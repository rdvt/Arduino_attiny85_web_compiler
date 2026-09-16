/* ============================================================================
 *  Protocolo micronucleus sobre WebUSB
 *
 *  Reimplementación en JS de lo que hace `commandline/library/micronucleus_lib.c`
 *  del proyecto micronucleus: identificar la placa, borrar la flash de usuario,
 *  escribirla página por página y arrancar la aplicación.
 *
 *  Todo el protocolo son control transfers de tipo vendor a nivel DISPOSITIVO
 *  (bmRequestType 0x40 / 0xC0), que es justo lo que expone WebUSB. Por eso no
 *  hace falta ningún driver ni puerto serie: el bootloader no es CDC ni HID.
 *
 *    IN  request 0 (v1)       -> 4 bytes: [0..1] flash, [2] página, [3] delay
 *    IN  request 0 (v2)       -> 8 bytes: lo anterior + [4..5] firma,
 *                              [6] flags, [7] versión de la app
 *    OUT request 2            -> borrar
 *    OUT request 1 (v2)       -> preparar página (value = largo, index = dir)
 *    OUT request 3 (v2)       -> 4 bytes de datos (value = palabra 1, index = 2)
 *    OUT request 1 (v1)       -> página completa como datos de la transferencia
 *    OUT request 4            -> arrancar la aplicación
 *
 *  Ojo con la versión: micronucleus la deduce de bcdDevice (o sea
 *  `usb.deviceVersionMajor`), no de la lectura de info.
 * ========================================================================== */

export const MICRONUCLEUS_VENDOR_ID = 0x16d0;
export const MICRONUCLEUS_PRODUCT_ID = 0x0753;
export const MAX_MAJOR_VERSION = 2;

/**
 * Etiquetas de cada fase de la grabación, compartidas por el flasher y el editor
 * para que la barra de progreso diga lo mismo en las dos páginas.
 */
export const FASE_ETIQUETAS = {
  connecting: "Conectando con la placa",
  erasing: "Borrando la flash de usuario",
  reconnecting: "Esperando a que la placa se reenumere",
  resuming: "La flash ya está borrada: sigo con la escritura",
  writing: "Grabando el firmware",
  starting: "Arrancando el firmware",
  done: "Grabación terminada",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const setupIn = (request, value = 0, index = 0) => ({
  requestType: "vendor",
  recipient: "device",
  request,
  value,
  index,
});

const setupOut = (request, value = 0, index = 0) => setupIn(request, value, index);

function toBytes(dataView) {
  if (!dataView) return new Uint8Array(0);
  return new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
}

/**
 * ¿El error es "la placa se fue", que micronucleus trata como recuperable?
 * El borrado y el arranque hacen que la placa se reenumere, así que esto es
 * normal y no un fallo real; lo mismo pasa si el enlace V-USB se cae.
 */
export function isRecoverable(error) {
  if (!(error instanceof DOMException)) return false;
  return error.name === "NetworkError" || error.name === "NotFoundError";
}

/**
 * ¿El status que devolvió una control transfer es el esperable?
 *
 * En libusb, el borrado y el arranque suelen terminar en un stall del endpoint
 * (-32 = EPIPE) porque la placa se reinicia y la respuesta nunca llega;
 * `micronucleus_lib.c` acepta -32, -34, -71 y -84 en el borrado. WebUSB NO
 * lanza excepción en ese caso: resuelve con `status: "stall"`. Sin tratarlo acá,
 * un borrado correcto se reportaba como fallo.
 */
export function isRecoverableStatus(status) {
  return status === "ok" || status === "stall";
}

/** Convierte los errores típicos de WebUSB en algo accionable. */
export function explainError(error) {
  const name = error instanceof DOMException ? error.name : "";
  const message = error && error.message ? error.message : String(error);

  if (name === "SecurityError" || /access denied|security/i.test(message)) {
    return (
      "Chrome bloqueó el acceso al dispositivo. Causas típicas: la página está " +
      "dentro de un webview/iframe, no es un contexto seguro (HTTPS o localhost), " +
      "el dispositivo es de clase HID, o en Windows el driver no es WinUSB " +
      "(instalalo con Zadig) / en Linux faltan las reglas udev de micronucleus."
    );
  }
  if (name === "NotFoundError" || /no device|not found/i.test(message)) {
    return (
      "No se encontró el dispositivo (0x16d0:0x0753). El bootloader micronucleus " +
      "sólo escucha unos 5 segundos al conectarse: desconecta la placa, pulsa " +
      "Grabar y recién ahí enchufala."
    );
  }
  if (name === "NetworkError" || /disconnect/i.test(message)) {
    return (
      "Se cortó la comunicación con la placa (se reenumeró o el enlace V-USB se " +
      "cayó). La flash de usuario puede haber quedado borrada: el bootloader sigue " +
      "intacto, así que vuelve a grabar. Prueba un puerto USB directo, sin hub ni dock."
    );
  }
  return message;
}

/**
 * Abre el dispositivo, elige la configuración y reclama las interfaces.
 * Micronucleus es clase vendor (no HID), así que Chrome deja reclamarla.
 */
async function prepare(usb) {
  if (!usb.opened) await usb.open();
  if (!usb.configuration) await usb.selectConfiguration(1);

  for (const usbInterface of usb.configuration.interfaces) {
    if (usbInterface.claimed) continue;
    try {
      await usb.claimInterface(usbInterface.interfaceNumber);
    } catch (error) {
      // Las control transfers a nivel dispositivo no necesitan la interfaz
      // reclamada; si el reclamo falla seguimos igual y el error real aparecerá
      // en la primera transferencia con un mensaje más claro.
      if (usb.configuration.interfaces.length === 1) {
        throw new Error(`No se pudo reclamar la interfaz USB: ${explainError(error)}`);
      }
    }
  }
}

/**
 * Lee los datos del bootloader y calcula el layout de la flash.
 *
 * @param {USBDevice} usb
 * @returns {Promise<{major:number, minor:number, flashSize:number, pageSize:number,
 *   pages:number, bootloaderStart:number, writeDelay:number, eraseDelay:number,
 *   signature:number[]|null, featureFlags:number|null, appVersion:number|null}>}
 */
export async function readDeviceInfo(usb) {
  const major = usb.deviceVersionMajor;
  const minor = usb.deviceVersionMinor;

  if (major > MAX_MAJOR_VERSION) {
    throw new Error(
      `La placa reporta micronucleus ${major}.${minor}, más nuevo que lo que ` +
        `soporta este flasher (hasta la ${MAX_MAJOR_VERSION}.x).`,
    );
  }

  // El tamaño de la respuesta depende de la versión: v2 contesta 6 u 8 bytes
  // (flash, página, delay, firma, flags, versión de app) y v1 sólo 4. Pedir de
  // más en un v1 puede dejarlo esperando el paquete que nunca va a llegar.
  const result = await usb.controlTransferIn(setupIn(0), major >= 2 ? 8 : 4);
  if (result.status !== "ok") {
    throw new Error(`La lectura de datos del bootloader falló (${result.status}).`);
  }

  const data = toBytes(result.data);
  if (data.length < 4) {
    throw new Error(
      "El dispositivo no respondió como un bootloader micronucleus " +
        "(¿es la placa en modo flash? ¿el VID/PID es 16d0:0753?).",
    );
  }

  const flashSize = (data[0] << 8) | data[1];
  const pageSize = data[2];

  // Si consultamos la placa justo mientras el erase la reinicia, puede
  // contestar cualquier cosa: mejor abortar que escribir con ese layout.
  if (flashSize < 512 || pageSize < 16 || pageSize > flashSize) {
    throw new Error(
      `El bootloader respondió datos inconsistentes (flash ${flashSize} bytes, página ${pageSize}). ` +
        "Probablemente la placa se estaba reiniciando: vuelve a intentarlo.",
    );
  }

  const pages = Math.ceil(flashSize / pageSize);
  // micronucleus_lib suma 2 ms de margen cuando el firmware es v2 y no se usa
  // el modo rápido del CLI.
  const writeDelay = (data[3] & 0x7f) + (major >= 2 ? 2 : 0);
  // El bit 7 avisa que el borrado es 4x más rápido (ATtiny441/841). Sólo lo
  // define el firmware v2: micronucleus_lib arma el erase del v1 como
  // write_sleep * pages sin mirar ese bit, aunque viniera en 1.
  const eraseDelay =
    major >= 2 && (data[3] & 0x80) ? (writeDelay * pages) / 4 : writeDelay * pages;

  return {
    major,
    minor,
    flashSize,
    pageSize,
    pages,
    bootloaderStart: pages * pageSize,
    writeDelay,
    eraseDelay,
    signature: data.length >= 6 ? [data[4], data[5]] : null,
    featureFlags: data.length >= 8 ? data[6] : null,
    appVersion: data.length >= 8 ? data[7] : null,
  };
}

/**
 * Prepara la imagen que hay que grabar: rellena con 0xFF, inserta en la página 0
 * un salto al bootloader y guarda el vector de reset del usuario en la tiny
 * vector table (los últimos 4 bytes del espacio de usuario). Es el parcheo que
 * micronucleus hace en el host, no en la placa.
 *
 * @param {Uint8Array} firmware imagen cruda del sketch
 * @param {{major:number, flashSize:number, pageSize:number, pages:number, bootloaderStart:number}} info
 * @returns {Uint8Array}
 */
export function patchResetVector(firmware, info) {
  const { bootloaderStart, flashSize, major } = info;

  if (firmware.length > flashSize) {
    throw new Error(
      `El firmware mide ${firmware.length} bytes y en esta placa entran ${flashSize}. ` +
        "¿Compilaste para otra placa?",
    );
  }

  const program = new Uint8Array(bootloaderStart).fill(0xff);
  program.set(firmware);

  // Los bootloaders v1 no usan tiny vector table: se graba tal cual.
  if (major < 2) return program;

  const word0 = program[0] | (program[1] << 8);
  const word1 = program[2] | (program[3] << 8);
  let userReset;

  if (word0 === 0x940c) {
    userReset = word1; // jmp k
  } else if ((word0 & 0xf000) === 0xc000) {
    userReset = (word0 & 0x0fff) + 1; // rjmp k: el destino es k+1 palabras
  } else {
    throw new Error(
      "El firmware no arranca con un jmp/rjmp, así que micronucleus no puede " +
        "alojar el bootloader. Recompilá el sketch sin tocar los sectores bajos.",
    );
  }

  // Página 0: salto al bootloader.
  if (bootloaderStart > 0x2000) {
    program[0] = 0x0c;
    program[1] = 0x94;
    program[2] = bootloaderStart & 0xff;
    program[3] = (bootloaderStart >> 8) & 0xff;
  } else {
    const jump = 0xc000 | ((bootloaderStart / 2 - 1) & 0x0fff);
    program[0] = jump & 0xff;
    program[1] = (jump >> 8) & 0xff;
  }

  // Tiny vector table: el reset del usuario, en los últimos 4 bytes usables.
  const table = bootloaderStart - 4;
  if (table > 0x2000) {
    program[table] = 0x0c;
    program[table + 1] = 0x94;
    program[table + 2] = userReset & 0xff;
    program[table + 3] = (userReset >> 8) & 0xff;
  } else {
    const jump = 0xc000 | ((userReset - table / 2 - 1) & 0x0fff);
    program[table] = jump & 0xff;
    program[table + 1] = (jump >> 8) & 0xff;
  }

  return program;
}

/**
 * Cuánto esperar después de pedir el borrado, en ms.
 *
 * El firmware calcula `erase_sleep = write_sleep × páginas` (752 ms en la
 * Digispark), pero es una cuenta optimista: el borrado de página del ATtiny85
 * puede tardar hasta 9 ms, o sea 846 ms para 94 páginas. Se espera el doble,
 * con 1 s mínimo, para no tocar el USB mientras el firmware borra con las
 * interrupciones apagadas (si no, Chrome marca el handle como roto).
 */
export function eraseWaitMs(info) {
  return Math.max((info?.eraseDelay ?? 0) * 2, 1000);
}

async function erase(usb, info) {
  try {
    const result = await usb.controlTransferOut(setupOut(2));
    // Un stall acá es normal: la placa se reenumera antes de contestar.
    if (!isRecoverableStatus(result.status)) throw new Error(`El borrado falló (${result.status}).`);
  } catch (error) {
    // Normalísimo: borrar la flash desconecta y reenumera la placa antes de que
    // la respuesta llegue al host. micronucleus lo trata igual (errores -32,
    // -34, -71, -84 en libusb => "recuperable").
    if (!isRecoverable(error) && !/NetworkError|disconnected/i.test(String(error && error.message))) {
      throw error;
    }
  }
  await sleep(eraseWaitMs(info));
}

async function writePage(usb, address, page, useV2) {
  if (!useV2) {
    // Protocolo v1: la página entera viaja como datos de la transferencia.
    const result = await usb.controlTransferOut(
      setupOut(1, page.length, address),
      page,
    );
    if (result.status !== "ok") throw new Error(`La escritura de la página falló (${result.status}).`);
    return;
  }

  // Protocolo v2: primero se anuncia la página y después van las palabras.
  const start = await usb.controlTransferOut(setupOut(1, page.length, address));
  if (start.status !== "ok") throw new Error(`El inicio de página falló (${start.status}).`);

  for (let offset = 0; offset < page.length; offset += 4) {
    const word1 = page[offset] | (page[offset + 1] << 8);
    const word2 = page[offset + 2] | (page[offset + 3] << 8);
    const result = await usb.controlTransferOut(setupOut(3, word1, word2));
    if (result.status !== "ok") throw new Error(`La escritura de datos falló (${result.status}).`);
  }
}

async function startApp(usb) {
  try {
    const result = await usb.controlTransferOut(setupOut(4));
    // También acá la placa se reenumera como aplicación: el stall es esperable.
    if (!isRecoverableStatus(result.status)) throw new Error(`El arranque falló (${result.status}).`);
  } catch (error) {
    // Al arrancar, la placa se reenumera como mouse: es esperable perderla acá.
    if (!isRecoverable(error)) throw error;
  }
}

/**
 * Fuerza el ciclo cerrar/abrir sobre un handle, equivalente al `usb_close()` de
 * micronucleus_lib.
 *
 * Ojo con `usb.opened`: tras el borrado el firmware apaga las interrupciones
 * ~750 ms y Chrome puede dar el dispositivo por caído **dejando el flag en
 * `true`**. Si el `close()` falla, el flag nunca vuelve a `false`, y si el
 * `open()` se condiciona a `!usb.opened` (como antes) el handle jamás se
 * reabre: el bucle de reconexión se queda girando sobre un dispositivo muerto
 * hasta agotar los 10 s. Por eso acá el `open()` no depende del flag.
 */
async function reopenDevice(usb) {
  try {
    if (usb.opened) await usb.close();
  } catch {
    /* el handle ya estaba roto: reabrirlo es justo lo que hace falta */
  }

  try {
    await usb.open();
  } catch (error) {
    // Chrome dice "ya está abierto" cuando el `close()` no llegó a aplicarse.
    if (error instanceof DOMException && error.name === "InvalidStateError") {
      await usb.close();
      await usb.open();
      return;
    }
    throw error;
  }
}

async function listGrantedDevices(vendorId, productId) {
  if (typeof navigator === "undefined" || !navigator.usb) return [];
  try {
    const devices = await navigator.usb.getDevices();
    return devices.filter((d) => d.vendorId === vendorId && d.productId === productId);
  } catch {
    return [];
  }
}

/**
 * Estado del flasheo. Mantiene el `USBDevice` y los datos del bootloader.
 */
export class MicronucleusFlasher {
  constructor({
    vendorId = MICRONUCLEUS_VENDOR_ID,
    productId = MICRONUCLEUS_PRODUCT_ID,
    onLog = () => {},
    // Ventana de reconexión tras el borrado (60 × 200 ms = 12 s). Es la parte
    // más lenta del protocolo y sólo las pruebas necesitan acortarla.
    reconnectAttempts = 60,
    reconnectDelayMs = 200,
  } = {}) {
    this.vendorId = vendorId;
    this.productId = productId;
    this.onLog = onLog;
    this.reconnectAttempts = reconnectAttempts;
    this.reconnectDelayMs = reconnectDelayMs;
    this.usb = null;
    this.info = null;
    this.lastError = null;

    // Diagnóstico: sin la placa a mano, los eventos de WebUSB son la única forma
    // de saber si Chrome la ve salir del bus tras el borrado (y si vuelve). Es
    // justo el dato que hace falta cuando la reconexión falla.
    if (typeof navigator !== "undefined" && navigator.usb?.addEventListener) {
      const esPlaca = (dev) => dev.vendorId === this.vendorId && dev.productId === this.productId;
      navigator.usb.addEventListener("connect", (event) => {
        if (esPlaca(event.device)) this.onLog("[usb] la placa apareció en el bus (connect).");
      });
      navigator.usb.addEventListener("disconnect", (event) => {
        if (esPlaca(event.device)) this.onLog("[usb] la placa desapareció del bus (disconnect).");
      });
    }
    // Se pone en true cuando el borrado ya se aceptó pero la placa todavía no
    // volvió a responder. El siguiente intento retoma la escritura en vez de
    // volver a borrar (que es lo que hace micronucleus.c: "Reconnected!
    // Continuing upload sequence...").
    this.erased = false;
  }

  /** ¿Hay un dispositivo abierto y con datos del bootloader? */
  get connected() {
    return Boolean(this.usb && this.info);
  }

  /**
   * Pide permiso a Chrome y se conecta. Tiene que llamarse dentro de un gesto
   * del usuario (un click): es lo que exige `requestDevice`.
   *
   * El diálogo queda abierto y se actualiza en vivo, así que el flujo que
   * funciona es: clic -> desenchufar -> enchufar -> elegir la placa.
   */
  async requestDevice() {
    if (!navigator.usb) {
      throw new Error("Este navegador no tiene WebUSB. Usa Chrome o Edge de escritorio.");
    }
    const usb = await navigator.usb.requestDevice({
      filters: [{ vendorId: this.vendorId, productId: this.productId }],
    });
    this.usb = usb;
    this.info = null;
    await prepare(usb);
    this.info = await readDeviceInfo(usb);
    this.lastError = null;
    return this.info;
  }

  /** Se conecta sin diálogo si el origen ya tiene permiso sobre la placa. */
  async connectGranted() {
    const [usb] = await listGrantedDevices(this.vendorId, this.productId);
    if (!usb) return null;
    this.usb = usb;
    await prepare(usb);
    this.info = await readDeviceInfo(usb);
    this.lastError = null;
    return this.info;
  }

  /**
   * Espera a que la placa (quizás reenumerada) vuelva a responder como
   * micronucleus. Prueba el handle actual y después los dispositivos ya
   * autorizados, que es donde aparece la placa al reconectarse.
   */
  async ensureReady({ attempts = 1, delayMs = 250, onAttempt = () => {}, reopen = false } = {}) {
    this.lastError = null;

    // Micronucleus NO cierra nada en el camino normal: reintenta la lectura
    // sobre el handle que ya tiene. Se hace igual: primero se reintenta tal
    // cual (cubre el corte momentáneo de V-USB) y sólo cuando la transferencia
    // falla de verdad se fuerza el ciclo cerrar/abrir. Reabrir en cada vuelta
    // deja el objeto de Chrome en un estado del que ya no sale.
    let needsReopen = false;
    // Para no llenar el log con 60 líneas: sólo se informa cuando cambia algo.
    let ultimoEstado = "";

    for (let attempt = 1; attempt <= attempts; attempt++) {
      onAttempt(attempt, attempts);
      if (attempt > 1) await sleep(delayMs);

      // Los dispositivos que devuelve `getDevices()` van primero: después del
      // borrado la placa se reenumera y ese listado es el equivalente WebUSB del
      // re-escaneo que hace `micronucleus_connect()`. El handle viejo queda de
      // último recurso, porque puede estar muerto para siempre.
      const concedidos = await listGrantedDevices(this.vendorId, this.productId);
      const estado =
        `getDevices=${concedidos.length} · handle=` +
        (this.usb ? (this.usb.opened ? "abierto" : "cerrado") : "ninguno") +
        (needsReopen ? " (a reabrir)" : "");
      if (estado !== ultimoEstado) {
        this.onLog(`[usb] intento ${attempt}/${attempts}: ${estado}`);
        ultimoEstado = estado;
      }

      const candidates = [...concedidos];
      if (this.usb && !candidates.includes(this.usb)) candidates.push(this.usb);

      for (const usb of candidates) {
        try {
          if (!usb.opened) {
            await usb.open();
          } else if (reopen && needsReopen) {
            // El borrado dejó el handle inutilizable: ciclo cerrar/abrir.
            await reopenDevice(usb);
          }

          await prepare(usb);
          const info = await readDeviceInfo(usb);
          this.usb = usb;
          this.info = info;
          return true;
        } catch (error) {
          this.lastError = error;
          // Si la placa se fue con el handle abierto, la próxima vuelta tiene
          // que reabrirlo (y no basta con reintentar la transferencia).
          if (usb.opened && isRecoverable(error)) needsReopen = true;
        }
      }
    }

    return false;
  }

  /**
   * Graba `firmware` (imagen cruda, sin parchear).
   *
   * @param {Uint8Array} firmware
   * @param {object} [options]
   * @param {"auto"|"v1"|"v2"} [options.protocol]
   * @param {(p: {phase: string, percentage: number, escrito?: number, total?: number,
   *   pagina?: number, paginas?: number, intento?: number, intentos?: number}) => void} [options.onProgress]
   *   El avance es real: durante `writing` llegan los bytes de flash ya escritos.
   */
  async flash(firmware, { protocol = "auto", onProgress = () => {} } = {}) {
    if (!this.connected) {
      throw new Error("Primero conectá la placa con el botón Conectar (o Grabar).");
    }

    const image = firmware instanceof Uint8Array ? firmware : new Uint8Array(firmware);
    if (image.length === 0) throw new Error("El firmware está vacío.");

    const initial = this.info;
    // El parcheo del vector sigue al protocolo que se va a usar, no a lo que
    // reporta la placa: con "v2" forzado un clon que dice v1 igual necesita la
    // tiny vector table, así que la validación previa usa ese major.
    const forcedMajor = protocol === "v2" ? 2 : protocol === "v1" ? 1 : initial.major;
    // Valida tamaño y vector de reset ANTES de borrar nada.
    patchResetVector(image, { ...initial, major: forcedMajor });

    const report = (phase, percentage, extra) => onProgress({ phase, percentage, total: initial.flashSize, ...extra });

    this.onLog(
      `Bootloader ${initial.major}.${initial.minor} · flash de usuario ${initial.flashSize} bytes · ` +
        `página ${initial.pageSize} bytes · ${initial.pages} páginas · write ${initial.writeDelay} ms`,
    );

    if (this.erased) {
      // Un intento anterior ya borró la flash pero no llegó a reconectar. Se
      // retoma la escritura tal cual, como hace micronucleus.c cuando el borrado
      // corta la conexión ("Reconnected! Continuing upload sequence...").
      this.onLog(
        "La placa ya quedó borrada en el intento anterior: retomo la escritura " +
          "(no hace falta volver a borrar).",
      );
      report("resuming", 6);
      await this.#writeAndStart({ image, protocol, report });
      return;
    }

    report("erasing", 4);
    await erase(this.usb, initial);
    // El borrado es la parte irreversible: si no llegamos a reconectar, el
    // siguiente intento retoma desde acá en vez de volver a borrar (y volver a
    // fallar) en un bucle del que nunca se sale.
    this.erased = true;
    // Micronucleus reenumera la placa después del borrado: hay que reencontrarla.
    // El borrado es una sola transferencia, así que no hay avance interno que
    // medir; en cambio, los reintentos de reconexión sí se pueden informar.
    report("reconnecting", 6);
    // El borrado reinicia el micro: la placa tarda en enumerar de nuevo y en V-USB
    // eso puede llevar varios segundos hasta con una placa impecable. Doce
    // segundos de paciencia cubren también los hubs USB 3.x lentos.
    const ready = await this.ensureReady({
      attempts: this.reconnectAttempts,
      delayMs: this.reconnectDelayMs,
      reopen: true,
      onAttempt: (intento, intentos) => report("reconnecting", 6 + Math.round((intento / intentos) * 2), { intento, intentos }),
    });
    if (!ready) {
      const segundos = Math.round((this.reconnectAttempts * this.reconnectDelayMs) / 1000);
      throw new Error(
        `La placa no volvió a responder después del borrado (esperé ${segundos} s). ` +
          "El borrado SÍ se completó: la flash de usuario quedó vacía y el bootloader intacto. " +
          "Desconectá la placa, pulsá Grabar y volvé a enchufarla: el próximo intento retoma " +
          "desde la escritura (no vuelve a borrar)." +
          (this.lastError
            ? ` (último fallo: ${this.lastError.name || "Error"} — ${explainError(this.lastError)})`
            : ""),
      );
    }

    await this.#writeAndStart({ image, protocol, report });
  }

  /**
   * Escribe la imagen página por página y arranca la aplicación.
   *
   * Sirve para los dos caminos: después de un borrado normal y al retomar un
   * intento que quedó cortado tras borrar. En ambos la flash de usuario ya está
   * vacía, así que el trabajo que falta es exactamente el mismo.
   */
  async #writeAndStart({ image, protocol, report }) {
    // Desde acá la flash puede quedar a medias si algo falla, así que un intento
    // posterior tiene que volver a borrar.
    this.erased = false;

    const info = this.info;
    const useV2 = protocol === "v2" || (protocol === "auto" && info.major >= 2);
    // La tiny vector table se parchea si el protocolo real es v2: forzar v2 en un
    // bootloader que reporta v1 también la necesita para poder arrancar.
    const program = patchResetVector(image, { ...info, major: useV2 ? 2 : 1 });
    this.onLog(
      `Escribiendo como micronucleus ${useV2 ? "v2 (por palabras)" : "v1 (página completa)"}` +
        (protocol === "auto" ? "." : ` (protocolo forzado a ${protocol}).`),
    );

    let nextReport = 8;
    for (let address = 0; address < info.flashSize; address += info.pageSize) {
      // La última página se manda COMPLETA (64 B en la Digispark), nunca recortada.
      //
      // micronucleus_lib la recorta a `flash_size % page_size` = 60 B para los
      // bootloaders v1.0–1.2, pero eso deja colgada a la familia v1.06/Digistump:
      // su usbFunctionWrite cierra la página cuando `currentAddress % SPM_PAGESIZE == 0`
      // (el writeLength que venía en wValue quedó comentado en el firmware), así
      // que con 60 bytes la dirección nunca llega al límite de página, el
      // firmware no contesta, el navegador espera ~5 s (AUTO_EXIT_MS) y devuelve
      // stall, siempre en la última página. Con los 64 bytes la página cierra en
      // el límite y el firmware alcanza a escribir ahí su tiny vector table.
      // Los 4 bytes de más son relleno 0xFF (flash ya borrada): no cambian nada.
      const page = program.slice(address, address + info.pageSize);      // La última página se escribe siempre: ahí va la tiny vector table.
      const mustWrite =
        address >= info.bootloaderStart - info.pageSize || page.some((byte) => byte !== 0xff);

      if (mustWrite) {
        try {
          await writePage(this.usb, address, page, useV2);
        } catch (error) {
          const revived = isRecoverable(error) && (await this.ensureReady({ attempts: 8, delayMs: 250 }));
          if (!revived) throw error instanceof Error ? error : new Error(explainError(error));
          await writePage(this.usb, address, page, useV2);
        }
        await sleep(info.writeDelay);
      }

      const escrito = Math.min(address + info.pageSize, info.flashSize);
      const percentage = 8 + Math.round((escrito / info.flashSize) * 88);
      // La última página se informa siempre: si no, el paso de `nextReport` la
      // saltea y la barra se quedaría en 95 % al terminar de escribir.
      const ultima = address + info.pageSize >= info.flashSize;
      if (percentage >= nextReport || ultima) {
        nextReport = percentage + 2;
        report("writing", Math.min(96, percentage), {
          escrito,
          pagina: address / info.pageSize + 1,
          paginas: info.pages,
        });
      }
    }

    report("starting", 98, { escrito: info.flashSize });
    await startApp(this.usb);
    await this.close();
    report("done", 100, { escrito: info.flashSize });
  }

  /** Suelta el dispositivo (ignorando que ya se haya ido solo). */
  async close() {
    const usb = this.usb;
    this.usb = null;
    this.info = null;
    if (!usb) return;
    try {
      if (usb.opened) await usb.close();
    } catch {
      /* la placa se reenumeró sola: no hay nada que hacer */
    }
  }
}

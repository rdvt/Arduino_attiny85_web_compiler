/* ============================================================================
 *  Verificación del flasher web (no necesita placa ni navegador).
 *
 *    node flasher/verify.mjs
 *
 *  Comprueba, contra el .hex real de build/:
 *    1. que el parser de Intel HEX devuelva exactamente lo mismo que
 *       `avr-objcopy -I ihex -O binary` (si está el toolchain disponible);
 *    2. la detección de formato y el rechazo de archivos corruptos;
 *    3. el parcheo del vector de reset y de la tiny vector table;
 *    4. las validaciones que corren ANTES de borrar la placa;
 *    5. el layout que se deduce de la respuesta del bootloader;
 *    6. el avance que se reporta a la barra mientras se graba, contra un
 *       USBDevice falso que habla el mismo protocolo (sin hardware);
 *    7. el protocolo forzado a v2 en un bootloader que reporta v1;
 *    8. la reconexión cuando la placa se cae tras el borrado;
 *    9. la reanudación de la escritura tras un borrado que no reconectó.
 * ========================================================================== */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { globSync } from "node:fs";
import assert from "node:assert/strict";

import { parseIntelHex, decodeFirmware, looksLikeIntelHex } from "./intelhex.js";
import { MicronucleusFlasher, patchResetVector, explainError, readDeviceInfo, eraseWaitMs } from "./micronucleus.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HEX_FILE = join(HERE, "..", "build", "DigisparkMouse.ino.hex");

const ok = (text) => console.log(`OK   ${text}`);
const skip = (text) => console.log(`SALTO ${text}`);

/** Busca avr-objcopy sin hardcodear usuario ni versión. */
function findObjcopy() {
  if (process.env.AVR_OBJCOPY) return process.env.AVR_OBJCOPY;

  let dataDir = "";
  try {
    dataDir = execFileSync("arduino-cli", ["config", "get", "directories.data"], {
      encoding: "utf8",
    }).trim();
  } catch {
    dataDir = join(process.env.HOME ?? "", "Library", "Arduino15");
  }

  const pattern = join(dataDir, "packages", "arduino", "tools", "avr-gcc", "*", "bin", "avr-objcopy");
  const [found] = globSync(pattern);
  return found ?? null;
}

/* ---------------------------- 1. imagen de flash --------------------------- */

const text = readFileSync(HEX_FILE, "utf8");
assert.ok(looksLikeIntelHex(text), "el .hex debería empezar con ':'");

const { image, end, hasEof, records } = parseIntelHex(text);
assert.equal(hasEof, true, "falta el registro EOF");
console.log(`     ${HEX_FILE}\n     ${image.length} bytes en ${records} registros (fin: 0x${end.toString(16)})`);

const objcopy = findObjcopy();
if (objcopy) {
  const reference = execFileSync(objcopy, ["-I", "ihex", "-O", "binary", HEX_FILE, "/dev/stdout"], {
    maxBuffer: 1 << 22,
  });
  assert.equal(image.length, reference.length, "el tamaño no coincide con avr-objcopy");
  assert.ok(Buffer.from(image).equals(reference), "los bytes no coinciden con avr-objcopy");
  ok(`imagen idéntica a avr-objcopy (${objcopy})`);
} else {
  skip("no encontré avr-objcopy; no puedo comparar contra la implementación de referencia");
}

/* --------------------------- 2. detección de formato ----------------------- */

assert.equal(decodeFirmware(readFileSync(HEX_FILE), "DigisparkMouse.ino.hex").format, "Intel HEX");
assert.equal(decodeFirmware(new Uint8Array([1, 2, 3, 4]), "otra.bin").format, "binario crudo");
ok("decodeFirmware distingue Intel HEX de binario crudo");

const dataLine = text.split(/\r?\n/).find((line) => /^:10/.test(line));
const mutated = text.replace(dataLine, dataLine.slice(0, 9) + (dataLine[9] === "0" ? "1" : "0") + dataLine.slice(10));
assert.notEqual(mutated, text, "el test tiene que corromper algo");
assert.throws(() => parseIntelHex(mutated), /checksum/);
assert.throws(() => parseIntelHex("no soy hex"), /Intel HEX/);
assert.throws(() => parseIntelHex(":01000000AA00\n"), /checksum/);
assert.throws(() => parseIntelHex(":01000000AA\n"), /dice 1 bytes/);
assert.throws(() => decodeFirmware(new Uint8Array([0x00, 0x01]), "roto.hex"), /no es Intel HEX/);
ok("checksums y formatos inválidos se detectan");

/* ------------------------ 3. parcheo del vector de reset ------------------- */

// Lo que reporta una Digispark con micronucleus 2.x: 6012 bytes de usuario.
const info = { major: 2, minor: 6, flashSize: 6012, pageSize: 64, pages: 94, bootloaderStart: 6016 };
const program = patchResetVector(image, info);

assert.equal(program.length, info.bootloaderStart, "el buffer llega justo hasta el bootloader");
assert.equal(program[1000], image[1000], "los datos del sketch se copian sin tocar");
assert.equal(program[5999], 0xff, "el relleno es 0xFF (flash sin programar)");

/** Lee un rjmp de la imagen parcheada y devuelve su destino (en palabras). */
function readRjmp(bytes, at) {
  const word = bytes[at] | (bytes[at + 1] << 8);
  assert.equal(word & 0xf000, 0xc000, `en 0x${at.toString(16)} debería haber un rjmp`);
  return (word & 0x0fff) + 1;
}

// Página 0: salto al bootloader.
assert.equal(readRjmp(program, 0) * 2, info.bootloaderStart, "la página 0 salta al bootloader");

// Tiny vector table: el reset original del usuario, relativo a su propia PC
// y envolviendo módulo 4096 palabras.
const word0 = image[0] | (image[1] << 8);
const word1 = image[2] | (image[3] << 8);
const userReset = word0 === 0x940c ? word1 : (word0 & 0x0fff) + 1;
const tableWord = (info.bootloaderStart - 4) / 2;
assert.equal(
  (tableWord + readRjmp(program, info.bootloaderStart - 4)) % 4096,
  userReset,
  "el reset del usuario queda en la tiny vector table",
);
ok(
  `vector de reset parcheado (0x${word0.toString(16)} -> palabra 0x${userReset.toString(16)}; ` +
    `página 0 -> 0x${info.bootloaderStart.toString(16)})`,
);

/* ------------------- 4. validaciones previas al borrado -------------------- */

assert.throws(() => patchResetVector(new Uint8Array(7000), info), /entran 6012/);

const broken = new Uint8Array(image);
broken[0] = 0x00;
broken[1] = 0x00;
assert.throws(() => patchResetVector(broken, info), /jmp\/rjmp/);

// Con un bootloader v1 no se parchea nada (no hay tiny vector table).
const plain = patchResetVector(image, { ...info, major: 1 });
assert.equal(plain[0], image[0]);
assert.equal(plain[1], image[1]);
ok("firmware demasiado grande, vector inválido y protocolo v1 se manejan bien");

/* ---------------- 5. layout a partir de la respuesta del bootloader -------- */

/** USBDevice falso: sólo lo que usa readDeviceInfo. */
function fakeDevice(infoBytes, major = 2, minor = 6) {
  return {
    deviceVersionMajor: major,
    deviceVersionMinor: minor,
    controlTransferIn: async (setup, length) => {
      assert.equal(setup.request, 0, "la lectura de info es el request 0");
      assert.equal(length, 8);
      return { status: "ok", data: new DataView(Uint8Array.from(infoBytes).buffer) };
    },
  };
}

// 6012 bytes (0x177C), página 64, delay 6, firma ATtiny85 (0x1E 0x93), flags 0, app v2:
// exactamente lo que reporta una Digispark con micronucleus 2.x.
const reported = await readDeviceInfo(fakeDevice([0x17, 0x7c, 0x40, 0x06, 0x1e, 0x93, 0x00, 0x02]));
assert.equal(reported.flashSize, 6012);
assert.equal(reported.pageSize, 64);
assert.equal(reported.pages, 94);
assert.equal(reported.bootloaderStart, 6016);
assert.equal(reported.writeDelay, 8, "v2 en modo normal suma 2 ms, como micronucleus_lib");
assert.equal(reported.eraseDelay, 8 * 94);
assert.deepEqual(reported.signature, [0x1e, 0x93]);
ok("el layout de la flash coincide con micronucleus_lib (6012 bytes, 94 páginas, bootloader en 0x1780)");

// Un bootloader v1 que contesta 4 bytes también se entiende. Y hay que pedirle
// exactamente 4, como micronucleus_lib: pedir 8 a un v1 lo deja esperando un
// paquete que nunca llega.
let v1Requested = null;
const v1 = await readDeviceInfo(
  Object.assign(fakeDevice([0x17, 0x7c, 0x40, 0x06], 1, 6), {
    controlTransferIn: async (setup, length) => {
      v1Requested = length;
      return { status: "ok", data: new DataView(Uint8Array.from([0x17, 0x7c, 0x40, 0x06]).buffer) };
    },
  }),
);
assert.equal(v1Requested, 4, "a un bootloader v1 se le piden 4 bytes, no 8");
assert.equal(v1.major, 1);
assert.equal(v1.writeDelay, 6, "un bootloader v1 no lleva el margen extra");
ok("un bootloader v1 (4 bytes de info) se interpreta bien");

// El bit 7 del byte de delay (borrado 4x más rápido del ATtiny441/841) sólo lo
// interpreta el firmware v2. micronucleus_lib arma el v1 como write*pages sin
// mirar ese bit, por más que venga en 1.
const v1FastBit = await readDeviceInfo(
  Object.assign(fakeDevice([0x17, 0x7c, 0x40, 0x86], 1, 6), {
    controlTransferIn: async () => ({
      status: "ok",
      data: new DataView(Uint8Array.from([0x17, 0x7c, 0x40, 0x86]).buffer),
    }),
  }),
);
assert.equal(v1FastBit.writeDelay, 6, "v1: el bit 7 no altera el delay de escritura");
assert.equal(v1FastBit.eraseDelay, 6 * 94, "v1: el borrado no se divide por 4");
const v2FastBit = await readDeviceInfo(fakeDevice([0x17, 0x7c, 0x40, 0x86]));
assert.equal(v2FastBit.eraseDelay, (8 * 94) / 4, "v2: el borrado 4x más rápido sí se aplica");
ok("el bit 7 del delay de borrado se interpreta sólo en micronucleus v2");

// El firmware calcula erase_sleep = write_sleep × páginas = 752 ms, pero el
// borrado de página del ATtiny85 puede tardar hasta 9 ms (94 × 9 = 846 ms).
// Esperar de menos deja el USB sin atender y Chrome da el handle por roto.
assert.equal(eraseWaitMs(reported), 1504, "el doble del cálculo del firmware");
assert.ok(eraseWaitMs(reported) > 94 * 9, "la espera tiene que cubrir el borrado más lento");
assert.equal(eraseWaitMs({ eraseDelay: 0 }), 1000, "mínimo de 1 s");
ok(`espera tras el borrado: ${eraseWaitMs(reported)} ms (peor caso de silicio: ${94 * 9} ms)`);

// Lectura basura (por ejemplo durante el borrado) => error claro, no escritura.
await assert.rejects(
  () => readDeviceInfo(fakeDevice([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])),
  /datos inconsistentes/,
);
ok("una lectura inconsistente del bootloader se rechaza");

assert.match(explainError(new DOMException("x", "SecurityError")), /Chrome bloqueó el acceso/);
ok("los errores de WebUSB se traducen a algo accionable");

/* ------------------- 6. avance real durante la grabación ------------------ */

/**
 * USBDevice falso que implementa el protocolo micronucleus sin hardware: lleva
 * la cuenta de las transferencias para comprobar que el avance que recibe la
 * barra coincide con lo que de verdad se escribe.
 */
function fakeFlasherDevice(
  infoBytes = [0x17, 0x7c, 0x40, 0x06, 0x1e, 0x93, 0x00, 0x02],
  major = 2,
  minor = 6,
  { eraseStatus = "ok", startStatus = "ok" } = {},
) {
  const calls = { erase: 0, pageStart: 0, words: 0, start: 0, escritas: [], largos: [] };
  const device = {
    deviceVersionMajor: major,
    deviceVersionMinor: minor,
    opened: false,
    configuration: { interfaces: [{ interfaceNumber: 0, claimed: false }] },
    async open() { this.opened = true; },
    async selectConfiguration() {},
    async claimInterface() { this.configuration.interfaces[0].claimed = true; },
    async controlTransferIn(setup, length) {
      assert.equal(setup.request, 0, "la información del bootloader es el request 0");
      // v2 contesta 8 bytes y v1 sólo 4: el host tiene que pedir lo correcto.
      assert.equal(length, major >= 2 ? 8 : 4);
      return { status: "ok", data: new DataView(Uint8Array.from(infoBytes).buffer) };
    },
    async controlTransferOut(setup) {
      if (setup.request === 2) { calls.erase++; return { status: eraseStatus }; }
      if (setup.request === 1) { calls.pageStart++; calls.escritas.push(setup.index); calls.largos.push(setup.value); }
      else if (setup.request === 3) calls.words++;
      else if (setup.request === 4) { calls.start++; return { status: startStatus }; }
      else assert.fail(`request inesperado: ${setup.request}`);
      return { status: "ok" };
    },
    async close() { this.opened = false; },
  };
  return { device, calls };
}

const { device, calls } = fakeFlasherDevice();
const eventos = [];
const fake = new MicronucleusFlasher({ onLog: () => {} });
fake.usb = device;
fake.info = await readDeviceInfo(device);
await fake.flash(image, { protocol: "auto", onProgress: (p) => eventos.push(p) });

// 1. Fases en orden y porcentaje final exacto.
const fases = eventos.map((e) => e.phase);
assert.equal(fases[0], "erasing", "la grabación empieza borrando");
assert.ok(fases.includes("reconnecting"), "debe informar la espera tras el borrado");
assert.ok(fases.includes("writing"), "debe informar la escritura página a página");
assert.equal(fases.at(-1), "done");
assert.equal(eventos.at(-1).percentage, 100);

// 2. El porcentaje nunca retrocede: es lo que evita que la barra dé saltos.
const porcentajes = eventos.map((e) => e.percentage);
assert.deepEqual(porcentajes, [...porcentajes].sort((a, b) => a - b), "el porcentaje no debe retroceder");
assert.ok(new Set(porcentajes).size >= 8, "el avance debe tener resolución para verse fluido");

// 3. Cada aviso de escritura trae datos concretos y coherentes.
const escrituras = eventos.filter((e) => e.phase === "writing");
assert.ok(escrituras.length >= 5);
for (const e of escrituras) {
  assert.equal(e.total, info.flashSize);
  assert.ok(e.escrito > 0 && e.escrito <= e.total);
  assert.ok(e.pagina >= 1 && e.pagina <= e.paginas);
}
assert.equal(escrituras.at(-1).escrito, info.flashSize, "la última página cierra el espacio de usuario");

// 4. Lo transferido coincide con lo reportado: v2 manda 16 palabras por página
//    y la última siempre se escribe (ahí va la tiny vector table).
assert.equal(calls.erase, 1);
assert.equal(calls.start, 1);
assert.equal(calls.words, calls.pageStart * (info.pageSize / 4));
assert.equal(calls.escritas.at(-1), info.bootloaderStart - info.pageSize, "la última página se graba siempre");
ok(
  `avance real de la grabación (${escrituras.length} avisos de escritura, ` +
    `${calls.pageStart} páginas, ${eventos.length} eventos, sin retrocesos)`,
);

// 5. El stall en el borrado y en el arranque es esperable (la placa se
//    reenumera antes de contestar): no debe abortar la grabación. Es el caso
//    que hacía fallar con "El borrado falló (stall)".
{
  const stalled = fakeFlasherDevice(undefined, 2, 6, { eraseStatus: "stall", startStatus: "stall" });
  const eventosStall = [];
  const flasherStall = new MicronucleusFlasher({ onLog: () => {} });
  flasherStall.usb = stalled.device;
  flasherStall.info = await readDeviceInfo(stalled.device);
  await flasherStall.flash(image, { protocol: "auto", onProgress: (p) => eventosStall.push(p) });
  assert.equal(eventosStall.at(-1).phase, "done", "un stall en borrado/arranque no debe abortar");
  assert.equal(stalled.calls.erase, 1);
  assert.equal(stalled.calls.start, 1);
  ok("el stall del borrado y del arranque se trata como recuperable (como micronucleus_lib)");
}

/* ------- 7. forzar el protocolo cuando el bootloader reporta mal ---------- */

// Clon que dice micronucleus 1.0 pero habla el protocolo v2 (el caso del
// selector del editor): con "Forzar v2" tiene que usar las palabras de 4 bytes
// (request 3), mandar la última página completa y parchear la tiny vector table.
{
  const mentiroso = fakeFlasherDevice([0x17, 0x7c, 0x40, 0x06], 1, 0);
  const infoLevantada = await readDeviceInfo(mentiroso.device);
  const flasherForzado = new MicronucleusFlasher({ onLog: () => {} });
  flasherForzado.usb = mentiroso.device;
  flasherForzado.info = infoLevantada;
  assert.equal(infoLevantada.major, 1, "la placa reporta v1");

  await flasherForzado.flash(image, { protocol: "v2", onProgress: () => {} });
  assert.ok(mentiroso.calls.words > 0, "v2 forzado debe escribir con el request 3");
  assert.equal(
    mentiroso.calls.words,
    mentiroso.calls.pageStart * (info.pageSize / 4),
    "v2 forzado manda la página completa (16 palabras), no la parcial del v1",
  );

  // Y el firmware queda parcheado con la tiny vector table, como en un v2 real.
  const parcheado = patchResetVector(image, { ...infoLevantada, major: 2 });
  const table = infoLevantada.bootloaderStart - 4;
  const tableWord = parcheado[table] | (parcheado[table + 1] << 8);
  assert.equal(tableWord & 0xf000, 0xc000, "la tiny vector table debe ser un rjmp");
  ok("forzar v2 en un bootloader que reporta v1 usa palabras y parchea el vector");
}

/* ------- 8. la placa se cae tras el borrado y hay que reconectar --------- */

/**
 * USBDevice falso que reproduce el "erase disconnection bug" de micronucleus:
 * mientras el firmware borra las 94 páginas con las interrupciones apagadas la
 * placa desaparece del bus. Durante ese rato el handle queda con `opened` en
 * `true` pero muerto, y `close()` puede fallar.
 *
 * @param {object} [options]
 * @param {number} [options.reconectarTras] Intentos que aguanta el host antes
 *   de que la placa vuelva. `Infinity` = no vuelve nunca (hace falta desenchufar).
 * @param {number} [options.fallosDeCierre] Cuántos `close()` fallan dejando
 *   `opened` en `true`, que es el estado que dejaba el bucle muerto.
 */
function fakeVanishingDevice(
  infoBytes = [0x17, 0x7c, 0x40, 0x08],
  major = 1,
  { reconectarTras = 0, fallosDeCierre = 0 } = {},
) {
  const calls = { erase: 0, pageStart: 0, words: 0, start: 0, abre: 0, cierra: 0, intentos: 0 };
  const device = {
    deviceVersionMajor: major,
    deviceVersionMinor: 0,
    opened: false,
    enBlanco: false,
    configuration: null,
    reconectarTras,
    fallosDeCierre,

    /** La placa vuelve al bus (equivale a desenchufar y enchufar). */
    reconectar() {
      this.enBlanco = false;
      this.opened = false;
      this.configuration = null;
    },

    // Cuenta sólo los intentos hechos con la placa fuera del bus: la placa vuelve
    // cuando el host ya insistió lo suficiente (`reconectarTras`).
    _intento() {
      if (!this.enBlanco) return;
      calls.intentos++;
      if (calls.intentos > this.reconectarTras) this.enBlanco = false;
    },

    async open() {
      calls.abre++;
      this._intento();
      if (this.opened) throw new DOMException("ya está abierto", "InvalidStateError");
      if (this.enBlanco) throw new DOMException("no está", "NotFoundError");
      this.opened = true;
      this.configuration = { interfaces: [{ interfaceNumber: 0, claimed: false }] };
    },
    async selectConfiguration() {
      this.configuration = { interfaces: [{ interfaceNumber: 0, claimed: false }] };
    },
    async claimInterface() {},
    async controlTransferIn() {
      this._intento();
      if (this.enBlanco) throw new DOMException("no está", "NotFoundError");
      return { status: "ok", data: new DataView(Uint8Array.from(infoBytes).buffer) };
    },
    async controlTransferOut(setup) {
      this._intento();
      if (this.enBlanco) throw new DOMException("no está", "NotFoundError");
      if (setup.request === 2) {
        calls.erase++;
        // Acá empieza el borrado: la placa se va del bus.
        this.enBlanco = true;
        this.opened = true;
        return { status: "ok" };
      }
      if (setup.request === 1) calls.pageStart++;
      else if (setup.request === 3) calls.words++;
      else if (setup.request === 4) calls.start++;
      return { status: "ok" };
    },
    async close() {
      calls.cierra++;
      // Con la placa fuera del bus el cierre puede fallar y dejar `opened` en
      // `true`: el estado exacto que hacía que nunca se reabriera el handle.
      if (this.enBlanco && this.fallosDeCierre > 0) {
        this.fallosDeCierre--;
        throw new DOMException("no está", "NotFoundError");
      }
      this.opened = false;
    },
  };
  return { device, calls };
}

// 7a. El handle queda muerto tras el borrado pero la placa vuelve unos intentos
//     después: el flasher tiene que reabrirlo y terminar la grabación.
{
  const { device, calls } = fakeVanishingDevice(undefined, 1, { reconectarTras: 3, fallosDeCierre: 1 });
  const flasher = new MicronucleusFlasher({ onLog: () => {}, reconnectAttempts: 30, reconnectDelayMs: 1 });
  // Estado real antes de grabar: handle abierto y con configuración elegida.
  await device.open();
  flasher.usb = device;
  flasher.info = await readDeviceInfo(device);
  await flasher.flash(image, { protocol: "v1", onProgress: () => {} });

  assert.equal(calls.erase, 1);
  assert.equal(calls.start, 1, "la grabación tiene que llegar hasta el arranque");
  assert.ok(calls.abre > 1, "el handle muerto se reabre (no se reintenta sobre un dispositivo que ya no está)");
  assert.ok(calls.cierra >= 1, "la recuperación pasa por cerrar el handle roto");
  ok(`la placa que se cae tras el borrado se reencuentra y graba (${calls.intentos} intentos)`);
}

/* --- 9. al reborrar no se puede caer en un bucle: se retoma la escritura -- */

// El caso que dejaba el flasher inutilizable: el borrado funcionaba, la
// reconexión no, y cada nuevo Grabar volvía a borrar y a fallar. Con esto el
// segundo intento retoma la escritura, igual que micronucleus.c
// ("Reconnected! Continuing upload sequence...").
{
  const { device, calls } = fakeVanishingDevice(undefined, 1, { reconectarTras: Infinity });
  const flasher = new MicronucleusFlasher({ onLog: () => {}, reconnectAttempts: 3, reconnectDelayMs: 1 });
  await device.open();
  flasher.usb = device;
  flasher.info = await readDeviceInfo(device);

  await assert.rejects(
    () => flasher.flash(image, { protocol: "v1", onProgress: () => {} }),
    /no volvió a responder/,
    "si la placa no vuelve hay que avisar, no seguir a ciegas",
  );
  assert.equal(calls.erase, 1, "el primer intento sí borra");
  assert.equal(calls.pageStart, 0, "y no llega a escribir");
  assert.equal(flasher.erased, true, "queda anotado que la flash ya está borrada");

  // Desenchufar, pulsar Grabar y volver a enchufar: mismo flasher (la página no
  // lo recrea), así que tiene que retomar sin borrar otra vez.
  device.reconectar();
  flasher.info = await readDeviceInfo(device);
  const eventosReanudados = [];
  await flasher.flash(image, { protocol: "v1", onProgress: (p) => eventosReanudados.push(p) });

  assert.equal(calls.erase, 1, "el segundo intento NO vuelve a borrar");
  assert.ok(calls.pageStart > 0, "el segundo intento escribe el firmware");
  assert.equal(calls.start, 1, "y arranca la aplicación");
  assert.equal(eventosReanudados[0].phase, "resuming", "el usuario tiene que ver que se retoma");
  assert.equal(eventosReanudados.at(-1).phase, "done");
  assert.equal(flasher.erased, false, "tras grabar ya no queda nada pendiente");
  ok("tras un borrado sin reconexión, el siguiente Grabar retoma la escritura (no vuelve a borrar)");
}

/* --- 10. v1 manda la última página completa (firmware v1.06/Digistump) ---- */

// El firmware cierra la página cuando la dirección llega a un múltiplo de 64
// (`currentAddress % SPM_PAGESIZE == 0`), NO por el largo declarado en wValue:
// con 60 bytes en la última página la transferencia se cuelga ~5 s y Chrome
// devuelve stall. Se comprueba que v1 pida el tamaño completo en todas.
{
  const v1dev = fakeFlasherDevice([0x17, 0x7c, 0x40, 0x08], 1, 0);
  const infoV1 = await readDeviceInfo(v1dev.device);
  const flasherV1 = new MicronucleusFlasher({ onLog: () => {} });
  flasherV1.usb = v1dev.device;
  flasherV1.info = infoV1;
  await flasherV1.flash(image, { protocol: "v1", onProgress: () => {} });

  assert.equal(infoV1.flashSize, 6012);
  assert.equal(v1dev.calls.words, 0, "v1 no usa el request 3 (palabras sueltas)");
  assert.deepEqual(
    [...new Set(v1dev.calls.largos)],
    [infoV1.pageSize],
    "v1 manda todas las páginas completas: la última también, no recortada a 60 B",
  );
  assert.equal(v1dev.calls.escritas.at(-1), infoV1.bootloaderStart - infoV1.pageSize, "la última página se graba siempre");
  ok("v1 manda la última página completa (el firmware cierra por límite de página, no por largo)");
}

console.log("\nTodo verde: el flasher web parsea, parchea y reporta igual que micronucleus.");

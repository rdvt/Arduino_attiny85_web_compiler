/* ============================================================================
 *  Conocimiento de ATtiny85 + Digispark + micronucleus
 *
 *  Acá vive todo lo que hace que el editor sea "especializado" y no un bloc de
 *  notas: qué límites tiene la placa, qué rompe el USB bit-bang de V-USB, qué
 *  exige micronucleus para poder alojar el bootloader, y qué errores del
 *  compilador hay que mostrar.
 * ========================================================================== */

/** RAM del ATtiny85 (512 B, de los cuales el core usa una parte para el stack). */
export const ATTINY85_RAM = 512;

/** Placas ATtiny85 conocidas, por si el agente no está disponible. */
export const FALLBACK_BOARDS = [
  {
    fqbn: "digistump:avr:digispark-tiny",
    name: "Digispark (Default - 16.5mhz)",
    mcu: "attiny85",
    fCpu: "16500000L",
    maximumSize: 6012,
    maximumDataSize: null,
    usesUsb: true,
  },
];

/* -------------------------------------------------------------------------- */
/* Imagen compilada                                                            */
/* -------------------------------------------------------------------------- */

/** Lee el vector de reset del binario y dice si micronucleus puede parchearlo. */
export function describeResetVector(image) {
  if (!image || image.length < 4) return { ok: false, text: "imagen demasiado corta", word0: null };
  const word0 = image[0] | (image[1] << 8);
  const word1 = image[2] | (image[3] << 8);
  if (word0 === 0x940c) return { ok: true, kind: "jmp", text: `jmp 0x${(word1 * 2).toString(16)}`, word0 };
  if ((word0 & 0xf000) === 0xc000) {
    return { ok: true, kind: "rjmp", text: `rjmp a la palabra 0x${((word0 & 0x0fff) + 1).toString(16)}`, word0 };
  }
  return { ok: false, kind: null, text: `0x${word0.toString(16).padStart(4, "0")} (no es jmp/rjmp)`, word0 };
}

/**
 * Chequeos que se aplican a la imagen ya compilada, antes de grabarla.
 *
 * @param {Uint8Array} image
 * @param {{maximumSize: number}} board
 */
export function checkFlashImage(image, board) {
  const findings = [];
  const budget = board?.maximumSize ?? 6012;

  if (!image || image.length === 0) {
    return { ok: false, used: 0, budget, findings: [error("No hay firmware compilado.")] };
  }

  const used = image.length;
  if (used > budget) {
    findings.push(
      error(
        `El firmware mide ${used} bytes y en esta placa entran ${budget}. ` +
          "El bootloader ocupa el resto de la flash: hay que achicar el sketch.",
      ),
    );
  }

  const vector = describeResetVector(image);
  if (!vector.ok) {
    findings.push(
      error(
        `El firmware no arranca con jmp/rjmp (${vector.text}). micronucleus necesita parchear el ` +
          "vector de reset para arrancar tu programa, así que esto no se puede grabar.",
      ),
    );
  }

  return { ok: findings.every((finding) => finding.level !== "error"), used, budget, vector, findings };
}

export function usagePercent(used, budget) {
  if (!budget) return 0;
  return Math.min(100, Math.round((used / budget) * 1000) / 10);
}

/* -------------------------------------------------------------------------- */
/* Diagnóstico del código                                                      */
/* -------------------------------------------------------------------------- */

const error = (message, line = null) => ({ level: "error", message, line });
const warn = (message, line = null) => ({ level: "warn", message, line });
const info = (message, line = null) => ({ level: "info", message, line });

/** Número de línea (1-based) de la primera coincidencia. */
function lineOf(source, index) {
  if (index < 0) return null;
  return source.slice(0, index).split("\n").length;
}

/**
 * Reemplaza el contenido de comentarios y literales por espacios, conservando
 * largos y saltos de línea. Sin esto, cualquier mención a `delay()` escrita en
 * un comentario (o un "Serial." dentro de un string) daría un falso positivo, y
 * los números de línea se mantienen exactos.
 */
function blankCommentsAndStrings(text) {
  let out = "";
  let index = 0;

  while (index < text.length) {
    const pair = text.slice(index, index + 2);

    if (pair === "//") {
      const newline = text.indexOf("\n", index);
      const stop = newline === -1 ? text.length : newline;
      out += " ".repeat(stop - index);
      index = stop;
      continue;
    }

    if (pair === "/*") {
      const close = text.indexOf("*/", index + 2);
      const stop = close === -1 ? text.length : close + 2;
      out += text.slice(index, stop).replace(/[^\n]/g, " ");
      index = stop;
      continue;
    }

    const char = text[index];
    if (char === '"' || char === "'") {
      let cursor = index + 1;
      while (cursor < text.length && text[cursor] !== char) {
        if (text[cursor] === "\\") cursor++;
        cursor++;
      }
      cursor = Math.min(cursor + 1, text.length);
      out += text.slice(index, cursor).replace(/[^\n]/g, " ");
      index = cursor;
      continue;
    }

    out += char;
    index++;
  }

  return out;
}

function firstMatch(source, pattern) {
  const match = pattern.exec(source);
  return match ? { match, line: lineOf(source, match.index) } : null;
}

/**
 * Reglas específicas de ATtiny85 / Digispark / V-USB.
 *
 * No pretende compilar: el compilador de verdad es el agente. Acá van los
 * errores que se explican mejor con contexto de la placa que con un mensaje de
 * avr-gcc, y que además se detectan sin gastar una compilación.
 *
 * @param {string} source
 * @param {{board?: object}} [options]
 * @returns {{level: "error"|"warn"|"info", message: string, line: number|null}[]}
 */
export function lintSource(source, { board } = {}) {
  const findings = [];
  const raw = String(source ?? "");
  // Los #include se buscan en el fuente tal cual; el resto de las reglas corre
  // sobre el código sin comentarios ni literales, así una mención a delay()
  // escrita en un comentario no genera un falso positivo.
  const text = blankCommentsAndStrings(raw);
  const hasDigiMouse = /#\s*include\s*[<"]DigiMouse\.h[>"]/.test(raw);
  const hasDigiKeyboard = /#\s*include\s*[<"]DigiKeyboard\.h[>"]/.test(raw);
  const hasDigiUsb = /#\s*include\s*[<"](DigiUSB|DigiJoystick)[>"]/.test(raw);

  // --- estructura del sketch -------------------------------------------------
  if (!/\bvoid\s+setup\s*\(/.test(text)) {
    findings.push(error("Falta setup(): el main() del core lo llama y el link falla."));
  }
  if (!/\bvoid\s+loop\s*\(/.test(text)) {
    findings.push(error("Falta loop(): el main() del core lo llama en bucle."));
  }

  const mainDef = firstMatch(text, /^\s*(?:int|void)\s+main\s*\(/m);
  if (mainDef) {
    findings.push(
      error("No definas main(): el core de Arduino ya trae uno y vas a tener símbolos duplicados.", mainDef.line),
    );
  }

  // --- reglas de las librerías Digi* / V-USB ---------------------------------
  if (hasDigiMouse && hasDigiKeyboard) {
    findings.push(
      error(
        "DigiMouse.h y DigiKeyboard.h definen el mismo descriptor USB: no se pueden usar en el " +
          "mismo sketch. Elige uno, o usa TrinketHidCombo si necesitas los dos.",
        firstMatch(text, /#\s*include\s*[<"]Digi(?:Mouse|Keyboard)\.h[>"]/)?.line ?? null,
      ),
    );
  }

  if (hasDigiMouse && !/\bDigiMouse\s*\.\s*begin\s*\(/.test(text)) {
    findings.push(
      warn("Incluís DigiMouse.h pero nunca llamás a DigiMouse.begin(): el USB no se reenumera como mouse."),
    );
  }

  if (hasDigiMouse) {
    // DigiMouse.delay() es la que hace usbPoll(); delay() normal corta el USB.
    for (const found of text.matchAll(/(?<![.\w])delay\s*\(/g)) {
      findings.push(
        warn(
          "delay() sin DigiMouse. delante: no llama a usbPoll() y el host corta la comunicación. " +
            "Usa DigiMouse.delay().",
          lineOf(text, found.index),
        ),
      );
      break; // con una alcanza para avisar
    }
  }

  const interval = /#\s*define\s+INTERVALO_MS\s+(\d+)/.exec(text);
  if (interval && Number(interval[1]) < 20) {
    findings.push(
      warn(
        `INTERVALO_MS = ${interval[1]} ms: por debajo de 20 ms el intervalo de reporte HID es más ` +
          "largo que tu delay, así que el siguiente move() pisa al anterior y perdés pasos.",
        lineOf(text, interval.index),
      ),
    );
  }

  // --- pines y periféricos ---------------------------------------------------
  const pin34 = firstMatch(text, /\bdigital(?:Read|Write)\s*\(\s*(?:3|4)\s*[,)]/);
  if (pin34) {
    findings.push(
      warn("Los pines P3 y P4 los usa V-USB para el bit-bang del USB: no los uses para otra cosa.", pin34.line),
    );
  }

  // P5 es RESET: si el sketch lo usa como GPIO (requiere grabar el fusible
  // RSTDISBL), el bootloader micronucleus se pierde y la placa deja de ser
  // grabable por USB.
  const pin5 = firstMatch(text, /\b(?:digital(?:Read|Write)|analog(?:Read|Write))\s*\(\s*(?:5|A0|PIN_B5|PB5)\s*[,)]/);
  if (pin5) {
    findings.push(
      warn(
        "P5 es RESET en la Digispark: usarlo como GPIO exige grabar el fusible RSTDISBL y el bootloader " +
          "micronucleus se pierde (la placa deja de ser grabable por USB). Usá P0, P1 o P2.",
        pin5.line,
      ),
    );
  }

  const serial = firstMatch(text, /\bSerial\s*\./);
  if (serial) {
    findings.push(
      error(
        "El ATtiny85 no tiene UART: Serial no existe. Para depurar por USB usa DigiUSB o DigiKeyboard.",
        serial.line,
      ),
    );
  }

  const attach = firstMatch(text, /\battachInterrupt\s*\(/);
  if (attach) {
    findings.push(info("attachInterrupt() compila, pero evitá interrupciones largas: V-USB necesita atención constante.", attach.line));
  }

  // --- coherencia con la placa elegida ---------------------------------------
  if (board && board.usesUsb === false && (hasDigiMouse || hasDigiKeyboard || hasDigiUsb)) {
    findings.push(
      error(
        `${board.name} es una variante "No USB", así que no tiene V-USB: este sketch no puede hablar ` +
          "por USB. Elige Digispark (Default - 16.5mhz).",
      ),
    );
  }

  const fcpu = /#\s*define\s+F_CPU\s+(\d+)/.exec(text);
  if (board && fcpu && /^(\d+)/.test(board.fCpu ?? "") && !board.fCpu.startsWith(fcpu[1])) {
    findings.push(
      warn(
        `El sketch define F_CPU ${fcpu[1]} pero la placa compila a ${board.fCpu.replace(/L$/, "")}. ` +
          "Las demoras de V-USB van a estar mal calibradas: elimina el #define y deja que lo configure el core.",
        lineOf(text, fcpu.index),
      ),
    );
  }

  return findings;
}

/* -------------------------------------------------------------------------- */
/* Salida del compilador                                                       */
/* -------------------------------------------------------------------------- */

/** Resume el log de arduino-cli: errores, warnings y el uso de memoria. */
/** Desempaqueta los resultados de compilación (agente local o compilador WASM) para el panel. */
export function summarizeBuild(result) {
  const log = result?.log ?? hacerLogWasm(result);
  const errors = [];
  const warnings = [];

  for (const line of log.split("\n")) {
    const texto = line.trim();
    if (!texto) continue;
    if (/^[^:\s]+:\d+:\d+:\s*error/i.test(texto) || /^error:/i.test(texto)) errors.push(texto);
    else if (/^[^:\s]+:\d+:\d+:\s*warning/i.test(texto)) warnings.push(texto);
  }

  const sizes = result?.sizes ?? {};
  return {
    errors,
    warnings,
    flash: sizes.flash ?? result?.bytes ?? result?.bytesFlash ?? null,
    ram: sizes.ram ?? null,
    maximum: sizes.maximum ?? null,
    log,
    tiempos: result?.tiempos ?? null,
    totalMs: result?.totalMs ?? null,
  };
}

/** Si el build viene del compilador WASM (sin log de texto), lo reconstruye desde
 * el logger que el compilador usó en su propio sistema de archivos virtual. */
function hacerLogWasm(result) {
  if (!result || !Array.isArray(result?.errores)) return "";
  const lineas = result.errores.filter(Boolean);
  if (!lineas.length) return "";
  // Los mensajes del compilador llevan prefijo [cc1plus] / [avr-as] / [avr-ld] / [avr-objcopy];
  // para que el parser de errores los considere warnings/errores.
  return lineas.map((l) => l.replace(/^\[/, "")).join("\n");
}

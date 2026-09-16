/* ============================================================================
 *  Parser de Intel HEX
 *
 *  Convierte el .hex que deja `./flash.sh --compile-only` en la imagen cruda
 *  de flash que espera micronucleus (lo mismo que hace
 *  `avr-objcopy -I ihex -O binary`).
 *
 *  Reglas del formato:
 *    :LLAAAATT[DD..]CC
 *      LL = cantidad de bytes de datos, AAAA = dirección, TT = tipo,
 *      DD = datos, CC = checksum (la suma de todos los bytes, incluido CC,
 *      tiene que dar 0 módulo 256).
 *
 *  Tipos que importan para grabar flash: 00 (datos), 01 (EOF), 02 (segmento
 *  extendido), 04 (dirección lineal extendida). Los 03/05 (punto de entrada)
 *  se ignoran: micronucleus deduce el arranque del vector de reset.
 * ========================================================================== */

const TYPE_DATA = 0x00;
const TYPE_EOF = 0x01;
const TYPE_EXT_SEGMENT = 0x02;
const TYPE_START_SEGMENT = 0x03;
const TYPE_EXT_LINEAR = 0x04;
const TYPE_START_LINEAR = 0x05;

/** Espacio de usuario de un ATtiny85 con el bootloader de la Digispark. */
export const DIGISPARK_USER_FLASH = 6012;

/** ¿El texto parece Intel HEX? (para distinguir de un .bin pasado por error) */
export function looksLikeIntelHex(text) {
  return /^\s*:/.test(text);
}

/**
 * Parsea texto Intel HEX y devuelve la imagen de flash.
 *
 * Devuelve { image, end, hasEof, records }. `image` arranca en la dirección 0
 * (así lo emite avr-objcopy para AVR) y los huecos quedan en 0xFF, que es lo
 * que micronucleus espera para las zonas sin datos.
 *
 * @param {string} text contenido del .hex
 * @returns {{image: Uint8Array, end: number, hasEof: boolean, records: number}}
 */
export function parseIntelHex(text) {
  const source = String(text);

  // Un .bin pasado por error como texto produce "líneas" enormes sin ':':
  // cortamos temprano para dar un error claro en vez de recorrer megabytes.
  if (!looksLikeIntelHex(source)) {
    throw new Error(
      'El archivo no parece Intel HEX: ninguna línea empieza con ":". ' +
        'Si es un binario crudo ya se puede grabar tal cual.',
    );
  }

  /** @type {{address: number, bytes: Uint8Array}[]} */
  const chunks = [];
  let base = 0;
  let hasEof = false;
  const lines = source.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const lineNumber = i + 1;
    if (line === "") continue;
    if (hasEof) {
      throw new Error(`Línea ${lineNumber}: hay datos después del registro EOF.`);
    }
    if (line[0] !== ":") {
      throw new Error(`Línea ${lineNumber}: no empieza con ":" (¿archivo corrupto?).`);
    }

    const hex = line.slice(1);
    if (hex.length < 10 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error(`Línea ${lineNumber}: registro Intel HEX inválido.`);
    }

    const raw = new Uint8Array(hex.length / 2);
    for (let j = 0; j < raw.length; j++) {
      raw[j] = parseInt(hex.slice(j * 2, j * 2 + 2), 16);
    }

    const length = raw[0];
    if (raw.length !== length + 5) {
      throw new Error(
        `Línea ${lineNumber}: el registro dice ${length} bytes de datos pero trae ${raw.length - 5}.`,
      );
    }

    let checksum = 0;
    for (const byte of raw) checksum = (checksum + byte) & 0xff;
    if (checksum !== 0) {
      throw new Error(
        `Línea ${lineNumber}: checksum inválido (0x${checksum.toString(16).padStart(2, "0")} != 0).`,
      );
    }

    const address = (raw[1] << 8) | raw[2];
    const type = raw[3];
    const data = raw.slice(4, 4 + length);

    switch (type) {
      case TYPE_DATA:
        chunks.push({ address: base + address, bytes: data });
        break;
      case TYPE_EOF:
        hasEof = true;
        break;
      case TYPE_EXT_SEGMENT:
        base = (((data[0] << 8) | data[1]) << 4) >>> 0;
        break;
      case TYPE_EXT_LINEAR:
        base = (((data[0] << 8) | data[1]) << 16) >>> 0;
        break;
      case TYPE_START_SEGMENT:
      case TYPE_START_LINEAR:
        break; // no hacen falta para grabar la flash
      default:
        throw new Error(`Línea ${lineNumber}: tipo de registro desconocido (0x${type.toString(16)}).`);
    }
  }

  if (chunks.length === 0) throw new Error("El archivo no tiene datos de firmware.");

  let end = 0;
  for (const chunk of chunks) {
    if (chunk.address + chunk.bytes.length > end) end = chunk.address + chunk.bytes.length;
  }

  const image = new Uint8Array(end).fill(0xff);
  for (const chunk of chunks) {
    image.set(chunk.bytes, chunk.address);
  }

  return { image, end, hasEof, records: chunks.length };
}

/**
 * Acepta el contenido crudo de un archivo y devuelve la imagen de flash,
 * detectando solo si es Intel HEX o un binario.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {string} [fileName]
 * @returns {{image: Uint8Array, format: string}}
 */
export function decodeFirmware(buffer, fileName = "") {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  if (bytes.length === 0) throw new Error(`El archivo ${fileName} está vacío.`);

  // ':' = 0x3A. Los .bin de AVR casi nunca empiezan con ese byte.
  if (bytes[0] === 0x3a) {
    const { image } = parseIntelHex(new TextDecoder().decode(bytes));
    return { image, format: "Intel HEX" };
  }

  if (/\.hex$/i.test(fileName)) {
    throw new Error(
      `El archivo ${fileName} tiene extensión .hex pero no es Intel HEX. Elimínalo y vuelve a compilar.`,
    );
  }

  return { image: bytes, format: "binario crudo" };
}

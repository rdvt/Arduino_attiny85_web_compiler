/*
 * AVR assembler for ATtiny85, 100% browser-side JavaScript.
 *
 * Two-pass assembler for the AVR instruction set commonly used on ATtiny25/45/85.
 * It emits a raw flash image and Intel HEX without invoking a process, loading a
 * compiler, or making network requests.
 */

const TARGETS = Object.freeze({
  attiny85: Object.freeze({
    name: "ATtiny85",
    flashBytes: 8192,
    ramBytes: 512,
    userFlashBytes: 8192,
    ioBytes: 64,
    registerCount: 32,
  }),
  digispark: Object.freeze({
    name: "Digispark ATtiny85 + micronucleus",
    flashBytes: 8192,
    ramBytes: 512,
    userFlashBytes: 6012,
    ioBytes: 64,
    registerCount: 32,
  }),
});

const FLAGS = Object.freeze({ C: 0, Z: 1, N: 2, V: 3, S: 4, H: 5, T: 6, I: 7 });
const IO = Object.freeze({
  SREG: 0x3f, SPL: 0x3d, SPH: 0x3e, GIMSK: 0x3b, GIFR: 0x3a,
  TIMSK: 0x39, TIFR: 0x38, MCUCR: 0x35, MCUSR: 0x34, SMCR: 0x33,
  ACSR: 0x30, OSCCAL: 0x31, PRR: 0x20, CLKPR: 0x26,
  PORTB: 0x18, DDRB: 0x17, PINB: 0x16, DIDR0: 0x14,
  OCR0A: 0x29, OCR0B: 0x28, TCCR0A: 0x2a, TCCR0B: 0x33,
  TCNT0: 0x32, TCNT1: 0x2f, OCR1A: 0x2e, OCR1C: 0x2d,
  PLLCSR: 0x27, WDTCR: 0x21, EEARL: 0x1e, EEDR: 0x1d, EECR: 0x1c,
});

const REG_ALIASES = Object.freeze({
  zero: 1, xl: 26, xh: 27, yl: 28, yh: 29, zl: 30, zh: 31,
});

export class AssemblerError extends Error {
  constructor(message, line = null, column = null) {
    super(message);
    this.name = "AssemblerError";
    this.line = line;
    this.column = column;
  }
}

function fail(message, line, column = null) {
  throw new AssemblerError(message, line, column);
}

function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ";" || (char === "/" && text[i + 1] === "/")) return text.slice(0, i);
  }
  return text;
}

function splitOperands(text, line) {
  const result = [];
  let start = 0;
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      result.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quote) fail("Cadena sin cerrar.", line);
  if (depth !== 0) fail("Paréntesis sin cerrar.", line);
  const last = text.slice(start).trim();
  if (last || result.length) result.push(last);
  return result;
}

function decodeString(text, line) {
  const value = text.trim();
  if (!((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    fail(`Se esperaba una cadena: ${text}`, line);
  }
  let out = "";
  for (let i = 1; i < value.length - 1; i++) {
    if (value[i] !== "\\") {
      out += value[i];
      continue;
    }
    const next = value[++i];
    const escapes = { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"', "'": "'", 0: "\0" };
    if (next === "x") {
      const hex = value.slice(i + 1, i + 3);
      if (!/^[0-9a-f]{2}$/i.test(hex)) fail("Escape hexadecimal inválido.", line);
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2;
    } else if (next === "u") {
      const hex = value.slice(i + 1, i + 5);
      if (!/^[0-9a-f]{4}$/i.test(hex)) fail("Escape Unicode inválido.", line);
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else if (escapes[next] !== undefined) out += escapes[next];
    else out += next;
  }
  return out;
}

function charValue(text, line) {
  const value = decodeString(text, line);
  if (value.length !== 1) fail("Un literal de carácter debe tener exactamente un carácter.", line);
  return value.charCodeAt(0);
}

function tokenizeExpression(text, line) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    const two = text.slice(i, i + 2);
    if (["<<", ">>", "<=", ">=", "==", "!=", "&&", "||"].includes(two)) {
      tokens.push(two); i += 2; continue;
    }
    if ("()+-*/%&|^~!<>".includes(text[i])) { tokens.push(text[i++]); continue; }
    if (text[i] === "'" || text[i] === '"') {
      const quote = text[i];
      let end = i + 1;
      while (end < text.length) {
        if (text[end] === "\\") end += 2;
        else if (text[end] === quote) break;
        else end++;
      }
      if (end >= text.length) fail("Cadena sin cerrar en expresión.", line);
      tokens.push({ type: "number", value: charValue(text.slice(i, end + 1), line) });
      i = end + 1;
      continue;
    }
    const match = /^(?:\$[0-9a-f]+|0[xX][0-9a-f]+|0[bB][01]+|0[oO][0-7]+|\d+|[A-Za-z_.$][\w.$]*)/i.exec(text.slice(i));
    if (!match) fail(`Token inválido en expresión cerca de «${text.slice(i)}».`, line);
    const raw = match[0];
    if (/^(?:\$[0-9a-f]+|0[xX]|0[bB]|0[oO]|\d)/i.test(raw)) {
      let value;
      if (raw[0] === "$") value = parseInt(raw.slice(1), 16);
      else if (/^0[xX]/.test(raw)) value = parseInt(raw.slice(2), 16);
      else if (/^0[bB]/.test(raw)) value = parseInt(raw.slice(2), 2);
      else if (/^0[oO]/.test(raw)) value = parseInt(raw.slice(2), 8);
      else value = Number(raw);
      tokens.push({ type: "number", value });
    } else tokens.push({ type: "name", value: raw });
    i += raw.length;
  }
  return tokens;
}

function evaluateExpression(text, symbols, line, { allowUndefined = false } = {}) {
  const tokens = tokenizeExpression(String(text), line);
  let index = 0;
  const precedence = { "||": 1, "&&": 2, "|": 3, "^": 4, "&": 5, "==": 6, "!=": 6, "<": 7, ">": 7, "<=": 7, ">=": 7, "<<": 8, ">>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10 };
  const peek = () => tokens[index];
  const take = () => tokens[index++];
  const primary = () => {
    const token = take();
    if (!token) fail("Expresión incompleta.", line);
    if (token === "(") {
      const value = expression(0);
      if (take() !== ")") fail("Falta ) en expresión.", line);
      return value;
    }
    if (token === "+") return +primary();
    if (token === "-") return -primary();
    if (token === "~") return ~primary();
    if (token === "!") return primary() ? 0 : 1;
    if (token.type === "number") return token.value;
    if (token.type === "name") {
      const lower = token.value.toLowerCase();
      if (["low", "lo8", "high", "hi8", "byte1", "byte2", "byte3", "byte4"].includes(lower) && peek() === "(") {
        take();
        const value = expression(0);
        if (take() !== ")") fail(`Falta ) después de ${token.value}.`, line);
        if (["low", "lo8", "byte1"].includes(lower)) return value & 0xff;
        if (["high", "hi8", "byte2"].includes(lower)) return (value >>> 8) & 0xff;
        if (lower === "byte3") return (value >>> 16) & 0xff;
        return (value >>> 24) & 0xff;
      }
      if (symbols.has(token.value)) return symbols.get(token.value);
      if (symbols.has(lower)) return symbols.get(lower);
      if (allowUndefined) return 0;
      fail(`Símbolo no definido: ${token.value}.`, line);
    }
    fail("Operando inválido en expresión.", line);
  };
  const expression = (minPrecedence) => {
    let left = primary();
    while (typeof peek() === "string" && precedence[peek()] >= minPrecedence) {
      const op = take();
      const right = expression(precedence[op] + 1);
      switch (op) {
        case "+": left += right; break; case "-": left -= right; break;
        case "*": left *= right; break; case "/": left = right === 0 ? 0 : Math.trunc(left / right); break;
        case "%": left %= right; break; case "<<": left <<= right; break; case ">>": left >>= right; break;
        case "&": left &= right; break; case "|": left |= right; break; case "^": left ^= right; break;
        case "&&": left = left && right ? 1 : 0; break; case "||": left = left || right ? 1 : 0; break;
        case "==": left = left === right ? 1 : 0; break; case "!=": left = left !== right ? 1 : 0; break;
        case "<": left = left < right ? 1 : 0; break; case ">": left = left > right ? 1 : 0; break;
        case "<=": left = left <= right ? 1 : 0; break; case ">=": left = left >= right ? 1 : 0; break;
      }
    }
    return left;
  };
  const value = expression(0);
  if (index !== tokens.length) fail(`Expresión inválida cerca de «${tokens[index].value ?? tokens[index]}».`, line);
  return Number.isFinite(value) ? value : 0;
}

function number(text, symbols, line, options = {}) {
  const key = String(text).trim();
  if (Object.prototype.hasOwnProperty.call(IO, key.toUpperCase())) return IO[key.toUpperCase()];
  if (/^0x/i.test(key) || /^\d/.test(key) || /^\$/.test(key) || /^0[bBoO]/.test(key) || /^[()+\-~]/.test(key)) {
    return evaluateExpression(key, symbols, line, options);
  }
  return evaluateExpression(key, symbols, line, options);
}

function reg(text, line, symbols = null) {
  const clean = text.trim().toLowerCase();
  if (REG_ALIASES[clean] !== undefined) return REG_ALIASES[clean];
  const match = /^r(\d+)$/.exec(clean);
  if (match) {
    if (Number(match[1]) > 31) fail(`Registro inválido: ${text}.`, line);
    return Number(match[1]);
  }
  if (symbols?.has(text.trim())) {
    const value = symbols.get(text.trim());
    if (Number.isInteger(value) && value >= 0 && value <= 31) return value;
  }
  fail(`Registro inválido: ${text}.`, line);
}

function requireRegs(args, count, line, symbols = null) {
  if (args.length !== count) fail(`Se esperaban ${count} operandos y llegaron ${args.length}.`, line);
  return args.map((arg) => reg(arg, line, symbols));
}

function range(value, min, max, label, line) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label} fuera de rango (${value}; esperado ${min}..${max}).`, line);
  return value;
}

function word(value) {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function pair(text, line) {
  const value = text.trim().toUpperCase();
  if (value === "X") return { kind: "X" };
  if (value === "Y") return { kind: "Y" };
  if (value === "Z") return { kind: "Z" };
  if (/^[XYZ][+-]$/.test(value)) return { kind: value[0], mode: value[1] };
  if (/^-[XYZ]$/.test(value)) return { kind: value[1], mode: "-" };
  fail(`Puntero inválido: ${text}.`, line);
}

function relative(value, bits, pc, label, line) {
  const delta = value - (pc + 2);
  if ((delta & 1) !== 0) fail(`${label} debe apuntar a una dirección de instrucción par.`, line);
  const k = delta / 2;
  const max = (1 << (bits - 1)) - 1;
  const min = -(1 << (bits - 1));
  return range(k, min, max, `${label} relativo`, line);
}

function encodeBranch(name, args, symbols, pc, line) {
  const aliases = {
    brcc: [0, 0], brsh: [0, 0], brcs: [0, 1], brlo: [0, 1], breq: [1, 1], brne: [1, 0],
    brmi: [2, 1], brpl: [2, 0], brvs: [3, 1], brvc: [3, 0], brlt: [4, 1], brge: [4, 0],
    brhs: [5, 1], brhc: [5, 0], brts: [6, 1], brtc: [6, 0], brie: [7, 1], brid: [7, 0],
  };
  let bit;
  let set;
  let target;
  if (aliases[name]) {
    [bit, set] = aliases[name];
    target = args[0];
  } else {
    if (args.length !== 2) fail(`${name.toUpperCase()} necesita bit y destino.`, line);
    bit = range(number(args[0], symbols, line), 0, 7, "bit", line);
    set = name === "brbs" ? 1 : 0;
    target = args[1];
  }
  if (!target) fail(`Falta destino para ${name}.`, line);
  const k = relative(number(target, symbols, line), 7, pc, name, line);
  return word((set ? 0xf000 : 0xf400) | ((k & 0x7f) << 3) | bit);
}

function encodeInstruction(name, args, symbols, pc, line) {
  const op = name.toLowerCase();
  const rr = (base) => {
    const [d, r] = requireRegs(args, 2, line, symbols);
    return base | (d << 4) | (r & 0x0f) | ((r & 0x10) << 5);
  };
  const imm = (base, minReg = 16) => {
    if (args.length !== 2) fail("Se esperaban registro e inmediato.", line);
    const d = reg(args[0], line, symbols); range(d, minReg, 31, "registro", line);
    const k = range(number(args[1], symbols, line), 0, 255, "inmediato", line);
    return base | ((k & 0xf0) << 4) | ((d - minReg) << 4) | (k & 0x0f);
  };
  const one = (base) => {
    const [d] = requireRegs(args, 1, line, symbols); return base | (d << 4);
  };

  if (["brcc", "brsh", "brcs", "brlo", "breq", "brne", "brmi", "brpl", "brvs", "brvc", "brlt", "brge", "brhs", "brhc", "brts", "brtc", "brie", "brid", "brbs", "brbc"].includes(op)) {
    return encodeBranch(op, args, symbols, pc, line);
  }
  if (op === "nop") return word(0x0000); if (op === "ret") return word(0x9508); if (op === "reti") return word(0x9518);
  if (op === "sleep") return word(0x9588); if (op === "wdr") return word(0x95a8); if (op === "break") return word(0x9598);
  if (op === "ijmp") return word(0x9409); if (op === "eijmp") return word(0x9419);
  if (op === "rjmp" || op === "rcall") {
    if (args.length !== 1) fail(`Se esperaba un destino para ${op}.`, line);
    const k = relative(number(args[0], symbols, line), 12, pc, op, line);
    return word((op === "rjmp" ? 0xc000 : 0xd000) | (k & 0x0fff));
  }
  if (op === "jmp" || op === "call") {
    if (args.length !== 1) fail(`Se esperaba un destino para ${op}.`, line);
    const k = range(Math.trunc(number(args[0], symbols, line) / 2), 0, 0x3fffff, "destino", line);
    const first = (op === "jmp" ? 0x940c : 0x940e) | ((k & 0x3e0000) >>> 13) | ((k & 0x10000) >>> 16);
    return [...word(first), ...word(k)];
  }
  if (["add", "adc", "sub", "sbc", "and", "or", "eor", "cp", "cpc", "cpse", "mov"].includes(op)) {
    const bases = { add: 0x0c00, adc: 0x1c00, sub: 0x1800, sbc: 0x0800, and: 0x2000, or: 0x2800, eor: 0x2400, cp: 0x1400, cpc: 0x0400, cpse: 0x1000, mov: 0x2c00 };
    return word(rr(bases[op]));
  }
  if (["ldi", "subi", "sbci", "andi", "ori", "cpi", "sbr"].includes(op)) {
    const bases = { ldi: 0xe000, subi: 0x5000, sbci: 0x4000, andi: 0x7000, ori: 0x6000, cpi: 0x3000, sbr: 0x6000 };
    return word(imm(bases[op]));
  }
  if (op === "cbr") {
    if (args.length !== 2) fail("CBR necesita registro e inmediato.", line);
    const d = reg(args[0], line, symbols); range(d, 16, 31, "registro", line);
    const k = (~number(args[1], symbols, line)) & 0xff;
    return word(0x7000 | ((k & 0xf0) << 4) | ((d - 16) << 4) | (k & 0x0f));
  }
  if (op === "adiw" || op === "sbiw") {
    if (args.length !== 2) fail(`${op.toUpperCase()} necesita registro par e inmediato.`, line);
    const d = reg(args[0], line, symbols); range(d, 24, 30, "registro par", line);
    if (d % 2) fail("ADIW/SBIW requiere r24, r26, r28 o r30.", line);
    const k = range(number(args[1], symbols, line), 0, 63, "inmediato", line);
    return word((op === "adiw" ? 0x9600 : 0x9700) | (((d - 24) >> 1) << 4) | ((k & 0x30) << 2) | (k & 0x0f));
  }
  if (op === "movw") {
    const [d, r] = requireRegs(args, 2, line, symbols); if (d % 2 || r % 2) fail("MOVW requiere registros pares.", line); range(d, 0, 30, "registro destino", line); range(r, 0, 30, "registro fuente", line);
    return word(0x0100 | ((d >> 1) << 4) | (r >> 1));
  }
  if (["com", "neg", "swap", "inc", "dec", "asr", "lsr", "ror"].includes(op)) {
    const bases = { com: 0x9400, neg: 0x9401, swap: 0x9402, inc: 0x9403, dec: 0x940a, asr: 0x9405, lsr: 0x9406, ror: 0x9407 };
    return word(one(bases[op]));
  }
  if (op === "ser") {    const [d] = requireRegs(args, 1, line, symbols); range(d, 16, 31, "registro", line); return word(0xef0f | ((d - 16) << 4)); }
  if (["clr", "tst", "lsl", "rol"].includes(op)) {
    const [d] = requireRegs(args, 1, line, symbols); const op2 = { clr: "eor", tst: "and", lsl: "add", rol: "adc" }[op];
    const bases = { eor: 0x2400, and: 0x2000, add: 0x0c00, adc: 0x1c00 }; return word(bases[op2] | (d << 4) | (d & 0x0f) | ((d & 0x10) << 5));
  }
  if (["in", "out"].includes(op)) {
    if (args.length !== 2) fail(`${op.toUpperCase()} necesita registro e IO.` , line);
    const first = op === "in" ? reg(args[0], line, symbols) : reg(args[1], line, symbols);
    const address = range(number(op === "in" ? args[1] : args[0], symbols, line), 0, 63, "IO", line);
    return word((op === "in" ? 0xb000 : 0xb800) | ((address & 0x30) << 5) | (first << 4) | (address & 0x0f));
  }
  if (["sbi", "cbi", "sbic", "sbis"].includes(op)) {
    if (args.length !== 2) fail(`${op.toUpperCase()} necesita IO y bit.`, line);
    const address = range(number(args[0], symbols, line), 0, 31, "IO para bit", line);
    const bit = range(number(args[1], symbols, line), 0, 7, "bit", line);
    const bases = { cbi: 0x9800, sbi: 0x9a00, sbic: 0x9900, sbis: 0x9b00 };
    return word(bases[op] | ((address & 0x1f) << 3) | bit);
  }
  if (["bset", "bclr", "sec", "clc", "sen", "cln", "sez", "clz", "sei", "cli", "ses", "cls", "sev", "clv", "seh", "clh", "set", "clt"].includes(op)) {
    const aliases = { sec: ["bset", 0], clc: ["bclr", 0], sen: ["bset", 2], cln: ["bclr", 2], sez: ["bset", 1], clz: ["bclr", 1], sei: ["bset", 7], cli: ["bclr", 7], ses: ["bset", 4], cls: ["bclr", 4], sev: ["bset", 3], clv: ["bclr", 3], seh: ["bset", 5], clh: ["bclr", 5], set: ["bset", 6], clt: ["bclr", 6] };
    const [base, bit] = aliases[op] || [op, number(args[0], symbols, line)];
    if (base === "bset" || base === "bclr") return word((base === "bset" ? 0x9408 : 0x9488) | (range(bit, 0, 7, "bit", line) << 4));
  }
  if (["push", "pop"].includes(op)) {
    const [d] = requireRegs(args, 1, line, symbols); return word((op === "push" ? 0x920f : 0x900f) | (d << 4));
  }
  if (op === "mul") { const value = rr(0x9c00); return word(value); }
  if (op === "lpm") {
    if (args.length === 0) return word(0x95c8);
    if (args.length !== 2) fail("LPM acepta LPM o LPM Rd,Z[+].", line);
    const d = reg(args[0], line, symbols); const p = pair(args[1], line);
    if (p.kind !== "Z" || (p.mode && p.mode !== "+")) fail("LPM usa Z o Z+.", line);
    return word(0x9004 | (d << 4) | (p.mode === "+" ? 1 : 0));
  }
  if (["ld", "st"].includes(op)) {
    if (args.length !== 2) fail(`${op.toUpperCase()} necesita registro y puntero.`, line);
    const isLoad = op === "ld"; const d = reg(isLoad ? args[0] : args[1], line, symbols); const p = pair(isLoad ? args[1] : args[0], line);
    const bases = { X: isLoad ? 0x900c : 0x920c, Y: isLoad ? 0x8008 : 0x8208, Z: isLoad ? 0x8000 : 0x8200 };
    const modeWords = {
      X: { "-": 0x0002, "+": 0x0001 },
      Y: { "-": 0x1002, "+": 0x1001 },
      Z: { "-": 0x0002, "+": 0x0001 },
    };
    if (p.mode && modeWords[p.kind][p.mode] === undefined) fail("Modo de puntero inválido.", line);
    let value = bases[p.kind];
    if (p.mode) {
      const modeBase = p.kind === "X"
        ? (isLoad ? 0x900c : 0x920c)
        : p.kind === "Y"
          ? (isLoad ? 0x8008 : 0x8208)
          : (isLoad ? 0x9000 : 0x9200);
      value = modeBase | modeWords[p.kind][p.mode];
    }
    value |= d << 4;
    return word(value);
  }
  if (["ldd", "std"].includes(op)) {
    if (args.length !== 2) fail(`${op.toUpperCase()} necesita registro/puntero y desplazamiento.`, line);
    const isLoad = op === "ldd"; const d = reg(isLoad ? args[0] : args[1], line, symbols); const pointer = isLoad ? args[1] : args[0];
    const match = /^([YZ])\s*\+\s*(.+)$/i.exec(pointer); if (!match) fail("LDD/STD requiere Y+q o Z+q.", line);
    const q = range(number(match[2], symbols, line), 0, 63, "desplazamiento", line); const base = match[1].toUpperCase() === "Y" ? 0x8008 : 0x8000;
    const opcode = (isLoad ? base : base + 0x0200) | (d << 4) | ((q & 0x20) << 8) | ((q & 0x18) << 7) | (q & 7);
    return word(opcode);
  }
  if (["lds", "sts"].includes(op)) {
    if (args.length !== 2) fail(`${op.toUpperCase()} necesita registro y dirección.`, line);
    const d = reg(args[op === "lds" ? 0 : 1], line, symbols); range(d, 0, 31, "registro", line);
    const address = range(number(args[op === "lds" ? 1 : 0], symbols, line), 0, 0xffff, "dirección SRAM/IO", line);
    const first = (op === "lds" ? 0x9000 : 0x9200) | (d << 4);
    return [...word(first), ...word(address)];
  }
  fail(`Instrucción no soportada: ${name}.`, line);
}

function instructionSize(name) {
  return ["jmp", "call", "lds", "sts"].includes(name.toLowerCase()) ? 4 : 2;
}

function parseLine(raw, line) {
  let text = stripComment(raw).trim();
  const labels = [];
  while (text) {
    const match = /^([A-Za-z_.$][\w.$]*):\s*/.exec(text);
    if (!match) break;
    labels.push(match[1]); text = text.slice(match[0].length).trim();
  }
  if (!text) return { labels, op: null, args: [], source: raw };
  const match = /^([^\s]+)(?:\s+(.*))?$/.exec(text);
  const op = match[1];
  const args = match[2] ? splitOperands(match[2], line) : [];
  return { labels, op, args, source: raw };
}

function directiveSize(op, args, symbols, pc, line) {
  const lower = op.toLowerCase();
  if (lower === ".org") return null;
  if ([".byte", ".db"].includes(lower)) return args.reduce((total, arg) => total + (arg.startsWith('"') ? decodeString(arg, line).length : 1), 0);
  if ([".word", ".dw"].includes(lower)) return args.length * 2;
  if ([".dword", ".long"].includes(lower)) return args.length * 4;
  if ([".ascii", ".asciz", ".string"].includes(lower)) return args.length ? args.reduce((total, arg) => total + decodeString(arg, line).length + (lower === ".asciz" || lower === ".string" ? 1 : 0), 0) : 0;
  if (lower === ".device") {
    if (args.length !== 1 || !/^(attiny25|attiny45|attiny85|attinyx5)$/i.test(args[0])) fail(`Dispositivo no soportado: ${args.join(" ")}. Usá attiny85.`, line);
    return 0;
  }
  if (lower === ".fill") {
    const count = range(number(args[0], symbols, line, { allowUndefined: true }), 0, 65536, "cantidad", line);
    const size = args[1] ? range(number(args[1], symbols, line, { allowUndefined: true }), 1, 4, "tamaño .fill", line) : 1;
    return count * size;
  }
  if (lower === ".align") return 0;
  if ([".equ", ".set", ".def", ".device", ".cseg", ".text", ".global", ".extern", ".include", ".message"].includes(lower)) return 0;
  return undefined;
}

function emitDirective(op, args, symbols, state, line) {
  const lower = op.toLowerCase();
  if (lower === ".org") {
    const address = range(number(args[0], symbols, line), 0, state.target.flashBytes - 1, "dirección .org", line);
    if (address < state.pc) fail(".org no puede retroceder el contador.", line);
    state.pc = address; return;
  }
  if (lower === ".align") {
    const alignment = range(number(args[0], symbols, line), 1, state.target.flashBytes, "alineación", line);
    state.pc = Math.ceil(state.pc / alignment) * alignment; return;
  }
  const bytes = [];
  const pushValue = (value, size) => { for (let i = 0; i < size; i++) bytes.push((value >>> (8 * i)) & 0xff); };
  if ([".byte", ".db"].includes(lower)) for (const arg of args) {
    if (arg.startsWith('"')) for (const char of decodeString(arg, line)) bytes.push(char.charCodeAt(0) & 0xff);
    else pushValue(range(number(arg, symbols, line), -128, 255, "byte", line), 1);
  }
  else if ([".word", ".dw"].includes(lower)) for (const arg of args) pushValue(number(arg, symbols, line), 2);
  else if ([".dword", ".long"].includes(lower)) for (const arg of args) pushValue(number(arg, symbols, line), 4);
  else if ([".ascii", ".asciz", ".string"].includes(lower)) for (const arg of args) {
    for (const char of decodeString(arg, line)) bytes.push(char.charCodeAt(0) & 0xff);
    if (lower !== ".ascii") bytes.push(0);
  }
  else if (lower === ".fill") {
    const count = range(number(args[0], symbols, line), 0, 65536, "cantidad", line);
    const size = args[1] ? range(number(args[1], symbols, line), 1, 4, "tamaño .fill", line) : 1;
    const value = args[2] ? range(number(args[2], symbols, line), 0, 255, "relleno", line) : 0;
    for (let i = 0; i < count * size; i++) bytes.push(value);
  }
  for (const value of bytes) { state.bytes.set(state.pc++, value); }
}

function normalizeDefineArgs(args) {
  if (args.length === 2) return args;
  if (args.length === 1) {
    const match = /^([^=]+?)\s*=\s*(.+)$/.exec(args[0]);
    if (match) return [match[1].trim(), match[2].trim()];
  }
  return args;
}

function defineDirective(op, args, symbols, line) {
  const lower = op.toLowerCase();
  if ([".equ", ".set", ".def"].includes(lower)) {
    const normalized = normalizeDefineArgs(args);
    if (normalized.length !== 2) fail(`${op} necesita nombre y valor.`, line);
    if (lower === ".def") symbols.set(normalized[0], reg(normalized[1], line, symbols));
    else symbols.set(normalized[0], evaluateExpression(normalized[1], symbols, line, { allowUndefined: true }));
    return true;
  }
  return false;
}

function intelHex(image, recordSize = 16) {
  const lines = [];
  const record = (address, type, data) => {
    const payload = [data.length, (address >>> 8) & 0xff, address & 0xff, type, ...data];
    const checksum = (-payload.reduce((a, b) => a + b, 0)) & 0xff;
    return `:${payload.map((b) => b.toString(16).padStart(2, "0")).join("")}${checksum.toString(16).padStart(2, "0")}`.toUpperCase();
  };
  for (let address = 0; address < image.length; address += recordSize) lines.push(record(address, 0, [...image.slice(address, address + recordSize)]));
  lines.push(":00000001FF");
  return lines.join("\n") + "\n";
}

export function assemble(source, options = {}) {
  const targetName = options.target === "digispark" ? "digispark" : "attiny85";
  const target = TARGETS[targetName];
  const lines = String(source ?? "").split(/\r?\n/);
  const symbols = new Map(Object.entries(IO));
  for (const [name, value] of Object.entries(FLAGS)) symbols.set(name, value);
  const parsed = lines.map((text, index) => parseLine(text, index + 1));
  let pc = 0;
  const diagnostics = [];

  for (const item of parsed) {
    for (const label of item.labels) {
      if (symbols.has(label)) fail(`Símbolo duplicado: ${label}.`, parsed.indexOf(item) + 1);
      symbols.set(label, pc);
    }
    if (!item.op) continue;
    const lower = item.op.toLowerCase();
    if (defineDirective(lower, item.args, symbols, parsed.indexOf(item) + 1)) continue;
    const size = directiveSize(lower, item.args, symbols, pc, parsed.indexOf(item) + 1);
    if (size !== undefined) {
      if (size === null) { const value = number(item.args[0], symbols, parsed.indexOf(item) + 1, { allowUndefined: true }); pc = value; }
      else if (lower === ".align") { const alignment = Math.max(1, number(item.args[0], symbols, parsed.indexOf(item) + 1, { allowUndefined: true })); pc = Math.ceil(pc / alignment) * alignment; }
      else pc += size;
      continue;
    }
    pc += instructionSize(item.op);
  }

  if (pc > target.userFlashBytes) fail(`El programa supera el límite del objetivo ${target.name}: ${pc} bytes (máximo ${target.userFlashBytes}).`, lines.length);
  const bytes = new Map();
  const state = { pc: 0, bytes, target };
  for (let index = 0; index < parsed.length; index++) {
    const item = parsed[index]; const line = index + 1;
    if (!item.op) continue;
    const lower = item.op.toLowerCase();
    if (defineDirective(lower, item.args, symbols, line)) continue;
    if ([".org", ".align", ".byte", ".db", ".word", ".dw", ".dword", ".long", ".ascii", ".asciz", ".string", ".fill"].includes(lower)) {
      emitDirective(lower, item.args, symbols, state, line); continue;
    }
    if (lower === ".device") {
      if (item.args.length !== 1 || !/^(attiny25|attiny45|attiny85|attinyx5)$/i.test(item.args[0])) fail(`Dispositivo no soportado: ${item.args.join(" ")}. Usá attiny85.`, line);
      continue;
    }
    if ([".device", ".cseg", ".text", ".global", ".extern", ".include", ".message"].includes(lower)) continue;
    if (state.pc % 2 && !lower.startsWith(".")) fail("Una instrucción debe comenzar en una dirección par.", line);
    const encoded = encodeInstruction(item.op, item.args, symbols, state.pc, line);
    if (!Array.isArray(encoded)) fail("No se pudo codificar la instrucción.", line);
    for (const value of encoded) state.bytes.set(state.pc++, value);
  }

  const end = state.bytes.size ? Math.max(...state.bytes.keys()) + 1 : 0;
  if (end > target.userFlashBytes) fail(`El programa termina en 0x${end.toString(16)} y supera el límite del objetivo (${target.userFlashBytes} bytes).`, lines.length);
  const image = new Uint8Array(end).fill(0xff);
  for (const [address, value] of state.bytes) image[address] = value;
  return {
    ok: true,
    target,
    image,
    hex: intelHex(image),
    symbols: Object.fromEntries([...symbols.entries()].filter(([key]) => !Object.prototype.hasOwnProperty.call(IO, key))),
    bytes: image.length,
    usedBytes: [...state.bytes.keys()].length,
    diagnostics,
  };
}

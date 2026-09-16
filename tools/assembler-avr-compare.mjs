import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "../assembler/avr85.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const toolRoot = join(process.env.HOME ?? "", "Library/Arduino15/packages/arduino/tools/avr-gcc");
const candidates = [
  process.env.AVR_AS,
  join(toolRoot, "7.3.0-atmel3.6.1-arduino7/bin/avr-as"),
  join(toolRoot, "4.8.1-arduino5/bin/avr-as"),
].filter(Boolean);
const avrAs = candidates.find(existsSync);
const avrLdCandidates = [
  process.env.AVR_LD,
  avrAs && join(dirname(avrAs), "avr-ld"),
].filter(Boolean);
const avrLd = avrLdCandidates.find(existsSync);
const objcopyCandidates = [
  process.env.AVR_OBJCOPY,
  avrAs && join(dirname(avrAs), "avr-objcopy"),
].filter(Boolean);
const avrObjcopy = objcopyCandidates.find(existsSync);
assert.ok(avrAs, "No se encontró avr-as; define AVR_AS para indicar su ruta.");
assert.ok(avrLd, "No se encontró avr-ld; define AVR_LD para indicar su ruta.");
assert.ok(avrObjcopy, "No se encontró avr-objcopy; define AVR_OBJCOPY para indicar su ruta.");

const source = `
.text
start:
  nop
  ldi r16, 0x42
  ldi r31, 0xff
  mov r17, r16
  movw r30, r28
  add r16, r17
  adc r18, r19
  sub r20, r21
  sbc r22, r23
  and r16, r17
  or r18, r19
  eor r20, r21
  cp r22, r23
  cpc r24, r25
  cpse r26, r27
  subi r16, 1
  sbci r17, 2
  andi r18, 3
  ori r19, 4
  cpi r20, 5
  adiw r24, 6
  sbiw r28, 7
  com r16
  neg r17
  swap r18
  inc r19
  dec r20
  asr r21
  lsr r22
  ror r23
  push r24
  pop r25
  clr r26
  tst r27
  lsl r28
  rol r29
  in r16, 0x18
  out 0x18, r16
  sbi 0x18, 2
  cbi 0x18, 3
  sbic 0x18, 4
  sbis 0x18, 5
  bset 0
  bclr 1
  sec
  clz
  lpm
  lpm r16, Z
  lpm r17, Z+
  ld r18, X
  ld r19, X+
  ld r20, -X
  ld r21, Y
  ld r22, Y+
  ld r23, -Y
  ld r24, Z
  ld r25, Z+
  ld r26, -Z
  st X, r27
  st X+, r28
  st -X, r29
  st Y, r30
  st Y+, r31
  st -Y, r16
  st Z, r17
  st Z+, r18
  st -Z, r19
  ldd r20, Y+5
  ldd r21, Z+6
  std Y+7, r22
  std Z+8, r23
  lds r24, 0x1234
  sts 0x1234, r25
branch_target:
  rjmp branch_target
  rcall branch_target
  brne branch_target
  brbs 0, branch_target
`;

const web = assemble(source);
const temp = mkdtempSync(join(root, ".assembler-compare-"));
try {
  const asmPath = join(temp, "matrix.s");
  const objectPath = join(temp, "matrix.o");
  const elfPath = join(temp, "matrix.elf");
  const binaryPath = join(temp, "matrix.bin");
  writeFileSync(asmPath, source);
  execFileSync(avrAs, ["-mmcu=attiny85", "-o", objectPath, asmPath], { cwd: root, stdio: "pipe" });
  execFileSync(avrLd, ["-m", "avr25", "-o", elfPath, objectPath], { cwd: root, stdio: "pipe" });
  execFileSync(avrObjcopy, ["-O", "binary", elfPath, binaryPath], { cwd: root, stdio: "pipe" });
  const reference = new Uint8Array(readFileSync(binaryPath));
  const mismatch = [...web.image].findIndex((value, index) => value !== reference[index]);
  if (mismatch >= 0) console.error(`Primer byte distinto: 0x${mismatch.toString(16)} web=0x${web.image[mismatch].toString(16)} avr=0x${reference[mismatch].toString(16)}`);
  assert.deepEqual([...web.image], [...reference], "La salida web difiere de avr-as.");
  console.log(`OK: ${web.image.length} bytes coinciden con avr-as (${avrAs})`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

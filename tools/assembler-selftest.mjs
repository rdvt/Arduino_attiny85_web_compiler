import assert from "node:assert/strict";
import { assemble, AssemblerError } from "../assembler/avr85.js";

const result = assemble(`
.device attiny85
.equ DDRB = 0x17
.equ PORTB, 0x18
.org 0
rjmp reset
reset:
  ldi r16, 1
  out DDRB, r16
loop:
  out PORTB, r16
  dec r16
  brne loop
  rjmp reset
`);

assert.equal(result.ok, true);
assert.equal(result.image[0], 0x00); // RJMP 0: 0xC000, little endian.
assert.match(result.hex, /^:.*\n:00000001FF\n$/m);
assert.equal(result.target.name, "ATtiny85");
assert.ok(result.symbols.reset >= 2);

const directives = assemble('.db 1, 2, 3\n.dw 0x1234\n.asciz "OK"\n.fill 2, 1, 0xff');
assert.deepEqual([...directives.image], [1, 2, 3, 0x34, 0x12, 0x4f, 0x4b, 0, 0xff, 0xff]);

assert.equal(assemble("ldi r16, low(0x1234)\nldi r17, high(0x1234)").bytes, 4);
assert.equal(assemble("lds r16, 0x1234\nsts 0x1234, r16").bytes, 8);
assert.equal(assemble(".def value = r16\nldi value, 1").bytes, 2);

for (const source of [
  "ldi r0, 1",
  "rjmp missing",
  ".device atmega328p",
  ".fill 7000",
]) {
  assert.throws(() => assemble(source, { target: "digispark" }), AssemblerError);
}

console.log("OK: assembler core tests passed");

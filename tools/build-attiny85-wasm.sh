#!/usr/bin/env bash
set -euo pipefail

# Este script valida la cadena nativa. No inventa avr-gcc.wasm ni copia un
# compilador de Arduino Uno como si fuera compatible con ATtiny85.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${OUT:-$ROOT/.wasm-build/attiny85}"
mkdir -p "$OUT"

ok() { printf 'OK   %s\n' "$*"; }
fail() { printf 'ERROR %s\n' "$*" >&2; exit 1; }

command -v avr-gcc >/dev/null 2>&1 || fail "Falta avr-gcc. Instala gcc-avr y avr-libc."
command -v avr-objcopy >/dev/null 2>&1 || fail "Falta avr-objcopy. Instala binutils-avr."
command -v emcc >/dev/null 2>&1 || fail "Falta emcc. Instala Emscripten."

cat > "$OUT/prueba.c" <<'EOF'
#include <avr/io.h>
#include <stdint.h>

volatile uint8_t contador;

int main(void) {
  DDRB |= _BV(PB0);
  PORTB |= _BV(PB0);
  contador++;
  return contador == 0;
}
EOF

avr-gcc -mmcu=attiny85 -DF_CPU=16500000L -Os \
  -ffunction-sections -fdata-sections \
  -c "$OUT/prueba.c" -o "$OUT/prueba.o"

avr-gcc -mmcu=attiny85 -Os -Wl,--gc-sections \
  "$OUT/prueba.o" -o "$OUT/prueba.elf"
avr-objcopy -O ihex -R .eeprom "$OUT/prueba.elf" "$OUT/prueba.hex"

file "$OUT/prueba.elf" | grep -qi 'Atmel AVR' || fail "El ELF no es AVR"
[ -s "$OUT/prueba.hex" ] || fail "No se generó Intel HEX"
ok "C → ELF AVR → Intel HEX para ATtiny85/avr25"

emcc -x c -O2 -s STANDALONE_WASM=1 \
  -s EXPORTED_FUNCTIONS='["_main"]' \
  -o "$OUT/prueba-host.wasm" - <<'EOF'
int main(void) { return 0; }
EOF

file "$OUT/prueba-host.wasm" | grep -qi 'WebAssembly' || fail "Emscripten no generó WebAssembly"
ok "Emscripten genera WebAssembly para el host"

cat > "$OUT/ESTADO.txt" <<'EOF'
La cadena nativa ATtiny85 y Emscripten funcionan.
Esto no constituye todavía un compilador AVR-WASM: emcc genera WebAssembly
para el host y avr-gcc genera AVR nativo. Para compilar C/C++ ATtiny85 dentro
del navegador falta construir el backend AVR y binutils como herramientas WASM.
EOF
cat "$OUT/ESTADO.txt"

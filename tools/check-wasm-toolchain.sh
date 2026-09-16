#!/usr/bin/env bash
set -euo pipefail

ok() { printf 'OK   %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

command -v emcc >/dev/null 2>&1 || fail "No se encontró emcc. Instala Emscripten con: brew install emscripten"
command -v arduino-cli >/dev/null 2>&1 || fail "No se encontró arduino-cli. Instala con: brew install arduino-cli"
ok "emcc: $(emcc --version | head -1)"
ok "arduino-cli: $(arduino-cli version | head -1)"

DATA_DIR="$(arduino-cli config get directories.data 2>/dev/null | tr -d '\r' | tail -1)"
DATA_DIR="${DATA_DIR:-$HOME/Library/Arduino15}"

AVR_BIN=""
for candidate in \
  "$DATA_DIR/packages/arduino/tools/avr-gcc/7.3.0-atmel3.6.1-arduino7/bin" \
  "$DATA_DIR/packages/arduino/tools/avr-gcc"/*/bin; do
  if [ -x "$candidate/avr-gcc" ]; then
    AVR_BIN="$candidate"
    break
  fi
done

[ -n "$AVR_BIN" ] || fail "No se encontró el toolchain AVR dentro de $DATA_DIR"
for tool in avr-gcc avr-as avr-ld avr-objcopy; do
  [ -x "$AVR_BIN/$tool" ] || fail "Falta $AVR_BIN/$tool"
  ok "$tool: $("$AVR_BIN/$tool" --version | head -1)"
done

"$AVR_BIN/avr-gcc" -mmcu=attiny85 -DF_CPU=16500000L -Os -c -x c -o "${TMPDIR:-/tmp}/attiny85-toolchain-check.o" - <<'EOF'
#include <stdint.h>
volatile uint8_t output;
int main(void) { output = 1; return 0; }
EOF
ok "avr-gcc genera un objeto válido para attiny85/avr25"

if arduino-cli core list 2>/dev/null | grep -q '^digistump:avr'; then
  ok "core digistump:avr instalado"
else
  warn "core digistump:avr no aparece instalado; el editor local no podrá compilar Digispark"
fi

printf '\nEntorno base listo.\n'
printf 'Nota: esto valida las herramientas nativas de desarrollo; todavía no crea automáticamente avr-gcc/avr-as/avr-ld como WASM.\n'

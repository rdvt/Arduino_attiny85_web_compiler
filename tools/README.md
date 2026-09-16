# `tools/` — agente local y scripts de desarrollo

> **Importante:** `tools/` no es el Worker WASM del editor principal. El Worker WASM vive en `compiler/worker.js` y sus binarios en `compiler/tools/` y `compiler/assets/`. Esta guía corresponde al `/worker-editor/`, que usa el agente local `compile-agent.py`.

El archivo descargable `worker-editor/tools.zip` contiene esta carpeta. Descomprímelo en la raíz del repositorio para que la ruta quede exactamente como `tools/compile-agent.py`.

Este directorio tiene dos cosas bien distintas:

1. **El agente local de compilación/grabación** (`compile-agent.py`). Es un servidor
   Python que escucha sólo en `127.0.0.1` y usa `arduino-cli` para compilar y **grabar**
   en un ATtiny85. Es lo que hace funcionar al editor contra la máquina, sin backend y
   sin WebUSB.
2. **Los scripts de desarrollo y verificación** (`*-selftest.mjs`, `build-*.sh`, etc.).
   No hacen falta para usar el editor: sirven para mantener el compilador WASM, el
   ensamblador y el flasher.

Todo es local. El agente no sale a internet y no se expone a la red.

---

## 1. Requisitos

| Requisito | Para qué | Cómo verificar |
|---|---|---|
| **Python 3.9+** | El agente. Sólo usa la librería estándar: no hace falta `pip install`. | `python3 --version` |
| **`arduino-cli`** | Compilar y grabar. | `arduino-cli version` |
| **Core `digistump:avr`** | Los archivos propios del Digispark (core `tiny`, V-USB, `DigiMouse`, las recetas de micronucleus). | `arduino-cli core list` → tiene que aparecer `digistump:avr` |
| **Core `arduino:avr`** | Sólo en Apple Silicon: el `avr-gcc` i386 de Digistump no corre y el agente lo reemplaza por el de Arduino. | `arduino-cli core list` → `arduino:avr` |
| **Node 18+** *(opcional)* | Sólo para los `*-selftest.mjs`. | `node --version` |

### Instalación

No hace falta `pip install`. Si usás la copia del proyecto que incluye `tools/instalar-attiny85.sh`, podés ejecutarlo desde la raíz con:

```bash
bash tools/instalar-attiny85.sh
```

En esta versión de GitHub Pages, si el ZIP no incluye ese instalador, seguí los comandos manuales de abajo.

**macOS**

```bash
brew install arduino-cli
arduino-cli config init
arduino-cli core update-index \
  --additional-urls https://raw.githubusercontent.com/digistump/arduino-boards-index/master/package_digistump_index.json
arduino-cli core install digistump:avr \
  --additional-urls https://raw.githubusercontent.com/digistump/arduino-boards-index/master/package_digistump_index.json
arduino-cli core install arduino:avr      # recomendado (Apple Silicon)
```

**Linux**

```bash
# arduino-cli: seguí https://arduino.github.io/arduino-cli/latest/installation/
arduino-cli config init
arduino-cli core update-index \
  --additional-urls https://raw.githubusercontent.com/digistump/arduino-boards-index/master/package_digistump_index.json
arduino-cli core install digistump:avr \
  --additional-urls https://raw.githubusercontent.com/digistump/arduino-boards-index/master/package_digistump_index.json
# Para grabar sin sudo hacen falta las reglas udev de micronucleus:
#   https://github.com/micronucleus/micronucleus/blob/master/commandline/49-micronucleus.rules
```

Si `digistump:avr` no aparece en el índice, el mirror de GitHub del comando de arriba
sirve (probado con la versión 1.6.7).

---

## 2. El agente: `compile-agent.py`

### Levantarlo

```bash
# desde la raíz del repositorio
python3 tools/compile-agent.py
```

Salida esperada:

```
Agente de compilación ATtiny85
  escuchando en http://127.0.0.1:8765
  repo:        /ruta/al/repo
  arduino-cli: arduino-cli
  orígenes:    http://localhost:*, http://127.0.0.1:*, https://rdvt.github.io, ...
  versión:     arduino-cli  Version: 1.5.1 ...

Listo. En el editor, apretá Compilar.
```

Dejalo corriendo en su propia terminal: la página le habla por HTTP.

### Opciones

| Flag | Default | Para qué |
|---|---|---|
| `--port` | `8765` | Puerto. Si está ocupado, usá otro y abrí la página con `?agent=http://127.0.0.1:9000`. |
| `--host` | `127.0.0.1` | Interfaz. **No lo pongas en `0.0.0.0`**: el preprocesador de C++ puede leer archivos del disco. |
| `--repo` | la raíz del repo | Qué árbol de archivos puede abrir y guardar. |
| `--arduino-cli` | `arduino-cli` | Ruta completa si no está en el `PATH` del proceso. |
| `--timeout` | `180` | Tope de la **compilación**, en segundos. |
| `--allow-origin` | localhost + `rdvt.github.io` + `valedam.lat` | Repetible. Agregá tu origen si servís el sitio en otro host. |

### Endpoints

| Método y ruta | Body | Devuelve |
|---|---|---|
| `GET /health` | — | `arduino-cli`, `dataDir`, cores instalados, `digistumpInstalled` y las placas ATtiny85 detectadas. |
| `GET /boards` | — | Placas con `fqbn`, `name`, `mcu`, `fCpu`, `maximumSize`, `usesUsb`. |
| `GET /files` | — | Fuentes del repo que se pueden abrir/editar. |
| `GET /sketch` | `?path=<rel>` | Contenido de un archivo del repo. |
| `POST /compile` | `{ source, name, fqbn, files[] }` | `{ ok, hex, bytes, sizes, files, log, error }`. Un fallo de compilación **no** es un error HTTP: viene con `ok:false`. |
| `POST /upload` | `{ source, name, fqbn, files[], port? }` | Compila **y graba**. `{ ok, stage, bytes, sizes, port, log, error }`. Espera hasta 60 s a que aparezca la placa. |
| `POST /save` | `{ path, source }` | Guarda un archivo del repo dejando un `.bak` antes. |

`name` tiene que empezar con letra y usar sólo letras, dígitos y `_` (máx. 63): es el
nombre del sketch y a la vez lo que impide escapar del directorio temporal.

Prueba rápida:

```bash
curl -s http://127.0.0.1:8765/health | python3 -m json.tool
```

### Por qué existe la lista blanca de orígenes

El compilador de C++ resuelve `#include`, así que cualquier página que pudiera hablarle
al agente podría leer archivos del disco. Por eso sólo atiende los orígenes de la lista
(default: `localhost`, `127.0.0.1`, `https://rdvt.github.io`, `https://valedam.lat`).
Un origen no autorizado recibe **403 y ningún header CORS**. Para otros hosts:

```bash
python3 tools/compile-agent.py --allow-origin http://192.168.1.50:8000
```

---

## 3. Grabar en la placa desde la máquina (sin WebUSB)

Es el camino más confiable: **no pasa por Chrome**. `arduino-cli` llama al CLI de
micronucleus, que es el mismo que usa el IDE de Arduino.

### Desde la página

En `worker-editor/` (o en el editor, según la versión) está el botón
**Grabar desde la máquina**. El orden importa:

1. Pulsá el botón. El agente compila y **se queda esperando la placa** (hasta 60 s).
2. **Recién entonces reenchufá la placa.** El bootloader micronucleus sólo escucha ~5 s
   después de conectarse; si la enchufás antes, el agente no la ve.

### Por comando

```bash
arduino-cli compile --fqbn digistump:avr:digispark-tiny --output-dir build DigisparkMouse
arduino-cli upload  -p usb --fqbn digistump:avr:digispark-tiny --input-dir build DigisparkMouse
```

Una grabación buena termina así:

```
Running Digispark Uploader...
Plug in device now... (will timeout in 60 seconds)
> Device is found!
> Device has firmware version 1.6
> Available space for user applications: 6012 bytes
> Suggested sleep time between sending pages: 8ms
> Whole page count: 94  page size: 64
> Erase function sleep duration: 752ms
...
>> Micronucleus done. Thank you!
```

### Dos detalles que importan

- **`arduino-cli` devuelve `exit 0` aunque micronucleus falle.** El timeout de búsqueda
  de placa no se propaga como código de salida. El agente decide el resultado leyendo el
  log y buscando la marca `Micronucleus done`, y traduce los fallos (`Device search timed
  out`, `has occured`, `No data in input file`, `too big for the bootloader`).
- **`-p usb`** es un puerto ficticio. La receta de Digistump no usa `{serial.port}`
  (micronucleus es USB puro, no serie), así que el valor da igual; el IDE de Arduino
  también pasa `usb`.

Si la placa no aparece, el agente lo dice y **no toca nada**: la flash de usuario queda
como estaba, no se borra nada a medias.

---

## 4. Scripts de desarrollo

Ninguno hace falta para usar el editor.

| Archivo | Qué hace |
|---|---|
| `agent-selftest.mjs` | Prueba el agente de punta a punta contra un agente levantado: `/health`, `/compile` (compara el HEX con el de `./flash.sh`), que un cambio cambie el binario, que un error se reporte, `/save` con backup, y la lista blanca de orígenes. |
| `assembler-selftest.mjs` | Prueba el ensamblador web (`assembler/avr85.js`) sin agente. |
| `assembler-avr-compare.mjs` | Compara la salida del ensamblador con `avr-objcopy` real. |
| `compiler-selftest.mjs` | Prueba de integración del compilador WASM en Node: compila el ejemplo del mouse y compara el HEX con el de `arduino-cli` (disco, sitio en subdirectorio y Web Worker), y comprueba que los ejemplos de `DigisparkUSB`, `DigisparkKeyboard`, `DigisparkJoystick` y `DigisparkCDC` den el mismo HEX que la referencia nativa de `tools/referencias/`. También cubre un sketch con `Wire.h` (C++ puro, sin objetos publicados). |
| `browser-check.mjs` | Abre la página en Chrome headless y compila con el mismo Web Worker: el ejemplo del mouse (HEX contra la referencia), un sketch roto y un sketch con `DigiUSB.h` (librería resuelta, objetos nativos de V-USB enlazados y HEX contra la referencia). |
| `servir-local.mjs` | Sirve el sitio en local imitando a GitHub Pages (subdirectorio, redirecciones, `index.html` por carpeta, tipos MIME y archivos ocultos omitidos). Es lo que conviene usar para probar antes de publicar. |
| `preparar-compiler-assets.mjs` | Prepara los assets del compilador para `compiler/`. Necesita el toolchain AVR nativo (avr-gcc 7.3.0, core Digistump y una compilación de referencia con `arduino-cli` por librería con fuentes V-USB; ver «Referencias nativas con Docker»). |
| `prepare-attiny85-wasm.py` | Inventario de assets del toolchain ATtiny85-WASM (genera `manifest.json`). |
| `build-attiny85-wasm.sh` | Compila el toolchain a WASM. Necesita Emscripten. |
| `check-wasm-toolchain.sh` | Verifica que `emcc` y compañía estén listos. |
| `compiler-hex-referencia.hex` | HEX de referencia del ejemplo de mouse para comparar compilaciones. |
| `referencias/` | Par sketch + HEX nativo de los ejemplos de `DigisparkUSB`, `DigisparkKeyboard`, `DigisparkJoystick` y `DigisparkCDC`, generados con `arduino-cli`; es contra esto que el self-test y `browser-check` verifican la paridad byte a byte. |

```bash
# con el agente levantado en otra terminal
node tools/agent-selftest.mjs

# sin agente
node tools/assembler-selftest.mjs
node flasher/verify.mjs
```

> **Nota:** los scripts del compilador y del navegador deben ejecutarse desde la raíz de este checkout, porque la raíz del repo también es la raíz del sitio. Si una copia antigua menciona un prefijo `web/`, esa documentación está desactualizada: no cambies las rutas del sitio publicado. `agent-selftest.mjs` y los del ensamblador sí son independientes del Worker WASM.

---

## 5. Referencias nativas con Docker

Los objetos y los HEX de `tools/referencias/` los produce el **toolchain AVR nativo** (`avr-gcc` 7.3.0), que `arduino-cli` usa para compilar. En un Mac Apple Silicon ese toolchain es x86_64 y no corre (ni con Rosetta), así que se ejecuta dentro de un contenedor `linux/amd64`: Docker Desktop lo emula.

```bash
# 1) Contenedor con el toolchain nativo (una sola vez; el volumen lo conserva)
docker volume create attini-tools
docker run -d --name attini-avr --platform linux/amd64 \
  -v "$PWD:/attini:ro" -v attini-tools:/opt/avr debian:12 sleep infinity
docker exec attini-avr bash -lc 'apt-get update -qq && apt-get install -y -qq curl bzip2 ca-certificates'
docker exec attini-avr bash -lc 'cd /opt/avr && curl -sSL -o avr.tar.bz2 \
  https://downloads.arduino.cc/tools/avr-gcc-7.3.0-atmel3.6.1-arduino7-x86_64-pc-linux-gnu.tar.bz2 \
  && tar xf avr.tar.bz2 && rm avr.tar.bz2'   # queda en /opt/avr/avr/bin

# 2) arduino-cli y los cores, con el mismo truco de platform.local.txt que el agente
#    (el avr-gcc de Digistump es i386: se usa el de arduino:avr 7.3.0)
docker exec attini-avr bash -lc 'export PATH=/opt/avr/avr/bin:/opt/avr/bin:$PATH; \
  ARDUINO_DIRECTORIES_DATA=/arduino15/data ARDUINO_DIRECTORIES_USER=/arduino15/user \
  arduino-cli core install digistump:avr && arduino-cli core install arduino:avr'

# 3) Compilar cada ejemplo de referencia (uno por librería V-USB)
#    FQBN digistump:avr:digispark-tiny, y el build queda en /probe/builds/<Sketch>
docker exec attini-avr bash -lc 'export PATH=/opt/avr/avr/bin:/opt/avr/bin:$PATH; \
  ARDUINO_DIRECTORIES_DATA=/arduino15/data ARDUINO_DIRECTORIES_USER=/arduino15/user; \
  arduino-cli compile --fqbn digistump:avr:digispark-tiny \
    --build-path /probe/builds/DigiUSBEcho /probe/sketches/DigiUSBEcho'
```

De cada build salen dos cosas:

- `libraries/<Librería>/<fuente>.o` → `compiler/assets/objects/<prefijo>_<fuente>.o` (sólo los `.c`/`.S`),
- `<Sketch>.ino.hex` → `tools/referencias/<Librería>.hex`, con el `.ino` correspondiente al lado.

Eso es exactamente lo que hace `preparar-compiler-assets.mjs` cuando encuentra los builds de referencia en `/tmp/ref-build` (mouse) y `/tmp/ref-builds/<Librería>` (resto): `docker cp attini-avr:/probe/builds/<Sketch> /tmp/ref-builds/<Librería>` y correrlo.

---

## 6. Problemas frecuentes

| Síntoma | Causa y solución |
|---|---|
| `No pude hablar con el agente en http://127.0.0.1:8765` | El agente no está levantado o está en otro puerto. Levantalo, o abrí la página con `?agent=http://127.0.0.1:9000`. |
| HTTP 403 “origen rechazado” | Servís el sitio en un host que no está en la lista blanca. Arrancá con `--allow-origin`. |
| `No encuentro 'arduino-cli'` | No está en el `PATH` del proceso: instalalo o pasá `--arduino-cli /ruta/completa`. |
| Falla con `Arduino.h` o `DigiMouse.h` | Falta el core: `arduino-cli core install digistump:avr` (ver requisitos). |
| Error de `avr-gcc` en Apple Silicon | El agente reemplaza el compilador i386 de Digistump por el de `arduino:avr`. Instalá `arduino:avr 1.8.8`. |
| El puerto 8765 está ocupado | `--port 9000` y abrí la página con `?agent=http://127.0.0.1:9000`. |
| `Device search timed out` | La placa no apareció en modo bootloader. Pulsá Grabar y **después** reenchufala, en un puerto USB directo y sin hub. |
| `MICRONUCLEUS device seems to be inactive` | El bootloader quedó a medio responder: desenchufá, pulsá Grabar y volvé a enchufarla. |
| En Linux, `usb_open(): Permission denied` | Faltan las reglas udev de micronucleus (ver Instalación). |

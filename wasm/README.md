# Compilador ATtiny85 con WebAssembly

Esta carpeta documenta el toolchain que usa el editor publicado. **No es la ruta que carga directamente el navegador**: el editor usa los binarios y assets publicados en `compiler/`.

## Estado actual

La compilación WASM está activa en:

```text
compiler/
├── worker.js       ← Web Worker de compilación
├── compiler.js     ← preprocesado, compilación, enlace y HEX
├── tools/          ← cc1plus, avr-as, avr-ld y avr-objcopy (.wasm)
└── assets/         ← manifest, sysroot, core, librerías (core y usuario) y objetos
```

El objetivo es:

- FQBN: `digistump:avr:digispark-tiny`
- MCU: `attiny85`
- arquitectura: `avr25`
- frecuencia: `F_CPU=16500000L`
- flash disponible para el usuario: `6012` bytes
- compilador: `cc1plus 7.3.0` y binutils AVR en WebAssembly

El editor `/editor/` crea un `Worker` con `../compiler/worker.js`. Ese worker ejecuta la compilación fuera del hilo visual, informa el progreso y devuelve el resultado o los errores del sketch. No requiere Python, `arduino-cli`, Node ni un agente local.

## Diferencia entre los dos workers

No hay que confundir estas dos rutas:

| Ruta | Qué hace | Requisitos |
|---|---|---|
| `/editor/` | Compila en el navegador con WASM y graba por WebUSB | Navegador moderno; Chrome/Edge para grabar |
| `/worker-editor/` | Compila y opcionalmente graba usando `tools/compile-agent.py` | Python, `arduino-cli` y core Digistump instalados |

El **Worker WASM** es parte del sitio publicado. El **Worker Editor** es una página alternativa para cuando se necesita el toolchain nativo, guardar fuentes en el repo o grabar mediante `arduino-cli` sin WebUSB.

## Assets publicados

Para que el editor funcione, el hosting debe publicar la carpeta completa `compiler/`, respetando sus subdirectorios:

```text
compiler/worker.js
compiler/compiler.js
compiler/tools/*.wasm
compiler/assets/manifest.json
compiler/assets/fs/**
compiler/assets/objects/**
compiler/assets/ldscripts/**
```

No se debe subir únicamente `worker.js`: faltarán las herramientas WASM, headers, librerías u objetos. El servidor debe permitir `GET` de `.wasm`, `.json`, `.js` y archivos binarios grandes, sin bloquearlos con reglas de firewall. GitHub Pages funciona porque el repositorio incluye `.nojekyll` y sirve esos assets como archivos estáticos.

Si el sitio se publica en una subcarpeta, las rutas deben conservarse. El editor calcula la base relativa a `/compiler/`; no cambies los nombres de las carpetas ni abras `index.html` con doble clic (`file://`).

## Librerías y enlace

El manifiesto y el filesystem publicado incluyen el core Digistump y sus librerías. Con eso, el compilador reproduce lo que hace `arduino-cli`:

1. **Resolución.** Se leen los `#include` del sketch y de sus pestañas extra y se resuelve cada nombre al directorio de librería que lo publica (`/libraries/<Librería>` —las del usuario— primero, después `/digispark/libraries/<Librería>`). El conjunto se cierra de forma transitiva con los `#include` de las fuentes de esas librerías. Las rutas `-I` de las librerías detectadas van antes que el resto, así un `usbdrv.h` ambiguo (lo publican las cinco librerías USB) resuelve a la que corresponde al sketch.
2. **Compilación.** Se compilan las fuentes de primer nivel de cada librería detectada (igual que Arduino: no se entra en `examples/` ni en subcarpetas), una unidad de traducción por archivo.
3. **Enlace.** `crtattiny85.o` + objetos del sketch + objetos de las librerías + `core.a` + `libgc/libm/libc/libattiny85`, con `--gc-sections`.

```text
compiler/assets/manifest.json          inventario y objetos nativos por librería
compiler/assets/fs/digispark/libraries/ librerías del core Digistump
compiler/assets/fs/libraries/           librerías instaladas por el usuario
compiler/assets/objects/                objetos nativos (core_*, mouse_*, usb_*, keyboard_*, joystick_*, cdc_*)
tools/referencias/                      sketch + HEX nativo de cada ejemplo (paridad)
```

Si el manifiesto declara el objeto de una fuente (`objetosPorLibreria`, con `objetosMouse` como forma antigua para DigiMouse), ese objeto se enlaza tal cual y esa fuente **no** se compila de nuevo: es lo que garantiza que los ejemplos sean idénticos byte a byte a los de `arduino-cli`. El salto es **por fuente**, no por librería: de DigisparkUSB, por ejemplo, se enlazan los objetos de `usbdrv.c`, `osccal.c`, `oddebug.c` y `usbdrvasm.S`, mientras que su `DigiUSB.cpp` se sigue compilando en el navegador.

Por qué existen esos objetos: el frontend C++ no reproduce la semántica C. Medido con el toolchain nativo (GCC 7.3.0): `avr-gcc` en C compila `calibrateOscillator` de `osccal.c` en 142 bytes, y `avr-g++` con el mismo wrapper que usa el navegador en 146; además, en C los tentativos de V-USB caen en símbolos `COMMON` y en C++ en secciones `.bss.<nombre>`. Como el compilador publicado sólo trae `cc1plus`, para las fuentes V-USB se publican los objetos que produjo `arduino-cli` con el toolchain nativo.

### Los `.c` y los `.S` de V-USB

El toolchain WASM publicado sólo tiene el frontend C++ (`cc1plus`): no hay `cc1` ni el driver `avr-gcc`, y `avr-as` no preprocesa. Las librerías USB del Digispark traen las dos cosas, y se resuelven así:

| Fuente | Cómo se compila |
|---|---|
| `.cpp`, `.cc` | `cc1plus` como C++, sin cambios. Verificado: los objetos salen idénticos a los del `avr-g++` nativo, así que los ejemplos con parte C++ (DigiUSB, DigiCDC) siguen dando el mismo HEX de `arduino-cli`. |
| `.c` de librerías V-USB | Se enlaza el objeto nativo que publica el manifiesto (ver arriba): es la única forma de reproducir al frontend C. |
| `.c` de una librería del usuario (sin objeto publicado) | `cc1plus` como C++ dentro de `extern "C" { … }`, con las **declaraciones implícitas de C emuladas**: cc1plus no acepta llamar a una función sin declarar, así que el compilador compila una vez, lee de los diagnósticos los nombres (`'usbMeasureFrameLength' was not declared in this scope`) y reintenta con `int nombre(...)`, que es lo que C da por sentado. Incluir el header de la librería no sirve: el prototipo (`unsigned usbMeasureFrameLength(void)`) le cambia la aritmética al fuente y producía 10 bytes de código distintos. Los estáticos se devuelven sin manglar (`_ZL9usbMsgLen` → `usbMsgLen`) para que las secciones queden como en C. Es fiel al frontend C++, no byte a byte igual a C. |
| `.S` | `cc1plus -E -P -w -D__ASSEMBLER__` y después `avr-as`. `-P` es imprescindible: sin él cpp intercala marcadores `# línea` en medio de las instrucciones (el `.S` expande macros definidas en otros archivos) y el ensamblador recibe `mov`, `r26` y `, r24` como tres líneas distintas. `-w` silencia los avisos por los apóstrofes de los comentarios (`; don't change this`), que en modo C++ se leen como literales de carácter. El ensamblador resultante es idéntico al del toolchain nativo. |

`tools/compiler-selftest.mjs` comprueba que el HEX del ejemplo de mouse siga siendo idéntico byte a byte al de `arduino-cli` (en disco, con el sitio en un subdirectorio y por el Worker), que los ejemplos de `DigisparkUSB`, `DigisparkKeyboard`, `DigisparkJoystick` y `DigisparkCDC` den el mismo HEX que la referencia nativa de `tools/referencias/`, y que un sketch con `Wire.h` (C++ puro, sin objetos publicados) compile y enlace con un vector de reset válido. `tools/browser-check.mjs` repite la verificación de mouse y DigiUSB en Chrome real.

Que exista un header no garantiza que una librería externa arbitraria esté disponible: también deben existir sus fuentes y, si usa código nativo, objetos compatibles con `attiny85/avr25`. Para una librería que no está en `assets/fs`, usa archivos adicionales del editor o el agente local.

## Flujo de compilación del Worker

1. `editor/index.html` crea `new Worker("../compiler/worker.js", { type: "module" })`.
2. El editor envía `{ id, tipo: "compilar", fuente, archivos, base }`.
3. `worker.js` fija la base de assets y llama a `compiler.js`.
4. El worker envía mensajes `progreso`, `resultado` o `fallo`.
5. `infraestructura: true` significa que no cargó el toolchain/assets; un error con `false` es un error normal del sketch.
6. El editor muestra el HEX únicamente después de validar la compilación.

La primera compilación descarga los recursos que el navegador aún no tenga en caché. Si el firewall del hosting bloquea archivos, aparecerá un error de infraestructura o faltará un header; la solución es publicar `compiler/` completo o usar temporalmente `/worker-editor/` con el agente local.

## Verificación local

Desde la raíz del repositorio:

```bash
python3 -m http.server 8000
# abrir http://localhost:8000/editor/
node tools/compiler-selftest.mjs
```

El self-test comprueba el filesystem, la publicación en subdirectorio y el protocolo del worker. Para comprobar el navegador real, usa el test disponible en `tools/browser-check.mjs` con Chrome instalado.

## Regenerar assets

Sólo hace falta para desarrollar el toolchain, no para usar el sitio:

```bash
bash tools/check-wasm-toolchain.sh
python3 tools/prepare-attiny85-wasm.py
```

La regeneración debe conservar `attiny85`, `avr25`, `F_CPU=16500000L`, el linker `avr25.xn`, el límite de 6012 bytes y las librerías/objetos de Digistump. No sustituyas estos assets por un toolchain de Arduino Uno (`atmega328p`/`avr5`).

## Agente local de respaldo

Si el WASM no puede cargar por restricciones del hosting, usa la página `/worker-editor/`:

```bash
python3 tools/compile-agent.py
```

Consulta [`tools/README.md`](../tools/README.md) para instalar `arduino-cli`, los cores, configurar CORS y usar `tools.zip`. El agente sólo escucha en `127.0.0.1`; no lo expongas con `--host 0.0.0.0`.

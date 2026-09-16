# ATtiny85 Web Workbench

Herramientas web para **ATtiny85** y **Digispark**: ensamblador AVR, editor C/C++ con compilador en WebAssembly y grabador WebUSB. Todo funciona dentro del navegador, **sin instalar nada**: sin IDE, sin `arduino-cli`, sin drivers (salvo detalles por sistema operativo, ver [Requisitos](#requisitos)).

- Sitio publicado: `https://rdvt.github.io/Arduino_attiny85_web_compiler/`
- Manual de uso completo: [`manual.html`](manual.html)

---

## Índice

- [Qué incluye](#qué-incluye)
- [Inicio rápido](#inicio-rápido)
- [Requisitos](#requisitos)
- [Flujo recomendado](#flujo-recomendado)
- [Estructura del repositorio](#estructura-del-repositorio)
- [El compilador en el navegador](#el-compilador-en-el-navegador)
- [Límites de la placa](#límites-de-la-placa)
- [Grabar la placa](#grabar-la-placa)
- [Despliegue en GitHub Pages](#despliegue-en-github-pages)
- [Servir el sitio en local](#servir-el-sitio-en-local)
- [Notas de desarrollo](#notas-de-desarrollo)

---

## Qué incluye

| Herramienta | Ruta | Qué hace |
|---|---|---|
| **Editor C/C++** | [`editor/`](editor/) | Edita un sketch estilo Arduino y compílalo en el navegador con WebAssembly. Muestra la flash usada y los errores en un panel lateral; la compilación corre en un worker, así que la interfaz sigue respondida. |
| **Ensamblador AVR** | [`assembler/`](assembler/) | Escribe instrucciones AVR directamente: resuelve etiquetas y expresiones, genera Intel HEX y binario, limita la salida al espacio de usuario de la Digispark y muestra los diagnósticos línea por línea. |
| **Flasher WebUSB** | [`flasher/`](flasher/) | Valida el firmware (checksum, vector de reset y límite de 6012 bytes), conecta el bootloader **micronucleus** y escribe la flash por WebUSB con barra de progreso real. |
| **Manual** | [`manual.html`](manual.html) | Tutorial completo de las tres herramientas y lista ampliada de problemas frecuentes. |

Además trae un proyecto de ejemplo listo para compilar y grabar:

- [`DigisparkMouse/`](DigisparkMouse/) — sketch que convierte la Digispark en un **mouse USB** (mouse jiggler) usando la librería **DigiMouse** (V-USB).
- [`build/DigisparkMouse.ino.hex`](build/) — ese mismo sketch ya compilado; el flasher lo carga por defecto.

## Inicio rápido

1. Abre el [editor C/C++](editor/) (trae el sketch de ejemplo cargado) o el [ensamblador](assembler/).
2. Pulsa **Compilar** (o `Ctrl`/`⌘` + `Enter`). La primera vez se descarga el compilador (~20 MB); después queda en la caché del navegador.
3. Revisa la flash usada: el máximo de la Digispark es **6012 bytes**.
4. Descarga el HEX y ábrelo en el [flasher](flasher/), o pulsa **Grabar compilado** directo desde el editor.
5. Pulsa **Grabar**, y conecta la placa *cuando el navegador muestre el selector*. Elige el dispositivo `16D0:0753`.

> El bootloader micronucleus solo escucha **~5 segundos** desde que conectas la placa: primero pulsa Grabar, después enchúfala.

## Requisitos

- **Navegador:** Chrome o Edge de escritorio (WebUSB). Firefox y Safari no sirven para grabar.
- **Contexto seguro:** la página debe servirse por `https://` o `localhost`.
- **Windows:** Chrome necesita el driver WinUSB para `16d0:0753`. Si aparece *Access denied*, asigna el dispositivo con [Zadig](https://zadig.akeo.ie/) (el driver Digistump/libusbK no sirve para WebUSB).
- **Linux:** instalar las reglas udev de micronucleus (`49-micronucleus.rules`) para que Chrome pueda abrir el dispositivo.
- **Hardware:** puerto USB directo, preferiblemente con adaptador USB-C→USB-A pasivo; evita hubs y docks (V-USB es bit-bang por software y detrás de un hub USB 3.x las escrituras se cortan).

## Flujo recomendado

```
escribir el código  →  compilar / ensamblar  →  revisar la flash usada
                    →  descargar el HEX      →  grabar con el flasher
```

Las tres herramientas comparten el mismo formato de firmware: puedes ensamblar a mano, compilar C/C++ o cargar un HEX que ya tengas.

## Estructura del repositorio

```
├── index.html          ← portada
├── manual.html         ← manual de uso completo
├── theme.css           ← sistema de diseño compartido
├── hero-3d.js          ← chip 3D decorativo de la portada (three.js)
├── assembler/          ← ensamblador AVR en el navegador
│   ├── avr85.js          núcleo del ensamblador
│   └── app.js            interfaz
├── editor/             ← editor C/C++ (usa el compilador WASM)
├── compiler/           ← compilador ATtiny85 en WebAssembly
│   ├── tools/            cc1plus, avr-as, avr-ld, avr-objcopy (.wasm)
│   └── assets/           sysroot, core Digistump y sus librerías, ldscripts, manifest
├── flasher/            ← grabación WebUSB
│   ├── micronucleus.js   protocolo micronucleus
│   ├── intelhex.js       lectura/validación de HEX y BIN
│   └── verify.mjs        pruebas de verificación
├── DigisparkMouse/     ← sketch de ejemplo (mouse USB con DigiMouse)
├── build/              ← firmware HEX de ejemplo ya compilado
├── wasm/               ← documentación del toolchain WASM y su inventario
├── vendor/three/       ← three.js (local, sin CDN)
└── .nojekyll           ← evita que GitHub Pages omita los assets del compilador
```

## El compilador en el navegador

El editor no llama a ningún servidor: compila **en tu máquina** con un toolchain AVR compilado a WebAssembly.

- **cc1plus 7.3.0** + `avr-as`, `avr-ld` y `avr-objcopy` en WebAssembly, con el sysroot de avr-libc, el core Digistump, sus librerías USB (V-USB, DigiMouse, DigiUSB, DigiKeyboard…) y las librerías `avr25`.
- Objetivo: `digistump:avr:digispark-tiny`, MCU `attiny85`, arquitectura `avr25`, `F_CPU = 16.5 MHz`.
- **Librerías del sketch:** el compilador resuelve las librerías por sus `#include` (igual que `arduino-cli`) y compila sus fuentes dentro del navegador, así que no hay que limitarse al ejemplo del mouse: `DigiUSB`, `DigiKeyboard`, `DigiJoystick`, `Wire`, `SPI`, `TinyWireM`, `OneWire`… funcionan sin instalar nada. Ver [Librerías del sketch](#librerías-del-sketch).
- Los HEX del **ejemplo de mouse** y de los de **DigiUSB, DigiKeyboard, DigiJoystick y DigiCDC** son **idénticos byte a byte** a los de `arduino-cli` (las fuentes V-USB de esas librerías se enlazan como objetos nativos publicados en el manifiesto).
- La compilación corre en un **Web Worker**: la interfaz no se bloquea y los errores de C++ llegan al panel.
- El preprocesado replica el de Arduino: combina el `.ino`, genera prototipos y acepta `.c`, `.cpp` y headers.

### Librerías del sketch

No hace falta incluir los fuentes de la librería en el editor: alcanza con `#include <DigiUSB.h>`.

1. El compilador lee los `#include` del sketch y de sus pestañas extra, y resuelve cada uno a la librería que lo publica (primero las instaladas por el usuario, después las del core Digistump).
2. Compila las fuentes de primer nivel de esas librerías (`.cpp`, `.cc`, `.c` y `.S`) y las enlaza con el sketch, el core y avr-libc.
3. Si el manifiesto ya publica el objeto de una fuente (`compiler/assets/manifest.json` → `objetosPorLibreria`, con `objetosMouse` como forma antigua), enlaza ese objeto nativo y no la compila: así los ejemplos conservan la paridad byte a byte con `arduino-cli`. Se publican los `.c`/`.S` de las librerías V-USB, no los `.cpp` (esos sí se compilan en el navegador, así que editarlos en el editor tiene efecto).
4. Si un `#include` no existe en el filesystem publicado, el panel muestra el error de `cc1plus` (`No such file or directory`) en vez de un `undefined reference` del enlazado.

El toolchain WASM no trae frontend C (`cc1`), así que las fuentes `.c` de V-USB se compilan como C++ con enlazado C; los detalles, las limitaciones y las verificaciones están en [`wasm/README.md`](wasm/README.md#librerías-y-enlace).

El manifiesto de assets está en [`compiler/assets/manifest.json`](compiler/assets/manifest.json) y la documentación del toolchain en [`wasm/README.md`](wasm/README.md).

### Worker WASM y agente local

El editor `/editor/` usa `compiler/worker.js` y compila dentro del navegador: no necesita Python, `arduino-cli` ni servidor local. El hosting debe publicar completa la carpeta `compiler/`, incluidos `worker.js`, `compiler.js`, `tools/*.wasm`, `assets/manifest.json`, `assets/fs/**`, `assets/objects/**` y `assets/ldscripts/**`; subir sólo el worker no alcanza. No abras el sitio con `file://`: servilo por HTTPS, GitHub Pages o `localhost`.

La página alternativa `/worker-editor/` usa `tools/compile-agent.py` como agente local. Descargá `worker-editor/tools.zip`, descomprimilo en la raíz del repositorio, instalá Python 3, `arduino-cli`, `digistump:avr` y `arduino:avr`, y levantá:

```bash
python3 tools/compile-agent.py
```

Después abrí `https://rdvt.github.io/Arduino_attiny85_web_compiler/worker-editor/` o la copia local. Si cambiás el puerto, usá `?agent=http://127.0.0.1:9000`. El agente debe escuchar sólo en `127.0.0.1`; no lo expongas en `0.0.0.0`. Para grabar desde la máquina, pulsá primero **Grabar desde la máquina** y recién después enchufá la placa: micronucleus sólo escucha aproximadamente cinco segundos.

## Límites de la placa

| Recurso | Valor |
|---|---|
| MCU | ATtiny85 (`avr25`) |
| Frecuencia | 16.5 MHz (clock calibrado por V-USB) |
| Flash de usuario | **6012 bytes** (el resto es el bootloader micronucleus) |
| RAM | 512 bytes |
| Vector de reset | El firmware debe empezar con `jmp` o `rjmp` |
| Serie | El ATtiny85 no tiene UART: `Serial` no está disponible (usa `DigiMouse`, `DigiKeyboard`, etc.) |

El editor, el ensamblador y el flasher bloquean la grabación si el firmware supera 6012 bytes o no empieza con `jmp`/`rjmp`.

## Grabar la placa

1. **Validación:** el flasher decodifica el HEX/BIN, verifica el checksum, el vector de reset y el tamaño antes de tocar la placa.
2. **Conexión:** pulsa **Grabar** para abrir el diálogo de Chrome y conecta la placa en modo bootloader (recién enchufada, dentro de los ~5 s). El dispositivo aparece como `16D0:0753`.
3. **Escritura:** solo se borra y escribe la **zona de usuario**; el bootloader queda intacto, así que un fallo a mitad de grabación siempre deja la placa recuperable.
4. **Arranque:** al terminar, la placa se reenumera como dispositivo HID (por ejemplo, como mouse).

Detalles y soluciones de errores en el [manual](manual.html#problemas) y en el propio flasher (sección *Tutoriales minuciosos*).

## Servir el sitio en local

La forma más fiel a GitHub Pages es el servidor del propio repositorio: no hace falta
instalar nada (sólo Node) y publica el sitio **bajo el mismo subdirectorio** que usa
Pages, con los mismos tipos MIME y omitiendo los archivos ocultos (por eso aparece el
aviso *"N recurso(s) no disponibles en este hosting"*, igual que en el sitio publicado).

```bash
node tools/servir-local.mjs
# abre http://127.0.0.1:8000/Arduino_attiny85_web_compiler/editor/
```

Opciones: `--port 8080`, `--prefijo /otro-nombre`, `--abrir` (abre el editor en el
navegador) y `--con-ocultos` (publica también los archivos ocultos, por si querés probar
algo que dependa de ellos). Cada pedido queda registrado en la terminal, así se ve qué
descarga el compilador.

También sirve cualquier servidor estático desde la raíz del repositorio:

```bash
python3 -m http.server 8000
# abre http://localhost:8000/
```

Con `localhost` (o `127.0.0.1`) ya hay contexto seguro para WebUSB, así que puedes grabar
la placa sin desplegar nada. Si servís el sitio en un subdirectorio distinto, acordate de
que las rutas del compilador son relativas: `http://localhost:8000/<subcarpeta>/editor/`.

## Notas de desarrollo

- **Sin dependencias de build ni de CDN:** three.js está incluido en [`vendor/three/`](vendor/three/) y todo el resto es JavaScript estándar.
- [`wasm/README.md`](wasm/README.md) documenta cómo se genera y valida el toolchain WASM (incluido el auto-test `compiler-selftest.mjs` que compara la salida contra `arduino-cli`), y qué se necesita para regenerar los assets del compilador.
- [`flasher/verify.mjs`](flasher/verify.mjs) contiene las verificaciones del protocolo micronucleus y del decodificador Intel HEX.
- Revisa [`compiler/assets/manifest.json`](compiler/assets/manifest.json) para auditar versiones, headers y objetos precompilados incluidos en el toolchain.

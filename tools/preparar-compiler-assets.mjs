#!/usr/bin/env node
/**
 * Prepara los assets del compilador C/C++ ATtiny85 (avr25) para web/compiler/.
 *
 * Requiere el entorno ya instalado (ver README.md):
 *  - Toolchain AVR 7.3.0 de Arduino (avr-gcc/avr-as/avr-ld/avr-objcopy/avr-ar)
 *  - Core Digistump 1.6.7 instalado con arduino-cli
 *  - Una compilación de referencia con arduino-cli por cada librería con fuentes
 *    V-USB (ver BUILDS_REFERENCIA); la de DigiMouse es /tmp/ref-build
 *  - Paquete vendor de herramientas WASM en .wasm-build/vendor/package
 *
 * Uso:
 *   node tools/preparar-compiler-assets.mjs
 *
 * Genera:
 *   web/compiler/tools/{cc1plus,avr-as,avr-ld,avr-objcopy}.{mjs,wasm}
 *   web/compiler/assets/fs/...            (headers AVR/GCC + core Digispark + DigiMouse)
 *   compiler/assets/objects/core_*.o      (objetos del core Digispark precompilados)
 *   compiler/assets/objects/<lib>_*.o     (objetos nativos de las librerías V-USB)
 *   tools/referencias/<Lib>.hex           (HEX nativo de cada ejemplo de referencia)
 *   web/compiler/assets/libs/...          (crtattiny85.o, libc/libm/libgcc avr25)
 *   web/compiler/assets/ldscripts/avr25.xn
 *   web/compiler/assets/manifest.json     (inventario con hashes SHA-256)
 */
import { readFile, writeFile, mkdir, readdir, stat, copyFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const RAIZ = join(import.meta.dirname, "..");
const DESTINO = join(RAIZ, "web/compiler");
const VENDOR = join(RAIZ, ".wasm-build/vendor/package");
const REF_BUILD = "/tmp/ref-build";

/**
 * Compilaciones de referencia: la librería que traen compilada y el sketch con el
 * que se generó.
 *
 * `arduino-cli compile` sólo compila las librerías que el sketch usa, así que hace
 * falta un build por librería. De cada uno se copian los objetos de sus fuentes
 * `.c`/`.S` (las que el frontend C++ del WASM no reproduce igual que C) y su HEX,
 * que queda como referencia de paridad para `compiler-selftest.mjs`.
 *
 * El procedimiento para generarlos con el toolchain nativo está en tools/README.md
 * (sección «Referencias nativas con Docker»).
 */
const BUILDS_REFERENCIA = {
  DigisparkUSB: "/tmp/ref-builds/DigisparkUSB",
  DigisparkKeyboard: "/tmp/ref-builds/DigisparkKeyboard",
  DigisparkJoystick: "/tmp/ref-builds/DigisparkJoystick",
  DigisparkCDC: "/tmp/ref-builds/DigisparkCDC",
};

/** Prefijo de cada librería en los nombres de objeto publicados. */
const PREFIJOS = {
  DigisparkMouse: "mouse",
  DigisparkUSB: "usb",
  DigisparkKeyboard: "keyboard",
  DigisparkJoystick: "joystick",
  DigisparkCDC: "cdc",
};
const AVR_ROOT = join(homedir(), "Library/Arduino15/packages/arduino/tools/avr-gcc/7.3.0-atmel3.6.1-arduino7");
const AVR_BIN = join(AVR_ROOT, "bin");
const DIGICORE = join(homedir(), "Library/Arduino15/packages/digistump/hardware/avr/1.6.7");
const DIGIMOUSE_USUARIO = join(homedir(), "Documents/Arduino/libraries/DigisparkMouse");

const AVISOS = [];
function aviso(mensaje) { AVISOS.push(mensaje); console.warn(`AVISO: ${mensaje}`); }

async function existe(ruta) { try { await stat(ruta); return true; } catch { return false; } }

async function copiarArchivo(origen, destinoRel) {
  const destino = join(DESTINO, destinoRel);
  await mkdir(destino.split("/").slice(0, -1).join("/"), { recursive: true });
  await copyFile(origen, destino);
  return destinoRel;
}

async function carpeta(fsRuta, destinoRel) {
  let total = 0;
  const entradas = await readdir(fsRuta, { withFileTypes: true });
  for (const e of entradas) {
    const o = join(fsRuta, e.name);
    const d = join(destinoRel, e.name);
    if (e.isDirectory()) total += await carpeta(o, d);
    else if (/\.(o|d)$/i.test(e.name)) { /* binarios residuales: no copiar */ }
    else { await copiarArchivo(o, d); total++; }
  }
  return total;
}

async function hashDe(ruta) {
  const contenido = await readFile(ruta);
  return createHash("sha256").update(contenido).digest("hex");
}

// ---------- 0) Verificaciones previas ----------
console.log("== Preparación de assets del compilador ATtiny85-WASM ==");

for (const [nombre, ruta] of [
  ["paquete vendor", VENDOR],
  ["build de referencia", REF_BUILD],
  ["toolchain AVR", AVR_BIN],
  ["core Digistump", DIGICORE],
  ["librería DigiMouse del usuario", DIGIMOUSE_USUARIO],
]) {
  if (!(await existe(ruta))) {
    throw new Error(`Falta ${nombre}: ${ruta}. Consulta README.md para instalarlo.`);
  }
}

const REFERENCIA_HEX = join(REF_BUILD, "DigisparkMouse.ino.hex");
if (!(await existe(REFERENCIA_HEX))) throw new Error(`Falta el HEX de referencia: ${REFERENCIA_HEX}`);

// ---------- 1) Herramientas WASM ----------
console.log("1) Copiando herramientas WASM...");
for (const herramienta of ["cc1plus", "avr-as", "avr-ld", "avr-objcopy"]) {
  await copiarArchivo(join(VENDOR, `tools/${herramienta}.mjs`), `tools/${herramienta}.mjs`);
  await copiarArchivo(join(VENDOR, `tools/${herramienta}.wasm`), `tools/${herramienta}.wasm`);
}

// ---------- 2) Headers AVR y GCC (originales de GCC 7.3.0, igual que la compilación nativa) ----------
console.log("2) Copiando headers de avr-libc y GCC 7.3.0 (idénticos al toolchain nativo)...");
const SYS_DESTINO = "assets/fs/sysroot";
let nHeaders = 0;
nHeaders += await carpeta(join(AVR_ROOT, "avr/include"), join(SYS_DESTINO, "avr/include"));
nHeaders += await carpeta(join(AVR_ROOT, "lib/gcc/avr/7.3.0/include"), join(SYS_DESTINO, "gcc/include"));

// ---------- 3) Core Digispark: headers y fuentes ----------
console.log("3) Copiando core Digispark, variante y librería DigiMouse...");
const nCore = await carpeta(join(DIGICORE, "cores/tiny"), "assets/fs/digispark/cores/tiny");
const nVariant = await carpeta(join(DIGICORE, "variants/digispark"), "assets/fs/digispark/variants/digispark");
const nMouse = await carpeta(DIGIMOUSE_USUARIO, "assets/fs/libraries/DigisparkMouse");
const nLibsCore = await carpeta(join(DIGICORE, "libraries"), "assets/fs/digispark/libraries");
console.log(`   core: ${nCore} | variante: ${nVariant} | DigiMouse: ${nMouse} | librerías del core: ${nLibsCore}`);

// ---------- 4) Objetos del core y librería DigiMouse precompilados ----------
console.log("4) Copiando objetos precompilados del build de referencia...");
const objetos = [];
for (const archivo of await readdir(join(REF_BUILD, "core"))) {
  if (archivo.endsWith(".o")) {
    objetos.push(await copiarArchivo(join(REF_BUILD, `core/${archivo}`), `assets/objects/core_${archivo}`));
  }
}
// Objetos de las librerías V-USB del build de referencia. El compilador los enlaza
// tal cual y no vuelve a compilar esas fuentes en el navegador: es lo que mantiene
// el HEX de los ejemplos idéntico al de arduino-cli (ver `compiler/compiler.js`).
//
// Se copian sólo los objetos de fuentes `.c`/`.S`: un `cc1plus` no reproduce la
// semántica C (declaraciones implícitas, definiciones tentativas) y el nativo es el
// único que lo hace igual que arduino-cli. Los `.cpp` se siguen compilando en el
// navegador, así que editar esas fuentes en el editor tiene efecto.
const objetosLibrerias = {};
for (const [libreria, build] of Object.entries({ DigisparkMouse: REF_BUILD, ...BUILDS_REFERENCIA })) {
  const carpeta = join(build, `libraries/${libreria}`);
  if (!(await existe(carpeta))) {
    aviso(`Sin build de referencia de ${libreria} (${carpeta}): no se publican sus objetos`);
    continue;
  }
  const prefijo = PREFIJOS[libreria] ?? libreria.toLowerCase();
  const deLaLibreria = [];
  for (const archivo of (await readdir(carpeta)).sort()) {
    if (!/\.(c|S)\.o$/.test(archivo)) continue;
    deLaLibreria.push(await copiarArchivo(join(carpeta, archivo), `assets/objects/${prefijo}_${archivo}`));
  }
  if (deLaLibreria.length) objetosLibrerias[libreria] = deLaLibreria.map((rel) => "/" + rel);
}
const objetosMouse = objetosLibrerias.DigisparkMouse ?? [];
await copiarArchivo(join(REF_BUILD, "core/core.a"), "assets/libs/core.a");

// ---------- 5) Librerías avr25 y linker script ----------
console.log("5) Copiando libs avr25 (crt, libc, libm, libgcc) y linker script...");
await copiarArchivo(join(VENDOR, "assets/libs/crtattiny85.o"), "assets/libs/crtattiny85.o");
await copiarArchivo(join(VENDOR, "assets/libs/libc-avr25.a"), "assets/libs/libc-avr25.a");
await copiarArchivo(join(VENDOR, "assets/libs/libm-avr25.a"), "assets/libs/libm-avr25.a");
await copiarArchivo(join(VENDOR, "assets/libs/libgcc-avr25.a"), "assets/libs/libgcc-avr25.a");
await copiarArchivo(join(AVR_ROOT, "avr/lib/avr25/libattiny85.a"), "assets/libs/libattiny85.a");
await copiarArchivo(join(VENDOR, "assets/ldscripts/avr25.xn"), "assets/ldscripts/avr25.xn");
if (!(await existe(join(VENDOR, "assets/ldscripts/avr25.xn")))) {
  // Fallback: generar desde el toolchain nativo
  await copiarArchivo(join(AVR_ROOT, "avr/lib/ldscripts/avr25.xn"), "assets/ldscripts/avr25.xn");
}

// ---------- 6) Manifiesto con hashes ----------
console.log("6) Generando manifiesto con hashes SHA-256...");
async function inventar(dirRel, lista) {
  const abs = join(DESTINO, dirRel);
  if (!(await existe(abs))) return;
  const entradas = await readdir(abs, { withFileTypes: true });
  for (const e of entradas) {
    const rel = join(dirRel, e.name);
    if (e.isDirectory()) await inventar(rel, lista);
    else lista.push(rel.split("/").join("/"));
  }
}
const archivos = [];
for (const grupo of ["tools", "assets"]) await inventar(grupo, archivos);
const fsFiles = archivos.filter((a) => a.startsWith("assets/fs/")).map((a) => "/" + a.replace(/^assets\/fs\//, ""));

const manifest = {
  generadoEl: new Date().toISOString(),
  objetivo: {
    placa: "digistump:avr:digispark-tiny",
    mcu: "attiny85",
    arquitectura: "avr25",
    fcpu: 16500000,
    flashUsuario: 6012,
    ram: 512,
  },
  compilador: {
    gcc: "7.3.0",
    marca: "ATtiny85-WASM (cc1plus 7.3.0 + binutils AVR en WebAssembly)",
  },
  herramientas: {
    cc1plus: "tools/cc1plus.wasm",
    "avr-as": "tools/avr-as.wasm",
    "avr-ld": "tools/avr-ld.wasm",
    "avr-objcopy": "tools/avr-objcopy.wasm",
  },
  recuento: {
    headers: nHeaders,
    objetosCore: objetos.length,
    objetosMouse: objetosMouse.length,
    objetosLibrerias: Object.values(objetosLibrerias).reduce((n, lista) => n + lista.length, 0),
    libreriasConObjetos: Object.keys(objetosLibrerias).length,
    archivosTotales: archivos.length,
  },
  // `objetosMouse` se mantiene por compatibilidad; `objetosPorLibreria` es la
  // forma general que lee compiler.js.
  objetosMouse,
  objetosPorLibreria: objetosLibrerias,
  fsFiles,
  hashes: {},
};
for (const rel of archivos) {
  manifest.hashes[rel] = await hashDe(join(DESTINO, rel));
}
await writeFile(join(DESTINO, "assets/manifest.json"), JSON.stringify(manifest, null, 2));

// ---------- 7) HEX de referencia para pruebas ----------
await copyFile(REFERENCIA_HEX, join(RAIZ, "tools/compiler-hex-referencia.hex"));
for (const [libreria, build] of Object.entries(BUILDS_REFERENCIA)) {
  const hex = (await readdir(build)).find((archivo) => archivo.endsWith(".ino.hex"));
  if (!hex) {
    aviso(`El build de ${libreria} (${build}) no tiene HEX: no se actualiza tools/referencias/${libreria}.hex`);
    continue;
  }
  await copyFile(join(build, hex), join(RAIZ, `tools/referencias/${libreria}.hex`));
}

// ---------- Resumen ----------
let bytes = 0;
for (const rel of archivos) bytes += (await stat(join(DESTINO, rel))).size;
console.log(`
== Resumen ==
Destino: ${relative(process.cwd(), DESTINO)}
Herramientas WASM: 4 (cc1plus, avr-as, avr-ld, avr-objcopy)
Headers copiados: ${nHeaders}
Objetos core: ${objetos.length} | Objetos de librerías: ${Object.entries(objetosLibrerias).map(([l, o]) => `${l} (${o.length})`).join(", ") || "ninguno"}
Archivos totales: ${archivos.length}
Tamaño total: ${(bytes / 1024 / 1024).toFixed(1)} MB
`);
if (AVISOS.length) {
  console.log(`AVISOS (${AVISOS.length}):`);
  for (const a of AVISOS) console.log(` - ${a}`);
}
console.log("LISTO: assets del compilador preparados. Ejecuta node tools/compiler-selftest.mjs para validar.");

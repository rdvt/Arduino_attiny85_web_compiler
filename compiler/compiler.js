/**
 * Compilador C/C++ ATtiny85 (avr25) para el navegador.
 *
 * Ejecuta, sobre un sistema de archivos virtual:
 *   cc1plus (GCC 7.3.0, WebAssembly) → ensamblador AVR
 *   avr-as   (binutils WASM)         → objeto ELF AVR
 *   avr-ld   (binutils WASM)         → ELF con crtattiny85, core Digispark y libs avr25
 *   avr-objcopy (binutils WASM)      → Intel HEX
 *
 * Objetivo: digistump:avr:digispark-tiny (ATtiny85 @ 16.5 MHz, 6012 bytes de flash).
 *
 * El HEX producido es idéntico byte a byte al de `arduino-cli compile
 * --fqbn digistump:avr:digispark-tiny` (verificado en tools/compiler-selftest.mjs).
 */
import createCc1plus from "./tools/cc1plus.mjs";
import createAvrAs from "./tools/avr-as.mjs";
import createAvrLd from "./tools/avr-ld.mjs";
import createObjcopy from "./tools/avr-objcopy.mjs";

const FLASH_USUARIO = 6012;

/**
 * Normaliza una base de assets para que SIEMPRE termine en "/".
 *
 * Sin el separador final, `new URL("tools/cc1plus.wasm", ".../compiler")` descarta
 * el último segmento y apunta a `.../tools/cc1plus.wasm` (404). Ese fallo solo
 * aparece al servir el sitio en un subdirectorio, así que conviene blindarlo acá.
 */
function baseDeAssets(valor) {
  const url = new URL(valor ?? "./", import.meta.url);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

let baseAssets = baseDeAssets("./");
export function fijarBaseAssets(base) {
  baseAssets = baseDeAssets(base);
  manifestPromesa = undefined;
  cacheAssets.clear();
}

/** Error de infraestructura (falta un asset, no arranca la herramienta), a
 * diferencia de un error de compilación del código del usuario. Quien llama
 * puede decidir si vale la pena reintentar con otro compilador. */
function errorDeInfraestructura(mensaje) {
  const error = new Error(mensaje);
  error.infraestructura = true;
  return error;
}

let manifestPromesa;
function manifest() {
  if (!manifestPromesa) {
    manifestPromesa = fetch(new URL("assets/manifest.json", baseAssets)).then((r) => {
      if (!r.ok) throw errorDeInfraestructura(`No se pudo cargar el manifiesto del compilador (${r.status})`);
      return r.json();
    });
  }
  return manifestPromesa;
}

// Caché de assets: las herramientas y los ~900 archivos del FS virtual se
// descargan una sola vez; las compilaciones siguientes reutilizan los bytes.
const cacheAssets = new Map();

async function bytesAsset(rutaRel) {
  const clave = rutaRel.replace(/^\//, "");
  if (!cacheAssets.has(clave)) {
    const respuesta = await fetch(new URL(clave, baseAssets));
    if (!respuesta.ok) throw errorDeInfraestructura(`No se pudo cargar ${clave} (${respuesta.status})`);
    cacheAssets.set(clave, new Uint8Array(await respuesta.arrayBuffer()));
  }
  return cacheAssets.get(clave);
}

/** Igual que bytesAsset pero devuelve null si el archivo no existe (404).
 * Algunos hostings estáticos (Jekyll/GitHub Pages) omiten archivos sueltos del
 * inventario sin impedir la compilación; los recursos imprescindibles fallan
 * igual más adelante dentro de cc1plus o avr-ld, con un error explícito. */
async function bytesAssetOpcional(rutaRel) {
  try {
    return await bytesAsset(rutaRel);
  } catch {
    return null;
  }
}

function crearDirs(fs, ruta) {
  let actual = "";
  for (const parte of ruta.split("/").filter(Boolean)) {
    actual += `/${parte}`;
    try { fs.mkdir(actual); } catch { /* ya existe */ }
  }
}

function escribir(fs, ruta, datos) {
  crearDirs(fs, ruta.split("/").slice(0, -1).join("/"));
  fs.writeFile(ruta, datos);
}

const codificar = (texto) => new TextEncoder().encode(String(texto ?? ""));

const BINARIOS = {
  cc1plus: "tools/cc1plus.wasm",
  "avr-as": "tools/avr-as.wasm",
  "avr-ld": "tools/avr-ld.wasm",
  "avr-objcopy": "tools/avr-objcopy.wasm",
};

const ERRORES = new Set();

/**
 * Publica los diagnósticos finales de una herramienta: al panel y a ERRORES.
 *
 * Separado de `crearModulo` porque una herramienta puede ejecutarse varias veces
 * (ver `compilarFuenteDeLibreria`) y sólo interesa lo que dijo la última.
 */
function publicarDiagnosticos(progreso, herramienta, lineas) {
  for (const linea of lineas) {
    ERRORES.add(linea);
    if (progreso) progreso(`[${herramienta}] ${linea}`);
  }
}

/**
 * Crea el módulo de una herramienta WASM.
 *
 * `diagnosticos`: si se pasa un array, los mensajes de la herramienta se acumulan
 * ahí en lugar de publicarse enseguida, y el llamador decide después si son un
 * error de verdad. Importa para los `.c`: el primer intento puede fallar sólo por
 * las declaraciones implícitas de C y no debe verse en el panel del editor.
 */
async function crearModulo(herramienta, fabrica, progreso, diagnosticos = null) {
  const binario = await bytesAsset(BINARIOS[herramienta]);
  let modulo;
  try {
    modulo = await fabrica({
      noInitialRun: true,
      wasmBinary: binario,
      print() {},
      printErr(linea) {
        if (!linea) return;
        if (diagnosticos) {
          diagnosticos.push(linea);
          return;
        }
        ERRORES.add(linea);
        if (progreso) progreso(`[${herramienta}] ${linea}`);
      },
    });
  } catch (error) {
    throw errorDeInfraestructura(`No se pudo iniciar ${herramienta}: ${error?.message || error}`);
  }
  return modulo;
}

/* -------------------------------------------------------------------------- */
/* Avance de la compilación                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Reparto del avance (0..1) entre las fases. El primer tramo se lleva la mayor
 * parte porque incluye la descarga de assets, que en la primera compilación es
 * lo más lento (unas 10 veces cc1plus).
 */
const TRAMOS = {
  recursos: [0, 0.35],
  cc1plus: [0.35, 0.6],
  "avr-as": [0.6, 0.7],
  "avr-ld": [0.7, 0.9],
  "avr-objcopy": [0.9, 1],
};

/**
 * Información estructurada de avance para la barra del editor.
 *
 * `dentro` es el progreso dentro de la fase (0..1); si no se informa, se ubica en
 * la mitad, así cada evento empuja la barra hacia adelante y nunca hacia atrás.
 */
function avance(fase, etiqueta, dentro) {
  const [desde, hasta] = TRAMOS[fase] ?? [0, 1];
  const proporcion = Number.isFinite(dentro) ? Math.min(1, Math.max(0, dentro)) : 0.5;
  return { fase, fase_etiqueta: etiqueta, fraccion: desde + (hasta - desde) * proporcion };
}

/**
 * Máximo avance informado en la compilación en curso.
 *
 * Algunas fases se repiten (una unidad extra vuelve a cargar recursos y a pasar
 * por cc1plus), así que sin esto la barra del editor retrocedería. El productor
 * garantiza que la fracción nunca baja.
 */
let avanceMaximo = 0;

/** Notifica una línea de log y, si el llamador lo usa, su avance estructurado. */
function avisar(progreso, linea, meta) {
  if (typeof progreso !== "function") return;
  if (Number.isFinite(meta?.fraccion)) {
    meta = { ...meta, fraccion: Math.max(avanceMaximo, meta.fraccion) };
    avanceMaximo = meta.fraccion;
  }
  progreso(linea, meta);
}

function envolverSalida(herramienta, fn) {
  try {
    return fn();
  } catch (error) {
    const mensaje = String(error?.message || error);
    const m = mensaje.match(/exit\((\d+)\)/);
    const codigo = m ? Number(m[1]) : error?.status;
    if (codigo === 0) return undefined;
    if (codigo !== undefined && codigo !== 0) {
      throw new Error(`${herramienta} terminó con código ${codigo}:\n${[...ERRORES].slice(-15).join("\n")}`);
    }
    throw new Error(`${herramienta} falló: ${mensaje}\n${[...ERRORES].slice(-15).join("\n")}`);
  }
}

/**
 * Detecta errores de compilación en los mensajes de la herramienta.
 *
 * Como `callMain` puede volver sin lanzar, esperar al archivo de salida hace que
 * un error de C++ recién aparezca en el enlazado (con un "undefined reference to
 * setup" de regalo). Mirar los diagnósticos permite cortar en la etapa correcta y
 * sin trabajo de más.
 */
const RE_ERROR = /:\d+:\d+:\s*(?:fatal error|error):|^error:/m;

function comprobarDiagnosticos(herramienta) {
  const errores = [...ERRORES].filter((linea) => RE_ERROR.test(linea));
  if (!errores.length) return;
  throw new Error(
    `${herramienta} reportó errores de compilación:\n${[...ERRORES].slice(-20).join("\n")}`,
  );
}

/**
 * Lee el artefacto que debía producir una herramienta.
 *
 * `callMain` puede retornar SIN lanzar aunque la herramienta haya terminado con
 * error (Emscripten captura el `exit` internamente). La ausencia del archivo de
 * salida es entonces la señal fiable de fallo: sin esta comprobación, un error de
 * C++ se convertía en un críptico `ErrnoError` sin los mensajes del compilador, y
 * el panel del editor quedaba vacío.
 */
function leerSalida(fs, herramienta, ruta) {
  try {
    return fs.readFile(ruta);
  } catch {
    const diagnostico = [...ERRORES].slice(-20).join("\n").trim();
    throw new Error(
      diagnostico
        ? `${herramienta} no produjo ${ruta} porque la compilación falló:\n${diagnostico}`
        : `${herramienta} no produjo ${ruta}. No hubo mensajes del compilador que mostrar.`,
    );
  }
}

/**
 * Carga en el FS virtual todos los headers y recursos listados en el manifiesto.
 *
 * El inventario pasa de 900 archivos: se descargan en paralelo (con límite) para
 * no encadenar cientos de viajes de red en serie. Las escrituras al FS virtual
 * siguen siendo síncronas, así que no hace falta ningún otro orden.
 */
const RUTAS_COMPATIBILIDAD = [
  "/digispark/libraries/DigisparkKeyboard/DigiKeyboard.h",
  "/digispark/libraries/DigisparkKeyboard/scancode-ascii-table.h",
  "/digispark/libraries/DigisparkKeyboard/usbconfig.h",
  "/digispark/libraries/DigisparkKeyboard/usbconfig-prototype.h",
  "/digispark/libraries/DigisparkKeyboard/usbdrv.h",
  "/digispark/libraries/DigisparkKeyboard/usbportability.h",
  "/digispark/libraries/DigisparkKeyboard/asmcommon.inc",
  "/digispark/libraries/DigisparkKeyboard/oddebug.h",
  "/digispark/libraries/DigisparkKeyboard/osccal.h",
  "/digispark/libraries/DigisparkKeyboard/osctune.h",
  "/digispark/libraries/DigisparkKeyboard/usbdrvasm12.inc",
  "/digispark/libraries/DigisparkKeyboard/usbdrvasm15.inc",
  "/digispark/libraries/DigisparkKeyboard/usbdrvasm16.inc",
  "/digispark/libraries/DigisparkKeyboard/usbdrvasm165.inc",
  "/digispark/libraries/DigisparkKeyboard/usbdrvasm18-crc.inc",
  "/digispark/libraries/DigisparkKeyboard/usbdrvasm20.inc",
  "/digispark/libraries/DigisparkKeyboard/usbdrvasm128.inc",
];
export async function prepararFS(fs, progreso) {
  const man = await manifest();
  const rutas = [...new Set([...(man.fsFiles || []), ...RUTAS_COMPATIBILIDAD])];
  const faltantes = [];
  let cargados = 0;
  let siguiente = 0;
  const CONCURRENCIA = 12;

  const trabajador = async () => {
    while (siguiente < rutas.length) {
      const ruta = rutas[siguiente++];
      const datos = await bytesAssetOpcional(`assets/fs${ruta}`);
      if (datos) escribir(fs, ruta, datos);
      else faltantes.push(ruta);
      cargados++;
      // El avance se informa seguido (barra fluida) y el log cada 150 archivos
      // (sin ruido): por eso las notificaciones intermedias no llevan línea.
      if (cargados % 25 === 0) {
        avisar(progreso, null, avance("recursos", "Cargando recursos", cargados / rutas.length));
      }
      if (cargados % 150 === 0) {
        avisar(progreso, `Recursos cargados: ${cargados}/${rutas.length}`, avance("recursos", "Cargando recursos", cargados / rutas.length));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, rutas.length) }, trabajador));

  avisar(progreso, `Recursos cargados: ${cargados}/${rutas.length}`, avance("recursos", "Cargando recursos", 1));
  if (faltantes.length) {
    avisar(progreso, `Aviso: ${faltantes.length} recurso(s) no disponibles en este hosting (${faltantes.slice(0, 3).join(", ")}${faltantes.length > 3 ? "…" : ""})`);
  }
  man.faltantes = faltantes;
  return man;
}

/** Carga libs, linker script y objetos en el FS del módulo dado. */
async function cargarEntradasEnlace(fs, progreso, objetosPrecompilados = []) {
  escribir(fs, "/libs/crtattiny85.o", await bytesAsset("assets/libs/crtattiny85.o"));
  // Nombres genéricos para que -lc/-lm/-lgcc los encuentre; el contenido es el de avr25.
  escribir(fs, "/libs/libc.a", await bytesAsset("assets/libs/libc-avr25.a"));
  escribir(fs, "/libs/libm.a", await bytesAsset("assets/libs/libm-avr25.a"));
  escribir(fs, "/libs/libgcc.a", await bytesAsset("assets/libs/libgcc-avr25.a"));
  escribir(fs, "/libs/libattiny85.a", await bytesAsset("assets/libs/libattiny85.a"));
  escribir(fs, "/libs/core.a", await bytesAsset("assets/libs/core.a"));
  // Objetos precompilados con GCC 7.3.0 nativo (igual que hace arduino-cli antes
  // de enlazar). Los publica el manifiesto para las fuentes `.c`/`.S` de V-USB de
  // cada librería que las usa (`objetosPorLibreria`); el resto de cada librería se
  // compila en el navegador (ver `objetosDeLibrerias`).
  for (const rel of objetosPrecompilados) {
    const nombre = rel.split("/").pop();
    escribir(fs, `/libs/${nombre}`, await bytesAsset(rel));
  }
  escribir(fs, "/ldscripts/avr25.xn", await bytesAsset("assets/ldscripts/avr25.xn"));
  const detalle = objetosPrecompilados.length ? "crt, libc, libm, libgcc, core, V-USB" : "crt, libc, libm, libgcc, core";
  avisar(progreso, `Librerías del enlace cargadas (${detalle})`, avance("avr-ld", "Enlazando", 0.4));
  return objetosPrecompilados.map((rel) => `/libs/${rel.split("/").pop()}`);
}

const DEFINES = [
  "-D__AVR_ATtiny85__", "-D__AVR_DEVICE_NAME__=attiny85",
  "-DF_CPU=16500000L",
  "-DARDUINO=10607",
  "-DARDUINO_AVR_DIGISPARK",
  "-DARDUINO_ARCH_AVR",
];

const FLAGS_COMUNES = [
  "-quiet",
  "-imultilib", "avr25",
  ...DEFINES,
  "-mmcu=avr25", "-mn-flash=1", "-mno-skip-bug",
  "-Os", "-std=gnu++11",
  // -Wno-narrowing: los .c de V-USB inicializan arrays con 128; en C++11 eso es
  // un error (en C es una conversión válida). Ver `compilarFuenteDeLibreria`.
  "-Wno-narrowing",
  "-fno-exceptions", "-fno-rtti", "-fno-threadsafe-statics", "-fpermissive",
  "-ffunction-sections", "-fdata-sections",
];

/* -------------------------------------------------------------------------- */
/* Librerías incluidas por el sketch                                           */
/* -------------------------------------------------------------------------- */

/** Extensiones que Arduino compila dentro de una librería. Las .ino de
 * `examples/` son sketches de muestra: no se compilan como parte de ella. */
const EXTENSIONES_COMPILABLES = [".cpp", ".cc", ".c", ".S"];

const RE_INCLUDE = /^[ \t]*#[ \t]*include[ \t]*[<"]([^">]+)[">]/gm;

/**
 * Índice de las librerías publicadas en el FS virtual.
 *
 * Se arma con el manifiesto (no hace falta listar directorios y refleja lo que
 * realmente publica el hosting). Los nombres de header se mapean a las
 * librerías que los publican, en el orden de búsqueda de las rutas -I.
 */
function indiceDeLibrerias(man) {
  const dirs = [];
  const porArchivo = new Map();
  const esTopNivel = (dir, ruta) => {
    const rel = ruta.slice(dir.length + 1);
    return rel.length > 0 && !rel.includes("/");
  };
  for (const bruta of man.fsFiles || []) {
    const ruta = `/${String(bruta).replace(/^\//, "")}`;
    const partes = ruta.split("/").filter(Boolean);
    let dir = null;
    if (partes[0] === "digispark" && partes[1] === "libraries" && partes.length >= 4) {
      dir = `/${partes.slice(0, 3).join("/")}`;
    } else if (partes[0] === "libraries" && partes.length >= 3) {
      dir = `/${partes.slice(0, 2).join("/")}`;
    }
    if (!dir || !esTopNivel(dir, ruta)) continue;
    if (!dirs.includes(dir)) dirs.push(dir);
    const lista = porArchivo.get(ruta.slice(dir.length + 1)) || [];
    if (!lista.includes(dir)) lista.push(dir);
    porArchivo.set(ruta.slice(dir.length + 1), lista);
  }
  // Orden de búsqueda: las librerías instaladas por el usuario (`/libraries`)
  // ganan sobre las que trae el core Digistump (`/digispark/libraries`), igual
  // que en arduino-cli. Importa cuando el usuario copia una librería para
  // ajustarle, por ejemplo, el `usbconfig.h` (nombre de fabricante del USB).
  const orden = (d) => (d.startsWith("/libraries/") ? `0${d}` : `1${d}`);
  dirs.sort((a, b) => orden(a).localeCompare(orden(b)));
  for (const lista of porArchivo.values()) lista.sort((a, b) => orden(a).localeCompare(orden(b)));
  return { dirs, porArchivo };
}

/** Fuentes de primer nivel de una librería (las que compila Arduino). */
function fuentesDeLibreria(man, dir) {
  return (man.fsFiles || [])
    .map((ruta) => `/${String(ruta).replace(/^\//, "")}`)
    .filter((ruta) => {
      if (!ruta.startsWith(`${dir}/`)) return false;
      const rel = ruta.slice(dir.length + 1);
      return rel.length > 0 && !rel.includes("/") && EXTENSIONES_COMPILABLES.some((ext) => rel.endsWith(ext));
    });
}

/** Resuelve un `#include` a la librería que lo publica (o null). */
function resolverLibreria(indice, nombre) {
  const partes = String(nombre).split("/");
  if (partes.length > 1) {
    // Forma <DigisparkUSB/DigiUSB.h>: la primera parte nombra la librería.
    const candidata = indice.dirs.find((dir) => dir.endsWith(`/${partes[0]}`));
    if (candidata) return candidata;
  }
  return (indice.porArchivo.get(nombre) || [])[0] ?? null;
}

/**
 * Librerías que el sketch necesita, siguiendo los `#include` de forma
 * transitiva (como hace arduino-cli antes de compilar el código).
 *
 * Sin esto, el enlace sólo conocía el core y la librería DigiMouse: cualquier
 * otro sketch (`DigiUSB`, `DigiKeyboard`, `Wire`, `SPI`…) fallaba con
 * "undefined reference to DigiUSB".
 */
function libreriasUsadas(man, fs, textos) {
  const indice = indiceDeLibrerias(man);
  const usadas = [];
  const pendientes = textos.map((texto) => ({ texto, dir: null }));
  while (pendientes.length) {
    const { texto, dir: dirOrigen } = pendientes.shift();
    for (const coincidencia of String(texto ?? "").matchAll(RE_INCLUDE)) {
      const nombre = coincidencia[1];
      const candidatas = indice.porArchivo.get(nombre) || [];
      // Un header que publica la propia librería (o una ya usada) no aporta nada:
      // evita que el `#include "usbdrv.h"` de DigiUSB arrastre DigisparkKeyboard.
      if (dirOrigen && candidatas.includes(dirOrigen)) continue;
      if (candidatas.some((dir) => usadas.includes(dir))) continue;
      const dir = resolverLibreria(indice, nombre);
      if (!dir || usadas.includes(dir)) continue;
      usadas.push(dir);
      for (const fuente of fuentesDeLibreria(man, dir)) {
        const contenido = leerTexto(fs, fuente);
        if (contenido !== null) pendientes.push({ texto: contenido, dir });
      }
    }
  }
  return usadas;
}

/**
 * Rutas -I de la compilación.
 *
 * IMPORTANTE: el core Digispark y sus librerías van con -I (no -isystem).
 * GCC envuelve implícitamente en extern "C" los headers encontrados vía
 * -isystem (se asumen headers de sistema C), lo que rompe las plantillas y los
 * overloads del core Arduino. Solo el sysroot de avr-libc/GCC debe ir como
 * -isystem.
 *
 * Las librerías que el sketch usa van primero: cuando varias publican el mismo
 * header (los cinco `usbdrv.h` de V-USB), gana la que corresponde al sketch.
 */
function includesDeCompilacion(man, usadas) {
  const { dirs } = indiceDeLibrerias(man);
  const resto = dirs.filter((dir) => !usadas.includes(dir));
  return [
    "-I", "/digispark/cores/tiny",
    "-I", "/digispark/variants/digispark",
    ...usadas.flatMap((dir) => ["-I", dir]),
    "-I", "/digispark/libraries",
    "-I", "/libraries",
    ...resto.flatMap((dir) => ["-I", dir]),
    "-isystem", "/sysroot/gcc/include",
    "-isystem", "/sysroot/avr/include",
  ];
}

/** Flags de compilación de una unidad de traducción (sketch o librería). */
function flagsDeCompilacion(man, usadas) {
  return [...FLAGS_COMUNES, ...includesDeCompilacion(man, usadas)];
}

/**
 * Objetos precompilados que el manifiesto declare para una librería.
 *
 * Cuando existen se enlazan tal cual (paridad byte a byte con arduino-cli, sin
 * volver a compilarlos en el navegador). Los manifiestos anteriores a este
 * soporte sólo publicaban `objetosMouse`, así que se aceptan las dos formas.
 *
 * Sólo cubren las fuentes que el frontend C++ no reproduce fielmente (los `.c` y
 * `.S` de V-USB): el resto de la librería —los `.cpp`— se sigue compilando acá, así
 * que editar esas fuentes en el editor tiene efecto.
 */
function objetosPrecompiladosDe(man, dir) {
  const nombre = dir.split("/").pop();
  const porLibreria = man.objetosPorLibreria || {};
  if (Array.isArray(porLibreria[nombre])) return porLibreria[nombre];
  if (nombre === "DigisparkMouse" && Array.isArray(man.objetosMouse)) return man.objetosMouse;
  return [];
}

function leerTexto(fs, ruta) {
  try {
    return new TextDecoder().decode(fs.readFile(ruta));
  } catch {
    return null;
  }
}

/**
 * Preprocesado de un `.S` de V-USB.
 *
 * El toolchain WASM no tiene frontend C (`cc1`) ni `avr-gcc`: el único
 * preprocesador disponible es cc1plus, y `-lang-asm` es una opción exclusiva de
 * C (cc1plus sólo la avisa y la ignora). Por eso el modo asm se emula así:
 *   - `-D__ASSEMBLER__`, que es lo que define el driver nativo para los .S;
 *   - `-P`, porque sin él cpp intercala marcadores `# línea` EN MEDIO de las
 *     instrucciones (el .S usa macros que vienen de otros archivos) y `avr-as`
 *     recibe `mov` / `r26` / `, r24` como tres líneas sueltas;
 *   - `-w`, para no inundar el panel con avisos por los apóstrofes de los
 *     comentarios (`; don't change this`) que en modo C++ cpp interpreta como
 *     literales de carácter. Son inofensivos: van dentro de comentarios `;`.
 * El ensamblador resultante es idéntico byte a byte al del toolchain nativo.
 */
const FLAGS_PREPROCESADO_ASM = ["-E", "-P", "-w", "-D__ASSEMBLER__"];

/** Llamada a una función sin declarar: en C es una declaración implícita. */
const RE_SIN_DECLARAR = /error: '([^']+)' was not declared in this scope/g;

/**
 * Nombres que el fuente llama sin declararlos.
 *
 * C los resuelve con una declaración implícita (`int nombre()`); cc1plus corta la
 * compilación con "'nombre' was not declared in this scope". Se leen de los
 * diagnósticos en vez de adivinar con expresiones regulares sobre el fuente: es
 * exactamente la lista que el compilador necesita.
 */
function llamadasSinDeclarar(diagnosticos) {
  const nombres = [];
  for (const linea of diagnosticos) {
    for (const coincidencia of String(linea).matchAll(RE_SIN_DECLARAR)) {
      if (!nombres.includes(coincidencia[1])) nombres.push(coincidencia[1]);
    }
  }
  return nombres;
}

/**
 * Fuente con la que se compila un `.c` de librería usando el frontend C++.
 *
 *   - `extern "C"` le da a los símbolos el enlazado C que espera el resto del
 *     proyecto (V-USB mezcla C y ensamblador);
 *   - las llamadas que C resolvería con una declaración implícita se declaran
 *     igual que en C, `int nombre(...)`. No sirve incluir el header de la librería:
 *     su prototipo (`unsigned usbMeasureFrameLength(void)`) le cambia la aritmética
 *     al fuente, y osccal.c —que no incluye usbdrv.h y por lo tanto en C ve un
 *     `int`— generaba 10 bytes de código distintos a los de arduino-cli.
 */
function envoltorioDeFuenteC(fuente, implicitas) {
  const declaraciones = implicitas.map((nombre) => `int ${nombre}(...);`);
  return `extern "C" {\n${declaraciones.length ? `${declaraciones.join("\n")}\n` : ""}#include "${fuente}"\n}\n`;
}

/** Intentos de compilación de un `.c` (declaraciones implícitas por ronda). */
const MAX_INTENTOS_C = 5;

/**
 * Nombres mangleados de los símbolos con enlazado interno de un fuente C++.
 *
 *   static uchar usbMsgLen;              → `_ZL9usbMsgLen`
 *   static uchar wasReset; (en función)  → `_ZZ18usbHandleResetHookE8wasReset`
 *
 * El prefijo numérico es el largo del nombre; se valida contra el nombre para no
 * tocar identificadores que casualmente empiecen igual.
 */
const RE_MANGLE_ARCHIVO = /_ZL(\d+)([A-Za-z_$][\w$]*)/g;
const RE_MANGLE_EN_FUNCION = /_ZZ(\d+)([A-Za-z_$][\w$]*?)E(\d+)([A-Za-z_$][\w$]*)/g;

/**
 * Devuelve al ensamblado el enlazado C de un fuente `.c`.
 *
 * Al compilar un `.c` con el frontend C++ (el toolchain WASM no trae `cc1`),
 * `extern "C"` arregla el enlazado de los símbolos globales pero **no** el de los
 * estáticos: GCC los manglea igual, y ese nombre se propaga a la sección
 * (`.bss._ZL9usbMsgLen`) y a cada referencia (`sts _ZL9usbMsgLen`). En C el símbolo
 * se llama `usbMsgLen` a secas, y ese nombre es el que decide el acomodo de las
 * secciones al enlazar: con el nombre mangleado el firmware sale con otro orden de
 * RAM y un HEX distinto al de arduino-cli.
 *
 * El reemplazo es textual a propósito: el nombre mangleado aparece en las
 * directivas (`.section`, `.type`, `.size`) y en los operandos (`sts`/`lds`,
 * `lo8(…)`), así que un solo pase los cubre a todos.
 */
function ensambladorConNombresDeC(asm) {
  const mapa = new Map();
  const registrar = (mangleado, nombre, valido) => {
    if (valido && !mapa.has(mangleado)) mapa.set(mangleado, nombre);
  };
  for (const coincidencia of asm.matchAll(RE_MANGLE_ARCHIVO)) {
    const [mangleado, largo, nombre] = coincidencia;
    registrar(mangleado, nombre, Number(largo) === nombre.length);
  }
  for (const coincidencia of asm.matchAll(RE_MANGLE_EN_FUNCION)) {
    const [mangleado, largoFuncion, funcion, largo, nombre] = coincidencia;
    registrar(mangleado, nombre, Number(largoFuncion) === funcion.length && Number(largo) === nombre.length);
  }
  if (!mapa.size) return asm;
  // Dos estáticos distintos pueden llamarse igual (un `static x` en dos funciones).
  // En C el compilador agrega un sufijo para desambiguarlos; acá se replica.
  const vistos = new Map();
  for (const [mangleado, nombre] of mapa) {
    const veces = vistos.get(nombre) ?? 0;
    vistos.set(nombre, veces + 1);
    if (veces) mapa.set(mangleado, `${nombre}.${veces}`);
  }
  // Los nombres más largos primero: `_ZL9usbMsgLen` no debe comerse el prefijo de
  // `_ZL10usbMsgLen2`.
  let salida = asm;
  for (const mangleado of [...mapa.keys()].sort((a, b) => b.length - a.length)) {
    salida = salida.split(mangleado).join(mapa.get(mangleado));
  }
  return salida;
}

/**
 * Compila una fuente de librería a objeto AVR y lo deja en el FS del enlazador.
 *
 * El toolchain WASM sólo incluye el frontend C++ (`cc1plus`), no `cc1`, así que
 * los `.c` se compilan como C++ envueltos en `extern "C"`: así conservan el
 * enlazado C que espera el resto del proyecto (V-USB mezcla C y ensamblador).
 *
 * Como cc1plus no acepta las declaraciones implícitas de C, un `.c` puede
 * necesitar varias rondas: en cada una se leen de los diagnósticos las llamadas
 * sin declarar y se reintenta con ellas declaradas como `int nombre(...)`, que es
 * lo que C haría (ver `envoltorioDeFuenteC`). Los diagnósticos de los intentos
 * intermedios se descartan: sólo se publica lo que dijo el intento definitivo.
 */
async function compilarFuenteDeLibreria(dir, fuente, flags, progreso) {
  const nombre = fuente.split("/").pop();
  const base = `${dir.split("/").pop()}_${nombre.replace(/\.[^.]+$/, "")}`;
  const asm = `/build/${base}.s`;
  const esC = /\.c$/.test(nombre);
  const extra = /\.S$/.test(nombre) ? FLAGS_PREPROCESADO_ASM : [];
  const entrada = esC ? `/build/${base}.c.cpp` : fuente;

  const implicitas = [];
  let ensamblador = null;
  for (let intento = 0; ensamblador === null; intento++) {
    // Un cc1plus nuevo por intento: después de una compilación con errores el
    // módulo no se puede reutilizar (aborta en `Unwind_GetIPInfo`), y un `.c` puede
    // necesitar más de una pasada. El avance no repite el log de los 900 recursos.
    const diagnosticos = [];
    const cc1x = await crearModulo("cc1plus", createCc1plus, progreso, diagnosticos);
    await prepararFS(cc1x.FS, (_, meta) => avisar(progreso, null, meta));
    crearDirs(cc1x.FS, "/build");
    if (esC) escribir(cc1x.FS, entrada, codificar(envoltorioDeFuenteC(fuente, implicitas)));
    let fallo = null;
    try {
      envolverSalida("cc1plus", () => cc1x.callMain([...flags, ...extra, entrada, "-o", asm]));
    } catch (error) {
      fallo = error;
    }
    const nuevas = esC && intento < MAX_INTENTOS_C ? llamadasSinDeclarar(diagnosticos) : [];
    if (nuevas.length) {
      for (const llamada of nuevas) {
        if (!implicitas.includes(llamada)) implicitas.push(llamada);
      }
      continue;
    }
    // Intento definitivo: lo que dijo es lo que el usuario debe ver.
    publicarDiagnosticos(progreso, "cc1plus", diagnosticos);
    if (fallo) throw fallo;
    const generado = leerSalida(cc1x.FS, "cc1plus", asm);
    ensamblador = esC ? codificar(ensambladorConNombresDeC(new TextDecoder().decode(generado))) : generado;
  }
  comprobarDiagnosticos("cc1plus");

  const as = await crearModulo("avr-as", createAvrAs, progreso);
  escribir(as.FS, asm, ensamblador);
  const objeto = `/build/${base}.o`;
  envolverSalida("avr-as", () => as.callMain(["-mmcu=attiny85", "-o", objeto, asm]));
  comprobarDiagnosticos("avr-as");
  return { nombre: base, datos: leerSalida(as.FS, "avr-as", objeto) };
}

/**
 * Compila todas las librerías que el sketch usa y devuelve sus objetos.
 *
 * Los objetos se nombran con el prefijo de la librería (`DigisparkUSB_usbdrv`)
 * para que no choquen entre sí ni con los del core.
 *
 * De cada librería se saltean las fuentes que el manifiesto ya publique como
 * objeto precompilado (`<prefijo>_<fuente>.o`: `usb_usbdrv.c.o` cubre `usbdrv.c`).
 */
async function objetosDeLibrerias(man, usadas, flags, progreso) {
  const objetos = [];
  for (const dir of usadas) {
    const precompilados = objetosPrecompiladosDe(man, dir);
    const yaCompilada = (fuente) => precompilados.some((rel) => rel.endsWith(`_${fuente.split("/").pop()}.o`));
    const libreria = dir.split("/").pop();
    const fuentes = fuentesDeLibreria(man, dir).filter((fuente) => !yaCompilada(fuente));
    if (!fuentes.length) continue;
    for (const [indice, fuente] of fuentes.entries()) {
      avisar(
        progreso,
        `Compilando librería ${libreria}: ${fuente.split("/").pop()} (${indice + 1}/${fuentes.length})...`,
        avance("cc1plus", `Compilando ${libreria}`),
      );
      const compilado = await compilarFuenteDeLibreria(dir, fuente, flags, progreso);
      objetos.push({ ...compilado, libreria });
    }
  }
  return objetos;
}

/** Antepone #include <Arduino.h> si el fuente no lo trae (semántica Arduino). */
function conArduinoH(codigo) {
  return /#include\s*[<"]Arduino\.h/.test(codigo) ? codigo : `#include <Arduino.h>\n${codigo}`;
}

/**
 * Compila código C/C++ a Intel HEX para Digispark ATtiny85, 100% en el navegador.
 *
 * Las librerías que el sketch incluye (`DigiUSB.h`, `DigiKeyboard.h`, `Wire.h`…)
 * se resuelven por sus `#include` y se compilan acá mismo, igual que haría
 * arduino-cli; no hay que agregar sus fuentes a mano (ver `libreriasUsadas`).
 *
 * @param {string} fuente Código fuente C/C++ (estilo Arduino aceptado).
 * @param {object} opciones {
 *   progreso(linea, meta) — `meta.fraccion` (0..1) alimenta la barra del editor,
 *   archivos: [{name, content}] — pestañas adicionales del editor:
 *     .ino se concatenan al principal (semántica Arduino), .h/.hpp quedan
 *     disponibles para #include y .c/.cpp se compilan como unidades extra.
 * }
 * @returns {object} { exito, hex, bytesFlash, flashLimite, tiempos, totalMs, errores[] }
 */
export async function compilar(fuente, opciones = {}) {
  const progreso = opciones.progreso || (() => {});
  ERRORES.clear();
  avanceMaximo = 0;

  // ---- Clasificación de los archivos extra (semántica Arduino) -------------
  const inos = [];
  const cabeceras = [];
  const unidades = [];
  for (const archivo of Array.isArray(opciones.archivos) ? opciones.archivos : []) {
    const nombre = String(archivo?.name || "").split(/[\\/]/).pop();
    if (!nombre) continue;
    const contenido = String(archivo?.content ?? "");
    if (/\.ino$/i.test(nombre)) inos.push({ nombre, contenido });
    else if (/\.(h|hpp|hh|hxx)$/i.test(nombre)) cabeceras.push({ nombre, contenido });
    else unidades.push({ nombre, contenido });
  }
  inos.sort((a, b) => a.nombre.localeCompare(b.nombre));
  let codigo = fuente + (inos.length ? "\n" + inos.map((a) => a.contenido).join("\n") : "");

  const t0 = performance.now();
  const tiempos = {};

  // ---------- 1) cc1plus: C++ → ensamblador AVR (una unidad por archivo) ----
  // Primero los recursos (headers y demás): en la primera compilación es la parte
  // más lenta, así que ocupa el tramo inicial del avance.
  avisar(progreso, "Paso 1/4: preparando el compilador C++ (cc1plus WASM)...", avance("recursos", "Cargando recursos", 0));
  const cc1 = await crearModulo("cc1plus", createCc1plus, progreso);
  const man = await prepararFS(cc1.FS, progreso);

  // Qué librerías necesita el sketch (DigiUSB, DigiKeyboard, Wire…): se resuelve
  // antes de compilar porque también define el orden de las rutas -I.
  const usadas = libreriasUsadas(man, cc1.FS, [codigo, ...cabeceras.map((c) => c.contenido)]);
  if (usadas.length) {
    avisar(progreso, `Librerías detectadas: ${usadas.map((dir) => dir.split("/").pop()).join(", ")}`, avance("cc1plus", "Compilando C++", 0));
  }
  const FLAGS_TU = flagsDeCompilacion(man, usadas);

  avisar(progreso, "Compilando el sketch a ensamblador AVR...", avance("cc1plus", "Compilando C++", 0));
  escribir(cc1.FS, "/build/sketch.cpp", codificar(conArduinoH(codigo)));
  for (const c of cabeceras) escribir(cc1.FS, `/build/${c.nombre}`, codificar(c.contenido));

  const ensambladores = [{ nombre: "sketch", s: null }];
  envolverSalida("cc1plus", () => cc1.callMain([...FLAGS_TU, "/build/sketch.cpp", "-o", "/build/sketch.s"]));
  comprobarDiagnosticos("cc1plus");
  ensambladores[0].s = leerSalida(cc1.FS, "cc1plus", "/build/sketch.s");
  tiempos.cc1plusMs = Math.round(performance.now() - t0);
  avisar(progreso, `Ensamblador AVR generado (${ensambladores[0].s.length} bytes)`, avance("cc1plus", "Compilando C++", 1));

  for (const u of unidades) {
    avisar(progreso, `Compilando unidad extra: ${u.nombre}...`, avance("cc1plus", `Compilando ${u.nombre}`));
    const cc1x = await crearModulo("cc1plus", createCc1plus, progreso);
    await prepararFS(cc1x.FS, (_, meta) => avisar(progreso, null, meta));
    const base = u.nombre.replace(/\.[^.]+$/, "");
    escribir(cc1x.FS, `/build/${u.nombre}`, codificar(conArduinoH(u.contenido)));
    envolverSalida("cc1plus", () => cc1x.callMain([...FLAGS_TU, `/build/${u.nombre}`, "-o", `/build/${base}.s`]));
    comprobarDiagnosticos("cc1plus");
    ensambladores.push({ nombre: base, s: leerSalida(cc1x.FS, "cc1plus", `/build/${base}.s`) });
  }

  // ---------- 1b) Fuentes de las librerías usadas por el sketch -------------
  // Las librerías del Digispark son C/C++ con partes de V-USB en ensamblador, así
  // que se compilan igual que el sketch y se enlazan con él. Las que el
  // manifiesto ya publica precompiladas (DigiMouse) no pasan por acá.
  const objetosLibrerias = await objetosDeLibrerias(man, usadas, FLAGS_TU, progreso);
  tiempos.libreriasMs = Math.round(performance.now() - t0 - tiempos.cc1plusMs);
  if (objetosLibrerias.length) {
    avisar(progreso, `Librerías compiladas: ${objetosLibrerias.map((o) => o.nombre).join(", ")}`, avance("cc1plus", "Compilando librerías", 1));
  }

  // ---------- 2) avr-as: ensamblador → objeto (uno por unidad) --------------
  avisar(progreso, "Paso 2/4: ensamblando a objeto ELF AVR (avr-as WASM)...", avance("avr-as", "Ensamblando"));
  const objetos = [];
  for (const unidad of ensambladores) {
    const as = await crearModulo("avr-as", createAvrAs, progreso);
    escribir(as.FS, `/build/${unidad.nombre}.s`, unidad.s);
    envolverSalida("avr-as", () => as.callMain(["-mmcu=attiny85", "-o", `/build/${unidad.nombre}.o`, `/build/${unidad.nombre}.s`]));
    comprobarDiagnosticos("avr-as");
    objetos.push({ nombre: unidad.nombre, o: leerSalida(as.FS, "avr-as", `/build/${unidad.nombre}.o`) });
  }
  tiempos.avrAsMs = Math.round(performance.now() - t0 - tiempos.cc1plusMs - tiempos.libreriasMs);
  avisar(progreso, `Objetos generados (${objetos.map((o) => `${o.nombre}: ${o.o.length} B`).join(", ")})`, avance("avr-as", "Ensamblando", 1));

  // ---------- 3) avr-ld: objetos → ELF con core Digispark -------------------
  avisar(progreso, "Paso 3/4: enlazando con el core Digispark (avr-ld WASM)...", avance("avr-ld", "Enlazando"));
  const ld = await crearModulo("avr-ld", createAvrLd, progreso);
  const precompilados = usadas.flatMap((dir) => objetosPrecompiladosDe(man, dir));
  const rutasLibrerias = await cargarEntradasEnlace(ld.FS, progreso, precompilados);
  for (const objeto of objetos) escribir(ld.FS, `/build/${objeto.nombre}.o`, objeto.o);
  for (const objeto of objetosLibrerias) escribir(ld.FS, `/libs/${objeto.nombre}.o`, objeto.datos);
  // Receta verificada byte a byte contra el HEX de arduino-cli (digistump:avr:digispark-tiny):
  // el driver nativo pasa --pmem-wrap-around=8k y agrupa las libs con --start-group/--end-group.
  envolverSalida("avr-ld", () => ld.callMain([
    "-mavr25",
    "--pmem-wrap-around=8k",
    "--gc-sections",
    "-o", "/build/sketch.elf",
    "/libs/crtattiny85.o",
    ...objetos.map((o) => `/build/${o.nombre}.o`),
    ...objetosLibrerias.map((o) => `/libs/${o.nombre}.o`),
    ...rutasLibrerias,
    "/libs/core.a",
    "-L/libs",
    "--start-group",
    "-lgcc", "-lm", "-lc", "-lattiny85",
    "--end-group",
  ]));
  const elf = leerSalida(ld.FS, "avr-ld", "/build/sketch.elf");
  tiempos.avrLdMs = Math.round(performance.now() - t0 - tiempos.cc1plusMs - tiempos.libreriasMs - tiempos.avrAsMs);
  avisar(progreso, `ELF enlazado (${elf.length} bytes)`, avance("avr-ld", "Enlazando", 1));

  // ---------- 4) avr-objcopy: ELF → Intel HEX -------------------------------
  avisar(progreso, "Paso 4/4: generando Intel HEX (avr-objcopy WASM)...", avance("avr-objcopy", "Generando HEX"));
  const oc = await crearModulo("avr-objcopy", createObjcopy, progreso);
  escribir(oc.FS, "/build/sketch.elf", elf);
  envolverSalida("avr-objcopy", () => oc.callMain(["-O", "ihex", "-R", ".eeprom", "/build/sketch.elf", "/build/sketch.hex"]));
  const hexBytes = leerSalida(oc.FS, "avr-objcopy", "/build/sketch.hex");
  const hex = new TextDecoder().decode(hexBytes);
  tiempos.avrObjcopyMs = Math.round(performance.now() - t0 - tiempos.cc1plusMs - tiempos.libreriasMs - tiempos.avrAsMs - tiempos.avrLdMs);

  // ---------- Resumen --------------------------------------------------------
  let bytesFlash = 0;
  for (const linea of hex.split(/\r?\n/)) {
    if (!linea || linea[0] !== ":") continue;
    if (parseInt(linea.slice(7, 9), 16) === 0x00) bytesFlash += parseInt(linea.slice(1, 3), 16);
  }
  const exito = bytesFlash > 0 && bytesFlash <= FLASH_USUARIO;
  avisar(
    progreso,
    exito
      ? `Compilación completa: ${bytesFlash} bytes de flash (${Math.round((bytesFlash / FLASH_USUARIO) * 100)}% de ${FLASH_USUARIO})`
      : `El firmware excede la flash del Digispark (${bytesFlash} > ${FLASH_USUARIO} bytes)`,
    avance("avr-objcopy", exito ? "Compilación completa" : "Firmware demasiado grande", 1),
  );

  // `ok`/`bytes` replican el contrato del agente local (tools/compile-agent.py)
  // para que el editor pueda usar cualquiera de las dos rutas sin distinguirlas.
  return {
    ok: exito,
    bytes: bytesFlash,
    exito,
    hex,
    bytesFlash,
    flashLimite: FLASH_USUARIO,
    sizes: { flash: bytesFlash, ram: null, maximum: FLASH_USUARIO },
    tiempos,
    totalMs: Math.round(performance.now() - t0),
    errores: [...ERRORES],
  };
}

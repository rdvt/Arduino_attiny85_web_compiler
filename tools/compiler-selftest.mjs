#!/usr/bin/env node
/**
 * Prueba de integración del compilador web (compiler/compiler.js) en Node.
 *
 * Fase 1 — disco: parchea fetch para leer URLs file:// y compila el sketch de
 *          referencia comparando el HEX con el de arduino-cli.
 * Fase 2 — HTTP en subdirectorio: levanta un servidor que publica web/ bajo
 *          /Arduino_attiny85_web_compiler/ y compila otra vez pasando la base SIN
 *          barra final. Es el escenario del sitio publicado (GitHub Pages o un
 *          hosting con subcarpeta) donde las rutas relativas se rompían.
 */
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { join, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ_COMPILER = fileURLToPath(new URL("../compiler/", import.meta.url));
const RAIZ_WEB = fileURLToPath(new URL("../", import.meta.url));

// ---------- Parche de fetch para URLs file:// ----------
const fetchOriginal = globalThis.fetch;
const cacheFetch = new Map();
globalThis.fetch = async (entrada) => {
  const url = String(entrada instanceof Request ? entrada.url : entrada);
  if (!url.startsWith("file://")) return fetchOriginal(entrada);
  const ruta = fileURLToPath(url);
  let datos = cacheFetch.get(ruta);
  if (!datos) {
    try {
      const contenido = await readFile(ruta);
      const buffer = contenido.buffer.slice(contenido.byteOffset, contenido.byteOffset + contenido.byteLength);
      datos = {
        ok: true, status: 200,
        arrayBuffer: async () => buffer,
        json: async () => JSON.parse(new TextDecoder().decode(buffer)),
        text: async () => new TextDecoder().decode(buffer),
      };
    } catch {
      datos = { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), json: async () => { throw new Error("404"); }, text: async () => "" };
    }
    cacheFetch.set(ruta, datos);
  }
  return datos;
};

const { compilar, fijarBaseAssets } = await import(pathToFileURL(join(RAIZ_COMPILER, "compiler.js")).href);


// ---------- Sketch de prueba: el sketch real del proyecto ----------
// El ejemplo vive en EjemplosDigispark/; se acepta la ruta antigua por compatibilidad.
const RUTAS_SKETCH = [
  join(import.meta.dirname, "../EjemplosDigispark/DigisparkMouse/DigisparkMouse.ino"),
  join(import.meta.dirname, "../DigisparkMouse/DigisparkMouse.ino"),
];
let fuente = null;
for (const ruta of RUTAS_SKETCH) {
  try {
    fuente = await readFile(ruta, "utf8");
    break;
  } catch { /* se prueba la siguiente */ }
}
if (fuente === null) throw new Error(`No encontré el sketch de referencia en:\n  ${RUTAS_SKETCH.join("\n  ")}`);

const referencia = (await readFile(join(import.meta.dirname, "compiler-hex-referencia.hex"), "utf8")).replace(/\r/g, "");

/** Compara un HEX generado con la referencia y devuelve true si son idénticos. */
function compararHex(generado) {
  const limpio = generado.replace(/\r/g, "");
  if (limpio === referencia) return true;
  const lineasRef = referencia.split("\n");
  const lineasGen = limpio.split("\n");
  console.error(`DIFERENCIA: ${lineasRef.length} vs ${lineasGen.length} líneas`);
  let mostradas = 0;
  for (let i = 0; i < Math.max(lineasRef.length, lineasGen.length); i++) {
    if (lineasRef[i] !== lineasGen[i]) {
      console.error(`  línea ${i + 1}:`);
      console.error(`    ref: ${lineasRef[i]?.slice(0, 60)}`);
      console.error(`    gen: ${lineasGen[i]?.slice(0, 60)}`);
      if (++mostradas > 6) break;
    }
  }
  return false;
}

// ============================================================================
// Fase 1 · Compilación desde el sistema de archivos
// ============================================================================
/** Comprueba que el avance que alimenta la barra del editor sea coherente. */
function revisarAvance(metas, etiqueta) {
  const fracciones = metas.map((m) => m?.fraccion).filter((f) => Number.isFinite(f));
  if (fracciones.length < 5) {
    console.error(`FALLO (${etiqueta}): solo ${fracciones.length} eventos con fracción; la barra no tendría datos.`);
    process.exit(1);
  }
  for (let i = 1; i < fracciones.length; i++) {
    if (fracciones[i] < fracciones[i - 1]) {
      console.error(`FALLO (${etiqueta}): la barra retrocedería (${fracciones[i - 1]} → ${fracciones[i]}).`);
      process.exit(1);
    }
  }
  const ultima = fracciones.at(-1);
  if (ultima !== 1) {
    console.error(`FALLO (${etiqueta}): la barra termina en ${ultima} en vez de 1.`);
    process.exit(1);
  }
  const fases = new Set(metas.map((m) => m?.fase).filter(Boolean));
  console.log(`  avance OK: ${fracciones.length} eventos, fases ${[...fases].join(" → ")}, termina en 100 %`);
}

console.log("== Fase 1: compilación desde disco (file://) ==");
const metasFase1 = [];
const resultado = await compilar(fuente, {
  // Las notificaciones sin línea son solo avance de la barra: no se imprimen.
  progreso: (linea, meta) => { metasFase1.push(meta); if (linea) console.log(`  ${linea}`); },
});
revisarAvance(metasFase1, "fase 1");
console.log(`\nResultado: exito=${resultado.exito}, ${resultado.bytesFlash} bytes de flash (límite ${resultado.flashLimite})`);
console.log(`Tiempos: ${JSON.stringify(resultado.tiempos)} | total ${resultado.totalMs} ms`);

if (!compararHex(resultado.hex)) {
  console.error("\nFALLO: el HEX de la fase 1 no coincide con arduino-cli.");
  process.exit(1);
}
console.log("★ Fase 1 OK: el HEX generado en WASM es IDÉNTICO byte a byte al de arduino-cli");

// Un sketch con errores debe fallar con los diagnósticos del compilador.
// `callMain` de Emscripten puede retornar sin lanzar, así que si esto se rompe el
// usuario ve un críptico ErrnoError y el panel del editor queda vacío.
const ROTO = "#include <Arduino.h>\nvoid setup() { noExisteEstaFuncion(); }\nvoid loop() {}\n";
try {
  await compilar(ROTO, { progreso: () => {} });
  console.error("FALLO: un sketch con errores compiló sin fallar.");
  process.exit(1);
} catch (error) {
  const mensaje = String(error?.message || error);
  if (!/error:/.test(mensaje)) {
    console.error(`FALLO: el error no incluye los diagnósticos del compilador:\n  ${mensaje.slice(0, 300)}`);
    process.exit(1);
  }
  if (/ErrnoError|ENOENT/.test(mensaje)) {
    console.error(`FALLO: el error se filtra como ErrnoError en vez de mostrarse:\n  ${mensaje.slice(0, 300)}`);
    process.exit(1);
  }
  console.log("  errores de C++ OK: llega el diagnóstico de cc1plus (no un ErrnoError)");
}

// ============================================================================
// Fase 2 · Sitio servido en un subdirectorio (reproduce el hosting real)
// ============================================================================
const PREFIJO = "/Arduino_attiny85_web_compiler/";
const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
};

const servidor = createServer(async (req, res) => {
  const ruta = new URL(req.url, "http://127.0.0.1").pathname;
  if (!ruta.startsWith(PREFIJO)) {
    res.writeHead(404).end("fuera del sitio");
    return;
  }
  const rel = decodeURIComponent(ruta.slice(PREFIJO.length));
  const destino = join(RAIZ_WEB, rel);
  try {
    if (!(await stat(destino)).isFile()) throw new Error("no es archivo");
    res.writeHead(200, { "content-type": TIPOS[extname(destino)] ?? "application/octet-stream" });
    res.end(await readFile(destino));
  } catch {
    res.writeHead(404).end("no encontrado");
  }
});
await new Promise((resolver) => servidor.listen(0, "127.0.0.1", resolver));
const puerto = servidor.address().port;

const sinBarraFinal = `http://127.0.0.1:${puerto}${PREFIJO}compiler`; // a propósito, sin "/"
console.log(`\n== Fase 2: sitio en subdirectorio (${sinBarraFinal}) ==`);
fijarBaseAssets(sinBarraFinal);

let resultadoHttp;
try {
  resultadoHttp = await compilar(fuente, { progreso: (l) => console.log(`  ${l}`) });
} catch (error) {
  console.error(`\nFALLO: no se pudo compilar con el sitio servido en un subdirectorio.\n  ${error.message}`);
  console.error("Sospecha: la base de assets no se normalizó con '/' final, así que las rutas relativas pierden el último segmento.");
  process.exit(1);
} finally {
  servidor.close();
}

if (!compararHex(resultadoHttp.hex)) {
  console.error("\nFALLO: el HEX de la fase 2 (subdirectorio) no coincide con arduino-cli.");
  console.error("Sospecha: la base de assets no se normalizó con '/' final, así que las rutas relativas pierden el último segmento.");
  process.exit(1);
}console.log("★ Fase 2 OK: compila igual con el sitio servido en un subdirectorio");

// ============================================================================
// Fase 3 · Protocolo del Web Worker (sin hilo principal y sin `document`)
// ============================================================================
// Se emula el entorno de un worker: `self` con addEventListener/postMessage.
// Verifica el protocolo de mensajes y que compiler.js no dependa del DOM.
console.log("\n== Fase 3: protocolo del worker del compilador ==");

let manejadorMensaje = null;
const mensajes = [];
globalThis.self = {
  addEventListener: (tipo, callback) => { if (tipo === "message") manejadorMensaje = callback; },
  postMessage: (datos) => mensajes.push(datos),
};

await import(pathToFileURL(join(RAIZ_COMPILER, "worker.js")).href);
if (typeof manejadorMensaje !== "function") {
  console.error("FALLO: worker.js no registró el manejador de mensajes.");
  process.exit(1);
}

const baseWorker = new URL("../compiler/", import.meta.url).href;
manejadorMensaje({ data: { id: 7, tipo: "compilar", fuente, base: baseWorker } });

const final = await new Promise((resolver, rechazar) => {
  const limite = Date.now() + 120000;
  const revisar = setInterval(() => {
    const cierre = mensajes.find((m) => m.id === 7 && (m.tipo === "resultado" || m.tipo === "fallo"));
    if (cierre) {
      clearInterval(revisar);
      cierre.tipo === "resultado" ? resolver(cierre) : rechazar(new Error(cierre.mensaje));
    } else if (Date.now() > limite) {
      clearInterval(revisar);
      rechazar(new Error("el worker no respondió en 120 s"));
    }
  }, 20);
}).catch((error) => {
  console.error(`\nFALLO: el worker no produjo un resultado.\n  ${error.message}`);
  process.exit(1);
});

const eventosProgreso = mensajes.filter((m) => m.id === 7 && m.tipo === "progreso");
if (eventosProgreso.length < 5) {
  console.error(`FALLO: el worker envió ${eventosProgreso.length} mensajes de progreso; se esperaban varios.`);
  process.exit(1);
}
// El worker debe reenviar la fracción para que el editor pueda dibujar la barra.
revisarAvance(eventosProgreso.map((m) => m.meta), "fase 3 (worker)");
const progreso = eventosProgreso.map((m) => m.linea);
if (final.resultado.ok !== true || final.resultado.bytes !== 2960) {
  console.error(`FALLO: resultado inesperado del worker: ok=${final.resultado.ok} bytes=${final.resultado.bytes}`);
  process.exit(1);
}
if (!compararHex(final.resultado.hex)) {
  console.error("\nFALLO: el HEX de la fase 3 (worker) no coincide con arduino-cli.");
  process.exit(1);
}
console.log(`  ${progreso.length} mensajes de progreso recibidos`);
console.log("★ Fase 3 OK: el worker compila y reporta progreso sin tocar el DOM");

// ============================================================================
// Fase 4 · Librerías del sketch (paridad V-USB y compilación en el navegador)
// ============================================================================
// El compilador resuelve las librerías por sus `#include` y enlaza las que el
// sketch usa. Las que traen V-USB (DigiMouse, DigiUSB, DigiKeyboard, DigiJoystick,
// DigiCDC) tienen fuentes `.c`/`.S` que **sólo un frontend C** compila igual que
// arduino-cli: el WASM publica `cc1plus`. Para esas fuentes el manifiesto declara
// objetos nativos (`objetosPorLibreria`) y el resto de la librería —los `.cpp`— se
// compila en el navegador, así que editar esos fuentes sigue teniendo efecto.
//
// Cada referencia de `tools/referencias/` es el par sketch + HEX que produjo
// `arduino-cli compile --fqbn digistump:avr:digispark-tiny` con el toolchain AVR
// nativo, así que comparar contra ellas es la prueba de paridad byte a byte.
console.log("\n== Fase 4: librerías del sketch ==");
fijarBaseAssets(new URL("../compiler/", import.meta.url).href);

/**
 * El firmware debe arrancar con rjmp/jmp: es la primera validación del flasher
 * (ver `patchResetVector` en flasher/micronucleus.js). El AVR es little-endian
 * por palabra, así que la primera instrucción es `byte0 | (byte1 << 8)`.
 */
function primeraInstruccionEsSalto(hex) {
  const primera = hex.split("\n").find((linea) => linea.startsWith(":"));
  const palabra = parseInt(primera.slice(9, 11), 16) | (parseInt(primera.slice(11, 13), 16) << 8);
  return palabra === 0x940c || (palabra & 0xf000) === 0xc000;
}

async function compilarSketch(etiqueta, fuente, esperado) {
  const lineas = [];
  const resultado = await compilar(fuente, {
    progreso: (linea) => {
      if (!linea) return;
      lineas.push(linea);
      if (/Librerías detectadas|Librerías compiladas|Librerías del enlace/.test(linea)) console.log(`  ${linea}`);
    },
  });
  const detectadas = lineas.find((linea) => linea.startsWith("Librerías detectadas:"));
  if (esperado && !(detectadas ?? "").includes(esperado)) {
    console.error(`FALLO (${etiqueta}): no detectó la librería ${esperado}.\n  ${detectadas ?? "(sin detección de librerías)"}`);
    process.exit(1);
  }
  if (!resultado.exito) {
    console.error(`FALLO (${etiqueta}): el firmware no entra en la flash (${resultado.bytesFlash} bytes).`);
    process.exit(1);
  }
  if (!primeraInstruccionEsSalto(resultado.hex)) {
    console.error(`FALLO (${etiqueta}): el firmware no empieza con rjmp/jmp.`);
    process.exit(1);
  }
  console.log(`  ${etiqueta}: ${resultado.bytesFlash} bytes y vector de reset válido`);
  return resultado;
}

/**
 * Compila el sketch de referencia de una librería y compara el HEX con el nativo.
 *
 * El par `<Librería>.ino` + `<Librería>.hex` de `tools/referencias/` es lo que
 * produjo arduino-cli, así que una igualdad byte a byte acá significa que el
 * navegador compila y enlaza igual que el toolchain nativo.
 */
async function compararReferencia(libreria) {
  const fuente = await readFile(join(import.meta.dirname, `referencias/${libreria}.ino`), "utf8");
  const referencia = (await readFile(join(import.meta.dirname, `referencias/${libreria}.hex`), "utf8")).replace(/\r/g, "");
  const resultado = await compilarSketch(libreria, fuente, libreria);
  if (resultado.hex.replace(/\r/g, "") === referencia) {
    console.log(`★ ${libreria}: HEX idéntico byte a byte al de arduino-cli`);
    return;
  }
  const a = referencia.split("\n");
  const b = resultado.hex.replace(/\r/g, "").split("\n");
  const distintas = a.filter((linea, i) => linea !== b[i]).length;
  console.error(`FALLO (${libreria}): el HEX difiere en ${distintas} líneas (referencia ${a.length}, generado ${b.length}).`);
  for (let i = 0; i < Math.max(a.length, b.length) && i < 5; i++) {
    if (a[i] !== b[i]) console.error(`  línea ${i + 1}:\n    ref: ${a[i]}\n    gen: ${b[i]}`);
  }
  process.exit(1);
}

// Las cuatro librerías V-USB del core (DigiMouse ya se probó en las fases 1-3).
for (const libreria of ["DigisparkUSB", "DigisparkKeyboard", "DigisparkJoystick", "DigisparkCDC"]) {
  await compararReferencia(libreria);
}

// Wire es C++ puro (sin V-USB): cubre el camino sin objetos precompilados, donde
// todas las fuentes se compilan en el navegador.
await compilarSketch(
  "Wire",
  `#include <Wire.h>
void setup() { Wire.begin(); }
void loop() { Wire.beginTransmission(0x48); Wire.endTransmission(); }
`,
  "Wire",
);

// Un #include que no existe debe fallar con el diagnóstico de cc1plus, no con el
// críptico "undefined reference to setup" del enlazado.
try {
  await compilar("#include <NoExisteEstaLibreria.h>\nvoid setup() {}\nvoid loop() {}\n", { progreso: () => {} });
  console.error("FALLO: un sketch con un #include inexistente compiló sin fallar.");
  process.exit(1);
} catch (error) {
  if (!/NoExisteEstaLibreria\.h/.test(String(error?.message || error))) {
    console.error(`FALLO: el error no menciona el header que falta.\n  ${String(error?.message || error).slice(0, 200)}`);
    process.exit(1);
  }
  console.log("  header inexistente: falla con el diagnóstico del compilador");
}

console.log("\n★ ÉXITO TOTAL: HEX idéntico al de arduino-cli (mouse y librerías V-USB) y librerías del sketch resueltas");
process.exit(0);

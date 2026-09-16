#!/usr/bin/env node
/**
 * Verificación en un navegador real (Chrome headless + DevTools Protocol).
 *
 * Sirve el sitio bajo /Arduino_attiny85_web_compiler/ (un subdirectorio, como el
 * hosting real de GitHub Pages),
 * abre la página del editor y compila el ejemplo con el MISMO Web Worker que usa
 * el editor. Después compara el HEX con la referencia de arduino-cli y revisa que
 * la consola no tenga errores.
 *
 * Uso:
 *   node tools/browser-check.mjs
 *   HOST_PRUEBA=127.0.0.1 node tools/browser-check.mjs   # simula desarrollo local
 *   CHROME_PATH=... node tools/browser-check.mjs
 *
 * Comprueba además que en un dominio publicado NO se sondee el agente local
 * (en 127.0.0.1 sí, porque ahí es una herramienta de desarrollo).
 *
 * Requiere Chrome instalado. Si no se encuentra, sale con código 0 y un aviso:
 * es una verificación opcional, no una dependencia del proyecto.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, rm, mkdtemp, access } from "node:fs/promises";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

/** FNV-1a 32 bits: sirve para comparar cadenas en cualquier contexto (HTTP incluido). */
const fnv1a = (texto) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    hash ^= texto.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const RAIZ_WEB = fileURLToPath(new URL("../", import.meta.url));
const PREFIJO = "/Arduino_attiny85_web_compiler/";
const PUERTO_HTTP = 8231;
const PUERTO_CDP = 9333;
const CANDIDATOS_CHROME = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

let CHROME = null;
for (const candidato of CANDIDATOS_CHROME) {
  try {
    await access(candidato);
    CHROME = candidato;
    break;
  } catch { /* se prueba el siguiente */ }
}
if (!CHROME) {
  console.log("AVISO: no encontré Chrome ni Chromium; salteo la verificación en navegador.");
  console.log("       Definí CHROME_PATH=/ruta/al/ejecutable para forzarla.");
  process.exit(0);
}

const referencia = (await readFile(new URL("./compiler-hex-referencia.hex", import.meta.url), "utf8")).replace(/\r/g, "");
const shaReferencia = createHash("sha256").update(referencia, "utf8").digest("hex");
// Referencia nativa del ejemplo DigiUSB (tools/referencias/, generada con arduino-cli).
const referenciaUsb = (await readFile(new URL("./referencias/DigisparkUSB.hex", import.meta.url), "utf8")).replace(/\r/g, "");

const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".wasm": "application/wasm", ".css": "text/css; charset=utf-8", ".ino": "text/plain; charset=utf-8" };

const servidor = createServer(async (req, res) => {
  const ruta = new URL(req.url, "http://127.0.0.1").pathname;
  if (!ruta.startsWith(PREFIJO)) return res.writeHead(404).end("fuera del sitio");
  let rel = decodeURIComponent(ruta.slice(PREFIJO.length));
  if (rel === "" || rel.endsWith("/")) rel += "index.html"; // como cualquier servidor estático
  const destino = join(RAIZ_WEB, rel);
  try {
    const datos = await readFile(destino);
    res.writeHead(200, { "content-type": TIPOS[extname(destino)] ?? "application/octet-stream" });
    res.end(datos);
  } catch {
    res.writeHead(404).end("no encontrado");
  }
});
await new Promise((r) => servidor.listen(PUERTO_HTTP, "127.0.0.1", r));

const perfil = await mkdtemp(join(tmpdir(), "chrome-compilador-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${perfil}`, `--remote-debugging-port=${PUERTO_CDP}`,
  // Simula un dominio publicado (no-localhost) resolviéndolo al servidor local.
  "--host-resolver-rules=MAP valedam.test 127.0.0.1",
  "about:blank",
], { stdio: "ignore" });

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let listo = false;
for (let i = 0; i < 60 && !listo; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PUERTO_CDP}/json/version`);
    listo = r.ok;
  } catch { /* todavía no */ }
  if (!listo) await dormir(500);
}
if (!listo) { chrome.kill("SIGKILL"); servidor.close(); throw new Error("Chrome no abrió el puerto de depuración"); }

const objetivos = await (await fetch(`http://127.0.0.1:${PUERTO_CDP}/json/list`)).json();
const pagina = objetivos.find((o) => o.type === "page");
const ws = new WebSocket(pagina.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("no pude abrir el WebSocket de CDP")); });

let siguienteId = 1;
const pendientes = new Map();
const eventos = [];
ws.onmessage = (evento) => {
  const datos = JSON.parse(evento.data);
  if (datos.id && pendientes.has(datos.id)) {
    const { resolver, rechazar } = pendientes.get(datos.id);
    pendientes.delete(datos.id);
    datos.error ? rechazar(new Error(JSON.stringify(datos.error))) : resolver(datos.result);
  } else if (datos.method) {
    eventos.push(datos);
  }
};
const enviar = (method, params = {}) =>
  new Promise((resolver, rechazar) => {
    const id = siguienteId++;
    pendientes.set(id, { resolver, rechazar });
    ws.send(JSON.stringify({ id, method, params }));
  });

await enviar("Runtime.enable");
await enviar("Log.enable");
await enviar("Page.enable");
// Nombre de host no-localhost a propósito: así se comprueba que el sitio publicado
// no intenta contactar el agente local en 127.0.0.1:8765.
const HOST = process.env.HOST_PRUEBA ?? "valedam.test";
await enviar("Page.navigate", { url: `http://${HOST}:${PUERTO_HTTP}${PREFIJO}editor/` });
await dormir(2500); // deja cargar el editor y su sondeo (que ya no debería existir)

const EXPRESION = `(async () => {
  const base = new URL("../compiler/", location.href).href;
  const worker = new Worker(new URL("../compiler/worker.js", location.href), { type: "module" });
  const fuente = await (await fetch("../DigisparkMouse/DigisparkMouse.ino")).text();
  let progreso = 0;
  const resultado = await new Promise((resolver, rechazar) => {
    const reloj = setTimeout(() => rechazar(new Error("timeout de compilación")), 180000);
    worker.addEventListener("error", (e) => { clearTimeout(reloj); rechazar(new Error("error del worker: " + e.message)); });
    worker.addEventListener("message", (e) => {
      if (e.data.tipo === "progreso") { progreso++; return; }
      clearTimeout(reloj);
      if (e.data.tipo === "fallo") rechazar(new Error(e.data.mensaje));
      else resolver(e.data.resultado);
    });
    worker.postMessage({ id: 1, tipo: "compilar", fuente, base });
  });
  const hex = resultado.hex.replace(/\\r/g, "");
  let fnv = 0x811c9dc5;
  for (let i = 0; i < hex.length; i++) { fnv ^= hex.charCodeAt(i); fnv = Math.imul(fnv, 0x01000193) >>> 0; }
  return JSON.stringify({ ok: resultado.ok, bytes: resultado.bytes, lineas: hex.split("\\n").length, progreso, fnv: (fnv >>> 0).toString(16).padStart(8, "0") });
})()`;

// ----------------------------------------------------------------------------
// Fase A · La barra de progreso del editor, pulsando «Compilar» de verdad
// Se ejecuta PRIMERO, con la caché fría: es el caso en el que la barra importa
// (descarga de assets) y donde se pueden muestrear muchos valores intermedios.
// ----------------------------------------------------------------------------
const EXPRESION_UI = `(async () => {
  const texto = (id) => document.getElementById(id)?.textContent ?? "";
  const esperar = (fn, ms, que) => new Promise((resolver, rechazar) => {
    const t0 = Date.now();
    const reloj = setInterval(() => {
      let valor = false;
      try { valor = fn(); } catch { valor = false; }
      if (valor) { clearInterval(reloj); resolver(valor); }
      else if (Date.now() - t0 > ms) { clearInterval(reloj); rechazar(new Error("timeout esperando " + que)); }
    }, 100);
  });

  // El editor carga el sketch de ejemplo publicado al arrancar.
  await esperar(() => document.getElementById("src").value.length > 100, 30000, "el sketch de ejemplo");

  const muestras = [];
  const reloj = setInterval(() => {
    const relleno = document.getElementById("progreso-compilacion-fill");
    const caja = document.getElementById("compilando");
    muestras.push({
      ancho: relleno ? relleno.style.width : null,
      etiqueta: texto("compilando-texto"),
      visible: caja ? !caja.hidden : null,
    });
  }, 30); // muestreo fino: la primera compilación es la que más valores intermedios tiene

  document.getElementById("btn-compilar").click();
  await esperar(() => /Compilado:|falló/i.test(texto("build-resumen")), 180000, "el fin de la compilación");
  clearInterval(reloj);
  await esperar(() => document.getElementById("progreso-compilacion-fill").style.width === "100%", 5000, "la barra al 100 %").catch(() => null);

  const anchos = muestras.map((m) => parseFloat(m.ancho)).filter((n) => Number.isFinite(n));
  let monotono = true;
  for (let i = 1; i < anchos.length; i++) if (anchos[i] < anchos[i - 1]) monotono = false;
  const etiquetas = [...new Set(muestras.map((m) => (m.etiqueta || "").split(" · ")[0]).filter(Boolean))];

  return JSON.stringify({
    resumen: texto("build-resumen"),
    anchoFinal: document.getElementById("progreso-compilacion-fill").style.width,
    aria: document.getElementById("progreso-compilacion").getAttribute("aria-valuenow"),
    muestras: muestras.length,
    valoresDistintos: [...new Set(anchos)].length,
    maxAncho: anchos.length ? Math.max(...anchos) : 0,
    monotono,
    etiquetas: etiquetas.slice(0, 8),
    logOk: /OK: 2960 bytes/.test(document.getElementById("salida").textContent),
  });
})()`;

const evaluacionUI = await enviar("Runtime.evaluate", { expression: EXPRESION_UI, awaitPromise: true, returnByValue: true });

// ----------------------------------------------------------------------------
// Fase B · Un sketch roto: la barra debe marcarlo y NO buscar el agente local
// ----------------------------------------------------------------------------
const EXPRESION_ERROR = `(async () => {
  const texto = (id) => document.getElementById(id)?.textContent ?? "";
  const esperar = (fn, ms, que) => new Promise((resolver, rechazar) => {
    const t0 = Date.now();
    const reloj = setInterval(() => {
      let valor = false;
      try { valor = fn(); } catch { valor = false; }
      if (valor) { clearInterval(reloj); resolver(valor); }
      else if (Date.now() - t0 > ms) { clearInterval(reloj); rechazar(new Error("timeout esperando " + que)); }
    }, 100);
  });

  const src = document.getElementById("src");
  src.value = "#include <Arduino.h>\\nvoid setup() { noExisteEstaFuncion(); }\\nvoid loop() {}\\n";
  src.dispatchEvent(new Event("input", { bubbles: true }));
  document.getElementById("btn-compilar").click();
  await esperar(() => /falló/i.test(texto("build-resumen")), 120000, "el fallo de compilación");

  const salida = texto("salida");
  const caja = document.getElementById("compilando");
  return JSON.stringify({
    resumen: texto("build-resumen"),
    clase: caja.className,
    visible: !caja.hidden,
    textoBarra: texto("compilando-texto"),
    errores: document.querySelectorAll("#build-findings li.error").length,
    usoAgente: /pruebo el agente local|No pude hablar con el agente/.test(salida),
  });
})()`;

const evaluacionError = await enviar("Runtime.evaluate", { expression: EXPRESION_ERROR, awaitPromise: true, returnByValue: true });

// ----------------------------------------------------------------------------
// Fase C · El worker del compilador por separado, comparando el HEX
// (la caché ya está caliente: aquí interesa la corrección, no la velocidad)
// ----------------------------------------------------------------------------
const evaluacion = await enviar("Runtime.evaluate", { expression: EXPRESION, awaitPromise: true, returnByValue: true });

// ----------------------------------------------------------------------------
// Fase D · Un sketch que usa OTRA librería (DigiUSB)
// El compilador tiene que resolverla por sus #include, enlazar los objetos nativos
// de V-USB que publica el manifiesto y compilar en el navegador su parte C++
// (DigiUSB.cpp). Antes de este soporte, cualquier sketch que no fuera el del mouse
// fallaba con "undefined reference to `DigiUSB'" (y en GitHub Pages igual).
// El HEX se compara contra la referencia nativa, así que esta fase también cubre la
// paridad byte a byte de las librerías V-USB.
// ----------------------------------------------------------------------------
const EXPRESION_LIBRERIA = `(async () => {
  const base = new URL("../compiler/", location.href).href;
  const worker = new Worker(new URL("../compiler/worker.js", location.href), { type: "module" });
  const fuente = [
    "#include <DigiUSB.h>",
    "void setup() { DigiUSB.begin(); }",
    "void loop() {",
    "  if (DigiUSB.available()) { DigiUSB.write(DigiUSB.read()); }",
    "  DigiUSB.refresh();",
    "}",
    "",
  ].join("\\n");
  const lineas = [];
  const resultado = await new Promise((resolver, rechazar) => {
    const reloj = setTimeout(() => rechazar(new Error("timeout de compilación")), 300000);
    worker.addEventListener("error", (e) => { clearTimeout(reloj); rechazar(new Error("error del worker: " + e.message)); });
    worker.addEventListener("message", (e) => {
      if (e.data.tipo === "progreso") { if (e.data.linea) lineas.push(e.data.linea); return; }
      clearTimeout(reloj);
      if (e.data.tipo === "fallo") rechazar(new Error(e.data.mensaje));
      else resolver(e.data.resultado);
    });
    worker.postMessage({ id: 2, tipo: "compilar", fuente, base });
  });
  const hex = resultado.hex.replace(/\\r/g, "");
  const primera = hex.split("\\n").find((l) => l.startsWith(":"));
  const palabra = parseInt(primera.slice(9, 11), 16) | (parseInt(primera.slice(11, 13), 16) << 8);
  let fnv = 0x811c9dc5;
  for (let i = 0; i < hex.length; i++) { fnv ^= hex.charCodeAt(i); fnv = Math.imul(fnv, 0x01000193) >>> 0; }
  return JSON.stringify({
    ok: resultado.ok,
    bytes: resultado.bytes,
    arrancaConSalto: palabra === 0x940c || (palabra & 0xf000) === 0xc000,
    detectada: lineas.some((l) => /Librerías detectadas:.*DigisparkUSB/.test(l)),
    precompilado: lineas.some((l) => /Librerías del enlace cargadas.*V-USB/.test(l)),
    compiladas: (lineas.find((l) => l.startsWith("Librerías compiladas:")) ?? "").replace("Librerías compiladas: ", ""),
    lineas: hex.split("\\n").length,
    fnv: (fnv >>> 0).toString(16).padStart(8, "0"),
  });
})()`;

const evaluacionLibreria = await enviar("Runtime.evaluate", { expression: EXPRESION_LIBRERIA, awaitPromise: true, returnByValue: true });

ws.close();
chrome.kill("SIGKILL");
servidor.close();
await rm(perfil, { recursive: true, force: true });

if (evaluacion.exceptionDetails) {
  console.error("FALLO en el navegador:", JSON.stringify(evaluacion.exceptionDetails.exception?.description ?? evaluacion.exceptionDetails));
  process.exit(1);
}

const salida = JSON.parse(evaluacion.result.value);
console.log("Navegador:", JSON.stringify(salida));
console.log("Referencia: sha256=" + shaReferencia + " fnv=" + fnv1a(referencia) + " lineas=" + referencia.split("\n").length);

const erroresRed = eventos
  .filter((e) => e.method === "Log.entryAdded" && ["error", "warning"].includes(e.params.entry.level))
  .map((e) => `${e.params.entry.level}: ${e.params.entry.text} (${e.params.entry.url ?? ""})`);

if (erroresRed.length) {
  console.log("\nAvisos/errores en la consola del navegador:");
  for (const linea of erroresRed.slice(0, 10)) console.log("  " + linea);
} else {
  console.log("\nSin errores ni advertencias en la consola del navegador.");
}

if (salida.fnv !== fnv1a(referencia) || salida.lineas !== referencia.split("\n").length) {
  console.error("\nFALLO: el HEX del navegador no coincide con la referencia.");
  process.exit(1);
}
console.log(`\n★ Chrome OK: el worker compila en el navegador (${salida.progreso} mensajes de progreso) y el HEX es idéntico byte a byte a arduino-cli`);

if (evaluacionUI.exceptionDetails) {
  console.error("\nFALLO en la barra de progreso:", JSON.stringify(evaluacionUI.exceptionDetails.exception?.description ?? evaluacionUI.exceptionDetails));
  process.exit(1);
}

const ui = JSON.parse(evaluacionUI.result.value);
console.log("\nBarra de progreso del editor:", JSON.stringify(ui, null, 0));

const problemas = [];
if (!/Compilado:\s*2960 bytes/.test(ui.resumen)) problemas.push(`el resumen no confirma la compilación: "${ui.resumen}"`);
if (!ui.logOk) problemas.push("el log no muestra \"OK: 2960 bytes\"");
if (ui.anchoFinal !== "100%") problemas.push(`la barra terminó en ${ui.anchoFinal} en vez de 100%`);
if (ui.valoresDistintos < 6) problemas.push(`la barra solo pasó por ${ui.valoresDistintos} valor(es): no avanzó de forma gradual`);
if (!ui.monotono) problemas.push("la barra retrocedió en algún momento");
if (ui.etiquetas.length < 3) problemas.push(`solo ${ui.etiquetas.length} etiqueta(s) de fase distintas`);

if (problemas.length) {
  console.error("\nFALLO en la barra de progreso:");
  for (const problema of problemas) console.error("  - " + problema);
  process.exit(1);
}
console.log(`★ Barra OK: avanzó por ${ui.valoresDistintos} valores distintos (${ui.maxAncho}% máximo), sin retrocesos, fases: ${ui.etiquetas.join(" → ")}`);

if (evaluacionError.exceptionDetails) {
  console.error("\nFALLO en la ruta de error:", JSON.stringify(evaluacionError.exceptionDetails.exception?.description ?? evaluacionError.exceptionDetails));
  process.exit(1);
}

const fallo = JSON.parse(evaluacionError.result.value);
console.log("\nSketch roto:", JSON.stringify(fallo));

const problemasError = [];
if (!/falló/i.test(fallo.resumen)) problemasError.push(`el resumen no marca el fallo: "${fallo.resumen}"`);
if (!fallo.clase.includes("error")) problemasError.push(`la barra no quedó en estado de error (clases: ${fallo.clase})`);
if (!fallo.visible) problemasError.push("la barra se ocultó en lugar de mostrar el error");
if (fallo.errores < 1) problemasError.push("no se listó ningún error del compilador");
if (fallo.usoAgente) problemasError.push("un error de C++ disparó el respaldo al agente local (no debe hacerlo)");

if (problemasError.length) {
  console.error("\nFALLO en la ruta de error:");
  for (const problema of problemasError) console.error("  - " + problema);
  process.exit(1);
}
console.log(`★ Error OK: ${fallo.errores} error(es) en el panel, barra en rojo y sin respaldo innecesario al agente`);

if (evaluacionLibreria.exceptionDetails) {
  console.error(
    "\nFALLO compilando un sketch con DigiUSB:",
    JSON.stringify(evaluacionLibreria.exceptionDetails.exception?.description ?? evaluacionLibreria.exceptionDetails),
  );
  process.exit(1);
}

const libreria = JSON.parse(evaluacionLibreria.result.value);
console.log("\nSketch con DigiUSB:", JSON.stringify(libreria));

const problemasLibreria = [];
if (!libreria.ok) problemasLibreria.push("el sketch no compiló");
if (!libreria.detectada) problemasLibreria.push("no detectó la librería DigisparkUSB a partir de sus #include");
if (!libreria.arrancaConSalto) problemasLibreria.push("el firmware no empieza con jmp/rjmp");
if (!libreria.precompilado) problemasLibreria.push("no enlazó los objetos nativos de V-USB que publica el manifiesto");
if (libreria.fnv !== fnv1a(referenciaUsb) || libreria.lineas !== referenciaUsb.split("\n").length) {
  problemasLibreria.push(`el HEX de DigiUSB no coincide con el de arduino-cli (fnv ${libreria.fnv} vs ${fnv1a(referenciaUsb)})`);
}

if (problemasLibreria.length) {
  console.error("\nFALLO con las librerías del sketch:");
  for (const problema of problemasLibreria) console.error("  - " + problema);
  process.exit(1);
}
console.log(`★ Librería OK: compiló ${libreria.compiladas} en el navegador, enlazó los objetos nativos de V-USB y el HEX es idéntico byte a byte al de arduino-cli`);

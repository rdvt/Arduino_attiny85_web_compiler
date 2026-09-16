#!/usr/bin/env node
/**
 * Servidor local que imita a GitHub Pages para probar el sitio antes de publicar.
 *
 * No hace falta instalar nada (sólo Node). Reproduce lo que hace el hosting real
 * con un sitio de proyecto:
 *
 *   - publica el repositorio bajo un subdirectorio, igual que
 *     https://<usuario>.github.io/<repositorio>/ (por defecto
 *     /Arduino_attiny85_web_compiler);
 *   - `/repositorio` redirige a `/repositorio/` y una carpeta sin barra final
 *     también (301), como hace Pages;
 *   - `/repositorio/carpeta/` sirve `index.html`;
 *   - los archivos y carpetas ocultos (`.git`, `.DS_Store`, `.gitattributes`…)
 *     devuelven 404: Pages no los publica — el compilador avisa "9 recurso(s) no
 *     disponibles en este hosting" justamente por eso;
 *   - manda los tipos MIME correctos (`.wasm`, `.json`, `.mjs`, `.hex`…), que es
 *     lo que necesita el Web Worker del compilador.
 *
 * Uso:
 *   node tools/servir-local.mjs                 # http://127.0.0.1:8000/Arduino_attiny85_web_compiler/
 *   node tools/servir-local.mjs --port 8080
 *   node tools/servir-local.mjs --prefijo /otro-nombre
 *   node tools/servir-local.mjs --abrir         # abre el editor en el navegador
 *   node tools/servir-local.mjs --con-ocultos   # publica también los archivos ocultos
 *
 * Para grabar la placa con WebUSB alcanza con `localhost`: el navegador también
 * considera seguro ese origen.
 */
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const RAIZ = fileURLToPath(new URL("../", import.meta.url));

/** Tipos MIME que sirve GitHub Pages y que el sitio necesita. */
const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".hex": "text/plain; charset=utf-8",
  ".ino": "text/plain; charset=utf-8",
  ".c": "text/plain; charset=utf-8",
  ".h": "text/plain; charset=utf-8",
  ".cpp": "text/plain; charset=utf-8",
  ".S": "text/plain; charset=utf-8",
  ".inc": "text/plain; charset=utf-8",
  ".zip": "application/zip",
  ".bin": "application/octet-stream",
  ".o": "application/octet-stream",
  ".a": "application/octet-stream",
  ".eep": "application/octet-stream",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".pde": "text/plain; charset=utf-8",
  ".properties": "text/plain; charset=utf-8",
};

function opciones(argv) {
  const valor = (nombre, porDefecto) => {
    const i = argv.indexOf(nombre);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : porDefecto;
  };
  const prefijo = `/${valor("--prefijo", "Arduino_attiny85_web_compiler").replace(/^\/+|\/+$/g, "")}`;
  return {
    puerto: Number(valor("--port", process.env.PORT ?? 8000)),
    host: valor("--host", "127.0.0.1"),
    prefijo,
    ocultos: argv.includes("--con-ocultos"),
    abrir: argv.includes("--abrir"),
  };
}

const AYUDA = `
Servidor local que imita a GitHub Pages.

Uso:
  node tools/servir-local.mjs [opciones]

Opciones:
  --port <n>        puerto (por defecto 8000)
  --host <host>     interfaz (por defecto 127.0.0.1)
  --prefijo <ruta>  subdirectorio que imita al repositorio (por defecto /Arduino_attiny85_web_compiler)
  --abrir           abre el editor en el navegador al levantar
  --con-ocultos     publica también los archivos ocultos (Pages no los publica)
  --ayuda           muestra esta ayuda
`;

if (process.argv.includes("--ayuda") || process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(AYUDA);
  process.exit(0);
}

const { puerto, host, prefijo, ocultos, abrir } = opciones(process.argv.slice(2));

/** ¿Hay algún segmento oculto (`.git`, `.DS_Store`) en la ruta? */
const tieneOcultos = (rel) => rel.split(/[/\\]/).some((parte) => parte.startsWith(".") && parte !== "." && parte !== "");

/** Resuelve una ruta relativa del sitio a un archivo de disco sin salir de RAIZ. */
function resolverArchivo(rel) {
  const limpia = decodeURIComponent(rel.split("?")[0].split("#")[0]);
  const destino = normalize(join(RAIZ, limpia));
  if (destino !== RAIZ.replace(/[/\\]$/, "") && !destino.startsWith(RAIZ.endsWith(sep) ? RAIZ : RAIZ + sep)) return null;
  return destino;
}

function responder(res, estado, cabeceras, cuerpo = "") {
  res.writeHead(estado, { "cache-control": "no-store", ...cabeceras });
  res.end(cuerpo);
}

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${host}:${puerto}`);
  let ruta = url.pathname;

  // Igual que Pages: `/` no es el sitio de proyecto, se redirige a él.
  if (ruta === "/") {
    responder(res, 302, { location: `${prefijo}/` });
    console.log(`302 ${ruta} → ${prefijo}/`);
    return;
  }
  if (!ruta.startsWith(`${prefijo}/`) && ruta !== prefijo) {
    responder(res, 404, { "content-type": "text/plain; charset=utf-8" },
      `Esta carpeta publica el sitio en ${prefijo}/ (como GitHub Pages). Abrí http://${host}:${puerto}${prefijo}/\n`);
    console.log(`404 ${ruta} (fuera del prefijo ${prefijo}/)`);
    return;
  }
  if (ruta === prefijo) {
    responder(res, 301, { location: `${prefijo}/` });
    console.log(`301 ${ruta} → ${prefijo}/`);
    return;
  }

  const rel = ruta.slice(prefijo.length + 1);
  if (!ocultos && tieneOcultos(rel)) {
    responder(res, 404, { "content-type": "text/plain; charset=utf-8" }, "404 (GitHub Pages no publica archivos ocultos)\n");
    console.log(`404 ${ruta} (oculto, como en Pages)`);
    return;
  }

  let destino = resolverArchivo(rel);
  if (!destino) {
    responder(res, 400, { "content-type": "text/plain; charset=utf-8" }, "ruta inválida\n");
    return;
  }

  let info = await stat(destino).catch(() => null);
  if (info?.isDirectory()) {
    // Pages agrega la barra final y después sirve el index.html de la carpeta.
    if (!ruta.endsWith("/")) {
      responder(res, 301, { location: `${ruta}/` });
      console.log(`301 ${ruta} → ${ruta}/`);
      return;
    }
    destino = join(destino, "index.html");
    info = await stat(destino).catch(() => null);
  }

  if (!info?.isFile()) {
    responder(res, 404, { "content-type": "text/html; charset=utf-8" },
      `<!doctype html><meta charset="utf-8"><title>404</title><h1>404</h1><p>No existe <code>${ruta}</code> en el sitio publicado.</p>`);
    console.log(`404 ${ruta}`);
    return;
  }

  const tipo = TIPOS[extname(destino)] ?? "application/octet-stream";
  const cabeceras = {
    "content-type": tipo,
    "content-length": String(info.size),
    // `content-length` importa para el .wasm de 13 MB del compilador.
  };
  if (req.method === "HEAD") {
    responder(res, 200, cabeceras);
  } else {
    res.writeHead(200, { "cache-control": "no-store", ...cabeceras });
    createReadStream(destino).pipe(res);
  }
  console.log(`200 ${ruta} (${tipo.split(";")[0]}, ${(info.size / 1024).toFixed(1)} kB)`);
});

servidor.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`El puerto ${puerto} está ocupado. Probá con otro: node tools/servir-local.mjs --port 8080`);
  } else {
    console.error("No pude levantar el servidor:", error.message);
  }
  process.exit(1);
});

servidor.listen(puerto, host, async () => {
  const base = `http://${host}:${puerto}${prefijo}/`;
  const paginas = ["editor/", "assembler/", "flasher/", "worker-editor/", "manual.html"];
  const disponibles = [];
  for (const pagina of paginas) {
    const existe = await stat(join(RAIZ, pagina === "manual.html" ? pagina : pagina)).catch(() => null);
    if (existe) disponibles.push(pagina);
  }
  console.log("Servidor local (igual que GitHub Pages)");
  console.log(`  raíz del repositorio: ${RAIZ}`);
  console.log(`  publicando en:        ${base}`);
  console.log(`  archivos ocultos:     ${ocultos ? "sí (--con-ocultos)" : "no, como GitHub Pages"}`);
  console.log("\nAbrí:");
  for (const pagina of disponibles) console.log(`  ${base}${pagina}`);
  console.log(`\nCompará con el sitio publicado:`);
  console.log("  https://rdvt.github.io/Arduino_attiny85_web_compiler/");
  console.log("\nCtrl+C para parar. Cada pedido queda registrado abajo.\n");

  if (abrir) {
    const abre = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(abre, [base], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  }
});

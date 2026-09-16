/* ============================================================================
 *  Test del agente local de compilación (necesita el agente levantado).
 *
 *    python3 tools/compile-agent.py &
 *    node tools/agent-selftest.mjs
 *
 *  Comprueba contra el agente real:
 *    1. /health y la lista de placas ATtiny85;
 *    2. que compilar el sketch del repo devuelva EXACTAMENTE el .hex de build/
 *       (misma imagen binaria que produce ./flash.sh);
 *    3. que un cambio en el código cambie el binario;
 *    4. que un error de compilación se reporte como error y no como .hex;
 *    5. /save (con backup) sobre un archivo temporal, sin tocar el sketch real;
 *    6. la lista blanca de orígenes y el preflight de Private Network Access.
 * ========================================================================== */

import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

import { parseIntelHex } from "../flasher/intelhex.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const BASE = process.env.AGENT_URL ?? "http://127.0.0.1:8765";

const ok = (text) => console.log(`OK   ${text}`);
const skip = (text) => console.log(`SALTO ${text}`);

async function call(path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  return { status: response.status, payload, headers: response.headers };
}

/* --------------------------- 1. salud y placas ---------------------------- */

let health;
try {
  health = await call("/health");
} catch (error) {
  console.error(
    `No puedo hablar con el agente en ${BASE} (${error.message}).\n` +
      "Levantalo con: python3 tools/compile-agent.py &",
  );
  process.exit(1);
}

assert.equal(health.status, 200);
assert.equal(health.payload.ok, true);
assert.ok(health.payload.digistumpInstalled, "falta el core digistump:avr");

const boards = health.payload.boards;
assert.ok(boards.length > 0, "no detectó ninguna placa ATtiny85");
assert.ok(
  boards.every((board) => board.mcu === "attiny85"),
  "se colaron placas que no son ATtiny85",
);
assert.ok(boards.some((board) => board.fqbn === "digistump:avr:digispark-tiny"));
console.log(`     placas: ${boards.map((b) => `${b.fqbn} (${b.fCpu})`).join(", ")}`);
ok(`/health OK: ${boards.length} placas ATtiny85, todas con mcu=attiny85`);

/* ------------------- 2. compilar el sketch real del repo ------------------ */

const sketchResponse = await call(`/sketch?path=DigisparkMouse/DigisparkMouse.ino`);
assert.equal(sketchResponse.status, 200);
const source = sketchResponse.payload.source;
assert.match(source, /DigiMouse\.h/, "no leí el sketch esperado");
console.log(`     sketch: ${source.length} bytes de fuente`);

const built = await call("/compile", {
  method: "POST",
  body: { source, name: "DigisparkMouse", fqbn: "digistump:avr:digispark-tiny" },
});
assert.equal(built.status, 200, `la compilación falló:\n${built.payload.log ?? ""}`);
assert.equal(built.payload.ok, true);
assert.match(built.payload.hex, /^:/m, "no devolvió Intel HEX");

// La prueba fuerte: mismo binario que el .hex ya verificado de build/.
const referencePath = join(REPO, "build", "DigisparkMouse.ino.hex");
if (existsSync(referencePath)) {
  const reference = parseIntelHex(readFileSync(referencePath, "utf8")).image;
  const compiled = parseIntelHex(built.payload.hex).image;
  assert.equal(compiled.length, reference.length, "la imagen compilada mide distinto que la de ./flash.sh");
  assert.ok(
    Buffer.from(compiled).equals(Buffer.from(reference)),
    "el binario compilado por el agente difiere del que produce ./flash.sh",
  );
  ok(`compilado idéntico byte a byte al .hex de ./flash.sh (${compiled.length} bytes)`);
} else {
  console.log(`     (no está ${referencePath}; comparo sólo el tamaño)`);
  skip("no hay .hex de referencia en build/ para comparar byte a byte");
}
assert.equal(built.payload.bytes, parseIntelHex(built.payload.hex).image.length);
ok(`/compile OK: ${built.payload.bytes} bytes de imagen, flash usada ${built.payload.sizes.flash ?? "?"}`);

/* -------------------- 3. un cambio de código cambia el hex ---------------- */

const edited = await call("/compile", {
  method: "POST",
  body: {
    source: source.replace("#define PASO_PX        4", "#define PASO_PX        9"),
    name: "DigisparkMouse",
    fqbn: "digistump:avr:digispark-tiny",
  },
});
assert.equal(edited.status, 200, `la compilación editada falló:\n${edited.payload.log ?? ""}`);
assert.equal(edited.payload.ok, true);
assert.notEqual(edited.payload.hex, built.payload.hex, "cambiar el código no cambió el binario");
ok("un cambio en el código produce un binario distinto (el editor recompila de verdad)");

/* ---------------------- 4. errores de compilación ------------------------- */

const broken = await call("/compile", {
  method: "POST",
  body: {
    source: "void setup() {\n  estoNoExiste();\n}\nvoid loop() {}\n",
    name: "Rota",
    fqbn: "digistump:avr:digispark-tiny",
  },
});
assert.equal(broken.payload.ok, false, "un error de compilación se reportó como éxito");
assert.equal(broken.payload.hex, "");
assert.match(broken.payload.log, /error/i, "el log no trae el error del compilador");
ok("un sketch roto se reporta como error con el log del compilador");

/* ------------------------------- 5. /save --------------------------------- */

const tempDir = mkdtempSync(join(REPO, "build", "selftest-"));
const tempRelative = join(tempDir, "prueba.ino").slice(REPO.length + 1);
writeFileSync(join(REPO, tempRelative), "// original\n");

const saved = await call("/save", { method: "POST", body: { path: tempRelative, source: "// nuevo\n" } });
assert.equal(saved.payload.ok, true, `save falló: ${saved.payload.error}`);
assert.equal(readFileSync(join(REPO, tempRelative), "utf8"), "// nuevo\n");
assert.equal(readFileSync(join(REPO, tempRelative + ".bak"), "utf8"), "// original\n", "no dejó backup");
ok("/save escribe el archivo y deja backup .bak");

const outside = await call("/save", { method: "POST", body: { path: "../../etc/hosts", source: "x" } });
assert.equal(outside.payload.ok, false, "dejó guardar fuera del repo");
assert.equal((await call("/save", { method: "POST", body: { path: "flash.sh", source: "x" } })).payload.ok, false);
ok("/save rechaza rutas fuera del repo y extensiones no permitidas");

rmSync(tempDir, { recursive: true, force: true });

/* ------------------------ 6. orígenes y preflight ------------------------- */

const evil = await call("/health", { headers: { origin: "https://evil.example" } });
assert.equal(evil.status, 403, "atendió a un origen no autorizado");
assert.equal(evil.headers.get("access-control-allow-origin"), null, "devolvió CORS a un origen no autorizado");
ok("un origen no autorizado recibe 403 y ningún header CORS");

const allowed = await call("/health", { headers: { origin: "https://rdvt.github.io" } });
assert.equal(allowed.status, 200);
assert.equal(allowed.headers.get("access-control-allow-origin"), "https://rdvt.github.io");

const preflight = await fetch(BASE + "/compile", {
  method: "OPTIONS",
  headers: {
    origin: "https://rdvt.github.io",
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type",
    "access-control-request-private-network": "true",
  },
});
assert.equal(preflight.status, 204);
assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
ok("el preflight desde GitHub Pages habilita Private Network Access (127.0.0.1)");

console.log("\nTodo verde: el agente compila igual que ./flash.sh y sólo atiende a los orígenes permitidos.");

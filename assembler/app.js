import { assemble, AssemblerError } from "./avr85.js";

const $ = (id) => document.getElementById(id);
const DEFAULT_SOURCE = `.device attiny85
; ATtiny85: PB0 como salida. Cambia el valor para variar el patrón.
.equ DDRB  = 0x17
.equ PORTB = 0x18

.org 0
rjmp reset

reset:
    ldi r16, 0x01
    out DDRB, r16

loop:
    out PORTB, r16
    rcall delay
    eor r16, r16
    ldi r16, 0x01
    rjmp loop

; Retardo mínimo de ejemplo: en firmware real ajustá F_CPU.
delay:
    ldi r18, 0xff
wait:
    dec r18
    brne wait
    ret
`;

let lastResult = null;

function setStatus(text, kind = "idle") {
  const element = $("status");
  element.textContent = text;
  element.className = `status ${kind}`;
}

function syncLines() {
  const source = $("source");
  const count = source.value.split("\n").length;
  $("lines").textContent = Array.from({ length: count }, (_, index) => index + 1).join("\n");
  $("source-meta").textContent = `${count} líneas · ${source.value.length} caracteres`;
  updateCursor();
}

function updateCursor() {
  const source = $("source");
  const before = source.value.slice(0, source.selectionStart);
  const line = before.split("\n").length;
  const column = before.length - before.lastIndexOf("\n");
  $("cursor").textContent = `Línea ${line} · Columna ${column}`;
}

function resetResult() {
  lastResult = null;
  $("used").textContent = "—";
  $("end").textContent = "—";
  $("symbols").textContent = "—";
  $("size").textContent = "—";
  $("meter-fill").style.width = "0%";
  $("meter-fill").parentElement.classList.remove("over");
  $("symbol-list").textContent = "Ensamblá para ver etiquetas.";
  $("hex-output").textContent = "Ensamblá el programa para generar Intel HEX.";
  $("diagnostics").innerHTML = '<p class="muted">Los errores aparecen aquí con línea y columna.</p>';
  $("diagnostic-count").textContent = "0";
  for (const id of ["download-hex", "download-bin", "copy-hex"]) $(id).disabled = true;
}

function renderDiagnostics(items) {
  const container = $("diagnostics");
  container.innerHTML = "";
  if (!items.length) {
    container.innerHTML = '<p class="diagnostic ok"><span class="tag">OK</span><span class="message">Sin errores. El programa se puede descargar.</span></p>';
    $("diagnostic-count").textContent = "0";
    return;
  }
  $("diagnostic-count").textContent = String(items.length);
  for (const item of items) {
    const row = document.createElement("p");
    row.className = `diagnostic ${item.kind || "error"}`;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = item.kind || "error";
    const message = document.createElement("span");
    message.className = "message";
    message.textContent = `${item.line ? `Línea ${item.line}: ` : ""}${item.message}`;
    row.append(tag, message);
    container.append(row);
  }
}

function renderResult(result) {
  lastResult = result;
  const target = $("target").value === "digispark" ? 6012 : 8192;
  const percent = Math.min(100, Math.round((result.bytes / target) * 1000) / 10);
  $("used").textContent = `${result.bytes} B`;
  $("end").textContent = `0x${result.bytes.toString(16).toUpperCase()}`;
  $("symbols").textContent = String(Object.keys(result.symbols).length);
  $("size").textContent = `${percent}% de ${target} B`;
  $("meter-fill").style.width = `${percent}%`;
  $("meter-fill").parentElement.classList.toggle("over", result.bytes > target);
  $("hex-output").textContent = result.hex;
  const symbols = Object.entries(result.symbols).filter(([name]) => !["SREG", "PORTB", "DDRB"].includes(name));
  $("symbol-list").textContent = symbols.length
    ? symbols.map(([name, value]) => `${name.padEnd(20)}  0x${Number(value).toString(16).toUpperCase().padStart(4, "0")} (${value})`).join("\n")
    : "No hay etiquetas definidas.";
  renderDiagnostics([]);
  for (const id of ["download-hex", "download-bin", "copy-hex"]) $(id).disabled = false;
  setStatus("Ensamblado correctamente", "ok");
}

function assembleSource() {
  resetResult();
  setStatus("Ensamblando…", "busy");
  try {
    const result = assemble($("source").value, { target: $("target").value });
    renderResult(result);
  } catch (error) {
    const item = {
      kind: "error",
      line: error instanceof AssemblerError ? error.line : null,
      message: error?.message || String(error),
    };
    renderDiagnostics([item]);
    setStatus("Hay un error", "error");
  }
}

function download(name, data, type) {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

$("source").value = DEFAULT_SOURCE;
syncLines();
$("source").addEventListener("input", () => { syncLines(); setStatus("Cambios sin ensamblar", "busy"); });
$("source").addEventListener("click", updateCursor);
$("source").addEventListener("keyup", updateCursor);
$("source").addEventListener("scroll", () => { $("lines").scrollTop = $("source").scrollTop; });
$("source").addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    const source = $("source");
    source.setRangeText("  ", source.selectionStart, source.selectionEnd, "end");
    syncLines();
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    assembleSource();
  }
});
$("assemble").addEventListener("click", assembleSource);
$("example").addEventListener("click", () => { $("source").value = DEFAULT_SOURCE; syncLines(); assembleSource(); });
$("clear").addEventListener("click", () => { $("source").value = ""; syncLines(); resetResult(); setStatus("Editor vacío", "idle"); });
$("target").addEventListener("change", () => { if (lastResult) assembleSource(); });
$("download-hex").addEventListener("click", () => download("firmware-attiny85.hex", lastResult.hex, "text/plain"));
$("download-bin").addEventListener("click", () => download("firmware-attiny85.bin", lastResult.image, "application/octet-stream"));
$("copy-hex").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(lastResult.hex);
    $("copy-hex").textContent = "Copiado";
    setTimeout(() => { $("copy-hex").textContent = "Copiar"; }, 1200);
  } catch {
    setStatus("No se pudo copiar", "error");
  }
});

assembleSource();

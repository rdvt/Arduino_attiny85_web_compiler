/* ============================================================================
 *  Worker del compilador ATtiny85 (cc1plus + binutils en WebAssembly)
 *
 *  Ejecuta compiler/compiler.js en un hilo aparte: la página sigue
 *  respondiendo durante la compilación (la primera pasada descarga ~20 MB y
 *  cc1plus puede tardar segundos) y el progreso llega como mensajes.
 *
 *  Protocolo (postMessage):
 *    ← { id, tipo: "compilar", fuente, archivos, base }
 *    → { id, tipo: "progreso", linea, meta }   meta.fraccion (0..1) alimenta la barra
 *    → { id, tipo: "resultado", resultado }
 *    → { id, tipo: "fallo", mensaje, infraestructura }
 *
 *  `fallo` se distingue a propósito de un error del worker. Y dentro de `fallo`,
 *  `infraestructura: true` significa "no pude cargar el compilador o sus assets",
 *  mientras que `false` es un error de compilación del sketch: en ese caso el
 *  editor debe mostrar los errores, no buscarse otro compilador.
 * ========================================================================== */

import { compilar, fijarBaseAssets } from "./compiler.js";

// Una compilación por vez, en orden de llegada.
let cola = Promise.resolve();

self.addEventListener("message", (evento) => {
  const datos = evento.data;
  if (!datos || datos.tipo !== "compilar") return;
  cola = cola.then(() => atender(datos));
});

async function atender({ id, fuente, archivos, base }) {
  try {
    if (base) fijarBaseAssets(base);
    const resultado = await compilar(String(fuente ?? ""), {
      archivos,
      progreso: (linea, meta) => self.postMessage({ id, tipo: "progreso", linea, meta }),
    });
    self.postMessage({ id, tipo: "resultado", resultado });
  } catch (error) {
    // Nunca dejar caer el worker por un error de compilación: se informa y sigue vivo.
    self.postMessage({
      id,
      tipo: "fallo",
      mensaje: String(error?.message || error),
      infraestructura: Boolean(error?.infraestructura),
    });
  }
}

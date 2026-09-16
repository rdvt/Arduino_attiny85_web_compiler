/* ============================================================================
 *  Hub de herramientas del editor: las etapas del compilador y las dos rutas
 *  de grabación convergiendo en el ATtiny85.
 *
 *  Versión en SVG plano del patrón "integration" de 21st.dev. El sitio no usa
 *  React ni Tailwind, así que se reproduce el mismo efecto sin dependencias:
 *   - El diagrama se construye desde una tabla de datos (nada de SVG repetido
 *     a mano) y los textos visibles viven en el HTML que envuelve al nodo.
 *   - Los pulsos que viajan hacia el chip son CSS puro; el largo real de cada
 *     camino se mide con `getTotalLength()` para que el ciclo sea continuo.
 *   - Los nodos entran escalonados cuando el bloque llega a pantalla.
 *   - Con `prefers-reduced-motion: reduce` no hay entrada ni pulsos: queda el
 *     diagrama quieto, que sigue contando lo mismo.
 *   - Es decorativo: `aria-hidden` en el contenedor y todo el contenido del
 *     diagrama está también en el texto de la tarjeta.
 *
 *  Uso: `<div class="integration__visual" data-toolchain-hub></div>` y este
 *  módulo se inicializa solo (igual que `hero-3d.js`).
 * ========================================================================== */

const SVG_NS = "http://www.w3.org/2000/svg";

/** Lienzo de referencia: 564×410, las mismas proporciones que el original. */
const LIENZO = { ancho: 564, alto: 410 };

/** Caja del núcleo (el chip) y radio de las cajas de herramientas. */
const NUCLEO = { x: 238, y: 161, lado: 88 };
const CAJA = 44;

/**
 * Las seis piezas que muestra el diagrama. `ruta` va del nodo hacia el centro
 * (así el pulso viaja hacia el chip) y las coordenadas están en el espacio del
 * lienzo: dos columnas a x=96 y x=468, tres filas a y=62, 205 y 348.
 */
const HERRAMIENTAS = [
  {
    id: "cc1plus",
    glifo: "C++",
    etiqueta: "cc1plus · C++ → ASM",
    x: 96,
    y: 62,
    ruta: "M 118 62 H 242 Q 282 62 282 102 V 161",
    demora: 0.05,
  },
  {
    id: "avr-as",
    glifo: "as",
    etiqueta: "avr-as",
    x: 96,
    y: 205,
    ruta: "M 118 205 H 238",
    demora: 0.18,
  },
  {
    id: "avr-ld",
    glifo: "ld",
    etiqueta: "avr-ld · libc",
    x: 96,
    y: 348,
    ruta: "M 118 348 H 242 Q 282 348 282 308 V 249",
    demora: 0.31,
  },
  {
    id: "objcopy",
    glifo: "HEX",
    etiqueta: "avr-objcopy · Intel HEX",
    x: 468,
    y: 62,
    ruta: "M 446 62 H 322 Q 282 62 282 102 V 161",
    demora: 0.44,
  },
  {
    id: "agente",
    glifo: "cli",
    etiqueta: "agente local · arduino-cli",
    x: 468,
    y: 205,
    ruta: "M 446 205 H 326",
    demora: 0.57,
  },
  {
    id: "usb",
    glifo: "USB",
    etiqueta: "micronucleus · WebUSB",
    x: 468,
    y: 348,
    ruta: "M 446 348 H 322 Q 282 348 282 308 V 249",
    demora: 0.7,
  },
];

/** Atajo para crear un nodo SVG con sus atributos. */
function crear(nombre, atributos = {}) {
  const elemento = document.createElementNS(SVG_NS, nombre);
  for (const [clave, valor] of Object.entries(atributos)) elemento.setAttribute(clave, String(valor));
  return elemento;
}

/** Una caja con su glifo y su etiqueta debajo. */
function cajaHerramienta(herramienta) {
  const grupo = crear("g", { class: "hub__nodo", style: `--demora: ${herramienta.demora}s` });

  grupo.append(
    crear("rect", {
      class: "hub__caja",
      x: herramienta.x - CAJA / 2,
      y: herramienta.y - CAJA / 2,
      width: CAJA,
      height: CAJA,
      rx: 12,
    }),
  );

  const glifo = crear("text", {
    class: "hub__glifo",
    x: herramienta.x,
    y: herramienta.y + 4,
    "text-anchor": "middle",
  });
  glifo.textContent = herramienta.glifo;

  const etiqueta = crear("text", {
    class: "hub__etiqueta",
    x: herramienta.x,
    y: herramienta.y + 37,
    "text-anchor": "middle",
  });
  etiqueta.textContent = herramienta.etiqueta;

  grupo.append(glifo, etiqueta);
  return grupo;
}

/** El chip del centro: caja, anillo que late, cuerpo con patas y su nombre. */
function nucleoDelChip() {
  const grupo = crear("g", { class: "hub__nucleo" });

  grupo.append(
    crear("rect", {
      class: "hub__pulso",
      x: NUCLEO.x,
      y: NUCLEO.y,
      width: NUCLEO.lado,
      height: NUCLEO.lado,
      rx: 18,
    }),
    crear("rect", {
      class: "hub__caja hub__caja--nucleo",
      x: NUCLEO.x,
      y: NUCLEO.y,
      width: NUCLEO.lado,
      height: NUCLEO.lado,
      rx: 18,
    }),
  );

  const centro = { x: NUCLEO.x + NUCLEO.lado / 2, y: NUCLEO.y + NUCLEO.lado / 2 };
  const chip = crear("g", { class: "hub__chip", transform: `translate(${centro.x} ${centro.y - 17})` });
  chip.append(crear("rect", { x: -15, y: -11, width: 30, height: 22, rx: 3 }));
  for (const dy of [-6, 0, 6]) {
    chip.append(
      crear("line", { x1: -15, y1: dy, x2: -21, y2: dy }),
      crear("line", { x1: 15, y1: dy, x2: 21, y2: dy }),
    );
  }
  // Muesca del pin 1: orienta el dibujo como el encapsulado real.
  chip.append(crear("circle", { cx: -9, cy: -6, r: 1.8 }));

  const titulo = crear("text", { class: "hub__titulo", x: centro.x, y: centro.y + 40, "text-anchor": "middle" });
  titulo.textContent = "ATtiny85";

  grupo.append(chip, titulo);
  return grupo;
}

/** Arma el SVG completo y ajusta el ciclo de cada pulso a su camino real. */
function construirDiagrama() {
  const svg = crear("svg", {
    class: "hub__lienzo",
    viewBox: `0 0 ${LIENZO.ancho} ${LIENZO.alto}`,
    role: "img",
    "aria-label":
      "Las etapas del compilador (cc1plus, avr-as, avr-ld, avr-objcopy), el agente local y la grabación WebUSB convergen en el ATtiny85.",
  });

  const vias = crear("g", { class: "hub__vias" });
  const nodos = crear("g", { class: "hub__nodos" });

  for (const herramienta of HERRAMIENTAS) {
    vias.append(
      crear("path", { class: "hub__via", d: herramienta.ruta }),
      crear("path", {
        class: "hub__flujo",
        d: herramienta.ruta,
        style: `--demora: ${herramienta.demora}s`,
      }),
    );
    nodos.append(cajaHerramienta(herramienta));
  }

  svg.append(vias, nucleoDelChip(), nodos);

  // El guion del pulso mide siempre lo mismo, pero el hueco se ajusta al largo
  // del camino: así el ciclo no deja huecos muertos en los tramos cortos.
  for (const flujo of svg.querySelectorAll(".hub__flujo")) {
    const largo = Math.round(flujo.getTotalLength());
    flujo.style.setProperty("--largo", `${largo}px`);
    flujo.style.strokeDasharray = `34px ${largo}px`;
  }

  return svg;
}

function menosMovimiento() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Monta el diagrama dentro de `contenedor`. Devuelve `null` si el navegador no
 * permite construir SVG (nunca debería) y el contenedor queda vacío: la tarjeta
 * sigue explicando lo mismo con su texto.
 */
export function iniciarHub(contenedor) {
  try {
    const svg = construirDiagrama();
    contenedor.replaceChildren(svg);

    if (!menosMovimiento()) {
      // Ambas clases se agregan en la misma tarea, antes del primer pintado:
      // no hay parpadeo y el estado inicial no depende de que el JS corra.
      contenedor.classList.add("hub--animado");
      if (typeof IntersectionObserver === "function") {
        const observador = new IntersectionObserver(
          (entradas) => {
            if (!entradas.some((entrada) => entrada.isIntersecting)) return;
            contenedor.classList.add("hub--dentro");
            observador.disconnect();
          },
          { threshold: 0.15 },
        );
        observador.observe(contenedor);
      } else {
        contenedor.classList.add("hub--dentro");
      }
    }

    return { nodos: HERRAMIENTAS.length, reducido: menosMovimiento() };
  } catch {
    return null;
  }
}

/** Arranque: un diagrama por cada `[data-toolchain-hub]` de la página. */
function arrancar() {
  for (const contenedor of document.querySelectorAll("[data-toolchain-hub]")) iniciarHub(contenedor);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", arrancar, { once: true });
else arrancar();

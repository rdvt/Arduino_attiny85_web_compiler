/* ============================================================================
 *  ATtiny85 en 3D para el hero de la portada
 *
 *  Cumple las reglas de `design.md` §7:
 *   - three.js **vendorizado** en `vendor/three/` y cargado en diferido.
 *   - Sólo se activa si el navegador soporta WebGL2; si algo falla, NO se
 *     registra ningún error y queda la silueta SVG que ya está en el HTML.
 *   - Un único `<canvas>`, dentro de un contenedor con `aspect-ratio` fijo
 *     (no hay saltos de layout).
 *   - Sin OrbitControls, sin posprocesado, sin sombras dinámicas ni texturas
 *     remotas: sólo geometría procedural y tres luces.
 *   - Se pausa cuando sale de pantalla (`IntersectionObserver`) y cuando la
 *     pestaña se oculta (`visibilitychange`).
 *   - Con `prefers-reduced-motion: reduce` se dibuja un solo cuadro.
 *   - `dispose()` de geometrías, materiales y renderer al desmontar.
 *   - El canvas es decorativo: `aria-hidden` y `role="presentation"`.
 * ========================================================================== */

const COLOR_CUERPO = 0x1b1b1f;
const COLOR_PIN = 0xc8ccd4;
const COLOR_ACENTO = 0x2ba6ff; // --brand de theme.css

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** ¿El navegador puede crear un contexto WebGL2? */
function soportaWebGL2() {
  if (typeof WebGL2RenderingContext === "undefined") return false;
  try {
    const prueba = document.createElement("canvas");
    const contexto = prueba.getContext("webgl2");
    if (!contexto) return false;
    contexto.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Respeta la preferencia de menos movimiento del sistema. */
function menosMovimiento() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Construye el chip: cuerpo DIP-8, ocho patas, marcador de pin 1 y aristas. */
function construirChip(THREE) {
  const chip = new THREE.Group();

  const cajaCuerpo = new THREE.BoxGeometry(1, 0.32, 0.66);
  const materialCuerpo = new THREE.MeshStandardMaterial({
    color: COLOR_CUERPO,
    roughness: 0.55,
    metalness: 0.25,
  });
  chip.add(new THREE.Mesh(cajaCuerpo, materialCuerpo));

  // Aristas marcadas en azul: la lectura «wireframe» que pide design.md.
  chip.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(cajaCuerpo),
      new THREE.LineBasicMaterial({ color: COLOR_ACENTO, transparent: true, opacity: 0.55 }),
    ),
  );

  // Patas: cuatro por lado, saliendo por ±Z (el cuerpo es largo en X).
  const cajaPin = new THREE.BoxGeometry(0.07, 0.05, 0.3);
  const materialPin = new THREE.MeshStandardMaterial({
    color: COLOR_PIN,
    roughness: 0.35,
    metalness: 0.85,
  });
  const separacion = 0.2;
  for (let i = 0; i < 4; i++) {
    const x = (i - 1.5) * separacion;
    for (const signo of [1, -1]) {
      const pin = new THREE.Mesh(cajaPin, materialPin);
      pin.position.set(x, -0.09, signo * 0.44);
      chip.add(pin);
    }
  }

  // Marcador de pin 1, en la esquina del lado izquierdo.
  const marca = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.055, 0.02, 20),
    new THREE.MeshStandardMaterial({ color: COLOR_ACENTO, roughness: 0.4, metalness: 0.2 }),
  );
  marca.position.set(-0.36, 0.17, -0.21);
  chip.add(marca);

  chip.rotation.set(-0.16, 0.6, 0);
  return chip;
}

/** Luces: una ambiente, una clave blanca y un contraluz azul que da el borde. */
function construirLuces(THREE, escena) {
  escena.add(new THREE.AmbientLight(0xffffff, 0.45));

  const clave = new THREE.DirectionalLight(0xffffff, 2.1);
  clave.position.set(2.6, 3.2, 2.4);
  escena.add(clave);

  const contraluz = new THREE.DirectionalLight(COLOR_ACENTO, 2.6);
  contraluz.position.set(-2.8, 1, -2.2);
  escena.add(contraluz);
}

/**
 * Monta la escena en `contenedor`. Devuelve un objeto para desmontarla, o null
 * si no se puede (sin WebGL2, sin three.js, o cualquier fallo inesperado).
 */
export async function iniciarHero3D(contenedor) {
  if (!contenedor) return null;

  const desmontar = () => {
    contenedor.replaceChildren();
    delete contenedor.dataset.estado;
  };

  if (!soportaWebGL2()) return null;

  let THREE;
  try {
    // Carga diferida: el archivo sólo se pide cuando de verdad se va a usar.
    THREE = await import("./vendor/three/three.module.js");
  } catch {
    return null; // sin ruido en consola: se conserva la silueta estática
  }

  try {
    const escena = new THREE.Scene();
    const camara = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    camara.position.set(2.3, 1.8, 3);
    camara.lookAt(0, 0.02, 0);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true, // el resplandor del hero se ve a través del canvas
      powerPreference: "low-power",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearAlpha(0);

    const canvas = renderer.domElement;
    canvas.setAttribute("aria-hidden", "true");
    canvas.setAttribute("role", "presentation");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    contenedor.replaceChildren(canvas);

    const chip = construirChip(THREE);
    escena.add(chip);
    construirLuces(THREE, escena);

    const ajustarTamano = () => {
      const ancho = contenedor.clientWidth;
      const alto = contenedor.clientHeight;
      if (!ancho || !alto) return;
      renderer.setSize(ancho, alto, false);
      camara.aspect = ancho / alto;
      camara.updateProjectionMatrix();
    };
    ajustarTamano();

    const observadorTamano = new ResizeObserver(ajustarTamano);
    observadorTamano.observe(contenedor);

    /* --- Animación con pausas: nada de rAF en segundo plano ------------- */

    const inmóvil = menosMovimiento();
    const inicio = performance.now();
    let cuadro = 0;
    let visible = true;
    let dibujando = false;

    const pintar = (ahora) => {
      const t = (ahora - inicio) / 1000;
      if (!inmóvil) {
        chip.rotation.y = 0.6 + t * 0.22;
        chip.rotation.x = -0.16 + Math.sin(t * 0.55) * 0.03;
        chip.position.y = Math.sin(t * 0.9) * 0.03;
      }
      renderer.render(escena, camara);
    };

    const bucle = (ahora) => {
      if (!visible) {
        dibujando = false;
        return;
      }
      pintar(ahora);
      cuadro = requestAnimationFrame(bucle);
    };

    const arrancar = () => {
      if (dibujando || inmóvil || !visible) return;
      dibujando = true;
      cuadro = requestAnimationFrame(bucle);
    };
    const parar = () => {
      cancelAnimationFrame(cuadro);
      dibujando = false;
    };

    const observadorVisibilidad = new IntersectionObserver(
      (entradas) => {
        visible = entradas.some((e) => e.isIntersecting);
        if (visible) {
          ajustarTamano();
          arrancar();
        } else {
          parar();
        }
      },
      { threshold: 0 },
    );
    observadorVisibilidad.observe(contenedor);

    const alCambiarVisibilidad = () => {
      if (document.hidden) parar();
      else if (visible) arrancar();
    };
    document.addEventListener("visibilitychange", alCambiarVisibilidad);

    if (inmóvil) pintar(performance.now());
    else arrancar();

    const desmontarEscena = () => {
      parar();
      document.removeEventListener("visibilitychange", alCambiarVisibilidad);
      observadorVisibilidad.disconnect();
      observadorTamano.disconnect();
      escena.traverse((objeto) => {
        objeto.geometry?.dispose?.();
        const materiales = Array.isArray(objeto.material) ? objeto.material : [objeto.material];
        for (const material of materiales) material?.dispose?.();
      });
      renderer.dispose();
      renderer.forceContextLoss?.();
      desmontar();
    };

    // La página puede irse en cualquier momento: no dejar el contexto colgado.
    window.addEventListener("pagehide", desmontarEscena, { once: true });

    return { desmontar: desmontarEscena, esMovil: inmóvil ? "reducido" : "animado" };
  } catch {
    desmontar();
    return null;
  }
}

/**
 * Arranque: espera al primer pintado y al ocio del hilo principal, y sólo
 * entonces monta la escena. Cualquier fallo es silencioso.
 */
function arrancarCuandoHayaHueco() {
  const contenedor = document.querySelector("[data-hero-3d]");
  if (!contenedor) return;

  const enIdle =
    typeof requestIdleCallback === "function"
      ? (fn) => requestIdleCallback(fn, { timeout: 1200 })
      : (fn) => setTimeout(fn, 200);

  const tras = () => {
    // Con movimiento reducido igual se monta la escena: sólo se dibuja un
    // cuadro estático (lo decide `iniciarHero3D`), y así el chip se ve.
    enIdle(async () => {
      const resultado = await iniciarHero3D(contenedor);
      if (resultado) contenedor.dataset.estado = "listo";
    });
  };

  if (document.readyState === "complete") tras();
  else window.addEventListener("load", tras, { once: true });
}

arrancarCuandoHayaHueco();

export default { iniciarHero3D };

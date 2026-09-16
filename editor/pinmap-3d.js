/* ============================================================================
 *  Mapa de pines 3D de la Digispark para la barra lateral del editor.
 *
 *  Sigue las mismas reglas que `hero-3d.js` (design.md §7):
 *   - three.js vendorizado, carga diferida sólo si hay WebGL2.
 *   - Sin OrbitControls ni texturas remotas: geometría procedural + 3 luces.
 *   - Se pausa fuera de pantalla y con la pestaña oculta.
 *   - Con `prefers-reduced-motion: reduce` se dibuja un solo cuadro.
 *   - `dispose()` completo de geometrías, materiales y renderer.
 *   - Pines clicables: hover resalta la pata y un clic fija un tooltip con
 *     el detalle completo del pin (posición proyectada del modelo 3D).
 *   - Si algo falla, la leyenda estática del HTML queda como respaldo.
 * ========================================================================== */

const COLOR_CUERPO = 0x111114;
const COLOR_PIN_LIBRE = 0x22c55e; // --ok de theme.css
const COLOR_PIN_USB = 0xef4444; // --danger de theme.css
const COLOR_PIN_RESET = 0xf79009; // --warn de theme.css
const COLOR_ETIQUETA = 0xffffff;
const COLOR_ACENTO = 0x2ba6ff; // --brand de theme.css

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

/**
 * Metadatos de los seis pines de la Digispark. Posiciones en el espacio del
 * modelo: la placa mide 1.86 de largo (X) por 0.86 de ancho (Z), con los
 * pines alineados en el borde -Z, como en la placa física real.
 */
export const PINES = [
  {
    n: 0,
    estado: "libre",
    x: -0.75,
    rol: "libre · PWM",
    detalle:
      "PWM por hardware (OC0A), SDA de I²C, MOSI/DI de SPI y AREF. Es el pin más cómodo para LEDs, señales o sensores.",
  },
  {
    n: 1,
    estado: "libre",
    x: -0.45,
    rol: "libre · PWM",
    detalle:
      "PWM por hardware (OC0B), DO de SPI y AIN1. En las Digispark originales aquí va el LED de la placa: si lo reutilizas, el LED deja de responder.",
  },
  {
    n: 2,
    estado: "libre",
    x: -0.15,
    rol: "libre · digital/analógico",
    detalle:
      "SCK de SPI, SCL de I²C, ADC1 e INT0. Digital y analógico, pero sin PWM por hardware: para atenuar un LED usa P0 o P1.",
  },
  {
    n: 3,
    estado: "usb",
    x: 0.15,
    rol: "USB D+",
    detalle:
      "V-USB lo usa como línea D+ del USB por software (también es ADC3 y XTAL1). Cualquier circuito externo en este pin corta la comunicación USB: no lo uses.",
  },
  {
    n: 4,
    estado: "usb",
    x: 0.45,
    rol: "USB D−",
    detalle:
      "V-USB lo usa como línea D− del USB por software (también es ADC2, XTAL2 y PWM). Igual que P3: hay que dejarlo libre para el USB.",
  },
  {
    n: 5,
    estado: "reset",
    x: 0.75,
    rol: "RESET",
    detalle:
      "Es RESET (y ADC0). Usarlo como GPIO exige grabar el fusible RSTDISBL y entonces el bootloader micronucleus se pierde: la placa deja de ser grabable por USB. Usá P0, P1 o P2.",
  },
];

/** Colores por estado: libre / USB / reset. */
const COLOR_ESTADO = {
  libre: COLOR_PIN_LIBRE,
  usb: COLOR_PIN_USB,
  reset: COLOR_PIN_RESET,
};

/** Textura de canvas para las etiquetas P0…P5 (sin fuentes remotas). */
function texturaEtiqueta(THREE, texto) {
  const lienzo = document.createElement("canvas");
  lienzo.width = 128;
  lienzo.height = 64;
  const ctx = lienzo.getContext("2d");
  ctx.clearRect(0, 0, lienzo.width, lienzo.height);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 44px ui-monospace, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(texto, 64, 34);
  const textura = new THREE.CanvasTexture(lienzo);
  textura.anisotropy = 4;
  return textura;
}

/** Construye la placa: PCB, conector USB, pastilla y los seis pines con etiqueta. */
function construirPlaca(THREE) {
  const placa = new THREE.Group();

  /* --- PCB ------------------------------------------------------------- */
  const pcbGeom = new THREE.BoxGeometry(1.86, 0.08, 0.86);
  const pcbMat = new THREE.MeshStandardMaterial({ color: 0x0b3b2e, roughness: 0.6, metalness: 0.15 });
  const pcb = new THREE.Mesh(pcbGeom, pcbMat);
  placa.add(pcb);
  placa.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(pcbGeom),
      new THREE.LineBasicMaterial({ color: COLOR_ACENTO, transparent: true, opacity: 0.35 }),
    ),
  );

  /* --- Conector USB (las dos patas metálicas del enchufe) -------------- */
  const usbGeom = new THREE.BoxGeometry(0.55, 0.18, 0.8);
  const usbMat = new THREE.MeshStandardMaterial({ color: 0xc8ccd4, roughness: 0.35, metalness: 0.85 });
  const usb = new THREE.Mesh(usbGeom, usbMat);
  usb.position.set(0.62, 0.12, 0);
  placa.add(usb);

  /* --- Pastilla ATtiny85 ------------------------------------------------ */
  const chipGeom = new THREE.BoxGeometry(0.5, 0.1, 0.5);
  const chipMat = new THREE.MeshStandardMaterial({ color: COLOR_CUERPO, roughness: 0.55, metalness: 0.25 });
  const chip = new THREE.Mesh(chipGeom, chipMat);
  chip.position.set(-0.25, 0.09, 0.05);
  placa.add(chip);
  placa.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(chipGeom),
      new THREE.LineBasicMaterial({ color: COLOR_ACENTO, transparent: true, opacity: 0.5 }),
    ),
  );

  /* --- Pines P0…P5: cabeza cónica + etiqueta flotante ------------------- */
  const geometrias = { cabeza: new THREE.ConeGeometry(0.055, 0.16, 16), base: new THREE.CylinderGeometry(0.022, 0.022, 0.1, 12) };
  for (const pin of PINES) {
    const { n, estado, x } = pin;
    const color = COLOR_ESTADO[estado];
    const grupo = new THREE.Group();

    const base = new THREE.Mesh(geometrias.base, new THREE.MeshStandardMaterial({ color: 0xc8ccd4, roughness: 0.4, metalness: 0.8 }));
    base.position.set(x, 0.02, -0.36);
    grupo.add(base);

    // El emissive arranca en 0: sube la intensidad al hacer hover/clic.
    const cabeza = new THREE.Mesh(
      geometrias.cabeza,
      new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.2, emissive: color, emissiveIntensity: 0 }),
    );
    cabeza.position.set(x, 0.14, -0.36);
    grupo.add(cabeza);

    const textura = texturaEtiqueta(THREE, `P${n}`);
    const etiqueta = new THREE.Mesh(
      new THREE.PlaneGeometry(0.22, 0.11),
      new THREE.MeshBasicMaterial({ map: textura, transparent: true }),
    );
    etiqueta.position.set(x, 0.34, -0.36);
    etiqueta.rotation.x = -Math.PI / 2.6; // tumbada sobre la placa, mirando a cámara
    grupo.add(etiqueta);

    grupo.userData = { pin, cabeza, textura };
    cabeza.userData.pin = pin; // el raycast golpea la malla: subimos al grupo
    placa.add(grupo);
  }

  placa.userData.geometrias = geometrias;
  return placa;
}

/** Luces: ambiente, clave blanca y contraluz azul (igual que el hero). */
function construirLuces(THREE, escena) {
  escena.add(new THREE.AmbientLight(0xffffff, 0.5));
  const clave = new THREE.DirectionalLight(0xffffff, 2.0);
  clave.position.set(2.2, 3.0, 2.6);
  escena.add(clave);
  const contraluz = new THREE.DirectionalLight(COLOR_ACENTO, 2.2);
  contraluz.position.set(-2.4, 1, -2);
  escena.add(contraluz);
}

/**
 * Monta el mapa 3D en `contenedor`. Devuelve { desmontar } o null si no se
 * puede (sin WebGL2, sin three.js o cualquier fallo); en ese caso el HTML
 * deja la leyenda estática como respaldo.
 */
export async function iniciarPinmap3D(contenedor) {
  if (!contenedor) return null;

  const desmontar = () => {
    contenedor.replaceChildren();
    delete contenedor.dataset.estado;
    delete contenedor.dataset.pin;
  };

  if (!soportaWebGL2()) return null;

  let THREE;
  try {
    THREE = await import("../vendor/three/three.module.js");
  } catch {
    return null; // sin ruido en consola: queda la leyenda estática
  }

  try {
    const escena = new THREE.Scene();
    const camara = new THREE.PerspectiveCamera(35, 16 / 9, 0.1, 50);
    camara.position.set(0, 2.1, 2.3);
    camara.lookAt(0, 0.05, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearAlpha(0);

    const canvas = renderer.domElement;
    canvas.setAttribute("aria-hidden", "true");
    canvas.setAttribute("role", "presentation");
    contenedor.appendChild(canvas);
    // El tooltip se maneja también con teclado: el contenedor es enfocable.
    contenedor.tabIndex = 0;

    /* Tooltip anclado al pin: vive dentro del contenedor, por encima del canvas. */
    const tooltip = document.createElement("div");
    tooltip.className = "tooltip";
    tooltip.hidden = true;
    tooltip.setAttribute("role", "status");
    const tituloTooltip = document.createElement("strong");
    const detalleTooltip = document.createElement("span");
    tooltip.append(tituloTooltip, detalleTooltip);
    contenedor.appendChild(tooltip);

    const placa = construirPlaca(THREE);
    escena.add(placa);
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

    /* --- Animación suave, con pausas fuera de pantalla ------------------- */
    const inmóvil = menosMovimiento();
    const inicio = performance.now();
    let cuadro = 0;
    let visible = true;
    let dibujando = false;

    const pintar = (ahora) => {
      const t = (ahora - inicio) / 1000;
      if (!inmóvil) {
        placa.rotation.y = Math.sin(t * 0.35) * 0.35; // oscilación suave
        placa.position.y = Math.sin(t * 0.8) * 0.02;
      }
      renderer.render(escena, camara);
      if (pinFijado) posicionarTooltip(); // el tooltip sigue a la placa
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

    /* --- Pines interactivos: hover + clic con tooltip anclado ------------- */

    const cabezaPines = [];
    placa.traverse((objeto) => {
      if (objeto.userData?.pin) cabezaPines.push(objeto);
    });
    const raycaster = new THREE.Raycaster();
    const puntero = new THREE.Vector2();

    let pinEnHover = null;
    let pinFijado = null; // pin del tooltip fijado por clic

    const ajustarBrillo = () => {
      for (const cabeza of cabezaPines) {
        const activo = cabeza === pinEnHover || cabeza === pinFijado;
        cabeza.material.emissiveIntensity = activo ? 0.55 : 0;
      }
    };

    const setPinEnHover = (cabeza) => {
      if (pinEnHover === cabeza) return;
      pinEnHover = cabeza;
      ajustarBrillo();
    };

    /** Ancla el tooltip al punto 3D de la cabeza del pin, proyectado a píxeles. */
    const posicionarTooltip = () => {
      if (!pinFijado) return;
      const punto = pinFijado.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.08, 0));
      const pantalla = punto.project(camara);
      const ancho = contenedor.clientWidth;
      const alto = contenedor.clientHeight;
      tooltip.style.left = `${((pantalla.x + 1) / 2) * ancho}px`;
      tooltip.style.top = `${((1 - pantalla.y) / 2) * alto}px`;
    };

    const mostrarTooltip = (pin) => {
      tooltip.querySelector("strong").textContent = `P${pin.n} · ${pin.rol}`;
      tooltip.querySelector("span").textContent = pin.detalle;
      tooltip.hidden = false;
      contenedor.dataset.pin = String(pin.n);
    };

    const ocultarTooltip = () => {
      tooltip.hidden = true;
      pinFijado = null;
      ajustarBrillo();
    };

    /** Pinta el canvas en el próximo cuadro (para refrescar el anclaje). */
    const repintarPronto = () => {
      if (inmóvil) pintar(performance.now());
      else if (!dibujando && visible) arrancar();
    };

    const alMoverPuntero = (evento) => {
      const rect = contenedor.getBoundingClientRect();
      puntero.x = ((evento.clientX - rect.left) / rect.width) * 2 - 1;
      puntero.y = -((evento.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(puntero, camara);
      const golpe = raycaster.intersectObjects(cabezaPines, false)[0];
      const cabeza = golpe?.object ?? null;
      setPinEnHover(cabeza);
      contenedor.style.cursor = cabeza ? "pointer" : "";
    };

    const alClic = (evento) => {
      const rect = contenedor.getBoundingClientRect();
      puntero.x = ((evento.clientX - rect.left) / rect.width) * 2 - 1;
      puntero.y = -((evento.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(puntero, camara);
      const golpe = raycaster.intersectObjects(cabezaPines, false)[0];
      const cabeza = golpe?.object ?? null;

      if (!cabeza) {
        ocultarTooltip(); // clic en el vacío: cierra el tooltip
        return;
      }
      if (pinFijado === cabeza) {
        ocultarTooltip(); // segundo clic en el mismo pin: lo suelta
        return;
      }
      pinFijado = cabeza;
      mostrarTooltip(cabeza.userData.pin);
      ajustarBrillo();
      posicionarTooltip();
      repintarPronto();
    };

    /* Tooltip accesible desde teclado: la tarjeta es un botón que cicla P0…P5. */
    const alTeclado = (evento) => {
      if (evento.key !== "Enter" && evento.key !== " " && !evento.key.startsWith("Arrow")) return;
      evento.preventDefault();
      if (!cabezaPines.length) return;
      const indiceActual = pinFijado ? cabezaPines.indexOf(pinFijado) : -1;
      const delta = evento.key === "ArrowLeft" ? -1 : 1;
      const siguiente = cabezaPines[(indiceActual + delta + cabezaPines.length) % cabezaPines.length];
      pinFijado = siguiente;
      mostrarTooltip(siguiente.userData.pin);
      ajustarBrillo();
      posicionarTooltip();
      repintarPronto();
    };

    const alSalirPuntero = () => setPinEnHover(null);
    contenedor.addEventListener("pointermove", alMoverPuntero);
    contenedor.addEventListener("pointerdown", alClic);
    contenedor.addEventListener("pointerleave", alSalirPuntero);
    contenedor.addEventListener("keydown", alTeclado);
    contenedor.addEventListener("blur", ocultarTooltip);

    const desmontarEscena = () => {
      parar();
      contenedor.removeEventListener("pointermove", alMoverPuntero);
      contenedor.removeEventListener("pointerdown", alClic);
      contenedor.removeEventListener("pointerleave", alSalirPuntero);
      contenedor.removeEventListener("keydown", alTeclado);
      contenedor.removeEventListener("blur", ocultarTooltip);
      document.removeEventListener("visibilitychange", alCambiarVisibilidad);
      observadorVisibilidad.disconnect();
      observadorTamano.disconnect();
      escena.traverse((objeto) => {
        objeto.geometry?.dispose?.();
        const materiales = Array.isArray(objeto.material) ? objeto.material : [objeto.material];
        for (const material of materiales) {
          material.map?.dispose?.(); // texturas de etiquetas
          material?.dispose?.();
        }
      });
      renderer.dispose();
      renderer.forceContextLoss?.();
      desmontar();
    };
    window.addEventListener("pagehide", desmontarEscena, { once: true });

    return { desmontar: desmontarEscena, modo: inmóvil ? "reducido" : "animado" };
  } catch {
    desmontar();
    return null;
  }
}

export default { iniciarPinmap3D };

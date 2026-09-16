/* ============================================================================
 *  Configuración del sketch de mouse (DigiMouse)
 *
 *  Este módulo es opcional para el editor: si el código que abriste no es el
 *  sketch del mouse, `detectConfig()` no encuentra nada y el panel no aparece.
 *  Cuando sí lo es, permite editar los #define con validación de rangos,
 *  escribir los valores de vuelta en el fuente y previsualizar el recorrido.
 * ========================================================================== */

export const PRESET_VERSION = 1;

/**
 * Cada parámetro con su rango real. Los comentarios son los que importan:
 * salen de las reglas de DigiMouse documentadas en el README del proyecto.
 */
export const MOUSE_DEFINES = [
  {
    name: "PASO_PX",
    label: "Píxeles por paso",
    min: 1,
    max: 127,
    unit: "px",
    help: "Los deltas de HID son enteros con signo: el máximo por reporte es 127.",
  },
  {
    name: "PASOS_POR_LADO",
    label: "Pasos por lado del cuadro",
    min: 1,
    max: 200,
    unit: "pasos",
    help: "Cuántos pasos hace en cada lado del recorrido cuadrado.",
  },
  {
    name: "INTERVALO_MS",
    label: "Intervalo entre pasos",
    min: 20,
    max: 2000,
    unit: "ms",
    help: "Piso de 20 ms: el reporte HID no puede ir más rápido, y si bajás perdés pasos.",
  },
  {
    name: "DESCANSO_MS",
    label: "Pausa entre ciclos",
    min: 0,
    max: 600000,
    unit: "ms",
    help: "Cuánto espera antes de volver a recorrer el cuadro.",
  },
  {
    name: "ARRANQUE_MS",
    label: "Espera inicial",
    min: 0,
    max: 60000,
    unit: "ms",
    help: "Margen para que el sistema operativo detecte el mouse al conectarlo.",
  },
  {
    name: "HACER_CLICK",
    label: "Click por ciclo",
    min: 0,
    max: 1,
    options: [
      { value: 0, label: "No" },
      { value: 1, label: "Clic izquierdo" },
    ],
    help: "Hace clic donde esté el cursor al cerrar el cuadro.",
  },
  {
    name: "USAR_RUEDA",
    label: "Rueda por ciclo",
    min: 0,
    max: 1,
    options: [
      { value: 0, label: "No" },
      { value: 1, label: "Sí (2 arriba, 2 abajo)" },
    ],
    help: "Mueve la rueda y la devuelve, para no dejar scroll acumulado.",
  },
];

const DEFINE_LINE = (name) => new RegExp(`^(\\s*#\\s*define\\s+${name}\\s+)([^\\s/]+)(.*)$`, "m");

/* -------------------------------------------------------------------------- */
/* Detección y edición                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Busca los #define del mouse en el fuente.
 * @param {string} source
 */
export function detectConfig(source) {
  const text = String(source ?? "");
  const isMouse = /#\s*include\s*[<"]DigiMouse\.h[>"]/.test(text) || /\bDigiMouse\s*\./.test(text);

  const values = {};
  const missing = [];
  const lines = {};

  for (const define of MOUSE_DEFINES) {
    const match = DEFINE_LINE(define.name).exec(text);
    if (!match) {
      missing.push(define.name);
      continue;
    }
    const raw = match[2];
    const number = Number.parseInt(raw, 10);
    values[define.name] = Number.isFinite(number) ? number : null;
    lines[define.name] = text.slice(0, match.index).split("\n").length;
  }

  const presetCount = Object.keys(values).length;
  return {
    found: isMouse && presetCount >= 2,
    isMouse,
    values,
    missing,
    lines,
  };
}

/**
 * Escribe los valores en el fuente, respetando indentación y comentarios.
 * Sólo toca los defines que ya existen: no inventa parámetros.
 *
 * @returns {{source: string, changed: string[], skipped: string[]}}
 */
export function applyConfig(source, values) {
  let text = String(source ?? "");
  const changed = [];
  const skipped = [];

  for (const define of MOUSE_DEFINES) {
    const value = values[define.name];
    if (value === undefined || value === null) continue;

    const pattern = DEFINE_LINE(define.name);
    if (!pattern.test(text)) {
      skipped.push(define.name);
      continue;
    }
    text = text.replace(pattern, (_full, head, _old, tail) => {
      changed.push(define.name);
      return `${head}${value}${tail}`;
    });
  }

  return { source: text, changed, skipped };
}

/* -------------------------------------------------------------------------- */
/* Validación                                                                  */
/* -------------------------------------------------------------------------- */

export function validateConfig(values) {
  const findings = [];

  for (const define of MOUSE_DEFINES) {
    const value = values[define.name];
    if (value === undefined || value === null) continue;

    if (!Number.isInteger(value)) {
      findings.push({ level: "error", name: define.name, message: `${define.name} tiene que ser un entero.` });
      continue;
    }
    if (value < define.min || value > define.max) {
      findings.push({
        level: "error",
        name: define.name,
        message: `${define.name} = ${value} está fuera del rango ${define.min}..${define.max} ${define.unit ?? ""}`.trim(),
      });
    }
  }

  const paso = values.PASO_PX;
  const lados = values.PASOS_POR_LADO;
  const intervalo = values.INTERVALO_MS;

  if (Number.isInteger(paso) && Number.isInteger(lados)) {
    const lado = paso * lados;
    if (lado > 600) {
      findings.push({
        level: "warn",
        name: "PASO_PX",
        message: `El cuadro mide ${lado} px de lado: si el cursor empieza pegado a un borde se va a chocar contra el límite de la pantalla.`,
      });
    }
  }

  if (Number.isInteger(intervalo) && Number.isInteger(lados) && 4 * lados * intervalo > 120000) {
    findings.push({
      level: "info",
      name: "INTERVALO_MS",
      message: "Un ciclo del cuadro va a tardar más de dos minutos.",
    });
  }

  if (values.HACER_CLICK === 1) {
    findings.push({
      level: "warn",
      name: "HACER_CLICK",
      message: "El click cae donde esté el cursor al cerrar el cuadro: puede activar algo sin querer.",
    });
  }

  return findings;
}

/* -------------------------------------------------------------------------- */
/* Previsualización                                                            */
/* -------------------------------------------------------------------------- */

/** Datos del ciclo, para mostrar en el panel y dibujar. */
export function cycleStats(values) {
  const paso = values.PASO_PX ?? 0;
  const lados = values.PASOS_POR_LADO ?? 0;
  const intervalo = values.INTERVALO_MS ?? 0;
  const descanso = values.DESCANSO_MS ?? 0;
  const arranque = values.ARRANQUE_MS ?? 0;

  const steps = 4 * lados;
  const activeMs = steps * intervalo;
  const clickMs = values.HACER_CLICK ? 80 + intervalo : 0;
  const wheelMs = values.USAR_RUEDA ? 2 * intervalo : 0;

  return {
    steps,
    sidePx: paso * lados,
    activeMs,
    cycleMs: activeMs + descanso + clickMs + wheelMs,
    totalMs: arranque + activeMs + descanso + clickMs + wheelMs,
    speedPxPerSecond: intervalo > 0 ? Math.round((paso / intervalo) * 1000) : 0,
  };
}

/** Esquinas del recorrido, en píxeles, empezando y terminando en el origen. */
export function pathPoints(values) {
  const side = (values.PASO_PX ?? 0) * (values.PASOS_POR_LADO ?? 0);
  return [
    [0, 0],
    [side, 0],
    [side, side],
    [0, side],
    [0, 0],
  ];
}

/* -------------------------------------------------------------------------- */
/* Presets                                                                     */
/* -------------------------------------------------------------------------- */

export function buildPreset(values, name = "mi preset") {
  return { version: PRESET_VERSION, name, values: { ...values } };
}

/**
 * Valida un preset traído de un JSON y devuelve sus valores, o los errores.
 * Un preset es lo único que se importa de afuera, así que se revisa entero.
 */
export function parsePreset(payload) {
  const data = typeof payload === "string" ? safeJson(payload) : payload;
  if (!data || typeof data !== "object") return { ok: false, errors: ["El preset no es un objeto JSON."] };

  const values = {};
  const errors = [];
  const source = data.values ?? data;

  for (const define of MOUSE_DEFINES) {
    const value = source[define.name];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < define.min || value > define.max) {
      errors.push(`${define.name} = ${JSON.stringify(value)} está fuera del rango ${define.min}..${define.max}.`);
      continue;
    }
    values[define.name] = value;
  }

  if (Object.keys(values).length === 0) errors.push("El preset no trae ningún parámetro conocido.");
  return errors.length ? { ok: false, errors } : { ok: true, values, name: data.name ?? "preset" };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

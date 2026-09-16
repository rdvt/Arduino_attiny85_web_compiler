/* ============================================================================
 *  Cliente del agente local de compilación
 *
 *  El navegador no puede compilar AVR por su cuenta (ver README), así que el
 *  editor le pide el .hex a `tools/compile-agent.py`, que corre en la misma
 *  máquina. La página puede estar en localhost o en GitHub Pages: Chrome permite
 *  que una página HTTPS llame a http://127.0.0.1 porque lo considera un origen
 *  confiable.
 *
 *  Todos los errores salen ya traducidos a algo que se puede hacer.
 * ========================================================================== */

// `localhost` es más compatible que la dirección numérica cuando una página HTTPS
// intenta contactar al agente local (especialmente en Safari y con Private Network
// Access). El servidor escucha en 127.0.0.1, por lo que ambas URLs llegan al mismo proceso.
export const DEFAULT_AGENT_URL = "http://localhost:8765";
export const AGENT_COMMAND = "python3 tools/compile-agent.py";

/** Usa localhost:8765 por defecto; el parámetro sólo sirve para puertos alternativos. */
export function agentUrlFromLocation(location = globalThis.location) {
  if (!location || !location.search) return DEFAULT_AGENT_URL;
  const param = new URLSearchParams(location.search).get("agent");
  if (!param) return DEFAULT_AGENT_URL;
  try {
    return new URL(param).origin;
  } catch {
    return DEFAULT_AGENT_URL;
  }
}

/**
 * ¿Tiene sentido sondear el agente local?
 *
 * El agente es una herramienta de desarrollo. En el sitio publicado no se debe
 * intentar contactar 127.0.0.1: además de no existir, ensucia la consola del
 * navegador con errores de red. Solo se sondea en localhost o si se pide
 * explícitamente con `?agent=http://127.0.0.1:8765`.
 */
export function agenteHabilitado(location = globalThis.location) {
  if (!location) return false;
  if (location.search && new URLSearchParams(location.search).has("agent")) return true;
  const host = location.hostname ?? "";
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export class AgentError extends Error {
  constructor(message, { kind = "generic", status = 0, payload = null } = {}) {
    super(message);
    this.name = "AgentError";
    this.kind = kind;
    this.status = status;
    this.payload = payload;
  }
}

export class CompileAgent {
  constructor(baseUrl = DEFAULT_AGENT_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  get command() {
    return `${AGENT_COMMAND} --port ${new URL(this.baseUrl).port || 8765}`;
  }

  /* ------------------------------- pedidos ------------------------------- */

  async request(path, { method = "GET", body, timeoutMs } = {}) {
    let response;
    try {
      response = await fetch(this.baseUrl + path, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (error) {
      throw new AgentError(
        `No pude hablar con el agente en ${this.baseUrl}. Levantalo con:\n  ${this.command}\n` +
          `(detalle: ${error.message})`,
        { kind: "unreachable" },
      );
    }

    let payload = null;
    const text = await response.text();
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new AgentError(`El agente respondió algo que no es JSON (HTTP ${response.status}).`, {
        kind: "protocol",
        status: response.status,
      });
    }

    if (response.status === 403) {
      throw new AgentError(
        payload?.error ??
          "El agente rechazó este origen. Arrancalo con --allow-origin " + globalThis.location?.origin,
        { kind: "forbidden", status: 403, payload },
      );
    }

    if (!response.ok && response.status !== 422) {
      throw new AgentError(payload?.error ?? `El agente devolvió HTTP ${response.status}.`, {
        kind: "http",
        status: response.status,
        payload,
      });
    }

    return payload;
  }

  /* -------------------------------- API ---------------------------------- */

  /**
   * Estado del agente: arduino-cli, cores instalados y placas ATtiny85.
   *
   * El sondeo inicial lleva un tiempo máximo corto: el agente es opcional, así que
   * la página no debe quedarse esperando si no hay nada escuchando en 127.0.0.1.
   */
  health({ timeoutMs = 1500 } = {}) {
    return this.request("/health", { timeoutMs });
  }

  /** Lista de fuentes del repo que se pueden abrir y guardar. */
  files() {
    return this.request("/files");
  }

  /** Lee un archivo del repo (por ruta relativa). */
  read(path) {
    return this.request(`/sketch?path=${encodeURIComponent(path)}`);
  }

  /**
   * Compila y devuelve { ok, hex, bytes, sizes, log }.
   * Un fallo de compilación NO es una excepción: viene con ok:false y el log.
   */
  compile({ source, name = "Sketch", fqbn, files = [] }) {
    return this.request("/compile", { method: "POST", body: { source, name, fqbn, files } });
  }

  /** Guarda un archivo del repo (el agente deja un .bak antes de escribir). */
  save({ path, source }) {
    return this.request("/save", { method: "POST", body: { path, source } });
  }

  /**
   * Compila y graba en la placa con arduino-cli, sin pasar por WebUSB.
   *
   * El agente se queda esperando a que la placa aparezca en modo bootloader (el
   * CLI de micronucleus espera hasta 60 s), así que el timeout es amplio: hay
   * que desenchufar y enchufar la placa DESPUÉS de llamar a esto.
   */
  flash({ source, name = "Sketch", fqbn, files = [], port = "usb" }) {
    return this.request("/upload", {
      method: "POST",
      body: { source, name, fqbn, files, port },
      timeoutMs: 150000,
    });
  }
}

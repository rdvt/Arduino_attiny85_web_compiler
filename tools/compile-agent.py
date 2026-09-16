#!/usr/bin/env python3
"""Agente local de compilación para el banco de trabajo ATtiny85.

Compila sketches con el mismo arduino-cli que usa ./flash.sh y devuelve el Intel
HEX, para que la página del editor (localhost o GitHub Pages) pueda compilar sin
backend. Escucha SOLO en 127.0.0.1: no se expone a la red.

    python3 tools/compile-agent.py            # http://127.0.0.1:8765
    python3 tools/compile-agent.py --help

Endpoints (JSON):
    GET  /health                 estado de arduino-cli y del core
    GET  /boards                 placas ATtiny85 instaladas (fqbn, F_CPU, límites)
    GET  /files                  fuentes del repo que se pueden abrir/editar
    GET  /sketch?path=<rel>      lee un archivo del repo
    POST /compile {...}          compila y devuelve { ok, hex, bytes, log, ... }
    POST /upload {...}           compila y GRABA en la placa con arduino-cli
    POST /save {...}             guarda un archivo del repo (con backup .bak)

Seguridad: el preprocesador de C++ puede leer archivos del disco vía #include, así
que sólo se atienden pedidos de los orígenes de la lista blanca (--allow-origin).
Por defecto: localhost, 127.0.0.1 y rdvt.github.io.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

FQBN_DEFAULT = "digistump:avr:digispark-tiny"
SKETCH_DEFAULT = "DigisparkMouse/DigisparkMouse.ino"
SOURCE_EXTENSIONS = {".ino", ".pde", ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".S", ".s"}
MAX_SOURCE_BYTES = 512 * 1024

# Un nombre de sketch en Arduino tiene que empezar con letra y sólo admite
# letras/dígitos/underscore: es también lo que evita escapar del directorio.
NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,62}$")


# --------------------------------------------------------------------------- #
# arduino-cli
# --------------------------------------------------------------------------- #


class ArduinoCLI:
    def __init__(self, command: str, timeout: int = 180):
        self.command = command
        self.timeout = timeout
        self._board_cache: list[dict] | None = None

    def run(self, args: list[str], timeout: int | None = None) -> tuple[int, str]:
        try:
            done = subprocess.run(
                [self.command, *args],
                capture_output=True,
                text=True,
                timeout=timeout or self.timeout,
            )
        except FileNotFoundError:
            return 127, f"No encuentro '{self.command}'. Instalalo (brew install arduino-cli)."
        except subprocess.TimeoutExpired:
            return 124, f"arduino-cli tardó más de {timeout or self.timeout}s y lo cancelé."
        return done.returncode, (done.stdout or "") + (done.stderr or "")

    @property
    def data_dir(self) -> str:
        code, out = self.run(["config", "get", "directories.data"], timeout=20)
        if code == 0 and out.strip():
            return out.strip()
        return os.path.expanduser("~/Library/Arduino15")

    def cores(self) -> list[str]:
        code, out = self.run(["core", "list"], timeout=30)
        if code != 0:
            return []
        cores = []
        for line in out.splitlines():
            parts = line.split()
            if parts and ":" in parts[0]:
                cores.append(parts[0])
        return cores

    def boards(self, refresh: bool = False) -> list[dict]:
        """Placas ATtiny85 instaladas, con F_CPU y límites reales."""
        if self._board_cache is not None and not refresh:
            return self._board_cache

        code, out = self.run(["board", "listall", "--format", "json"], timeout=60)
        if code != 0:
            return []
        try:
            listed = json.loads(out)["boards"]
        except (ValueError, KeyError):
            return []

        # 'board listall' no dice el microcontrolador: hay que preguntar por cada
        # placa candidata y quedarse con las que son attiny85 de verdad (así el
        # Digispark Pro, que es attiny167, no se cuela).
        keywords = ("digispark", "tiny85", "tinyx5", "micronucleus", "attiny")
        candidates = [
            board
            for board in listed
            if any(key in (board.get("fqbn", "") + board.get("name", "")).lower() for key in keywords)
        ]

        found = []
        for board in candidates:
            details = self.board_details(board["fqbn"])
            if details.get("mcu") == "attiny85":
                found.append(details)

        found.sort(key=lambda b: (b["fqbn"] != FQBN_DEFAULT, b["fqbn"]))
        self._board_cache = found
        return found

    def board_details(self, fqbn: str) -> dict:
        code, out = self.run(["board", "details", "--fqbn", fqbn, "--format", "json"], timeout=60)
        if code != 0:
            return {}
        try:
            raw = json.loads(out)
        except ValueError:
            return {}

        # build_properties viene como lista de "clave=valor".
        props: dict[str, str] = {}
        for item in raw.get("build_properties") or []:
            if isinstance(item, str) and "=" in item:
                key, _, value = item.partition("=")
                props[key] = value
            elif isinstance(item, dict):
                for key, value in item.items():
                    props[key] = value

        def number(key: str) -> int | None:
            value = props.get(key, "")
            match = re.match(r"^(\d+)", value.strip())
            return int(match.group(1)) if match else None

        return {
            "fqbn": fqbn,
            "name": raw.get("name") or fqbn,
            "mcu": props.get("build.mcu"),
            "fCpu": props.get("build.f_cpu"),
            "maximumSize": number("upload.maximum_size"),
            "maximumDataSize": number("upload.maximum_data_size"),
            "variant": props.get("build.variant"),
            # En el core de Digistump las variantes "No USB" no traen V-USB, así que
            # el sketch no puede hablar por USB (ni DigiMouse ni DigiKeyboard).
            "usesUsb": "no usb" not in (raw.get("name") or "").lower(),
        }


# --------------------------------------------------------------------------- #
# Intel HEX
# --------------------------------------------------------------------------- #


def hex_image_size(hex_text: str) -> int:
    """Bytes de imagen de flash, igual que `avr-objcopy -O binary` (huecos incluidos)."""
    end = 0
    base = 0
    for line in hex_text.splitlines():
        line = line.strip()
        if not line.startswith(":") or len(line) < 11:
            continue
        try:
            length = int(line[1:3], 16)
            address = int(line[3:7], 16)
            record_type = int(line[7:9], 16)
        except ValueError:
            continue
        if record_type == 0x00:
            end = max(end, base + address + length)
        elif record_type == 0x02:
            base = int(line[9:13], 16) << 4
        elif record_type == 0x04:
            base = int(line[9:13], 16) << 16
    return end


SIZE_PATTERNS = (
    (r"(?:El Sketch usa|Sketch uses)\s+(\d+)\s+bytes", "flash"),
    (r"(?:Variables globales usan|Global variables use)\s+(\d+)\s+bytes", "ram"),
    (r"(?:El máximo es|Maximum is)\s+(\d+)\s+bytes", "maximum"),
)


def parse_sizes(log: str) -> dict:
    sizes: dict[str, int] = {}
    for pattern, key in SIZE_PATTERNS:
        match = re.search(pattern, log)
        if match:
            sizes[key] = int(match.group(1))
    return sizes


# --------------------------------------------------------------------------- #
# Compilación
# --------------------------------------------------------------------------- #


class Builder:
    def __init__(self, cli: ArduinoCLI, repo: str):
        self.cli = cli
        self.repo = repo
        self.scratch = os.path.join(repo, "build")
        os.makedirs(self.scratch, exist_ok=True)

    def compiler_path_override(self) -> list[str]:
        """Apple Silicon: el avr-gcc i386 de Digistump no corre sin este override.

        Es el mismo arreglo que hace ./flash.sh cuando falta platform.local.txt.
        """
        platform_dirs = self._glob(
            os.path.join(self.cli.data_dir, "packages", "digistump", "hardware", "avr", "*")
        )
        if not platform_dirs:
            return []
        platform_dir = platform_dirs[0]
        if os.path.isfile(os.path.join(platform_dir, "platform.local.txt")):
            return []
        gcc_bins = self._glob(
            os.path.join(self.cli.data_dir, "packages", "arduino", "tools", "avr-gcc", "7.3.0*", "bin")
        )
        if not gcc_bins:
            return []
        return ["--build-property", f"compiler.path={gcc_bins[0]}{os.sep}"]

    @staticmethod
    def _glob(pattern: str) -> list[str]:
        import glob

        return sorted(glob.glob(pattern))

    def _write_sketch(self, scratch: str, name: str, source: str, extra_files: list[dict]):
        """Escribe el sketch y sus archivos extra en `scratch`.

        Devuelve (sketch_dir, nombres_escritos) o un dict de error, porque la
        validación de nombres es la misma para compilar y para grabar.
        """
        sketch_dir = os.path.join(scratch, name)
        os.makedirs(sketch_dir, exist_ok=True)
        with open(os.path.join(sketch_dir, f"{name}.ino"), "w", encoding="utf-8") as handle:
            handle.write(source)

        written = [f"{name}.ino"]
        for extra in extra_files:
            file_name = str(extra.get("name", "")).strip()
            base = os.path.basename(file_name)
            if base != file_name or not base:
                return None, f"Nombre de archivo inválido: {file_name!r}"
            if os.path.splitext(base)[1] not in SOURCE_EXTENSIONS:
                return None, f"Extensión no permitida en {base!r}."
            with open(os.path.join(sketch_dir, base), "w", encoding="utf-8") as handle:
                handle.write(str(extra.get("content", "")))
            written.append(base)
        return sketch_dir, written

    def _build(self, scratch: str, name: str, source: str, fqbn: str, extra_files: list[dict]):
        """Escribe el sketch y lo compila en `scratch/out`.

        Devuelve (log, hex_text, written) o (log, None, written) si falló.
        """
        sketch_dir, written = self._write_sketch(scratch, name, source, extra_files)
        if sketch_dir is None:
            # `written` trae el mensaje de error cuando la validación falla.
            return written, None, []

        out_dir = os.path.join(scratch, "out")
        os.makedirs(out_dir, exist_ok=True)

        code, log = self.cli.run(
            [
                "compile",
                "--fqbn",
                fqbn,
                "--output-dir",
                out_dir,
                *self.compiler_path_override(),
                sketch_dir,
            ]
        )
        if code != 0:
            return log, None, written

        hex_path = os.path.join(out_dir, f"{name}.ino.hex")
        hex_text = ""
        if os.path.isfile(hex_path):
            with open(hex_path, "r", encoding="utf-8") as handle:
                hex_text = handle.read()
        return log, hex_text or None, written

    def compile(self, source: str, name: str, fqbn: str, extra_files: list[dict]) -> dict:
        scratch = tempfile.mkdtemp(prefix="agent-", dir=self.scratch)
        try:
            log, hex_text, written = self._build(scratch, name, source, fqbn, extra_files)
            if hex_text is None:
                # Si el problema fue el nombre del archivo, el log viene vacío.
                if not written:
                    return _error(log)
                return {
                    "ok": False,
                    "exitCode": 1,
                    "hex": "",
                    "bytes": 0,
                    "sizes": parse_sizes(log),
                    "files": written,
                    "fqbn": fqbn,
                    "log": log.strip(),
                    "error": "La compilación falló (mirá el log).",
                }

            return {
                "ok": True,
                "exitCode": 0,
                "hex": hex_text,
                "bytes": hex_image_size(hex_text),
                "sizes": parse_sizes(log),
                "files": written,
                "fqbn": fqbn,
                "log": log.strip(),
                "error": None,
            }
        finally:
            shutil.rmtree(scratch, ignore_errors=True)

    def flash(
        self,
        source: str,
        name: str,
        fqbn: str,
        extra_files: list[dict],
        port: str = "usb",
        timeout: int = 75,
    ) -> dict:
        """Compila y graba en la placa con arduino-cli, sin pasar por WebUSB.

        Es el mismo camino que usa el IDE de Arduino: arduino-cli llama al CLI de
        micronucleus (recetas `tools.micronucleus.*` del core Digistump), que se
        queda esperando hasta 60 s a que la placa aparezca en modo bootloader.

        Por eso el orden que funciona es: pulsar Grabar y REÉN enchufar la placa
        (el bootloader sólo escucha ~5 s después de conectarse).
        """
        scratch = tempfile.mkdtemp(prefix="flash-", dir=self.scratch)
        try:
            log, hex_text, written = self._build(scratch, name, source, fqbn, extra_files)
            if hex_text is None:
                if not written:
                    return _error(log)
                return {
                    "ok": False,
                    "stage": "compile",
                    "bytes": 0,
                    "sizes": parse_sizes(log),
                    "files": written,
                    "fqbn": fqbn,
                    "log": log.strip(),
                    "error": "La compilación falló: no se grabó nada en la placa.",
                }

            out_dir = os.path.join(scratch, "out")
            code, upload_log = self.cli.run(
                [
                    "upload",
                    "-p",
                    port,
                    "--fqbn",
                    fqbn,
                    "--input-dir",
                    out_dir,
                    os.path.join(scratch, name),
                ],
                timeout=timeout,
            )

            # OJO: arduino-cli devuelve 0 aunque el CLI de micronucleus falle
            # (el timeout de búsqueda de placa no se propaga como exit code), así
            # que el resultado hay que leerlo del log. El éxito tiene marca
            # propia: "Micronucleus done. Thank you!" (commandline/micronucleus.c).
            fallos = {
                "Device search timed out": (
                    "La placa no apareció en modo bootloader. Desenchufala, pulsá Grabar otra vez "
                    "y enchufala cuando el agente ya esté esperando."
                ),
                "has occured": "El bootloader reportó un error de borrado o de escritura.",
                "No data in input file": "El .hex quedó vacío: no se grabó nada.",
                "too big for the bootloader": "El firmware es más grande que la flash de usuario.",
                "seems to be inactive": (
                    "El bootloader no responde: desenchufá la placa, pulsá Grabar y volvé a enchufarla."
                ),
            }
            encontrado = next((texto for marca, texto in fallos.items() if marca in upload_log), None)

            if code == 124:
                ok = False
                message = (
                    f"La placa no apareció en {timeout} s. Desenchufala, pulsá Grabar otra vez "
                    "y enchufala cuando el agente ya esté esperando."
                )
            elif "Micronucleus done" not in upload_log:
                ok = False
                message = encontrado or "No se pudo grabar (mirá el log de la grabación)."
            else:
                ok = code == 0
                message = None if ok else "El CLI de micronucleus salió con error."

            return {
                "ok": ok,
                "stage": "upload",
                "exitCode": code,
                "bytes": hex_image_size(hex_text),
                "sizes": parse_sizes(log),
                "files": written,
                "fqbn": fqbn,
                "port": port,
                "log": (log + "\n" + upload_log).strip(),
                "error": message,
            }
        finally:
            shutil.rmtree(scratch, ignore_errors=True)

    # ----------------------------------------------------------------- #

    def resolve(self, relative: str) -> str | None:
        """Resuelve una ruta dentro del repo y valida extensión y existencia."""
        if not relative:
            return None
        candidate = os.path.realpath(os.path.join(self.repo, relative))
        if not candidate.startswith(os.path.realpath(self.repo) + os.sep):
            return None
        if os.path.splitext(candidate)[1] not in SOURCE_EXTENSIONS:
            return None
        return candidate

    def source_files(self, limit: int = 200) -> list[str]:
        found = []
        for root, dirs, files in os.walk(self.repo):
            dirs[:] = [d for d in dirs if d not in {".git", "build", "node_modules"} and not d.startswith(".")]
            for file_name in sorted(files):
                if os.path.splitext(file_name)[1] in SOURCE_EXTENSIONS:
                    found.append(os.path.relpath(os.path.join(root, file_name), self.repo))
        return sorted(found)[:limit]

    def save(self, relative: str, content: str) -> dict:
        path = self.resolve(relative)
        if not path:
            return _error(f"Ruta no permitida: {relative!r}")
        if not os.path.isfile(path):
            return _error(f"No existe el archivo {relative}.")
        if len(content.encode("utf-8")) > MAX_SOURCE_BYTES:
            return _error("El archivo es demasiado grande (512 KB).")

        shutil.copyfile(path, path + ".bak")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(content)
        return {"ok": True, "path": os.path.relpath(path, self.repo), "backup": os.path.relpath(path, self.repo) + ".bak"}


def _error(message: str) -> dict:
    return {"ok": False, "error": message}


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #


class Agent:
    def __init__(self, cli: ArduinoCLI, builder: Builder, allowed_origins: list[str]):
        self.cli = cli
        self.builder = builder
        self.allowed_origins = allowed_origins

    def origin_allowed(self, origin: str | None) -> bool:
        if not origin:
            return True  # curl y demás clientes locales, sin navegador de por medio
        for allowed in self.allowed_origins:
            if allowed == "*":
                return True
            if allowed.endswith(":*"):
                prefix = allowed[:-2]
                if origin == prefix or origin.startswith(prefix + ":"):
                    return True
            if origin == allowed:
                return True
        return False


def make_handler(agent: Agent):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ATtiny85CompileAgent/1.0"

        # ---------------------------- utilidades ---------------------------- #

        def log_message(self, fmt, *args):  # silencio: el log lo maneja el usuario
            sys.stderr.write("[agente] %s\n" % (fmt % args))

        def _cors(self):
            origin = self.headers.get("Origin")
            if origin and agent.origin_allowed(origin):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "content-type")
            # Private Network Access: una página pública (https://…github.io)
            # que llama a 127.0.0.1 manda este pedido en el preflight.
            if (self.headers.get("Access-Control-Request-Private-Network") or "").lower() == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")

        def _send(self, payload: dict, status: int = 200):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self._cors()
            self.end_headers()
            self.wfile.write(body)

        def _guard(self) -> bool:
            origin = self.headers.get("Origin")
            if agent.origin_allowed(origin):
                return True
            self._send(
                _error(
                    f"Origen no autorizado: {origin}. Arrancá el agente con "
                    f"--allow-origin {origin} si querés permitirlo."
                ),
                status=403,
            )
            return False

        def _body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return {}
            if length > 4 * 1024 * 1024:
                raise ValueError("Pedido demasiado grande.")
            return json.loads(self.rfile.read(length).decode("utf-8"))

        # ------------------------------ rutas ------------------------------ #

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self._cors()
            self.end_headers()

        def do_GET(self):
            if not self._guard():
                return
            parsed = urlparse(self.path)
            query = parse_qs(parsed.query)

            if parsed.path == "/health":
                boards = agent.cli.boards()
                cores = agent.cli.cores()
                self._send(
                    {
                        "ok": True,
                        "agent": "ATtiny85 compile agent",
                        "arduinoCli": agent.cli.command,
                        "dataDir": agent.cli.data_dir,
                        "cores": cores,
                        "digistumpInstalled": any(core.startswith("digistump:") for core in cores),
                        "boards": boards,
                        "sketch": SKETCH_DEFAULT,
                    }
                )
                return

            if parsed.path == "/boards":
                self._send({"ok": True, "boards": agent.cli.boards(refresh="refresh" in query)})
                return

            if parsed.path == "/files":
                self._send({"ok": True, "files": agent.builder.source_files()})
                return

            if parsed.path == "/sketch":
                relative = (query.get("path") or [SKETCH_DEFAULT])[0]
                path = agent.builder.resolve(relative)
                if not path or not os.path.isfile(path):
                    self._send(_error(f"No puedo leer {relative!r}."), status=404)
                    return
                with open(path, "r", encoding="utf-8", errors="replace") as handle:
                    source = handle.read()
                self._send({"ok": True, "path": os.path.relpath(path, agent.builder.repo), "source": source})
                return

            self._send(_error("Ruta desconocida."), status=404)

        def do_POST(self):
            if not self._guard():
                return
            path = urlparse(self.path).path

            try:
                body = self._body()
            except (ValueError, json.JSONDecodeError) as error:
                self._send(_error(f"JSON inválido: {error}"), status=400)
                return

            if path == "/compile":
                source = body.get("source")
                if not isinstance(source, str) or not source.strip():
                    self._send(_error("Falta 'source'."), status=400)
                    return
                name = str(body.get("name") or "Sketch")
                if not NAME_RE.match(name):
                    self._send(_error("Nombre de sketch inválido: usá letras, dígitos y _."), status=400)
                    return
                fqbn = str(body.get("fqbn") or FQBN_DEFAULT)
                extra = body.get("files") or []
                if not isinstance(extra, list):
                    self._send(_error("'files' tiene que ser una lista."), status=400)
                    return
                result = agent.builder.compile(source, name, fqbn, extra)
                self._send(result, status=200 if result.get("ok") else 422)
                return

            if path == "/upload":
                source = body.get("source")
                if not isinstance(source, str) or not source.strip():
                    self._send(_error("Falta 'source'."), status=400)
                    return
                name = str(body.get("name") or "Sketch")
                if not NAME_RE.match(name):
                    self._send(_error("Nombre de sketch inválido: usá letras, dígitos y _."), status=400)
                    return
                fqbn = str(body.get("fqbn") or FQBN_DEFAULT)
                extra = body.get("files") or []
                if not isinstance(extra, list):
                    self._send(_error("'files' tiene que ser una lista."), status=400)
                    return
                result = agent.builder.flash(
                    source,
                    name,
                    fqbn,
                    extra,
                    port=str(body.get("port") or "usb"),
                )
                self._send(result, status=200 if result.get("ok") else 422)
                return

            if path == "/save":
                source = body.get("source")
                relative = str(body.get("path") or SKETCH_DEFAULT)
                if not isinstance(source, str):
                    self._send(_error("Falta 'source'."), status=400)
                    return
                result = agent.builder.save(relative, source)
                self._send(result, status=200 if result.get("ok") else 422)
                return

            self._send(_error("Ruta desconocida."), status=404)

    return Handler


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #


def main() -> int:
    repo_default = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))

    parser = argparse.ArgumentParser(description="Agente local de compilación para ATtiny85.")
    parser.add_argument("--port", type=int, default=8765, help="puerto (default 8765)")
    parser.add_argument("--host", default="127.0.0.1", help="interfaz (default 127.0.0.1)")
    parser.add_argument("--repo", default=repo_default, help="raíz del repo")
    parser.add_argument("--arduino-cli", default="arduino-cli", help="comando de arduino-cli")
    parser.add_argument("--timeout", type=int, default=180, help="timeout de compilación en segundos")
    parser.add_argument(
        "--allow-origin",
        action="append",
        default=None,
        help="origen permitido (repetible). Default: localhost/127.0.0.1 y https://rdvt.github.io",
    )
    args = parser.parse_args()

    allowed = args.allow_origin or [
        "http://localhost:*",
        "http://127.0.0.1:*",
        "https://rdvt.github.io",
        "https://rdvt.github.io:*",
        "https://valedam.lat:*",
    ]

    cli = ArduinoCLI(args.arduino_cli, timeout=args.timeout)
    builder = Builder(cli, os.path.realpath(args.repo))
    agent = Agent(cli, builder, allowed)

    print("Agente de compilación ATtiny85")
    print(f"  escuchando en http://{args.host}:{args.port}")
    print(f"  repo:        {builder.repo}")
    print(f"  arduino-cli: {args.arduino_cli}")
    print(f"  orígenes:    {', '.join(allowed)}")
    # `arduino-cli` usa `version` como subcomando; `--version` no está
    # disponible en varias versiones y daba el falso diagnóstico "NO ENCONTRADO".
    code, version = cli.run(["version"], timeout=20)
    if code != 0:
        code, version = cli.run(["--version"], timeout=20)
    print(f"  versión:     {version.strip() if code == 0 else 'NO ENCONTRADO'}")
    if code != 0:
        print("\n  ⚠ arduino-cli no responde: el editor va a mostrar el error igual, pero no compila.")
    print("\nListo. En el editor, apretá Compilar.")

    server = ThreadingHTTPServer((args.host, args.port), make_handler(agent))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nChau.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

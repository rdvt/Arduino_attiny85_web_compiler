#!/usr/bin/env python3
"""Prepara el inventario de assets para un toolchain ATtiny85-WASM.

Este comando no descarga ni fabrica binarios por accidente. Inspecciona el core
Digistump instalado, comprueba que el objetivo sea attiny85 y genera un
manifest.json de trabajo que luego usa el pipeline de compilación WASM.

Uso:
    python3 tools/prepare-attiny85-wasm.py
    python3 tools/prepare-attiny85-wasm.py --output wasm/attiny85/assets/manifest.json

La generación de cc1plus/avr-as/avr-ld/avr-objcopy en WASM requiere un entorno
Linux con Emscripten y está documentada en wasm/README.md. El agente local sigue
siendo la implementación de compilación de producción del proyecto.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

DEFAULT_FQBN = "digistump:avr:digispark-tiny"
DEFAULT_OUTPUT = "wasm/attiny85/assets/manifest.json"


def run(*args: str) -> str:
    try:
        result = subprocess.run(args, capture_output=True, text=True, check=False)
    except FileNotFoundError:
        raise SystemExit(f"No encuentro {args[0]!r}. Instalá arduino-cli antes de preparar los assets.")
    output = (result.stdout or "") + (result.stderr or "")
    if result.returncode != 0:
        raise SystemExit(output.strip() or f"{args[0]} terminó con código {result.returncode}.")
    return output.strip()


def config_data_dir(cli: str) -> Path:
    configured = run(cli, "config", "get", "directories.data")
    if configured:
        return Path(configured).expanduser().resolve()
    return Path.home() / "Library" / "Arduino15"


def board_details(cli: str, fqbn: str) -> dict:
    raw = run(cli, "board", "details", "--fqbn", fqbn, "--format", "json")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as error:
        raise SystemExit(f"arduino-cli devolvió JSON inválido: {error}")

    props: dict[str, str] = {}
    for item in data.get("build_properties") or []:
        if isinstance(item, str) and "=" in item:
            key, _, value = item.partition("=")
            props[key] = value
        elif isinstance(item, dict):
            props.update({str(key): str(value) for key, value in item.items()})

    def number(key: str) -> int | None:
        match = re.match(r"^(\d+)", props.get(key, "").strip())
        return int(match.group(1)) if match else None

    result = {
        "fqbn": fqbn,
        "name": data.get("name") or fqbn,
        "mcu": props.get("build.mcu"),
        "multilib": props.get("build.arch"),
        "fCpu": props.get("build.f_cpu"),
        "userFlashBytes": number("upload.maximum_size"),
        "ramBytes": number("upload.maximum_data_size") or (512 if props.get("build.mcu") == "attiny85" else None),
        "variant": props.get("build.variant"),
    }
    if result["mcu"] != "attiny85":
        raise SystemExit(
            f"El FQBN {fqbn} no describe un attiny85 (mcu={result['mcu']!r}). "
            "No se genera un manifest para otro microcontrolador."
        )
    return result


def find_platform(data_dir: Path) -> Path:
    matches = sorted((data_dir / "packages" / "digistump" / "hardware" / "avr").glob("*"))
    if not matches:
        raise SystemExit(
            f"No encuentro el core Digistump en {data_dir}. "
            "Instalá digistump:avr o indicá --data-dir."
        )
    return matches[-1]


def relative_candidates(platform: Path) -> dict[str, list[str]]:
    """Inventario conservador: sólo nombres que luego deben confirmarse al compilar."""
    candidates = {
        "headers": [],
        "sources": [],
        "objects": [],
    }
    for path in platform.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(platform).as_posix()
        if path.suffix.lower() in {".h", ".hpp", ".inc"}:
            candidates["headers"].append(relative)
        elif path.suffix.lower() in {".c", ".cc", ".cpp", ".s", ".S".lower()}:
            candidates["sources"].append(relative)
        elif path.suffix.lower() == ".o":
            candidates["objects"].append(relative)
    for values in candidates.values():
        values.sort()
    return candidates


def main() -> int:
    parser = argparse.ArgumentParser(description="Inventaría el core Digistump para ATtiny85-WASM.")
    parser.add_argument("--arduino-cli", default="arduino-cli", help="comando de arduino-cli")
    parser.add_argument("--fqbn", default=DEFAULT_FQBN, help=f"FQBN objetivo (default: {DEFAULT_FQBN})")
    parser.add_argument("--data-dir", type=Path, help="directories.data de Arduino15")
    parser.add_argument("--output", type=Path, default=Path(DEFAULT_OUTPUT), help="manifest JSON de salida")
    args = parser.parse_args()

    data_dir = (args.data_dir or config_data_dir(args.arduino_cli)).expanduser().resolve()
    target = board_details(args.arduino_cli, args.fqbn)
    platform = find_platform(data_dir)
    inventory = relative_candidates(platform)

    manifest = {
        "schemaVersion": 1,
        "generatedBy": "tools/prepare-attiny85-wasm.py",
        "target": {
            **target,
            "multilib": "avr25",
            "linkerScript": "/ldscripts/avr25.xn",
        },
        "source": {
            "platformVersion": platform.name,
            "inventory": inventory,
            "note": "Inventario del core; los objetos deben compilarse para avr25 antes de activar WASM.",
        },
        "toolchain": {
            "tools": ["cc1plus.wasm", "avr-as.wasm", "avr-ld.wasm", "avr-objcopy.wasm"],
            "assetsBase": "./",
            "status": "inventory-only",
        },
        "objectGroups": {
            "base": [],
            "vusb": [],
        },
        "headerFiles": [],
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Manifest escrito en {args.output}")
    print(f"Objetivo: {target['mcu']} / avr25 / {target['fCpu']} / {target['userFlashBytes']} bytes de flash")
    print(f"Inventario: {len(inventory['headers'])} headers, {len(inventory['sources'])} fuentes, {len(inventory['objects'])} objetos")
    print("Siguiente paso: compilar los objetos con Emscripten y completar objectGroups/headerFiles según wasm/README.md.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

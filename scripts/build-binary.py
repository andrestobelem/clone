#!/usr/bin/env python3
"""Build one standalone Clone executable for the current platform."""

from __future__ import annotations

import platform
import sys
from pathlib import Path

import PyInstaller.__main__


ROOT = Path(__file__).resolve().parents[1]
SYSTEMS = {"darwin": "darwin", "linux": "linux", "win32": "win32"}
ARCHITECTURES = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}


def target_name() -> str:
    system = SYSTEMS.get(sys.platform)
    architecture = ARCHITECTURES.get(platform.machine().lower())
    if not system or not architecture:
        raise SystemExit(f"Unsupported build target: {sys.platform}/{platform.machine()}")
    return f"clone-{system}-{architecture}"


def main() -> None:
    name = target_name()
    PyInstaller.__main__.run(
        [
            "--noconfirm",
            "--clean",
            "--onefile",
            "--name",
            name,
            "--distpath",
            str(ROOT / "dist" / "bin"),
            "--workpath",
            str(ROOT / "build" / "pyinstaller"),
            "--specpath",
            str(ROOT / "build"),
            "--paths",
            str(ROOT),
            "--hidden-import",
            "server",
            "--add-data",
            f"{ROOT / 'index.html'}:.",
            "--add-data",
            f"{ROOT / 'app.js'}:.",
            "--add-data",
            f"{ROOT / 'styles.css'}:.",
            str(ROOT / "packaging" / "clone_runtime.py"),
        ]
    )


if __name__ == "__main__":
    main()

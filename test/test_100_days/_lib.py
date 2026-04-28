"""
Shared validators used by every per-project test under test_100_days/.

These helpers do *not* mutate any backend state. The "live" portion of
each test only runs when ``$VELXIO_BACKEND_URL`` points at a reachable
``uvicorn app.main:app`` — by default it is unset and the live tests
auto-skip, so the suite stays green offline.
"""

from __future__ import annotations

import ast
import os
import re
import socket
from pathlib import Path
from typing import Iterable, Literal
from urllib.parse import urlparse

# ─── Velxio capability matrix ──────────────────────────────────────────────
# Mirrors:
#   frontend/src/types/board.ts          (BoardKind / BOARD_KIND_FQBN)
#   backend/app/services/esp32_worker.py (wifi_enabled / -nic esp32_wifi)
# Keep this list in sync if Velxio gains/loses board support.

BoardKind = Literal[
    "esp32", "esp32-s3", "esp32-c3", "xiao-esp32",
    "rp2040", "pico-w",
    "esp8266",  # listed but unsupported
]

PROJECT_BOARD = {
    "esp32":      ("✅", "Espressif QEMU + Arduino-CLI esp32:esp32:esp32"),
    "esp32-s3":   ("✅", "Espressif QEMU + esp32:esp32:esp32s3"),
    "esp32-c3":   ("✅", "Espressif QEMU + esp32:esp32:esp32c3"),
    "xiao-esp32": ("✅", "treated as esp32-s3 / esp32-c3 in Esp32Bridge"),
    "rp2040":     ("✅", "rp2040js with avr8js fallback for compute"),
    "pico-w":     ("✅", "rp2040js — WiFi limited"),
    "esp8266":    ("❌", "no ESP8266 emulator/firmware in Velxio"),
}


def velxio_supports_board(board: str | None) -> tuple[bool, str]:
    """Return ``(ok, reason)`` for a board kind."""
    if board is None:
        return False, "no board could be inferred from project name or source"
    info = PROJECT_BOARD.get(board)
    if info is None:
        return False, f"board {board!r} is not in Velxio's supported list"
    icon, reason = info
    return icon == "✅", reason


# ─── Static source analysis ────────────────────────────────────────────────

# MicroPython modules that ship with the firmware Velxio loads (esp32 +
# rp2040 generic builds, v1.20.0). Anything outside this set is either a
# user file in the project (resolved separately) or a host-only Python
# package (matplotlib / tkinter / flask / requests / numpy …).
MICROPYTHON_BUILTINS = {
    # Stdlib subset
    "array", "binascii", "builtins", "cmath", "collections", "errno",
    "gc", "hashlib", "heapq", "io", "json", "math", "os", "platform",
    "random", "re", "select", "socket", "ssl", "struct", "sys", "time",
    "uasyncio", "asyncio", "ubinascii", "uctypes", "uhashlib", "uheapq",
    "uio", "ujson", "uos", "uplatform", "urandom", "ure", "uselect",
    "usocket", "ussl", "ustruct", "usys", "utime", "uzlib", "zlib",
    # MCU API
    "machine", "micropython", "neopixel", "framebuf",
    # ESP-specific
    "esp", "esp32", "espnow", "network", "btree", "uctypes", "ubluetooth",
    "ucryptolib", "umqtt", "umqtt.simple", "umqtt.robust",
    "urequests", "requests", "ntptime",
    # Pico-specific
    "rp2", "_thread",
}

# Modules that obviously do NOT belong in MCU code — if the .py file is
# meant to run on the board, importing one of these is a Velxio blocker.
HOST_ONLY_MODULES = {
    "tkinter", "customtkinter",
    "flask", "fastapi", "django",
    "matplotlib", "numpy", "scipy", "pandas",
    "serial",  # pyserial — host PC side
    "PIL",
    "pyqt5", "pyqt6", "PySide2", "PySide6",
}


def _module_root(name: str) -> str:
    return name.split(".", 1)[0]


def classify_micropython_source(py_files: Iterable[Path]) -> dict:
    """Walk imports across all .py files and bucket them.

    Returns a dict:
        {
            "imports":             {module_root, ...},
            "host_only_in_mcu_files": ["main.py imports tkinter", ...],
            "user_modules":        {"BlynkLib", "ssd1306", ...},
        }
    """
    files = list(py_files)
    user_module_names = {p.stem for p in files}
    imports: set[str] = set()
    host_offenders: list[str] = []

    for f in files:
        # Skip files that are clearly host-only by their *role*, e.g.
        # `app.py`, `gui_*.py`, `analyze.py`. They live in the project but
        # are intended for the host PC, not the MCU.
        if _is_host_role(f):
            continue
        try:
            tree = ast.parse(f.read_text(encoding="utf-8", errors="ignore"))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imports.add(_module_root(alias.name))
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    imports.add(_module_root(node.module))

        # Detect host-only imports inside what is supposed to be MCU code
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    root = _module_root(alias.name)
                    if root in HOST_ONLY_MODULES:
                        host_offenders.append(f"{f.name} imports {alias.name}")
            elif isinstance(node, ast.ImportFrom):
                if node.module and _module_root(node.module) in HOST_ONLY_MODULES:
                    host_offenders.append(f"{f.name} imports from {node.module}")

    user_modules = imports & user_module_names
    return dict(
        imports=imports,
        host_only_in_mcu_files=host_offenders,
        user_modules=user_modules,
    )


_HOST_ROLE_NAMES = {
    "app.py", "gui.py", "server.py", "client_gui.py", "analyze.py",
    "serial_py_code.py",
}


def _is_host_role(p: Path) -> bool:
    name = p.name.lower()
    if name in _HOST_ROLE_NAMES:
        return True
    if name.startswith("gui_") or name.endswith("_gui.py"):
        return True
    if name.startswith("flask_") or name.endswith("_flask.py"):
        return True
    return False


def compile_python_sources(py_files: Iterable[Path]) -> list[str]:
    """Return a list of human-readable error strings for any .py file that
    fails to ``compile()``. Empty list = all good.
    """
    errs: list[str] = []
    for f in py_files:
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except OSError as e:
            errs.append(f"{f.name}: read error: {e}")
            continue
        try:
            compile(text, str(f), "exec")
        except SyntaxError as e:
            errs.append(f"{f.name}:{e.lineno}: {e.msg}")
    return errs


_INCLUDE_RE = re.compile(r'#\s*include\s*[<"]([^>"]+)[>"]')


def detect_arduino_includes(ino_files: Iterable[Path]) -> list[str]:
    out: list[str] = []
    for f in ino_files:
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        out.extend(_INCLUDE_RE.findall(text))
    # de-dup, preserving order
    seen = set()
    deduped = []
    for inc in out:
        if inc not in seen:
            deduped.append(inc)
            seen.add(inc)
    return deduped


# ─── Backend reachability ──────────────────────────────────────────────────

def _backend_url() -> str:
    return os.environ.get("VELXIO_BACKEND_URL", "").strip()


def backend_reachable(timeout: float = 0.5) -> bool:
    """Cheap TCP probe against $VELXIO_BACKEND_URL — returns False fast."""
    url = _backend_url()
    if not url:
        return False
    try:
        u = urlparse(url)
        host = u.hostname or "localhost"
        port = u.port or (443 if u.scheme == "https" else 80)
    except Exception:
        return False
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def backend_websocket_url(client_id: str) -> str:
    """Map ``$VELXIO_BACKEND_URL`` (http://…) → ws://…/api/simulation/{id}."""
    url = _backend_url() or "http://localhost:8001"
    u = urlparse(url)
    scheme = "wss" if u.scheme == "https" else "ws"
    host = u.hostname or "localhost"
    port = f":{u.port}" if u.port else ""
    return f"{scheme}://{host}{port}/api/simulation/{client_id}"

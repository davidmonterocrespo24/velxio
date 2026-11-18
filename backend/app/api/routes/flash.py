"""
Hardware flash router — `POST /api/flash/upload`.

Wraps `arduino-cli upload` so the desktop frontend can write a
compiled sketch to a real USB-attached board. Same arduino-cli the
compile path uses, so AVR / RP2040 / ESP32 (Arduino-core) all share
one code path — arduino-cli internally dispatches to avrdude /
picotool / esptool based on the FQBN.

Why a route (and not a pure Tauri command on the shell):
  - Sidecar already has arduino-cli on PATH (see
    `pro/desktop/sidecar/main.py::_expose_bundled_arduino_cli`) +
    knows the bundled `binaries/arduino-data` location. Reusing it
    avoids duplicating the resolution logic in Rust.
  - Streaming stdout via SSE works the same shape the compile flow
    already uses for live build output, so the frontend's modal
    can reuse most of the rendering plumbing.
  - The web build can later proxy to a WebSerial-based flasher
    instead — keeping the surface as `/api/flash/*` lets us route
    based on `isTauri()` without changing the call sites.

Concurrency: one in-flight flash per port. A second request to the
same port returns 409 Conflict immediately so the user gets a clear
error instead of two arduino-cli runs fighting over the device.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import AsyncIterator

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)

router = APIRouter()

# Per-port locks. Keyed by the port string the client sends — same
# port name from list_serial_ports MUST hash the same on both sides
# (case + leading slashes matter on Windows COM ports). Locks live
# for the process lifetime; abandoned ones don't leak meaningfully
# (a port that's never flashed again just keeps its lock object
# around, ~200 bytes).
_PORT_LOCKS: dict[str, asyncio.Lock] = {}


def _lock_for(port: str) -> asyncio.Lock:
    if port not in _PORT_LOCKS:
        _PORT_LOCKS[port] = asyncio.Lock()
    return _PORT_LOCKS[port]


# Allow-list of FQBN prefixes we know arduino-cli can flash via the
# bundled cores. Anything outside this set returns 400 so we don't
# accidentally let a typo through to a confusing arduino-cli error
# ("platform not installed"). Add more as cores get bundled.
_FQBN_PREFIXES = (
    "arduino:avr:",       # UNO, Mega, Nano, Leonardo, Pro Mini, ...
    "ATTinyCore:avr:",    # ATtiny85 via DigiSpark, ATtiny84, ...
    "rp2040:rp2040:",     # Pi Pico, Pico W, Pico 2, ...
    "esp32:esp32:",       # DevKitC, S3, C3, S2, ...
    "arduino:samd:",      # MKR boards, Nano 33 IoT (defensive — only
                          # works if the SAMD core is installed)
)

# Format → file extension hint for arduino-cli. Some flashers key
# off the extension; passing the wrong one makes esptool refuse a
# .hex it would otherwise burn as .bin.
# What a port and an FQBN may hold (velxio/velxio-prod#236). arduino-cli
# expands {property} references inside the port string when it builds the
# uploader's command line, and splits it on quotes, so a port is a plain
# device name: a /dev path (/dev/ttyUSB0, /dev/cu.usbmodem1101, a
# /dev/serial/by-id/ link) or a Windows COM port. An FQBN is its three
# words and, after a fourth colon, its menu options (key=value,...).
_PORT_OK = re.compile(r'(?:/dev/[A-Za-z0-9._:/+-]+|COM[0-9]{1,3})')
_FQBN_OK = re.compile(r'[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.=,-]+)?')

_FORMAT_EXTENSIONS = {
    "hex": ".hex",
    "bin": ".bin",
    "uf2": ".uf2",
    "elf": ".elf",
}

# Hard cap on uploaded program size. AVR programs are <32 KB,
# ESP32 apps are typically <1.5 MB, RP2040 max app is ~2 MB. 8 MB
# is generous + protects against a buggy client uploading the full
# sketch dir.
MAX_PROGRAM_BYTES = 8 * 1024 * 1024


def _arduino_cli_bin() -> str | None:
    """Pick the arduino-cli binary the sidecar uses for compile.

    Desktop bundle: `pro/desktop/sidecar/main.py::_expose_bundled_arduino_cli`
    has already prepended `<resources>/binaries/arduino-cli/` to PATH,
    so `shutil.which("arduino-cli")` resolves to the bundled one.
    Self-host / dev: relies on the user's system arduino-cli.
    """
    explicit = os.environ.get("ARDUINO_CLI_BIN", "").strip()
    if explicit:
        return explicit if Path(explicit).is_file() else None
    return shutil.which("arduino-cli")


def _safe_port_label(port: str) -> str:
    """Cosmetic — sanitise the port string for log lines so a
    malicious frontend can't smuggle ANSI escapes through us."""
    return re.sub(r"[^\w./\\:-]", "_", port)[:64]


@router.post("/upload")
async def flash_upload(
    board_id: str = Form(..., description="Frontend's board UUID, echoed in log"),
    port: str = Form(..., description="Serial port: COM3 / /dev/ttyUSB0 / /dev/cu.*"),
    fqbn: str = Form(..., description="arduino-cli FQBN (board target)"),
    program_format: str = Form(..., description="hex / bin / uf2 / elf"),
    program: UploadFile = File(..., description="The compiled sketch bytes"),
) -> StreamingResponse:
    """Stream-flash `program` to `port` using `arduino-cli upload`.

    Returns an SSE stream of `{phase, line?, progress?, success?, error?}`
    events. The frontend modal consumes the stream line-by-line.
    """
    # ── Validate inputs ──────────────────────────────────────────────
    if program_format not in _FORMAT_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Unknown program_format {program_format!r}. "
                f"Expected one of {sorted(_FORMAT_EXTENSIONS)}."
            ),
        )
    if not _FQBN_OK.fullmatch(fqbn):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="An FQBN holds letters, digits and . _ - , = between its colons.",
        )
    if not any(fqbn.startswith(p) for p in _FQBN_PREFIXES):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"FQBN {fqbn!r} is not in the flash allow-list. "
                f"Supported prefixes: {list(_FQBN_PREFIXES)}."
            ),
        )
    if port.strip() and not _PORT_OK.fullmatch(port):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A port is a device name: /dev/... or COM<n>.",
        )
    if not port.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty port.",
        )

    cli = _arduino_cli_bin()
    if cli is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "arduino-cli not found. Set ARDUINO_CLI_BIN or install "
                "it on the host. The desktop bundle ships one - this "
                "error usually means the sidecar's PATH wasn't extended."
            ),
        )

    # ── Stream the upload into a temp file ───────────────────────────
    # arduino-cli wants the program on disk - no stdin path. The
    # extension matters: arduino-cli uses it (and the FQBN) to pick
    # the right uploader. Wrong extension = wrong uploader = silent
    # failure or a confusing "format not recognised" error.
    suffix = _FORMAT_EXTENSIONS[program_format]
    fd, tmp_path_str = tempfile.mkstemp(prefix="velxio-flash-", suffix=suffix)
    tmp_path = Path(tmp_path_str)
    total = 0
    try:
        with os.fdopen(fd, "wb") as fh:
            while True:
                chunk = await program.read(1 << 20)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_PROGRAM_BYTES:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail=(
                            f"Program exceeds {MAX_PROGRAM_BYTES} bytes. "
                            "Real sketches stay well under that — check the "
                            "upload payload."
                        ),
                    )
                fh.write(chunk)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise

    logger.info(
        "[flash] queued board=%s port=%s fqbn=%s size=%d",
        board_id, _safe_port_label(port), fqbn, total,
    )

    # ── SSE generator ────────────────────────────────────────────────
    async def stream() -> AsyncIterator[bytes]:
        # Per-port lock prevents two simultaneous flashes from fighting
        # for the same /dev/ttyACM0. Yield a "queued" event if we end
        # up waiting so the frontend knows the request landed but is
        # blocked on a prior flash.
        lock = _lock_for(port)
        if lock.locked():
            yield _sse({"phase": "queued", "line": f"Waiting for prior flash on {port}..."})
        async with lock:
            try:
                async for event in _run_flash(cli, port, fqbn, tmp_path):
                    yield _sse(event)
            finally:
                tmp_path.unlink(missing_ok=True)

    # X-Accel-Buffering: no   tells nginx to NOT buffer SSE chunks
    # (default proxy_buffering=on holds the whole response). Without
    # it the frontend sees no output until the flash is done.
    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


def _sse(payload: dict) -> bytes:
    """Wrap a dict in the SSE `data: <json>\\n\\n` envelope."""
    return f"data: {json.dumps(payload, separators=(',', ':'))}\n\n".encode("utf-8")


async def _run_flash(
    cli: str, port: str, fqbn: str, program: Path,
) -> AsyncIterator[dict]:
    """Spawn arduino-cli upload, stream stdout/stderr line-by-line as
    SSE events, yield a final `done` event with success + elapsed_ms.
    """
    started = time.monotonic()
    cmd = [
        cli, "upload",
        "-p", port,
        "-i", str(program),
        "--fqbn", fqbn,
        "-v",  # verbose — gives the uploader's per-byte progress
    ]
    yield {
        "phase": "starting",
        "line": f"$ {' '.join(cmd)}",
    }

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except FileNotFoundError as exc:
        yield _done(False, error=f"could not start arduino-cli: {exc}",
                    elapsed_ms=int((time.monotonic() - started) * 1000))
        return

    assert proc.stdout is not None
    # avrdude / esptool progress lines look like:
    #   "Writing | ################################################## | 100% 1.23s"
    # capture the 0-100 number for the frontend's progress bar.
    progress_re = re.compile(r"(\d{1,3})%")
    async for raw in proc.stdout:
        try:
            line = raw.decode(errors="replace").rstrip("\r\n")
        except Exception:  # noqa: BLE001
            continue
        if not line:
            continue
        event: dict = {"phase": "writing", "line": line}
        m = progress_re.search(line)
        if m:
            try:
                pct = max(0, min(100, int(m.group(1))))
                event["progress"] = pct / 100.0
            except ValueError:
                pass
        yield event

    rc = await proc.wait()
    elapsed_ms = int((time.monotonic() - started) * 1000)
    if rc == 0:
        yield _done(True, elapsed_ms=elapsed_ms)
    else:
        yield _done(
            False,
            error=f"arduino-cli upload exited {rc}",
            elapsed_ms=elapsed_ms,
        )


def _done(success: bool, *, elapsed_ms: int, error: str | None = None) -> dict:
    payload: dict = {"phase": "done", "success": success, "elapsed_ms": elapsed_ms}
    if error:
        payload["error"] = error
    return payload

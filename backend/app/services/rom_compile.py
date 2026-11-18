"""ROM-compile service — turns a chip-program source file into raw ROM bytes.

Backs the `POST /api/compile-rom` endpoint that the frontend's "Compile" button
uses when the active file is a chip-program file (.s / .asm / .hex / .bin).
The output is base64-encoded bytes the frontend can stash in the chip's
`romBytes` property; the chip then reads them at chip_setup via
`vx_rom_size` / `vx_rom_read`.

Supported targets and formats:

  target=8080  format=asm   → in-tree two-pass Intel 8080 assembler (asm8080.py)
  target=*     format=hex   → Intel HEX parser
  target=*     format=bin   → raw byte passthrough (already-compiled ROM)

Future: z80/8086/4004 assemblers and SDCC for C sources.
"""
from __future__ import annotations

import asyncio
import base64
import logging
from importlib import import_module
from typing import Literal

logger = logging.getLogger(__name__)

# Lazy-load the asm8080 module from this services dir so the import stays
# explicit (no implicit sys.path manipulation).
_ASM_MODULE = None
_ASM_Z80_MODULE = None


def _asm8080():
    global _ASM_MODULE
    if _ASM_MODULE is None:
        _ASM_MODULE = import_module("app.services.asm8080")
    return _ASM_MODULE


def _asmz80():
    global _ASM_Z80_MODULE
    if _ASM_Z80_MODULE is None:
        _ASM_Z80_MODULE = import_module("app.services.asmz80")
    return _ASM_Z80_MODULE


Target = Literal["8080", "z80", "8086", "4004"]
Format = Literal["asm", "hex", "bin"]

# Longest source compile_rom builds, in characters. An 8080 or Z80 image is
# at most 64 KB; a whole one written as DB lines is about 400 KB of text.
MAX_SOURCE_CHARS = 1 << 20


def parse_intel_hex(text: str) -> bytes:
    """Parse Intel HEX records into a flat byte buffer. Unknown record types
    are skipped; data records (type 0x00) are placed at their declared address.
    """
    out = bytearray()
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith(":"):
            continue
        try:
            length = int(line[1:3], 16)
            addr   = int(line[3:7], 16)
            rtype  = int(line[7:9], 16)
        except ValueError:
            continue
        if rtype == 0x01:        # EOF record
            break
        if rtype != 0x00:        # ignore extended-segment, start-address, etc.
            continue
        data_hex = line[9 : 9 + length * 2]
        try:
            data = bytes.fromhex(data_hex)
        except ValueError:
            continue
        end = addr + len(data)
        if end > len(out):
            out.extend(b"\x00" * (end - len(out)))
        out[addr:end] = data
    return bytes(out)


def assemble_8080(source: str) -> bytes:
    """Two-pass Intel 8080 assembler. Returns raw ROM bytes."""
    return _asm8080().assemble(source)


def assemble_z80(source: str) -> bytes:
    """Two-pass Zilog Z80 assembler. Returns raw ROM bytes."""
    return _asmz80().assemble(source)


async def compile_rom(source: str, target: Target, fmt: Format) -> dict:
    """Compile a chip-program source to ROM bytes.

    Returns a dict shaped like:
        { success, rom_base64, byte_size, stderr, error }
    """
    if len(source) > MAX_SOURCE_CHARS:
        return {
            "success": False, "rom_base64": None, "byte_size": 0, "stderr": "",
            "error": (
                f"This program is {len(source):,} characters long; Velxio builds "
                f"chip programs of up to {MAX_SOURCE_CHARS:,} characters."
            ),
        }
    fmt_l = fmt.lower()
    tgt_l = target.lower()

    if fmt_l == "c":
        return await _compile_c(source, tgt_l)
    # The other formats run pure-Python code: on a worker thread, so a large
    # program does not hold up the server's other requests.
    return await asyncio.to_thread(_compile_in_process, source, target, fmt, fmt_l, tgt_l)


def _compile_in_process(source: str, target: str, fmt: str, fmt_l: str, tgt_l: str) -> dict:
    """compile_rom for the asm, hex and bin formats (synchronous)."""
    if fmt_l == "bin":
        # Source may arrive as a hex string (frontend pre-encodes binary)
        # or as raw text. Try hex-encoded first.
        clean = "".join(source.split())
        try:
            data = bytes.fromhex(clean)
        except ValueError:
            data = source.encode("latin1")
        return {
            "success": True,
            "rom_base64": base64.b64encode(data).decode("ascii"),
            "byte_size": len(data),
            "stderr": "",
            "error": None,
        }

    if fmt_l == "hex":
        try:
            data = parse_intel_hex(source)
        except Exception as e:  # noqa: BLE001
            return {
                "success": False,
                "rom_base64": None,
                "byte_size": 0,
                "stderr": "",
                "error": f"Intel HEX parse failed: {e}",
            }
        return {
            "success": True,
            "rom_base64": base64.b64encode(data).decode("ascii"),
            "byte_size": len(data),
            "stderr": "",
            "error": None,
        }

    if fmt_l == "asm":
        if tgt_l == "8080":
            try:
                data = assemble_8080(source)
            except Exception as e:  # noqa: BLE001
                return {
                    "success": False, "rom_base64": None, "byte_size": 0,
                    "stderr": "", "error": f"asm8080: {e}",
                }
        elif tgt_l == "z80":
            try:
                data = assemble_z80(source)
            except Exception as e:  # noqa: BLE001
                return {
                    "success": False, "rom_base64": None, "byte_size": 0,
                    "stderr": "", "error": f"asm-z80: {e}",
                }
        else:
            return {
                "success": False, "rom_base64": None, "byte_size": 0,
                "stderr": "",
                "error": (
                    f"No assembler for target {target!r} yet. Supported: "
                    "8080, z80. Try uploading a .hex or .bin compiled with "
                    "your own toolchain."
                ),
            }
        return {
            "success": True,
            "rom_base64": base64.b64encode(data).decode("ascii"),
            "byte_size": len(data),
            "stderr": "", "error": None,
        }

    return {
        "success": False,
        "rom_base64": None,
        "byte_size": 0,
        "stderr": "",
        "error": f"Unknown format {fmt!r} — expected asm / hex / bin / c.",
    }


async def _compile_c(source: str, tgt_l: str) -> dict:
    """compile_rom for the c format."""
    # C source via SDCC (Z80 only — pure 8080 has no SDCC backend; Z80
    # is binary-compat with 8080 so the same .c can target both chips).
    from app.services.c_compile import compile_c  # lazy — keeps the
                                                   # import out of the
                                                   # asm/hex/bin path.
    result = await compile_c(source, tgt_l if tgt_l in ("z80", "8080") else "z80")
    rom = result.get("rom_bytes", b"")
    if not result.get("success"):
        return {
            "success": False,
            "rom_base64": None,
            "byte_size": 0,
            "stderr": result.get("stderr", ""),
            "error": result.get("error", "C compile failed"),
        }
    return {
        "success": True,
        "rom_base64": base64.b64encode(rom).decode("ascii"),
        "byte_size": len(rom),
        "stderr": result.get("stderr", ""),
        "error": None,
    }

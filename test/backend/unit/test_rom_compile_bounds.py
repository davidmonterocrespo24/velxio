"""
test_rom_compile_bounds.py: POST /api/compile-rom does bounded work, off the
event loop.

* The 8080 and Z80 assemblers keep every location and every byte inside the
  CPUs' 64 KB address space. An ORG past it, or code that runs past its end,
  is an assembly error found at once; the gap up to an ORG is filled in one
  step instead of one byte per interpreter step.
* compile_rom refuses a source longer than MAX_SOURCE_CHARS and runs the
  asm, hex and bin formats on a worker thread, so the server's other
  requests keep being answered while a program is assembled.
* Programs that fit build to the same bytes as before: the gallery's
  retro-CPU examples, the ROM monitors in scripts/, and programs that end on
  the last byte of memory.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import re
import time
from pathlib import Path

import pytest

from app.services import asm8080, asmz80, rom_compile

REPO = Path(__file__).resolve().parents[3]

# SHA-256 and size of each image as the assemblers built it before the
# bound (velxio 5ed52d73).
BEFORE = {
    ("gallery", "killbitsAsm", "8080"): (28, "6686cb42bfe61410"),
    ("gallery", "larsonZ80Asm", "z80"): (26, "0a2ece32a61f2036"),
    ("gallery", "larsonScannerAsm", "z80"): (26, "a0795027ef956922"),
    ("scripts", "killbits-rom.s", "8080"): (28, "6686cb42bfe61410"),
    ("scripts", "repl-rom.s", "8080"): (328, "8f7aa97e4c60b515"),
    ("scripts", "counter-rom.s", "8080"): (34, "44393ca44925d5d2"),
    ("scripts", "larson-z80.s", "z80"): (26, "0a2ece32a61f2036"),
    ("scripts", "test-z80.s", "z80"): (22, "aaad841f0d36a5f2"),
}
EDGES = {
    ("ORG 0xFFFF\nNOP\n", "8080"): (65536, "de2f256064a0af79"),
    ("ORG 0xFFFE\nDW 0x1234\n", "8080"): (65536, "854bc37b3beb0559"),
    ("ORG 0FFF0h\nDB \"0123456789abcdef\"\n", "8080"): (65536, "a901ca1d86347b58"),
    ("ORG 0x8000\nLXI SP, 0xBFFF\nDB 'A'+1, 255\nHLT\n", "8080"): (32774, "d124d29eb0d87cf3"),
    ("ORG 0xFFFF\nNOP\n", "z80"): (65536, "de2f256064a0af79"),
    ("ORG 0xFFFD\nJP 0x0000\n", "z80"): (65536, "b7cdd74ea10391dc"),
    ("ORG 0x4000\nstart: LD A, 0x55\nJR start\nDB \"ok\", 0\n", "z80"): (16391, "7099e89dd8fbf456"),
}
OTHER_FORMATS = {
    (":0300000002000AF1\n:02FFFE00AA55FC\n:00000001FF\n", "hex"): (65536, "ba0b8c51147a5313"),
    ("3E 55 32 00 C0 76", "bin"): (6, "fc6a8b57ca6856a6"),
}


def _gallery_source(name: str) -> str:
    """A program literal of frontend/src/data/examples-retro-intel.ts, as the
    editor sends it (a template literal with no interpolation)."""
    text = (REPO / "frontend" / "src" / "data" / "examples-retro-intel.ts").read_text(encoding="utf-8")
    m = re.search(r"const " + name + r" = `((?:[^`\\]|\\.)*)`;", text)
    assert m, name
    body = m.group(1)
    assert "${" not in body
    return re.sub(r"\\([`\\$])", r"\1", body)


def _source(kind: str, name: str) -> str:
    if kind == "gallery":
        return _gallery_source(name)
    return (REPO / "scripts" / name).read_text(encoding="utf-8")


def _build(source: str, target: str, fmt: str = "asm") -> dict:
    return asyncio.run(rom_compile.compile_rom(source, target, fmt))


def _digest(result: dict) -> tuple[int, str]:
    data = base64.b64decode(result["rom_base64"])
    return len(data), hashlib.sha256(data).hexdigest()[:16]


@pytest.mark.parametrize("key", sorted(BEFORE), ids=lambda k: f"{k[0]}:{k[1]}")
def test_the_gallery_and_repo_programs_build_as_before(key):
    kind, name, target = key
    r = _build(_source(kind, name), target)
    assert r["success"] is True, r
    assert _digest(r) == BEFORE[key]


@pytest.mark.parametrize("key", sorted(EDGES), ids=lambda k: f"{k[1]}:{k[0].splitlines()[0]}")
def test_a_program_that_ends_on_the_last_byte_still_builds(key):
    source, target = key
    r = _build(source, target)
    assert r["success"] is True, r
    assert _digest(r) == EDGES[key]


@pytest.mark.parametrize("key", sorted(OTHER_FORMATS), ids=lambda k: k[1])
def test_hex_and_bin_build_as_before(key):
    source, fmt = key
    r = _build(source, "8080", fmt)
    assert r["success"] is True, r
    assert _digest(r) == OTHER_FORMATS[key]


OUTSIDE = [
    "ORG 0x2000000\nNOP\n",  # far past the end of memory
    "ORG 0x10001\n",
    "ORG 0xFFFF\nNOP\nNOP\n",
    "ORG 0xFFF0\nDB \"0123456789abcdefg\"\n",
    "ORG -1\n",
]


@pytest.mark.parametrize("target", ["8080", "z80"])
@pytest.mark.parametrize("source", OUTSIDE)
def test_a_location_outside_64k_is_an_assembly_error_found_at_once(source, target):
    t = time.process_time()
    r = _build(source, target)
    assert time.process_time() - t < 0.5
    assert r["success"] is False and "64 KB" in r["error"], r


@pytest.mark.parametrize("mod", [asm8080, asmz80], ids=["8080", "z80"])
def test_the_assemblers_bound_location_and_image(mod):
    assert mod.ADDRESS_SPACE == 0x10000
    image = mod.assemble("ORG 0x10000\n")  # the end of memory, with nothing placed there
    assert image == bytes(0x10000)
    with pytest.raises(ValueError, match="64 KB"):
        mod.assemble("ORG 0xFFFF\nDW 1\n")


def test_compile_rom_refuses_a_source_past_the_cap():
    line = "; " + "-" * 61 + "\n"  # 64 characters
    fits = line * (rom_compile.MAX_SOURCE_CHARS // len(line) - 1) + "NOP\n"
    over = line * (rom_compile.MAX_SOURCE_CHARS // len(line) + 1) + "NOP\n"
    assert len(fits) <= rom_compile.MAX_SOURCE_CHARS < len(over)
    t = time.process_time()
    r = _build(over, "8080")
    assert time.process_time() - t < 0.2
    assert r["success"] is False and f"{rom_compile.MAX_SOURCE_CHARS:,} characters" in r["error"], r
    for fmt in ("hex", "bin", "c"):
        assert _build(over, "z80", fmt)["success"] is False
    assert _build(fits, "8080")["success"] is True


def test_compile_rom_assembles_off_the_event_loop():
    source = ";\n" * 400_000 + "NOP\n"  # under the cap; most of a second of Z80 assembling

    async def main():
        gaps: list[float] = []
        running = True

        async def tick():
            last = time.monotonic()
            while running:
                await asyncio.sleep(0.005)
                now = time.monotonic()
                gaps.append(now - last)
                last = now

        ticker = asyncio.ensure_future(tick())
        await asyncio.sleep(0.02)
        started = time.monotonic()
        result = await rom_compile.compile_rom(source, "z80", "asm")
        took = time.monotonic() - started
        running = False
        await ticker
        return result, took, max(gaps)

    result, took, gap = asyncio.run(main())
    assert result["success"] is True and result["byte_size"] == 1
    assert took > 0.15  # long enough for the loop to have waited on it
    assert gap < took / 3, (gap, took)

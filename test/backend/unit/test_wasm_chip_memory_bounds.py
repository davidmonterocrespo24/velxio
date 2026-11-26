"""
What the runtime reads and writes through the address of a chip's memory
stays inside that memory.

Three things the host serves straight from a chip's linear memory take their
offset from the chip: the SPI buffer it arms (vx_spi_start, then
spi_transfer_byte and the copy _spi_sync writes back), the peek flag of a bus
model (watch_peeks, _PeekGuard.peeking) and an input the host pushes with
write_memory on a wasmtime without the unchecked call. Each is checked the way
read_memory and write_memory check theirs: a buffer the memory does not hold
arms nothing (the line idles high, no on_done, one chip_error line), a flag
outside it is no flag, a push outside it raises IndexError. A chip whose
buffers are its own sees no difference (the SPI suites around this file).

The cases run in a child process so that a regression fails a test instead of
ending the run.
"""
from __future__ import annotations

import json
import subprocess
import sys

import pytest

pytest.importorskip("wasmtime")

MEM = 2 * 65536  # the runtime's memory at chip_setup: two pages

# vx_spi_config at 64: sck 0, mosi 1, miso 2, cs none, mode 0, no callbacks;
# 0x40.. at 256 is the chip's own buffer. arm(ptr, count) is vx_spi_start.
_FILL = "".join(f"\\{b:02x}" for b in range(0x40, 0x60))
# The sixteen zero bytes are built out here: before Python 3.12 an expression
# inside an f-string cannot hold a backslash (a SyntaxError), and CI runs this
# file on 3.11, where it ended the whole run at collection.
_ZEROS = "\\00" * 16
ARMING_CHIP = f"""(module
  (import "env" "memory" (memory 2))
  (import "env" "vx_spi_attach" (func $attach (param i32) (result i32)))
  (import "env" "vx_spi_start" (func $start (param i32 i32 i32)))
  (data (i32.const 64) "\\00\\00\\00\\00\\01\\00\\00\\00\\02\\00\\00\\00\\ff\\ff\\ff\\ff{_ZEROS}")
  (data (i32.const 256) "{_FILL}")
  (func (export "chip_setup") (drop (call $attach (i32.const 64))))
  (func (export "arm") (param $p i32) (param $n i32)
    (call $start (i32.const 0) (local.get $p) (local.get $n))))"""

# A bus model: says where its peek flag is, and calls the host.
PEEK_MODEL = """(module
  (import "env" "memory" (memory 2))
  (import "env" "vx_sim_now_nanos" (func $now (result i64)))
  (global $flag (mut i32) (i32.const 0))
  (func (export "chip_setup"))
  (func (export "set_flag") (param $f i32) (global.set $flag (local.get $f)))
  (func (export "chip_i2c_guard") (result i32) (global.get $flag))
  (func (export "poke") (result i32) (i32.wrap_i64 (call $now))))"""

CHILD = r"""
import json, sys
cfg = json.loads(sys.argv[1])
sys.path[:0] = cfg["sys_path"]
import wasmtime
import app.services.wasm_chip_runtime as wcr
out = {}

def spi(name, ptr, count, n):
    print("spi", name, flush=True)
    events = []
    rt = wcr.WasmChipRuntime(wasmtime.wat2wasm(cfg["arming"]), {}, events.append)
    rt.run_chip_setup()
    for _ in range(2):
        rt._drop_mem_view()
        rt._exports["arm"](rt._store, ptr, count)
    miso = bytes(rt.spi_transfer_byte(0x5A) & 0xFF for _ in range(n))
    rt._drop_mem_view()
    rt._exports["arm"](rt._store, 256, 4)
    again = bytes(rt.spi_transfer_byte(0) & 0xFF for _ in range(4))
    out[name] = {"miso": miso.hex(), "again": again.hex(),
                 "errors": [e["where"] for e in events if e.get("type") == "chip_error"]}

def sync(name, moved_to):
    print("sync", name, flush=True)
    rt = wcr.WasmChipRuntime(wasmtime.wat2wasm(cfg["arming"]), {}, None)
    rt.run_chip_setup()
    rt._drop_mem_view()
    rt._exports["arm"](rt._store, 256, 40)
    for i in range(3):
        rt.spi_transfer_byte(0xA0 + i)
    rt._spi_handles[0].ptr = moved_to   # a span that never went through vx_spi_start
    rt._drop_mem_view()
    out[name] = rt.read_memory(256, 4).hex()

def peek(name, flag, by_hand):
    print("peek", name, flush=True)
    rt = wcr.WasmChipRuntime(wasmtime.wat2wasm(cfg["peek"]), {}, None, share_module=True)
    rt.run_chip_setup()
    rt._drop_mem_view()
    rt._exports["set_flag"](rt._store, flag)
    if by_hand:
        rt._peek_guard.flag_at = flag
        watched = None
    else:
        watched = rt.watch_peeks(rt.call_export("chip_i2c_guard"))
    rt.call_export("poke")
    out[name] = watched

def push(name, ptr, unchecked_call):
    print("push", name, flush=True)
    rt = wcr.WasmChipRuntime(wasmtime.wat2wasm(cfg["arming"]), {}, None)
    rt.run_chip_setup()
    keep = wcr._RAW_CALL
    if not unchecked_call:
        wcr._RAW_CALL = None
    try:
        rt.write_memory(ptr, b"\x41" * 8)
        out[name] = "written"
    except IndexError:
        out[name] = "IndexError"
    finally:
        wcr._RAW_CALL = keep

for case in cfg["cases"]:
    globals()[case[0]](*case[1:])
print("RESULT " + json.dumps(out), flush=True)
"""


def in_child(cases: list) -> dict:
    cfg = {"sys_path": list(sys.path), "arming": ARMING_CHIP, "peek": PEEK_MODEL, "cases": cases}
    proc = subprocess.run([sys.executable, "-c", CHILD, json.dumps(cfg)],
                          capture_output=True, text=True, timeout=180)
    tail = (proc.stdout + proc.stderr).strip().splitlines()[-6:]
    assert proc.returncode == 0, f"the child ended with {proc.returncode}: {tail}"
    line = [x for x in proc.stdout.splitlines() if x.startswith("RESULT ")][-1]
    return json.loads(line[len("RESULT "):])


def test_an_spi_buffer_outside_the_memory_arms_nothing_and_the_chip_is_told_once():
    out = in_child([
        ["spi", "below the start", -(1 << 20), 64, 64],
        ["spi", "past the end", MEM + (1 << 20), 64, 64],
        ["spi", "a gigabyte", 0, 1 << 30, 64],
        ["spi", "one byte too many", MEM - 16, 17, 17],
        ["spi", "short, past the end", MEM, 4, 4],
        ["spi", "the last sixteen bytes", MEM - 16, 16, 16],
    ])
    for name in ("below the start", "past the end", "a gigabyte", "one byte too many",
                 "short, past the end"):
        n = len(bytes.fromhex(out[name]["miso"]))
        assert out[name]["miso"] == "ff" * n, name
        # Two refused arms, one line; and the chip's own buffer still works.
        assert out[name]["errors"] == ["spi_start"], name
        assert out[name]["again"] == "40414243", name
    assert out["the last sixteen bytes"] == {"miso": "00" * 16, "again": "40414243", "errors": []}


def test_the_copy_of_a_long_buffer_is_written_back_only_inside_the_memory():
    out = in_child([
        ["sync", "kept", 256],
        ["sync", "moved below", -(1 << 20)],
        ["sync", "moved beyond", MEM + (1 << 20)],
    ])
    assert out["kept"] == "a0a1a243"          # the master's bytes went back
    assert out["moved below"] == "40414243"   # and nothing was written anywhere
    assert out["moved beyond"] == "40414243"


def test_a_peek_flag_outside_the_memory_is_no_flag():
    out = in_child([
        ["peek", "inside", 0x100, False],
        ["peek", "below", -(1 << 20), False],
        ["peek", "beyond", MEM + (1 << 20), False],
        ["peek", "below, set by hand", -(1 << 20), True],
        ["peek", "beyond, set by hand", (1 << 31) - 1, True],
    ])
    assert out["inside"] is True
    assert out["below"] is False and out["beyond"] is False
    assert out["below, set by hand"] is None and out["beyond, set by hand"] is None


def test_a_push_outside_the_memory_raises_on_both_paths():
    out = in_child([
        ["push", "inside", 1024, False],
        ["push", "below", -(1 << 20), False],
        ["push", "beyond", MEM + (1 << 20), False],
        ["push", "beyond, unchecked call", MEM + (1 << 20), True],
    ])
    assert out["inside"] == "written"
    assert out["below"] == out["beyond"] == out["beyond, unchecked call"] == "IndexError"

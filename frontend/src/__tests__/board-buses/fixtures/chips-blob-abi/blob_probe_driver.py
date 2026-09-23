"""Replay the shared vx_blob_* table against a Python host (board-buses F4).

Lives next to the artifact and the table it drives, because the point of the
fixture is that ONE wasm and ONE list of expected answers reach every host. The
two Python suites (the QEMU worker's and the Linux boards') import this; the
browser suite does the same walk in TypeScript.

Both Python hosts run the chip through WasmChipRuntime, so one driver serves
them: the Linux-board adapter hands over its `.runtime`.
"""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
WASM = HERE / "blob-probe.wasm"
TABLE = json.loads((HERE / "expectations.json").read_text())


class BlobProbe:
    """The probe surface blob-probe.c exports, plus the memory poke a write
    needs to have something to store."""

    def __init__(self, runtime):
        self.rt = runtime

    def _call(self, name: str, *args: int) -> int:
        return self.rt._exports[name](self.rt._store, *args)

    def setup_size(self) -> int:
        return self._call("setup_size")

    def scratch(self, n: int) -> bytes:
        return self.rt._read_bytes(self._call("scratch_ptr"), n)

    def poke(self, data: bytes) -> None:
        self.rt._write_bytes(self._call("scratch_ptr"), data)

    def step(self, step: dict) -> int:
        if step["op"] == "size":
            return self._call("blob_size", step["which"])
        if step["op"] == "read":
            return self._call("blob_read", step["which"], step["offset"], step["len"])
        if step["op"] == "write":
            return self._call("blob_write", step["which"], step["offset"], step["len"])
        raise AssertionError(f"not a probe call: {step['op']}")


def replay(probe: BlobProbe, steps=None) -> list[str]:
    """Walk the table. Returns one line per row that answered differently, so a
    failing host names every divergence at once instead of the first."""
    bad: list[str] = []
    for i, st in enumerate(steps if steps is not None else TABLE["steps"]):
        if st["op"] == "poke":
            probe.poke(bytes.fromhex(st["hex"]))
            continue
        got = probe.step(st)
        if got != st["ret"]:
            bad.append(f"step {i} {st}: returned {got}, table says {st['ret']}")
        want = st.get("scratchHex")
        if want is not None:
            seen = probe.scratch(len(want) // 2).hex()
            if seen != want:
                bad.append(f"step {i} {st}: scratch {seen}, table says {want}")
    return bad

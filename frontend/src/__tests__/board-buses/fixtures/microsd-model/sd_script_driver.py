"""Replay the shared microSD table against a Python host (board-buses F4).

Lives next to the artifact and the table it drives, because the point of the
fixture is that ONE wasm and ONE list of expected answers reach every host: the
browser runtime, the ESP32 / STM32 worker runtime, and whatever the Linux-board
host grows for SPI responders. The browser suite does the same walk in
TypeScript, through a real engine.

The driver plays the part the bus fabric plays in production: it clocks the
chip only while chip select is asserted, and it tells the chip about the
select's edges. It never interprets a byte, so a model that answers wrongly
answers wrongly here too.
"""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
WASM = (HERE.parents[4] / "public" / "bus-chips" / "microsd.wasm")
SOURCE = (HERE.parents[3] / "simulation" / "buses" / "models" / "microsd.c")
MANIFEST = (HERE.parents[3] / "simulation" / "buses" / "models" / "manifest.json")
TABLE = json.loads((HERE / "sd-script.json").read_text())

SECTOR = 512
#: GPIO numbers this driver pretends the card's four legs are wired to. Any
#: numbers do; they only have to agree between the pin map and the edges.
PINS = {"SCK": 13, "DI": 11, "DO": 12, "CS": 10}


def build_card() -> bytes:
    """The table's card image, built from the rule the table states."""
    spec = TABLE["card"]
    n = spec["sectors"]
    return bytes((s * 37 + o) & 0xFF for s in range(n) for o in range(SECTOR))


def step_mosi(step: dict) -> bytes:
    """The bytes a step clocks out: its hex chunks, then its trailing fill."""
    out = bytearray()
    for chunk in step.get("mosi", []):
        if isinstance(chunk, dict):
            out += bytes.fromhex(chunk["byte"]) * chunk["times"]
        else:
            out += bytes.fromhex(chunk)
    out += b"\xff" * step.get("clock", 0)
    return bytes(out)


def check(step: dict, miso: bytes, label: str) -> list[str]:
    """Every expectation of one step that the answer did not meet."""
    bad: list[str] = []
    for exp in step.get("expect", []):
        at, want = exp["at"], exp["is"]
        got = miso[at:at + len(want) // 2].hex()
        if got != want:
            bad.append(
                f"{label}: at {at} got {got or '<short>'}, table says {want}"
                f"  ({step['why']})"
            )
    return bad


class ScriptRun:
    """One host's walk through one script.

    `transfer` clocks a byte and returns MISO; `select` reports a chip-select
    edge. A host supplies those two and nothing else.
    """

    def __init__(self, transfer, select):
        self._transfer = transfer
        self._select = select
        self.selected = False

    def play(self, script: dict) -> list[str]:
        bad: list[str] = []
        for i, step in enumerate(script["steps"]):
            cs = step.get("cs")
            if cs is not None:
                self.selected = cs == "low"
                self._select(self.selected)
            mosi = step_mosi(step)
            if not mosi:
                continue
            assert self.selected, f"step {i} clocks bytes with chip select released"
            miso = bytes(self._transfer(b) for b in mosi)
            bad += check(step, miso, f"step {i}")
        return bad

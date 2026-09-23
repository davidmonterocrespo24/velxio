"""
Board buses F4: the portable microSD model in the QEMU WORKER host.

QEMU asks for each byte's MISO synchronously and cannot wait for the browser,
so a card hosted in the tab always answers too late. The card therefore runs
next to the CPU, as one compiled model
(frontend/src/simulation/buses/models/microsd.c) that every host runs. This
suite is the worker half of the proof; the browser half is

  frontend/src/__tests__/board-buses/board-buses-microsd-model.test.ts

and it drives the same artifact through a real AVR engine and real Arduino
SD.h firmware. Both replay the same table
(frontend/src/__tests__/board-buses/fixtures/microsd-model/sd-script.json),
which is written from the SD spec and not from any runtime, so the two fail
rather than agreeing on a wrong answer.

What this file does NOT prove: that the worker's own fabric picks the right
responder for a chip select, and that a card reaches this runtime at all on the
QEMU path. Those are the worker's wiring, not the model's, and they are
somebody else's file (esp32_worker.py, stm32_worker.py).
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest

pytest.importorskip("wasmtime")

from app.services.wasm_chip_runtime import WasmChipRuntime  # noqa: E402

FIXTURES = (Path(__file__).resolve().parents[3]
            / "frontend" / "src" / "__tests__" / "board-buses"
            / "fixtures" / "microsd-model")
sys.path.insert(0, str(FIXTURES))
from sd_script_driver import (  # noqa: E402
    MANIFEST, PINS, SOURCE, TABLE, WASM, ScriptRun, build_card,
)

CARD = build_card()


class WorkerHost:
    """The worker's side of the bus, reduced to what the model needs: the
    per-byte hook the QEMU SPI callback lands on, and the GPIO notification the
    chip's chip-select watch hangs off."""

    def __init__(self, script: dict):
        blobs = None if script.get("noCard") else {"card": CARD}
        self.rt = WasmChipRuntime(
            WASM.read_bytes(),
            attrs={k: float(v) for k, v in script.get("attrs", {}).items()},
            pin_map=dict(PINS),
            pin_reader=lambda gpio: self.levels.get(gpio, 0),
            blobs=blobs,
        )
        # Chip select rests high, as its pull-up holds it, so the first assert
        # is a real falling edge and the first release a real rising one.
        self.levels = {PINS["CS"]: 1}
        self.rt.run_chip_setup()

    def transfer(self, mosi: int) -> int:
        return self.rt.spi_transfer_byte(mosi)

    def select(self, active: bool) -> None:
        self.levels[PINS["CS"]] = 0 if active else 1
        self.rt.notify_pin_change(PINS["CS"], self.levels[PINS["CS"]])


def run(name: str) -> tuple[WorkerHost, list[str]]:
    script = TABLE["scripts"][name]
    host = WorkerHost(script)
    bad = ScriptRun(host.transfer, host.select).play(script)
    return host, bad


def test_the_committed_wasm_was_built_from_the_committed_source():
    # The model is product code, not a fixture: a stale .wasm means this suite
    # and the browser one are testing a binary nobody can rebuild from the tree.
    manifest = json.loads(MANIFEST.read_text())
    sha = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    assert sha == manifest["microsd"]["sourceSha256"], "run models/build.sh"


def test_a_standard_capacity_card_answers_every_row_of_the_table():
    _host, bad = run("sdsc")
    assert bad == []


def test_the_guest_writes_land_in_the_blob_the_panel_reads():
    # The card IS the blob: this is the whole reason the vx_blob_* ABI exists,
    # and on this host it is what the worker ships back to the tab. The whole
    # card is compared, not just the written sectors, so a model that wrote one
    # byte too far differs here.
    host, bad = run("sdsc")
    assert bad == []
    expected = bytearray(CARD)
    for w in TABLE["scripts"]["sdsc"]["after"]["writes"]:
        expected[w["offset"]:w["offset"] + len(w["hex"]) // 2] = bytes.fromhex(w["hex"])
    assert bytes(host.rt.blob_bytes("card")) == bytes(expected)


def test_only_the_written_sector_is_reported_dirty():
    # The host ships the touched span, not a megabyte image, so a model that
    # reported the whole card would flood the link on every sector.
    host, bad = run("sdsc")
    assert bad == []
    dirty = {k: list(v) for k, v in host.rt.take_blob_dirty().items()}
    assert dirty == TABLE["scripts"]["sdsc"]["after"]["dirty"]
    assert host.rt.take_blob_dirty() == {}


def test_a_high_capacity_card_addresses_in_blocks():
    # CMD17 with argument 3 reads sector 3 here and sector 0 on the standard
    # card above: the same table proves both halves of the addressing rule.
    _host, bad = run("sdhc")
    assert bad == []


def test_a_slot_with_no_card_image_drives_nothing():
    host, bad = run("empty")
    assert bad == []
    assert host.rt.blob_bytes("card") is None

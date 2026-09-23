"""
Board buses F4: the vx_blob_* ABI in the QEMU WORKER host (WasmChipRuntime).

Named byte storage is how a portable microSD model gets its card image and how
the guest's writes get back to the card panel. F4 runs responders next to the
CPU, which on the ESP32 and STM32 boards means this runtime, so the model that
answers in the browser has to answer identically here.

This suite is one of three that replay the SAME table against the SAME
artifact (frontend/src/__tests__/board-buses/fixtures/chips-blob-abi/):

  board-buses-blob-abi.test.ts                            browser
  this file                                               QEMU worker
  velxio-prod pro/backend/tests/unit/
      test_board_buses_blob_abi_pi.py                     Linux boards

The table is written from backend/sdk/velxio-chip.h, not from any runtime, so
all three fail rather than agreeing on a wrong answer.
"""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest

wasmtime = pytest.importorskip("wasmtime")

from app.services.wasm_chip_runtime import WasmChipRuntime, decode_blobs  # noqa: E402

FIXTURES = (Path(__file__).resolve().parents[3]
            / "frontend" / "src" / "__tests__" / "board-buses"
            / "fixtures" / "chips-blob-abi")
sys.path.insert(0, str(FIXTURES))
from blob_probe_driver import TABLE, WASM, BlobProbe, replay  # noqa: E402

BLOB = bytes.fromhex(TABLE["blobHex"])
NAME = TABLE["blobName"]


def make_chip(blobs=None) -> tuple[WasmChipRuntime, BlobProbe]:
    rt = WasmChipRuntime(WASM.read_bytes(), attrs={}, blobs=blobs)
    rt.run_chip_setup()
    return rt, BlobProbe(rt)


def declared() -> dict[str, bytes]:
    return {NAME: BLOB}


def test_the_committed_wasm_was_built_from_the_committed_source():
    manifest = __import__("json").loads((FIXTURES / "manifest.json").read_text())
    sha = hashlib.sha256((FIXTURES / "blob-probe.c").read_bytes()).hexdigest()
    assert sha == manifest["blob-probe"]["sourceSha256"]


def test_the_blob_is_there_while_chip_setup_runs():
    # A card model sizes its storage during setup; a host that only wires the
    # blob up afterwards hands it a card of zero sectors.
    _, probe = make_chip(declared())
    assert probe.setup_size() == TABLE["setupSize"]


def test_answers_every_row_of_the_cross_host_table():
    _, probe = make_chip(declared())
    assert replay(probe) == []


def test_leaves_the_blob_holding_exactly_what_the_chip_wrote():
    rt, probe = make_chip(declared())
    replay(probe)
    assert rt.blob_bytes(NAME).hex() == TABLE["finalBlobHex"]


def test_reports_the_touched_span_once_and_then_nothing():
    # The worker ships the span back to the tab, so it needs where, not just
    # whether; and a span already shipped must not go a second time.
    rt, probe = make_chip(declared())
    replay(probe)
    assert rt.take_blob_dirty() == {k: tuple(v) for k, v in TABLE["dirty"].items()}
    assert rt.take_blob_dirty() == {}


def test_copies_the_caller_bytes_in():
    # The browser runtime copies too. A host that aliased the config's bytes
    # would let one chip's writes rewrite what a later chip is handed.
    source = bytearray(BLOB)
    rt, probe = make_chip({NAME: source})
    probe.poke(b"\xaa\xbb")
    assert probe.step({"op": "write", "which": 0, "offset": 2, "len": 2}) == 2
    assert bytes(source) == BLOB
    assert rt.blob_bytes(NAME)[2:4] == b"\xaa\xbb"


def test_a_chip_whose_host_declared_no_blob_gets_nothing():
    rt, probe = make_chip()
    assert probe.step({"op": "size", "which": 0}) == 0
    assert probe.step({"op": "read", "which": 0, "offset": 0, "len": 4}) == 0
    assert probe.step({"op": "write", "which": 0, "offset": 0, "len": 4}) == 0
    assert rt.blob_bytes(NAME) is None


def test_storage_is_per_instance():
    a_rt, a = make_chip(declared())
    b_rt, b = make_chip(declared())
    a.poke(b"\xaa\xbb")
    assert a.step({"op": "write", "which": 0, "offset": 0, "len": 2}) == 2
    assert b_rt.blob_bytes(NAME) == BLOB
    assert b.step({"op": "read", "which": 0, "offset": 0, "len": 2}) == 2
    assert b.scratch(2) == BLOB[:2]


def test_the_wire_carries_blobs_base64_and_one_decoder_reads_them():
    # Every host builds its runtime from the same JSON config, so the base64
    # the browser sends has to land as the same bytes wherever it is read.
    import base64
    raw = {NAME: base64.b64encode(BLOB).decode("ascii")}
    assert decode_blobs(raw) == {NAME: BLOB}
    assert decode_blobs({NAME: BLOB}) == {NAME: BLOB}
    assert decode_blobs(None) == {}
    _, probe = make_chip(decode_blobs(raw))
    assert probe.setup_size() == TABLE["setupSize"]

"""
The runtime's per-byte SPI path for a LONG armed buffer
(project/board-buses-2026-09, F4, the second half of the worker SD cost).

A QEMU guest reads MISO one callback per byte. For a streamed card sector
that is 515 calls into WasmChipRuntime.spi_transfer_byte, and each used to
read and write the chip's buffer through the ctypes view of wasm memory,
which cost more than the rest of the call. A buffer of at least
_SPI_CACHE_MIN bytes is now served from a Python copy, taken on its first
byte and written back before wasm runs again.

The copy must be invisible to the chip. These tests hold that with a chip
that arms a 40-byte buffer and logs, in on_done, exactly what arrived
(fixtures/board_buses_worker/block-probe.c):

  - MISO is the buffer the chip filled, byte for byte;
  - a full buffer reaches on_done with every MOSI byte in it;
  - a transfer the chip stops part-way (CS rising, which runs the chip's pin
    watch and so wasm, in the middle of a copied buffer) reaches on_done with
    the MOSI clocked so far, and the next one starts clean;
  - the copy is used at all, so the cost it removes stays removed.
"""
from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("wasmtime")

from app.services.wasm_chip_runtime import WasmChipRuntime  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "board_buses_worker" / "block-probe.wasm"
LEN = 40
CS = 7


class Host:
    def __init__(self) -> None:
        self.levels = {CS: 1}
        self.logs: list[str] = []

        def emit(ev: dict) -> None:
            if ev.get("type") == "chip_log":
                self.logs.append(ev["text"].strip())

        self.rt = WasmChipRuntime(
            FIXTURE.read_bytes(), {"sig": 0x30}, emit,
            pin_map={"CS": CS, "SCK": 1, "MOSI": 2, "MISO": 3},
            pin_reader=lambda g: self.levels.get(g, 1),
        )
        self.rt.run_chip_setup()
        # A watch starts from the pin's registered value (0), not from what
        # the reader says, so the first falling edge would be no edge at all.
        # The worker hears the guest drive CS high before it selects; so does
        # this host.
        self.cs(1)

    def cs(self, level: int) -> None:
        self.levels[CS] = level
        self.rt.notify_pin_change(CS, level)

    def clock(self, mosi: list[int]) -> list[int]:
        return [self.rt.spi_transfer_byte(b) for b in mosi]


def rx(n: int, data: list[int]) -> str:
    return f"block 30 n={n} rx=" + " ".join(f"{b:02x}" for b in data)


def test_a_long_buffer_answers_what_the_chip_filled_and_hears_every_byte():
    h = Host()
    h.cs(0)
    mosi = [(i * 11 + 5) & 0xFF for i in range(LEN)]
    assert h.clock(mosi) == [(0x30 + i) & 0xFF for i in range(LEN)]
    assert h.logs == [rx(LEN, mosi)]


def test_the_chip_rearms_from_on_done_and_the_next_buffer_is_its_own():
    h = Host()
    h.cs(0)
    first = list(range(LEN))
    second = [0xFF - i for i in range(LEN)]
    assert h.clock(first + second) == [(0x30 + i) & 0xFF for i in range(LEN)] * 2
    assert h.logs == [rx(LEN, first), rx(LEN, second)]


def test_a_transfer_stopped_part_way_reaches_on_done_with_what_was_clocked():
    # CS rising runs the chip's watch, which is wasm, in the middle of a buffer
    # the host is serving from its copy: the chip must find the bytes there.
    h = Host()
    h.cs(0)
    part = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]
    assert h.clock(part) == [0x30 + i for i in range(len(part))]
    h.cs(1)
    assert h.logs == [rx(len(part), part)]
    h.logs.clear()
    h.cs(0)
    again = [0xA5] * LEN
    assert h.clock(again) == [(0x30 + i) & 0xFF for i in range(LEN)], 'a fresh buffer'
    assert h.logs == [rx(LEN, again)]


def test_a_long_buffer_is_served_from_the_copy():
    # The saving itself: two trips through the memory view per buffer (the
    # copy in, the MOSI back), not two per byte.
    h = Host()
    h.cs(0)
    calls = {"n": 0}
    real = h.rt._mem_view

    def counting():
        calls["n"] += 1
        return real()

    h.rt._mem_view = counting
    h.rt._mem_view_cache = None
    h.clock([0] * LEN)
    assert calls["n"] <= 2, f"{calls['n']} trips through the view for one {LEN}-byte buffer"
    # Counting trips alone cannot tell the copy from the cached view, which
    # also takes one trip per buffer and then pays a ctypes read and write on
    # every byte. The copy is what the middle of a buffer is served from.
    h.cs(1)
    h.cs(0)
    h.clock([0])
    assert h.rt._spi_cache is not None, "the rest of the buffer is served through the view"

"""
test_board_buses_f4_bus_attrs.py: the live inputs of a responder hosted in the
ESP32 QEMU worker (project/board-buses-2026-09, F4).

A responder that has to answer the guest runs beside it as a portable model,
shipped in the bus map. Its inputs are live: the finger on a touch panel, the
voltage the tab's circuit solve puts on an ADC channel, a thermocouple
slider. The map cannot carry them, because it goes once per membership change
and carries every model's artifact; so they travel on their own, as
`bus_attrs {owner, attrs}`, into the same `update_attrs` a custom chip's live
controls reach.

What is pinned here, on the same rig as the other F4 worker suites (the real
worker process, libqemu stubbed at ctypes, a real model):

  - the guest's NEXT transaction reads the new value, with the model kept (no
    rebuild: its frame state and counters survive);
  - the update reaches only the owner it names, so two instances of one part
    each keep their own input;
  - what is not a number, or names nobody, is dropped without touching a model
    that is running;
  - a map published after an update carries its own values, and those are the
    ones that stand.

The latency of an update (command in, next read changed) is measured by the
harness project/board-buses-2026-09/harness/bus-attrs-latency.py, not here: a
wall-clock bound in a unit test only measures the machine it runs on.
"""
from __future__ import annotations

from .test_board_buses_f4_worker import pin_cs, probe_entry, select
from .test_board_buses_repro_worker import (  # noqa: F401  (worker fixture)
    CHIP_A_CS,
    CHIP_B_CS,
    Worker,
    worker,
)


def first_byte(w: Worker, gpio: int) -> int:
    """One transaction on `gpio`'s select: the probe answers `sig` first."""
    select(w, gpio)
    out = w.spi([0x00, 0x00])
    w.pin(gpio, 1)
    return out[0]


def attrs(w: Worker, owner: str, values) -> None:
    w.send({'cmd': 'bus_attrs', 'owner': owner, 'attrs': values})
    w.sync()


class TestBusAttrs:

    def test_setup_the_probe_answers_its_published_attribute(self, worker):
        """The rig: the model loaded from the map, and its first byte is the
        attribute the map carried, so a change below is a change of input and
        not a model that was never there."""
        w = worker(bus_map={'spi': [probe_entry('a', pin_cs(CHIP_A_CS), 0xA0)]})
        assert first_byte(w, CHIP_A_CS) == 0xA0

    def test_the_next_transaction_reads_the_new_value(self, worker):
        w = worker(bus_map={'spi': [probe_entry('a', pin_cs(CHIP_A_CS), 0xA0)]})
        assert first_byte(w, CHIP_A_CS) == 0xA0
        attrs(w, 'a', {'sig': 0x30})
        assert first_byte(w, CHIP_A_CS) == 0x30

    def test_the_model_is_updated_in_place_not_rebuilt(self, worker):
        """A rebuilt model would log its setup again and lose everything it
        holds (an SD card's writes, a register a driver configured). An input
        is not a new device."""
        w = worker(bus_map={'spi': [probe_entry('a', pin_cs(CHIP_A_CS), 0xA0)]})
        ready = w.chip_log().count('spi probe ready')
        attrs(w, 'a', {'sig': 0x30})
        assert first_byte(w, CHIP_A_CS) == 0x30
        assert w.chip_log().count('spi probe ready') == ready

    def test_an_update_reaches_only_the_owner_it_names(self, worker):
        w = worker(bus_map={'spi': [probe_entry('a', pin_cs(CHIP_A_CS), 0xA0),
                                    probe_entry('b', pin_cs(CHIP_B_CS), 0xB0)]})
        attrs(w, 'b', {'sig': 0x40})
        assert first_byte(w, CHIP_A_CS) == 0xA0
        assert first_byte(w, CHIP_B_CS) == 0x40

    def test_an_owner_nobody_hosts_changes_nothing(self, worker):
        """An update can overtake the map that would host its owner; it is
        dropped, and the map that follows carries the same values."""
        w = worker(bus_map={'spi': [probe_entry('a', pin_cs(CHIP_A_CS), 0xA0)]})
        attrs(w, 'ghost', {'sig': 0x11})
        assert first_byte(w, CHIP_A_CS) == 0xA0

    def test_values_that_are_not_numbers_are_dropped(self, worker):
        w = worker(bus_map={'spi': [probe_entry('a', pin_cs(CHIP_A_CS), 0xA0)]})
        attrs(w, 'a', {'sig': 'lots'})
        attrs(w, 'a', {'sig': True})
        attrs(w, 'a', None)
        assert first_byte(w, CHIP_A_CS) == 0xA0

    def test_a_map_published_after_an_update_carries_its_own_values(self, worker):
        """The tab builds every map with the inputs as they are then, so the
        map is the newer word and wins over an older update."""
        w = worker(bus_map={'spi': [probe_entry('a', pin_cs(CHIP_A_CS), 0xA0)]})
        attrs(w, 'a', {'sig': 0x30})
        w.send({'cmd': 'bus_map', 'spi': [probe_entry('a', pin_cs(CHIP_A_CS), 0x50)]})
        w.sync()
        assert first_byte(w, CHIP_A_CS) == 0x50


# ── The hop before the worker: the lib manager writes the command ───────────

class _Stdin:
    def __init__(self) -> None:
        self.lines: list[bytes] = []

    def write(self, data: bytes) -> None:
        self.lines.append(data)

    def flush(self) -> None:
        pass


def test_the_lib_manager_hands_the_worker_one_bus_attrs_line():
    """`esp32_bus_attrs` from the tab becomes one `bus_attrs` command on the
    worker's stdin, owner and values untouched. The route in simulation.py
    that calls this imports fastapi, which this host does not have."""
    import json
    import threading
    from types import SimpleNamespace

    from app.services.esp32_lib_manager import EspLibManager

    mgr = EspLibManager()
    stdin = _Stdin()
    mgr._instances['c1'] = SimpleNamespace(
        process=SimpleNamespace(stdin=stdin, returncode=None),
        stdin_lock=threading.Lock(), running=True)
    mgr.set_bus_attrs('c1', 'tft1:touch', {'x': 0.25, 'touched': 1})
    mgr.set_bus_attrs('nobody', 'tft1:touch', {'x': 0.5})
    assert [json.loads(line) for line in stdin.lines] == [
        {'cmd': 'bus_attrs', 'owner': 'tft1:touch', 'attrs': {'x': 0.25, 'touched': 1}},
    ]

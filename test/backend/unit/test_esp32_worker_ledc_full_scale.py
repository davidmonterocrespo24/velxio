"""
test_esp32_worker_ledc_full_scale.py: an LEDC channel at full duty reaches the
tab as 100 %, not 100.39 % (velxio/velxio-prod#174).

ESP-IDF's LEDC takes a duty of 0 .. 2**duty_resolution, and 2**N is full on.
arduino-esp32 3.3.10's ledcWrite writes exactly that for the top value
("LEDC FULL ON": ledcWrite(pin, 255) at 8 bits writes 256). The QEMU fork
(hw/misc/esp32_ledc.c, frozen) divides the duty register by 2**N - 1, so it
keeps 100.39 % in its float duty table. The worker's IRQ path already refused
a value above 100, but its 100 ms poll of that table forwarded it as is, and
the circuit stamped duty * 3.3 V = 3.313 V on the pin.

The worker runs unmodified on the repro suite's rig
(fixtures/board_buses_worker/fake_libqemu.py), whose `ledc` op sets the
fork's float duty table the poll reads.
"""
from __future__ import annotations

import pytest

pytest.importorskip('wasmtime', reason='the custom-chip runtime needs wasmtime')

from .test_board_buses_repro_worker import Worker  # noqa: E402


@pytest.fixture
def worker(tmp_path):
    w = Worker(tmp_path)
    w.boot()
    yield w
    w.close()


def duties(w: Worker, channel: int) -> list[float]:
    return [e['duty_pct'] for e in w.events('ledc_duty') if e['channel'] == channel]


def test_full_on_is_reported_as_100_percent(worker):
    worker.guest('ledc', channel=0, duty=100 * 256 / 255)  # 100.39 %
    assert worker.wait_for(lambda: duties(worker, 0), 3.0), 'the LEDC poll never reported channel 0'
    assert duties(worker, 0)[-1] == 100.0


def test_a_duty_below_full_scale_is_reported_as_the_fork_keeps_it(worker):
    worker.guest('ledc', channel=3, duty=50.0)
    assert worker.wait_for(lambda: duties(worker, 3), 3.0)
    assert duties(worker, 3)[-1] == 50.0


def test_both_paths_report_full_on_as_100_percent(worker):
    # esp32_ledc.c raises 0x5000 | ch << 8 | the integer percent right after
    # it stored the float, and the poll reads the same float 100 ms later.
    worker.guest('ledc', channel=1, duty=100 * 256 / 255)
    worker.guest('dir', slot=-1, value=0x5000 | (1 << 8) | 100)
    assert worker.wait_for(lambda: len(duties(worker, 1)) >= 2, 3.0), duties(worker, 1)
    assert set(duties(worker, 1)) == {100.0}

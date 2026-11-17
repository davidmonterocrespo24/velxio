"""
test_esp32_worker_adc_millivolts.py: the QEMU worker converts the pad voltage
the tab sends, not that voltage cut to whole millivolts (velxio/velxio-prod#171).

The tab hands the worker the voltage the circuit solved on an ADC pad, in
millivolts with their fraction (a pot at 512 of 1023 on 3.3 V is 1651.6 mV).
The worker turns it into the 12-bit code the guest's SAR ADC reads
(qemu_picsimlab_set_apin), linearly over 0-3300 mV. It used to cut the
millivolts to an integer first, so a 12-bit step (0.806 mV) was skipped every
few millivolts: 795 of the 4096 codes never came out, whatever the circuit did.

The worker runs unmodified on the repro suite's rig
(fixtures/board_buses_worker/fake_libqemu.py), which records every
set_apin the worker makes into QEMU.
"""
from __future__ import annotations

import pytest

pytest.importorskip('wasmtime', reason='the custom-chip runtime needs wasmtime')

from .test_board_buses_repro_worker import Worker  # noqa: E402

LSB_MV = 3300 / 4095


@pytest.fixture
def worker(tmp_path):
    w = Worker(tmp_path)
    w.boot()
    yield w
    w.close()


def apin_calls(w: Worker) -> list[list[int]]:
    return [c for c in w.guest('calls')['calls'] if c[0] == 'set_apin']


def test_a_pot_at_512_reads_the_code_of_its_exact_voltage(worker):
    # 3.3 V * 512 / 1023 = 1651.61 mV -> 2049.48 -> code 2049. Cut to 1651 mV
    # first it read 2048.
    worker.send({'cmd': 'set_adc', 'channel': 6, 'millivolts': 3300 * 512 / 1023})
    worker.sync()
    assert apin_calls(worker)[-1] == ['set_apin', 6, 2049]


def test_every_code_is_reachable(worker):
    codes = list(range(0, 64)) + [2047, 2048, 2049, 4094, 4095]
    for code in codes:
        worker.send({'cmd': 'set_adc', 'channel': 0, 'millivolts': (code + 0.5) * LSB_MV})
    worker.sync()
    assert [c[2] for c in apin_calls(worker)] == codes


def test_whole_millivolts_still_convert_as_before(worker):
    for mv in (0, 1, 1650, 3300, 3400):
        worker.send({'cmd': 'set_adc', 'channel': 3, 'millivolts': mv})
    worker.sync()
    assert [c[2] for c in apin_calls(worker)] == [0, 1, 2047, 4095, 4095]


def test_a_value_that_is_no_number_leaves_the_worker_running(worker):
    worker.send({'cmd': 'set_adc', 'channel': 3, 'millivolts': None})
    worker.send({'cmd': 'set_adc', 'channel': 3, 'millivolts': 'x'})
    worker.send({'cmd': 'set_adc', 'channel': 3, 'millivolts': 100})
    worker.sync()
    assert [c[2] for c in apin_calls(worker)] == [124]

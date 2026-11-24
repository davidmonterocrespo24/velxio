"""
test_esp32_worker_adc_millivolts.py: the QEMU worker converts the pad voltage
the tab sends, not that voltage cut to whole millivolts (velxio/velxio-prod#171).

The tab hands the worker the voltage the circuit solved on an ADC pad, in
millivolts with their fraction (a pot at 512 of 1023 on 3.3 V is 1651.6 mV).
The worker turns it into the 12-bit code the guest's SAR ADC reads
(qemu_picsimlab_set_apin), linearly over 0-3300 mV. It used to cut the
millivolts to an integer first, so a 12-bit step (0.806 mV) was skipped every
few millivolts: 795 of the 4096 codes never came out, whatever the circuit did.

It also took the code below the voltage rather than the nearest one: every
voltage read up to one step (0.806 mV) low, half a step on average, which on a
libqemu that converts on the chip's curve is 0.6 code low at 12 dB and about
2 codes low at 0 dB (velxio/velxio-prod#171). The code is now the nearest one.

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
    # 3.3 V * 512 / 1023 = 1651.61 mV -> 2049.50 -> code 2050, the nearest.
    # Cut to 1651 mV first it read 2048; the code below it was 2049.
    worker.send({'cmd': 'set_adc', 'channel': 6, 'millivolts': 3300 * 512 / 1023})
    worker.sync()
    assert apin_calls(worker)[-1] == ['set_apin', 6, 2050]


def test_every_code_is_reachable_from_its_own_voltage(worker):
    # Each code's own voltage, code * 3300 / 4095 mV, reads that code. Taking
    # the code below read some of them one low, wherever the float landed a
    # hair under the code.
    codes = list(range(0, 64)) + [2047, 2048, 2049, 4094, 4095]
    for code in codes:
        worker.send({'cmd': 'set_adc', 'channel': 0, 'millivolts': code * LSB_MV})
    worker.sync()
    assert [c[2] for c in apin_calls(worker)] == codes


def test_a_voltage_reads_the_code_nearest_to_it(worker):
    # 0.3 of a step above a code reads that code; 0.7 of a step above it
    # reads the next one, where taking the code below read one low.
    for code in (0, 1, 1000, 2048, 4000):
        for frac in (0.3, 0.7):
            worker.send({'cmd': 'set_adc', 'channel': 5, 'millivolts': (code + frac) * LSB_MV})
    worker.sync()
    assert [c[2] for c in apin_calls(worker)] == [0, 1, 1, 2, 1000, 1001, 2048, 2049, 4000, 4001]


def test_whole_millivolts_convert_to_the_nearest_code(worker):
    # 1650 mV is code 2047.5: it reads 2048 (the code below read 2047).
    for mv in (0, 1, 1650, 3300, 3400, -5):
        worker.send({'cmd': 'set_adc', 'channel': 3, 'millivolts': mv})
    worker.sync()
    assert [c[2] for c in apin_calls(worker)] == [0, 1, 2048, 4095, 4095, 0]


def test_a_value_that_is_no_number_leaves_the_worker_running(worker):
    worker.send({'cmd': 'set_adc', 'channel': 3, 'millivolts': None})
    worker.send({'cmd': 'set_adc', 'channel': 3, 'millivolts': 'x'})
    worker.send({'cmd': 'set_adc', 'channel': 3, 'millivolts': 100})
    worker.sync()
    assert [c[2] for c in apin_calls(worker)] == [124]


# ── The hop before the worker: the websocket route ──────────────────────────

def test_the_route_hands_the_worker_the_millivolts_with_their_fraction(monkeypatch):
    """`esp32_adc_set` from the tab reaches the lib manager unrounded. The
    route cut it with int() first, so the worker's own fix never saw a
    fraction."""
    pytest.importorskip('fastapi')
    import json

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.routes import simulation

    calls: list[tuple[int, float]] = []
    monkeypatch.setattr(simulation.esp_lib_manager, 'is_available', lambda: True)
    monkeypatch.setattr(simulation.esp_lib_manager, 'set_adc',
                        lambda _cid, ch, mv: calls.append((ch, mv)))
    monkeypatch.setattr(simulation.esp_lib_manager, 'get_status', lambda _cid: {'ok': True})
    app = FastAPI()
    app.include_router(simulation.router)
    with TestClient(app) as client:
        with client.websocket_connect('/ws/adc-fraction') as ws:
            for mv in (3300 * 512 / 1023, 100):
                ws.send_text(json.dumps({'type': 'esp32_adc_set',
                                         'data': {'channel': 6, 'millivolts': mv}}))
            # The status reply comes after every message above was handled.
            ws.send_text(json.dumps({'type': 'esp32_status', 'data': {}}))
            assert json.loads(ws.receive_text())['type'] == 'esp32_status'
    assert calls == [(6, pytest.approx(1651.6129, abs=1e-4)), (6, 100.0)]


def test_a_millivolt_value_that_is_no_number_is_dropped_not_raised():
    """The route's reading of the value. int() on one it refuses (a NaN the
    tab sent as null) raised inside the session's loop, and the route ends
    the whole session, worker and all, on any exception there."""
    from app.services.esp32_lib_manager import adc_millivolts

    assert adc_millivolts(1651.6129) == pytest.approx(1651.6129)
    assert adc_millivolts('1650') == 1650.0
    for bad in (None, 'x', float('nan'), float('inf'), [], {}):
        assert adc_millivolts(bad) is None

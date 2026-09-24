"""
test_board_buses_f5_worker_i2c.py: the QEMU workers' I2C targets by
(controller, address) (project/board-buses-2026-09, F5-SPEC "Motores",
finding worker-i2c-slaves-ignore-bus-id).

Two layers:

  - the table itself (app/services/i2c_bus_table.py), driven directly: it is
    plain Python, shared by the ESP32 and the STM32 workers, and it holds every
    rule this file is about;
  - the ESP32 worker running unmodified on the repro suite's rig (libqemu
    replaced at the ctypes boundary, the guest played by calling the worker's
    own callbacks), for the parts only the worker has: the bus map arriving in
    the start config and as a command, and the GPIO matrix telling which
    controller a pad carries.

The rules, as the tab's fabric has them (simulation/buses/i2cBus.ts):

  - a target answers on the controller its SDA is wired to, and only there;
  - it is registered and removed by identity, never by address;
  - several targets at one address on one controller all see the START, the
    ACK is any of theirs, a read is the wired-AND, and that is reported;
  - the tab's map names the controller per owner, or the pad when it cannot
    (an ESP32's Wire1 has no default pins), and the worker resolves the pad
    against the live matrix; an owner the map lists as unplaced answers
    nothing; a record nobody placed answers anywhere, as before F5.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
SERVICES = HERE.parent.parent.parent / 'backend' / 'app' / 'services'

_spec = importlib.util.spec_from_file_location('i2c_bus_table_under_test',
                                               SERVICES / 'i2c_bus_table.py')
table_mod = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
sys.modules['i2c_bus_table_under_test'] = table_mod
_spec.loader.exec_module(table_mod)  # type: ignore[union-attr]
I2cBusTable = table_mod.I2cBusTable
NOT_ROUTED = table_mod.NOT_ROUTED

START_RECV, START_SEND, FINISH, NACK, WRITE, READ = 0x00, 0x01, 0x03, 0x04, 0x05, 0x06


class Probe:
    """A register-free target: ACKs its address (or not), answers `value` on
    every read, and logs every event it sees."""

    def __init__(self, value: int, ack: bool = True) -> None:
        self.value = value
        self.ack = ack
        self.log: list[int] = []

    def handle_event(self, event: int) -> int:
        self.log.append(event & 0xFF)
        op = event & 0xFF
        if op in (START_RECV, START_SEND):
            return 0 if self.ack else 1
        if op == READ:
            return self.value
        return 0


def read_one(t, bus: int, addr: int) -> tuple:
    """START for read, one byte, FINISH: (ack, byte) or (None, None) when the
    table has nobody there."""
    ack = t.event(bus, addr, START_RECV)
    if ack is None:
        return (None, None)
    byte = t.event(bus, addr, READ)
    t.event(bus, addr, FINISH)
    return (ack, byte)


# ── The table ────────────────────────────────────────────────────────────────


class TestTableKeying:
    def test_same_address_on_two_controllers_is_two_devices(self):
        t = I2cBusTable()
        t.add(('sensor', 268), Probe(0x11), [0x68], bus=0)
        t.add(('sensor', 269), Probe(0x22), [0x68], bus=1)
        assert read_one(t, 0, 0x68) == (0, 0x11)
        assert read_one(t, 1, 0x68) == (0, 0x22)

    def test_a_device_on_one_controller_is_not_on_the_other(self):
        t = I2cBusTable()
        t.add(('sensor', 276), Probe(0x58), [0x76], bus=1)
        assert t.event(0, 0x76, START_SEND) is None
        assert t.event(1, 0x76, START_SEND) == 0

    def test_removal_is_by_identity_and_keeps_the_other_device_at_that_address(self):
        t = I2cBusTable()
        t.add(('sensor', 268), Probe(0x11), [0x68], bus=0)
        t.add(('sensor', 269), Probe(0x22), [0x68], bus=1)
        t.remove(('sensor', 269))
        assert read_one(t, 0, 0x68) == (0, 0x11)
        assert read_one(t, 1, 0x68) == (None, None)
        # A stale key removes nothing.
        assert t.remove(('sensor', 269)) is None
        assert read_one(t, 0, 0x68) == (0, 0x11)

    def test_the_same_key_again_replaces_and_leaves_no_twin(self):
        t = I2cBusTable()
        old, new = Probe(0x11), Probe(0x22)
        t.add(('sensor', 268), old, [0x68], bus=0)
        t.add(('sensor', 268), new, [0x68], bus=0)
        assert read_one(t, 0, 0x68) == (0, 0x22)
        assert old.log == []

    def test_a_record_nobody_placed_answers_on_every_controller(self):
        """Unmigrated parts keep working: no owner, no bus, no map."""
        t = I2cBusTable()
        t.add(('sensor', 268), Probe(0x11), [0x68])
        assert read_one(t, 0, 0x68) == (0, 0x11)
        assert read_one(t, 1, 0x68) == (0, 0x11)

    def test_every_address_of_a_registration_is_indexed_and_leaves_with_it(self):
        t = I2cBusTable()
        t.add(('chip', 1), Probe(0x33), [0x3C, 0x3D], bus=0)
        assert read_one(t, 0, 0x3D) == (0, 0x33)
        t.remove(('chip', 1))
        assert read_one(t, 0, 0x3C) == (None, None)
        assert read_one(t, 0, 0x3D) == (None, None)


class TestTableMap:
    def test_the_map_places_an_owner_on_its_controller(self):
        t = I2cBusTable()
        t.add(('sensor', 268), Probe(0x11), [0x68], owner='mpu1')
        t.apply_map([{'owner': 'mpu1', 'bus_id': 1, 'sda': 25, 'scl': 26, 'addresses': [0x68]}])
        assert read_one(t, 0, 0x68) == (None, None)
        assert read_one(t, 1, 0x68) == (0, 0x11)

    def test_the_map_wins_over_the_record_field(self):
        t = I2cBusTable()
        t.add(('sensor', 268), Probe(0x11), [0x68], owner='mpu1', bus=0)
        t.apply_map([{'owner': 'mpu1', 'bus_id': 1}])
        assert read_one(t, 0, 0x68) == (None, None)
        assert read_one(t, 1, 0x68) == (0, 0x11)

    def test_an_unplaced_owner_answers_nothing(self):
        t = I2cBusTable()
        t.add(('sensor', 268), Probe(0x11), [0x68], owner='mpu1')
        t.apply_map([{'unplaced': ['mpu1']}])
        assert read_one(t, 0, 0x68) == (None, None)
        assert read_one(t, 1, 0x68) == (None, None)

    def test_an_owner_absent_from_the_next_map_falls_back_to_its_record(self):
        """The map is the whole list every time: an owner that left it is
        placed as if no map had named it."""
        t = I2cBusTable()
        t.add(('sensor', 268), Probe(0x11), [0x68], owner='mpu1', bus=0)
        t.apply_map([{'owner': 'mpu1', 'bus_id': 1}])
        t.apply_map([])
        assert read_one(t, 0, 0x68) == (0, 0x11)
        assert read_one(t, 1, 0x68) == (None, None)

    def test_a_map_with_no_i2c_key_keeps_the_placement(self):
        t = I2cBusTable()
        t.add(('sensor', 268), Probe(0x11), [0x68], owner='mpu1')
        t.apply_map([{'owner': 'mpu1', 'bus_id': 1}])
        t.apply_map(None)
        assert read_one(t, 0, 0x68) == (None, None)
        assert read_one(t, 1, 0x68) == (0, 0x11)

    def test_a_pad_the_tab_could_not_name_is_resolved_per_event(self):
        routed = {25: 1}
        t = I2cBusTable(resolve_bus=lambda sda: routed.get(sda, NOT_ROUTED))
        t.add(('sensor', 268), Probe(0x11), [0x68], owner='mpu1')
        t.apply_map([{'owner': 'mpu1', 'bus_id': None, 'sda': 25, 'scl': 26}])
        assert read_one(t, 1, 0x68) == (0, 0x11)
        assert read_one(t, 0, 0x68) == (None, None)
        # The sketch moves Wire onto the same pads: now it is controller 0's.
        routed[25] = 0
        assert read_one(t, 0, 0x68) == (0, 0x11)
        assert read_one(t, 1, 0x68) == (None, None)
        # And off them: no controller drives that pad, nobody hears the target.
        routed.clear()
        assert read_one(t, 0, 0x68) == (None, None)
        assert read_one(t, 1, 0x68) == (None, None)

    def test_a_matrix_that_cannot_be_read_answers_anywhere_as_before(self):
        t = I2cBusTable(resolve_bus=lambda sda: None)
        t.add(('sensor', 268), Probe(0x11), [0x68], owner='mpu1')
        t.apply_map([{'owner': 'mpu1', 'bus_id': None, 'sda': 25}])
        assert read_one(t, 0, 0x68) == (0, 0x11)
        assert read_one(t, 1, 0x68) == (0, 0x11)


class TestTableArbitration:
    def _two(self, a: Probe, b: Probe, emit=None):
        t = I2cBusTable(emit=emit)
        t.add(('sensor', 1), a, [0x50], owner='a', bus=0)
        t.add(('sensor', 2), b, [0x50], owner='b', bus=0)
        return t

    def test_a_read_from_two_is_the_wired_and(self):
        t = self._two(Probe(0x3C), Probe(0x0F))
        assert read_one(t, 0, 0x50) == (0, 0x0C)

    def test_the_ack_is_any_of_theirs_and_a_nacker_is_left_out_of_the_read(self):
        t = self._two(Probe(0x3C, ack=False), Probe(0x0F))
        assert read_one(t, 0, 0x50) == (0, 0x0F)

    def test_nobody_acking_is_a_nack(self):
        t = self._two(Probe(0x3C, ack=False), Probe(0x0F, ack=False))
        assert t.event(0, 0x50, START_SEND) != 0

    def test_every_target_sees_the_start_and_the_finish(self):
        a, b = Probe(0x3C), Probe(0x0F)
        t = self._two(a, b)
        read_one(t, 0, 0x50)
        assert a.log == [START_RECV, READ, FINISH]
        assert b.log == [START_RECV, READ, FINISH]

    def test_a_conflict_is_reported_once_with_both_owners(self):
        seen: list[dict] = []
        t = self._two(Probe(0x3C), Probe(0x0F), emit=seen.append)
        read_one(t, 0, 0x50)
        read_one(t, 0, 0x50)
        assert [(e['code'], e['bus'], e['controller'], e['owners']) for e in seen] == [
            ('i2c-address-conflict', 'i2c', 0, ['a', 'b'])]

    def test_one_target_answers_alone_and_raises_nothing(self):
        seen: list[dict] = []
        t = I2cBusTable(emit=seen.append)
        t.add(('sensor', 1), Probe(0x3C), [0x50], owner='a', bus=0)
        t.add(('sensor', 2), Probe(0x0F), [0x50], owner='b', bus=1)
        assert read_one(t, 0, 0x50) == (0, 0x3C)
        assert seen == []

    def test_a_write_is_acked_when_any_active_target_acks(self):
        class Nak(Probe):
            def handle_event(self, event: int) -> int:
                r = super().handle_event(event)
                return 1 if (event & 0xFF) == WRITE else r
        a, b = Nak(0), Probe(0)
        t = self._two(a, b)
        assert t.event(0, 0x50, START_SEND) == 0
        assert t.event(0, 0x50, WRITE | (0x42 << 8)) == 0
        t.remove(('sensor', 2))
        assert t.event(0, 0x50, START_SEND) == 0
        assert t.event(0, 0x50, WRITE | (0x42 << 8)) == 1


# ── The ESP32 worker ─────────────────────────────────────────────────────────

pytest.importorskip('wasmtime', reason='the worker rig loads custom chips')

from .test_board_buses_repro_worker import (  # noqa: E402,F401  (worker fixture)
    I2C_FINISH,
    I2C_START_SEND,
    MPU_WHO_AM_I,
    _wasm,
    worker,
)

# arduino-esp32 Wire1 on the pins the F0 browser test uses for it.
WIRE1_SDA, WIRE1_SCL = 25, 26
I2CEXT0_SDA_OUT, I2CEXT1_SDA_OUT = 30, 96


def mpu(pin: int, owner: str) -> dict:
    return {'sensor_type': 'mpu6050', 'pin': pin, 'addr': 0x68, 'owner': owner}


def i2c_chip(pin: int, chip_id: int, owner: str) -> dict:
    return {
        'sensor_type': 'custom-chip', 'pin': pin, 'wasm_b64': _wasm('i2c-probe'),
        'attrs': {'address': 0x50, 'id': chip_id}, 'component_id': owner,
        'pin_map': {}, 'nets': [], 'uart_map': {},
    }


def probe(w, bus: int, addr: int) -> int:
    return w.i2c(bus, addr, [I2C_START_SEND, I2C_FINISH])[0]


def read_chip(w, bus: int) -> tuple:
    ret = w.i2c(bus, 0x50, [0x00, READ, FINISH])
    return ret[0], ret[1]


class TestWorkerMap:
    def test_setup_an_unplaced_record_answers_on_both_controllers(self, worker):
        """The rig, and the fallback an unmigrated part keeps."""
        w = worker(sensors=[mpu(268, 'mpu1')])
        assert w.read_reg(0, 0x68, MPU_WHO_AM_I) == (0, 0x68)
        assert w.read_reg(1, 0x68, MPU_WHO_AM_I) == (0, 0x68)

    def test_the_start_config_map_puts_the_sensor_on_wire1_only(self, worker):
        w = worker(sensors=[mpu(268, 'mpu1')],
                   bus_map={'spi': [], 'i2c': [{'owner': 'mpu1', 'bus_id': 1,
                                                'sda': WIRE1_SDA, 'scl': WIRE1_SCL,
                                                'addresses': [0x68]}]})
        assert probe(w, 0, 0x68) != 0, 'Wire probe ACKed'
        assert w.read_reg(1, 0x68, MPU_WHO_AM_I) == (0, 0x68)

    def test_a_map_command_moves_it_and_an_unplaced_entry_silences_it(self, worker):
        w = worker(sensors=[mpu(268, 'mpu1')])
        w.send({'cmd': 'bus_map', 'spi': [], 'i2c': [{'owner': 'mpu1', 'bus_id': 0}]})
        w.sync()
        assert w.read_reg(0, 0x68, MPU_WHO_AM_I) == (0, 0x68)
        assert probe(w, 1, 0x68) != 0
        w.send({'cmd': 'bus_map', 'spi': [], 'i2c': [{'unplaced': ['mpu1']}]})
        w.sync()
        assert probe(w, 0, 0x68) != 0
        assert probe(w, 1, 0x68) != 0

    def test_a_map_with_no_i2c_key_leaves_the_placement(self, worker):
        """An F4 map (SPI only) sent after an F5 one must not undo it."""
        w = worker(sensors=[mpu(268, 'mpu1')],
                   bus_map={'spi': [], 'i2c': [{'owner': 'mpu1', 'bus_id': 1}]})
        w.send({'cmd': 'bus_map', 'spi': []})
        w.sync()
        assert probe(w, 0, 0x68) != 0
        assert w.read_reg(1, 0x68, MPU_WHO_AM_I) == (0, 0x68)

    def test_a_custom_chip_is_placed_by_its_component_id(self, worker):
        w = worker(sensors=[i2c_chip(400, 0x11, 'chipA'), i2c_chip(401, 0x22, 'chipB')],
                   bus_map={'spi': [], 'i2c': [{'owner': 'chipA', 'bus_id': 0},
                                               {'owner': 'chipB', 'bus_id': 1}]})
        assert read_chip(w, 0) == (0, 0x11)
        assert read_chip(w, 1) == (0, 0x22)


class TestWorkerMatrix:
    """The tab sends the pad when it cannot name the controller (Wire1 on an
    ESP32 has no default pins); the worker reads the matrix."""

    ENTRY = {'owner': 'mpu1', 'bus_id': None, 'sda': WIRE1_SDA, 'scl': WIRE1_SCL,
             'addresses': [0x68]}

    def test_the_pad_routed_to_i2c1_puts_the_sensor_on_wire1(self, worker):
        w = worker(sensors=[mpu(268, 'mpu1')], bus_map={'spi': [], 'i2c': [self.ENTRY]})
        w.guest('matrix', out_sel={str(WIRE1_SDA): I2CEXT1_SDA_OUT})
        assert w.read_reg(1, 0x68, MPU_WHO_AM_I) == (0, 0x68)
        assert probe(w, 0, 0x68) != 0, 'Wire probe ACKed'

    def test_the_same_pad_routed_to_i2c0_moves_it_to_wire(self, worker):
        w = worker(sensors=[mpu(268, 'mpu1')], bus_map={'spi': [], 'i2c': [self.ENTRY]})
        w.guest('matrix', out_sel={str(WIRE1_SDA): I2CEXT0_SDA_OUT})
        assert w.read_reg(0, 0x68, MPU_WHO_AM_I) == (0, 0x68)
        assert probe(w, 1, 0x68) != 0

    def test_a_pad_no_controller_drives_hears_nothing(self, worker):
        w = worker(sensors=[mpu(268, 'mpu1')], bus_map={'spi': [], 'i2c': [self.ENTRY]})
        w.guest('matrix', out_sel={'21': I2CEXT0_SDA_OUT})
        assert probe(w, 0, 0x68) != 0
        assert probe(w, 1, 0x68) != 0

    def test_setup_without_a_readable_matrix_it_answers_anywhere(self, worker):
        """An older libqemu has no matrix to read: the behaviour before F5."""
        w = worker(sensors=[mpu(268, 'mpu1')], bus_map={'spi': [], 'i2c': [self.ENTRY]})
        assert probe(w, 0, 0x68) == 0
        assert probe(w, 1, 0x68) == 0


class TestWorkerArbitrationAndIdentity:
    def test_two_chips_at_one_address_on_one_controller_read_the_and_and_say_so(self, worker):
        w = worker(sensors=[i2c_chip(400, 0x3C, 'chipA'), i2c_chip(401, 0x0F, 'chipB')],
                   bus_map={'spi': [], 'i2c': [{'owner': 'chipA', 'bus_id': 0},
                                               {'owner': 'chipB', 'bus_id': 0}]})
        assert read_chip(w, 0) == (0, 0x0C)
        # The diagnostic travels on stdout, the guest's answer on the rig's pipe.
        w.wait_for(lambda: any(e.get('code') == 'i2c-address-conflict'
                               for e in w.events('bus_diag')))
        diags = [e for e in w.events('bus_diag') if e.get('code') == 'i2c-address-conflict']
        assert [(d['bus'], d['controller'], d['owners']) for d in diags] == [
            ('i2c', 0, ['chipA', 'chipB'])]

    def test_unregistering_the_proxy_keeps_a_sensor_at_its_address(self, worker):
        """proxy_i2c_unregister used to pop whatever sat at the address."""
        w = worker(sensors=[mpu(268, 'mpu1')])
        w.send({'cmd': 'proxy_i2c_register', 'addr': 0x68, 'regs_b64': ''})
        w.send({'cmd': 'proxy_i2c_unregister', 'addr': 0x68})
        w.sync()
        assert w.read_reg(0, 0x68, MPU_WHO_AM_I) == (0, 0x68)

    def test_a_record_resent_on_its_pin_replaces_its_target(self, worker):
        """A sensor_attach on a pin that held an I2C target takes it away,
        whatever the new record is."""
        w = worker(sensors=[mpu(268, 'mpu1')])
        w.send({'cmd': 'sensor_attach', 'sensor_type': 'bmp280', 'pin': 268, 'addr': 0x76})
        w.sync()
        assert probe(w, 0, 0x68) != 0
        assert probe(w, 0, 0x76) == 0
        # And when the new record is not an I2C device at all, the old target
        # still goes: nothing re-registers under the pin to replace it.
        w.send({'cmd': 'sensor_attach', 'sensor_type': 'none-of-the-above', 'pin': 268})
        w.sync()
        assert probe(w, 0, 0x76) != 0


class TestWorkerMapHalves:
    def test_an_i2c_only_map_leaves_the_spi_table_as_it_is(self, worker):
        """An I2C membership change sends the I2C half alone, so it does not
        re-ship every SPI model's artifact; the SPI responders stay hosted."""
        from .test_board_buses_f4_worker import pin_cs, probe_entry, select
        from .test_board_buses_repro_worker import CHIP_A_CS
        w = worker(sensors=[mpu(268, 'mpu1')],
                   bus_map={'spi': [probe_entry('a', pin_cs(CHIP_A_CS), 0xA0)]})
        w.send({'cmd': 'bus_map', 'i2c': [{'owner': 'mpu1', 'bus_id': 1}]})
        w.sync()
        assert probe(w, 0, 0x68) != 0
        select(w, CHIP_A_CS)
        assert w.spi([0x00]) == [0xA0], 'the SPI responder left with the I2C-only map'

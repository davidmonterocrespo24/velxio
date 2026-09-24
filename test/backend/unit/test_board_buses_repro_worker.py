"""
test_board_buses_repro_worker.py: board-buses F0 reproduction, area "qemu",
for the ESP32 QEMU worker (app/services/esp32_worker.py).

The worker runs unmodified, as the child process esp32_lib_manager starts:
config on stdin, JSON events on stdout, commands on stdin. libqemu is replaced
at the ctypes boundary only (fixtures/board_buses_worker/fake_libqemu.py): the
worker's own ctypes callbacks are registered with it, and the test plays the
guest by calling them the way the C side does (per-byte picsimlab_spi_event,
write-only picsimlab_spi_event_batch, picsimlab_write_pin, picsimlab_i2c_event).
Every device model is the real one: the portable microSD, Ssd168xEpaperSlave,
MPU6050/DS3231/BMP280 slaves, and custom chips compiled with the production
chip flags (fixtures/board_buses_worker/*.c, rebuilt by build.sh) running in the
worker's WasmChipRuntime.

Convention (project/board-buses-2026-09/TESTS.md): each test states the
hardware-faithful behaviour. A finding that still reproduces is marked
`xfail(strict=True)` (the pytest it.fails: an unexpected pass fails the run)
next to a `setup` test that proves the rig, the models and the wiring work in
the configuration that does not trip the finding. When the finding is fixed
the marker comes off and the case becomes its regression guard; the `setup`
sibling stays, because it is what keeps the guard honest.

Wiring used throughout (ESP32 DevKit, VSPI): SCK 18, MISO 19, MOSI 23.
TFT CS 15 / DC 2, microSD CS 4, SPI chips CS 5 and 17, e-paper CS 25 / DC 26 /
RST 27 / BUSY 14, touch CS 33. GPIO 32 is a spare output the test toggles when
it needs the worker to flush its SPI batch (the worker flushes before every
gpio_change, so the flush is deterministic).
"""
from __future__ import annotations

import base64
import json
import os
import queue
import subprocess
import sys
import threading
from pathlib import Path

import pytest

pytest.importorskip('wasmtime', reason='the custom-chip runtime needs wasmtime')

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent.parent.parent / 'backend'
# A candidate fix can be checked against these tests without touching the
# tree: BOARD_BUSES_ESP32_WORKER=/path/to/esp32_worker.py pytest ... --runxfail
WORKER = Path(os.environ.get('BOARD_BUSES_ESP32_WORKER')
              or BACKEND / 'app' / 'services' / 'esp32_worker.py')
FIXTURES = HERE / 'fixtures' / 'board_buses_worker'

SCK, MISO, MOSI = 18, 19, 23
TFT_CS, TFT_DC = 15, 2
SD_CS = 4
CHIP_A_CS, CHIP_B_CS = 5, 17
EPD_CS, EPD_DC, EPD_RST, EPD_BUSY = 25, 26, 27, 14
TOUCH_CS = 33
FLUSH_PIN = 32
BARRIER_PIN = 900

# The field a sensor record uses to say which I2C controller (Wire = 0,
# Wire1 = 1) its SDA/SCL are wired to. F5 honours it (app/services/
# i2c_bus_table.py) beside the tab's bus map, which names the controller per
# owner, or the SDA pad for the worker to resolve against the GPIO matrix
# (test_board_buses_f5_worker_i2c.py covers the map and the matrix).
I2C_BUS_KEY = 'bus'

# picsimlab I2C ops (hw/i2c/picsimlab_i2c.c, esp32_i2c_slaves.py)
I2C_START_RECV, I2C_START_SEND, I2C_FINISH, I2C_WRITE, I2C_READ = 0x00, 0x01, 0x03, 0x05, 0x06


def _wasm(name: str) -> str:
    return base64.b64encode((FIXTURES / f'{name}.wasm').read_bytes()).decode('ascii')


def spi_chip(pin: int, cs: int, sig: int, component_id: str) -> dict:
    """The record CustomChipPart sends for spi-probe wired to VSPI and `cs`."""
    return {
        'sensor_type': 'custom-chip', 'pin': pin, 'wasm_b64': _wasm('spi-probe'),
        'attrs': {'sig': sig}, 'component_id': component_id,
        'pin_map': {'CS': cs, 'SCK': SCK, 'MOSI': MOSI, 'MISO': MISO},
        'nets': [], 'uart_map': {},
    }


EPAPER = {
    'sensor_type': 'epaper-ssd168x', 'pin': 300, 'component_id': 'epd1',
    'width': 200, 'height': 200, 'refresh_ms': 1, 'controller_family': 'ssd168x',
    'dc_pin': EPD_DC, 'cs_pin': EPD_CS, 'rst_pin': EPD_RST, 'busy_pin': EPD_BUSY,
}

# The microSD as the tab sends it: the REAL portable model
# (frontend/public/bus-chips/microsd.wasm, built from buses/models/microsd.c),
# with the card image as its named blob. Before F4 the worker was handed the
# image in its start config and served it from a Python card of its own; that
# third copy of the protocol is gone, so a card here is a bus-map entry like
# any other responder.
MICROSD_WASM = (
    Path(__file__).resolve().parents[3]
    / 'frontend' / 'public' / 'bus-chips' / 'microsd.wasm'
)


def sd_entry(cs_gpio: int = SD_CS, image: bytes = bytes(4096)) -> dict:
    return {
        'owner': 'sd1',
        'bus_id': None,
        'cs': {'kind': 'pin', 'gpio': cs_gpio, 'active_low': True},
        'model': {
            'wasm_b64': base64.b64encode(MICROSD_WASM.read_bytes()).decode('ascii'),
            'pin_map': {'SCK': SCK, 'DI': MOSI, 'DO': MISO, 'CS': cs_gpio},
            'attrs': {},
            'blobs': {'card': base64.b64encode(image).decode('ascii')},
        },
    }


def sd_cmd(idx: int, arg: int = 0) -> list[int]:
    return [0x40 | idx, (arg >> 24) & 0xFF, (arg >> 16) & 0xFF, (arg >> 8) & 0xFF,
            arg & 0xFF, 0x95]


# ── The rig ──────────────────────────────────────────────────────────────────

class Worker:
    """One esp32_worker.py child process with libqemu stubbed at ctypes."""

    def __init__(self, tmp_path: Path, sensors=(), bus_map=None) -> None:
        cfg = {
            'lib_path': str(tmp_path / 'libqemu-xtensa.so'),
            'firmware_b64': base64.b64encode(b'\x00' * 64).decode('ascii'),
            'machine': 'esp32-picsimlab',
            'sensors': list(sensors),
        }
        if bus_map:
            cfg['bus_map'] = bus_map
        ctl_r, self._ctl_w = os.pipe()
        self._rep_r, rep_w = os.pipe()
        env = {**os.environ, 'BB_CTL_IN': str(ctl_r), 'BB_CTL_OUT': str(rep_w),
               'TMPDIR': str(tmp_path), 'PYTHONDONTWRITEBYTECODE': '1'}
        code = (f'import sys; sys.path.insert(0, {str(FIXTURES)!r}); import fake_libqemu; '
                f'fake_libqemu.child_main({str(WORKER)!r}, {str(BACKEND)!r})')
        self.proc = subprocess.Popen(
            [sys.executable, '-c', code], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, pass_fds=(ctl_r, rep_w), env=env, text=True, bufsize=1)
        os.close(ctl_r)
        os.close(rep_w)
        self._ctl = os.fdopen(self._ctl_w, 'w', buffering=1)
        self._replies: queue.Queue = queue.Queue()
        self._events: list[dict] = []
        self._cv = threading.Condition()
        self.stderr: list[str] = []
        self._barrier = 0
        threading.Thread(target=self._read_events, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        threading.Thread(target=self._read_replies, daemon=True).start()
        self.proc.stdin.write(json.dumps(cfg) + '\n')
        self.proc.stdin.flush()

    def boot(self) -> None:
        assert self.wait_for(lambda: any(e.get('event') == 'booted' for e in self.events('system')),
                             15.0), 'worker never booted:\n' + ''.join(self.stderr[-40:])

    # background readers
    def _read_events(self) -> None:
        for line in self.proc.stdout:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            with self._cv:
                self._events.append(ev)
                self._cv.notify_all()

    def _read_stderr(self) -> None:
        for line in self.proc.stderr:
            self.stderr.append(line)

    def _read_replies(self) -> None:
        with os.fdopen(self._rep_r, 'r') as f:
            for line in f:
                self._replies.put(json.loads(line))

    # the guest (QEMU thread)
    def guest(self, op: str, **kw) -> dict:
        self._ctl.write(json.dumps({'op': op, **kw}) + '\n')
        reply = self._replies.get(timeout=15.0)
        if 'error' in reply:
            raise AssertionError(f'guest op {op} failed: {reply["error"]}\n' + ''.join(self.stderr[-40:]))
        return reply

    def pin(self, gpio: int, level: int) -> None:
        self.guest('pin', slot=gpio + 1, value=level)

    def spi(self, data: list[int], bus: int = 0) -> list[int]:
        return self.guest('spi', bus=bus, bytes=list(data))['miso']

    def cs(self, index: int, level: int, bus: int = 0) -> None:
        """A chip-select edge the SPI peripheral drives itself (op 0x01)."""
        self.guest('cs', bus=bus, cs=index, level=level)

    def batch(self, data: list[int]) -> None:
        self.guest('batch', bytes=list(data))

    def i2c(self, bus: int, addr: int, events: list[int]) -> list[int]:
        return self.guest('i2c', bus=bus, addr=addr, events=events)['ret']

    def read_reg(self, bus: int, addr: int, reg: int) -> tuple[int, int]:
        """Wire.beginTransmission(addr); write(reg); requestFrom(addr, 1): (ack, byte)."""
        ret = self.i2c(bus, addr, [I2C_START_SEND, I2C_WRITE | (reg << 8), I2C_FINISH,
                                   I2C_START_RECV, I2C_READ, I2C_FINISH])
        return ret[0], ret[4]

    # the frontend side (commands on stdin)
    def send(self, cmd: dict) -> None:
        self.proc.stdin.write(json.dumps(cmd) + '\n')
        self.proc.stdin.flush()

    def sync(self) -> None:
        """Return once every command sent so far has been applied (the command
        loop is sequential; a set_pin on a pin nothing uses marks the point)."""
        self._barrier += 1
        self.send({'cmd': 'set_pin', 'pin': BARRIER_PIN, 'value': self._barrier})
        assert self.guest('wait', call=['set_pin', BARRIER_PIN + 1, self._barrier])['ok']

    # what the worker emitted
    def events(self, kind: str | None = None) -> list[dict]:
        with self._cv:
            return [e for e in self._events if kind is None or e.get('type') == kind]

    def wait_for(self, pred, timeout: float = 3.0) -> bool:
        with self._cv:
            return self._cv.wait_for(pred, timeout=timeout)

    def flush(self) -> None:
        """Move the spare GPIO; the worker flushes its SPI batch before it
        announces the pin, so every byte clocked so far is out after this."""
        n = len(self.events('gpio_change'))
        level = n % 2
        self.pin(FLUSH_PIN, level)
        assert self.wait_for(lambda: any(e['pin'] == FLUSH_PIN and e['state'] == level
                                         for e in self.events('gpio_change')[n:]))

    def spi_stream(self) -> bytes:
        """Every MOSI byte the worker passed to the browser, in order."""
        return b''.join(base64.b64decode(e['b64']) for e in self.events('spi_batch'))

    def chip_log(self) -> list[str]:
        return [e['text'] for e in self.events('chip_log')]

    def close(self) -> None:
        try:
            self.send({'cmd': 'stop'})
            self.proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            self.proc.kill()
            self.proc.wait(timeout=5)
        try:
            self._ctl.close()
        except OSError:
            pass


@pytest.fixture
def worker(tmp_path):
    made: list[Worker] = []

    def make(**kw) -> Worker:
        w = Worker(tmp_path, **kw)
        made.append(w)
        w.boot()
        return w

    yield make
    for w in made:
        w.close()


# The frames the tests clock. An Adafruit_ILI9341 CASET: command byte with DC
# low, then four data bytes, sent one byte at a time (single-byte transfers
# take the per-byte path in esp32_spi.c), and a pixel run, which the driver
# sends as one bulk write (the write-only batch path).
CASET_CMD = [0x2A]
CASET_DATA = [0x00, 0x00, 0x00, 0xEF]
PIXELS = [(i * 37) & 0xFF for i in range(640)]


def _clock_tft(w: Worker) -> None:
    w.pin(TFT_CS, 0)
    w.pin(TFT_DC, 0)
    w.spi(CASET_CMD)
    w.pin(TFT_DC, 1)
    w.spi(CASET_DATA)
    w.batch(PIXELS)
    w.pin(TFT_CS, 1)
    w.flush()


# ── qemu-worker-chip-spi-swallows-bus ────────────────────────────────────────

class TestChipSwallowsBus:
    """esp32_worker.py _on_spi_event / _on_spi_batch: who answers a byte, and
    who else still hears it.

    The finding was that the first custom chip that called vx_spi_attach
    returned for EVERY byte, selected or not, and returned before the batch
    that feeds the browser. F4 replaced that walk with one chip-select table
    (`_spi_answer`), so these cases are the regression guard for it.
    """

    def test_setup_probe_chip_answers_its_own_transaction(self, worker):
        """qemu-worker-chip-spi-swallows-bus setup: the chip loads in the
        worker, hears its CS through the GPIO callback and answers per byte."""
        w = worker(sensors=[spi_chip(400, CHIP_A_CS, 0xA0, 'probe-a')])
        assert 'spi probe ready' in w.chip_log()
        w.pin(CHIP_A_CS, 1)
        w.pin(CHIP_A_CS, 0)
        assert w.spi([0x11, 0x22, 0x33]) == [0xA0, 0xA1, 0xA2]
        w.pin(CHIP_A_CS, 1)
        assert w.wait_for(lambda: 'probe a0 rx=11 22 33' in w.chip_log())

    def test_setup_bus_without_a_chip(self, worker):
        """qemu-worker-chip-spi-swallows-bus setup: with no chip, the TFT bytes
        (per byte and bulk) reach the browser, the card answers CMD0 and the
        e-paper latches a frame, all in this same rig."""
        w = worker(sensors=[EPAPER], bus_map={'spi': [sd_entry()]})
        w.pin(SD_CS, 1)
        w.pin(EPD_CS, 1)
        _clock_tft(w)
        assert w.spi_stream() == bytes(CASET_CMD + CASET_DATA + PIXELS)

        w.pin(SD_CS, 0)
        # R1 lands at offset 7, behind its N_CR fill byte. The Python card this
        # replaced answered at offset 6, where ESP-IDF's fixed sdspi_hw_cmd_t
        # layout cannot see it (see buses/models/microsd.c).
        assert w.spi(sd_cmd(0) + [0xFF, 0xFF])[7] == 0x01
        w.pin(SD_CS, 1)

        w.pin(EPD_CS, 0)
        w.pin(EPD_DC, 0)
        w.spi([0x20])
        w.pin(EPD_CS, 1)
        assert w.wait_for(lambda: bool(w.events('epaper_update')))

    def test_deselected_chip_leaves_per_byte_tft_traffic_on_the_bus(self, worker):
        """qemu-worker-chip-spi-swallows-bus: with the chip's CS high, the
        single-byte TFT commands still reach the browser's display."""
        w = worker(sensors=[spi_chip(400, CHIP_A_CS, 0xA0, 'probe-a')])
        w.pin(CHIP_A_CS, 1)
        w.pin(TFT_CS, 0)
        w.pin(TFT_DC, 0)
        w.spi(CASET_CMD)
        w.pin(TFT_DC, 1)
        w.spi(CASET_DATA)
        w.pin(TFT_CS, 1)
        w.flush()
        assert w.spi_stream() == bytes(CASET_CMD + CASET_DATA)

    def test_deselected_chip_leaves_bulk_tft_traffic_on_the_bus(self, worker):
        """qemu-worker-chip-spi-swallows-bus: with the chip's CS high, a bulk
        pixel write (the batch path) still reaches the browser's display."""
        w = worker(sensors=[spi_chip(400, CHIP_A_CS, 0xA0, 'probe-a')])
        w.pin(CHIP_A_CS, 1)
        w.pin(TFT_CS, 0)
        w.pin(TFT_DC, 1)
        w.batch(PIXELS)
        w.pin(TFT_CS, 1)
        w.flush()
        assert w.spi_stream() == bytes(PIXELS)

    def test_deselected_chip_leaves_the_sd_card_answering(self, worker):
        """qemu-worker-chip-spi-swallows-bus: with the chip's CS high and the
        card's CS low, SD.begin()'s CMD0 gets the card's R1 idle (0x01)."""
        w = worker(
            sensors=[spi_chip(400, CHIP_A_CS, 0xA0, 'probe-a')],
            bus_map={'spi': [sd_entry()]},
        )
        w.pin(CHIP_A_CS, 1)
        w.pin(SD_CS, 0)
        r = w.spi(sd_cmd(0) + [0xFF, 0xFF])
        assert r[7] == 0x01, f'CMD0 answered {r}'

    def test_deselected_chip_leaves_the_epaper_latching(self, worker):
        """qemu-worker-chip-spi-swallows-bus: with the chip's CS high and the
        panel's CS low, MASTER_ACTIVATION (0x20) latches an e-paper frame."""
        w = worker(sensors=[spi_chip(400, CHIP_A_CS, 0xA0, 'probe-a'), EPAPER])
        w.pin(CHIP_A_CS, 1)
        w.pin(EPD_CS, 0)
        w.pin(EPD_DC, 0)
        w.spi([0x20])
        w.pin(EPD_CS, 1)
        assert w.wait_for(lambda: bool(w.events('epaper_update')), 1.0), 'no epaper_update'

    def test_setup_two_chips_load_and_the_second_hears_its_cs(self, worker):
        """qemu-worker-chip-spi-swallows-bus setup: with two probe chips on the
        bus, both load and the second one's CS watch fires on its own pin, so
        an 0xFF answer below cannot come from a chip that never loaded."""
        w = worker(sensors=[spi_chip(400, CHIP_A_CS, 0xA0, 'probe-a'),
                            spi_chip(401, CHIP_B_CS, 0xB0, 'probe-b')])
        assert w.chip_log().count('spi probe ready') == 2
        w.pin(CHIP_B_CS, 1)
        w.pin(CHIP_B_CS, 0)
        w.pin(CHIP_B_CS, 1)
        assert w.wait_for(lambda: any(t.startswith('probe b0 rx=') for t in w.chip_log()))

    def test_second_chip_answers_when_it_is_the_selected_one(self, worker):
        """qemu-worker-chip-spi-swallows-bus: two SPI chips on one bus, the
        second selected: MISO is the second chip's and it hears the bytes."""
        w = worker(sensors=[spi_chip(400, CHIP_A_CS, 0xA0, 'probe-a'),
                            spi_chip(401, CHIP_B_CS, 0xB0, 'probe-b')])
        w.pin(CHIP_A_CS, 1)
        w.pin(CHIP_B_CS, 1)
        w.pin(CHIP_B_CS, 0)
        miso = w.spi([0x11, 0x22, 0x33])
        w.pin(CHIP_B_CS, 1)
        assert miso == [0xB0, 0xB1, 0xB2]
        assert w.wait_for(lambda: 'probe b0 rx=11 22 33' in w.chip_log(), 1.0)


# ── touch-qemu-async-miso, qemu-shim-miso-ws-per-byte ────────────────────────

class Xpt2046StandIn:
    """What a browser-side XPT2046 answers per byte (12-bit, 8-bit command then
    16 clocks). It stands in for the tab on the far side of the WebSocket: it
    is the answer a part in the browser WOULD give, and the point of the cases
    below is that nothing in the tab can give it in time."""

    def __init__(self, x: int) -> None:
        self.x = x
        self._pending: list[int] = []

    def answers(self, mosi: bytes) -> list[int]:
        out = []
        for b in mosi:
            out.append(self._pending.pop(0) if self._pending else 0x00)
            if b & 0x80 and ((b >> 4) & 0x7) == 0b101:     # start bit, channel X
                self._pending = [(self.x >> 5) & 0x7F, (self.x << 3) & 0xF8]
        return out


TOUCH_X = 1234                          # 0x4D2
TOUCH_X_BYTES = [0x26, 0x90]            # what the two bytes after 0xD0 carry
READ_X = [0xD0, 0x00, 0x00]


def touch_entry(cs: int = TOUCH_CS, x: int = TOUCH_X, owner: str = 'touch1',
                bus_id=None) -> dict:
    """The bus-map entry the tab sends for a touch controller: its chip select
    and its portable model (fixtures/board_buses_worker/touch-probe.c)."""
    return {
        'owner': owner,
        'bus_id': bus_id,
        'cs': {'kind': 'pin', 'gpio': cs, 'active_low': True},
        'model': {
            'wasm_b64': _wasm('touch-probe'),
            'pin_map': {'CS': cs, 'SCK': SCK, 'MOSI': MOSI, 'MISO': MISO},
            'attrs': {'x': x},
            'blobs': {},
        },
    }


class TestTouchAsyncMiso:
    """touch-qemu-async-miso, qemu-shim-miso-ws-per-byte: a part that ANSWERS
    on a QEMU board.

    Before F4 the worker returned a global `_spi_response[0]` for every byte
    and the tab only saw the byte afterwards (`spi_batch`), so the tab's answer
    landed on some later byte. F4 moves the responder to where the master is:
    the tab sends the chip's portable model in the bus map and the worker runs
    it, so the answer is for the byte being clocked.
    """

    def _read_x(self, w: Worker) -> tuple[list[int], bytes]:
        """getTouch()'s X read, one byte per guest op, as the driver does it."""
        w.pin(TOUCH_CS, 1)
        w.pin(TOUCH_CS, 0)
        miso: list[int] = []
        for b in READ_X:
            miso += w.spi([b])
        w.pin(TOUCH_CS, 1)
        w.flush()
        return miso, w.spi_stream()

    def test_setup_a_browser_side_answer_could_only_ever_be_late(self, worker):
        """touch-qemu-async-miso setup: with no model in the bus map the
        transaction still reaches the tab in order, and the answer a part there
        would give is the XPT2046's - it just arrives after the guest has
        clocked the bytes it was for. This is the rig, and the reason the fix
        is not "forward the answer faster"."""
        w = worker()
        miso, stream = self._read_x(w)
        assert stream == bytes(READ_X)
        assert Xpt2046StandIn(TOUCH_X).answers(stream) == [0x00] + TOUCH_X_BYTES
        assert miso == [0xFF, 0xFF, 0xFF], 'an unanswered bus reads its idle level'

    def test_guest_reads_the_touch_coordinate_on_the_bytes_after_the_command(self, worker):
        """touch-qemu-async-miso, qemu-shim-miso-ws-per-byte: with the model in
        the bus map, the guest reads X in the two bytes after 0xD0, as it does
        from a real XPT2046."""
        w = worker(bus_map={'spi': [touch_entry()]})
        assert 'touch probe ready' in w.chip_log()
        miso, stream = self._read_x(w)
        assert miso[1:] == TOUCH_X_BYTES, f'guest read {[hex(v) for v in miso]}'
        assert stream == bytes(READ_X), 'the sinks in the tab still get the traffic'

    def test_a_map_sent_after_the_start_replaces_the_bus(self, worker):
        """The map is resent whenever membership changes, so a part dropped on
        the canvas mid-run answers without a restart."""
        w = worker()
        w.send({'cmd': 'bus_map', 'spi': [touch_entry()]})
        w.sync()
        assert w.wait_for(lambda: 'touch probe ready' in w.chip_log(), 3.0)
        miso, _ = self._read_x(w)
        assert miso[1:] == TOUCH_X_BYTES

    def test_an_empty_map_takes_the_responder_off_the_bus(self, worker):
        """A device the user deleted is gone by being ABSENT from the next
        map: there is no per-device removal message to lose."""
        w = worker(bus_map={'spi': [touch_entry()]})
        assert self._read_x(w)[0][1:] == TOUCH_X_BYTES
        w.send({'cmd': 'bus_map', 'spi': []})
        w.sync()
        assert self._read_x(w)[0] == [0xFF, 0xFF, 0xFF]


# ── worker-i2c-slaves-ignore-bus-id ──────────────────────────────────────────

MPU_WHO_AM_I = 0x75
DS3231_TEMP_MSB = 0x11


def mpu6050(pin: int, bus: int) -> dict:
    return {'sensor_type': 'mpu6050', 'pin': pin, 'addr': 0x68, I2C_BUS_KEY: bus}


def ds3231(pin: int, bus: int) -> dict:
    return {'sensor_type': 'ds3231', 'pin': pin, 'addr': 0x68, I2C_BUS_KEY: bus}


class TestI2cSlavesPerBus:
    """esp32_worker.py _on_i2c_event: one slave per address, bus_id unused.
    Closed by F5 (the worker's I2cBusTable); these are its regression guards."""

    def test_setup_each_device_answers_alone(self, worker):
        """worker-i2c-slaves-ignore-bus-id setup: an MPU6050 on Wire answers
        WHO_AM_I 0x68; a DS3231 on Wire1 answers its temperature (25 C)."""
        w = worker(sensors=[mpu6050(268, 0)])
        assert w.read_reg(0, 0x68, MPU_WHO_AM_I) == (0, 0x68)
        w2 = worker(sensors=[ds3231(269, 1)])
        assert w2.read_reg(1, 0x68, DS3231_TEMP_MSB) == (0, 25)

    def test_same_address_on_wire_and_wire1_are_two_devices(self, worker):
        """worker-i2c-slaves-ignore-bus-id: an MPU6050 on Wire and a DS3231 on
        Wire1, both at 0x68, each answer on their own bus."""
        w = worker(sensors=[mpu6050(268, 0), ds3231(269, 1)])
        assert w.read_reg(0, 0x68, MPU_WHO_AM_I) == (0, 0x68)
        assert w.read_reg(1, 0x68, DS3231_TEMP_MSB) == (0, 25)

    def test_device_on_wire1_does_not_ack_on_wire(self, worker):
        """worker-i2c-slaves-ignore-bus-id: a BMP280 wired to Wire1 only is not
        on Wire, so Wire's address probe at 0x76 is NACKed."""
        w = worker(sensors=[{'sensor_type': 'bmp280', 'pin': 276, 'addr': 0x76, I2C_BUS_KEY: 1}])
        assert w.i2c(1, 0x76, [I2C_START_SEND, I2C_FINISH])[0] == 0      # ACK on its bus
        assert w.i2c(0, 0x76, [I2C_START_SEND, I2C_FINISH])[0] != 0, 'Wire probe ACKed'

    def test_removing_one_of_two_same_address_devices_keeps_the_other(self, worker):
        """worker-i2c-slaves-ignore-bus-id: two MPU6050 at 0x68, one per bus;
        deleting the Wire1 one leaves the Wire one answering."""
        w = worker(sensors=[mpu6050(268, 0), mpu6050(269, 1)])
        assert w.read_reg(0, 0x68, MPU_WHO_AM_I) == (0, 0x68)
        w.send({'cmd': 'sensor_detach', 'pin': 269})
        w.sync()
        assert w.read_reg(0, 0x68, MPU_WHO_AM_I) == (0, 0x68)

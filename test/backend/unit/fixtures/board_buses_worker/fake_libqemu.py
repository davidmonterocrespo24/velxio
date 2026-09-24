"""libqemu replaced at the ctypes boundary, for test_board_buses_repro_worker.py.

The worker under test (app/services/esp32_worker.py) runs unmodified in a
child process: it reads its config from stdin, emits JSON events on stdout and
takes commands on stdin, exactly as esp32_lib_manager drives it. The only thing
swapped is what `ctypes.CDLL(lib_path)` returns: this object instead of
libqemu-xtensa. It exports the symbols the worker resolves, records the calls
the worker makes into QEMU (set_pin, uart_receive, ...), and plays the guest
from `qemu_main_loop()`, on the thread the worker starts for QEMU, by calling
the worker's registered callbacks the way the C side does:

  per-byte SPI   picsimlab_spi_event(id, mosi << 8) -> MISO   (hw/ssi/picsimlab_spi.c)
  SPI CS edge    picsimlab_spi_event(id, (((cs & 3) << 1 | level) << 8) | 0x01)
  bulk SPI       picsimlab_spi_event_batch(0, buf, len), write-only (hw/ssi/esp32_spi.c)
  GPIO output    picsimlab_write_pin(slot, level), slot = gpio + 1 on ESP32
  I2C            picsimlab_i2c_event(bus, addr, op | data << 8) -> ack / data

The test sends one JSON op per line on a control pipe (BB_CTL_IN) and reads
one JSON reply per op (BB_CTL_OUT). Symbols the real library may lack
(velxio_push_camera_frame, bql_lock_impl, ...) are left out on purpose, so the
worker takes the same fallback it takes on an older libqemu build.
"""
from __future__ import annotations

import ctypes
import json
import os
import queue
import threading


class _Fn:
    """One exported symbol: callable, and accepts restype/argtypes like ctypes."""

    def __init__(self, fn):
        self._fn = fn

    def __call__(self, *args):
        return self._fn(*args)


class FakeLibQemu:
    def __init__(self, ctl_in_fd: int, ctl_out_fd: int) -> None:
        self._ctl_in = ctl_in_fd
        self._ctl_out = ctl_out_fd
        self._cbs = None
        self._shutdown = threading.Event()
        self._calls: list[list] = []
        self._calls_cv = threading.Condition()

        self.qemu_picsimlab_register_callbacks = _Fn(self._register)
        self.qemu_init = _Fn(lambda _argc, _argv, _envp: 0)
        self.qemu_main_loop = _Fn(self._guest_loop)
        self.qemu_system_shutdown_request = _Fn(lambda _cause: self._shutdown.set())
        self.qemu_picsimlab_get_internals = _Fn(lambda _idx: 0)
        self.qemu_picsimlab_set_pin = _Fn(lambda slot, v: self._record('set_pin', slot, v))
        self.qemu_picsimlab_set_apin = _Fn(lambda ch, v: self._record('set_apin', ch, v))
        self.qemu_picsimlab_enable_spi_cs_events = _Fn(
            lambda on: self._record('spi_cs_events', on))
        self.qemu_picsimlab_uart_receive = _Fn(
            lambda uart, buf, n: self._record('uart_receive', uart, list(bytes(buf[:n]))))

    # ── what the worker calls into QEMU ─────────────────────────────────────
    def _register(self, ref) -> None:
        # ctypes.byref(struct) keeps the struct it points at in `_obj`.
        self._cbs = ref._obj

    def _record(self, name: str, *args) -> None:
        with self._calls_cv:
            self._calls.append([name, *[int(a) if isinstance(a, int) else a for a in args]])
            self._calls_cv.notify_all()

    # ── the guest ───────────────────────────────────────────────────────────
    def _guest_loop(self) -> None:
        lines: queue.Queue = queue.Queue()

        def _reader() -> None:
            with os.fdopen(self._ctl_in, 'r') as f:
                for line in f:
                    lines.put(line)
            lines.put(None)

        threading.Thread(target=_reader, daemon=True, name='fake-guest-ctl').start()
        out = os.fdopen(self._ctl_out, 'w', buffering=1)
        while not self._shutdown.is_set():
            try:
                line = lines.get(timeout=0.02)
            except queue.Empty:
                continue
            if line is None:
                break
            op = json.loads(line)
            try:
                reply = self._run(op)
            except Exception as exc:  # noqa: BLE001 - reported to the test
                reply = {'error': repr(exc)}
            out.write(json.dumps(reply) + '\n')
            out.flush()

    def _run(self, op: dict) -> dict:
        cbs = self._cbs
        kind = op['op']
        if kind == 'pin':
            cbs.picsimlab_write_pin(int(op['slot']), int(op['value']))
            return {}
        if kind == 'dir':
            # A pad's direction: 1 output, 0 input (pinMode), as esp32_gpio.c
            # reports it through picsimlab_dir_pin.
            cbs.picsimlab_dir_pin(int(op['slot']), int(op['value']))
            return {}
        if kind == 'spi':
            bus = int(op.get('bus', 0))
            return {'miso': [int(cbs.picsimlab_spi_event(bus, (b & 0xFF) << 8))
                             for b in op['bytes']]}
        if kind == 'cs':
            ev = ((((int(op['cs']) & 3) << 1) | (int(op['level']) & 1)) << 8) | 0x01
            cbs.picsimlab_spi_event(int(op.get('bus', 0)), ev)
            return {}
        if kind == 'batch':
            data = [b & 0xFF for b in op['bytes']]
            buf = (ctypes.c_uint8 * len(data))(*data)
            cbs.picsimlab_spi_event_batch(int(op.get('bus', 0)), buf, len(data))
            return {}
        if kind == 'i2c':
            bus, addr = int(op['bus']), int(op['addr'])
            return {'ret': [int(cbs.picsimlab_i2c_event(bus, addr, int(ev)))
                            for ev in op['events']]}
        if kind == 'wait':
            want = op['call']
            with self._calls_cv:
                ok = self._calls_cv.wait_for(lambda: want in self._calls,
                                             timeout=float(op.get('timeout', 5.0)))
            return {'ok': bool(ok)}
        if kind == 'calls':
            with self._calls_cv:
                return {'calls': list(self._calls)}
        raise ValueError(f'unknown guest op {kind!r}')


def child_main(worker_path: str, backend_dir: str) -> None:
    """Entry point of the worker child: install the fake, then run the worker."""
    import importlib.util
    import sys

    sys.path.insert(0, backend_dir)
    fake = FakeLibQemu(int(os.environ['BB_CTL_IN']), int(os.environ['BB_CTL_OUT']))
    ctypes.CDLL = lambda *_a, **_k: fake  # type: ignore[assignment]
    spec = importlib.util.spec_from_file_location('worker_under_test', worker_path)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    mod.main()

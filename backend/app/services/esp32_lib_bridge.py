from __future__ import annotations
"""
Esp32LibBridge — ESP32 emulation via lcgamboa QEMU shared library (libqemu-xtensa.dll).

Enables full GPIO, ADC, UART, I2C, SPI, RMT, LEDC/PWM, and WiFi emulation
using the PICSimLab callback bridge.

C API exposed by the library:
  qemu_init(argc, argv, envp)
  qemu_main_loop()
  qemu_cleanup()
  qemu_picsimlab_register_callbacks(callbacks_t*)
  qemu_picsimlab_set_pin(pin: int, value: int)
  qemu_picsimlab_set_apin(channel: int, value: int)
  qemu_picsimlab_uart_receive(id: int, buf: bytes, size: int)
  qemu_picsimlab_get_internals(type: int) -> void*
  qemu_picsimlab_get_TIOCM() -> int

callbacks_t struct (from hw/xtensa/esp32_picsimlab.c):
  void    (*picsimlab_write_pin)(int pin, int value)
  void    (*picsimlab_dir_pin)(int pin, int value)
  int     (*picsimlab_i2c_event)(uint8_t id, uint8_t addr, uint16_t event)
  uint8_t (*picsimlab_spi_event)(uint8_t id, uint16_t event)
  void    (*picsimlab_uart_tx_event)(uint8_t id, uint8_t value)
  const short int *pinmap
  void    (*picsimlab_rmt_event)(uint8_t channel, uint32_t config0, uint32_t value)

I2C event flags (picsimlab convention):
  0x0000 = idle / stop
  0x0100 = start + address phase (READ if bit0=1 of addr)
  0x0200 = write data byte (byte in bits 7:0)
  0x0300 = read request (must return byte to place on SDA)

SPI event flags:
  High byte = control flags, low byte = MOSI data

RMT item encoding (value param):
  level0<<31 | duration0<<16 | level1<<15 | duration1
  duration units = RMT clock ticks (typ. 12.5 ns at 80 MHz APB)
"""
import asyncio
import base64
import ctypes
import logging
import os
import pathlib
import sys
import tempfile
import threading

logger = logging.getLogger(__name__)

# MinGW64 bin — Windows needs this on the DLL search path for glib2/libgcrypt deps
_MINGW64_BIN = r"C:\msys64\mingw64\bin"

# Default library path: .dll on Windows, .so on Linux/macOS
_LIB_NAME = "libqemu-xtensa.dll" if sys.platform == "win32" else "libqemu-xtensa.so"
_DEFAULT_LIB = str(pathlib.Path(__file__).parent / _LIB_NAME)

# ── GPIO pinmap ──────────────────────────────────────────────────────────────
# pinmap[0]  = total number of pin slots (40 for ESP32)
# pinmap[i]  = GPIO number for QEMU IRQ slot i (identity mapping: slot i → GPIO i-1)
# When GPIO N changes: callback fires with slot=i where pinmap[i]==N.
_GPIO_COUNT = 40
_PINMAP = (ctypes.c_int16 * (_GPIO_COUNT + 1))(
    _GPIO_COUNT,          # pinmap[0] = slot count
    *range(_GPIO_COUNT),  # pinmap[1..40] = GPIO 0..39
)

# Input-only GPIOs on ESP32-WROOM-32 (cannot be driven as output by firmware)
_INPUT_ONLY_GPIOS = frozenset({34, 35, 36, 39})

# ── Callback function types ─────────────────────────────────────────────────
_WRITE_PIN = ctypes.CFUNCTYPE(None, ctypes.c_int, ctypes.c_int)
_DIR_PIN   = ctypes.CFUNCTYPE(None, ctypes.c_int, ctypes.c_int)
_I2C_EVENT = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_uint8, ctypes.c_uint8, ctypes.c_uint16)
_SPI_EVENT = ctypes.CFUNCTYPE(ctypes.c_uint8, ctypes.c_uint8, ctypes.c_uint16)
_UART_TX   = ctypes.CFUNCTYPE(None, ctypes.c_uint8, ctypes.c_uint8)
_RMT_EVENT = ctypes.CFUNCTYPE(None, ctypes.c_uint8, ctypes.c_uint32, ctypes.c_uint32)


class _CallbacksT(ctypes.Structure):
    _fields_ = [
        ('picsimlab_write_pin',     _WRITE_PIN),
        ('picsimlab_dir_pin',       _DIR_PIN),
        ('picsimlab_i2c_event',     _I2C_EVENT),
        ('picsimlab_spi_event',     _SPI_EVENT),
        ('picsimlab_uart_tx_event', _UART_TX),
        ('pinmap',                  ctypes.c_void_p),
        ('picsimlab_rmt_event',     _RMT_EVENT),
    ]


class Esp32LibBridge:
    """
    Wraps one libqemu-xtensa.dll instance for a single ESP32 board.

    The QEMU event loop runs in a daemon thread so it does not block asyncio.
    All async callbacks are dispatched into the asyncio event loop via
    call_soon_threadsafe(), keeping the asyncio side thread-safe.

    GPIO listeners receive (gpio_num, value) where gpio_num is the real
    ESP32 GPIO number (0-39), automatically translated from QEMU IRQ slots.

    I2C/SPI handlers are *synchronous* (called from QEMU thread) and must
    return the response byte immediately. Register async notifications
    separately via the manager layer.
    """

    def __init__(self, lib_path: str, loop: asyncio.AbstractEventLoop):
        self._lib_path = lib_path
        if os.name == 'nt' and os.path.isdir(_MINGW64_BIN):
            os.add_dll_directory(_MINGW64_BIN)
        self._lib:           ctypes.CDLL = ctypes.CDLL(lib_path)
        self._loop:          asyncio.AbstractEventLoop = loop
        self._thread:        threading.Thread | None = None
        self._callbacks_ref: _CallbacksT | None = None   # GC guard
        self._firmware_path: str | None = None
        self._stopped:       bool = False  # set on stop(); silences callbacks

        # ── Listener/handler lists ────────────────────────────────────────
        self._gpio_listeners: list = []   # fn(gpio_num: int, value: int)
        self._dir_listeners:  list = []   # fn(gpio_num: int, direction: int)
        self._uart_listeners: list = []   # fn(uart_id: int, byte_val: int)
        self._i2c_handlers:   list = []   # sync fn(bus, addr, event) -> int
        self._spi_handlers:   list = []   # sync fn(bus, event) -> int
        self._rmt_listeners:  list = []   # fn(channel: int, config0: int, value: int)

        # GPIO direction state: gpio_num → 0 (input) | 1 (output)
        self._gpio_dir: dict[int, int] = {}

    # ── Listener registration ─────────────────────────────────────────────

    def register_gpio_listener(self, fn) -> None:
        """fn(gpio_num: int, value: int) — GPIO output changed."""
        self._gpio_listeners.append(fn)

    def register_dir_listener(self, fn) -> None:
        """fn(gpio_num: int, direction: int) — GPIO direction changed (0=in, 1=out)."""
        self._dir_listeners.append(fn)

    def register_uart_listener(self, fn) -> None:
        """fn(uart_id: int, byte_val: int) — UART TX byte from ESP32."""
        self._uart_listeners.append(fn)

    def register_i2c_handler(self, fn) -> None:
        """Sync fn(bus_id, addr, event) -> int — I2C event (called from QEMU thread)."""
        self._i2c_handlers.append(fn)

    def register_spi_handler(self, fn) -> None:
        """Sync fn(bus_id, event) -> int — SPI event (called from QEMU thread)."""
        self._spi_handlers.append(fn)

    def register_rmt_listener(self, fn) -> None:
        """fn(channel: int, config0: int, value: int) — RMT pulse event."""
        self._rmt_listeners.append(fn)

    # ── Lifecycle ─────────────────────────────────────────────────────────

    def start(self, firmware_b64: str, machine: str = 'esp32-picsimlab') -> None:
        """Decode firmware, init QEMU, start event loop in daemon thread."""
        fw_bytes = base64.b64decode(firmware_b64)
        tmp = tempfile.NamedTemporaryFile(suffix='.bin', delete=False)
        tmp.write(fw_bytes)
        tmp.close()
        self._firmware_path = tmp.name

        # ROM directory: esp32-v3-rom.bin lives beside the library
        rom_dir = str(pathlib.Path(self._lib_path).parent).encode()

        args_bytes = [
            b'qemu',
            b'-M', machine.encode(),
            b'-nographic',
            b'-L', rom_dir,
            b'-drive', f'file={self._firmware_path},if=mtd,format=raw'.encode(),
        ]
        argc = len(args_bytes)
        argv = (ctypes.c_char_p * argc)(*args_bytes)

        cbs = _CallbacksT(
            picsimlab_write_pin     = _WRITE_PIN(self._on_pin_change),
            picsimlab_dir_pin       = _DIR_PIN(self._on_dir_change),
            picsimlab_i2c_event     = _I2C_EVENT(self._on_i2c_event),
            picsimlab_spi_event     = _SPI_EVENT(self._on_spi_event),
            picsimlab_uart_tx_event = _UART_TX(self._on_uart_tx),
            pinmap                  = ctypes.cast(_PINMAP, ctypes.c_void_p).value,
            picsimlab_rmt_event     = _RMT_EVENT(self._on_rmt_event),
        )
        self._callbacks_ref = cbs
        self._lib.qemu_picsimlab_register_callbacks(ctypes.byref(cbs))

        # qemu_init() and qemu_main_loop() MUST run in the same thread (BQL)
        self._init_done  = threading.Event()
        self._init_error: str | None = None

        def _qemu_thread() -> None:
            try:
                self._lib.qemu_init(argc, argv, None)
            except Exception as exc:
                self._init_error = str(exc)
            finally:
                self._init_done.set()
            if self._init_error is None:
                self._lib.qemu_main_loop()

        self._thread = threading.Thread(
            target=_qemu_thread,
            daemon=True,
            name=f'qemu-esp32-{machine}',
        )
        self._thread.start()

        if not self._init_done.wait(timeout=30.0):
            raise TimeoutError('qemu_init() did not complete within 30 s')
        if self._init_error:
            raise RuntimeError(f'qemu_init() failed: {self._init_error}')

        logger.info('lcgamboa QEMU started: machine=%s firmware=%s', machine, self._firmware_path)

    def stop(self) -> None:
        """
        Terminate the QEMU instance and block until the thread exits (≤5 s).

        qemu_cleanup() is called here to request QEMU shutdown; the assertion
        it raises on some platforms is non-fatal (glib prints "Bail out!" but
        does not abort the process on Windows).  We swallow all exceptions.

        This method is intentionally synchronous/blocking so that callers can
        run it in a thread-pool executor and await it from async code without
        stalling the asyncio event loop.
        """
        self._stopped = True
        self._callbacks_ref = None   # allow GC of ctypes callbacks early
        try:
            self._lib.qemu_cleanup()
        except Exception as exc:
            logger.debug('qemu_cleanup exception (expected): %s', exc)
        # Wait for QEMU thread so the DLL global state is clean before re-init
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5.0)
            if self._thread.is_alive():
                logger.warning('QEMU thread still alive after 5 s — proceeding anyway')
        if self._firmware_path and os.path.exists(self._firmware_path):
            try:
                os.unlink(self._firmware_path)
            except OSError:
                pass
            self._firmware_path = None
        logger.info('Esp32LibBridge stopped')

    @property
    def is_alive(self) -> bool:
        """Return True if the QEMU daemon thread is still running."""
        return self._thread is not None and self._thread.is_alive()

    # ── GPIO / ADC / UART control ─────────────────────────────────────────

    def set_pin(self, gpio_num: int, value: int) -> None:
        """Drive a GPIO input from outside (e.g. button press, connected component).
        gpio_num is the real ESP32 GPIO number (0-39)."""
        # Identity pinmap: slot = gpio_num + 1
        slot = gpio_num + 1
        self._lib.qemu_picsimlab_set_pin(slot, value)

    def set_adc(self, channel: int, millivolts: int) -> None:
        """Set ADC channel voltage.  channel 0-9, millivolts 0-3300."""
        raw = int(millivolts * 4095 / 3300)
        self._lib.qemu_picsimlab_set_apin(channel, max(0, min(4095, raw)))

    def set_adc_raw(self, channel: int, raw: int) -> None:
        """Set ADC channel directly with 12-bit raw value (0-4095)."""
        self._lib.qemu_picsimlab_set_apin(channel, max(0, min(4095, raw)))

    def uart_send(self, uart_id: int, data: bytes) -> None:
        """Send bytes to the ESP32's UART RX (simulated serial input)."""
        buf = (ctypes.c_uint8 * len(data))(*data)
        self._lib.qemu_picsimlab_uart_receive(uart_id, buf, len(data))

    def get_gpio_direction(self, gpio_num: int) -> int:
        """Return last known direction for gpio_num: 0=input, 1=output."""
        return self._gpio_dir.get(gpio_num, 0)

    # ── LEDC / PWM introspection ──────────────────────────────────────────

    def get_ledc_duty(self, channel: int) -> int | None:
        """
        Read LEDC channel duty cycle via qemu_picsimlab_get_internals(0).
        Returns raw 32-bit duty register value, or None if unavailable.
        channel 0-15 maps to LEDC channels 0-15 (low-speed + high-speed).
        """
        try:
            self._lib.qemu_picsimlab_get_internals.restype = ctypes.c_void_p
            ptr = self._lib.qemu_picsimlab_get_internals(0)
            if ptr is None:
                return None
            arr = (ctypes.c_uint32 * 16).from_address(ptr)
            return int(arr[channel]) if 0 <= channel < 16 else None
        except Exception:
            return None

    def get_tiocm(self) -> int:
        """Read UART modem control lines bitmask (TIOCM_*)."""
        try:
            self._lib.qemu_picsimlab_get_TIOCM.restype = ctypes.c_int
            return int(self._lib.qemu_picsimlab_get_TIOCM())
        except Exception:
            return 0

    # ── Static helpers ────────────────────────────────────────────────────

    @staticmethod
    def decode_rmt_item(value: int) -> tuple[int, int, int, int]:
        """
        Decode a 32-bit RMT item into (level0, duration0, level1, duration1).
        Bit layout: level0[31] | duration0[30:16] | level1[15] | duration1[14:0]
        Durations are in RMT clock ticks (12.5 ns per tick at 80 MHz APB).
        """
        level0    = (value >> 31) & 1
        duration0 = (value >> 16) & 0x7FFF
        level1    = (value >> 15) & 1
        duration1 =  value        & 0x7FFF
        return level0, duration0, level1, duration1

    # ── Internal callbacks (called from QEMU thread) ──────────────────────

    def _slot_to_gpio(self, slot: int) -> int:
        """Translate QEMU IRQ slot index to ESP32 GPIO number via pinmap."""
        if 1 <= slot <= _GPIO_COUNT:
            return int(_PINMAP[slot])
        return slot

    def _on_pin_change(self, slot: int, value: int) -> None:
        """GPIO output changed — translate slot→GPIO, dispatch to async listeners."""
        if self._stopped:
            return
        gpio = self._slot_to_gpio(slot)
        for fn in self._gpio_listeners:
            self._loop.call_soon_threadsafe(fn, gpio, value)

    def _on_dir_change(self, slot: int, direction: int) -> None:
        """GPIO direction changed (0=input, 1=output)."""
        if self._stopped:
            return
        gpio = self._slot_to_gpio(slot)
        self._gpio_dir[gpio] = direction
        for fn in self._dir_listeners:
            self._loop.call_soon_threadsafe(fn, gpio, direction)

    def _on_i2c_event(self, bus_id: int, addr: int, event: int) -> int:
        """
        I2C bus event — synchronous, called from QEMU thread.
        Calls all registered sync handlers; returns last non-zero response byte.
        """
        response = 0
        for fn in self._i2c_handlers:
            try:
                resp = fn(bus_id, addr, event)
                if resp:
                    response = resp & 0xFF
            except Exception as exc:
                logger.debug('i2c_handler error: %s', exc)
        return response

    def _on_spi_event(self, bus_id: int, event: int) -> int:
        """
        SPI bus event — synchronous, called from QEMU thread.
        Returns MISO byte (0xFF = idle bus).
        """
        response = 0xFF
        for fn in self._spi_handlers:
            try:
                resp = fn(bus_id, event)
                if resp is not None:
                    response = resp & 0xFF
            except Exception as exc:
                logger.debug('spi_handler error: %s', exc)
        return response

    def _on_uart_tx(self, uart_id: int, byte_val: int) -> None:
        """UART TX byte transmitted by ESP32 firmware."""
        if self._stopped:
            return
        for fn in self._uart_listeners:
            self._loop.call_soon_threadsafe(fn, uart_id, byte_val)

    def _on_rmt_event(self, channel: int, config0: int, value: int) -> None:
        """RMT pulse event — used for NeoPixel/WS2812, IR remotes, etc."""
        if self._stopped:
            return
        for fn in self._rmt_listeners:
            self._loop.call_soon_threadsafe(fn, channel, config0, value)

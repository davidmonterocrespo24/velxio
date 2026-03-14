"""
Tests for ESP32 emulation via lcgamboa libqemu-xtensa.dll.

What this tests
===============
  Unit (fast, no QEMU process):
    - DLL file exists at the expected path
    - DLL loads via ctypes without error
    - All required C symbols are exported
    - EspLibManager.is_available() returns True
    - Manager API surface matches EspQemuManager (duck-typing compatibility)

  Integration (starts the real QEMU DLL):
    - QEMU boots with IRAM-safe blink firmware (esp32-picsimlab machine)
    - UART output: "LCGAMBOA_STARTED", "LED_ON", "LED_OFF", "BLINK_DONE"
    - GPIO callbacks: pin 3 (GPIO2 identity-mapped) toggles HIGH/LOW 5 times
    - GPIO input: qemu_picsimlab_set_pin() accepted without crash
    - ADC input:  qemu_picsimlab_set_apin() accepted without crash
    - UART RX:    qemu_picsimlab_uart_receive() accepted without crash

Firmware notes
--------------
  Uses blink_lcgamboa.ino compiled with:
    - IRAM_ATTR on all functions → code lives in SRAM, not flash cache
    - DRAM_ATTR on all strings   → data lives in SRAM, not flash cache
    - esp_rom_printf() for UART output (ROM function, cache-safe)
    - Direct GPIO register writes (no IDF cached helpers)
    - ets_delay_us() for delays (ROM function, cache-safe)

  This avoids the "Cache disabled but cached memory region accessed" crash that
  occurs in the lcgamboa machine when the WiFi core temporarily disables the
  SPI flash cache during emulated radio init.

GPIO pinmap note
----------------
  Identity pinmap: position i → GPIO (i-1).
  GPIO2 (LED_BIT) → pinmap position 3 → picsimlab_write_pin(pin=3, value).
"""

import ctypes
import os
import pathlib
import sys
import threading
import time
import unittest

# ── paths ────────────────────────────────────────────────────────────────────
_REPO    = pathlib.Path(__file__).parent.parent.parent
_BACKEND = _REPO / "backend"
_FW_LCGAMBOA = (
    _REPO / "test" / "esp32-emulator" / "binaries_lcgamboa"
    / "blink_lcgamboa.ino.merged.bin"
)

sys.path.insert(0, str(_BACKEND))

from app.services.esp32_lib_bridge import _DEFAULT_LIB, _MINGW64_BIN, _PINMAP, _GPIO_COUNT
from app.services.esp32_lib_manager import LIB_PATH, EspLibManager

_DLL_AVAILABLE      = bool(LIB_PATH) and os.path.isfile(LIB_PATH)
_FW_AVAILABLE       = _FW_LCGAMBOA.is_file()
_SKIP_INTEGRATION   = os.environ.get("SKIP_LIB_INTEGRATION", "") == "1"

_GPIO_PIN_FOR_LED   = 3   # pinmap position for GPIO2 (identity map: pos i → gpio i-1)


# ═══════════════════════════════════════════════════════════════════════════════
# Unit tests — no QEMU process needed
# ═══════════════════════════════════════════════════════════════════════════════

class TestDllExists(unittest.TestCase):
    def test_default_lib_path_is_absolute(self):
        self.assertTrue(pathlib.Path(_DEFAULT_LIB).is_absolute())

    def test_dll_file_exists(self):
        self.assertTrue(
            os.path.isfile(_DEFAULT_LIB),
            f"libqemu-xtensa.dll not found at {_DEFAULT_LIB}"
        )

    def test_lib_path_resolved(self):
        self.assertTrue(_DLL_AVAILABLE, f"LIB_PATH='{LIB_PATH}' — empty or missing")

    def test_mingw64_bin_exists(self):
        self.assertTrue(os.path.isdir(_MINGW64_BIN), f"MinGW64 bin not found: {_MINGW64_BIN}")

    def test_rom_binaries_exist(self):
        rom_dir = pathlib.Path(_DEFAULT_LIB).parent
        for name in ("esp32-v3-rom.bin", "esp32-v3-rom-app.bin"):
            self.assertTrue((rom_dir / name).is_file(), f"ROM binary missing: {name}")


class TestDllLoads(unittest.TestCase):
    REQUIRED_SYMBOLS = [
        "qemu_init", "qemu_main_loop",
        "qemu_picsimlab_register_callbacks",
        "qemu_picsimlab_set_pin", "qemu_picsimlab_set_apin",
        "qemu_picsimlab_uart_receive",
        "qemu_picsimlab_get_internals", "qemu_picsimlab_get_TIOCM",
        "qemu_picsimlab_flash_dump",
        "picsimlab_write_pin", "picsimlab_dir_pin", "picsimlab_uart_tx_event",
    ]

    @classmethod
    def setUpClass(cls):
        if not _DLL_AVAILABLE:
            raise unittest.SkipTest("DLL not available")
        if os.name == "nt" and os.path.isdir(_MINGW64_BIN):
            os.add_dll_directory(_MINGW64_BIN)
        cls.lib = ctypes.CDLL(LIB_PATH)

    def test_all_required_symbols_exported(self):
        missing = [s for s in self.REQUIRED_SYMBOLS if not hasattr(self.lib, s)]
        self.assertFalse(missing, f"Missing DLL exports: {missing}")

    def test_qemu_init_is_callable(self):
        self.assertIsNotNone(self.lib.qemu_init)

    def test_qemu_main_loop_is_callable(self):
        self.assertIsNotNone(self.lib.qemu_main_loop)


class TestPinmap(unittest.TestCase):
    def test_pinmap_count(self):
        self.assertEqual(_PINMAP[0], _GPIO_COUNT)

    def test_pinmap_identity_mapping(self):
        for i in range(1, _GPIO_COUNT + 1):
            self.assertEqual(_PINMAP[i], i - 1)

    def test_gpio2_at_position3(self):
        self.assertEqual(_PINMAP[_GPIO_PIN_FOR_LED], 2)


class TestManagerAvailability(unittest.TestCase):
    def test_is_available(self):
        self.assertTrue(EspLibManager().is_available())

    def test_api_surface_matches_subprocess_manager(self):
        from app.services.esp_qemu_manager import EspQemuManager  # noqa: F401
        for m in ["start_instance", "stop_instance", "load_firmware",
                  "set_pin_state", "send_serial_bytes"]:
            self.assertTrue(hasattr(EspLibManager(), m), f"Missing: {m}")


# ═══════════════════════════════════════════════════════════════════════════════
# Integration tests — starts QEMU with lcgamboa DLL
# ═══════════════════════════════════════════════════════════════════════════════

@unittest.skipUnless(_DLL_AVAILABLE, "libqemu-xtensa.dll not available")
@unittest.skipUnless(_FW_AVAILABLE, f"Firmware not found: {_FW_LCGAMBOA}")
@unittest.skipIf(_SKIP_INTEGRATION, "SKIP_LIB_INTEGRATION=1")
class TestEsp32LibIntegration(unittest.TestCase):
    """
    Live tests: boot the IRAM-safe blink firmware in the lcgamboa DLL.

    setUpClass starts QEMU once. All tests share the same instance.
    Firmware: blink_lcgamboa.ino — blinks GPIO2 5x using IRAM/DRAM-safe code.
    Expected UART: LCGAMBOA_STARTED, LED_ON×5, LED_OFF×5, BLINK_DONE.
    Expected GPIO: pin=3 toggles HIGH/LOW 5 times each.
    """

    BOOT_TIMEOUT  = 30.0
    BLINK_TIMEOUT = 60.0
    LED_PIN       = _GPIO_PIN_FOR_LED  # pinmap position 3 → GPIO2

    _uart_lines:   list
    _gpio_events:  list
    _qemu_thread:  threading.Thread

    @classmethod
    def setUpClass(cls):
        from app.services.esp32_lib_bridge import (
            _WRITE_PIN, _DIR_PIN, _I2C_EVENT, _SPI_EVENT, _UART_TX, _RMT_EVENT,
            _CallbacksT, _PINMAP,
        )

        if os.name == "nt" and os.path.isdir(_MINGW64_BIN):
            os.add_dll_directory(_MINGW64_BIN)
        cls._lib = ctypes.CDLL(LIB_PATH)

        cls._uart_lines  = []
        cls._gpio_events = []
        cls._uart_buf    = bytearray()
        cls._uart_lock   = threading.Lock()
        cls._gpio_lock   = threading.Lock()

        def _on_pin(pin, value):
            with cls._gpio_lock:
                cls._gpio_events.append((pin, value))

        def _on_uart(uart_id, byte_val):
            with cls._uart_lock:
                cls._uart_buf.append(byte_val)
                if byte_val == ord('\n'):
                    line = cls._uart_buf.decode("utf-8", errors="replace").strip()
                    cls._uart_buf.clear()
                    if line:
                        cls._uart_lines.append(line)

        cb_write = _WRITE_PIN(_on_pin)
        cb_dir   = _DIR_PIN(lambda p, v: None)
        cb_i2c   = _I2C_EVENT(lambda *a: 0)
        cb_spi   = _SPI_EVENT(lambda *a: 0)
        cb_uart  = _UART_TX(_on_uart)
        cb_rmt   = _RMT_EVENT(lambda *a: None)

        cbs = _CallbacksT(
            picsimlab_write_pin     = cb_write,
            picsimlab_dir_pin       = cb_dir,
            picsimlab_i2c_event     = cb_i2c,
            picsimlab_spi_event     = cb_spi,
            picsimlab_uart_tx_event = cb_uart,
            pinmap                  = ctypes.cast(_PINMAP, ctypes.c_void_p).value,
            picsimlab_rmt_event     = cb_rmt,
        )
        cls._keep = (cbs, cb_write, cb_dir, cb_i2c, cb_spi, cb_uart, cb_rmt)
        cls._lib.qemu_picsimlab_register_callbacks(ctypes.byref(cbs))

        rom_dir = str(pathlib.Path(_DEFAULT_LIB).parent).encode()
        fw      = str(_FW_LCGAMBOA).encode()
        args    = [b"qemu", b"-M", b"esp32-picsimlab", b"-nographic",
                   b"-L", rom_dir,
                   b"-drive", b"file=" + fw + b",if=mtd,format=raw"]
        argc = len(args)
        argv = (ctypes.c_char_p * argc)(*args)

        init_done = threading.Event()

        def _qemu_run():
            cls._lib.qemu_init(argc, argv, None)
            init_done.set()
            cls._lib.qemu_main_loop()

        cls._qemu_thread = threading.Thread(target=_qemu_run, daemon=True, name="qemu-lib-test")
        cls._qemu_thread.start()

        if not init_done.wait(timeout=30.0):
            raise RuntimeError("qemu_init() timed out")

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _wait_uart(self, text: str, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._uart_lock:
                if text in self._uart_lines:
                    return True
            time.sleep(0.1)
        return False

    def _wait_gpio(self, pin: int, value: int, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._gpio_lock:
                if any(p == pin and v == value for p, v in self._gpio_events):
                    return True
            time.sleep(0.05)
        return False

    # ── UART output tests ─────────────────────────────────────────────────────

    def test_01_boot_started(self):
        ok = self._wait_uart("LCGAMBOA_STARTED", self.BOOT_TIMEOUT)
        self.assertTrue(ok, f"'LCGAMBOA_STARTED' not received in {self.BOOT_TIMEOUT}s.\n"
                            f"UART lines: {self._uart_lines[:15]}")

    def test_02_uart_led_on(self):
        ok = self._wait_uart("LED_ON", self.BLINK_TIMEOUT)
        self.assertTrue(ok, f"'LED_ON' not seen. Lines: {self._uart_lines}")

    def test_03_uart_led_off(self):
        """LED_OFF must appear — IDF 4.x does not crash between ON and OFF."""
        ok = self._wait_uart("LED_OFF", self.BLINK_TIMEOUT)
        self.assertTrue(ok, f"'LED_OFF' not seen. Lines: {self._uart_lines}")

    def test_04_uart_blink_done(self):
        """BLINK_DONE must appear after all 5 cycles — IDF 4.x stays stable."""
        ok = self._wait_uart("BLINK_DONE", self.BLINK_TIMEOUT)
        self.assertTrue(ok, f"'BLINK_DONE' not seen after 5 cycles.\n"
                            f"Lines: {self._uart_lines}")

    def test_05_uart_five_led_on(self):
        """Firmware blinks 5 times — expect exactly 5 'LED_ON' lines."""
        deadline = time.monotonic() + self.BLINK_TIMEOUT
        while time.monotonic() < deadline:
            with self._uart_lock:
                count = self._uart_lines.count("LED_ON")
            if count >= 5:
                break
            time.sleep(0.1)
        with self._uart_lock:
            count = self._uart_lines.count("LED_ON")
        self.assertEqual(count, 5,
            f"Expected 5×LED_ON, got {count}. Lines: {self._uart_lines}")

    # ── GPIO output callback tests ────────────────────────────────────────────

    def test_06_gpio_led_goes_high(self):
        ok = self._wait_gpio(self.LED_PIN, 1, self.BLINK_TIMEOUT)
        with self._gpio_lock:
            ev = list(self._gpio_events)
        self.assertTrue(ok, f"GPIO pin {self.LED_PIN} never HIGH. Events: {ev[:20]}")

    def test_07_gpio_led_goes_low(self):
        ok = self._wait_gpio(self.LED_PIN, 0, self.BLINK_TIMEOUT)
        with self._gpio_lock:
            ev = list(self._gpio_events)
        self.assertTrue(ok, f"GPIO pin {self.LED_PIN} never LOW. Events: {ev[:20]}")

    def test_08_gpio_toggles_five_times(self):
        """GPIO2 must toggle 5 HIGH + 5 LOW = 10 transitions (IDF 4.x is stable)."""
        deadline = time.monotonic() + self.BLINK_TIMEOUT
        while time.monotonic() < deadline:
            with self._gpio_lock:
                led = [(p, v) for p, v in self._gpio_events if p == self.LED_PIN]
            if len(led) >= 10:
                break
            time.sleep(0.1)
        with self._gpio_lock:
            led = [(p, v) for p, v in self._gpio_events if p == self.LED_PIN]
        self.assertGreaterEqual(
            len(led), 10,
            f"Expected ≥10 LED transitions, got {len(led)}: {led}"
        )

    def test_09_gpio_sequence_correct(self):
        """GPIO2 must alternate HIGH/LOW for 5 full cycles."""
        deadline = time.monotonic() + self.BLINK_TIMEOUT
        while time.monotonic() < deadline:
            with self._gpio_lock:
                led = [v for p, v in self._gpio_events if p == self.LED_PIN]
            if len(led) >= 10:
                break
            time.sleep(0.1)
        with self._gpio_lock:
            led = [v for p, v in self._gpio_events if p == self.LED_PIN]
        try:
            start = led.index(1)
        except ValueError:
            self.fail(f"GPIO2 never went HIGH. Values seen: {led}")
        sequence = led[start:start + 10]
        expected = [1, 0] * 5
        self.assertEqual(sequence, expected,
                         f"GPIO2 sequence not alternating. Got: {sequence}")

    # ── GPIO input / ADC / UART RX tests ─────────────────────────────────────

    def test_10_set_pin_accepted(self):
        """qemu_picsimlab_set_pin() must not raise."""
        try:
            self._lib.qemu_picsimlab_set_pin(0, 1)
            self._lib.qemu_picsimlab_set_pin(0, 0)
            self._lib.qemu_picsimlab_set_pin(4, 1)
            self._lib.qemu_picsimlab_set_pin(34, 0)   # GPIO34 = ADC1_CH6
        except Exception as e:
            self.fail(f"qemu_picsimlab_set_pin raised: {e}")

    def test_11_set_adc_accepted(self):
        """qemu_picsimlab_set_apin() must accept 12-bit values without raising."""
        try:
            self._lib.qemu_picsimlab_set_apin(0, 0)
            self._lib.qemu_picsimlab_set_apin(0, 2048)
            self._lib.qemu_picsimlab_set_apin(0, 4095)
            self._lib.qemu_picsimlab_set_apin(3, 1000)
        except Exception as e:
            self.fail(f"qemu_picsimlab_set_apin raised: {e}")

    def test_12_uart_receive_accepted(self):
        """qemu_picsimlab_uart_receive() must accept bytes without raising."""
        try:
            data = b"test\n"
            buf  = (ctypes.c_uint8 * len(data))(*data)
            self._lib.qemu_picsimlab_uart_receive(0, buf, len(data))
        except Exception as e:
            self.fail(f"qemu_picsimlab_uart_receive raised: {e}")

    def test_13_get_internals_not_null(self):
        self._lib.qemu_picsimlab_get_internals.restype = ctypes.c_void_p
        result = self._lib.qemu_picsimlab_get_internals(0)
        self.assertIsNotNone(result, "qemu_picsimlab_get_internals(0) returned NULL")

    def test_14_qemu_thread_alive(self):
        self.assertTrue(self._qemu_thread.is_alive(),
                        "QEMU daemon thread died — QEMU may have crashed")

    def test_15_summary(self):
        """Informational: print full GPIO and UART event summary."""
        with self._gpio_lock:
            ev = list(self._gpio_events)
        with self._uart_lock:
            lines = list(self._uart_lines)

        led = [(p, v) for p, v in ev if p == self.LED_PIN]
        other_pins = sorted({p for p, _ in ev if p != self.LED_PIN})

        print(f"\n  GPIO events total   : {len(ev)}")
        print(f"  Pins that fired     : {sorted({p for p, _ in ev})}")
        print(f"  Other pins (init)   : {other_pins}")
        print(f"  LED (pin={self.LED_PIN}) transitions: {led}")
        print(f"  UART lines          : {lines}")

        self.assertTrue(len(ev) > 0 or len(lines) > 0,
                        "Neither GPIO events nor UART output were observed")


if __name__ == "__main__":
    unittest.main(verbosity=2)

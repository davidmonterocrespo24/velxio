"""
test_arduino_esp32_integration.py
==================================
Integration test: Arduino Uno ↔ ESP32 (QEMU/lcgamboa) over serial.

Architecture
------------
  [Python "Arduino"] ──UART0 bytes──→ [ESP32 QEMU (lcgamboa)]
                     ←──UART0 bytes──

  The "Arduino simulator" is a Python coroutine that sends LED_ON / LED_OFF /
  PING commands via bridge.uart_send(), exactly as a real Arduino Uno would
  send bytes over its TX line.

  In Velxio (browser), the same protocol works with the AVR emulator (avr8js):
    - Wire Arduino TX pin → ESP32 GPIO1 (UART0 RX)
    - Wire Arduino RX pin ← ESP32 GPIO3 (UART0 TX)
    - The store routes bytes between the two bridges via WebSocket

ESP32 firmware required
-----------------------
  test/esp32-emulator/sketches/serial_led/serial_led.ino

  Compile:
    arduino-cli compile \\
      --fqbn esp32:esp32:esp32:FlashMode=dio \\
      --output-dir test/esp32-emulator/out_serial_led \\
      test/esp32-emulator/sketches/serial_led

  Merge (4 MB required by QEMU esp32-picsimlab):
    esptool.py --chip esp32 merge_bin --fill-flash-size 4MB \\
      -o test/esp32-emulator/binaries_lcgamboa/serial_led.ino.merged.bin \\
      --flash_mode dio --flash_size 4MB \\
      0x1000  test/esp32-emulator/out_serial_led/serial_led.ino.bootloader.bin \\
      0x8000  test/esp32-emulator/out_serial_led/serial_led.ino.partitions.bin \\
      0x10000 test/esp32-emulator/out_serial_led/serial_led.ino.bin

GPIO pinmap note
----------------
  Identity pinmap: position i → GPIO (i-1).
  GPIO2 (LED_PIN) → pinmap position 3.
  Bridge translates slot→real GPIO, so gpio_change events arrive as pin=2.

Run:
  cd test/esp32
  python -m pytest test_arduino_esp32_integration.py -v

  # Skip integration (unit-only):
  SKIP_LIB_INTEGRATION=1 python -m pytest test_arduino_esp32_integration.py -v
"""

import asyncio
import base64
import os
import pathlib
import sys
import time
import unittest

# ── paths ─────────────────────────────────────────────────────────────────────
_REPO    = pathlib.Path(__file__).parent.parent.parent
_BACKEND = _REPO / "backend"
_FW_PATH = (
    _REPO / "test" / "esp32-emulator" / "binaries_lcgamboa"
    / "serial_led.ino.merged.bin"
)
_SKETCH_PATH = (
    _REPO / "test" / "esp32-emulator" / "sketches"
    / "serial_led" / "serial_led.ino"
)

sys.path.insert(0, str(_BACKEND))

from app.services.esp32_lib_bridge import Esp32LibBridge  # noqa: E402
from app.services.esp32_lib_manager import LIB_PATH, EspLibManager  # noqa: E402

_DLL_AVAILABLE = bool(LIB_PATH) and os.path.isfile(LIB_PATH)
_FW_AVAILABLE  = _FW_PATH.is_file()
_SKIP_INT      = os.environ.get("SKIP_LIB_INTEGRATION", "") == "1"

_SKIP_DLL = "libqemu-xtensa.dll not available (set QEMU_ESP32_LIB)"
_SKIP_FW  = (
    f"Firmware not found: {_FW_PATH}\n"
    "Compile serial_led.ino with arduino-esp32 2.0.17 then merge with "
    "--fill-flash-size 4MB. See docstring for commands."
)


# ═══════════════════════════════════════════════════════════════════════════════
# Unit tests — no QEMU process needed
# ═══════════════════════════════════════════════════════════════════════════════

class TestSketchExists(unittest.TestCase):
    """Verify the Arduino/ESP32 sketch source files are present in the repo."""

    def test_esp32_sketch_exists(self):
        self.assertTrue(
            _SKETCH_PATH.is_file(),
            f"ESP32 sketch not found: {_SKETCH_PATH}",
        )

    def test_arduino_sketch_exists(self):
        arduino_sketch = (
            _REPO / "test" / "esp32-emulator" / "sketches"
            / "arduino_serial_controller" / "arduino_serial_controller.ino"
        )
        self.assertTrue(
            arduino_sketch.is_file(),
            f"Arduino sketch not found: {arduino_sketch}",
        )

    def test_firmware_path_documented(self):
        """Firmware path is a .merged.bin (4 MB) as required by QEMU."""
        self.assertTrue(str(_FW_PATH).endswith(".merged.bin"))


@unittest.skipUnless(_DLL_AVAILABLE, _SKIP_DLL)
class TestManagerApi(unittest.TestCase):
    """Manager API is present and compatible."""

    def test_is_available(self):
        self.assertTrue(EspLibManager().is_available())

    def test_manager_has_send_serial_bytes(self):
        mgr = EspLibManager()
        self.assertTrue(
            hasattr(mgr, "send_serial_bytes"),
            "EspLibManager must expose send_serial_bytes() for Arduino routing",
        )


# ═══════════════════════════════════════════════════════════════════════════════
# Integration tests — starts QEMU with serial_led firmware
# ═══════════════════════════════════════════════════════════════════════════════

@unittest.skipUnless(_DLL_AVAILABLE, _SKIP_DLL)
@unittest.skipUnless(_FW_AVAILABLE, _SKIP_FW)
@unittest.skipIf(_SKIP_INT, "SKIP_LIB_INTEGRATION=1")
class TestArduinoEsp32Serial(unittest.TestCase):
    """
    Live integration: Arduino Uno (simulated in Python) ↔ ESP32 (QEMU lcgamboa).

    setUpClass boots the ESP32 once. All tests share the same running instance.

    The "Arduino" is a Python helper that calls bridge.uart_send() — the same
    bytes that the AVR emulator (avr8js) would produce from the Serial.println()
    calls in arduino_serial_controller.ino.
    """

    BOOT_TIMEOUT  = 20.0   # seconds to wait for READY
    REPLY_TIMEOUT = 8.0    # seconds to wait for command reply
    GPIO_TIMEOUT  = 8.0    # seconds to wait for GPIO change

    @classmethod
    def setUpClass(cls):
        cls.loop = asyncio.new_event_loop()
        cls.bridge = Esp32LibBridge(LIB_PATH, cls.loop)

        cls.serial_lines: list[str]        = []   # complete UART0 lines received
        cls.gpio_events:  list[tuple[int, int]] = []   # (pin, state)
        cls._uart_buf = ""

        cls.bridge.register_uart_listener(cls._on_uart)
        cls.bridge.register_gpio_listener(cls._on_gpio)

        fw_b64 = base64.b64encode(_FW_PATH.read_bytes()).decode()
        cls.bridge.start(fw_b64, machine="esp32-picsimlab")

        # Wait for READY before any test runs
        deadline = time.monotonic() + cls.BOOT_TIMEOUT
        while time.monotonic() < deadline:
            cls.loop.run_until_complete(asyncio.sleep(0.05))
            if any("READY" in ln for ln in cls.serial_lines):
                break

    @classmethod
    def tearDownClass(cls):
        cls.bridge.stop()
        cls.loop.close()

    # ── Internal callbacks (called from QEMU thread) ──────────────────────────

    @classmethod
    def _on_uart(cls, uart_id: int, byte_val: int) -> None:
        if uart_id != 0:
            return
        ch = chr(byte_val)
        cls._uart_buf += ch
        if ch == "\n":
            line = cls._uart_buf.strip()
            if line:
                cls.serial_lines.append(line)
            cls._uart_buf = ""

    @classmethod
    def _on_gpio(cls, pin: int, state: int) -> None:
        cls.gpio_events.append((pin, state))

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _wait_line(self, contains: str, timeout: float) -> str | None:
        """Wait until a line containing `contains` arrives on UART0."""
        seen = set(self.serial_lines)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.loop.run_until_complete(asyncio.sleep(0.05))
            for ln in self.serial_lines:
                if ln not in seen and contains in ln:
                    return ln
                seen.add(ln)
        # Final check including lines seen before the call
        return next((ln for ln in self.serial_lines if contains in ln), None)

    def _wait_gpio(self, pin: int, state: int, timeout: float) -> bool:
        """Wait until GPIO `pin` reaches `state`."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.loop.run_until_complete(asyncio.sleep(0.05))
            if any(p == pin and s == state for p, s in self.gpio_events):
                return True
        return False

    def _arduino_send(self, cmd: str) -> None:
        """
        Simulate Arduino sending a command string over its TX line.

        Equivalent to:  esp32Link.println(cmd);  // in arduino_serial_controller.ino
        Routes via bridge.uart_send() — same path used in Velxio when
        the AVR simulator's serial bytes are forwarded to the ESP32 UART input.
        """
        self.bridge.uart_send(uart_id=0, data=(cmd + "\n").encode())

    # ── Tests ─────────────────────────────────────────────────────────────────

    def test_01_esp32_boots_and_sends_ready(self):
        """ESP32 firmware boots and sends 'READY' over UART0."""
        ok = any("READY" in ln for ln in self.serial_lines)
        self.assertTrue(
            ok,
            f"ESP32 did not send READY within {self.BOOT_TIMEOUT}s.\n"
            f"Received lines: {self.serial_lines}",
        )

    def test_02_ping_pong_handshake(self):
        """
        Arduino sends PING; ESP32 replies PONG.

        Simulates the setup() block of arduino_serial_controller.ino:
          esp32Link.println("PING");
          → ESP32 replies: "PONG"
        """
        before = len(self.serial_lines)
        self._arduino_send("PING")
        deadline = time.monotonic() + self.REPLY_TIMEOUT
        while time.monotonic() < deadline:
            self.loop.run_until_complete(asyncio.sleep(0.05))
            if any("PONG" in ln for ln in self.serial_lines[before:]):
                break
        got_pong = any("PONG" in ln for ln in self.serial_lines[before:])
        self.assertTrue(got_pong, "ESP32 did not reply PONG to PING")

    def test_03_led_on_command(self):
        """
        Arduino sends LED_ON; ESP32 turns on GPIO2 and replies OK:ON.

        Simulates:  esp32Link.println("LED_ON");   in arduino_serial_controller.ino
        Verifies:
          - ESP32 serial output contains "OK:ON"
          - GPIO2 goes HIGH (gpio_change pin=2, state=1)
        """
        gpio_before = len(self.gpio_events)
        lines_before = len(self.serial_lines)

        self._arduino_send("LED_ON")

        # Wait for serial reply
        deadline = time.monotonic() + self.REPLY_TIMEOUT
        while time.monotonic() < deadline:
            self.loop.run_until_complete(asyncio.sleep(0.05))
            if any("OK:ON" in ln for ln in self.serial_lines[lines_before:]):
                break
        got_reply = any("OK:ON" in ln for ln in self.serial_lines[lines_before:])
        self.assertTrue(got_reply, "ESP32 did not send OK:ON after LED_ON")

        # Wait for GPIO2 HIGH
        ok = self._wait_gpio(pin=2, state=1, timeout=self.GPIO_TIMEOUT)
        self.assertTrue(
            ok,
            f"GPIO2 did not go HIGH after LED_ON command.\n"
            f"GPIO events since test start: {self.gpio_events[gpio_before:]}",
        )

    def test_04_led_off_command(self):
        """
        Arduino sends LED_OFF; ESP32 turns off GPIO2 and replies OK:OFF.

        Simulates the loop() in arduino_serial_controller.ino toggling off.
        """
        # Ensure LED is on first
        self._arduino_send("LED_ON")
        self._wait_gpio(pin=2, state=1, timeout=self.GPIO_TIMEOUT)

        gpio_before  = len(self.gpio_events)
        lines_before = len(self.serial_lines)

        self._arduino_send("LED_OFF")

        deadline = time.monotonic() + self.REPLY_TIMEOUT
        while time.monotonic() < deadline:
            self.loop.run_until_complete(asyncio.sleep(0.05))
            if any("OK:OFF" in ln for ln in self.serial_lines[lines_before:]):
                break
        got_reply = any("OK:OFF" in ln for ln in self.serial_lines[lines_before:])
        self.assertTrue(got_reply, "ESP32 did not send OK:OFF after LED_OFF")

        ok = self._wait_gpio(pin=2, state=0, timeout=self.GPIO_TIMEOUT)
        self.assertTrue(
            ok,
            f"GPIO2 did not go LOW after LED_OFF.\n"
            f"GPIO events: {self.gpio_events[gpio_before:]}",
        )

    def test_05_toggle_five_times(self):
        """
        Arduino toggles LED 5 times (like the loop() in arduino_serial_controller.ino).
        Expects ≥10 GPIO2 transitions (5 HIGH + 5 LOW).
        """
        gpio_before = len(self.gpio_events)

        for _ in range(5):
            self._arduino_send("LED_ON")
            self._wait_line("OK:ON", self.REPLY_TIMEOUT)
            self._arduino_send("LED_OFF")
            self._wait_line("OK:OFF", self.REPLY_TIMEOUT)

        pin2 = [(p, s) for p, s in self.gpio_events[gpio_before:] if p == 2]
        self.assertGreaterEqual(
            len(pin2), 10,
            f"Expected ≥10 GPIO2 transitions for 5 toggles, got {len(pin2)}: {pin2}",
        )

    def test_06_gpio_sequence_on_off(self):
        """GPIO2 transitions after toggles follow ON→OFF→ON→OFF pattern."""
        gpio_before = len(self.gpio_events)

        self._arduino_send("LED_ON")
        self._wait_line("OK:ON", self.REPLY_TIMEOUT)
        self._arduino_send("LED_OFF")
        self._wait_line("OK:OFF", self.REPLY_TIMEOUT)
        self._arduino_send("LED_ON")
        self._wait_line("OK:ON", self.REPLY_TIMEOUT)
        self._arduino_send("LED_OFF")
        self._wait_line("OK:OFF", self.REPLY_TIMEOUT)

        pin2 = [s for p, s in self.gpio_events[gpio_before:] if p == 2]
        # Find first HIGH to anchor the pattern
        try:
            start = pin2.index(1)
        except ValueError:
            self.fail(f"GPIO2 never went HIGH. Events: {pin2}")
        sequence = pin2[start:start + 4]
        self.assertEqual(
            sequence, [1, 0, 1, 0],
            f"Expected ON→OFF→ON→OFF sequence, got: {sequence}",
        )

    def test_07_unknown_command_does_not_crash(self):
        """
        Unknown serial command from Arduino is silently ignored.
        ESP32 continues to respond to valid commands (no crash/hang).
        """
        before = len(self.serial_lines)
        self._arduino_send("GARBAGE_CMD_XYZ_123")
        # Small settle time
        self.loop.run_until_complete(asyncio.sleep(0.3))

        # ESP32 must still respond to PING
        self._arduino_send("PING")
        deadline = time.monotonic() + self.REPLY_TIMEOUT
        while time.monotonic() < deadline:
            self.loop.run_until_complete(asyncio.sleep(0.05))
            if any("PONG" in ln for ln in self.serial_lines[before:]):
                break
        ok = any("PONG" in ln for ln in self.serial_lines[before:])
        self.assertTrue(
            ok,
            "ESP32 became unresponsive after receiving an unknown command",
        )

    def test_08_rapid_commands(self):
        """
        Rapid burst of commands (no delay between them) does not stall UART.
        Simulates fast polling from a heavily-loaded Arduino sketch.
        """
        lines_before = len(self.serial_lines)
        for _ in range(10):
            self._arduino_send("LED_ON")
            self._arduino_send("LED_OFF")

        # Wait for at least 10 replies
        deadline = time.monotonic() + self.REPLY_TIMEOUT * 2
        while time.monotonic() < deadline:
            self.loop.run_until_complete(asyncio.sleep(0.05))
            replies = [
                ln for ln in self.serial_lines[lines_before:]
                if "OK:" in ln
            ]
            if len(replies) >= 10:
                break
        replies = [ln for ln in self.serial_lines[lines_before:] if "OK:" in ln]
        self.assertGreaterEqual(
            len(replies), 10,
            f"Expected ≥10 OK replies for 10 toggle pairs, got {len(replies)}",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)

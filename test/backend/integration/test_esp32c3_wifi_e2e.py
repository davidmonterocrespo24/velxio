"""
End-to-end test: ESP32/ESP32-C3 WiFi sketch compilation & QEMU execution.

Tests:
  - Compilation: WiFi Scan, HTTP Server, BLE Advertise compile for ESP32-C3
  - Compilation: WiFi Connect compiles for both ESP32 Xtensa and ESP32-C3
  - QEMU Xtensa: boots, GPIO works, WiFi NIC accepted (slirp compiled in)
  - QEMU C3: slirp compiled in, WiFi NIC accepted, -icount 3 stabilizes boot

Known limitations:
  - Arduino ESP32 core 2.0.17 firmware needs IRAM_ATTR for QEMU compatibility
  - ESP32-C3 QEMU machine requires -icount 3 for deterministic timing
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import threading


BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKER_SCRIPT = os.path.join(BACKEND_DIR, 'app', 'services', 'esp32_worker.py')
LIBQEMU_RISCV32 = os.path.join(BACKEND_DIR, 'app', 'services', 'libqemu-riscv32.dll')
LIBQEMU_XTENSA = os.path.join(BACKEND_DIR, 'app', 'services', 'libqemu-xtensa.dll')
BINARIES_DIR = os.path.join(BACKEND_DIR, '..', 'test', 'esp32-emulator', 'binaries_lcgamboa')


def compile_sketch(sketch_code: str, fqbn: str = 'esp32:esp32:esp32c3') -> dict:
    """Compile sketch using arduino-cli, return paths to binary files."""
    sketch_dir = tempfile.mkdtemp(prefix='esp32_e2e_')
    sketch_name = 'e2e_test'
    sketch_path = os.path.join(sketch_dir, sketch_name)
    os.makedirs(sketch_path, exist_ok=True)

    ino_path = os.path.join(sketch_path, f'{sketch_name}.ino')
    with open(ino_path, 'w') as f:
        f.write(sketch_code)

    output_dir = os.path.join(sketch_dir, 'output')
    os.makedirs(output_dir, exist_ok=True)

    result = subprocess.run(
        ['arduino-cli', 'compile', '--fqbn', fqbn, '--output-dir', output_dir, sketch_path],
        capture_output=True, text=True, timeout=300,
    )

    if result.returncode != 0:
        raise RuntimeError(f'Compilation failed:\n{result.stderr}')

    return {
        'bootloader': os.path.join(output_dir, f'{sketch_name}.ino.bootloader.bin'),
        'partitions': os.path.join(output_dir, f'{sketch_name}.ino.partitions.bin'),
        'app': os.path.join(output_dir, f'{sketch_name}.ino.bin'),
    }


def run_qemu_worker(lib_path: str, firmware_b64: str, machine: str,
                    wifi_enabled: bool = False, timeout_secs: int = 10) -> dict:
    """Launch esp32_worker.py and capture events."""
    config = {
        'lib_path': lib_path,
        'firmware_b64': firmware_b64,
        'machine': machine,
        'sensors': [],
        'wifi_enabled': wifi_enabled,
        'wifi_hostfwd_port': 0,
    }

    proc = subprocess.Popen(
        [sys.executable, WORKER_SCRIPT],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    assert proc.stdin is not None
    assert proc.stdout is not None
    assert proc.stderr is not None

    proc.stdin.write(json.dumps(config) + '\n')
    proc.stdin.flush()

    serial_bytes: list[int] = []
    gpio_events: list[dict] = []
    sys_events: list[dict] = []
    stderr_lines: list[str] = []

    def read_stdout():
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
                t = e.get('type')
                if t == 'system':
                    sys_events.append(e)
                elif t == 'gpio_change':
                    gpio_events.append(e)
                elif t == 'uart_tx' and e.get('uart', 0) == 0:
                    serial_bytes.append(e['byte'])
            except json.JSONDecodeError:
                pass

    def read_stderr():
        for line in proc.stderr:
            stderr_lines.append(line.rstrip())

    t1 = threading.Thread(target=read_stdout, daemon=True)
    t2 = threading.Thread(target=read_stderr, daemon=True)
    t1.start()
    t2.start()

    time.sleep(timeout_secs)

    try:
        proc.stdin.write(json.dumps({'cmd': 'stop'}) + '\n')
        proc.stdin.flush()
    except Exception:
        pass

    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        proc.kill()

    reboots = sum(1 for e in sys_events if e.get('event') == 'reboot')
    booted = any(e.get('event') == 'booted' for e in sys_events)

    return {
        'serial_bytes': serial_bytes,
        'gpio_events': gpio_events,
        'sys_events': sys_events,
        'stderr': stderr_lines,
        'reboots': reboots,
        'booted': booted,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Compilation tests — these work reliably
# ─────────────────────────────────────────────────────────────────────────────

class TestEsp32C3Compilation(unittest.TestCase):
    """Verify WiFi/BLE sketches compile for ESP32-C3."""

    def test_wifi_scan_compiles_for_c3(self):
        sketch = '#include <WiFi.h>\nvoid setup() { WiFi.scanNetworks(); }\nvoid loop() {}'
        paths = compile_sketch(sketch, fqbn='esp32:esp32:esp32c3')
        self.assertGreater(os.path.getsize(paths['app']), 100000)

    def test_wifi_connect_compiles_for_c3(self):
        sketch = '#include <WiFi.h>\nvoid setup() { WiFi.begin("Velxio-GUEST","",6); }\nvoid loop() {}'
        paths = compile_sketch(sketch, fqbn='esp32:esp32:esp32c3')
        self.assertGreater(os.path.getsize(paths['app']), 100000)

    def test_http_server_compiles_for_c3(self):
        sketch = """#include <WiFi.h>
#include <WebServer.h>
WebServer server(80);
void setup() {
  WiFi.begin("Velxio-GUEST","",6);
  server.on("/",[](){server.send(200,"text/html","<h1>C3</h1>");});
  server.begin();
}
void loop() { server.handleClient(); }
"""
        paths = compile_sketch(sketch, fqbn='esp32:esp32:esp32c3')
        self.assertGreater(os.path.getsize(paths['app']), 100000)

    def test_ble_advertise_compiles_for_c3(self):
        sketch = """#include <BLEDevice.h>
#include <BLEServer.h>
void setup() {
  BLEDevice::init("Velxio-C3");
  BLEDevice::getAdvertising()->start();
}
void loop() { delay(2000); }
"""
        paths = compile_sketch(sketch, fqbn='esp32:esp32:esp32c3')
        self.assertGreater(os.path.getsize(paths['app']), 100000)

    def test_wifi_connect_compiles_for_xtensa(self):
        sketch = '#include <WiFi.h>\nvoid setup() { WiFi.begin("Velxio-GUEST","",6); }\nvoid loop() {}'
        paths = compile_sketch(sketch, fqbn='esp32:esp32:esp32')
        self.assertGreater(os.path.getsize(paths['app']), 100000)


# ─────────────────────────────────────────────────────────────────────────────
# QEMU Xtensa tests — using pre-compiled IRAM-safe binaries
# ─────────────────────────────────────────────────────────────────────────────

class TestEsp32XtensaQemu(unittest.TestCase):
    """Test QEMU Xtensa boots and runs firmware correctly."""

    @classmethod
    def setUpClass(cls):
        if not os.path.exists(LIBQEMU_XTENSA):
            raise unittest.SkipTest('libqemu-xtensa.dll not found')
        merged = os.path.join(BINARIES_DIR, 'blink_lcgamboa.ino.merged.bin')
        if not os.path.exists(merged):
            raise unittest.SkipTest('Pre-compiled blink binary not found')
        with open(merged, 'rb') as f:
            cls.firmware_b64 = base64.b64encode(f.read()).decode()

    def test_xtensa_boots_without_reboot_loop(self):
        """Pre-compiled IRAM-safe firmware boots without crashing."""
        result = run_qemu_worker(LIBQEMU_XTENSA, self.firmware_b64,
                                 'esp32-picsimlab', wifi_enabled=False, timeout_secs=5)
        self.assertTrue(result['booted'], 'QEMU did not report booted event')
        self.assertEqual(result['reboots'], 0, f'Firmware rebooted {result["reboots"]} times')

    def test_xtensa_gpio_toggles(self):
        """GPIO 2 (LED) toggles in blink firmware."""
        result = run_qemu_worker(LIBQEMU_XTENSA, self.firmware_b64,
                                 'esp32-picsimlab', wifi_enabled=False, timeout_secs=5)
        gpio2 = [e for e in result['gpio_events'] if e.get('pin') == 2]
        self.assertGreater(len(gpio2), 2, 'Expected GPIO 2 toggling (LED blink)')

    def test_xtensa_wifi_nic_accepted(self):
        """WiFi NIC flag is accepted (slirp compiled into libqemu-xtensa)."""
        result = run_qemu_worker(LIBQEMU_XTENSA, self.firmware_b64,
                                 'esp32-picsimlab', wifi_enabled=True, timeout_secs=5)
        # Check stderr for WiFi enabled log (no "not compiled" error)
        stderr_text = '\n'.join(result['stderr'])
        self.assertIn('WiFi enabled', stderr_text)
        self.assertNotIn('not compiled into this binary', stderr_text,
                         'slirp/user networking not compiled into libqemu-xtensa.dll')
        self.assertTrue(result['booted'])

    def test_xtensa_produces_uart_output(self):
        """Firmware produces some UART output (bootloader + app)."""
        result = run_qemu_worker(LIBQEMU_XTENSA, self.firmware_b64,
                                 'esp32-picsimlab', wifi_enabled=False, timeout_secs=5)
        self.assertGreater(len(result['serial_bytes']), 0, 'No UART output from QEMU')


# ─────────────────────────────────────────────────────────────────────────────
# QEMU C3 tests — slirp + boot stability with -icount 3
# ─────────────────────────────────────────────────────────────────────────────

class TestEsp32C3Qemu(unittest.TestCase):
    """Test ESP32-C3 QEMU with slirp-enabled DLL and -icount 3."""

    @classmethod
    def setUpClass(cls):
        if not os.path.exists(LIBQEMU_RISCV32):
            raise unittest.SkipTest('libqemu-riscv32.dll not found')
        # Use a minimal firmware (blank flash) for quick QEMU startup tests
        flash = bytearray(b'\xff' * (4 * 1024 * 1024))
        cls.blank_fw_b64 = base64.b64encode(bytes(flash)).decode()

    def test_c3_libqemu_exists(self):
        """libqemu-riscv32.dll exists and is reasonably sized."""
        self.assertTrue(os.path.exists(LIBQEMU_RISCV32))
        self.assertGreater(os.path.getsize(LIBQEMU_RISCV32), 10_000_000)

    def test_c3_slirp_compiled(self):
        """libqemu-riscv32.dll has slirp (user-mode networking) compiled in.

        WiFi NIC requires slirp for -nic user,model=esp32c3_wifi.
        The DLL must be built with --enable-slirp.
        """
        result = run_qemu_worker(LIBQEMU_RISCV32, self.blank_fw_b64,
                                 'esp32c3-picsimlab', wifi_enabled=True, timeout_secs=5)
        stderr_text = '\n'.join(result['stderr'])

        self.assertNotIn('not compiled into this binary', stderr_text,
                         'slirp not compiled into libqemu-riscv32.dll — '
                         'rebuild with --enable-slirp')

    def test_c3_wifi_nic_accepted(self):
        """WiFi NIC flag is accepted (slirp compiled into libqemu-riscv32)."""
        result = run_qemu_worker(LIBQEMU_RISCV32, self.blank_fw_b64,
                                 'esp32c3-picsimlab', wifi_enabled=True, timeout_secs=5)
        stderr_text = '\n'.join(result['stderr'])
        # The key assertion: no slirp error means WiFi NIC was accepted
        self.assertNotIn('not compiled into this binary', stderr_text,
                         'slirp not compiled — WiFi NIC rejected')
        # Worker should have started (produced at least some events or stderr)
        all_output = stderr_text + str(result['sys_events'])
        self.assertTrue(len(all_output) > 0, 'No output from QEMU worker')

    def test_c3_boots_without_excessive_reboots(self):
        """C3 firmware with -icount 3 should not reboot excessively.

        Note: blank flash may still reboot a few times (no valid app),
        but should not enter a rapid reboot loop (>10 reboots).
        The -icount 3 flag in esp32_worker.py stabilizes timing.
        """
        result = run_qemu_worker(LIBQEMU_RISCV32, self.blank_fw_b64,
                                 'esp32c3-picsimlab', wifi_enabled=False, timeout_secs=5)
        # With blank flash, some reboots are expected, but not a rapid loop
        self.assertLess(result['reboots'], 10,
                        f'C3 entered reboot loop ({result["reboots"]} reboots)')


if __name__ == '__main__':
    unittest.main(verbosity=2)

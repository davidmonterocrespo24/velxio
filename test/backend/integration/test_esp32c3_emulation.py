#!/usr/bin/env python3
"""
test_esp32c3_emulation.py — Direct test of ESP32-C3 emulation via libqemu-riscv32.

Steps:
  1. Compile a minimal blink sketch for ESP32-C3 via arduino-cli
  2. Merge .bin files into a 4 MB flash image
  3. Launch esp32_worker.py with machine=esp32c3-picsimlab
  4. Wait for gpio_change events on GPIO8 (blink period ~500ms)
  5. PASS if at least 2 toggles seen within 30 s, FAIL otherwise

Run from the backend directory:
    python test_esp32c3_emulation.py
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# ── paths ────────────────────────────────────────────────────────────────────
BACKEND_DIR  = Path(__file__).parent.parent.parent.parent / 'backend'
SERVICES_DIR = BACKEND_DIR / 'app' / 'services'
WORKER       = SERVICES_DIR / 'esp32_worker.py'
LIB_PATH     = SERVICES_DIR / 'libqemu-riscv32.dll'

BLINK_SKETCH = """\
#define LED_PIN 8

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  Serial.println("ESP32-C3 blink test started");
}

void loop() {
  digitalWrite(LED_PIN, HIGH);
  Serial.println("LED ON");
  delay(500);
  digitalWrite(LED_PIN, LOW);
  Serial.println("LED OFF");
  delay(500);
}
"""

FQBN = 'esp32:esp32:esp32c3:FlashMode=dio'
TIMEOUT_S = 45   # seconds to wait for GPIO toggles
MIN_TOGGLES = 2  # minimum gpio_change events expected


def _fail(msg: str) -> None:
    print(f'\nFAIL: {msg}')
    sys.exit(1)


def _ok(msg: str) -> None:
    print(f'OK  {msg}')


# ── Step 1: compile ───────────────────────────────────────────────────────────

def compile_sketch(sketch_dir: Path, build_dir: Path) -> Path:
    print('\n=== Step 1: Compiling ESP32-C3 blink sketch ===')
    sketch_file = sketch_dir / 'sketch.ino'
    sketch_file.write_text(BLINK_SKETCH)

    cmd = [
        'arduino-cli', 'compile',
        '--fqbn', FQBN,
        '--build-property', 'build.extra_flags=-DARDUINO_ESP32_LCGAMBOA=1',
        '--output-dir', str(build_dir),
        str(sketch_dir),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print('STDOUT:', result.stdout)
        print('STDERR:', result.stderr)
        _fail('arduino-cli compilation failed')

    _ok(f'Compilation successful (rc={result.returncode})')
    return build_dir / 'sketch.ino.bin'


# ── Step 2: merge flash image ─────────────────────────────────────────────────

def merge_flash_image(build_dir: Path) -> bytes:
    """Merge bootloader + partition table + app into a 4 MB flash image."""
    print('\n=== Step 2: Merging flash image ===')
    FLASH_SIZE = 4 * 1024 * 1024
    image = bytearray(b'\xFF' * FLASH_SIZE)

    parts = [
        (0x00000, build_dir / 'sketch.ino.bootloader.bin'),
        (0x08000, build_dir / 'sketch.ino.partitions.bin'),
        (0x10000, build_dir / 'sketch.ino.bin'),
    ]
    for offset, path in parts:
        if not path.exists():
            _fail(f'Missing file: {path}')
        data = path.read_bytes()
        image[offset:offset + len(data)] = data
        _ok(f'{path.name} -> 0x{offset:05X} ({len(data)} bytes)')

    _ok(f'Merged image: {len(image)} bytes')
    return bytes(image)


# ── Step 3+4: run worker and watch for GPIO events ────────────────────────────

def run_worker_and_check_gpio(firmware_bytes: bytes) -> None:
    print('\n=== Step 3: Launching esp32_worker.py ===')

    if not WORKER.exists():
        _fail(f'Worker not found: {WORKER}')
    if not LIB_PATH.exists():
        _fail(f'DLL not found: {LIB_PATH}')

    firmware_b64 = base64.b64encode(firmware_bytes).decode()
    cfg = {
        'lib_path':     str(LIB_PATH),
        'firmware_b64': firmware_b64,
        'machine':      'esp32c3-picsimlab',
    }

    proc = subprocess.Popen(
        [sys.executable, str(WORKER)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=False,
    )

    # Send config on stdin
    cfg_line = (json.dumps(cfg) + '\n').encode()
    proc.stdin.write(cfg_line)
    proc.stdin.flush()

    print(f'Worker PID {proc.pid} started, waiting up to {TIMEOUT_S}s for GPIO toggles on GPIO8...')
    print('(All worker stderr will be shown below)\n')

    # ── Read stdout in a non-blocking fashion ────────────────────────────────
    import threading

    gpio8_states: list[int] = []
    uart_output:  list[str] = []
    errors:       list[str] = []
    all_events:   list[dict] = []

    def _read_stdout() -> None:
        for raw_line in proc.stdout:
            line = raw_line.decode('utf-8', errors='replace').strip()
            if not line:
                continue
            try:
                evt = json.loads(line)
            except Exception:
                print(f'  [worker non-JSON] {line}')
                continue
            all_events.append(evt)
            t = evt.get('type')
            if t == 'gpio_change':
                pin   = evt.get('pin')
                state = evt.get('state')
                if pin == 8:
                    gpio8_states.append(state)
                    print(f'  [GPIO8] -> {"HIGH" if state else "LOW"} (toggle #{len(gpio8_states)})')
            elif t == 'uart_tx':
                ch = chr(evt.get('byte', 0))
                uart_output.append(ch)
                line_so_far = ''.join(uart_output)
                if line_so_far.endswith('\n'):
                    print(f'  [UART0] {"".join(uart_output).rstrip()}')
                    uart_output.clear()
            elif t == 'system':
                print(f'  [system] {evt.get("event")}')
            elif t == 'error':
                msg = evt.get('message', '')
                errors.append(msg)
                print(f'  [ERROR] {msg}')

    def _read_stderr() -> None:
        for raw_line in proc.stderr:
            print(f'  [stderr] {raw_line.decode("utf-8", errors="replace").rstrip()}')

    t_out = threading.Thread(target=_read_stdout, daemon=True)
    t_err = threading.Thread(target=_read_stderr, daemon=True)
    t_out.start()
    t_err.start()

    # Wait up to TIMEOUT_S seconds or until we have MIN_TOGGLES
    deadline = time.monotonic() + TIMEOUT_S
    while time.monotonic() < deadline:
        if len(gpio8_states) >= MIN_TOGGLES:
            break
        if proc.poll() is not None:
            print(f'  Worker exited early with rc={proc.returncode}')
            break
        time.sleep(0.2)

    # Terminate worker
    try:
        proc.stdin.write((json.dumps({'cmd': 'stop'}) + '\n').encode())
        proc.stdin.flush()
    except Exception:
        pass
    time.sleep(0.5)
    if proc.poll() is None:
        proc.terminate()
        proc.wait(timeout=5)

    print(f'\n=== Step 4: Results ===')
    print(f'  GPIO8 toggles observed : {len(gpio8_states)}')
    print(f'  UART output chars      : {len("".join(uart_output))}')
    print(f'  Total events           : {len(all_events)}')
    print(f'  Errors                 : {errors}')

    if errors and not gpio8_states:
        _fail(f'Worker reported errors and no GPIO activity: {errors}')
    if len(gpio8_states) < MIN_TOGGLES:
        _fail(
            f'Expected at least {MIN_TOGGLES} GPIO8 toggles within {TIMEOUT_S}s, '
            f'got {len(gpio8_states)}.\n'
            f'  First 10 events: {all_events[:10]}'
        )

    _ok(f'GPIO8 toggled {len(gpio8_states)} times — ESP32-C3 emulation is working!')


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    print('=' * 60)
    print('ESP32-C3 EMULATION END-TO-END TEST')
    print('=' * 60)

    with tempfile.TemporaryDirectory() as tmpdir:
        sketch_dir = Path(tmpdir) / 'sketch'
        build_dir  = Path(tmpdir) / 'build'
        sketch_dir.mkdir()
        build_dir.mkdir()

        compile_sketch(sketch_dir, build_dir)
        firmware_bytes = merge_flash_image(build_dir)
        run_worker_and_check_gpio(firmware_bytes)

    print('\nPASS: ESP32-C3 emulation test PASSED')


if __name__ == '__main__':
    main()

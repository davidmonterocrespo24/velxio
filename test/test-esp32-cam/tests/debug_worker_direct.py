"""
Spawn esp32_worker.py directly (bypassing the WS+uvicorn stack) so we can
SEE the QEMU stderr where our fprintf debug lines from esp32_i2s_cam.c go.

Usage:
    python test/test-esp32-cam/tests/debug_worker_direct.py

Compiles webcam_demo.ino, launches the worker, pushes a JPEG every 100 ms,
prints worker stderr + stdout to terminal in real time. Kill with Ctrl+C.
"""

from __future__ import annotations

import base64
import json
import os
import pathlib
import subprocess
import sys
import threading
import time

THIS_DIR = pathlib.Path(__file__).resolve().parent
TEST_ROOT = THIS_DIR.parent
REPO_ROOT = TEST_ROOT.parent.parent
SKETCH = TEST_ROOT / "sketches" / "webcam_demo" / "webcam_demo.ino"
WORKER_SCRIPT = REPO_ROOT / "backend" / "app" / "services" / "esp32_worker.py"
LIB_XTENSA = REPO_ROOT / "backend" / "app" / "services" / "libqemu-xtensa.dll"

sys.path.insert(0, str(THIS_DIR))


def compile_sketch() -> str:
    """POST sketch to /api/compile/ and return base64-encoded firmware.
    Caches the result in /tmp/webcam_demo_fw.b64 keyed by sketch SHA256."""
    import hashlib
    import httpx
    sketch = SKETCH.read_text(encoding="utf-8")
    h = hashlib.sha256(sketch.encode()).hexdigest()[:16]
    cache = pathlib.Path(os.environ.get("TEMP", "C:/temp")) / f"webcam_demo_fw_{h}.b64"
    cache.parent.mkdir(parents=True, exist_ok=True)
    if cache.exists():
        fw = cache.read_text().strip()
        print(f"[compile] cache HIT ({h}): {len(fw)} chars b64")
        return fw
    print(f"[compile] cache MISS ({h}), compiling via /api/compile/...")
    r = httpx.post(
        "http://localhost:8001/api/compile/",
        json={
            "files": [{"name": "webcam_demo.ino", "content": sketch}],
            "board_fqbn": "esp32:esp32:esp32cam",
        },
        timeout=300.0,
    )
    r.raise_for_status()
    body = r.json()
    if not body.get("success"):
        raise RuntimeError(f"compile failed: {body.get('error', body)[:600]}")
    fw = body.get("binary_content") or body.get("firmware_b64")
    if not fw:
        raise RuntimeError("compile OK but no firmware")
    cache.write_text(fw)
    print(f"[compile] OK, firmware: {len(fw)} chars b64 "
          f"(~{len(fw) * 3 // 4 // 1024} KiB raw), cached to {cache}")
    return fw


def main() -> int:
    print(f"[paths] worker={WORKER_SCRIPT}")
    print(f"[paths] dll={LIB_XTENSA}  exists={LIB_XTENSA.exists()}")
    print(f"[paths] sketch={SKETCH}  exists={SKETCH.exists()}")

    fw = compile_sketch()

    from webcam_helper import get_test_jpeg
    jpeg, src = get_test_jpeg()
    print(f"[jpeg] source={src}, {len(jpeg)} bytes, head={jpeg[:8].hex()}")
    jpeg_b64 = base64.b64encode(jpeg).decode("ascii")

    config = {
        "lib_path":     str(LIB_XTENSA),
        "firmware_b64": fw,
        "machine":      "esp32-picsimlab",
        "sensors":      [],
        "wifi_enabled": False,
    }

    print(f"[spawn] launching worker via {sys.executable}")
    proc = subprocess.Popen(
        [sys.executable, str(WORKER_SCRIPT)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    # Send config
    proc.stdin.write((json.dumps(config) + "\n").encode())
    proc.stdin.flush()
    print("[spawn] config sent")

    # Threads to stream stderr + stdout
    stop = threading.Event()

    def stream_stderr():
        for line in proc.stderr:
            if stop.is_set():
                return
            sys.stderr.write("[STDERR] " + line.decode(errors="replace"))
            sys.stderr.flush()

    def stream_stdout():
        line_buf = bytearray()
        if proc.stdout is None:
            return
        for line in proc.stdout:
            if stop.is_set():
                return
            try:
                msg = json.loads(line)
            except Exception:
                continue
            t = msg.get("type", "?")
            if t == "uart_tx" and msg.get("uart") == 0:
                b = msg.get("byte", 0)
                line_buf.append(b)
                if b == ord("\n") or len(line_buf) >= 200:
                    text = line_buf.decode(errors="replace").rstrip()
                    line_buf.clear()
                    if text:
                        sys.stdout.write(f"[SERIAL] {text}\n")
                        sys.stdout.flush()
            elif t == "system":
                sys.stdout.write(f"[SYSTEM] {msg}\n"); sys.stdout.flush()

    t1 = threading.Thread(target=stream_stderr, daemon=True)
    t2 = threading.Thread(target=stream_stdout, daemon=True)
    t1.start(); t2.start()

    # Wait for boot
    time.sleep(6.0)

    # Attach + push frames
    print("[push] sending camera_attach")
    proc.stdin.write((json.dumps({"cmd": "camera_attach"}) + "\n").encode())
    proc.stdin.flush()

    print("[push] starting frame push loop (10 fps)")
    push_count = 0
    try:
        while True:
            time.sleep(0.1)
            if proc.stdin is None:
                break
            proc.stdin.write((json.dumps({
                "cmd": "camera_frame",
                "b64": jpeg_b64,
                "fmt": "jpeg",
                "w": 320,
                "h": 240,
            }) + "\n").encode())
            proc.stdin.flush()
            push_count += 1
            if push_count == 1 or push_count % 50 == 0:
                print(f"[push] {push_count} frames pushed")
            if push_count > 300:
                print("[push] hit 300 frames, stopping")
                break
    except KeyboardInterrupt:
        print("\n[main] Ctrl+C received")
    finally:
        stop.set()
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            proc.kill()

    return 0


if __name__ == "__main__":
    sys.exit(main())

# 10 — Phase 3 webcam round-trip test

End-to-end test that proves the **PC webcam → ESP32-CAM firmware
buffer** pipeline works under QEMU. Lives at
`tests/test_frame_roundtrip_live.py`.

This note documents what shipped, **what works**, **what doesn't yet**,
and the dead ends we hit so future contributors don't repeat them.

## TL;DR

| Question                                                  | Answer    |
|-----------------------------------------------------------|-----------|
| Can the host inject a real JPEG into firmware memory?     | **YES**   |
| Does the QEMU OV2640 device respond to chip-ID probes?    | **YES**   |
| Does the QEMU I²S+DMA model deliver frames + fire EOF?    | **YES**   |
| Does the *upstream* `esp_camera_init` succeed under QEMU? | partially |
| Does the *upstream* `esp_camera_fb_get` return a JPEG?    | **NO**    |

The "partial" / "no" answers are about the upstream Espressif library
auto-detection and framectrl semantics — see "What doesn't work yet"
below. The Velxio QEMU peripherals themselves are correct.

## What works (asserted by the live tests)

### `test_sccb_probe_live.py` — Phase 1 ✅

A bare-Wire.h sketch reads the OV2640 chip-ID via SCCB:

```
PID=0x26 VER=0x42 MIDH=0xA2 MIDL=0x7F
OV2640 detected
```

Proves: `hw/i2c/esp32_ov2640.c` correctly handles bank-select
(`0xFF=0x01`) + byte reads at `0x0A`/`0x0B`/`0x1C`/`0x1D`.

### `test_dma_smoke_live.py` — Phase 2 ✅

A sketch that pokes I²S0 directly (no esp_camera library) arms DMA,
waits for `in_suc_eof`, dumps 32 bytes:

```
i2s_rx armed, eof_num=512
EOF after 0ms
buf[0..31] = 00 AA 00 AA 00 AA 00 AA …
```

Proves: `hw/misc/esp32_i2s_cam.c` walks the `lldesc_t` chain, packs
pixels via `pack_two_pixels` (low half = padding, high half = pixel
byte), raises `in_suc_eof`, fires the IRQ.

### `test_frame_roundtrip_live.py` — Phase 3 ✅ (this note's main deliverable)

The webcam round-trip. A JPEG (real webcam if `VELXIO_USE_WEBCAM=1`,
otherwise a 4 KB PIL-rendered fallback) travels:

```
PC webcam (OpenCV)              ← tests/webcam_helper.py
    ↓
WebSocket (esp32_camera_attach + esp32_camera_frame)
    ↓
backend/app/api/routes/simulation.py
    ↓
backend/app/services/esp32_lib_manager.py:camera_frame()
    ↓
worker subprocess stdin (JSON line)
    ↓
backend/app/services/esp32_worker.py: ctypes → velxio_push_camera_frame()
    ↓
wokwi-libs/qemu-lcgamboa/hw/misc/velxio_camera_export.c
    ↓
hw/misc/esp32_i2s_cam.c: Esp32I2sCamState.frame_buf
    ↓
walk_dma_chain() pulls bytes via next_pixel_byte() while filling DMA
    ↓
firmware s_buf in sketches/frame_roundtrip/frame_roundtrip.ino
    ↓
Serial.printf("FRAME[0..63]: …")   — visible to the test
```

The test asserts:
- The padding bytes at offsets 0, 2, 4, 6 are `0x00` (low half of
  `dma_elem_t`).
- The pixel bytes at offsets 1, 3, 5, 7, 9, 11, 13, 15 match the first
  8 bytes of the source JPEG (`0xFF 0xD8 0xFF 0xE0` SOI+APP0 + the
  JFIF length field).

A failure of any link in that chain produces a precise diagnostic.
**That's the regression contract we wanted.**

## What doesn't work yet (and why)

### Blocker A — I²C NACK semantics fool auto-probe

The upstream `esp_camera.c` scans 18 sensor models in a fixed order.
It calls `SCCB_Probe(slv_addr)` for each, and the first one that
returns `ESP_OK` "wins" — the driver then reads the chip-id at that
address and tries to match against per-sensor PIDs.

In our QEMU I²C controller (`hw/i2c/esp32_i2c.c:199`), when no slave
is registered at the addressed location, `i2c_start_transfer` returns
non-zero and the controller sets `I2C_INT_RAW.ACK_ERR`. ESP-IDF's
`i2c_master_cmd_begin` is supposed to detect this and return
`ESP_FAIL` — and our DHT22/HC-SR04 traffic confirms that path works
for command sequences with data.

**But** the SCCB probe writes a single byte (slave addr + W bit) with
no following data and a STOP. With this minimal pattern, the QEMU
controller's ACK_ERR flag is set on the same MMIO cycle as the cmd
completion bit, and the driver's poll loop sees the cmd-complete bit
first and returns `ESP_OK` before it sees ACK_ERR. The driver thinks
something ACKed at `0x21` (the first scan address — OV7725).

Concretely: the I²C event log shows hundreds of `addr=0x21
op=START_SEND/WRITE/READ NO_SLAVE registered=[]` entries during
`esp_camera_init`. The driver thinks OV7725 is real, fails the
chip-id check (read returns `0xFF`, OV7725 expects `0x77`), iterates
through the other sensors that share `0x21` (OV7670, GC0308, GC032A)
— all fail. After all four fail, control eventually advances, but
because the driver also runs the (now half-initialised) sensor's init
sequence, the camera_init.ino sketch never reaches a clean state and
`fb_get` returns NULL forever.

**Workarounds tried** (all rejected):
- Add OV2640 slave on bus 1 too — done (the `sccb` config uses port 1
  on arduino-esp32 v2.0.17 — `CONFIG_SCCB_HARDWARE_I2C_PORT1=y`). Did
  NOT help because the driver still hangs on 0x21 first.
- Register a synthetic "rejecting" slave at 0x21 — would work but is
  fragile (would need NACK forwarding through the I²CSlave API, which
  QEMU's I²C bus core doesn't naturally support).
- Patch `hw/i2c/esp32_i2c.c` to defer the cmd-complete signal until
  after ACK_ERR is observable — possible but rabbit hole.

**The real fix** is to patch the QEMU I²C controller's MMIO timing so
ACK_ERR latches before the cmd-complete bit. That's a follow-up.

For now: the test sketches that bypass the upstream auto-probe
(`sccb_probe.ino`, `dma_smoke.ino`, `frame_roundtrip.ino`) work
perfectly. Sketches that go through `esp_camera_init` get stuck on
auto-detect.

### Blocker B — `framectrl` task expects continuous EOFs

Even if Blocker A were resolved, `cam_hal.c` runs a FreeRTOS task
that:
1. Receives `in_suc_eof` events from a queue.
2. For each event, swaps the active half-buffer.
3. Validates JPEG (`cam_verify_jpeg_eoi`) and pushes complete frames
   to the user's `xQueueReceive`-able queue.

My `esp32_i2s_cam.c` fires `in_suc_eof` ONCE per `rx_start` 0→1 edge.
Real hardware fires it on every PCLK*samples cycle while `rx_start=1`.

To unblock `fb_get`, the QEMU model needs to either:

- (a) Re-arm itself: when the driver clears `in_suc_eof` via INT_CLR,
  immediately fire another EOF (with the next chunk of frame data).
  Risk: tight loops if the driver doesn't drain fast enough.
- (b) Use a `qemu_mod_timer` that fires every ~16 ms while `rx_start=1`
  and walks the chain. More authentic to real PCLK timing.

Both are 1–2 day implementations. **Out of scope for this round.**
See `04_proposed_architecture.md` "Frame timing — strategy (B)".

### Blocker C — frame source ↔ rx_start race

In `frame_roundtrip.ino` we work around the timing by making the
sketch wait for a serial trigger. The test pushes the JPEG via WS,
then sends a serial byte to release the sketch. That guarantees
`frame_buf` is populated before `rx_start = 1` fires the walker.

In a "natural" capture loop (no trigger), `rx_start` would already be
asserted from the previous cycle. The walker would consume any newly
pushed frame on its NEXT EOF cycle — which doesn't happen until
Blocker B is fixed.

**The trigger mechanism is a test-time convenience, not a production
limitation.** Once Blocker B is resolved, the trigger goes away.

## Things we tried that didn't pan out

### Adding `driver` to main's REQUIRES — not enough on its own

`libesp32-camera.a` references `i2c_master_*` and `i2c_cmd_link_*`
which live in ESP-IDF's `driver` component. Adding `driver` to
`main/CMakeLists.txt`'s `REQUIRES ${_arduino_comp_name}` line was
necessary BUT not sufficient — `target_link_libraries(${COMPONENT_LIB}
INTERFACE "${_cam_lib}")` doesn't propagate the REQUIRES, so the
linker still couldn't find the i2c symbols.

**The fix** (which DID work) is `add_prebuilt_library` from ESP-IDF's
build system:

```cmake
add_prebuilt_library(esp32_camera_prebuilt "${_cam_lib}"
    REQUIRES driver ${_arduino_comp_name})
target_link_libraries(${COMPONENT_LIB} PUBLIC esp32_camera_prebuilt)
```

That's now in `backend/app/services/esp-idf-template/main/CMakeLists.txt`
and lets `#include "esp_camera.h"` compile + link cleanly.

### Patching `arduino-esp32/CMakeLists.txt` — rejected

`arduino-esp32/CMakeLists.txt` doesn't expose esp32-camera headers in
its `INCLUDE_DIRS`. We could patch it. **Don't** — it's a user-shared
component (other projects on the same machine share it), and any
patch would silently break their builds. Doing it in our project's
own `main/CMakeLists.txt` is the right scope.

### Windows path with `\E` triggered CMake escape error

The first attempt to add the camera include path passed
`$ENV{ARDUINO_ESP32_PATH}` directly. CMake interpreted the
backslashes as escape sequences and crashed:

```
Invalid character escape '\E'.
when parsing string
    .;C:\Espressif\components\arduino-esp32/tools/sdk/...
```

Fix: `file(TO_CMAKE_PATH "$ENV{ARDUINO_ESP32_PATH}" _arduino_path_norm)`
normalises backslashes to forward slashes.

### Pre-existing worker-subprocess crash

While debugging the camera path I uncovered an unrelated bug: when
`backend/app/services/esp32_worker.py` is run as a script (the way
`esp_lib_manager` spawns it), its sibling-import fallback for
`esp32_i2c_slaves` and `esp32_spi_slaves` registered the modules with
`importlib.util.module_from_spec` but **didn't put them in
`sys.modules`** before `exec_module`. Python's `@dataclass` decorator
looks up `cls.__module__` in `sys.modules` and crashes with
`AttributeError: 'NoneType' has no attribute '__dict__'` when missing.

This was silently breaking every ESP32 simulation under certain CWD
conditions (specifically the conditions Velxio's CI/Docker uses). Fix
landed in the same commit as the camera work — see worker.py changes
around lines 56-66 and 76-83.

## Source references

The production-grade sources we lifted patterns from:

- [espressif/esp32-camera — driver/esp_camera.c](https://github.com/espressif/esp32-camera/blob/master/driver/esp_camera.c) — the auto-detect loop (lines 234–263)
- [espressif/esp32-camera — driver/sccb.c](https://github.com/espressif/esp32-camera/blob/master/driver/sccb.c) — the bare SCCB_Probe pattern at line 97
- [espressif/esp32-camera — target/esp32/ll_cam.c](https://github.com/espressif/esp32-camera/blob/master/target/esp32/ll_cam.c) — the I²S register sequence
- [arduino-esp32 / Camera/CameraWebServer.ino](https://github.com/espressif/arduino-esp32/blob/master/libraries/ESP32/examples/Camera/CameraWebServer/CameraWebServer.ino) — canonical pin map for AI-Thinker ESP32-CAM
- [RuiSantosdotme/ESP32-CAM-Take-Photo-and-Display-Web-Server](https://github.com/RuiSantosdotme/ESP32-CAM-Arduino-IDE/blob/master/ESP32-CAM-Take-Photo-and-Display-Web-Server/ESP32-CAM-Take-Photo-and-Display-Web-Server.ino) — simplest fb_get loop (the pattern our `camera_init.ino` follows)
- [Random Nerd Tutorials — ESP32-CAM video streaming](https://randomnerdtutorials.com/esp32-cam-video-streaming-web-server-camera-home-assistant/) — for the high-level workflow

## Reproducing the round-trip locally

```bash
# 1. Build the QEMU library with camera patches (one-time, ~25 min)
C:/msys64/usr/bin/bash.exe -lc "cd /c/v_qemu/build && bash ../build_libqemu-esp32-win.sh"
cp /c/v_qemu/build/libqemu-xtensa.dll backend/app/services/

# 2. Backend
cd backend && python -m uvicorn app.main:app --port 8003

# 3. Suite (synthetic JPEG fallback — works in CI)
VELXIO_BACKEND_URL=http://127.0.0.1:8003 \
  python -m pytest test/test-esp32-cam/tests -v

# 4. Same suite but using the actual webcam
VELXIO_BACKEND_URL=http://127.0.0.1:8003 \
  VELXIO_USE_WEBCAM=1 \
  python -m pytest test/test-esp32-cam/tests/test_frame_roundtrip_live.py -v
```

## Follow-ups (in priority order)

1. **Fix QEMU I²C ACK_ERR timing** so `SCCB_Probe` correctly reports
   no-slave NACK. Unblocks Blocker A → `esp_camera_init` reaches the
   chip-id detect for OV2640 directly.
2. **Implement continuous EOF** (`qemu_mod_timer` strategy in
   `esp32_i2s_cam.c`). Unblocks Blocker B → `framectrl` task drains,
   `fb_get` returns the pushed JPEG.
3. **Front-end webcam button + `useWebcamFrames` hook** (out of
   scope until backend Phase 3 is solid; user said don't touch).
4. **Stream multiple frames** (not just one push) so the simulator
   can run face-detection / motion-detection sketches.

Each is a 1–3 day chunk on top of the foundation now in place.

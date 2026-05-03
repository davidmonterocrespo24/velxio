# 04 — proposed architecture

End-to-end pipeline for "user's webcam → ESP32-CAM firmware".

## Components

```
┌────────────────────────┐    binary WS frames     ┌─────────────────────┐
│ Browser                │  (camera_frame, ~10 fps)│ Backend             │
│  • <video>+canvas      │ ─────────────────────►  │  • Esp32Bridge      │
│  • OV2640 button       │                         │  • CameraQueue (2)  │
│  • useWebcamFrames hook│                         │  • esp_lib_bridge   │
└────────────────────────┘                         └────────┬────────────┘
                                                            │ MMIO read
                                                            │ or
                                                            │ I²C-bridge poll
                                                            ▼
                                                  ┌─────────────────────┐
                                                  │ QEMU (xtensa, ESP32)│
                                                  │  • running firmware │
                                                  │  • libcamera shim   │
                                                  │     ├ esp_camera_init   ─► OK
                                                  │     ├ esp_camera_fb_get ─► JPEG bytes
                                                  │     └ esp_camera_fb_return
                                                  └─────────────────────┘
```

## Pieces, owned by their layer

### Frontend

- `frontend/src/hooks/useWebcamFrames.ts` (new)
  Status-managed wrapper around `getUserMedia`+canvas+JPEG, sending one
  `camera_frame` WS message per tick.
- `frontend/src/components/simulator/CameraToggle.tsx` (new)
  Button rendered on the canvas header of any board whose `boardKind`
  is `esp32-cam`. Idle / requesting permission / streaming / error.
- `frontend/src/simulation/Esp32Bridge.ts`
  Add `sendCameraFrame(buffer: ArrayBuffer)`. Already supports binary
  send via `this.ws.send(...)`.

### Backend

- `backend/app/services/camera_queue.py` (new)
  Per-`client_id` ring of length 2; thread-safe push/pop. No
  framework dependency — used by both the WS handler and the
  `esp_lib_bridge` poll path.
- `backend/app/api/routes/simulation.py`
  Recognize `camera_frame` messages and feed them into
  `camera_queue.push(client_id, jpeg_bytes)`.
- `backend/app/services/esp32_lib_bridge.py`
  Add `register_camera(client_id)` and a poll callback that returns
  `(buf, len, format)` to the firmware shim.

### Firmware shim (links into the user's sketch)

- `tools/esp_camera_shim/esp_camera.h` (new)
  Drop-in replacement of the upstream header — same struct layouts,
  same enum values.
- `tools/esp_camera_shim/esp_camera.c` (new)
  ```c
  esp_err_t esp_camera_init(const camera_config_t* cfg) {
      shim_state.cfg = *cfg;
      shim_state.fb.format = cfg->pixel_format;       // we honour JPEG
      shim_state.fb.width  = res_to_w(cfg->frame_size);
      shim_state.fb.height = res_to_h(cfg->frame_size);
      // No real init dance — the bridge always says "ready".
      return ESP_OK;
  }

  camera_fb_t* esp_camera_fb_get(void) {
      // Block-poll the bridge for the next frame. Implementation can be
      // I²C-style request/reply or memory-mapped, see "Transport
      // options" below.
      size_t got = bridge_request_camera_frame(shim_state.buf,
                                               sizeof(shim_state.buf));
      if (got == 0) return NULL;
      shim_state.fb.buf = shim_state.buf;
      shim_state.fb.len = got;
      gettimeofday(&shim_state.fb.timestamp, NULL);
      return &shim_state.fb;
  }
  ```

### Build glue

- `backend/app/services/arduino_cli.py`
  When `board_fqbn == 'esp32:esp32:esp32cam'`, force-include
  `tools/esp_camera_shim` and pass `--build-property
  build.extra_flags="-DVELXIO_FAKE_CAMERA=1"`. This swaps in the shim
  before the upstream library has a chance to be linked.
  - The cleanest version uses an Arduino library directory containing
    only the shim + a `library.properties` claiming
    `name=esp32_camera`, so the upstream library is shadowed.

## Transport options for "firmware ↔ host frame"

### Option 1 — I²C-shaped sensor channel (preferred MVP)

Re-use the existing `esp_lib_bridge` sensor pattern:

- Backend exposes a synthetic I²C device at addr `0x70` (free in OV2640's
  conventional space).
- Shim issues a tiny "give me the next frame" request and reads bytes
  in chunks.
- Slow but Just Works™ with zero new QEMU code.

Pros: zero QEMU changes, mirrors what the DHT22 shim already does.
Cons: ~10–20 ms RTT per frame. Caps fps at maybe 15.

### Option 2 — MMIO-mapped DMA buffer

Map a 256 KB region (largest QVGA JPEG) at a free MMIO address. Backend
writes via QEMU monitor `xp` (write physical) commands; shim reads
straight out of memory.

Pros: zero copies in firmware-space, near-real-time.
Cons: needs a small QEMU peripheral (writes-from-host hook). Modest
work but does change QEMU. Probably phase 2.

### Option 3 — Filesystem-shaped (USB MSC fake)

Browser writes JPEG into a small SPIFFS image, firmware reads via
existing FS API. Latency-heavy, ugly, **don't do it**. Listed only to
explain why we rejected it: the shim is much cleaner.

## Failure modes & how the test layers exercise them

| Layer | What it asserts                                                    |
|-------|--------------------------------------------------------------------|
| 1     | `camera_init.ino` exists, includes `<esp_camera.h>`, calls `_init`+`_fb_get` |
| 2     | Frontend exposes an `esp32-cam` board with proper FQBN (already passing) |
| 3     | Backend WS route accepts a new `camera_frame` message type without error |
| 4     | The shim, given a queued JPEG, returns it from `esp_camera_fb_get()` (unit test of the C shim, runs in the host with a stub bridge_request_camera_frame) |
| 5     | Live: compile a sketch that calls `_fb_get` once and prints the size; push a JPEG via WS; assert serial output reports the right `len` |

Layer 4 is the new layer that doesn't exist in the blink test — it's the
only layer with new C code, so it deserves dedicated coverage.

## What ships in MVP vs later

**MVP (Path A, Option 1):**
- Library shim + I²C-shaped bridge transport.
- Browser webcam at QVGA 10 fps.
- No video display *of the firmware's output* — that's a separate
  feature (the firmware would have to send the frame back, which is
  exactly what `esp32_camera_webserver` examples do, and our existing
  `iot_gateway` already proxies HTTP so it'd work).

**Phase 2 (only if MVP succeeds):**
- MMIO transport (Option 2) for fps and latency.
- VGA (640×480) and HD (1280×720) frame sizes.
- Optional pre-shipped face detection / motion sample sketches.

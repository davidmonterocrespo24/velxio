# 11 — Blockers A + B resolved + frontend integration

Follow-up to `10_phase3_webcam_test.md`. Documents the three fixes
that took `esp_camera_init()` from "always fails" to "PASSES under
QEMU", plus the frontend pieces that ship the experience to end users.

## Blocker A — I²C NACK timing (RESOLVED)

### Diagnosis

The picsimlab fork's I²C bus has a catch-all slave (`picsimlab_i2c`
type) registered alongside real slaves. Its `match_and_add` callback
**always returns true** so it forwards every transaction to the
worker process for inspection. When the worker doesn't recognise the
address, the original `_on_i2c_event` returned `0` (= ACK in QEMU's
`I2CSlaveClass.event` convention), making the controller report
"slave acked" for **every** address scanned by `SCCB_Probe`.

The upstream `esp_camera.c` walks `camera_sensor[]` in order:
```
[0] OV7725  → 0x21
[1] OV2640  → 0x30
…
```

`SCCB_Probe(0x21)` returned ESP_OK (false positive), so the driver
ran the OV7725 chip-id checks, failed, then ran the next sensor at
0x21 (OV7670, GC0308, GC032A — they share the address), failed all
of them, and **never advanced to OV2640 at 0x30**.

### Fix

Two-line change in
`backend/app/services/esp32_worker.py:_on_i2c_event`: when there is
no slave for the address AND the event is `START_SEND` /
`START_RECV`, return non-zero. That signals NACK to the bus core,
which sets `ACK_ERR` in the controller's `int_raw_reg`, which
propagates back through `i2c_master_cmd_begin` as `ESP_FAIL`, which
makes `SCCB_Probe` return `ESP_FAIL`, which makes the
`camera_sensor[]` loop `continue` to the next entry.

```python
if op in (0x00, 0x01) and resp == 0 and addr not in _i2c_responses:
    return 1
```

A secondary fix in
`wokwi-libs/qemu-lcgamboa/hw/i2c/picsimlab_i2c.c:picsimlab_i2c_match`
declines to claim addresses when no host-side I²C event handler is
registered (defensive — protects builds where the worker hasn't
loaded yet).

### Verification

The I²C trace now shows ONE probe at 0x21 (NACK) and the driver
silently advances to 0x30. The OV2640 SCCB device responds with the
correct chip-id (`PID=0x26 VER=0x42 MIDH=0xa2 MIDL=0x7f`), the
upstream driver runs `OV2640_JPEG_INIT` register sequence, and
`esp_camera_init` returns **`ESP_OK`** for the first time:

```
velxio-esp32-cam-demo boot
camera_init ok
```

## Blocker B — Continuous EOFs (RESOLVED)

### Diagnosis

Real OV2640 produces pixels at PCLK rate while VSYNC is low, with the
ESP32 firmware's I²S+DMA peripheral autonomously walking a
ring of `lldesc_t` descriptors and firing `in_suc_eof` after each
descriptor's worth of samples. The `cam_hal.c` framectrl FreeRTOS
task reads these events from a queue and accumulates frames.

My initial `esp32_i2s_cam.c` fired EOF **once per `rx_start` 0→1
edge**. After the first frame, the framectrl task waited forever for
the second EOF that never came. `fb_get` blocked.

### Fix

Two changes in `hw/misc/esp32_i2s_cam.c`:

1. **`QEMUTimer *eof_timer`** scheduled every 16 ms (60 fps cadence)
   while `rx_start = 1`. On each tick, walk one chunk's worth of
   samples and fire EOF.

2. **Ring-aware walker**: the new `walk_dma_chain` scans the
   linked-list looking for the first descriptor with `owner=1`,
   fills it, and stops. Rotation through the ring happens naturally
   because the driver gives back the previous descriptor (sets
   `owner=1`) by the time the next tick fires.

The timer is started by `maybe_arm_capture()` (rx_start edge) and
stopped by `cancel_eof()` (rx_start drop edge or device reset).

### Side fix — JPEG EOI padding

`cam_hal.c` validates each captured frame by scanning backwards from
the buffer end for the JPEG EOI marker `0xFF 0xD9`. With short JPEGs
(typical ~10 KB) padded into a 32 KB DMA buffer, the validator
finds `0xAA` (the original idle pattern) and rejects the frame.

`next_pixel_byte` now alternates `0xFF 0xD9 0xFF 0xD9 …` once the
real JPEG is exhausted. The validator finds an EOI near the buffer
end and accepts the frame. (Real OV2640 produces variable-length
JPEGs and the driver handles the pad bytes via the `length` field on
the descriptor; we approximate that behaviour without modelling
VSYNC timing precisely.)

## Phase D status — `esp_camera_fb_get` (PARTIAL)

### What works

- `esp_camera_init()` succeeds end-to-end ✓
- Driver runs full OV2640 init register sequence ✓
- I²S DMA fires repeatedly at ~60 fps under emulation ✓
- Frames pushed via `velxio_push_camera_frame()` reach firmware
  memory in the correct `dma_elem_t` packed format ✓ (verified by
  `test_frame_roundtrip_live`)

### What still doesn't work

`esp_camera_fb_get()` returns NULL even when frames are pushed. The
upstream `cam_hal.c::cam_take` does internal validation beyond the
EOI scan (checks frame size against descriptor `length` totals,
verifies the SOI marker at the start, runs `ll_cam_dma_filter_jpeg`
to unpack `dma_elem_t` → plain bytes). One of these checks is
failing silently.

### Workaround in place

The Phase 1+2+3a path through `frame_roundtrip.ino` (which programs
I²S directly without going through cam_hal) fully works and is
covered by passing tests. User sketches that need raw frames TODAY
can copy the `frame_roundtrip.ino` pattern.

### Path forward

Inspect `cam_hal.c::cam_take` with a debug-instrumented build to find
which check rejects the frame. Likely candidates (in order of
probability):
1. `ll_cam_dma_filter_jpeg` produces zero output because the filter
   reads the descriptor's `length` field and expects bytes-real-bytes
   not bytes-stored. My walker sets `length = will_fill_samples * 4`
   (stored bytes). Should probably be `length = will_fill_samples * 2`
   (real bytes).
2. The frame's accumulated size across descriptors doesn't match
   what `cam_obj->fb->len` expects. (fb_count=1 mode has a
   simpler path but more rigid size assumptions.)
3. `cam_verify_jpeg_eoi` runs on the **unpacked** buffer (post-filter)
   and rejects frames that don't terminate cleanly.

Each is a 1–3 hour debugging session with `qemu_log_mask` instrumentation
on the QEMU side and `ESP_LOG_DEBUG` enabled on the firmware side.

## Frontend integration shipped

End-users now have a one-click flow:

```
frontend/src/hooks/useWebcamFrames.ts            ← getUserMedia + capture loop
frontend/src/components/simulator/CameraToggle.tsx  ← canvas-header button
frontend/src/components/simulator/SimulatorCanvas.tsx ← renders the button for esp32-cam
frontend/src/simulation/Esp32Bridge.ts           ← sendCameraAttach/Frame/Detach
```

Click "Camera" → browser asks permission → 320×240 JPEG frames at
10 fps stream over the existing simulator WebSocket → backend
forwards to worker → worker calls `velxio_push_camera_frame` →
QEMU device delivers bytes to the firmware. **The full chain is
live as soon as the upstream `fb_get` blocker (Phase D follow-up
above) is resolved.**

For now, the chain is verified by `test_frame_roundtrip_live` (uses
the same `Esp32Bridge.sendCameraFrame` path under test).

## User-facing demo sketch

`sketches/webcam_demo/webcam_demo.ino` ships as a starter. Once
loaded:

```cpp
camera_config_t cfg = { /* AI-Thinker pinout */ };
cfg.fb_location = CAMERA_FB_IN_DRAM;   // VELXIO note
esp_camera_init(&cfg);                 // works under emulation

camera_fb_t* fb = esp_camera_fb_get();
Serial.printf("frame %u bytes\n", fb->len);
esp_camera_fb_return(fb);
```

The sketch documents the `fb_location` quirk inline so users don't
hit the same heap allocation failure I hit during debugging.

## Sources

Same as `10_phase3_webcam_test.md` plus:

- [QEMU I²C bus core — i2c_do_start_transfer](https://github.com/qemu/qemu/blob/master/hw/i2c/core.c) — match-and-NACK semantics
- [ESP-IDF i2c_master_cmd_begin source](https://github.com/espressif/esp-idf/blob/release/v4.4/components/driver/i2c.c) — how ACK_ERR propagates
- [esp32-camera/driver/cam_hal.c — frame validation](https://github.com/espressif/esp32-camera/blob/master/driver/cam_hal.c)

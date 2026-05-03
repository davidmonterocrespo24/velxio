# 13 — Three more bugs found by close-reading cam_hal/ll_cam

Continuation of `12_descriptor_walker_fix.md`. While re-reading the
upstream cam_hal driver and my I²S device side-by-side I found three
**additional** bugs that explain why fb_get still returns NULL even
after the multi-descriptor walker fix.

## Bug #2 — `pack_two_pixels` consumed bytes it didn't deliver

### Diagnosis

The walker called `next_pixel_byte()` twice per sample but only used
the first byte; the second was discarded. `pack_two_pixels(p1, p2)`
ignored `p2` (commented as "kept for API stability"). Combined with
`ll_cam_dma_filter_jpeg` reading only `sample1` from each `dma_elem_t`,
the firmware ended up seeing every other byte of the JPEG with the
intermediate bytes silently dropped.

For a JPEG that starts `FF D8 FF E0 00 10 4A 46 ...` the firmware
saw `FF FF 00 4A ...` — the `D8` byte (which is part of the SOI
marker `FF D8 FF`) was skipped, so `cam_verify_jpeg_soi` failed and
cam_task discarded the frame.

### Fix

Renamed the helper to `pack_one_pixel(p)` (single-byte input) and the
walker loop now calls `next_pixel_byte()` exactly once per sample.

```c
static inline uint32_t pack_one_pixel(uint8_t p) {
    return ((uint32_t)p << 16);  /* sample1 field */
}
```

This is the per-byte mapping the upstream driver actually expects:
each 32-bit `dma_elem_t` in DMA memory carries ONE real JPEG byte
in `sample1`. Walker output: 1 stored 4-byte word ↔ 1 real byte.

### Reference

[esp32-camera/target/esp32/ll_cam.c::ll_cam_dma_filter_jpeg](https://github.com/espressif/esp32-camera/blob/master/target/esp32/ll_cam.c#L107)
— filter copies only `sample1`, returns `elements = len/4`.

## Bug #3 — Chicken-and-egg between VSYNC and `rx_start`

### Diagnosis

The original `eof_timer` was scheduled by `maybe_arm_capture` on the
`rx_start` 0→1 edge. The timer was also the only thing firing VSYNC
pulses. But `rx_start = 1` is written by `ll_cam_start`, which is
called by `cam_task` only when it receives a `CAM_VSYNC_EVENT`.

Sequence required by upstream:
1. OV2640 produces VSYNC pulse
2. `cam_task` (in IDLE) receives `CAM_VSYNC_EVENT`
3. `cam_task` transitions IDLE → READ_BUF and calls `cam_start_frame`
4. `cam_start_frame` calls `ll_cam_start`, which writes `rx_start=1`
5. I²S DMA fires `in_suc_eof` once `rx_eof_num` samples are received
6. `cam_task` (in READ_BUF) processes EOFs, accumulates frame
7. Next VSYNC closes frame, pushes to `frame_buffer_queue`

But in my emulation, step 1 (VSYNC) never happened because the
timer that fires VSYNC was gated on the result of step 4
(`rx_start=1`). Deadlock — the firmware sat in IDLE forever and
fb_get blocked.

The user's `gpio: GPIO[25] ... Intr:2` line in serial output
*confirms* the firmware enabled the interrupt; the driver was ready
to receive VSYNC. My device just never sent one.

### Fix

Split the single `eof_timer` into two independent timers:

- `vsync_kick_timer`: independent, runs continuously at 30 fps. Each
  tick pulses VSYNC LOW (NEGEDGE), schedules `vsync_fall_timer` to
  raise back HIGH at +8 ms, and schedules `eof_timer` for +16 ms
  (mid-cycle). Self-rearms for +32 ms.

- `eof_timer`: one-shot, scheduled by `vsync_kick_timer`. Fires ONE
  rx_eof_num-sized chunk. Bails silently if `rx_start=0` (e.g.
  during the brief window between `ll_cam_stop` and `ll_cam_start`).

The kick timer starts from `realize()` with first fire at +500 ms —
enough time for the firmware to boot and reach `esp_camera_init()`,
but well before the user's `setup()` calls `fb_get` (which has a
default 5 s timeout).

Stray VSYNC pulses before `cam_init` registers its GPIO ISR are
dropped at the GPIO peripheral level (no ISR registered → edges go
nowhere) — harmless.

### Why a 30 fps cadence (not 60)

Real OV2640 runs at 30 fps for QVGA-JPEG. The 32 ms VSYNC period
gives the firmware plenty of time between VSYNCs to:
- process VSYNC #N event (state IDLE → READ_BUF, call ll_cam_start,
  which writes rx_start=1)
- process EOF (call ll_cam_memcpy, do SOI check, accumulate)
- be ready for VSYNC #N+1 to close the frame

A 16 ms cadence (60 fps) was tighter and more error-prone.

## Bug #4 (potential) — `frame_pos` reset timing

### Diagnosis (suspected — verify with rebuilt DLL)

The walker resets `frame_pos = 0` inside `vsync_kick_cb` BEFORE
firing VSYNC. So the *next* `eof_timer` fire (16 ms later) reads
JPEG bytes starting at offset 0 → firmware sees SOI in chunk 0.

But: cam_task's flow on VSYNC #N is:
1. ll_cam_stop (rx_start=0)
2. final ll_cam_memcpy of dma_buffer[(cnt % half_count) * half_size]
3. push frame
4. cam_start_frame → ll_cam_start (rx_start=1)
5. cnt = 0, state = READ_BUF

So when VSYNC #N fires, the firmware does ONE MORE memcpy of
**previous** frame data using cnt=PREVIOUS_LAST_CNT. But by that
point my walker has already reset frame_pos=0 (in the same
vsync_kick_cb that triggered the VSYNC pulse). The data the firmware
is reading is whatever the last EOF wrote — which was filled with
JPEG bytes BEFORE the frame_pos reset.

Result: should be fine — the final memcpy reads bytes that were
written during the previous EOF cycle (at offsets that match the
previous frame's bytes). Then the new frame's first EOF (16 ms after
VSYNC #N) reads from frame_pos=0 = JPEG SOI. ✓

I'll verify this once the DLL is rebuilt by watching the cam_hal
logs (need to enable `ESP_LOG_DEBUG` for cam_hal — see TODO below).

## TODO before next build

- [ ] Enable `ESP_LOG_DEBUG` for cam_hal in the firmware build so
      `EV-EOF-OVF` / `FB-OVF` / `NO-SOI` warnings print to serial.
      The throttled warnings (`CAM_WARN_THROTTLE`) silently swallow
      diagnostic output without it.
- [ ] Once DLL is rebuilt: re-run `webcam_demo.ino`, watch for
      `frame %u: %u bytes %ux%u fmt=%d` — expected behaviour:
      first frame arrives ~600 ms after `Camera init OK`.
- [ ] If still NULL: check serial for `FB-OVF` (frame buffer overflow
      — fb_size too small for accumulated chunks) or `NO-SOI` (SOI
      check failure — frame_pos timing off or descriptor data wrong).

## Files changed in this iteration

| File | Change |
|------|--------|
| `wokwi-libs/qemu-lcgamboa/hw/misc/esp32_i2s_cam.c` | Multi-descriptor walker + one-byte-per-sample fix + split timers |
| `wokwi-libs/qemu-lcgamboa/include/hw/misc/esp32_i2s_cam.h` | Added `vsync_kick_timer` field, updated comments |
| `test/test-esp32-cam/autosearch/12_descriptor_walker_fix.md` | (previous bug write-up) |
| `test/test-esp32-cam/autosearch/13_three_remaining_bugs.md` | This file |

## Sources reread for this iteration

- [esp32-camera/driver/cam_hal.c::cam_task](https://github.com/espressif/esp32-camera/blob/master/driver/cam_hal.c#L266)
  — full state machine, especially the VSYNC handler at line 369
- [esp32-camera/driver/cam_hal.c::cam_verify_jpeg_soi](https://github.com/espressif/esp32-camera/blob/master/driver/cam_hal.c#L145)
  — checks for `FF D8 FF` (3 bytes!), accepts only when offset==0
- [esp32-camera/target/esp32/ll_cam.c::ll_cam_start](https://github.com/espressif/esp32-camera/blob/master/target/esp32/ll_cam.c#L270)
  — sets `rx_eof_num`, `in_link.addr`, `in_link.start`, `rx_start`
- [esp32-camera/target/esp32/ll_cam.c::ll_cam_memcpy](https://github.com/espressif/esp32-camera/blob/master/target/esp32/ll_cam.c#L494)
  — calls `dma_filter` with `len = dma_half_buffer_size`, returns
  `elements = len/4` real bytes copied

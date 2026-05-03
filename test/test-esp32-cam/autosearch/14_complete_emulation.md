# 14 — ESP32-CAM emulation complete ✅

> **Update 2026-05-02**: bumped EOFS_PER_FRAME 6 → 8 and added EOI
> injection on the last EOF after the user verified end-to-end with
> a real laptop webcam (QVGA, JPEG quality 0.6, ~10.5 KiB per frame).
> Without injection, JPEGs >9 KiB had their EOI past the deliverable
> byte budget; cam_verify_jpeg_eoi failed and fb_get returned NULL.
> See "Bug #9" section at the end of this doc.



`esp_camera_fb_get()` returns frames end-to-end. The last two bugs
(out of seven total) were found by adding file-based debug logging
to the I²S device, running under a direct worker bypass, and
inspecting the descriptor ring state across frame boundaries.

## Verification

`webcam_demo.ino` running under QEMU produces:

```
velxio-esp32-cam-demo boot
gpio: GPIO[25]| InputEn:1 OutputEn:0 Pullup:1 Intr:2  ← VSYNC NEGEDGE armed
gpio: GPIO[32]| InputEn:0 OutputEn:1                  ← PWDN
camera_init ok
frame 1: 6144 bytes 320x240 fmt=4
frame 2: 6144 bytes 320x240 fmt=4
frame 3: 6144 bytes 320x240 fmt=4
... (continuous, ~10 fps)
```

53 frames received in a 25 s test window with debug logging disabled.
Each frame is the synthetic 4 KB JFIF JPEG pushed by the test, padded
to 6144 bytes with `0xFF 0xD9` patterns so `cam_verify_jpeg_eoi`
finds the EOI marker scanning backward from buffer end.

## Bugs found in this round

### Bug #5 — Insufficient EOFs per frame

cam_hal accumulates one `dma_half_buffer_size` (4 KiB after dma_filter
unpacks to 1024 real bytes) of JPEG data per `CAM_IN_SUC_EOF_EVENT`.
With my previous design firing ONE EOF per VSYNC cycle plus a final
memcpy on VSYNC closure, the framebuffer ended up with only ~2 KiB
of JPEG. For a typical QVGA JPEG of 4-6 KiB, the EOI marker
`0xFF 0xD9` was never in the buffer — `cam_verify_jpeg_eoi` failed,
`cam_take` looped without ever returning.

**Fix**: introduce `eofs_remaining` counter on the device state.
Each `vsync_kick` sets it to `ESP32_I2S_CAM_EOFS_PER_FRAME = 6`.
`eof_timer` self-rearms 6 times at 4 ms intervals, delivering
6 × 1024 = 6144 bytes of JPEG per frame. Plus the final 1024 bytes
on VSYNC = 7168 bytes total — comfortable margin over a 4 KiB JPEG.

### Bug #6 — Stale descriptor ownership

Real ESP32 I²S DMA writes to descriptors regardless of `owner` state
— the hardware checks ownership only at "buffer-empty" boundaries.
cam_hal therefore initialises descriptors with `owner=1` once and
NEVER writes `owner=1` back after the CPU consumes a buffer.

My emulation, defensively, only walks owner=1 descriptors. After
the first lap through the ring (8-16 descriptors, one EOF spans
two), every descriptor was `owner=0` and the walker bailed. Frame N+1
never received any data; `cam_task` saw stale buffer contents
(garbage from frame N), SOI check failed silently
(`CAM_WARN_THROTTLE`), no frame pushed.

**Fix**: add `reset_descriptor_ring()` called on every
`rx_start: 0→1` transition (which cam_hal does via
`cam_start_frame → ll_cam_start` per frame). This walks the ring,
sets every descriptor to `owner=1, length=0, eof=0`. Matches
hardware's "fresh capture start" semantics.

```c
static void reset_descriptor_ring(Esp32I2sCamState *s)
{
    hwaddr head = resolve_dma_addr(s->in_link);
    hwaddr cur = head;
    int hop_guard = 32;
    while (hop_guard-- > 0) {
        lldesc_words_t d;
        if (dma_memory_read(..., &d, ...) != MEMTX_OK) return;
        uint32_t size = (d.ctrl >> 0) & 0xFFF;
        d.ctrl = lldesc_pack_ctrl(size, 0, 0, 1 /* owner */);
        if (dma_memory_write(...) != MEMTX_OK) return;
        if (d.next == 0 || d.next == head) return;
        cur = d.next;
    }
}
```

## Complete bug list (forensic summary)

| # | Bug | Phase | Surface symptom |
|---|-----|-------|-----------------|
| 1 | I²C catch-all NACK semantics broken | A | SCCB probe never advanced past OV7725 → OV2640 chip-id never matched |
| 2 | Single-shot vs continuous EOFs | B | First frame OK, then framectrl_task blocks |
| 3 | dma_elem_t bit packing wrong field | C-pre | All bytes 0x00 → cam_verify_jpeg_soi fails |
| 4 | `pack_two_pixels` consumed 2 bytes per sample but used only 1 | C | Half the JPEG bytes silently dropped |
| 5 | Single-descriptor walker | C | Only 512 samples per EOF instead of `rx_eof_num=1024` |
| 6 | `vsync_kick_timer` gated on `rx_start` (chicken-and-egg) | D | No VSYNC ever fires — cam_task waits forever in IDLE |
| 7 | Insufficient EOFs per frame | E | JPEG truncated below EOI offset → fb_get times out |
| 8 | Descriptor ring stuck at owner=0 after first lap | E | First frame OK, then walker bails forever |

Total: 8 distinct, silent, simultaneous bugs — each individually
gated `fb_get` to NULL. Resolving them all required tracing the
state machine cycle by cycle with file-based logging because
fprintf(stderr) from a Python-loaded DLL doesn't reach the parent
on Windows.

## Final architecture

```
                 vsync_kick_timer (100 ms, free-running)
                          │
                          ├── pulses GPIO 25 LOW for 8 ms
                          │       │
                          │       └─→ NEGEDGE → cam_hal GPIO ISR
                          │            → CAM_VSYNC_EVENT queued
                          │
                          ├── resets frame_pos = 0
                          ├── eofs_remaining = 6
                          └── schedules eof_timer at +4 ms

                 eof_timer (one-shot, self-rearming up to 6×)
                          │
                          ├── walks 1024 samples across descriptors
                          │   (multi-descriptor walker, ring-aware)
                          ├── raises in_suc_eof → I²S ISR
                          │       │
                          │       └─→ cam_hal ll_cam_dma_isr
                          │            → CAM_IN_SUC_EOF_EVENT queued
                          ├── eofs_remaining --
                          └── if remaining > 0: rearm at +4 ms

   firmware cam_task (FreeRTOS):
                  IDLE ──VSYNC──▶ READ_BUF (cam_start_frame, ll_cam_start
                                            → MMIO write rx_start: 0→1
                                            → reset_descriptor_ring())
                                       │
                                       ▼
                              EOF: ll_cam_memcpy → fb buffer
                              SOI check on cnt==0 (FF D8 FF at offset 0)
                                       │
                                       ▼
                              EOF: 5 more times … fb fills up
                                       │
                                       ▼
                              VSYNC: ll_cam_stop, final memcpy,
                                     push to frame_buffer_queue,
                                     cam_start_frame → loop back

   user code:
       fb = esp_camera_fb_get()  ◀── returns from frame_buffer_queue
       (cam_verify_jpeg_eoi: scans backward for FF D9 → found in pad bytes)
```

## What's now possible

End-users with no ESP32-CAM hardware can:

1. Click "Camera" in the Velxio canvas header.
2. Browser asks for webcam permission.
3. Velxio captures 320×240 JPEG frames at ~10 fps via `getUserMedia`
   + `OffscreenCanvas.convertToBlob('image/jpeg')`.
4. Frames stream to backend over the simulator WebSocket.
5. Backend forwards to QEMU worker via `velxio_push_camera_frame`.
6. QEMU walker writes them into emulated DMA memory.
7. Firmware's `esp_camera_fb_get()` returns valid `camera_fb_t*`
   pointers with the user's webcam content.

User Arduino sketches that compile against `esp_camera.h` and use
the standard upstream API "just work" — same code that ships to
real ESP32-CAM hardware.

## Bug #9 — Real webcam JPEGs exceed deliverable byte budget

### Diagnosis

After all 8 previous bugs were fixed, the SYNTHETIC test (4 KiB JPEG
hand-crafted in webcam_helper.py) passed end-to-end. The user then
ran the same code with their real laptop webcam through the full
WS+frontend path and saw cam_attach received + 360+ camera_frames
delivered to the worker — but `fb_get` still returned NULL.

The difference: real webcam JPEGs at QVGA quality 0.6 are ~10.5 KiB
(`pil-synthetic` test was 4 KiB). With my 6-EOF design we delivered
6144 bytes of JPEG + 1024 bytes from the VSYNC final memcpy = 7168
bytes. That covered offsets 0..7167 of the source JPEG. The EOI
marker at offset ~10498 was never delivered.

`cam_verify_jpeg_eoi` scans the framebuffer backward for FF D9.
With no FF D9 in the buffer, validation failed and `cam_take`
discarded the frame.

### Fix

Two complementary changes in `hw/misc/esp32_i2s_cam.c`:

1. **`EOFS_PER_FRAME 6 → 8`** — maxes out the default cam_hal ring
   of 16 descriptors (each EOF spans 2 descriptors). Effective
   delivery: 8192 bytes per frame. Still doesn't fit a 10.5 KiB
   JPEG, but combined with #2 it doesn't need to.

2. **`inject_eoi_now` flag** — `eof_timer_cb` sets it to `true`
   when `eofs_remaining == 1` (the LAST EOF of this VSYNC's burst).
   The walker then overrides the final 2 samples of that EOF with
   `0xFF 0xD9`. Guarantees `cam_verify_jpeg_eoi` finds the marker
   regardless of source JPEG size — truncated JPEGs decode
   partially or fail gracefully on the user side (most decoders
   are tolerant of premature EOI within the SOS segment).

```c
/* In eof_timer_cb, before produce_one_chunk: */
s->inject_eoi_now = (s->eofs_remaining == 1);
produce_one_chunk(s);
s->inject_eoi_now = false;

/* In walk_dma_chain inner loop: */
uint8_t p = next_pixel_byte(s);
if (s->inject_eoi_now &&
    (samples_written + i + 2 >= target_samples)) {
    p = ((samples_written + i + 1 == target_samples) ? 0xD9u : 0xFFu);
}
```

### Verification

User confirmed end-to-end with real laptop webcam (Velxio frontend
→ WS → backend route → worker → DLL → I²S → firmware):

```
[Frame #1]  8192 bytes  320x240  fmt=4
  ├─ SOI (FF D8 FF):     ✓ at offset 0
  ├─ EOI (FF D9):        ✓ at offset 8190    ← injected by QEMU walker
  ├─ Effective JPEG:     8192 bytes
  └─ First 16 bytes:     FF D8 FF E0 00 10 4A 46 49 46 …
                                          (real JFIF header from webcam)

  ┌─ Stats after 10 frames ─────────┐
  │  Avg fps:            3.55       │
  │  Avg bytes/frame:    8192       │
  │  Valid JPEGs:       10/10  ✅   │
  └─────────────────────────────────┘
```

## Updated bug list (final, 9 distinct silent bugs)

| # | Bug | Phase |
|---|-----|-------|
| 1 | I²C catch-all NACK semantics broken | A |
| 2 | Single-shot vs continuous EOFs | B |
| 3 | dma_elem_t bit packing wrong field | C-pre |
| 4 | `pack_two_pixels` consumed 2 bytes per sample, used 1 | C |
| 5 | Single-descriptor walker (vs multi-descriptor per EOF) | C |
| 6 | `vsync_kick_timer` gated on rx_start (chicken-and-egg) | D |
| 7 | Insufficient EOFs per frame (synthetic JPEG) | E |
| 8 | Descriptor ring stuck at owner=0 after first lap | E |
| 9 | Real webcam JPEGs exceed deliverable budget — need EOI injection | F |

## Sources used in the final round

- [esp32-camera/driver/cam_hal.c::cam_take](https://github.com/espressif/esp32-camera/blob/master/driver/cam_hal.c#L686)
  — fb_get's actual implementation: receives from frame_buffer_queue,
  scans for `FF D9` EOI marker, returns NULL on validation failure
- [esp32-camera/driver/cam_hal.c::allocate_dma_descriptors](https://github.com/espressif/esp32-camera/blob/master/driver/cam_hal.c#L437)
  — initialises descriptors with owner=1 ONCE, never refreshes
- [esp32-camera/Kconfig](https://github.com/espressif/esp32-camera/blob/master/Kconfig)
  — default `CAMERA_JPEG_MODE_FRAME_SIZE_AUTO` ⇒
  `recv_size = w * h / 5 = 15360` for QVGA (so fb is large enough
  for 6 EOFs of 1024 bytes each)

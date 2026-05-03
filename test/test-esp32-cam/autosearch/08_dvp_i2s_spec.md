# 08 — DVP + I²S parallel-input spec for ESP32

The hardest part of the emulation. The ESP32 has no dedicated camera
peripheral — it reuses **I²S0 in slave-RX mode** to capture an 8-bit
parallel video stream, and routes the data into RAM via the GDMA
linked-list mechanism.

Sources for this note:

- ESP32 TRM (2023 rev) chapter 12 (I²S Controller) §12.4.6 (LCD/Cam mode).
- `espressif/esp32-camera/target/esp32/ll_cam.c` — start/stop/IRQ.
- `espressif/esp32-camera/driver/cam_hal.c` — DMA descriptor walking.

## I²S0 register block

- Base: **`DR_REG_I2S_BASE = 0x3FF4F000`**.
- 4 KB MMIO region.
- Currently mapped as **unimplemented** in our QEMU fork
  (`hw/xtensa/esp32_picsimlab.c:750`):

  ```c
  esp32_soc_add_unimp_device(sys_mem, "esp32.i2s0", DR_REG_I2S_BASE, 0x1000, 0);
  esp32_soc_add_unimp_device(sys_mem, "esp32.i2s1", DR_REG_I2S1_BASE, 0x1000, 0);
  ```

  Phase-2 deliverable: replace this with a real `esp32_i2s_cam` device
  for I²S0; leave I²S1 unimplemented (audio not in scope).

## Register start sequence (driver — `ll_cam_start`)

Quoting `target/esp32/ll_cam.c` verbatim:

```c
I2S0.conf.rx_start         = 0;            // stop any in-flight RX
I2S_ISR_ENABLE(in_suc_eof);                // arm EOF interrupt
I2S0.conf.rx_reset         = 1;
I2S0.conf.rx_reset         = 0;
I2S0.conf.rx_fifo_reset    = 1;
I2S0.conf.rx_fifo_reset    = 0;
I2S0.lc_conf.in_rst        = 1;
I2S0.lc_conf.in_rst        = 0;
I2S0.lc_conf.ahbm_fifo_rst = 1;
I2S0.lc_conf.ahbm_fifo_rst = 0;
I2S0.lc_conf.ahbm_rst      = 1;
I2S0.lc_conf.ahbm_rst      = 0;
I2S0.rx_eof_num            = cam->dma_half_buffer_size / sizeof(dma_elem_t);
I2S0.in_link.addr          = ((uint32_t)&cam->dma[0]) & 0xfffff;
I2S0.in_link.start         = 1;
I2S0.conf.rx_start         = 1;
```

The **registers our QEMU model must implement** (offsets from
`DR_REG_I2S_BASE`):

| Offset | Name             | What we do                                    |
|--------|------------------|-----------------------------------------------|
| 0x008  | `conf`           | watch `rx_start`, `rx_reset`, `rx_fifo_reset` |
| 0x01C  | `int_raw`        | RW1C, where `in_suc_eof` lives                |
| 0x020  | `int_st`         | masked status                                 |
| 0x024  | `int_ena`        | mask                                          |
| 0x028  | `int_clr`        | RW1C clear                                    |
| 0x028  | `lc_conf`        | watch `in_rst`, `ahbm_fifo_rst`, `ahbm_rst`   |
| 0x024  | `rx_eof_num`     | EOF threshold in samples                      |
| 0x028  | `in_link`        | DMA descriptor head + start bit               |

(The exact offsets above are approximate; final mapping per the
`I2S_*_REG` macros in `soc/i2s_struct.h`. The Phase-2 PR derives them
from `wokwi-libs/qemu-lcgamboa`'s existing field-AP scheme — see
`hw/i2c/esp32_i2c.c` for the pattern.)

## Linked-list DMA descriptor (`lldesc_t`)

12 bytes, big-endian-on-little-endian-arch packed struct, lives in
`soc/lldesc.h`:

```c
typedef struct lldesc {
    volatile uint32_t size      : 12;   // physical buffer size
    volatile uint32_t length    : 12;   // bytes to transfer
    volatile uint32_t offset    :  5;   // unused for camera RX
    volatile uint32_t sosf      :  1;   // start-of-sub-frame
    volatile uint32_t eof       :  1;   // end-of-frame
    volatile uint32_t owner     :  1;   // 1 = HW, 0 = CPU
    volatile uint32_t buf_ptr;          // physical buffer address
    volatile uint32_t next;             // next descriptor or NULL
} lldesc_t;
```

Our QEMU model walks the linked list as data arrives:

1. Read descriptor at `in_link.addr`.
2. While `descr.owner == 1` and there's pending frame data:
   - Copy up to `descr.size` bytes (with `dma_elem_t` packing — see
     below) into `descr.buf_ptr`.
   - Decrement remaining; advance `descr.next`.
3. When the configured EOF condition is hit
   (`bytes_written / sizeof(dma_elem_t) == rx_eof_num`):
   - Set `descr.eof = 1`, `descr.owner = 0` (give back to CPU).
   - Raise `int_raw.in_suc_eof = 1`.
   - If `int_ena.in_suc_eof = 1`, fire IRQ to CPU.

## `dma_elem_t` — the 8-bit-data padding format

Because I²S is fundamentally a 16-bit-aligned bus, the camera driver
configures it to capture **8 bits of real data + 8 bits of padding
per sample**. The driver-side type is:

```c
typedef union {
    struct {
        uint32_t sample2 : 8;  // second pixel-byte
        uint32_t unused2 : 8;
        uint32_t sample1 : 8;  // first pixel-byte
        uint32_t unused1 : 8;
    };
    uint32_t val;
} dma_elem_t;
```

So **for every 4 bytes our QEMU device writes to RAM, only 2 bytes
carry image data**. The driver later re-packs these via the
`ll_cam_dma_filter_*` callbacks before exposing the buffer to the
user.

Implementation rule for the QEMU model: when the host pushes a
**32-byte run of pixel bytes**, write **64 bytes** to the descriptor
buffer (each pixel byte zero-padded into a 16-bit slot, two slots per
32-bit word, in `sample1 / sample2` order).

This is the single trickiest detail of the emulation. The Phase-2 unit
test (in C, as a QEMU device test) MUST cover this padding explicitly.

## Frame timing — what we synthesise

Real OV2640 at QVGA-JPEG ~10 fps with PCLK=10MHz produces:

- `VSYNC` once per 100 ms (HIGH ~1.5 ms).
- `HREF` per line (~240 lines), HIGH ~640 µs.
- 8-bit byte every PCLK rising edge while HREF is HIGH.
- Frame size is **variable** (JPEG): typically 8–14 KB at QVGA Q60.

For QEMU we don't need to be cycle-accurate. Two strategies:

- **(A)** Drop the entire frame into RAM in one go when the driver
  starts a capture. Set EOF after the right number of `dma_elem_t`s.
  Simulate `VSYNC` by raising `in_suc_eof` after the write.
- **(B)** Pace the writes via a `qemu_mod_timer` that fires every
  ~100 µs, writing `~64 bytes`. More authentic, but slower.

**Phase 2 ships strategy (A).** Strategy (B) only matters for sketches
that want to measure VSYNC timing — extremely rare. Document the
limitation in `05_open_questions.md`.

## Pixel-format conversion

`camera_config_t.pixel_format`:

| value          | What's in the buffer after `fb_get`              |
|----------------|--------------------------------------------------|
| PIXFORMAT_JPEG | JPEG bytes (variable length)                     |
| PIXFORMAT_RGB565 | width*height*2 bytes, RGB565                   |
| PIXFORMAT_YUV422 | width*height*2 bytes                           |
| PIXFORMAT_GRAYSCALE | width*height bytes                          |

Browser webcam → host-side conversion table:

| Frontend produces | Backend stores in queue | When firmware wants… |
|-------------------|-------------------------|----------------------|
| JPEG (canvas.toBlob) | JPEG bytes              | JPEG → pass-through |
|                      |                         | RGB565 → decode + pack |
|                      |                         | GRAY  → decode + Y plane |

The decoding burden lives in the backend (`esp_lib_bridge`), not in
QEMU. QEMU just pushes "the bytes for this frame" — what's in the
bytes is whatever the host already converted.

## Sources

- [esp32-camera/target/esp32/ll_cam.c](https://github.com/espressif/esp32-camera/blob/master/target/esp32/ll_cam.c)
- [esp32-camera/driver/cam_hal.c](https://github.com/espressif/esp32-camera/blob/master/driver/cam_hal.c)
- [I2S camera mode driver issues — IDFGH-2582](https://github.com/espressif/esp-idf/issues/2251)
- [ESP32 forum — 8-bit parallel capture using I2S+DMA](https://www.esp32.com/viewtopic.php?t=5873)
- [DeepWiki — ESP32 Camera Driver overview](https://deepwiki.com/espressif/esp32-camera/4.3-esp32-camera-driver)

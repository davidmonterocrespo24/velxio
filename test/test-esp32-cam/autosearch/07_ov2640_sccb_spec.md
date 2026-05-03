# 07 — OV2640 SCCB / I²C register spec

The minimum register set our QEMU OV2640 device must implement to keep
the upstream `espressif/esp32-camera` driver happy. Sourced from:

- OmniVision OV2640 datasheet rev 1.6 (Feb 2006).
- `espressif/esp32-camera/sensors/ov2640.c` — driver source.
- `espressif/esp32-camera/sensors/private_include/ov2640_regs.h`.

The Phase-1 deliverable is a QEMU device that passes the chip-detect
dance below. A more complete model (Phase 2) covers the full
`OV2640_JPEG_INIT` / `OV2640_YUV422` / `OV2640_RGB565` register
sequences so that pixel-format switches behave like real hardware.

## SCCB transport

- Same as I²C, but **8-bit register addresses** (no 16-bit auto-increment).
- 7-bit slave address: **`0x30`** (write `0x60`, read `0x61`).
- Single-register transactions: `START / 0x60 / regaddr / val / STOP`
  for write; `START / 0x60 / regaddr / RSTART / 0x61 / val / STOP` for
  read.

## Bank-select (BANK_SEL = `0xFF`)

The OV2640 has two register pages, switched by writing to `0xFF`:

| Value | Bank          | Holds                                |
|-------|---------------|--------------------------------------|
| 0x00  | DSP           | output format, scaling, JPEG, ISP    |
| 0x01  | SENSOR        | timing, exposure, gain, **chip ID**  |

Implementation: keep one `current_bank` byte; every register access
looks at it before deciding which 256-entry table to hit.

## Chip identification (Phase 1 — minimum viable)

Write `0xFF = 0x01` (sensor bank), then read:

| Reg  | Name      | Value (OV2640)        |
|------|-----------|-----------------------|
| 0x0A | REG_PID   | **`0x26`**            |
| 0x0B | REG_VER   | **`0x42`**            |
| 0x1C | REG_MIDH  | **`0xa2`**            |
| 0x1D | REG_MIDL  | **`0x7f`**            |

These four reads alone are what `esp32_camera_ov2640_detect()` checks.
Everything below is for `esp_camera_init()` to not return errors after
detection.

## Init register sequences (Phase 2)

The driver pushes three large `{reg, val}` arrays in sequence:

1. **`ov2640_init_regs`** — 102 registers, mixed banks (interleaved
   `0xFF=0x00` / `0xFF=0x01` switches). Pure setup; values are written
   verbatim, our model just stores them in the per-bank tables and
   acks.
2. **`ov2640_init_jpeg_regs`** — 26 registers, after format switch to
   JPEG. Configures the on-chip JPEG ISP. Same: store + ack.
3. **`ov2640_yuv422_regs`** / **`ov2640_rgb565_regs`** — alternative
   format paths, each ~12 regs.

Our QEMU model stores them all in two 256-byte per-bank arrays. No
register has read-modify-write side effects beyond:

- `0x12` (COM7): bit 7 = `RESET`. Writing 0x80 here triggers a soft
  reset. Implementation: zero both bank tables, restore chip-ID regs,
  set `current_bank=0x01`.
- `0xFF`: bank-select (already covered).
- `0x09` (COM2): bit 4 = `SOFT_SLEEP`. Doesn't affect bus behaviour;
  fine to ignore.

## Reset behaviour

After power-on or `0x12 = 0x80`:

- All registers go to chip default. Most defaults are zero except the
  chip-ID regs (which are ROM, never change).
- `current_bank` resets to `0x01` (sensor).
- The driver waits ~10 ms after a soft reset before reading PID. We
  can ignore that timing — QEMU's I²C bus is instant.

## What we **don't** model

- Auto-exposure / auto-white-balance / auto-gain — these never get
  read back by the driver, only written to. We accept any value.
- Test-pattern register (`0x12` bit 1). The real chip emits stripes;
  our emulator emits whatever the host pushed (see `08_dvp_i2s_spec.md`).
- The "OV2640 Window" registers (`0x17 / 0x18 / 0x19 / 0x1A`). The
  driver writes them; we accept and ignore — the *frame source* is the
  host webcam, no on-sensor windowing.

## Open question: SCCB vs I²C inside the ESP32-CAM driver

The upstream driver has historically supported two paths for talking
to the sensor:

- **`CONFIG_SCCB_HARDWARE_I2C`** (default): use the ESP32 I²C
  controller. This is what hits `esp32_i2c.c` in our QEMU.
- **`CONFIG_SCCB_HARDWARE_I2C=n`**: bit-bang via GPIO. Triggers GPIO
  toggles on SIOD/SIOC.

For Phase 1 we **assume hardware I²C** (the Arduino default for
`esp32:esp32:esp32cam`). The bit-bang path would need IOMUX-based
intercepting that's out of scope.

## Sources

- [OV2640 Datasheet rev 1.6 (Feb 2006)](https://www.uctronics.com/download/cam_module/OV2640DS.pdf)
- [esp32-camera/sensors/ov2640.c](https://github.com/espressif/esp32-camera/blob/master/sensors/ov2640.c)
- [esp32-camera/sensors/private_include/ov2640_regs.h](https://github.com/espressif/esp32-camera/blob/master/sensors/private_include/ov2640_regs.h)
- [SCCB specification](https://github.com/Freenove/Freenove_ESP32_WROVER_Board/blob/main/Datasheet/OV2640/OmniVision%20Technologies%20Seril%20Camera%20Control%20Bus(SCCB)%20Specification.pdf)
- [Issue #418 — confirmed PID/VER/MIDL/MIDH constants](https://github.com/espressif/esp32-camera/issues/418)

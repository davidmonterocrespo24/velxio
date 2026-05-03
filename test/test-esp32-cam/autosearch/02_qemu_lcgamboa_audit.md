# 02 — `wokwi-libs/qemu-lcgamboa/` audit

A grep-driven inventory of every ESP32 peripheral implemented in the
QEMU fork we ship, so it's clear at a glance whether the hardware path
is ever feasible without forking.

## Method

```bash
find wokwi-libs/qemu-lcgamboa/hw -maxdepth 3 -iname "esp32*"
grep -ri "ov2640\|sccb\|dvp\|i2s_cam\|camera" wokwi-libs/qemu-lcgamboa/hw
```

## Inventory

### CPU / boot

| File                                  | What it models                |
|---------------------------------------|-------------------------------|
| `hw/xtensa/esp32.c`                   | Xtensa LX6 base machine       |
| `hw/xtensa/esp32_picsimlab.c`         | PICSimLab variant w/ extras   |
| `hw/xtensa/esp32_intc.c`              | Interrupt controller          |
| `hw/riscv/esp32c3.c`                  | C3 base machine               |
| `hw/riscv/esp32c3_clk.c`              | C3 clock                      |
| `hw/riscv/esp32c3_intmatrix.c`        | C3 interrupt matrix           |
| `hw/riscv/esp32c3_picsimlab.c`        | C3 PICSimLab variant          |

### Buses / IO

| File                                  | What it models               |
|---------------------------------------|------------------------------|
| `hw/char/esp32_uart.c`                | UART                         |
| `hw/char/esp32c3_uart.c`              | C3 UART                      |
| `hw/i2c/esp32_i2c.c`                  | **I²C controller** (host)    |
| `hw/ssi/esp32_spi.c`                  | SPI                          |
| `hw/ssi/esp32c3_spi.c`                | C3 SPI                       |
| `hw/ssi/esp32_rmt.c`                  | RMT (remote control)         |
| `hw/gpio/esp32_gpio.c`                | GPIO                         |
| `hw/gpio/esp32c3_gpio.c`              | C3 GPIO                      |
| `hw/dma/esp32c3_gdma.c`               | C3 GDMA                      |
| `hw/misc/esp32_iomux.c`               | IO MUX (signal routing)      |
| `hw/misc/esp32c3_iomux.c`             | C3 IO MUX                    |

### Wi-Fi (the camera-shaped hole would go next to this)

| File                                  | What it models               |
|---------------------------------------|------------------------------|
| `hw/misc/esp32_wifi.c`                | Wi-Fi MAC                    |
| `hw/misc/esp32_wifi_ap.c`             | Wi-Fi AP                     |
| `hw/misc/esp32_wlan_packet.c`         | Wi-Fi packet path            |
| `hw/misc/esp32c3_wifi.c`              | C3 Wi-Fi                     |

### Crypto / power / misc

| File                                  | What it models               |
|---------------------------------------|------------------------------|
| `hw/misc/esp32_aes.c`                 | AES                          |
| `hw/misc/esp32_sha.c`                 | SHA                          |
| `hw/misc/esp32_rsa.c`                 | RSA                          |
| `hw/misc/esp32_rng.c`                 | RNG                          |
| `hw/misc/esp32_rtc_cntl.c`            | RTC                          |
| `hw/misc/esp32_dport.c`               | DPORT                        |
| `hw/misc/esp32_ledc.c`                | LEDC (PWM)                   |
| `hw/misc/esp32_sens.c`                | SENS / ADC                   |
| `hw/misc/esp32_ana.c`                 | Analog                       |
| `hw/misc/esp32_fe.c`                  | Front-end                    |
| `hw/misc/esp32_phya.c`                | PHY                          |
| `hw/misc/esp32_flash_enc.c`           | Flash encryption             |
| `hw/misc/esp32_unimp.c`               | Stub for unimplemented regs  |
| `hw/timer/esp32_frc_timer.c`          | FRC timer                    |
| `hw/timer/esp32_timg.c`               | TIMG                         |
| `hw/nvram/esp32_efuse.c`              | eFuse                        |

(Same picture, *mutatis mutandis*, for the C3.)

### Camera-related: nothing

```
$ grep -ri "ov2640\|sccb\|dvp\|i2s_cam" wokwi-libs/qemu-lcgamboa/hw
(no output)
```

There is **no I²S input mode** at all (only the ones used for audio, and
even those are stubbed via `esp32_unimp.c`). There is no DVP. There is
no SCCB layer over I²C — the OV2640's register dance would never
complete because the bus has no slave to ack it.

## What this means for Path B

To get a real camera up via QEMU, we'd need:

1. A new device in `hw/misc/esp32_cam.c` modelling at minimum the
   OV2640 SCCB register set + a fake DMA-fed frame buffer the I²S
   peripheral could pull from.
2. An I²S parallel-input model (`hw/misc/esp32_i2s_cam.c`).
3. Wiring those into `hw/xtensa/esp32_picsimlab.c` so they appear at
   the right MMIO offsets when the firmware probes them.
4. A new build of `libqemu-xtensa.so` per architecture (we ship 2:
   x86_64 + arm64) and per platform (Linux + Windows DLL).

Realistically: 2–4 person-weeks, then ongoing maintenance every time
the lcgamboa fork rebases. **Not for now.**

## What this means for Path A

The existing peripherals are enough. We don't even need to extend QEMU
— the shim runs entirely in firmware-space and pulls bytes through
either:

- The existing `esp_lib_bridge` sensor channel (slow, 1–10 fps), **or**
- A small new MMIO peripheral mapped into a free address range
  (`0x3FF7_xxxx` is unused) that the host pokes via the existing
  `qemu-monitor` HMP channel.

Both fit inside Path A and don't require recompiling QEMU.

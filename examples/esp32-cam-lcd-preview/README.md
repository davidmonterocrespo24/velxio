# ESP32-CAM live preview on ILI9341 TFT

What this does in plain Spanish:

> El ESP32-CAM emulado captura tu webcam con `esp_camera_fb_get()`,
> decodifica cada JPEG a RGB565 con `jpg2rgb565()` y lo dibuja en una
> pantalla ILI9341 320×240 conectada por SPI. La pantalla muestra el
> stream en vivo + una barra de estado con fps, contador de frames
> y errores de decodificación.

## What you'll see

Top of TFT (status bar, refreshed every frame):

```
VELXIO ESP32-CAM live preview                        ●  ← live dot
frame  142   8192 B   decode OK
fps  9.8   fails 0   nulls 0
```

Bottom of TFT (160×120 preview, centered):

The contents of your laptop webcam, mirrored into the simulated
ESP32-CAM frame buffer, decoded from JPEG and rendered as RGB565
pixels.

## How to run

1. **Open Velxio**, select board **ESP32-CAM** in the picker.
2. **Paste** `esp32-cam-lcd-preview.ino` into the editor.
3. **Add an ILI9341** to the canvas via the component picker (search
   "ILI9341"). Position it next to the ESP32-CAM board.
4. **Wire** the components according to the diagram below (the
   simulator will let you click pin pairs to draw wires).
5. **Install libraries** — open the Library Manager (book icon in
   the toolbar) and install:
   - `Adafruit GFX Library`
   - `Adafruit ILI9341`
6. **Compile** → **Run**.
7. **Click the Camera button** in the canvas header → grant webcam
   permission → watch your face appear on the simulated TFT.

## Wiring

```
   ILI9341          ESP32-CAM
   ───────          ─────────
    VCC   ────────  3V3
    GND   ────────  GND
    CS    ────────  GPIO 15   (orange)
    RST   ────────  GPIO  2   (white)
    D/C   ────────  GPIO 14   (yellow)
    MOSI  ────────  GPIO 13   (blue)
    SCK   ────────  GPIO 12   (green)
    LED   ────────  3V3       (backlight always on)
    MISO  ────────  (unused — display is write-only)
```

## Why these pins

The AI-Thinker ESP32-CAM has a tight pin budget: GPIOs 0, 5, 18, 19,
21, 22, 23, 25, 26, 27, 32, 34-39 are taken by the OV2640 camera.
The exposed header gives you 12, 13, 14, 15, 16 plus 0, 2, 4, RX, TX,
3V3, 5V, GND. This sketch uses 12-15 (perfect for VSPI without
reconfiguring) and steals GPIO 2 (the on-board blue LED) for RST.
GPIO 4 (the white flash LED) is left alone.

## Tuning

- **`PREVIEW_W` / `PREVIEW_H`** (line ~70 in the sketch) — change to
  `320`/`240` with `JPG_SCALE_NONE` for full-resolution preview at
  the cost of ~150 KiB of DRAM (won't fit without PSRAM).
- **`JPG_SCALE_2X` → `JPG_SCALE_4X`** for an 80×60 preview centered
  in a frame border. Frees up 27 KiB of RAM.
- **`delay(20)`** in the loop — drop to `0` for max framerate, or
  raise to throttle the SPI bus on slower setups.

## How this works under the hood

The interesting part: `jpg2rgb565()` is a function that lives inside
`libesp32-camera.a` (the precompiled archive shipped with arduino-esp32).
The Velxio compile template
([backend/app/services/esp-idf-template/main/CMakeLists.txt](../../backend/app/services/esp-idf-template/main/CMakeLists.txt))
adds the conversions/include directory to the include path
automatically — that's how `#include "img_converters.h"` resolves.

The `Adafruit_ILI9341` driver pushes pixels via `SPI` writes that hit
QEMU's emulated I/O bus. Velxio's frontend renders the resulting
framebuffer state into the on-screen TFT element in real time. None
of this needs PSRAM, networking, or any setup beyond the Library
Manager installs.

## Caveat

Real webcam JPEGs from `getUserMedia` at quality 0.6 are typically
~10 KiB. The Velxio QEMU emulation delivers up to ~9 KiB per frame
to the firmware, with the JPEG EOI marker (`FF D9`) injected in the
last samples to guarantee `cam_verify_jpeg_eoi` accepts the frame.
This means JPEGs are usually **truncated** before reaching the
decoder — `jpg2rgb565()` may fail on some frames, in which case the
sketch shows a red-X grey rectangle instead of an image. Lowering
the JPEG quality in the frontend (`JPEG_QUALITY = 0.3` in
`useWebcamFrames.ts`) makes frames small enough to fit entirely and
decode reliably.

See `test/test-esp32-cam/autosearch/14_complete_emulation.md` for
the full forensic trace of the 9 silent bugs that had to be fixed
to make `esp_camera_fb_get()` work in QEMU.

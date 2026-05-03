# 00 — overview

## Problem statement

`esp32-cam` boots fine in Velxio (GPIO works — see issue #129 fix), but the
**OV2640 image sensor is not emulated**. A sketch like

```c
#include "esp_camera.h"
camera_config_t cfg = { /* OV2640 pinout */ };
esp_camera_init(&cfg);            // ← what does this even do under QEMU?
camera_fb_t* fb = esp_camera_fb_get();   // ← always NULL or hang
```

cannot be exercised at all today. Concretely there are three blockers,
and **only the first one has a low-cost fix**:

| # | Blocker                          | Fix path                              |
|---|----------------------------------|---------------------------------------|
| 1 | No frame data ever arrives       | Inject JPEGs from outside QEMU        |
| 2 | The DVP+I2S parallel bus is gone | Skip it — replace the driver, not bus |
| 3 | The SCCB (I²C-like) probe fails  | Have the shim "pretend" probe success |

## What the user asked for

> "el esp32-cam no emula la cámara, [...] la idea es usar la webcam de la
> PC y usar algún código para obtener esas imágenes"

Concretely: **the user's webcam, captured in their browser**, becomes the
"camera" the ESP32 firmware sees. That fits Velxio's existing model
(everything else is browser-side, no server hardware).

## Three candidate paths (summary — full eval in `01_state_of_the_art.md`)

### Path A — Library shim (recommended)

Replace the `esp32-camera` library at link time with a thin shim that:

- Stubs `esp_camera_init()` to return `ESP_OK` after pretending to talk to
  the SCCB.
- Implements `esp_camera_fb_get()` by reading bytes from a tiny new
  MMIO-backed peripheral, or — simpler — from a region the host pokes
  via the existing `esp_lib_bridge` sensor channel.

**Pro:** zero changes to QEMU itself. Works with the prebuilt
`libqemu-xtensa.so` we already ship. Implementable in ~a week.
**Con:** the user has to use our shim, not the upstream library. We can
auto-swap it during compile (we already manage Arduino libraries).

### Path B — New QEMU peripheral (DVP + I²S + camera)

Write `hw/misc/esp32_cam.c` modelling the I²S-parallel input + an
internal "OV2640" device. Hook it up in `hw/xtensa/esp32_picsimlab.c`.

**Pro:** the upstream `esp32-camera` library works unchanged.
**Con:** writing a QEMU peripheral that satisfies the real driver's
init dance (PCLK/HREF/VSYNC, DMA descriptors, SCCB register sequence) is
weeks of work. We'd also need to rebuild and re-publish
`libqemu-xtensa.so`. Out of scope for now.

### Path C — Run a real ESP32-CAM out-of-band

Forward the user's sketch to a physical ESP32-CAM in a lab, stream back
the JPEG. **Off the table** — Velxio is "fully local, open-source",
shipping hardware kills the value prop.

## Decision

**Go with Path A.** The autosearch notes from here on assume that.

## Reading order

1. **`01_state_of_the_art.md`** — what others have tried, why each path
   is or isn't a fit.
2. **`02_qemu_lcgamboa_audit.md`** — concrete inventory of the QEMU fork
   we ship (`wokwi-libs/qemu-lcgamboa`) so future-you knows exactly
   which peripherals exist (and don't).
3. **`03_browser_webcam_capture.md`** — `getUserMedia` + canvas + JPEG
   encode + WebSocket framing.
4. **`04_proposed_architecture.md`** — the end-to-end pipeline we want
   to build.
5. **`05_open_questions.md`** — things still unresolved that need a
   spike before commit.

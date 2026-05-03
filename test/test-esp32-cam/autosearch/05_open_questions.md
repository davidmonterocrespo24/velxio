# 05 — open questions

Things still unresolved. **Don't start implementing until each of these
has a one-line answer**, otherwise the implementation will fork during
review.

## Q1. Library swap mechanism

**Question.** When the user clicks "Compile" on an `esp32-cam` sketch,
how exactly does our shim end up linked instead of the upstream
`espressif/esp32-camera`?

Options considered:
- **(a)** Pre-install a directory at `~/.arduino15/libraries/esp32_camera`
  that *is* our shim, with a higher version number than upstream.
  arduino-cli picks the highest-versioned library in the search path.
- **(b)** Pass `--library-search-path` to arduino-cli pointing at our
  shim ahead of the system one.
- **(c)** Patch the user's sketch source to `#include "velxio_esp_camera.h"`
  before compile. **Don't do this.** Modifying user code is invisible
  black-magic.

Spike needed: ~30 min to confirm which of (a)/(b) is honoured by the
arduino-cli we ship.

## Q2. Where does the shim's binary live in the QEMU image?

The shim is plain C. arduino-cli compiles it into the .elf like any
library. **No special handling needed** as long as Q1 is answered.

## Q3. SCCB probe — return what?

The upstream `esp_camera_init()` does an SCCB I²C probe at the camera
address, expecting register `0x0A` (chip-id high) = `0x26` for OV2640.
Two paths:

- **(a)** Bypass the probe entirely: shim's `esp_camera_init()` skips
  the dance and unconditionally returns `ESP_OK`. Cleanest.
- **(b)** Have the existing `esp_lib_bridge` answer the I²C probe with
  the OV2640 chip-id when address `0x30` is read. More authentic, also
  covers user code that calls `esp_camera_sensor_get()` and inspects
  `sensor->id.PID`.

**Default to (a)** for MVP; revisit (b) if a sketch calls
`sensor_get()`. Add a layer-3 test that asserts (a) is what we ship.

## Q4. Frame queue depth

- 1 = simplest, but if firmware reads while browser writes there's a
  lock contention story to handle.
- 2 = current+next, lock-free swap. Recommended.
- N = unbounded buffering — don't, latency would explode.

## Q5. What happens when no browser is sending frames?

`esp_camera_fb_get()` semantics are blocking-ish (real hardware blocks
on VSYNC). Options:

- Block forever — bad UX, looks like the firmware froze.
- Return `NULL` after a 200 ms timeout — matches "no frame ready" on
  real HW under low light.
- Return a fake static "camera off" image (e.g. solid gray w/ "no
  camera" overlay) so user code visibly knows.

**Pick 2 (timeout → NULL)** so user sketches with `if (!fb) continue;`
loops behave. Document that "no webcam permission" is reported via the
browser hook's `status:'error'`, so the user knows where to look.

## Q6. Multi-board: two ESP32-CAMs in one project?

`boards_json` already supports it. The frame queue is keyed on
`client_id`, but `client_id` is per-WebSocket. We'd need per-board
keying inside the queue. Two boards = two webcam streams **or** the
same webcam stream fanned out — let the user choose.

Defer this until MVP works for one board; the change is contained to
`camera_queue.py`.

## Q7. JPEG vs RGB565

`camera_config_t.pixel_format` lets the user pick. Browser canvas
gives us JPEG basically for free (`canvas.toBlob('image/jpeg')`); RGB565
needs a software encode of the canvas pixel data.

- For JPEG-mode sketches: pass through.
- For RGB565-mode sketches: decode the JPEG in the **shim** on
  firmware-side once, then re-pack to RGB565. Slow but correct.
  Alternatively decode in the *backend* and ship RGB565 over the wire
  (smaller transport for QVGA: 320×240×2 = 153.6 KB ~ same as a JPEG,
  no win).

**Default JPEG, document RGB565 as "supported but slower"**. Add a
test that asserts both paths return the right `format` in the
`camera_fb_t`.

## Q8. Compile-time switch

Should the shim apply *always* for `esp32:esp32:esp32cam`, or only when
the user opts in (e.g. board property "fake camera")? **Always**, with
no opt-out. The board doesn't work without it, so opting out is
opting into a no-op.

## Q9. Do we need to worry about the real `framectrl` task?

The upstream library starts a FreeRTOS task that polls VSYNC and
manages DMA descriptors. Our shim must not start that task — it would
just consume CPU and never get fed. **Confirmed by code-reading** (see
`01_state_of_the_art.md`): the public API doesn't expose the task
handle, so omitting `xTaskCreate` from our shim is invisible.

## Q10. How do we let the user *see* the firmware's output?

Out of scope for MVP, but worth noting: when the user's firmware does
`Serial.println` or runs a web server returning `/jpg`, the existing
Velxio plumbing already shows it. So the obvious demo sketch is:

```c
#include "esp_camera.h"
camera_fb_t* fb = esp_camera_fb_get();
Serial.printf("got frame: %d bytes\n", fb->len);
esp_camera_fb_return(fb);
```

That'd validate the round-trip end-to-end with no UI changes.

## Q11. Does this all collapse if Espressif adds camera to upstream QEMU?

Yes, and that'd be wonderful. Path B becomes free. Until then we keep
Path A as the only realistic option. **Re-check upstream every ~6
months.** A scheduled agent could do this — see `/schedule`.

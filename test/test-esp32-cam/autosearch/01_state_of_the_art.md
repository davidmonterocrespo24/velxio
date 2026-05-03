# 01 — state of the art

What other projects have done about emulating the OV2640 / ESP32-CAM
camera, with an honest "does it apply to Velxio?" verdict for each.

## Espressif official QEMU fork

- Repo: https://github.com/espressif/qemu (branch: `esp-develop`)
- Docs: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-guides/tools/qemu.html

**Camera support:** none. The peripheral list in the docs covers UART,
GPIO, SPI, I²C, RMT, LEDC, Wi-Fi (rudimentary), Ethernet — no DVP, no
I²S parallel-input mode, no OV2640 device. There is a "virtual RGB
panel" that the firmware can write *to*, but there is no way for the
firmware to read frames *in*.

**Verdict:** doesn't help. Even Espressif's own QEMU has no camera input.

## lcgamboa QEMU fork (the one we ship)

- Repo: https://github.com/lcgamboa/qemu
- Local copy: `wokwi-libs/qemu-lcgamboa/`

The README brags about three additions over Espressif's fork: **dynamic
library compilation, Wi-Fi+ESP-NOW, and IOMUX**. No camera. A grep over
`hw/` confirms zero references to `ov2640`, `dvp`, `i2s_cam`, or
`camera`. See `02_qemu_lcgamboa_audit.md` for the per-file inventory.

**Verdict:** doesn't help either. Forking is feasible but a multi-week
effort (see Path B in `00_overview.md`).

## Wokwi (commercial competitor)

Sample projects exist under `wokwi.com` slugs that *render* an ESP32-CAM
and let users wire to it (e.g.
https://wokwi.com/projects/393910195512969217), but the JPEG-output side
is mocked: their simulator returns canned test patterns or static
bitmaps. Wokwi doesn't expose the camera framework as a real video
input. There's no public documentation describing how they did it, and
the source isn't open.

**Verdict:** confirms that even commercial implementations stop at "fake
the API, return something that compiles". That's the right scope for us
too.

## espressif/esp32-camera library

- Repo: https://github.com/espressif/esp32-camera
- Public API (header `esp_camera.h`):
  ```c
  esp_err_t esp_camera_init(const camera_config_t *config);
  camera_fb_t* esp_camera_fb_get(void);
  void esp_camera_fb_return(camera_fb_t *fb);
  esp_err_t esp_camera_deinit(void);
  sensor_t* esp_camera_sensor_get(void);
  ```

`camera_fb_t` is:
```c
typedef struct {
    uint8_t * buf;          // ptr to image data
    size_t   len;           // bytes in buf
    size_t   width;
    size_t   height;
    pixformat_t format;     // PIXFORMAT_JPEG / RGB565 / GRAYSCALE / …
    struct timeval timestamp;
} camera_fb_t;
```

This is the surface our shim needs to mimic. It's small. **Almost every
sample sketch only ever calls `_init()`, `_fb_get()`, `_fb_return()`**.
That's our minimum viable shim.

## yoursunny/esp32cam (Arduino wrapper)

- Repo: https://github.com/yoursunny/esp32cam

Thin C++ wrapper on top of the Espressif library. Internally calls the
same `esp_camera_*` symbols. **If we shim the C API, the Arduino wrapper
works for free.**

## Browser-side webcam → frame stream

`navigator.mediaDevices.getUserMedia({video:true})` returns a
`MediaStream`; pipe it into a `<video>` element, draw it on a `<canvas>`,
call `canvas.toBlob('image/jpeg', quality)`, and you have a JPEG. There
are dozens of working examples (websocket-webcam, getUserMedia samples,
MDN "Taking still photos"). Frame rate of 5–15 fps is realistic for
320×240 with reasonable JPEG quality. See
`03_browser_webcam_capture.md` for the exact code we want.

**Verdict:** zero risk. This is a solved problem; it's just plumbing.

## Closest precedents inside Velxio

The ESP32 sensor-attach pattern (DHT22, HC-SR04) is the closest
precedent. Backend gets sensor data via a host channel, pushes it into
the QEMU process as needed when the firmware reads from a peripheral
register. See:

- `backend/app/services/esp32_lib_bridge.py`
- `backend/app/services/esp_qemu_manager.py`
- `frontend/src/store/useSimulatorStore.ts` — `registerSensor()` /
  `unregisterSensor()` calls.

The camera is "just another sensor that returns a JPEG when polled" —
the existing pattern fits **as long as we're injecting at the library
level, not the bus level**. That's another point in favour of Path A.

## Sources

- [Espressif esp32-camera README](https://github.com/espressif/esp32-camera/blob/master/README.md)
- [lcgamboa QEMU fork](https://github.com/lcgamboa/qemu)
- [ESP-IDF QEMU emulator docs](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-guides/tools/qemu.html)
- [yoursunny/esp32cam](https://github.com/yoursunny/esp32cam)
- [Wokwi ESP32-CAM project example](https://wokwi.com/projects/393910195512969217)
- [Random Nerd Tutorials — ESP32-CAM video streaming](https://randomnerdtutorials.com/esp32-cam-video-streaming-web-server-camera-home-assistant/)
- [MDN — Taking still photos with getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/Media_Capture_and_Streams_API/Taking_still_photos)
- [WebRTC samples — getUserMedia to canvas](https://webrtc.github.io/samples/src/content/getusermedia/canvas/)
- [websocket-webcam reference impl](https://github.com/wgroeneveld/websocket-webcam)

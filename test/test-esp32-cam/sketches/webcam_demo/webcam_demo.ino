// webcam_demo.ino — user-friendly ESP32-CAM sketch designed to be
// loaded into Velxio's editor as a starter example.
//
// What you should see in the simulator:
//   1. Click "Camera" in the canvas header → grant browser webcam
//      permission. Frames start streaming at ~10 fps.
//   2. The Serial Monitor prints:
//          velxio-esp32-cam-demo boot
//          camera_init ok
//          frame N: <bytes> bytes <W>x<H> fmt=4
//      Frames advance as long as the webcam is on.
//   3. Stop the webcam → fb_get goes back to NULL after the last
//      queued frame is consumed.
//
// What this sketch demonstrates:
//   - Standard upstream `esp_camera_init()` / `esp_camera_fb_get()`
//     pattern. Drops into any real ESP32-CAM project unchanged.
//   - Tells Velxio's QEMU OV2640 device about the AI-Thinker pin
//     mapping. The simulator forwards SCCB chip-id reads + SCCB init
//     register sequences exactly like real hardware.
//   - Asks for JPEG QVGA (320×240) which happens to match what the
//     browser's getUserMedia + canvas.toBlob produces.
//
// Caveat documented in autosearch/10: the upstream `cam_hal.c`
// validates each frame against the JPEG EOI marker via a private
// scan. If the frame fails validation, fb_get keeps blocking. Velxio
// pads frame buffers with 0xFF 0xD9 (EOI) so most JPEGs are accepted,
// but malformed frames may still drop. This is a quirk of the
// emulation, not your sketch — see autosearch/10 for the deep dive.

#include "esp_camera.h"

// AI-Thinker ESP32-CAM pin map. Don't change unless you also change
// the rendered board's pin layout — the simulator wires SCCB to GPIOs
// 26/27 expected here.
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("velxio-esp32-cam-demo boot");

  camera_config_t cfg = {};
  cfg.ledc_channel = LEDC_CHANNEL_0;
  cfg.ledc_timer   = LEDC_TIMER_0;
  cfg.pin_d0       = Y2_GPIO_NUM;
  cfg.pin_d1       = Y3_GPIO_NUM;
  cfg.pin_d2       = Y4_GPIO_NUM;
  cfg.pin_d3       = Y5_GPIO_NUM;
  cfg.pin_d4       = Y6_GPIO_NUM;
  cfg.pin_d5       = Y7_GPIO_NUM;
  cfg.pin_d6       = Y8_GPIO_NUM;
  cfg.pin_d7       = Y9_GPIO_NUM;
  cfg.pin_xclk     = XCLK_GPIO_NUM;
  cfg.pin_pclk     = PCLK_GPIO_NUM;
  cfg.pin_vsync    = VSYNC_GPIO_NUM;
  cfg.pin_href     = HREF_GPIO_NUM;
  cfg.pin_sccb_sda = SIOD_GPIO_NUM;
  cfg.pin_sccb_scl = SIOC_GPIO_NUM;
  cfg.pin_pwdn     = PWDN_GPIO_NUM;
  cfg.pin_reset    = RESET_GPIO_NUM;
  cfg.xclk_freq_hz = 20000000;
  cfg.pixel_format = PIXFORMAT_JPEG;
  cfg.frame_size   = FRAMESIZE_QVGA;       // matches what the browser hook sends
  cfg.jpeg_quality = 12;
  cfg.fb_count     = 1;
  // Velxio's QEMU board has no PSRAM emulated — keep the framebuffer
  // in DRAM. A real ESP32-CAM has 4 MB PSRAM and would default to it.
  cfg.fb_location  = CAMERA_FB_IN_DRAM;

  esp_err_t err = esp_camera_init(&cfg);
  if (err != ESP_OK) {
    Serial.printf("camera_init failed: 0x%x — see autosearch/10 for tips\n",
                  err);
    return;
  }
  Serial.println("camera_init ok");
}

void loop() {
  static uint32_t frame_count = 0;
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    // No frame ready — happens when the user hasn't clicked "Camera"
    // yet, or in the brief window between webcam frames.
    delay(200);
    return;
  }
  frame_count++;
  Serial.printf("frame %u: %u bytes %ux%u fmt=%d\n",
                (unsigned)frame_count, (unsigned)fb->len,
                (unsigned)fb->width, (unsigned)fb->height,
                (int)fb->format);
  esp_camera_fb_return(fb);

  // 100 ms cadence — gentle enough to avoid backpressure on the
  // browser-side capture loop (which runs at the same rate).
  delay(100);
}

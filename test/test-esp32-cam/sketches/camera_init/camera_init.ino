// camera_init.ino — minimum reproducer for "OV2640 emulation needed".
//
// Runs through the full upstream esp32-camera init dance and prints
// either the chip ID + a single-frame size or a clear error code.
//
// Today, under Velxio, this sketch hangs at esp_camera_init() because
// the SCCB I²C probe never gets an ack from a (non-existent) sensor.
// When the shim from autosearch/04_proposed_architecture.md ships,
// this sketch should print "got frame: N bytes" within ~5 s of boot.
//
// Pinout below matches the AI-Thinker ESP32-CAM, the variant Velxio
// renders. Don't change pin numbers — Layer-2 of the test suite checks
// that this sketch matches the board the simulator presents.

#include "esp_camera.h"

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
  Serial.println("velxio-esp32-cam-test boot");

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
  cfg.frame_size   = FRAMESIZE_QVGA;        // 320x240 — keeps WS bandwidth low
  cfg.jpeg_quality = 12;
  cfg.fb_count     = 1;
  // Default fb_location is CAMERA_FB_IN_PSRAM, which fails under QEMU
  // because we don't emulate the AI-Thinker board's external PSRAM.
  // DRAM has enough contiguous DMA-capable memory for QVGA JPEG (~30 KB).
  cfg.fb_location  = CAMERA_FB_IN_DRAM;

  esp_err_t err = esp_camera_init(&cfg);
  if (err != ESP_OK) {
    Serial.printf("camera_init failed: 0x%x\n", err);
    return;
  }
  Serial.println("camera_init ok");
}

void loop() {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("fb_get returned NULL");
    delay(500);
    return;
  }
  Serial.printf("got frame: %u bytes %ux%u fmt=%d\n",
                (unsigned)fb->len, (unsigned)fb->width,
                (unsigned)fb->height, (int)fb->format);
  esp_camera_fb_return(fb);
  delay(500);
}

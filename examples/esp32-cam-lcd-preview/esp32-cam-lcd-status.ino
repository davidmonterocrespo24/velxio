/*
 * esp32-cam-lcd-status.ino
 *
 * Simpler companion to esp32-cam-lcd-preview.ino: shows a STATUS
 * dashboard on the ILI9341 instead of decoding the JPEG. Useful if
 * jpg2rgb565() fails on truncated frames (a known limitation when
 * the source JPEG > 9 KiB — see the project README).
 *
 * What you see on the TFT:
 *   - Frame counter (incrementing as frames arrive)
 *   - Last frame size in bytes
 *   - Average fps
 *   - JPEG header byte dump (first 16 bytes — visualises the SOI
 *     marker FF D8 FF and APP0 JFIF on each frame)
 *   - Histogram of byte distribution in the JPEG (shows webcam
 *     activity visually — bright frames vs dark frames distribute
 *     bytes differently)
 *
 * Wiring is the same as esp32-cam-lcd-preview.ino — see that file or
 * the README. Libraries needed: Adafruit GFX + Adafruit ILI9341.
 */

#include "esp_camera.h"

#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>

// Camera pinout — AI-Thinker ESP32-CAM
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

// TFT pinout
#define TFT_CS    15
#define TFT_DC    14
#define TFT_RST    2
#define TFT_MOSI  13
#define TFT_SCK   12

SPIClass tftSPI(VSPI);
Adafruit_ILI9341 tft = Adafruit_ILI9341(&tftSPI, TFT_DC, TFT_CS, TFT_RST);

uint32_t frame_count   = 0;
uint32_t total_bytes   = 0;
unsigned long start_ms = 0;

void draw_static() {
  tft.fillScreen(ILI9341_BLACK);

  // Title bar
  tft.fillRect(0, 0, 320, 24, ILI9341_NAVY);
  tft.setTextSize(2);
  tft.setTextColor(ILI9341_WHITE);
  tft.setCursor(8, 4);
  tft.print("VELXIO ESP32-CAM");

  // Section labels
  tft.setTextSize(1);
  tft.setTextColor(ILI9341_CYAN);
  tft.setCursor(8, 36);  tft.print("STATS");
  tft.setCursor(8, 110); tft.print("JPEG HEADER (first 16 bytes)");
  tft.setCursor(8, 168); tft.print("BYTE HISTOGRAM (8 buckets)");
}

void draw_stats(size_t fb_len) {
  // Erase + redraw stats section
  tft.fillRect(0, 50, 320, 50, ILI9341_BLACK);
  tft.setTextSize(2);
  tft.setTextColor(ILI9341_GREEN);

  tft.setCursor(8, 54);
  tft.printf("frame %5u", (unsigned)frame_count);

  tft.setCursor(8, 76);
  tft.printf("size  %5u B", (unsigned)fb_len);

  unsigned long elapsed = millis() - start_ms;
  float fps = elapsed > 0 ? (1000.0f * frame_count) / (float)elapsed : 0.0f;
  tft.setTextColor(ILI9341_YELLOW);
  tft.setCursor(180, 54);
  tft.printf("fps %4.1f", fps);

  tft.setCursor(180, 76);
  tft.printf("avg %4u B",
             frame_count ? (unsigned)(total_bytes / frame_count) : 0);

  // Pulse dot — proves the loop is running each frame
  uint16_t dot = (frame_count & 1) ? ILI9341_RED : ILI9341_DARKGREY;
  tft.fillCircle(304, 12, 6, dot);
}

void draw_header_dump(const uint8_t* buf, size_t len) {
  // Erase + redraw 16-byte hex dump
  tft.fillRect(0, 124, 320, 36, ILI9341_BLACK);
  tft.setTextSize(2);
  // SOI bytes (FF D8 FF) coloured green if valid
  bool soi_ok = (len >= 3) && buf[0] == 0xFF && buf[1] == 0xD8 && buf[2] == 0xFF;
  tft.setCursor(8, 128);
  for (size_t i = 0; i < 8 && i < len; i++) {
    tft.setTextColor(i < 3 && soi_ok ? ILI9341_GREEN : ILI9341_WHITE);
    tft.printf("%02X ", buf[i]);
  }
  tft.setCursor(8, 146);
  for (size_t i = 8; i < 16 && i < len; i++) {
    tft.setTextColor(ILI9341_WHITE);
    tft.printf("%02X ", buf[i]);
  }
}

void draw_histogram(const uint8_t* buf, size_t len) {
  // 8 buckets: 0x00-0x1F, 0x20-0x3F, ..., 0xE0-0xFF
  // Sample stride = max(1, len/2048) so this stays cheap
  uint32_t bucket[8] = {0};
  size_t stride = len / 2048;
  if (stride < 1) stride = 1;
  for (size_t i = 0; i < len; i += stride) {
    bucket[buf[i] >> 5]++;
  }

  // Find max for scaling
  uint32_t maxv = 1;
  for (int i = 0; i < 8; i++) if (bucket[i] > maxv) maxv = bucket[i];

  // Draw 8 bars in 304 px wide area, 60 px tall, starting at y=180
  const int BAR_X = 8, BAR_Y = 184, BAR_W = 36, BAR_GAP = 2, BAR_H = 50;
  tft.fillRect(0, BAR_Y, 320, BAR_H + 4, ILI9341_BLACK);
  uint16_t colors[8] = {
    ILI9341_NAVY,    ILI9341_BLUE,    ILI9341_DARKCYAN, ILI9341_CYAN,
    ILI9341_GREEN,   ILI9341_YELLOW,  ILI9341_ORANGE,   ILI9341_RED,
  };
  for (int i = 0; i < 8; i++) {
    int h = (int)(((uint64_t)bucket[i] * BAR_H) / maxv);
    int x = BAR_X + i * (BAR_W + BAR_GAP);
    tft.fillRect(x, BAR_Y + (BAR_H - h), BAR_W, h, colors[i]);
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("=== Velxio ESP32-CAM + ILI9341 status dashboard ===");

  tftSPI.begin(TFT_SCK, -1, TFT_MOSI, TFT_CS);
  tft.begin();
  tft.setRotation(1);
  tft.fillScreen(ILI9341_NAVY);
  tft.setTextSize(2);
  tft.setTextColor(ILI9341_WHITE);
  tft.setCursor(40, 90);
  tft.print("Booting camera...");

  camera_config_t cfg = {};
  cfg.ledc_channel = LEDC_CHANNEL_0;
  cfg.ledc_timer   = LEDC_TIMER_0;
  cfg.pin_d0 = Y2_GPIO_NUM;
  cfg.pin_d1 = Y3_GPIO_NUM;
  cfg.pin_d2 = Y4_GPIO_NUM;
  cfg.pin_d3 = Y5_GPIO_NUM;
  cfg.pin_d4 = Y6_GPIO_NUM;
  cfg.pin_d5 = Y7_GPIO_NUM;
  cfg.pin_d6 = Y8_GPIO_NUM;
  cfg.pin_d7 = Y9_GPIO_NUM;
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
  cfg.frame_size   = FRAMESIZE_QVGA;
  cfg.jpeg_quality = 12;
  cfg.fb_count     = 1;
  cfg.fb_location  = CAMERA_FB_IN_DRAM;

  esp_err_t err = esp_camera_init(&cfg);
  if (err != ESP_OK) {
    tft.setTextColor(ILI9341_RED);
    tft.setCursor(40, 130);
    tft.print("camera_init FAIL");
    while (1) delay(1000);
  }

  draw_static();
  start_ms = millis();
}

void loop() {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) { delay(50); return; }

  frame_count++;
  total_bytes += fb->len;

  draw_stats(fb->len);
  draw_header_dump(fb->buf, fb->len);
  draw_histogram(fb->buf, fb->len);

  esp_camera_fb_return(fb);
  delay(50);
}

/*
 * esp32-cam-lcd-preview.ino
 *
 * ESP32-CAM live preview on an ILI9341 320×240 TFT.
 * Capture frames via esp_camera_fb_get(), decode the JPEG with
 * jpg2rgb565() (built into esp32-camera/conversions), and push the
 * resulting RGB565 bitmap to the screen with Adafruit_ILI9341.
 *
 * Designed to run end-to-end inside the Velxio ESP32-CAM emulator —
 * the user's webcam shows up live on the simulated TFT panel.
 *
 * Wiring (AI-Thinker ESP32-CAM ↔ ILI9341):
 *
 *   ILI9341  →  ESP32-CAM
 *   ──────────────────────────
 *   VCC       3V3
 *   GND       GND
 *   CS        GPIO 15   (VSPI CS)
 *   RST       GPIO 2    (or wire to 3V3 / EN — software reset works too)
 *   D/C       GPIO 14
 *   MOSI      GPIO 13   (VSPI MOSI)
 *   SCK       GPIO 12   (VSPI SCK)
 *   LED       3V3       (backlight always on)
 *   MISO      —         (display is write-only; leave unconnected)
 *
 * Why these pins: GPIOs 12-15 are the only pin block free on the
 * AI-Thinker ESP32-CAM after the camera takes over 0, 5, 18, 19, 21,
 * 22, 23, 25, 26, 27, 32, 34-39. GPIO 2 is the on-board blue LED;
 * we hijack it for RST.
 *
 * IMPORTANT: this sketch needs the following libraries installed via
 * the Velxio "Library Manager" (book icon in the toolbar):
 *   - Adafruit GFX Library   (graphics primitives)
 *   - Adafruit ILI9341       (TFT driver)
 */

#include "esp_camera.h"
#include "img_converters.h"   // jpg2rgb565 — ships with esp32-camera

#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>

// ── AI-Thinker ESP32-CAM camera pinout ─────────────────────────────
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

// ── ILI9341 SPI pinout ─────────────────────────────────────────────
#define TFT_CS    15
#define TFT_DC    14
#define TFT_RST    2
#define TFT_MOSI  13
#define TFT_SCK   12
#define TFT_MISO  -1   // unused (write-only display)

// Adafruit_ILI9341 wrapper — using a custom SPIClass on VSPI so we
// can pin MOSI/SCK to GPIOs 13/12 instead of the default SPI pins.
SPIClass tftSPI(VSPI);
Adafruit_ILI9341 tft = Adafruit_ILI9341(&tftSPI, TFT_DC, TFT_CS, TFT_RST);

// Preview is scaled 1/2 from the QVGA capture (320×240 → 160×120).
// 160 × 120 × 2 bytes = 38 400 bytes — fits comfortably in DRAM.
// Centered in the 320×240 landscape TFT at offset (80, 60).
#define PREVIEW_W  160
#define PREVIEW_H  120
#define PREVIEW_X   80
#define PREVIEW_Y   60
static uint8_t rgbBuf[PREVIEW_W * PREVIEW_H * 2];

// Counters for status overlay
uint32_t frame_count   = 0;
uint32_t decode_fails  = 0;
uint32_t null_fb_count = 0;
unsigned long start_ms = 0;

void draw_status_bar(uint32_t bytes_in, bool decoded) {
  // Background bar at the top of the screen (above preview area).
  tft.fillRect(0, 0, 320, PREVIEW_Y, ILI9341_BLACK);
  tft.setTextSize(1);
  tft.setTextColor(ILI9341_WHITE, ILI9341_BLACK);

  tft.setCursor(8, 6);
  tft.print("VELXIO ESP32-CAM live preview");

  tft.setCursor(8, 22);
  tft.printf("frame %4u   %4u B   %s",
             (unsigned)frame_count,
             (unsigned)bytes_in,
             decoded ? "decode OK   " : "decode FAIL ");

  unsigned long elapsed = millis() - start_ms;
  float fps = elapsed > 0 ? (1000.0f * frame_count) / (float)elapsed : 0.0f;
  tft.setCursor(8, 38);
  tft.printf("fps %4.1f   fails %u   nulls %u",
             fps,
             (unsigned)decode_fails,
             (unsigned)null_fb_count);

  // "Live dot" — pulses every frame so the user can see the loop is alive
  uint16_t dotColor = (frame_count & 1) ? ILI9341_GREEN : ILI9341_DARKGREEN;
  tft.fillCircle(308, 14, 6, dotColor);
}

void show_boot_step(int step, const char* msg, uint16_t color = ILI9341_WHITE) {
  tft.setTextSize(2);
  tft.setTextColor(color, ILI9341_BLACK);
  tft.setCursor(20, 40 + step * 30);
  tft.printf("[%d/4] %s", step, msg);
  Serial.printf("[%d/4] %s\n", step, msg);
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("=== Velxio ESP32-CAM + ILI9341 live preview ===");

  // ── Init TFT first so we can show camera-boot progress on screen ──
  tftSPI.begin(TFT_SCK, TFT_MISO, TFT_MOSI, TFT_CS);
  tft.begin();
  tft.setRotation(1);                  // landscape: 320 (w) × 240 (h)
  tft.fillScreen(ILI9341_NAVY);

  tft.setTextSize(3);
  tft.setTextColor(ILI9341_WHITE);
  tft.setCursor(20, 10);
  tft.print("VELXIO");
  tft.setTextSize(1);
  tft.setCursor(20, 38);
  tft.setTextColor(ILI9341_CYAN);
  tft.print("ESP32-CAM live preview");

  // ── Camera config ────────────────────────────────────────────────
  show_boot_step(1, "Configuring camera...");

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
  cfg.pixel_format = PIXFORMAT_JPEG;   // we decode in-sketch
  cfg.frame_size   = FRAMESIZE_QVGA;   // 320 × 240 — matches what the
                                       // browser webcam pipes through
  cfg.jpeg_quality = 12;
  cfg.fb_count     = 1;
  cfg.fb_location  = CAMERA_FB_IN_DRAM;  // QEMU has no PSRAM emulated

  show_boot_step(2, "Calling camera_init...");
  esp_err_t err = esp_camera_init(&cfg);
  if (err != ESP_OK) {
    show_boot_step(2, "camera_init FAIL", ILI9341_RED);
    Serial.printf("camera_init failed: 0x%x\n", err);
    while (1) delay(1000);
  }

  // Read the OV2640 chip-id over SCCB so we can show it on the LCD.
  show_boot_step(3, "Reading OV2640 chip-id...");
  sensor_t* s = esp_camera_sensor_get();
  if (s) {
    Serial.printf("OV2640 PID=0x%02X VER=0x%02X MIDH=0x%02X MIDL=0x%02X\n",
                  s->id.PID, s->id.VER, s->id.MIDH, s->id.MIDL);
    char line[40];
    snprintf(line, sizeof(line), "PID=0x%02X VER=0x%02X",
             s->id.PID, s->id.VER);
    tft.setTextSize(1);
    tft.setCursor(80, 145);
    tft.setTextColor(ILI9341_GREEN, ILI9341_NAVY);
    tft.print(line);
  }

  show_boot_step(4, "Click 'Camera' button >");
  tft.setTextColor(ILI9341_YELLOW, ILI9341_NAVY);
  tft.setTextSize(1);
  tft.setCursor(20, 200);
  tft.print("Waiting for webcam frames...");

  start_ms = millis();
  delay(500);
  tft.fillScreen(ILI9341_BLACK);
}

void loop() {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    null_fb_count++;
    if (null_fb_count == 1 || null_fb_count % 20 == 0) {
      Serial.printf("fb_get NULL — webcam not active? (count=%u)\n",
                    (unsigned)null_fb_count);
    }
    delay(50);
    return;
  }

  frame_count++;
  size_t fb_len = fb->len;

  // Decode the JPEG into RGB565 at half resolution (160×120).
  // The conversions library ships inside libesp32-camera.a; the
  // Velxio CMakeLists template adds the include path automatically.
  bool ok = jpg2rgb565(fb->buf, fb->len, rgbBuf, JPG_SCALE_2X);
  esp_camera_fb_return(fb);

  if (ok) {
    // Push the bitmap to the centre of the TFT.
    tft.drawRGBBitmap(PREVIEW_X, PREVIEW_Y,
                      (uint16_t*)rgbBuf, PREVIEW_W, PREVIEW_H);
  } else {
    decode_fails++;
    // Decode failure → grey rectangle with an X.
    tft.fillRect(PREVIEW_X, PREVIEW_Y, PREVIEW_W, PREVIEW_H, ILI9341_DARKGREY);
    tft.drawLine(PREVIEW_X, PREVIEW_Y,
                 PREVIEW_X + PREVIEW_W, PREVIEW_Y + PREVIEW_H, ILI9341_RED);
    tft.drawLine(PREVIEW_X + PREVIEW_W, PREVIEW_Y,
                 PREVIEW_X, PREVIEW_Y + PREVIEW_H, ILI9341_RED);
  }

  // Always refresh the status bar (cheap — only top 60 px).
  draw_status_bar((uint32_t)fb_len, ok);

  // Mild throttle so the CPU has time to refresh the SPI bus.
  delay(20);
}

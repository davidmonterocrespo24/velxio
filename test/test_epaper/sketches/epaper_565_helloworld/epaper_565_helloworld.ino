/*
 * epaper_565_helloworld — 5.65" 600×448 ACeP 7-colour panel (UC8159c).
 *
 * Driven by GxEPD2_7C with the GDEP0565D90 driver class. ESP32 / Pi
 * Pico only — the framebuffer (~135 KB even with paged mode) blows
 * past Uno's flash. Real refresh time is ~12 s; the emulator pulses
 * BUSY for `refreshMs` (default 150 ms).
 *
 * Wiring matches the rest of the ePaper sketches.
 */

#include <Arduino.h>

#if defined(ARDUINO_ARCH_AVR)
  #error "5.65\" 7-colour ACeP panel is too big for AVR Uno — use ESP32 or Pi Pico."
#endif

#include <GxEPD2_7C.h>
#include <Fonts/FreeMonoBold18pt7b.h>

#if defined(ARDUINO_ARCH_ESP32)
  #define EPD_CS    5
  #define EPD_DC    17
  #define EPD_RST   16
  #define EPD_BUSY  4
#else
  #define EPD_CS    9
  #define EPD_DC    8
  #define EPD_RST   12
  #define EPD_BUSY  13
#endif

GxEPD2_7C<GxEPD2_565c_GDEP0565D90, 8> display(
  GxEPD2_565c_GDEP0565D90(EPD_CS, EPD_DC, EPD_RST, EPD_BUSY));

const uint16_t COLOURS[] = {
  GxEPD_BLACK, GxEPD_WHITE, GxEPD_GREEN,
  GxEPD_BLUE,  GxEPD_RED,   GxEPD_YELLOW, GxEPD_ORANGE,
};

void drawRainbow() {
  display.fillScreen(GxEPD_WHITE);
  const int barH = 448 / 7;
  for (uint8_t i = 0; i < 7; i++) {
    display.fillRect(0, i * barH, 600, barH, COLOURS[i]);
  }
  display.setTextColor(GxEPD_BLACK);
  display.setFont(&FreeMonoBold18pt7b);
  display.setCursor(120, 240);
  display.print("Velxio ACeP 7c");
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println(F("ePaper 5.65\" ACeP 7-colour hello"));

  display.init(115200, true, 50, false);
  display.setRotation(0);
  display.setFullWindow();
  display.firstPage();
  do { drawRainbow(); } while (display.nextPage());
  display.hibernate();
  Serial.println(F("frame done"));
}

void loop() { delay(1000); }

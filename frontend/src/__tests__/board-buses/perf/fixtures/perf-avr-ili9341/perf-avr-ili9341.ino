// Board buses perf baseline (project/board-buses-2026-09, DESIGN section 11):
// Uno + ILI9341 (CS D10, D/C D9) on the hardware SPI bus (D11/D12/D13),
// Adafruit_ILI9341 filling the whole 240x320 screen in a loop.
//
// One frame = a drawPixel(0, 0) (CASET, PASET, RAMWR and one pixel: 13 bytes),
// then fillScreen: CASET, PASET, RAMWR (11 bytes) and 76800 RGB565 pixels
// (153600 bytes). The colour alternates so the bench can check the panel
// really drew the frame it timed.
//
// Why the drawPixel: Adafruit_ILI9341 caches the address window and, when a
// fill uses the same window as the last one, sends RAMWR alone. A real panel
// restarts at the window origin on RAMWR; the OSS ili9341 model does not, so
// from the second fillScreen on it drops every pixel and a bench would time a
// decoder that draws nothing. Moving the window to one pixel and back makes
// every frame carry CASET and PASET, which both the panel and the model
// handle, so each timed frame is a frame that really reached the glass.
//
// Serial protocol (115200):
//   READY          panel initialised
//   F <n> <us>     frame n finished; <us> = guest micros() the fill took
//
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn arduino:avr:uno --libs "Adafruit GFX Library,Adafruit ILI9341" \
//   --out <this dir> <this dir>/perf-avr-ili9341.ino
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>

#define TFT_CS 10
#define TFT_DC 9

Adafruit_ILI9341 tft(TFT_CS, TFT_DC);
static uint32_t frame = 0;

void setup() {
  Serial.begin(115200);
  tft.begin();
  Serial.println(F("READY"));
}

void loop() {
  uint16_t colour = (frame & 1) ? ILI9341_RED : ILI9341_BLUE;
  uint32_t t0 = micros();
  tft.drawPixel(0, 0, colour);
  tft.fillScreen(colour);
  uint32_t dt = micros() - t0;
  Serial.print(F("F "));
  Serial.print(frame);
  Serial.print(' ');
  Serial.println(dt);
  frame++;
}

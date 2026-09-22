// Uno + ILI9341 (CS D10, DC D9) + microSD (CS D4) on the hardware SPI bus.
//
// The spitftbitmap shape: ONE address window for the whole picture, and the
// card read in the middle of it. Between chunks the panel is deselected (CS
// high) but sits in RAMWR with DC high, which is where Adafruit_SPITFT leaves
// it, so every card byte crosses the panel's SCK/MOSI while it is not its own.
//
// Serial protocol (115200):
//   TFT            panel initialised
//   IDLE:<hex>     one byte clocked with NOBODY selected (hardware: 0xFF)
//   SD:OK|FAIL     SD.begin()
//   SUM:<n>        sum of the 16-bit words read from img.raw (MISO reached the MCU)
//   DONE           picture pushed
//
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn arduino:avr:uno --libs "SD,Adafruit GFX Library,Adafruit ILI9341" \
//   --out <this dir> <this dir>/avr-tft-sd.ino
#include <SPI.h>
#include <SD.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>

#define TFT_CS 10
#define TFT_DC 9
#define SD_CS 4
#define IMG_X 40
#define IMG_Y 60
#define IMG_W 32
#define IMG_H 32

Adafruit_ILI9341 tft(TFT_CS, TFT_DC);

void setup() {
  Serial.begin(115200);
  pinMode(SD_CS, OUTPUT);
  digitalWrite(SD_CS, HIGH);
  tft.begin();
  Serial.println(F("TFT"));

  SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));
  uint8_t idle = SPI.transfer(0x5A);
  SPI.endTransaction();
  Serial.print(F("IDLE:"));
  Serial.println(idle, HEX);

  if (!SD.begin(SD_CS)) {
    Serial.println(F("SD:FAIL"));
    return;
  }
  Serial.println(F("SD:OK"));
  File f = SD.open("img.raw");
  if (!f) {
    Serial.println(F("OPEN:FAIL"));
    return;
  }

  tft.startWrite();
  tft.setAddrWindow(IMG_X, IMG_Y, IMG_W, IMG_H);
  tft.endWrite();

  uint16_t buf[16];
  uint32_t sum = 0;
  for (int i = 0; i < (IMG_W * IMG_H) / 16; i++) {
    f.read((uint8_t *)buf, sizeof(buf));
    for (int k = 0; k < 16; k++) sum += buf[k];
    tft.startWrite();
    tft.writePixels(buf, 16);
    tft.endWrite();
  }
  f.close();
  Serial.print(F("SUM:"));
  Serial.println(sum);
  Serial.println(F("DONE"));
}

void loop() {}

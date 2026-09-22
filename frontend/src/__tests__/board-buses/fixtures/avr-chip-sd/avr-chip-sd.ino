// Uno + a custom SPI chip (spi-word.c, CS D7) + microSD (CS D4), both on the
// hardware SPI bus (D11/D12/D13).
//
// The chip answers one 16-bit word per chip select (0x0320 by default), so
// CHIP:320 means the chip's MISO reached the MCU, and CHIP:0 is the sketch
// reading its own MOSI (0x0000) back. The chip is read before and after the
// card, so both sit on the bus while the other one is used.
//
// Serial protocol (115200): CHIP:<hex>, SD:OK|FAIL, SUM:<n>, CHIP:<hex>, DONE.
//
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn arduino:avr:uno --libs "SD" --out <this dir> <this dir>/avr-chip-sd.ino
#include <SPI.h>
#include <SD.h>

#define SD_CS 4
#define CHIP_CS 7

static uint16_t readChip() {
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  digitalWrite(CHIP_CS, LOW);
  const uint16_t w = SPI.transfer16(0x0000);
  digitalWrite(CHIP_CS, HIGH);
  SPI.endTransaction();
  return w;
}

void setup() {
  Serial.begin(115200);
  pinMode(SD_CS, OUTPUT);
  digitalWrite(SD_CS, HIGH);
  pinMode(CHIP_CS, OUTPUT);
  digitalWrite(CHIP_CS, HIGH);
  SPI.begin();
  Serial.print(F("CHIP:"));
  Serial.println(readChip(), HEX);
  if (!SD.begin(SD_CS)) {
    Serial.println(F("SD:FAIL"));
    return;
  }
  Serial.println(F("SD:OK"));
  File f = SD.open("img.raw");
  uint32_t sum = 0;
  while (f.available() >= 2) {
    uint16_t w;
    f.read((uint8_t *)&w, 2);
    sum += w;
  }
  f.close();
  Serial.print(F("SUM:"));
  Serial.println(sum);
  Serial.print(F("CHIP:"));
  Serial.println(readChip(), HEX);
  Serial.println(F("DONE"));
}

void loop() {}

// ATtiny85 + SSD1306 over I2C (0x3C), driven through the USI (ATTinyCore Wire:
// SDA PB0, SCL PB2).
//
// Init in horizontal mode with the full window, then 1024 data bytes of 0x81
// in 8-byte transactions. Every transaction must be ACKed.
//
// No UART on this chip, so the result is on two pins: PB3 HIGH when every
// transaction was ACKed, PB4 HIGH when any was not. delay() is not used
// (ATtiny85 Timer0 limitation, see AVRSimulator).
//
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn ATTinyCore:avr:attinyx5:chip=85,clock=16pll --board-kind attiny85 \
//   --out <this dir> <this dir>/avr-tiny-oled.ino
#include <Wire.h>

#define OLED 0x3C

static bool ok = true;

static void cmd(uint8_t c) {
  Wire.beginTransmission(OLED);
  Wire.write(0x00);
  Wire.write(c);
  if (Wire.endTransmission() != 0) ok = false;
}

static const uint8_t INIT[] = {
  0xAE, 0x8D, 0x14, 0x20, 0x00, 0x21, 0x00, 0x7F, 0x22, 0x00, 0x07, 0xAF,
};

void setup() {
  pinMode(3, OUTPUT);
  pinMode(4, OUTPUT);
  digitalWrite(3, LOW);
  digitalWrite(4, LOW);
  Wire.begin();
  for (uint8_t i = 0; i < sizeof(INIT); i++) cmd(INIT[i]);
  for (uint8_t t = 0; t < 128; t++) {
    Wire.beginTransmission(OLED);
    Wire.write(0x40);
    for (uint8_t k = 0; k < 8; k++) Wire.write(0x81);
    if (Wire.endTransmission() != 0) ok = false;
  }
  digitalWrite(ok ? 3 : 4, HIGH);
}

void loop() {}

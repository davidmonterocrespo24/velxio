// Raspberry Pi Pico: hardware Wire writes the oscilloscope draws, each followed
// by an address probe that arduino-pico bit-bangs through the SIO on the same
// pads (SDA = GP4, SCL = GP5), for the order in which the scope receives the
// two (velxio/velxio-prod#160). The RP2040's controller cannot send a
// zero-length write, so Wire.endTransmission() with no data is bit-banged.
//
// rp2040js completes every I2C step at once, so the CPU runs ahead of the
// drawing. In the first half of a round the probe waits until the write is
// off the wire; in the second it starts while the write is still being drawn.
//
// Serial protocol (115200): "a=<err> b=<err>" after each round, every 20 ms
// (2 = the probed address did not answer).
//
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn rp2040:rp2040:rpipico --board-kind raspberry-pi-pico \
//   --out <this dir> <this dir>/rp2040-i2c-probe-scope.ino
#include <Wire.h>

// Sixteen data bytes to 0x3C: about 1.6 ms on the wire at 100 kHz.
static void write16() {
  Wire.beginTransmission(0x3C);
  for (uint8_t i = 0; i < 16; i++) Wire.write(0x40 + i);
  Wire.endTransmission();
}

// A zero-length write to 0x3D, which nobody answers.
static uint8_t probe() {
  Wire.beginTransmission(0x3D);
  return Wire.endTransmission();
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
}

void loop() {
  write16();
  delayMicroseconds(3000);
  uint8_t a = probe();
  write16();
  uint8_t b = probe();
  Serial.print("a=");
  Serial.print(a);
  Serial.print(" b=");
  Serial.println(b);
  delay(20);
}

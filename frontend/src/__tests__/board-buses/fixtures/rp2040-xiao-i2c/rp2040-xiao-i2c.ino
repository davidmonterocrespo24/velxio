// Seeed XIAO RP2040: the Grove I2C socket is D4 (SDA, GP6) / D5 (SCL, GP7).
// On this variant Wire is the RP2040's I2C1 controller.
// Addresses 0x44 (a one-byte register write, then a two-byte read). The
// write carries a byte on purpose: the core serves a zero-length write (the
// usual "probe") by bit-banging the pins, not through the controller. A
// short timeout keeps a NACK cheap: the engine only reports one when it runs
// out (a second of busy guest time at the core's default).
#include <Wire.h>

void setup() {
  Serial.begin(115200);
  Serial.println("READY");
  Wire.begin();
  Wire.setTimeout(20);
  Wire.beginTransmission(0x44);
  Wire.write(0x00);
  uint8_t err = Wire.endTransmission();
  if (err != 0) {
    Serial.println("WIRE:NACK");
  } else {
    Serial.print("WIRE:ACK:");
    Wire.requestFrom(0x44, 2);
    while (Wire.available()) {
      uint8_t b = Wire.read();
      if (b < 0x10) Serial.print('0');
      Serial.print(b, HEX);
    }
    Serial.println();
  }
  Serial.println("DONE");
}

void loop() {}

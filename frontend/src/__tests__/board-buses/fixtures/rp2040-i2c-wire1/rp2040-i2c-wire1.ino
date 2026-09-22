// Raspberry Pi Pico with both I2C controllers up:
//   Wire  = I2C0 on GP4 (SDA) / GP5 (SCL)
//   Wire1 = I2C1 on GP26 (SDA) / GP27 (SCL)
// Addresses 0x44 on each (a one-byte register write, then a two-byte read).
// The write carries a byte on purpose: the core serves a zero-length write
// (the usual "probe") by bit-banging the pins, not through the controller.
// A short timeout keeps a NACK cheap: the engine only reports one when it
// runs out (a second of busy guest time at the core's default).
#include <Wire.h>

static void probe(TwoWire &w, const char *name) {
  w.beginTransmission(0x44);
  w.write(0x00);
  uint8_t err = w.endTransmission();
  Serial.print(name);
  if (err != 0) {
    Serial.println(":NACK");
    return;
  }
  Serial.print(":ACK:");
  w.requestFrom(0x44, 2);
  while (w.available()) {
    uint8_t b = w.read();
    if (b < 0x10) Serial.print('0');
    Serial.print(b, HEX);
  }
  Serial.println();
}

void setup() {
  Serial.begin(115200);
  Serial.println("READY");
  Wire.setSDA(4);
  Wire.setSCL(5);
  Wire.begin();
  Wire.setTimeout(20);
  Wire1.setSDA(26);
  Wire1.setSCL(27);
  Wire1.begin();
  Wire1.setTimeout(20);
  probe(Wire, "WIRE0");
  probe(Wire1, "WIRE1");
  Serial.println("DONE");
}

void loop() {}

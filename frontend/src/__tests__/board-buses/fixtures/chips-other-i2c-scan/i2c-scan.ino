// I2C scanner on the hardware Wire pins (A4/A5), plus one read of 0x44 per pass.
#include <Wire.h>

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Serial.print("READY\n");
}

void loop() {
  Serial.print("scan:");
  for (uint8_t a = 8; a < 120; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      Serial.print(' ');
      Serial.print(a, HEX);
    }
  }
  Serial.print("\n");
  uint8_t n = Wire.requestFrom((uint8_t)0x44, (uint8_t)1);
  Serial.print("r44:");
  if (n) Serial.print(Wire.read(), HEX);
  else Serial.print("none");
  Serial.print("\n");
  delay(5);
}

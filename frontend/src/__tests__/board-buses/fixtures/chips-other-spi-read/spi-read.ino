// Three one-byte SPI transactions with CS on D10; prints what MISO returned.
#include <SPI.h>

void setup() {
  Serial.begin(115200);
  pinMode(10, OUTPUT);
  digitalWrite(10, HIGH);
  SPI.begin();
  Serial.print("READY\n");
  for (int i = 0; i < 3; i++) {
    digitalWrite(10, LOW);
    uint8_t r = SPI.transfer(0x9F);
    digitalWrite(10, HIGH);
    Serial.print("spi=");
    Serial.print(r, HEX);
    Serial.print("\n");
    delay(2);
  }
}

void loop() {}

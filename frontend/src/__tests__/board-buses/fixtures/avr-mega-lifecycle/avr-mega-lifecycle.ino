// Arduino Mega: a plain sketch that leans on three interrupt vectors.
//
//   TIMER0_OVF   millis()          (Mega vector 23, word 0x2E)
//   USART0_UDRE  buffered Serial   (Mega vector 26, word 0x34)
//   TWI          Wire              (Mega vector 39, word 0x4E)
//
// The DS1307 at 0x68 is a part the test wires to SDA/SCL (20/21). A vector
// that lands on an unused slot jumps to __bad_interrupt, which restarts the
// sketch: BOOT then shows up more than once.
//
// Serial protocol (115200): BOOT, TWI:OK|FAIL, T:1..T:5 (20 ms apart), DONE.
//
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn arduino:avr:mega --out <this dir> <this dir>/avr-mega-lifecycle.ino
#include <Wire.h>

void setup() {
  Serial.begin(115200);
  Serial.println(F("BOOT"));
  Wire.begin();
  Wire.beginTransmission(0x68);
  Wire.write(0x00);
  const uint8_t err = Wire.endTransmission();
  const uint8_t got = Wire.requestFrom(0x68, 1);
  if (got == 1) Wire.read();
  Serial.println(err == 0 && got == 1 ? F("TWI:OK") : F("TWI:FAIL"));
}

unsigned long last = 0;
uint8_t ticks = 0;

void loop() {
  if (ticks < 5 && millis() - last >= 20) {
    last = millis();
    ticks++;
    Serial.print(F("T:"));
    Serial.println(ticks);
    if (ticks == 5) Serial.println(F("DONE"));
  }
}

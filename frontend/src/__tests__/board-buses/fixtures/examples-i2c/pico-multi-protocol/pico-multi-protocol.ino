// Raspberry Pi Pico — Multi-Protocol Demo
// Tests Serial, I2C, SPI, and ADC all together

#include <Wire.h>
#include <SPI.h>

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
  delay(500);

  Serial.println("==============================");
  Serial.println(" Pico Multi-Protocol Demo");
  Serial.println("==============================");
  Serial.println();

  // ── 1. I2C Scanner ──
  Wire.begin();
  Serial.println("[I2C] Scanning bus...");
  int found = 0;
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      found++;
      Serial.print("  Found device at 0x");
      if (addr < 16) Serial.print('0');
      Serial.println(addr, HEX);
    }
  }
  Serial.print("  Total devices: "); Serial.println(found);
  Serial.println();

  // ── 2. I2C EEPROM R/W ──
  Serial.println("[I2C] EEPROM test at 0x50...");
  Wire.beginTransmission(0x50);
  Wire.write(0x00); // register 0
  Wire.write(0x42); // data
  Wire.endTransmission();
  delay(5);

  Wire.beginTransmission(0x50);
  Wire.write(0x00);
  Wire.endTransmission();
  Wire.requestFrom(0x50, 1);
  if (Wire.available()) {
    byte val = Wire.read();
    Serial.print("  Wrote 0x42, Read 0x");
    Serial.print(val, HEX);
    Serial.println(val == 0x42 ? " — OK" : " — FAIL");
  }
  Serial.println();

  // ── 3. I2C RTC ──
  Serial.println("[I2C] Reading RTC at 0x68...");
  Wire.beginTransmission(0x68);
  Wire.write(0x00);
  Wire.endTransmission();
  Wire.requestFrom(0x68, 3);
  if (Wire.available() >= 3) {
    byte sec = ((Wire.read() & 0x7F) >> 4) * 10 + (Wire.read() & 0x0F);
    byte min2 = Wire.read();
    (void)sec; (void)min2;
    Serial.println("  RTC responded OK");
  }
  Serial.println();

  // ── 4. SPI Loopback ──
  Serial.println("[SPI] Loopback test...");
  SPI.begin();
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  byte tx = 0xAB;
  byte rx = SPI.transfer(tx);
  Serial.print("  TX: 0x"); Serial.print(tx, HEX);
  Serial.print("  RX: 0x"); Serial.println(rx, HEX);
  SPI.endTransaction();
  Serial.println();

  // ── 5. ADC ──
  Serial.println("[ADC] Reading analog channels...");
  analogReadResolution(12);
  int a0 = analogRead(A0);
  Serial.print("  A0 (GP26): "); Serial.println(a0);
  Serial.println();

  // ── 6. GPIO ──
  Serial.println("[GPIO] Blinking LED...");
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_BUILTIN, HIGH);
    delay(200);
    digitalWrite(LED_BUILTIN, LOW);
    delay(200);
  }
  Serial.println("  3 blinks done");
  Serial.println();

  Serial.println("=== All protocol tests complete ===");
}

void loop() {
  // Heartbeat
  static unsigned long last = 0;
  if (millis() - last >= 3000) {
    last = millis();
    Serial.print("[Heartbeat] ");
    Serial.print(millis() / 1000);
    Serial.println("s");
  }
}

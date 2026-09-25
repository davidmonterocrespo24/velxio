// Multi-Protocol Demo: Serial + I2C + SPI
// Demonstrates all three major communication protocols
// working together in a single sketch.

#include <Wire.h>
#include <SPI.h>

#define DS1307_ADDR 0x68
#define EEPROM_ADDR 0x50
#define SS_PIN 10

byte bcdToDec(byte val) {
  return ((val >> 4) * 10) + (val & 0x0F);
}

void readRTC(byte &hr, byte &min, byte &sec) {
  Wire.beginTransmission(DS1307_ADDR);
  Wire.write(0x00);
  Wire.endTransmission();
  Wire.requestFrom(DS1307_ADDR, 3);
  sec = bcdToDec(Wire.read() & 0x7F);
  min = bcdToDec(Wire.read());
  hr  = bcdToDec(Wire.read() & 0x3F);
}

void writeEEPROM(byte reg, byte value) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write(reg);
  Wire.write(value);
  Wire.endTransmission();
  delay(5);
}

byte readEEPROM(byte reg) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write(reg);
  Wire.endTransmission();
  Wire.requestFrom(EEPROM_ADDR, 1);
  return Wire.available() ? Wire.read() : 0xFF;
}

byte spiTransfer(byte data) {
  digitalWrite(SS_PIN, LOW);
  byte result = SPI.transfer(data);
  digitalWrite(SS_PIN, HIGH);
  return result;
}

void setup() {
  Serial.begin(9600);
  Wire.begin();
  pinMode(SS_PIN, OUTPUT);
  digitalWrite(SS_PIN, HIGH);
  SPI.begin();

  Serial.println("===================================");
  Serial.println(" Multi-Protocol Demo");
  Serial.println(" Serial (USART) + I2C (TWI) + SPI");
  Serial.println("===================================");
  Serial.println();

  // ── I2C: Scan bus ──
  Serial.println("[I2C] Scanning bus...");
  int found = 0;
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.print("  Found device at 0x");
      if (addr < 16) Serial.print("0");
      Serial.println(addr, HEX);
      found++;
    }
  }
  Serial.print("  ");
  Serial.print(found);
  Serial.println(" device(s) on I2C bus.");
  Serial.println();

  // ── I2C: Write/read EEPROM ──
  Serial.println("[I2C] EEPROM write/read test:");
  writeEEPROM(0, 42);
  writeEEPROM(1, 99);
  byte v0 = readEEPROM(0);
  byte v1 = readEEPROM(1);
  Serial.print("  Wrote 42, read ");
  Serial.print(v0);
  Serial.println(v0 == 42 ? " [OK]" : " [FAIL]");
  Serial.print("  Wrote 99, read ");
  Serial.print(v1);
  Serial.println(v1 == 99 ? " [OK]" : " [FAIL]");
  Serial.println();

  // ── SPI: Transfer test ──
  Serial.println("[SPI] Transfer test:");
  byte spiData[] = {0xAA, 0x55, 0x42};
  for (int i = 0; i < 3; i++) {
    byte rx = spiTransfer(spiData[i]);
    Serial.print("  TX=0x");
    if (spiData[i] < 16) Serial.print("0");
    Serial.print(spiData[i], HEX);
    Serial.print(" RX=0x");
    if (rx < 16) Serial.print("0");
    Serial.println(rx, HEX);
  }
  Serial.println();

  Serial.println("Setup complete. Reading RTC...");
  Serial.println();
}

void loop() {
  // ── Serial: Print RTC time every 2 seconds ──
  byte hr, min, sec;
  readRTC(hr, min, sec);

  Serial.print("[RTC] ");
  if (hr < 10) Serial.print("0");
  Serial.print(hr);
  Serial.print(":");
  if (min < 10) Serial.print("0");
  Serial.print(min);
  Serial.print(":");
  if (sec < 10) Serial.print("0");
  Serial.print(sec);

  Serial.print("  |  Uptime: ");
  Serial.print(millis() / 1000);
  Serial.println("s");

  delay(2000);
}

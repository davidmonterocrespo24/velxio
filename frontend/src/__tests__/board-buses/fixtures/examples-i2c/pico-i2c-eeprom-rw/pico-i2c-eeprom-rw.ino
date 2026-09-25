// Raspberry Pi Pico — I2C EEPROM Read/Write
// Writes data to the 24C01 EEPROM at 0x50 (SDA = GP4, SCL = GP5) and reads it back

#include <Wire.h>

#define EEPROM_ADDR 0x50

void eepromWrite(byte memAddr, byte data) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write(memAddr);
  Wire.write(data);
  Wire.endTransmission();
  delay(5); // EEPROM write cycle
}

byte eepromRead(byte memAddr) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write(memAddr);
  Wire.endTransmission();
  Wire.requestFrom(EEPROM_ADDR, 1);
  return Wire.available() ? Wire.read() : 0xFF;
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Wire.begin();
  Serial.println("=== Pico I2C EEPROM Test ===");
  Serial.println();

  // Write 8 bytes
  Serial.println("Writing 8 bytes...");
  byte testData[] = {0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE};
  for (int i = 0; i < 8; i++) {
    eepromWrite(i, testData[i]);
    Serial.print("  ["); Serial.print(i);
    Serial.print("] = 0x");
    if (testData[i] < 16) Serial.print('0');
    Serial.println(testData[i], HEX);
  }
  Serial.println();

  // Read back
  Serial.println("Reading back...");
  int pass = 0;
  for (int i = 0; i < 8; i++) {
    byte val = eepromRead(i);
    Serial.print("  ["); Serial.print(i);
    Serial.print("] = 0x");
    if (val < 16) Serial.print('0');
    Serial.print(val, HEX);
    if (val == testData[i]) {
      Serial.println(" OK");
      pass++;
    } else {
      Serial.print(" FAIL (expected 0x");
      Serial.print(testData[i], HEX);
      Serial.println(")");
    }
  }

  Serial.println();
  Serial.print("Result: ");
  Serial.print(pass);
  Serial.println("/8 passed");
}

void loop() {
  delay(10000);
}

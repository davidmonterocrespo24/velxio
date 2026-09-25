// I2C EEPROM Read/Write Test
// 24C01 EEPROM at address 0x50 (A0-A2 to GND), SDA = A4, SCL = A5.
// Writes values to registers, then reads them back.

#include <Wire.h>

#define EEPROM_ADDR 0x50

void writeEEPROM(byte reg, byte value) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write(reg);    // register address
  Wire.write(value);  // data
  Wire.endTransmission();
  delay(5); // EEPROM write cycle time
}

byte readEEPROM(byte reg) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write(reg);
  Wire.endTransmission();

  Wire.requestFrom(EEPROM_ADDR, 1);
  if (Wire.available()) {
    return Wire.read();
  }
  return 0xFF;
}

void setup() {
  Wire.begin();
  Serial.begin(9600);

  Serial.println("============================");
  Serial.println(" I2C EEPROM R/W Test (0x50)");
  Serial.println("============================");
  Serial.println();

  // Write test pattern
  Serial.println("Writing test data...");
  for (byte i = 0; i < 8; i++) {
    byte value = (i + 1) * 10;  // 10, 20, 30, ...
    writeEEPROM(i, value);
    Serial.print("  Write reg[");
    Serial.print(i);
    Serial.print("] = ");
    Serial.println(value);
  }

  Serial.println();
  Serial.println("Reading back...");

  // Read back and verify
  byte errors = 0;
  for (byte i = 0; i < 8; i++) {
    byte expected = (i + 1) * 10;
    byte actual = readEEPROM(i);
    Serial.print("  Read  reg[");
    Serial.print(i);
    Serial.print("] = ");
    Serial.print(actual);

    if (actual == expected) {
      Serial.println("  [OK]");
    } else {
      Serial.print("  [FAIL] expected ");
      Serial.println(expected);
      errors++;
    }
  }

  Serial.println();
  if (errors == 0) {
    Serial.println("All tests PASSED!");
  } else {
    Serial.print(errors);
    Serial.println(" test(s) FAILED.");
  }
}

void loop() {
  // Nothing to do
  delay(1000);
}

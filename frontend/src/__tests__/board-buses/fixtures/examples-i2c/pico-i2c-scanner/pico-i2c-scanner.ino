// Raspberry Pi Pico — I2C Scanner
// Scans I2C bus (Wire / I2C0: SDA=GP4, SCL=GP5) for devices

#include <Wire.h>

void setup() {
  Serial.begin(115200);
  delay(500);
  Wire.begin(); // SDA=GP4, SCL=GP5 by default on Pico
  Serial.println("=== Pico I2C Scanner ===");
  Serial.println("Default I2C0: SDA=GP4, SCL=GP5");
  Serial.println();
}

void loop() {
  Serial.println("Scanning I2C bus...");
  int found = 0;

  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    byte error = Wire.endTransmission();

    if (error == 0) {
      found++;
      Serial.print("  Device found at 0x");
      if (addr < 16) Serial.print("0");
      Serial.print(addr, HEX);

      // Identify known addresses
      switch (addr) {
        case 0x48: Serial.print(" (Temperature sensor)"); break;
        case 0x50: Serial.print(" (EEPROM)"); break;
        case 0x68: Serial.print(" (DS1307/DS3231 RTC)"); break;
        case 0x27: Serial.print(" (LCD backpack)"); break;
        case 0x3C: Serial.print(" (SSD1306 OLED)"); break;
        default: break;
      }
      Serial.println();
    }
  }

  Serial.print("Scan complete. Found ");
  Serial.print(found);
  Serial.println(" device(s).");
  Serial.println();
  delay(5000);
}

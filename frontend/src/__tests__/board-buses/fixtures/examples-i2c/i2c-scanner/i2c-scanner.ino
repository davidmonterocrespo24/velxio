// I2C Bus Scanner — TWI Protocol Test
// Scans all 127 I2C addresses and reports which ones respond with ACK.
// Wired on the canvas (SDA = A4, SCL = A5):
//   0x3C = SSD1306 OLED
//   0x50 = 24C01 EEPROM
//   0x68 = DS1307 RTC

#include <Wire.h>

void setup() {
  Wire.begin();
  Serial.begin(9600);

  Serial.println("===========================");
  Serial.println("  I2C Bus Scanner (TWI)");
  Serial.println("===========================");
  Serial.println("Scanning...");
  Serial.println();

  int devicesFound = 0;

  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    byte error = Wire.endTransmission();

    if (error == 0) {
      Serial.print("  Device found at 0x");
      if (addr < 16) Serial.print("0");
      Serial.print(addr, HEX);

      // Identify known addresses
      switch (addr) {
        case 0x27: Serial.print("  (PCF8574 LCD backpack)"); break;
        case 0x3C: Serial.print("  (SSD1306 OLED)"); break;
        case 0x48: Serial.print("  (Temperature sensor)"); break;
        case 0x50: Serial.print("  (EEPROM)"); break;
        case 0x68: Serial.print("  (DS1307 RTC)"); break;
        case 0x76: Serial.print("  (BME280 sensor)"); break;
        case 0x77: Serial.print("  (BMP180/BMP280)"); break;
      }
      Serial.println();
      devicesFound++;
    }
  }

  Serial.println();
  Serial.print("Scan complete. ");
  Serial.print(devicesFound);
  Serial.println(" device(s) found.");

  if (devicesFound == 0) {
    Serial.println("No I2C devices found. Check connections.");
  }
}

void loop() {
  // Rescan every 10 seconds
  delay(10000);
  Serial.println("\nRescanning...");
  setup();
}

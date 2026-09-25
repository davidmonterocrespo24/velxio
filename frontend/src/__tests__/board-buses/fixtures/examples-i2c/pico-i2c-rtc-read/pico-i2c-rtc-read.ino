// Raspberry Pi Pico - I2C RTC Read
// Reads time from the DS3231 at address 0x68 (SDA = GP4, SCL = GP5).
// A DS3231 runs from the Pico's 3.3 V and keeps the DS1307 time registers.

#include <Wire.h>

byte bcdToDec(byte val) {
  return ((val >> 4) * 10) + (val & 0x0F);
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Wire.begin();
  Serial.println("=== Pico I2C RTC Read ===");
  Serial.println("Reading DS3231 at 0x68");
  Serial.println();
}

void loop() {
  // Set register pointer to 0
  Wire.beginTransmission(0x68);
  Wire.write(0x00);
  Wire.endTransmission();

  // Read 7 bytes: sec, min, hr, dow, date, month, year
  Wire.requestFrom(0x68, 7);
  if (Wire.available() >= 7) {
    byte sec   = bcdToDec(Wire.read() & 0x7F);
    byte min   = bcdToDec(Wire.read());
    byte hr    = bcdToDec(Wire.read() & 0x3F);
    byte dow   = bcdToDec(Wire.read());
    byte date  = bcdToDec(Wire.read());
    byte month = bcdToDec(Wire.read());
    byte year  = bcdToDec(Wire.read());

    const char* days[] = {"", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};

    Serial.print("Time: ");
    if (hr < 10) Serial.print('0'); Serial.print(hr); Serial.print(':');
    if (min < 10) Serial.print('0'); Serial.print(min); Serial.print(':');
    if (sec < 10) Serial.print('0'); Serial.print(sec);
    Serial.print("  Date: ");
    Serial.print(days[dow]); Serial.print(' ');
    if (date < 10) Serial.print('0'); Serial.print(date); Serial.print('/');
    if (month < 10) Serial.print('0'); Serial.print(month); Serial.print('/');
    Serial.print("20"); if (year < 10) Serial.print('0'); Serial.println(year);
  } else {
    Serial.println("RTC not responding!");
  }

  delay(1000);
}

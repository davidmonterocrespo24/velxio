// Time one BMP280 chip-id read over Wire (100 kHz default) and 64 SPI bytes at two clock rates.
#include <Wire.h>
#include <SPI.h>
volatile uint8_t sink;
void setup() {
  Serial.begin(115200);
  Wire.begin();
  SPI.begin();
}
void loop() {
  uint32_t t0 = micros();
  Wire.beginTransmission(0x76);
  Wire.write(0xD0);
  Wire.endTransmission(false);
  Wire.requestFrom(0x76, 1);
  uint8_t id = Wire.read();
  uint32_t t1 = micros();
  SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));
  uint32_t t2 = micros();
  for (uint8_t i = 0; i < 64; i++) sink = SPI.transfer(i);
  uint32_t t3 = micros();
  SPI.endTransaction();
  SPI.beginTransaction(SPISettings(125000, MSBFIRST, SPI_MODE0));
  uint32_t t4 = micros();
  for (uint8_t i = 0; i < 64; i++) sink = SPI.transfer(i);
  uint32_t t5 = micros();
  SPI.endTransaction();
  Serial.print("id=0x"); Serial.print(id, HEX);
  Serial.print(" i2c_us="); Serial.print(t1 - t0);
  Serial.print(" spi4M_64B_us="); Serial.print(t3 - t2);
  Serial.print(" spi125k_64B_us="); Serial.println(t5 - t4);
  delay(50);
}

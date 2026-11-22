// Raspberry Pi Pico: the transfers of avr-i2c-spi-bus-time on Wire (SDA = GP4,
// SCL = GP5) and SPI (SCK = GP18, MOSI = GP19, MISO = GP16), for the
// oscilloscope's drawing of hardware buses (velxio/velxio-prod#160): one
// register read of 0xD0 at 0x76 with a repeated START, four SPI bytes in mode
// 0 at 1 MHz and one in mode 3 at 500 kHz.
//
// Serial protocol (115200): "id=0x<id>" after each round, every 50 ms.
//
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn rp2040:rp2040:rpipico --board-kind raspberry-pi-pico \
//   --out <this dir> <this dir>/rp2040-i2c-spi-scope.ino
#include <Wire.h>
#include <SPI.h>
volatile uint8_t sink;
void setup() {
  Serial.begin(115200);
  Wire.begin();
  SPI.begin();
}
void loop() {
  Wire.beginTransmission(0x76);
  Wire.write(0xD0);
  Wire.endTransmission(false);
  Wire.requestFrom(0x76, 1);
  uint8_t id = Wire.read();
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  for (uint8_t i = 0; i < 4; i++) sink = SPI.transfer(0xA0 + i);
  SPI.endTransaction();
  SPI.beginTransaction(SPISettings(500000, MSBFIRST, SPI_MODE3));
  sink = SPI.transfer(0x81);
  SPI.endTransaction();
  Serial.print("id=0x");
  Serial.println(id, HEX);
  delay(50);
}

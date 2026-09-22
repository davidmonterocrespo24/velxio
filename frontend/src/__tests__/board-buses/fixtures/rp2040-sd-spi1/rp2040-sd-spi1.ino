// Raspberry Pi Pico, microSD card on SPI1 (the controller's default pins):
// GP12 MISO, GP10 SCK, GP11 MOSI, CS on GP13. SD SPI-mode init by hand,
// the same raw driver as rp2040-spi0-bus (see there for why not SD.begin()).
#include <SPI.h>

const int SD_CS = 13;

static uint8_t x(uint8_t b) { return SPI1.transfer(b); }

static uint8_t sdCmd(uint8_t cmd, uint32_t arg, uint8_t crc) {
  x(0xFF);
  x(0x40 | cmd);
  x(arg >> 24); x(arg >> 16); x(arg >> 8); x(arg);
  x(crc);
  uint8_t r = 0xFF;
  for (int i = 0; i < 10; i++) {
    r = x(0xFF);
    if (!(r & 0x80)) break;
  }
  return r;
}

void setup() {
  Serial.begin(115200);
  Serial.println("READY");
  pinMode(SD_CS, OUTPUT);
  digitalWrite(SD_CS, HIGH);
  SPI1.setRX(12);
  SPI1.setSCK(10);
  SPI1.setTX(11);
  SPI1.begin();
  SPI1.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  for (int i = 0; i < 10; i++) x(0xFF);
  digitalWrite(SD_CS, LOW);
  uint8_t r = sdCmd(0, 0, 0x95);
  Serial.print("SD:CMD0:");
  Serial.println(r, HEX);
  r = sdCmd(8, 0x1AA, 0x87);
  uint8_t r7[4];
  for (int i = 0; i < 4; i++) r7[i] = x(0xFF);
  Serial.print("SD:CMD8:");
  Serial.print(r, HEX);
  Serial.print(":");
  Serial.println(r7[3], HEX);
  digitalWrite(SD_CS, HIGH);
  x(0xFF);
  SPI1.endTransaction();
  Serial.println("DONE");
}

void loop() {}

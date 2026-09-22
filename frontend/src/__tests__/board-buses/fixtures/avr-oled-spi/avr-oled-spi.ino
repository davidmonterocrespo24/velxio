// Uno + SSD1306 in 4-wire SPI mode (DC D9, RST D8, SCK D13, MOSI D11).
//
// Chip select is deselected (HIGH) at init, as Adafruit_SSD1306 and U8g2 do,
// then held LOW for the whole run: D10 falls once in setup() and never moves
// again. Wired panel CS -> D10 that is a real select; wired panel CS -> GND
// the pin drives nothing and the panel is selected by its wiring.
//
// Every frame re-sends the addressing commands (horizontal mode, full column
// and page window) with DC low, then 1024 data bytes with DC high, all of one
// value: frame n is filled with framePattern(n).
//
// Serial protocol (115200): READY after init, then F:<n> after each frame
// (flushed before the next frame starts, so F:<n> means frame n is on the
// panel and frame n+1 has not begun).
//
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn arduino:avr:uno --out <this dir> <this dir>/avr-oled-spi.ino
#include <SPI.h>

#define OLED_CS 10
#define OLED_DC 9
#define OLED_RST 8

static void cmd(uint8_t c) {
  digitalWrite(OLED_DC, LOW);
  SPI.transfer(c);
}

static uint8_t framePattern(uint8_t n) { return (uint8_t)(0x11 * ((n % 15) + 1)); }

static const uint8_t INIT[] PROGMEM = {
  0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40, 0x8D, 0x14,
  0xA1, 0xC8, 0xDA, 0x12, 0x81, 0xCF, 0xD9, 0xF1, 0xDB, 0x40,
  0xA4, 0xA6, 0xAF,
};

void setup() {
  Serial.begin(115200);
  SPI.begin();
  pinMode(OLED_CS, OUTPUT);
  digitalWrite(OLED_CS, HIGH);
  delayMicroseconds(10);
  digitalWrite(OLED_CS, LOW);
  pinMode(OLED_DC, OUTPUT);
  pinMode(OLED_RST, OUTPUT);
  digitalWrite(OLED_RST, LOW);
  delayMicroseconds(10);
  digitalWrite(OLED_RST, HIGH);
  SPI.beginTransaction(SPISettings(8000000, MSBFIRST, SPI_MODE0));
  for (uint8_t i = 0; i < sizeof(INIT); i++) cmd(pgm_read_byte(&INIT[i]));
  Serial.println(F("READY"));
  Serial.flush();
}

uint8_t frame = 0;

void loop() {
  frame++;
  const uint8_t v = framePattern(frame);
  cmd(0x20); cmd(0x00);
  cmd(0x21); cmd(0); cmd(127);
  cmd(0x22); cmd(0); cmd(7);
  digitalWrite(OLED_DC, HIGH);
  for (int i = 0; i < 1024; i++) SPI.transfer(v);
  Serial.print(F("F:"));
  Serial.println(frame);
  Serial.flush();
}

// Uno + 1.54" SSD1681 e-paper (200x200 B/W): CS D10, DC D9, RST D8,
// SCK D13, SDI D11.
//
// Driven the way GxEPD2 drives it: CS deselected (HIGH) at init, then every
// command and every data burst framed by CS low ... CS high. With the panel's
// CS tied to GND instead of D10, D10 drives nothing and the panel is selected
// by its wiring for the whole run. BUSY is not polled: the sketch paces
// itself, which keeps the test independent of the panel's wall-clock
// refresh timer.
//
// Refresh n fills the whole RAM window with framePattern(n) and triggers a
// full update (0x22 0xF7, 0x20).
//
// Serial protocol (115200): READY after the reset pulse, then R:<n> after
// each refresh (flushed before the next one starts).
//
// Rebuild: node project/board-buses-2026-09/harness/compile-fixture.mjs \
//   --fqbn arduino:avr:uno --out <this dir> <this dir>/avr-epaper.ino
#include <SPI.h>

#define EPD_CS 10
#define EPD_DC 9
#define EPD_RST 8

static void cmd(uint8_t c) {
  digitalWrite(EPD_CS, LOW);
  digitalWrite(EPD_DC, LOW);
  SPI.transfer(c);
  digitalWrite(EPD_DC, HIGH);
  digitalWrite(EPD_CS, HIGH);
}

static void data(uint8_t d) {
  digitalWrite(EPD_CS, LOW);
  SPI.transfer(d);
  digitalWrite(EPD_CS, HIGH);
}

static uint8_t framePattern(uint8_t n) { return (n & 1) ? 0x0F : 0xF0; }

void setup() {
  Serial.begin(115200);
  digitalWrite(EPD_CS, HIGH);
  pinMode(EPD_CS, OUTPUT);
  pinMode(EPD_DC, OUTPUT);
  pinMode(EPD_RST, OUTPUT);
  digitalWrite(EPD_RST, HIGH);
  delayMicroseconds(10);
  digitalWrite(EPD_RST, LOW);
  delayMicroseconds(10);
  digitalWrite(EPD_RST, HIGH);
  SPI.begin();
  SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));
  Serial.println(F("READY"));
  Serial.flush();
}

uint8_t refresh = 0;

void loop() {
  refresh++;
  cmd(0x12);                                   // SW reset
  cmd(0x11); data(0x03);                       // X+, Y+
  cmd(0x44); data(0x00); data(0x18);           // RAM X 0..24 (bytes)
  cmd(0x45); data(0x00); data(0x00); data(0xC7); data(0x00);  // RAM Y 0..199
  cmd(0x4E); data(0x00);
  cmd(0x4F); data(0x00); data(0x00);
  cmd(0x24);
  const uint8_t v = framePattern(refresh);
  digitalWrite(EPD_CS, LOW);                   // one burst, as _writeDataPGM does
  for (uint16_t i = 0; i < 25u * 200u; i++) SPI.transfer(v);
  digitalWrite(EPD_CS, HIGH);
  cmd(0x22); data(0xF7);
  cmd(0x20);
  Serial.print(F("R:"));
  Serial.println(refresh);
  Serial.flush();
}

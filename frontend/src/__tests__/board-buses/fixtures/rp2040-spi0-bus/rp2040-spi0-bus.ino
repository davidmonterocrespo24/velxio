// Raspberry Pi Pico, four SPI0 devices on one bus (GP18 SCK, GP19 MOSI,
// GP16 MISO), each with its own chip select. A test wires only the parts it
// needs; a step whose device is absent just clocks into nothing.
//
//   BURST   CS GP13   64 bytes through SPI.transfer(buf, n); byte i = (i*7)^0x5A
//   e-paper CS GP20, DC GP21, RST GP22, BUSY GP26 (1.54" SSD1681, 200x200):
//           one full frame, top half black, bottom half white
//   chip    CS GP14   custom chip fixtures/rp2040-chips/spi-id.c, 0x9F -> 0xA5
//   microSD CS GP17   SD SPI-mode init, then hello.txt read through the FAT16
//                     boot sector, all by hand (see sdInit / sdReadHello)
//
// The SD card is driven with raw commands, not the core's SD library: that
// library (SdFat) discards the first byte after a command, and the microSD
// part answers R1 on exactly that byte, so SD.begin() never mounts it. The
// raw driver reads R1 from the first byte on, as the SD spec allows.
//
// The compile service prepends "#define Serial Serial1", so Serial is UART0.
#include <SPI.h>

const int BURST_CS = 13, CHIP_CS = 14, SD_CS = 17;
const int EPD_CS = 20, EPD_DC = 21, EPD_RST = 22, EPD_BUSY = 26;

static uint8_t x(uint8_t b) { return SPI.transfer(b); }

// ── Burst ──────────────────────────────────────────────────────────────────
static void burst() {
  uint8_t buf[64];
  for (int i = 0; i < 64; i++) buf[i] = (uint8_t)((i * 7) ^ 0x5A);
  SPI.beginTransaction(SPISettings(8000000, MSBFIRST, SPI_MODE0));
  digitalWrite(BURST_CS, LOW);
  SPI.transfer(buf, 64);
  digitalWrite(BURST_CS, HIGH);
  SPI.endTransaction();
  int idle = 0;
  for (int i = 0; i < 64; i++) if (buf[i] == 0xFF) idle++;
  Serial.print("BURST:IDLE:");
  Serial.println(idle);
}

// ── e-paper ────────────────────────────────────────────────────────────────
static void epdCmd(uint8_t c) {
  digitalWrite(EPD_DC, LOW);
  digitalWrite(EPD_CS, LOW);
  x(c);
  digitalWrite(EPD_CS, HIGH);
}
static void epdData(uint8_t d) {
  digitalWrite(EPD_DC, HIGH);
  digitalWrite(EPD_CS, LOW);
  x(d);
  digitalWrite(EPD_CS, HIGH);
}
static void epdWaitIdle() {
  unsigned long t0 = millis();
  while (digitalRead(EPD_BUSY) == HIGH && millis() - t0 < 100) {}
}
static void epaper() {
  digitalWrite(EPD_RST, LOW);
  delay(1);
  digitalWrite(EPD_RST, HIGH);
  SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));
  epdCmd(0x12);  // SW reset
  epdWaitIdle();
  epdCmd(0x11); epdData(0x03);                  // X+, Y+
  epdCmd(0x44); epdData(0x00); epdData(0x18);   // X bytes 0..24
  epdCmd(0x45); epdData(0x00); epdData(0x00); epdData(0xC7); epdData(0x00);  // Y 0..199
  epdCmd(0x4E); epdData(0x00);
  epdCmd(0x4F); epdData(0x00); epdData(0x00);
  epdCmd(0x24);
  digitalWrite(EPD_DC, HIGH);
  digitalWrite(EPD_CS, LOW);
  for (int i = 0; i < 25 * 200; i++) x(i < 25 * 100 ? 0x00 : 0xFF);
  digitalWrite(EPD_CS, HIGH);
  epdCmd(0x22); epdData(0xF7);
  epdCmd(0x20);  // master activation: the panel refreshes
  epdWaitIdle();
  SPI.endTransaction();
  Serial.println("EPD:SENT");
}

// ── custom chip ────────────────────────────────────────────────────────────
static uint8_t chipId() {
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  digitalWrite(CHIP_CS, LOW);
  x(0x9F);
  uint8_t id = x(0x00);
  digitalWrite(CHIP_CS, HIGH);
  SPI.endTransaction();
  return id;
}

// ── microSD, raw SPI mode ──────────────────────────────────────────────────
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
static bool sdReadBlock(uint32_t block, uint8_t *dst) {
  if (sdCmd(17, block * 512, 0x01) != 0x00) return false;
  for (int i = 0; i < 1000; i++) {
    uint8_t t = x(0xFF);
    if (t == 0xFE) {
      for (int k = 0; k < 512; k++) dst[k] = x(0xFF);
      x(0xFF); x(0xFF);  // CRC
      return true;
    }
  }
  return false;
}
static bool sdInit() {
  digitalWrite(SD_CS, HIGH);
  for (int i = 0; i < 10; i++) x(0xFF);
  digitalWrite(SD_CS, LOW);
  uint8_t r = sdCmd(0, 0, 0x95);
  Serial.print("SD:CMD0:");
  Serial.println(r, HEX);
  if (r != 0x01) return false;
  r = sdCmd(8, 0x1AA, 0x87);
  uint8_t r7[4];
  for (int i = 0; i < 4; i++) r7[i] = x(0xFF);
  if (r != 0x01 || r7[3] != 0xAA) return false;
  for (int i = 0; i < 100; i++) {
    sdCmd(55, 0, 0x01);
    r = sdCmd(41, 0x40000000, 0x01);
    if (r == 0x00) break;
  }
  if (r != 0x00) return false;
  r = sdCmd(58, 0, 0x01);
  for (int i = 0; i < 4; i++) x(0xFF);
  return r == 0x00;
}
static void sdReadHello() {
  static uint8_t b[512];
  if (!sdReadBlock(0, b) || b[510] != 0x55 || b[511] != 0xAA) {
    Serial.println("SD:NOBOOT");
    return;
  }
  // First data sector of a FAT16 volume: reserved + FATs + root directory.
  uint16_t reserved = b[14] | (b[15] << 8);
  uint8_t fats = b[16];
  uint16_t rootEntries = b[17] | (b[18] << 8);
  uint16_t fatSectors = b[22] | (b[23] << 8);
  uint32_t data = reserved + (uint32_t)fats * fatSectors + (rootEntries * 32u + 511u) / 512u;
  if (!sdReadBlock(data, b)) {
    Serial.println("SD:NODATA");
    return;
  }
  Serial.print("READ:");
  for (int i = 0; i < 32 && b[i]; i++) Serial.write(b[i]);
  Serial.println();
}

void setup() {
  Serial.begin(115200);
  Serial.println("READY");
  const int outs[] = {BURST_CS, CHIP_CS, SD_CS, EPD_CS, EPD_DC, EPD_RST};
  for (int p : outs) {
    pinMode(p, OUTPUT);
    digitalWrite(p, HIGH);
  }
  pinMode(EPD_BUSY, INPUT);
  SPI.begin();

  burst();
  epaper();
  Serial.print("CHIP1:");
  Serial.println(chipId(), HEX);

  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  bool ok = sdInit();
  Serial.println(ok ? "SD:OK" : "SD:FAIL");
  if (ok) sdReadHello();
  digitalWrite(SD_CS, HIGH);
  x(0xFF);
  SPI.endTransaction();

  Serial.print("CHIP2:");
  Serial.println(chipId(), HEX);
  Serial.println("DONE");
}

void loop() {}

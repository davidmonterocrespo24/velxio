/*
 * conf-rp2040-console: the guest of the RP2040 SPI controller-port conformance
 * suite (project board-buses-2026-09, TESTS.md layer 2; the test that drives it
 * is port-conformance-rp2040.test.ts).
 *
 * Built for the Raspberry Pi Pico (rp2040:rp2040:rpipico). The compile service
 * prepends "#define Serial Serial1", so the console is UART0 (GP0/GP1). The rig
 * types one command per line; the sketch answers with one line that starts
 * with '='. Pins and units are decimal, data is hex. U is the controller: 0 =
 * SPI (SPI0), 1 = SPI1.
 *
 *   p U MISO SCK MOSI CS HW
 *                   move controller U to these pins: end(), setRX/setSCK/setTX
 *                   (and setCS), begin(HW). HW = 1 hands CS to the controller
 *                   (its CSn function), HW = 0 leaves CS a GPIO.
 *   m U MODE ORDER HZ
 *                   SPI mode 0-3, bit order (1 = MSB first, 0 = LSB first) and
 *                   clock for the next transactions on U
 *   t U CS HH ..    one transaction, byte by byte: CS low, SPI.transfer() of
 *                   each byte, CS high; answer the bytes read back
 *   T U CS HH ..    the same through SPI.transfer(tx, rx, n), which keeps the
 *                   TX FIFO fed (pico-sdk spi_write_read_blocking); the
 *                   one-buffer transfer(buf, n) is a loop of transfer(b)
 *   w U CS HHHH ..  the same with transfer16() (16-bit frames)
 *   n U HH ..       no GPIO chip select at all (hardware CS, or none): the
 *                   FIFO-fed transfer of T; answer the bytes read back
 *
 * CS = -1 means the sketch drives no chip select. A GPIO chip select is driven
 * the way every CS driver does it: the latch goes high before the pad becomes
 * an output, so the line is never low until the transaction pulls it low.
 * READY is printed once per boot, after both controllers are up on their
 * default pins, so the rig can tell a fresh boot from a sketch that kept
 * running.
 *
 * Rebuild (production toolchain):
 *   node project/board-buses-2026-09/harness/compile-fixture.mjs --fqbn rp2040:rp2040:rpipico \
 *     --out <this dir> <this dir>/conf-rp2040-console.ino
 */
#include <SPI.h>

static char line[400];
static uint16_t len = 0;
static uint8_t buf[128];

struct Cfg {
  uint8_t mode;
  bool msbFirst;
  uint32_t hz;
};
static Cfg cfg[2] = {{0, true, 4000000}, {0, true, 4000000}};

static SPIClassRP2040 &bus(int u) { return u ? SPI1 : SPI; }

static void put2(uint8_t v) {
  if (v < 0x10) Serial.print('0');
  Serial.print(v, HEX);
}

static long num(char **p, int base) { return strtol(*p, p, base); }

static SPISettings settings(int u) {
  const BitOrder order = cfg[u].msbFirst ? MSBFIRST : LSBFIRST;
  switch (cfg[u].mode) {
    case 1: return SPISettings(cfg[u].hz, order, SPI_MODE1);
    case 2: return SPISettings(cfg[u].hz, order, SPI_MODE2);
    case 3: return SPISettings(cfg[u].hz, order, SPI_MODE3);
    default: return SPISettings(cfg[u].hz, order, SPI_MODE0);
  }
}

static void csIdle(int cs) {
  if (cs < 0) return;
  digitalWrite(cs, HIGH);
  pinMode(cs, OUTPUT);
}

/* Parse hex bytes into buf; returns how many. */
static int bytes(char *p) {
  int n = 0;
  for (;;) {
    char *e;
    long b = strtol(p, &e, 16);
    if (e == p || n >= (int)sizeof(buf)) break;
    p = e;
    buf[n++] = (uint8_t)b;
  }
  return n;
}

static void exec(char *s) {
  char cmd = s[0];
  char *p = s + 1;
  Serial.print('=');
  switch (cmd) {
    case 'p': {
      int u = num(&p, 10) & 1;
      int rx = num(&p, 10), sck = num(&p, 10), tx = num(&p, 10), cs = num(&p, 10);
      bool hw = num(&p, 10) != 0;
      SPIClassRP2040 &s = bus(u);
      s.end();
      s.setRX(rx);
      s.setSCK(sck);
      s.setTX(tx);
      if (hw) s.setCS(cs);
      s.begin(hw);
      Serial.print("OK");
      break;
    }
    case 'm': {
      int u = num(&p, 10) & 1;
      cfg[u].mode = (uint8_t)(num(&p, 10) & 3);
      cfg[u].msbFirst = num(&p, 10) != 0;
      cfg[u].hz = (uint32_t)num(&p, 10);
      Serial.print("OK");
      break;
    }
    case 't':
    case 'T': {
      int u = num(&p, 10) & 1;
      int cs = num(&p, 10);
      int n = bytes(p);
      SPIClassRP2040 &s = bus(u);
      csIdle(cs);
      s.beginTransaction(settings(u));
      if (cs >= 0) digitalWrite(cs, LOW);
      if (cmd == 'T') {
        s.transfer(buf, buf, n);
      } else {
        for (int i = 0; i < n; i++) buf[i] = s.transfer(buf[i]);
      }
      if (cs >= 0) digitalWrite(cs, HIGH);
      s.endTransaction();
      for (int i = 0; i < n; i++) {
        put2(buf[i]);
        Serial.print(' ');
      }
      break;
    }
    case 'w': {
      int u = num(&p, 10) & 1;
      int cs = num(&p, 10);
      SPIClassRP2040 &s = bus(u);
      csIdle(cs);
      s.beginTransaction(settings(u));
      if (cs >= 0) digitalWrite(cs, LOW);
      for (;;) {
        char *e;
        long v = strtol(p, &e, 16);
        if (e == p) break;
        p = e;
        uint16_t r = s.transfer16((uint16_t)v);
        put2(r >> 8);
        put2(r & 0xff);
        Serial.print(' ');
      }
      if (cs >= 0) digitalWrite(cs, HIGH);
      s.endTransaction();
      break;
    }
    case 'n': {
      int u = num(&p, 10) & 1;
      int n = bytes(p);
      SPIClassRP2040 &s = bus(u);
      s.beginTransaction(settings(u));
      s.transfer(buf, buf, n);
      s.endTransaction();
      for (int i = 0; i < n; i++) {
        put2(buf[i]);
        Serial.print(' ');
      }
      break;
    }
    default:
      Serial.print('?');
      break;
  }
  Serial.println();
}

void setup() {
  Serial.begin(115200);
  SPI.begin();
  SPI1.begin();
  Serial.println("READY");
}

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      line[len] = 0;
      if (len) exec(line);
      len = 0;
    } else if (len < sizeof(line) - 1) {
      line[len++] = c;
    }
  }
}

/*
 * conf-avr-spi: the guest of the AVR SPI controller-port conformance suite
 * (project board-buses-2026-09, TESTS.md layer 2; the test that drives it is
 * port-conformance-avr.test.ts).
 *
 * The same sketch is built for the Uno (arduino:avr:uno) and the Mega
 * (arduino:avr:mega). The rig types one command per line; the sketch answers
 * with one line that starts with '='. Pins are decimal, bytes are hex.
 *
 *   x CS HH [HH ..]   one transaction: CS low, SPI.transfer() of each byte,
 *                     CS high; answer the bytes read back (MISO)
 *   m MODE ORDER HZ   SPI mode 0-3, bit order (1 = MSB first, 0 = LSB first)
 *                     and clock for the next transactions
 *   r P               pinMode(P, INPUT), answer digitalRead(P): what a device
 *                     driving that line puts on it
 *
 * The chip select is driven the way every CS driver does it: the latch goes
 * high before the pad becomes an output, so the line is never low until the
 * transaction pulls it low. READY is printed once per boot, after SPI.begin(),
 * so the rig can tell a fresh boot from a sketch that kept running.
 *
 * Rebuild (production toolchain):
 *   node project/board-buses-2026-09/harness/compile-fixture.mjs --fqbn arduino:avr:uno \
 *     --out <this dir>/uno <this dir>/conf-avr-spi.ino
 *   node project/board-buses-2026-09/harness/compile-fixture.mjs --fqbn arduino:avr:mega \
 *     --out <this dir>/mega <this dir>/conf-avr-spi.ino
 */
#include <SPI.h>

static char line[272];
static uint16_t len = 0;
static uint8_t miso[88];

static uint8_t spiMode = 0;
static bool msbFirst = true;
static uint32_t spiHz = 4000000;

static void put2(uint8_t v) {
  if (v < 0x10) Serial.print('0');
  Serial.print(v, HEX);
}

static long num(char** p, int base) {
  return strtol(*p, p, base);
}

static void beginSpi() {
  const uint8_t order = msbFirst ? MSBFIRST : LSBFIRST;
  switch (spiMode) {
    case 1: SPI.beginTransaction(SPISettings(spiHz, order, SPI_MODE1)); break;
    case 2: SPI.beginTransaction(SPISettings(spiHz, order, SPI_MODE2)); break;
    case 3: SPI.beginTransaction(SPISettings(spiHz, order, SPI_MODE3)); break;
    default: SPI.beginTransaction(SPISettings(spiHz, order, SPI_MODE0)); break;
  }
}

static void exec(char* s) {
  char cmd = s[0];
  char* p = s + 1;
  Serial.print('=');
  switch (cmd) {
    case 'x': {
      int cs = num(&p, 10);
      digitalWrite(cs, HIGH);
      pinMode(cs, OUTPUT);
      beginSpi();
      digitalWrite(cs, LOW);
      uint8_t n = 0;
      for (;;) {
        char* e;
        long b = strtol(p, &e, 16);
        if (e == p || n >= sizeof(miso)) break;
        p = e;
        miso[n++] = SPI.transfer((uint8_t)b);
      }
      digitalWrite(cs, HIGH);
      SPI.endTransaction();
      for (uint8_t i = 0; i < n; i++) {
        put2(miso[i]);
        Serial.print(' ');
      }
      break;
    }
    case 'r': {
      int pin = num(&p, 10);
      pinMode(pin, INPUT);
      Serial.print(digitalRead(pin));
      break;
    }
    case 'm': {
      spiMode = (uint8_t)(num(&p, 10) & 3);
      msbFirst = num(&p, 10) != 0;
      spiHz = (uint32_t)num(&p, 10);
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

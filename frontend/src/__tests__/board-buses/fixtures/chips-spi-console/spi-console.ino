/*
 * spi-console: a serial-driven SPI master for the board-buses chips-spi tests.
 *
 * The same sketch is built for the Uno (arduino:avr:uno) and the Pico
 * (rp2040:rp2040:rpipico; the compile service maps Serial to Serial1 = UART0).
 * The test types one command per line and the sketch answers with one line
 * that starts with '='. Pins are decimal, bytes are hex.
 *
 *   l P            pinMode(P, OUTPUT), digitalWrite(P, LOW)
 *   h P            pinMode(P, OUTPUT), digitalWrite(P, HIGH)
 *   r P            pinMode(P, INPUT), answer digitalRead(P)
 *   q P0 .. P7     read eight pins as INPUT, answer the byte (bit i = Pi)
 *   t HH [HH ..]   hardware SPI.transfer of each byte inside one transaction,
 *                  answer the MISO bytes
 *   m MODE ORDER   SPI mode 0-3 and bit order (1 = MSB first, 0 = LSB first)
 *                  for the next transactions
 *   s DATA CLK HH  shiftOut(DATA, CLK, MSBFIRST, HH)
 *   b SCK MOSI MISO HH
 *                  software SPI, mode 0, MSB first: answer the byte read on MISO
 *   a P V          analogWrite(P, V)
 *
 * Rebuild (production toolchain):
 *   node project/board-buses-2026-09/harness/compile-fixture.mjs --fqbn arduino:avr:uno \
 *     --out <this dir>/uno <this dir>/spi-console.ino
 *   node project/board-buses-2026-09/harness/compile-fixture.mjs --fqbn rp2040:rp2040:rpipico \
 *     --out <this dir>/pico <this dir>/spi-console.ino
 */
#include <SPI.h>

static char line[96];
static uint8_t len = 0;
static uint8_t spiMode = 0;
static bool msbFirst = true;

static void put2(uint8_t v) {
  if (v < 0x10) Serial.print('0');
  Serial.print(v, HEX);
}

static long num(char** p, int base) {
  return strtol(*p, p, base);
}

/* The bit order type differs between cores (an int on AVR, an enum on the
 * Pico), so the ternary is spelled out where it is used. */
#define ORDER (msbFirst ? MSBFIRST : LSBFIRST)

static void beginSpi() {
  switch (spiMode) {
    case 1: SPI.beginTransaction(SPISettings(1000000, ORDER, SPI_MODE1)); break;
    case 2: SPI.beginTransaction(SPISettings(1000000, ORDER, SPI_MODE2)); break;
    case 3: SPI.beginTransaction(SPISettings(1000000, ORDER, SPI_MODE3)); break;
    default: SPI.beginTransaction(SPISettings(1000000, ORDER, SPI_MODE0)); break;
  }
}

static void exec(char* s) {
  char cmd = s[0];
  char* p = s + 1;
  Serial.print('=');
  switch (cmd) {
    case 'l': {
      int pin = num(&p, 10);
      pinMode(pin, OUTPUT);
      digitalWrite(pin, LOW);
      break;
    }
    case 'h': {
      int pin = num(&p, 10);
      pinMode(pin, OUTPUT);
      digitalWrite(pin, HIGH);
      break;
    }
    case 'r': {
      int pin = num(&p, 10);
      pinMode(pin, INPUT);
      Serial.print(digitalRead(pin));
      break;
    }
    case 'q': {
      uint8_t v = 0;
      for (int i = 0; i < 8; i++) {
        int pin = num(&p, 10);
        pinMode(pin, INPUT);
        if (digitalRead(pin)) v |= (uint8_t)(1 << i);
      }
      put2(v);
      break;
    }
    case 't': {
      beginSpi();
      for (;;) {
        char* e;
        long b = strtol(p, &e, 16);
        if (e == p) break;
        p = e;
        put2(SPI.transfer((uint8_t)b));
        Serial.print(' ');
      }
      SPI.endTransaction();
      break;
    }
    case 'm': {
      spiMode = (uint8_t)(num(&p, 10) & 3);
      msbFirst = num(&p, 10) != 0;
      break;
    }
    case 's': {
      int d = num(&p, 10);
      int c = num(&p, 10);
      long b = num(&p, 16);
      pinMode(d, OUTPUT);
      pinMode(c, OUTPUT);
      shiftOut(d, c, MSBFIRST, (uint8_t)b);
      break;
    }
    case 'b': {
      int sck = num(&p, 10);
      int mosi = num(&p, 10);
      int miso = num(&p, 10);
      long b = num(&p, 16);
      pinMode(sck, OUTPUT);
      pinMode(mosi, OUTPUT);
      pinMode(miso, INPUT);
      digitalWrite(sck, LOW);
      uint8_t in = 0;
      for (int i = 7; i >= 0; i--) {
        digitalWrite(mosi, (b >> i) & 1);
        digitalWrite(sck, HIGH);
        in = (uint8_t)((in << 1) | (digitalRead(miso) ? 1 : 0));
        digitalWrite(sck, LOW);
      }
      put2(in);
      break;
    }
    case 'a': {
      int pin = num(&p, 10);
      long v = num(&p, 10);
      analogWrite(pin, (int)v);
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

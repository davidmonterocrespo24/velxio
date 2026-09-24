/*
 * conf-i2c-console: the guest of the I2C controller-port conformance suite
 * (project board-buses-2026-09, F5, TESTS.md layer 2; the tests that drive it
 * are port-conformance-avr-i2c.test.ts, port-conformance-rp2040-i2c.test.ts
 * and the RP2350's port-conformance-rp2350-i2c.test.ts).
 *
 * One sketch, built for the Uno and the Mega (the TWI, through Wire) and for
 * the Pico and the Pico 2 (I2C0 and I2C1). The rig types one command per line;
 * the sketch answers with one line that starts with '='. Units and pins are
 * decimal, addresses and data hex. U is the controller: 0 = I2C0 (Wire),
 * 1 = I2C1 (Wire1, RP only).
 *
 *   x U AA N [HH ..]  one Wire exchange with address AA: write the bytes (if
 *                     any), then read N (if N > 0). A write followed by a read
 *                     keeps the bus (endTransmission(false)) and reads after a
 *                     repeated START; everything else ends with STOP. Answers
 *                     "=S [HH ..]": S is endTransmission's code (0 success,
 *                     2 address NACK, 3 data NACK, 5 timeout), or for a read
 *                     alone 0 when the bytes came and 2 when the address was
 *                     NACKed; then the bytes read.
 *   z U AA            a zero-length write (Wire's address probe, the one
 *                     i2c scanners and Adafruit_I2CDevice::begin() make).
 *                     Answers "=S" with endTransmission's code.
 *   p U SDA SCL       RP only: move controller U to these pins: end(),
 *                     setSDA/setSCL, begin(). Answers "=OK".
 *   R                 RP only: answer OK, then reboot through the watchdog at
 *                     once, watchdog_reboot(0, 0, 0), the call MicroPython's
 *                     machine.reset() makes (the RP2350's warm reboot).
 *
 * On the RP2040 family Wire reports every failed write as 4, so the exchange
 * goes through pico-sdk's i2c_write_blocking_until / i2c_read_blocking_until,
 * the calls Wire.endTransmission and Wire.requestFrom make, and the codes are
 * read from what they return (PICO_ERROR_GENERIC for an address NACK, the
 * count of bytes sent before a data NACK). A zero-length write is Wire's own:
 * arduino-pico bit-bangs it on the pins (_probe), which is the software-I2C
 * path, not the controller's.
 *
 * READY is printed once per boot, after the controllers are up on their
 * default pins, so the rig can tell a fresh boot from a sketch that kept
 * running.
 *
 * Rebuild (production toolchain), from the repo root:
 *   H=project/board-buses-2026-09/harness/compile-fixture.mjs
 *   D=velxio/frontend/src/__tests__/board-buses/fixtures/conf-i2c-console
 *   node $H --fqbn arduino:avr:uno --out $D/uno $D/conf-i2c-console.ino
 *   node $H --fqbn arduino:avr:mega --out $D/mega $D/conf-i2c-console.ino
 *   node $H --fqbn rp2040:rp2040:rpipico --out $D/pico $D/conf-i2c-console.ino
 *   P=pro/frontend/src/pro/boards/rp2350/__tests__/fixtures
 *   node $H --fqbn rp2040:rp2040:rpipico2:arch=riscv --board-kind badger-2350 \
 *     --out $P/conf-rp2350-i2c $D/conf-i2c-console.ino
 *   node $H --fqbn rp2040:rp2040:rpipico2:arch=arm --board-kind badger-2350 \
 *     --out $P/conf-rp2350-i2c-arm $D/conf-i2c-console.ino
 *   node $H --fqbn rp2040:rp2040:pimoroni_pico_plus_2w:arch=riscv \
 *     --board-kind pimoroni-pico-plus-2w --out $P/conf-rp2350b-i2c $D/conf-i2c-console.ino
 * (a copy of this .ino sits in $P/conf-rp2350-i2c so the pro fixtures rebuild
 * on their own). Keep the .bin / .hex and compile.log; drop the .uf2.
 */
#include <Wire.h>

#if defined(ARDUINO_ARCH_RP2040)
#include <hardware/i2c.h>
#include <hardware/watchdog.h>
#define RP_FAMILY 1
#endif

static char line[400];
static uint16_t len = 0;
static uint8_t tx[64];
static uint8_t rx[64];

static void put2(uint8_t v) {
  if (v < 0x10) Serial.print('0');
  Serial.print(v, HEX);
}

static long num(char **p, int base) { return strtol(*p, p, base); }

#ifdef RP_FAMILY
static TwoWire &bus(int u) { return u ? Wire1 : Wire; }
// On the Pico and the Pico 2 Wire is I2C0 and Wire1 is I2C1.
static i2c_inst_t *hw(int u) { return u ? i2c1 : i2c0; }

static int writeTo(int u, uint8_t a, uint8_t n, bool stop) {
  int r = i2c_write_blocking_until(hw(u), a, tx, n, !stop, make_timeout_time_ms(50));
  if (r == PICO_ERROR_TIMEOUT) return 5;
  if (r < 0) return 2;
  return r == n ? 0 : 3;
}

static int readFrom(int u, uint8_t a, uint8_t n) {
  int r = i2c_read_blocking_until(hw(u), a, rx, n, false, make_timeout_time_ms(50));
  if (r == PICO_ERROR_TIMEOUT) return -5;
  if (r < 0) return -2;
  return r;
}
#else
static TwoWire &bus(int) { return Wire; }

static int writeTo(int, uint8_t a, uint8_t n, bool stop) {
  Wire.beginTransmission(a);
  Wire.write(tx, n);
  return Wire.endTransmission(stop);
}

static int readFrom(int, uint8_t a, uint8_t n) {
  uint8_t got = Wire.requestFrom(a, n);
  if (got == 0) return -2;
  for (uint8_t i = 0; i < got; i++) rx[i] = Wire.read();
  return got;
}
#endif

static void exec(char *s) {
  char cmd = s[0];
  char *p = s + 1;
  Serial.print('=');
  switch (cmd) {
    case 'x': {
      int u = num(&p, 10);
      uint8_t a = num(&p, 16);
      uint8_t want = num(&p, 10);
      uint8_t n = 0;
      for (;;) {
        char *e;
        long b = strtol(p, &e, 16);
        if (e == p || n >= sizeof(tx)) break;
        p = e;
        tx[n++] = (uint8_t)b;
      }
      int status = 0;
      if (n > 0) {
        status = writeTo(u, a, n, want == 0);
        if (status != 0 || want == 0) {
          Serial.println(status);
          return;
        }
      }
      if (want > sizeof(rx)) want = sizeof(rx);
      int got = readFrom(u, a, want);
      if (got < 0) {
        Serial.println(-got);
        return;
      }
      Serial.print(status);
      for (int i = 0; i < got; i++) {
        Serial.print(' ');
        put2(rx[i]);
      }
      Serial.println();
      return;
    }
    case 'z': {
      int u = num(&p, 10);
      uint8_t a = num(&p, 16);
      bus(u).beginTransmission(a);
      Serial.println(bus(u).endTransmission());
      return;
    }
#ifdef RP_FAMILY
    case 'p': {
      int u = num(&p, 10);
      int sda = num(&p, 10);
      int scl = num(&p, 10);
      bus(u).end();
      bus(u).setSDA(sda);
      bus(u).setSCL(scl);
      bus(u).begin();
      bus(u).setTimeout(50);
      Serial.println("OK");
      return;
    }
    case 'R':
      Serial.println("OK");
      Serial.flush();
      watchdog_reboot(0, 0, 0);
      for (;;) {
      }
#endif
    default:
      Serial.println("?");
      return;
  }
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
#ifdef RP_FAMILY
  Wire.setTimeout(50);
  Wire1.begin();
  Wire1.setTimeout(50);
#endif
  Serial.println("READY");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      line[len] = 0;
      if (len) exec(line);
      len = 0;
      continue;
    }
    if (len < sizeof(line) - 1) line[len++] = c;
  }
}

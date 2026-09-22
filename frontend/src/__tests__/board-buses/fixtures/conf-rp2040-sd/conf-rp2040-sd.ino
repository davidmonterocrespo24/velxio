/*
 * conf-rp2040-sd: SD.h on arduino-pico, the way a user mounts a card, for the
 * RP2040 port suite (port-conformance-rp2040.test.ts). The bus matrix found a
 * microSD card that never mounts on a Pico even alone (scenario d2); this is
 * that sketch reduced to what it measures: SD.begin() on SPI0 with its default
 * pins (GP16 MISO, GP18 SCK, GP19 MOSI) and CS on GP17, then /data.txt read
 * back through the FAT.
 *
 * Lines the test reads:
 *   READY
 *   BEGIN:<0|1>
 *   READ:<first line of /data.txt> | NOFILE
 *   DONE
 *
 * Rebuild (production toolchain, the SD library the editor resolves):
 *   node project/board-buses-2026-09/harness/compile-fixture.mjs --fqbn rp2040:rp2040:rpipico \
 *     --libs SD --out <this dir> <this dir>/conf-rp2040-sd.ino
 */
#include <SPI.h>
#include <SD.h>

const int SD_CS = 17;

void setup() {
  Serial.begin(115200);
  Serial.println("READY");
  pinMode(SD_CS, OUTPUT);
  digitalWrite(SD_CS, HIGH);
  bool ok = SD.begin(SD_CS);
  Serial.print("BEGIN:");
  Serial.println(ok ? 1 : 0);
  if (ok) {
    File f = SD.open("/data.txt");
    if (f) {
      Serial.print("READ:");
      while (f.available()) {
        char c = (char)f.read();
        if (c == '\n') break;
        Serial.write(c);
      }
      Serial.println();
      f.close();
    } else {
      Serial.println("NOFILE");
    }
  }
  Serial.println("DONE");
}

void loop() {}

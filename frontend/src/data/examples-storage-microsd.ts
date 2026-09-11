/**
 * microSD card storage gallery examples.
 *
 * Two boards exercising the SD-over-SPI part end to end:
 *   - Arduino Uno  -> in-browser avr8js, served by the `microsd-card` part
 *     (`frontend/src/simulation/parts/ProtocolParts.ts`).
 *   - ESP32        -> QEMU, served by the Python slave
 *     (`backend/app/services/esp32_sd_slave.py`) wired into the worker's
 *     synchronous SPI bridge.
 *
 * Both use the Wokwi storage model:
 *   - FREE: the project's own workspace files are auto-copied onto the card,
 *     so `SD.open("/")` lists them with no setup.
 *   - PAID (Maker+): open the microSD component's properties dialog and use the
 *     "SD Card" panel to upload your own files (binaries included). They appear
 *     on the card alongside the auto-copied sources.
 *
 * The card image is rebuilt from project files + uploads on every run (writes
 * the firmware makes are session-only and reset on reload, like Wokwi).
 */
import type { ExampleProject } from './examples';

// Shared listing + write/read-back body, parameterised per board so the two
// examples stay in lock-step.
const UNO_CODE = `// microSD card over SPI (Arduino Uno)
// Wiring: CS->10  MOSI->11  MISO->12  SCK->13  VCC->5V  GND->GND
//
// The card already holds this project's files (auto-copied, free). Paid users
// can add their own files via the component's "SD Card" panel. Open the Serial
// Monitor (9600 baud) to watch it list the card, then write and read a file.
#include <SPI.h>
#include <SD.h>

const int CS_PIN = 10;

void listRoot() {
  File root = SD.open("/");
  Serial.println(F("Files on card:"));
  while (true) {
    File entry = root.openNextFile();
    if (!entry) break;
    Serial.print(F("  "));
    Serial.print(entry.name());
    Serial.print(F("  "));
    Serial.print(entry.size());
    Serial.println(F(" bytes"));
    entry.close();
  }
  root.close();
}

void setup() {
  Serial.begin(9600);
  while (!Serial) {}
  Serial.println(F("microSD demo - Arduino Uno"));

  if (!SD.begin(CS_PIN)) {
    Serial.println(F("SD.begin() FAILED - check the wiring"));
    return;
  }
  Serial.println(F("Card ready."));
  listRoot();

  // Write a file, then read it straight back.
  File w = SD.open("/log.txt", FILE_WRITE);
  if (w) {
    w.println("hello from velxio");
    w.close();
    Serial.println(F("Wrote /log.txt"));
  }
  File r = SD.open("/log.txt");
  if (r) {
    Serial.print(F("Read back: "));
    while (r.available()) Serial.write(r.read());
    r.close();
  }
  Serial.println(F("Done."));
}

void loop() {}
`;

const ESP32_CODE = `// microSD card over SPI (ESP32, VSPI default)
// Wiring: CS->5  MOSI->23  MISO->19  SCK->18  VCC->3V3  GND->GND
//
// The card already holds this project's files (auto-copied, free). Paid users
// can add their own files via the component's "SD Card" panel. Open the Serial
// Monitor (115200 baud) to watch it list the card, then write and read a file.
#include <SPI.h>
#include <SD.h>

void listRoot() {
  File root = SD.open("/");
  Serial.println("Files on card:");
  File entry = root.openNextFile();
  while (entry) {
    Serial.printf("  %s  %u bytes\\n", entry.name(), (unsigned) entry.size());
    entry.close();
    entry = root.openNextFile();
  }
  root.close();
}

void setup() {
  Serial.begin(115200);
  delay(1200);
  Serial.println("microSD demo - ESP32");

  if (!SD.begin()) {  // default VSPI, CS = GPIO5
    Serial.println("SD.begin() FAILED - check the wiring");
    return;
  }
  Serial.println("Card ready.");
  listRoot();

  File w = SD.open("/log.txt", FILE_WRITE);
  if (w) {
    w.println("hello from velxio");
    w.close();
    Serial.println("Wrote /log.txt");
  }
  File r = SD.open("/log.txt");
  if (r) {
    Serial.print("Read back: ");
    while (r.available()) Serial.write(r.read());
    r.close();
  }
  Serial.println("Done.");
}

void loop() {}
`;

export const microsdExamples: ExampleProject[] = [
  {
    id: 'microsd-card-uno',
    title: 'microSD Card (Arduino Uno)',
    description:
      'Read and write files on a microSD card over SPI. The card is pre-loaded ' +
      "with this project's own files (free auto-copy); paid users can upload their " +
      'own files from the component\'s "SD Card" panel. Lists the root directory, ' +
      'then writes /log.txt and reads it back. Open the Serial Monitor at 9600 baud.',
    category: 'communication',
    difficulty: 'beginner',
    boardType: 'arduino-uno',
    boardFilter: 'arduino-uno',
    tags: ['microsd', 'sd card', 'spi', 'storage', 'files', 'fat16'],
    code: UNO_CODE,
    // The AVR core ships no SD library: declare it, or nothing installs it
    // and the sketch dies on the include (project/gallery-libraries-2026-09, cause A).
    libraries: ['SD'],
    components: [
      {
        type: 'microsd-card',
        id: 'sd1',
        x: 460,
        y: 120,
        properties: {},
      },
    ],
    wires: [
      { id: 'w-cs', start: { componentId: 'arduino-uno', pinName: '10' }, end: { componentId: 'sd1', pinName: 'CS' }, color: '#ffaa00' },
      { id: 'w-mosi', start: { componentId: 'arduino-uno', pinName: '11' }, end: { componentId: 'sd1', pinName: 'MOSI' }, color: '#22aaff' },
      { id: 'w-miso', start: { componentId: 'arduino-uno', pinName: '12' }, end: { componentId: 'sd1', pinName: 'MISO' }, color: '#22cc22' },
      { id: 'w-sck', start: { componentId: 'arduino-uno', pinName: '13' }, end: { componentId: 'sd1', pinName: 'SCK' }, color: '#ffdd33' },
      { id: 'w-vcc', start: { componentId: 'arduino-uno', pinName: '5V' }, end: { componentId: 'sd1', pinName: 'VCC' }, color: '#ff4444' },
      { id: 'w-gnd', start: { componentId: 'arduino-uno', pinName: 'GND.1' }, end: { componentId: 'sd1', pinName: 'GND' }, color: '#000000' },
    ],
  },
  {
    id: 'microsd-card-esp32',
    title: 'microSD Card (ESP32)',
    description:
      'Read and write files on a microSD card over SPI on the ESP32 (VSPI). The ' +
      "card is pre-loaded with this project's own files (free auto-copy); paid users " +
      'can upload their own files from the component\'s "SD Card" panel. Lists the ' +
      'root directory, then writes /log.txt and reads it back. Open the Serial ' +
      'Monitor at 115200 baud.',
    category: 'communication',
    difficulty: 'intermediate',
    boardType: 'esp32',
    boardFilter: 'esp32',
    tags: ['microsd', 'sd card', 'spi', 'storage', 'files', 'fat16', 'esp32'],
    code: ESP32_CODE,
    components: [
      {
        type: 'microsd-card',
        id: 'sd1',
        x: 460,
        y: 120,
        properties: {},
      },
    ],
    wires: [
      { id: 'w-cs', start: { componentId: 'esp32', pinName: '5' }, end: { componentId: 'sd1', pinName: 'CS' }, color: '#ffaa00' },
      { id: 'w-mosi', start: { componentId: 'esp32', pinName: '23' }, end: { componentId: 'sd1', pinName: 'MOSI' }, color: '#22aaff' },
      { id: 'w-miso', start: { componentId: 'esp32', pinName: '19' }, end: { componentId: 'sd1', pinName: 'MISO' }, color: '#22cc22' },
      { id: 'w-sck', start: { componentId: 'esp32', pinName: '18' }, end: { componentId: 'sd1', pinName: 'SCK' }, color: '#ffdd33' },
      { id: 'w-vcc', start: { componentId: 'esp32', pinName: '3V3' }, end: { componentId: 'sd1', pinName: 'VCC' }, color: '#ff4444' },
      { id: 'w-gnd', start: { componentId: 'esp32', pinName: 'GND' }, end: { componentId: 'sd1', pinName: 'GND' }, color: '#000000' },
    ],
  },
];

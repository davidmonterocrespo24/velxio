/**
 * ePaper / e-Ink display gallery examples.
 *
 * Five Phase-1 panels (1.54", 2.13", 2.9", 4.2", 7.5"), all SSD168x family,
 * all driven through GxEPD2. Each example is wired against a different
 * board so users can see ePaper running across AVR / RP2040 / ESP32.
 *
 * The backend ESP32 path uses `Ssd168xEpaperSlave` in
 * `backend/app/services/esp32_spi_slaves.py`. The browser-side path
 * (AVR / RP2040) uses `frontend/src/simulation/displays/SSD168xDecoder.ts`.
 * Both render to the same `<velxio-epaper>` Web Component.
 */

import type { ExampleProject } from './examples';

const EPAPER_LIBS = ['GxEPD2', 'Adafruit GFX Library'];

// ── 1. Arduino Uno + 1.54" "Hello World" — the AVR poster child ─────────────
const helloUno154: ExampleProject = {
  id: 'epaper-1in54-uno-hello',
  title: 'ePaper 1.54" Hello — Arduino Uno',
  description:
    'GxEPD2 paged-mode "Hello, Velxio" on a 200×200 SSD1681 e-Ink panel driven by an Arduino Uno. ' +
    'The smallest panel that fits in Uno\'s 32 KB flash + 2 KB SRAM at 16-row page height.',
  category: 'displays',
  difficulty: 'intermediate',
  boardType: 'arduino-uno',
  boardFilter: 'arduino-uno',
  libraries: EPAPER_LIBS,
  tags: ['epaper', 'e-ink', 'gxepd2', 'ssd1681', 'avr', 'spi'],
  code: `// 1.54" SSD1681 ePaper hello-world for Arduino Uno
// Wiring: CS=D10, DC=D9, RST=D8, BUSY=D7 + hardware SPI (D11=MOSI, D13=SCK)

#include <GxEPD2_BW.h>
#include <Fonts/FreeMonoBold9pt7b.h>

GxEPD2_BW<GxEPD2_154_D67, 16> display(GxEPD2_154_D67(/*CS=*/10, /*DC=*/9, /*RST=*/8, /*BUSY=*/7));

void setup() {
  Serial.begin(9600);
  display.init(9600, true, 50, false);
  display.setRotation(0);
  display.setTextColor(GxEPD_BLACK);
  display.setFont(&FreeMonoBold9pt7b);
  display.setFullWindow();
  display.firstPage();
  do {
    display.fillScreen(GxEPD_WHITE);
    display.setCursor(20, 60);  display.print(F("Velxio"));
    display.setCursor(20, 100); display.print(F("ePaper"));
    display.setCursor(20, 140); display.print(F("OK!"));
  } while (display.nextPage());
  display.hibernate();
  Serial.println(F("done"));
}

void loop() {}
`,
  components: [
    {
      type: 'epaper-1in54-bw',
      id: 'epd-154',
      x: 480,
      y: 80,
      properties: { panelKind: 'epaper-1in54-bw', refreshMs: 50 },
    },
  ],
  wires: [
    { id: 'w-cs', start: { componentId: 'arduino-uno', pinName: '10' }, end: { componentId: 'epd-154', pinName: 'CS' }, color: '#ffaa00' },
    { id: 'w-dc', start: { componentId: 'arduino-uno', pinName: '9' },  end: { componentId: 'epd-154', pinName: 'DC' }, color: '#aa66ff' },
    { id: 'w-rst', start: { componentId: 'arduino-uno', pinName: '8' }, end: { componentId: 'epd-154', pinName: 'RST' }, color: '#ff4444' },
    { id: 'w-busy', start: { componentId: 'arduino-uno', pinName: '7' }, end: { componentId: 'epd-154', pinName: 'BUSY' }, color: '#22cc22' },
    { id: 'w-mosi', start: { componentId: 'arduino-uno', pinName: '11' }, end: { componentId: 'epd-154', pinName: 'SDI' }, color: '#22aaff' },
    { id: 'w-sck', start: { componentId: 'arduino-uno', pinName: '13' }, end: { componentId: 'epd-154', pinName: 'SCK' }, color: '#ffdd33' },
    { id: 'w-vcc', start: { componentId: 'arduino-uno', pinName: '3.3V' }, end: { componentId: 'epd-154', pinName: 'VCC' }, color: '#ff4444' },
    { id: 'w-gnd', start: { componentId: 'arduino-uno', pinName: 'GND.1' }, end: { componentId: 'epd-154', pinName: 'GND' }, color: '#000000' },
  ],
};

// ── 2. Pi Pico + 2.13" wall clock ────────────────────────────────────────────
const clockPico213: ExampleProject = {
  id: 'epaper-2in13-pico-clock',
  title: 'ePaper 2.13" Wall Clock — Raspberry Pi Pico',
  description:
    'Counts seconds and refreshes the framebuffer once per minute on a 2.13" 250×122 SSD1675A panel. ' +
    'Runs on the Pico via the Earle Philhower core; SPI0 default pins.',
  category: 'displays',
  difficulty: 'intermediate',
  boardType: 'raspberry-pi-pico',
  boardFilter: 'raspberry-pi-pico',
  libraries: EPAPER_LIBS,
  tags: ['epaper', 'e-ink', 'gxepd2', 'ssd1675', 'rp2040', 'pico', 'clock'],
  code: `// 2.13" SSD1675A panel on Pi Pico SPI0 (GP18=SCK, GP19=MOSI, GP9=CS, GP8=DC, GP12=RST, GP13=BUSY)

#include <GxEPD2_BW.h>
#include <Fonts/FreeMonoBold12pt7b.h>

GxEPD2_BW<GxEPD2_213_B72, GxEPD2_213_B72::HEIGHT> display(
  GxEPD2_213_B72(/*CS=*/9, /*DC=*/8, /*RST=*/12, /*BUSY=*/13));

uint32_t minutes = 0;

void drawClock() {
  display.fillScreen(GxEPD_WHITE);
  display.setTextColor(GxEPD_BLACK);
  display.setFont(&FreeMonoBold12pt7b);
  display.setCursor(8, 28);  display.print("Velxio Clock");
  display.setCursor(8, 64);
  display.print("uptime: "); display.print(minutes); display.print("m");
}

void setup() {
  Serial.begin(115200);
  display.init(115200, true, 50, false);
  display.setRotation(1);  // landscape 250×122
  display.setFullWindow();
  display.firstPage();
  do { drawClock(); } while (display.nextPage());
  display.hibernate();
}

void loop() {
  delay(60000UL);
  minutes++;
  display.firstPage();
  do { drawClock(); } while (display.nextPage());
  display.hibernate();
}
`,
  components: [
    {
      type: 'epaper-2in13-bw',
      id: 'epd-213',
      x: 480,
      y: 60,
      properties: { panelKind: 'epaper-2in13-bw', refreshMs: 50 },
    },
  ],
  wires: [
    { id: 'w-cs', start: { componentId: 'raspberry-pi-pico', pinName: 'GP9' }, end: { componentId: 'epd-213', pinName: 'CS' }, color: '#ffaa00' },
    { id: 'w-dc', start: { componentId: 'raspberry-pi-pico', pinName: 'GP8' }, end: { componentId: 'epd-213', pinName: 'DC' }, color: '#aa66ff' },
    { id: 'w-rst', start: { componentId: 'raspberry-pi-pico', pinName: 'GP12' }, end: { componentId: 'epd-213', pinName: 'RST' }, color: '#ff4444' },
    { id: 'w-busy', start: { componentId: 'raspberry-pi-pico', pinName: 'GP13' }, end: { componentId: 'epd-213', pinName: 'BUSY' }, color: '#22cc22' },
    { id: 'w-mosi', start: { componentId: 'raspberry-pi-pico', pinName: 'GP19' }, end: { componentId: 'epd-213', pinName: 'SDI' }, color: '#22aaff' },
    { id: 'w-sck', start: { componentId: 'raspberry-pi-pico', pinName: 'GP18' }, end: { componentId: 'epd-213', pinName: 'SCK' }, color: '#ffdd33' },
    { id: 'w-vcc', start: { componentId: 'raspberry-pi-pico', pinName: '3V3(OUT)' }, end: { componentId: 'epd-213', pinName: 'VCC' }, color: '#ff4444' },
    { id: 'w-gnd', start: { componentId: 'raspberry-pi-pico', pinName: 'GND.1' }, end: { componentId: 'epd-213', pinName: 'GND' }, color: '#000000' },
  ],
};

// ── 3. ESP32 + 2.9" Weather widget ──────────────────────────────────────────
const weatherEsp29: ExampleProject = {
  id: 'epaper-2in9-esp32-weather',
  title: 'ePaper 2.9" Weather — ESP32',
  description:
    'Mock weather widget on a 2.9" 296×128 SSD1680 panel. Demonstrates ePaper rendering via the ' +
    'backend Ssd168xEpaperSlave — the QEMU worker decodes SPI traffic and ships the latched frame ' +
    'back to the browser as an `epaper_update` WebSocket event.',
  category: 'displays',
  difficulty: 'intermediate',
  boardType: 'esp32',
  boardFilter: 'esp32',
  libraries: EPAPER_LIBS,
  tags: ['epaper', 'e-ink', 'gxepd2', 'ssd1680', 'esp32', 'weather'],
  code: `// 2.9" 296x128 SSD1680 panel on ESP32 (VSPI default — SCK=18, MOSI=23)

#include <GxEPD2_BW.h>
#include <Fonts/FreeMonoBold12pt7b.h>

GxEPD2_BW<GxEPD2_290_T94, GxEPD2_290_T94::HEIGHT> display(
  GxEPD2_290_T94(/*CS=*/5, /*DC=*/17, /*RST=*/16, /*BUSY=*/4));

void setup() {
  Serial.begin(115200);
  display.init(115200, true, 50, false);
  display.setRotation(1);
  display.setFullWindow();
  display.firstPage();
  do {
    display.fillScreen(GxEPD_WHITE);
    display.setTextColor(GxEPD_BLACK);
    display.setFont(&FreeMonoBold12pt7b);
    display.setCursor(8, 28);  display.print("Velxio Weather");
    display.setCursor(8, 64);  display.print("Temp:  22.5 C");
    display.setCursor(8, 96);  display.print("RH:    48 %");
  } while (display.nextPage());
  display.hibernate();
  Serial.println("frame done");
}

void loop() { delay(1000); }
`,
  components: [
    {
      type: 'epaper-2in9-bw',
      id: 'epd-290',
      x: 460,
      y: 80,
      properties: { panelKind: 'epaper-2in9-bw', refreshMs: 50 },
    },
  ],
  wires: [
    { id: 'w-cs', start: { componentId: 'esp32', pinName: '5' }, end: { componentId: 'epd-290', pinName: 'CS' }, color: '#ffaa00' },
    { id: 'w-dc', start: { componentId: 'esp32', pinName: '17' }, end: { componentId: 'epd-290', pinName: 'DC' }, color: '#aa66ff' },
    { id: 'w-rst', start: { componentId: 'esp32', pinName: '16' }, end: { componentId: 'epd-290', pinName: 'RST' }, color: '#ff4444' },
    { id: 'w-busy', start: { componentId: 'esp32', pinName: '4' }, end: { componentId: 'epd-290', pinName: 'BUSY' }, color: '#22cc22' },
    { id: 'w-mosi', start: { componentId: 'esp32', pinName: '23' }, end: { componentId: 'epd-290', pinName: 'SDI' }, color: '#22aaff' },
    { id: 'w-sck', start: { componentId: 'esp32', pinName: '18' }, end: { componentId: 'epd-290', pinName: 'SCK' }, color: '#ffdd33' },
    { id: 'w-vcc', start: { componentId: 'esp32', pinName: '3V3' }, end: { componentId: 'epd-290', pinName: 'VCC' }, color: '#ff4444' },
    { id: 'w-gnd', start: { componentId: 'esp32', pinName: 'GND' }, end: { componentId: 'epd-290', pinName: 'GND' }, color: '#000000' },
  ],
};

// ── 4. Pi Pico + 4.2" "Static image" ────────────────────────────────────────
const imagePico420: ExampleProject = {
  id: 'epaper-4in2-pico-image',
  title: 'ePaper 4.2" Static Image — Raspberry Pi Pico',
  description:
    'Embeds a fixed 400×300 black-and-white pattern (concentric squares) and pushes it once. ' +
    'Big enough to demonstrate a real layout — title block, divider, data table.',
  category: 'displays',
  difficulty: 'advanced',
  boardType: 'raspberry-pi-pico',
  boardFilter: 'raspberry-pi-pico',
  libraries: EPAPER_LIBS,
  tags: ['epaper', 'e-ink', 'gxepd2', 'ssd1683', 'rp2040', 'image'],
  code: `// 4.2" 400x300 SSD1683 panel on Pi Pico SPI0 — GP18 SCK, GP19 MOSI

#include <GxEPD2_BW.h>
#include <Fonts/FreeMonoBold18pt7b.h>
#include <Fonts/FreeMonoBold9pt7b.h>

GxEPD2_BW<GxEPD2_420_GDEY042T81, 32> display(
  GxEPD2_420_GDEY042T81(/*CS=*/9, /*DC=*/8, /*RST=*/12, /*BUSY=*/13));

void drawLayout() {
  display.fillScreen(GxEPD_WHITE);
  display.setTextColor(GxEPD_BLACK);
  display.setFont(&FreeMonoBold18pt7b);
  display.setCursor(20, 60);  display.print("Velxio Logbook");
  display.drawLine(20, 80, 380, 80, GxEPD_BLACK);

  display.setFont(&FreeMonoBold9pt7b);
  const char* rows[][2] = {
    {"Date",        "2026-04-29"},
    {"Battery",     " 3.91 V"},
    {"Cycles",      "  1024"},
    {"Last refresh","  62 ms"},
  };
  for (uint8_t i = 0; i < 4; i++) {
    display.setCursor(40, 120 + i * 28);  display.print(rows[i][0]);
    display.setCursor(220, 120 + i * 28); display.print(rows[i][1]);
  }
}

void setup() {
  Serial.begin(115200);
  display.init(115200, true, 50, false);
  display.setRotation(0);
  display.setFullWindow();
  display.firstPage();
  do { drawLayout(); } while (display.nextPage());
  display.hibernate();
}

void loop() {}
`,
  components: [
    {
      type: 'epaper-4in2-bw',
      id: 'epd-420',
      x: 480,
      y: 60,
      properties: { panelKind: 'epaper-4in2-bw', refreshMs: 80 },
    },
  ],
  wires: [
    { id: 'w-cs', start: { componentId: 'raspberry-pi-pico', pinName: 'GP9' }, end: { componentId: 'epd-420', pinName: 'CS' }, color: '#ffaa00' },
    { id: 'w-dc', start: { componentId: 'raspberry-pi-pico', pinName: 'GP8' }, end: { componentId: 'epd-420', pinName: 'DC' }, color: '#aa66ff' },
    { id: 'w-rst', start: { componentId: 'raspberry-pi-pico', pinName: 'GP12' }, end: { componentId: 'epd-420', pinName: 'RST' }, color: '#ff4444' },
    { id: 'w-busy', start: { componentId: 'raspberry-pi-pico', pinName: 'GP13' }, end: { componentId: 'epd-420', pinName: 'BUSY' }, color: '#22cc22' },
    { id: 'w-mosi', start: { componentId: 'raspberry-pi-pico', pinName: 'GP19' }, end: { componentId: 'epd-420', pinName: 'SDI' }, color: '#22aaff' },
    { id: 'w-sck', start: { componentId: 'raspberry-pi-pico', pinName: 'GP18' }, end: { componentId: 'epd-420', pinName: 'SCK' }, color: '#ffdd33' },
    { id: 'w-vcc', start: { componentId: 'raspberry-pi-pico', pinName: '3V3(OUT)' }, end: { componentId: 'epd-420', pinName: 'VCC' }, color: '#ff4444' },
    { id: 'w-gnd', start: { componentId: 'raspberry-pi-pico', pinName: 'GND.1' }, end: { componentId: 'epd-420', pinName: 'GND' }, color: '#000000' },
  ],
};

// ── 5. ESP32 + 7.5" multi-tile dashboard ────────────────────────────────────
const dashboardEsp750: ExampleProject = {
  id: 'epaper-7in5-esp32-dashboard',
  title: 'ePaper 7.5" Dashboard — ESP32',
  description:
    'Full 800×480 multi-tile dashboard on the largest mono panel. ESP32 only — the framebuffer ' +
    'is too big for AVR/Pico flash with paged GxEPD2.',
  category: 'displays',
  difficulty: 'advanced',
  boardType: 'esp32',
  boardFilter: 'esp32',
  libraries: EPAPER_LIBS,
  tags: ['epaper', 'e-ink', 'gxepd2', 'uc8179', 'gd7965', 'esp32', 'dashboard', '7.5'],
  code: `// 7.5" 800x480 UC8179 panel on ESP32 — VSPI

#include <GxEPD2_BW.h>
#include <Fonts/FreeMonoBold24pt7b.h>
#include <Fonts/FreeMonoBold12pt7b.h>

GxEPD2_BW<GxEPD2_750_T7, 16> display(
  GxEPD2_750_T7(/*CS=*/5, /*DC=*/17, /*RST=*/16, /*BUSY=*/4));

void drawDashboard() {
  display.fillScreen(GxEPD_WHITE);
  display.setTextColor(GxEPD_BLACK);

  // Title
  display.setFont(&FreeMonoBold24pt7b);
  display.setCursor(40, 60);  display.print("Velxio Dashboard");
  display.drawLine(40, 80, 760, 80, GxEPD_BLACK);

  // Tiles
  display.setFont(&FreeMonoBold12pt7b);
  const char* labels[] = { "Sensors", "Network", "Storage", "Health" };
  const char* values[] = { "12 / 12", "WiFi OK", "640 MB", "100 %" };
  for (uint8_t i = 0; i < 4; i++) {
    int x = 50 + (i % 2) * 360;
    int y = 130 + (i / 2) * 140;
    display.drawRect(x, y, 320, 100, GxEPD_BLACK);
    display.setCursor(x + 20, y + 38);  display.print(labels[i]);
    display.setCursor(x + 20, y + 78);  display.print(values[i]);
  }
}

void setup() {
  Serial.begin(115200);
  display.init(115200, true, 50, false);
  display.setRotation(0);
  display.setFullWindow();
  display.firstPage();
  do { drawDashboard(); } while (display.nextPage());
  display.hibernate();
}

void loop() {}
`,
  components: [
    {
      type: 'epaper-7in5-bw',
      id: 'epd-750',
      x: 480,
      y: 40,
      properties: { panelKind: 'epaper-7in5-bw', refreshMs: 100 },
    },
  ],
  wires: [
    { id: 'w-cs', start: { componentId: 'esp32', pinName: '5' }, end: { componentId: 'epd-750', pinName: 'CS' }, color: '#ffaa00' },
    { id: 'w-dc', start: { componentId: 'esp32', pinName: '17' }, end: { componentId: 'epd-750', pinName: 'DC' }, color: '#aa66ff' },
    { id: 'w-rst', start: { componentId: 'esp32', pinName: '16' }, end: { componentId: 'epd-750', pinName: 'RST' }, color: '#ff4444' },
    { id: 'w-busy', start: { componentId: 'esp32', pinName: '4' }, end: { componentId: 'epd-750', pinName: 'BUSY' }, color: '#22cc22' },
    { id: 'w-mosi', start: { componentId: 'esp32', pinName: '23' }, end: { componentId: 'epd-750', pinName: 'SDI' }, color: '#22aaff' },
    { id: 'w-sck', start: { componentId: 'esp32', pinName: '18' }, end: { componentId: 'epd-750', pinName: 'SCK' }, color: '#ffdd33' },
    { id: 'w-vcc', start: { componentId: 'esp32', pinName: '3V3' }, end: { componentId: 'epd-750', pinName: 'VCC' }, color: '#ff4444' },
    { id: 'w-gnd', start: { componentId: 'esp32', pinName: 'GND' }, end: { componentId: 'epd-750', pinName: 'GND' }, color: '#000000' },
  ],
};

// ── 6. ESP32 + 2.9" tri-colour B/W/R alert badge ────────────────────────────
const tricolorEsp29: ExampleProject = {
  id: 'epaper-2in9-bwr-esp32-alert',
  title: 'ePaper 2.9" Tri-Colour Alert — ESP32',
  description:
    'Tri-colour 296×128 B/W/Red panel showing a status badge. Demonstrates the SSD1680 ' +
    'red plane: title in black, "ALERT" pill in red on white. Exercises both 0x24 (BW) ' +
    'and 0x26 (Red) RAM commands.',
  category: 'displays',
  difficulty: 'intermediate',
  boardType: 'esp32',
  boardFilter: 'esp32',
  libraries: EPAPER_LIBS,
  tags: ['epaper', 'e-ink', 'gxepd2', 'ssd1680', '3c', 'tri-color', 'red', 'esp32'],
  code: `// 2.9" 296x128 SSD1680 B/W/R panel on ESP32 — VSPI
//
// GxEPD2 selects the 3-colour driver via GxEPD2_3C<...> instead of GxEPD2_BW<...>.
// Same physical wiring; the library writes to the red RAM plane (cmd 0x26) for
// every red pixel.

#include <GxEPD2_3C.h>
#include <Fonts/FreeMonoBold12pt7b.h>
#include <Fonts/FreeMonoBold18pt7b.h>

GxEPD2_3C<GxEPD2_290_C90c, GxEPD2_290_C90c::HEIGHT> display(
  GxEPD2_290_C90c(/*CS=*/5, /*DC=*/17, /*RST=*/16, /*BUSY=*/4));

void drawAlert() {
  display.fillScreen(GxEPD_WHITE);

  // Title in black
  display.setTextColor(GxEPD_BLACK);
  display.setFont(&FreeMonoBold12pt7b);
  display.setCursor(8, 28);
  display.print("System Status");

  // Red "ALERT" badge
  display.fillRect(8, 60, 130, 38, GxEPD_RED);
  display.setTextColor(GxEPD_WHITE);
  display.setFont(&FreeMonoBold18pt7b);
  display.setCursor(20, 90);
  display.print("ALERT");

  // Detail line in black
  display.setTextColor(GxEPD_BLACK);
  display.setFont(&FreeMonoBold12pt7b);
  display.setCursor(150, 84);
  display.print("Temp 89C");
}

void setup() {
  Serial.begin(115200);
  display.init(115200, true, 50, false);
  display.setRotation(1);
  display.setFullWindow();
  display.firstPage();
  do { drawAlert(); } while (display.nextPage());
  display.hibernate();
  Serial.println("frame done");
}

void loop() { delay(1000); }
`,
  components: [
    {
      type: 'epaper-2in9-bwr',
      id: 'epd-290-bwr',
      x: 460,
      y: 80,
      properties: { panelKind: 'epaper-2in9-bwr', refreshMs: 80 },
    },
  ],
  wires: [
    { id: 'w-cs', start: { componentId: 'esp32', pinName: '5' }, end: { componentId: 'epd-290-bwr', pinName: 'CS' }, color: '#ffaa00' },
    { id: 'w-dc', start: { componentId: 'esp32', pinName: '17' }, end: { componentId: 'epd-290-bwr', pinName: 'DC' }, color: '#aa66ff' },
    { id: 'w-rst', start: { componentId: 'esp32', pinName: '16' }, end: { componentId: 'epd-290-bwr', pinName: 'RST' }, color: '#ff4444' },
    { id: 'w-busy', start: { componentId: 'esp32', pinName: '4' }, end: { componentId: 'epd-290-bwr', pinName: 'BUSY' }, color: '#22cc22' },
    { id: 'w-mosi', start: { componentId: 'esp32', pinName: '23' }, end: { componentId: 'epd-290-bwr', pinName: 'SDI' }, color: '#22aaff' },
    { id: 'w-sck', start: { componentId: 'esp32', pinName: '18' }, end: { componentId: 'epd-290-bwr', pinName: 'SCK' }, color: '#ffdd33' },
    { id: 'w-vcc', start: { componentId: 'esp32', pinName: '3V3' }, end: { componentId: 'epd-290-bwr', pinName: 'VCC' }, color: '#ff4444' },
    { id: 'w-gnd', start: { componentId: 'esp32', pinName: 'GND' }, end: { componentId: 'epd-290-bwr', pinName: 'GND' }, color: '#000000' },
  ],
};

// ── 7. ESP32 + 5.65" 7-colour ACeP rainbow ──────────────────────────────────
const acepEsp565: ExampleProject = {
  id: 'epaper-5in65-7c-esp32-rainbow',
  title: 'ePaper 5.65" 7-colour Rainbow — ESP32',
  description:
    'Drives the GoodDisplay GDEP0565D90 / Waveshare 5.65" ACeP 7-colour panel ' +
    '(UC8159c controller). Renders horizontal colour bars + a centred title to ' +
    'show every palette entry. Real-hardware refresh is ~12 s; the emulator ' +
    'pulses BUSY for 150 ms.',
  category: 'displays',
  difficulty: 'advanced',
  boardType: 'esp32',
  boardFilter: 'esp32',
  libraries: EPAPER_LIBS,
  tags: ['epaper', 'e-ink', 'gxepd2', 'uc8159c', 'acep', '7-color', 'esp32', '5.65'],
  code: `// 5.65" 600x448 UC8159c ACeP 7-colour panel on ESP32 — VSPI
// CS=GPIO5  DC=GPIO17  RST=GPIO16  BUSY=GPIO4  SCK=GPIO18  MOSI=GPIO23

#include <GxEPD2_7C.h>
#include <Fonts/FreeMonoBold18pt7b.h>

GxEPD2_7C<GxEPD2_565c_GDEP0565D90, 8> display(
  GxEPD2_565c_GDEP0565D90(/*CS=*/5, /*DC=*/17, /*RST=*/16, /*BUSY=*/4));

// Each palette index in ACeP 7-colour:
//   0=black 1=white 2=green 3=blue 4=red 5=yellow 6=orange
const uint16_t COLOURS[] = {
  GxEPD_BLACK, GxEPD_WHITE, GxEPD_GREEN,
  GxEPD_BLUE,  GxEPD_RED,   GxEPD_YELLOW, GxEPD_ORANGE,
};

void drawRainbow() {
  display.fillScreen(GxEPD_WHITE);
  const int barH = 448 / 7;
  for (uint8_t i = 0; i < 7; i++) {
    display.fillRect(0, i * barH, 600, barH, COLOURS[i]);
  }
  display.setTextColor(GxEPD_BLACK);
  display.setFont(&FreeMonoBold18pt7b);
  display.setCursor(120, 240);
  display.print("Velxio ACeP 7c");
}

void setup() {
  Serial.begin(115200);
  display.init(115200, true, 50, false);
  display.setRotation(0);
  display.setFullWindow();
  display.firstPage();
  do { drawRainbow(); } while (display.nextPage());
  display.hibernate();
  Serial.println("frame done");
}

void loop() { delay(1000); }
`,
  components: [
    {
      type: 'epaper-5in65-7c',
      id: 'epd-565',
      x: 480,
      y: 40,
      properties: { panelKind: 'epaper-5in65-7c', refreshMs: 150 },
    },
  ],
  wires: [
    { id: 'w-cs', start: { componentId: 'esp32', pinName: '5' }, end: { componentId: 'epd-565', pinName: 'CS' }, color: '#ffaa00' },
    { id: 'w-dc', start: { componentId: 'esp32', pinName: '17' }, end: { componentId: 'epd-565', pinName: 'DC' }, color: '#aa66ff' },
    { id: 'w-rst', start: { componentId: 'esp32', pinName: '16' }, end: { componentId: 'epd-565', pinName: 'RST' }, color: '#ff4444' },
    { id: 'w-busy', start: { componentId: 'esp32', pinName: '4' }, end: { componentId: 'epd-565', pinName: 'BUSY' }, color: '#22cc22' },
    { id: 'w-mosi', start: { componentId: 'esp32', pinName: '23' }, end: { componentId: 'epd-565', pinName: 'SDI' }, color: '#22aaff' },
    { id: 'w-sck', start: { componentId: 'esp32', pinName: '18' }, end: { componentId: 'epd-565', pinName: 'SCK' }, color: '#ffdd33' },
    { id: 'w-vcc', start: { componentId: 'esp32', pinName: '3V3' }, end: { componentId: 'epd-565', pinName: 'VCC' }, color: '#ff4444' },
    { id: 'w-gnd', start: { componentId: 'esp32', pinName: 'GND' }, end: { componentId: 'epd-565', pinName: 'GND' }, color: '#000000' },
  ],
};

export const epaperExamples: ExampleProject[] = [
  helloUno154,
  clockPico213,
  weatherEsp29,
  imagePico420,
  dashboardEsp750,
  tricolorEsp29,
  acepEsp565,
];

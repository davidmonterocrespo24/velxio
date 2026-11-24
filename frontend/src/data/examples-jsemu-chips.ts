import type { ExampleProject } from './examples';

/**
 * Per-chip basics for the ESP32-S3 (Xtensa LX7) and ESP32-C3 (RISC-V)
 * boards — one minimal example per core peripheral
 * class (GPIO / UART / I2C / ADC / SPI). Besides filling the gallery
 * coverage gap for these chips, they are the smoke circuits used to
 * exercise each per-chip emulator backend.
 *
 * Pin choices follow the arduino-esp32 defaults for each variant:
 *   - ESP32-S3: Wire SDA=8 SCL=9; ADC1 on GPIO1..10.
 *   - ESP32-C3: Wire SDA=8 SCL=9; SPI (FSPI) SCK=4 MISO=5 MOSI=6 SS=7;
 *     ADC1 ch0 on GPIO0.
 * Wire pinName values match the board Web Component pinInfo names
 * (PINS_ESP32_S3 / PINS_ESP32_C3 in
 * velxio-components/Esp32Element.ts — note the suffixed power pins:
 * 3V3.1, GND.1, …).
 */
export const jsemuChipExamples: ExampleProject[] = [
  // ─── ESP32-S3 ─────────────────────────────────────────────────────────────
  {
    id: 'esp32s3-blink-led',
    title: 'ESP32-S3 Blink LED',
    description:
      'Blink an external red LED on GPIO4 of the ESP32-S3 DevKitC-1. Verifies ESP32-S3 GPIO emulation is working.',
    category: 'basics',
    difficulty: 'beginner',
    boardType: 'esp32-s3',
    boardFilter: 'esp32-s3',
    tags: ['esp32-s3', 'gpio', 'led', 'blink'],
    code: `// ESP32-S3 Blink LED
// The DevKitC-1 has no plain built-in LED (its on-board LED is an RGB
// WS2812 on GPIO48), so we blink an external LED wired to GPIO4.

#define LED_PIN 4   // External red LED through a 220 Ohm resistor

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  Serial.println("ESP32-S3 Blink ready!");
}

void loop() {
  digitalWrite(LED_PIN, HIGH);
  Serial.println("LED ON");
  delay(500);

  digitalWrite(LED_PIN, LOW);
  Serial.println("LED OFF");
  delay(500);
}`,
    components: [
      // 220 Ohm current-limiting resistor in series with the LED —
      // (3.3V - ~2V)/220R ~= 6 mA, well under the LED's 20 mA rating.
      { type: 'wokwi-resistor', id: 's3-r-led', x: 320, y: 205, properties: { value: '220' } },
      { type: 'wokwi-led', id: 's3-led-ext', x: 470, y: 190, properties: { color: 'red' } },
    ],
    wires: [
      // GPIO4 → resistor → LED anode
      {
        id: 's3blk-gpio4-r',
        start: { componentId: 'esp32-s3', pinName: '4' },
        end: { componentId: 's3-r-led', pinName: '1' },
        color: '#e74c3c',
      },
      {
        id: 's3blk-r-led',
        start: { componentId: 's3-r-led', pinName: '2' },
        end: { componentId: 's3-led-ext', pinName: 'A' },
        color: '#e74c3c',
      },
      // LED cathode → GND
      {
        id: 's3blk-gnd',
        start: { componentId: 's3-led-ext', pinName: 'C' },
        end: { componentId: 'esp32-s3', pinName: 'GND.1' },
        color: '#2c3e50',
      },
    ],
  },
  {
    id: 'esp32s3-serial-echo',
    title: 'ESP32-S3 Serial Echo',
    description:
      'ESP32-S3 reads from Serial and echoes back. Demonstrates UART and Serial Monitor integration on the S3.',
    category: 'communication',
    difficulty: 'beginner',
    boardType: 'esp32-s3',
    boardFilter: 'esp32-s3',
    tags: ['esp32-s3', 'uart', 'serial'],
    code: `// ESP32-S3 Serial Echo
// Echoes anything received on Serial (UART0) back to the sender.
// Open the Serial Monitor, type something, and see it echoed back.

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("ESP32-S3 Serial Echo ready!");
  Serial.println("Type anything in the Serial Monitor...");
}

void loop() {
  if (Serial.available()) {
    String input = Serial.readStringUntil('\\n');
    input.trim();
    if (input.length() > 0) {
      Serial.print("Echo: ");
      Serial.println(input);
    }
  }
}`,
    components: [],
    wires: [],
  },
  {
    id: 'esp32s3-oled-i2c',
    title: 'ESP32-S3: SSD1306 OLED Display',
    description:
      'Display text on a 128×64 SSD1306 OLED over I2C from the ESP32-S3 (default Wire pins SDA=GPIO8, SCL=GPIO9).',
    libraries: ['Adafruit SSD1306', 'Adafruit GFX Library', 'Adafruit BusIO'],
    category: 'displays',
    difficulty: 'intermediate',
    boardType: 'esp32-s3',
    boardFilter: 'esp32-s3',
    tags: ['esp32-s3', 'i2c', 'ssd1306', 'oled', 'display'],
    code: `// ESP32-S3 — SSD1306 OLED Display (I2C 128×64)
// Requires: Adafruit SSD1306, Adafruit GFX Library
// Wiring: SDA → GPIO8  |  SCL → GPIO9  |  VCC → 3V3  |  GND → GND
// GPIO8/9 are the arduino-esp32 default Wire pins on the S3.

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

int counter = 0;

void setup() {
  Serial.begin(115200);
  Wire.begin(8, 9);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 not found!");
    while (true) delay(10);
  }
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Hello");
  display.println("S3!");
  display.display();
  Serial.println("OLED ready!");
}

void loop() {
  counter++;
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Hello");
  display.println("S3!");
  display.setTextSize(1);
  display.setCursor(0, 48);
  display.printf("Count: %d", counter);
  display.display();
  Serial.printf("Frame: %d\\n", counter);
  delay(1000);
}`,
    components: [{ type: 'wokwi-ssd1306', id: 's3-oled1', x: 420, y: 130, properties: {} }],
    wires: [
      {
        id: 's3o-vcc',
        start: { componentId: 'esp32-s3', pinName: '3V3.1' },
        end: { componentId: 's3-oled1', pinName: '3V3' },
        color: '#ff4444',
      },
      {
        id: 's3o-gnd',
        start: { componentId: 'esp32-s3', pinName: 'GND.1' },
        end: { componentId: 's3-oled1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 's3o-sda',
        start: { componentId: 'esp32-s3', pinName: '8' },
        end: { componentId: 's3-oled1', pinName: 'DATA' },
        color: '#22aaff',
      },
      {
        id: 's3o-scl',
        start: { componentId: 'esp32-s3', pinName: '9' },
        end: { componentId: 's3-oled1', pinName: 'CLK' },
        color: '#ff8800',
      },
    ],
  },
  {
    id: 'esp32s3-potentiometer',
    title: 'ESP32-S3: Potentiometer (ADC)',
    description:
      'Read a potentiometer with the ESP32-S3 12-bit ADC on GPIO1 (ADC1_CH0) and print the raw value and the calibrated voltage (analogReadMilliVolts). At the default 12 dB the S3 measures up to about 3.1 V.',
    category: 'sensors',
    difficulty: 'beginner',
    boardType: 'esp32-s3',
    boardFilter: 'esp32-s3',
    tags: ['esp32-s3', 'adc', 'potentiometer', 'analog'],
    code: `// ESP32-S3 — Potentiometer on the ADC
// Pot: SIG → GPIO1 (ADC1_CH0)  |  VCC → 3V3  |  GND → GND

#define POT_PIN 1  // ADC1_CH0

void setup() {
  Serial.begin(115200);
  Serial.println("ESP32-S3 ADC ready — turn the pot!");
}

// At the default 12 dB attenuation the S3 measures up to about 3.1 V and
// its code is not a straight line from 0 to 3.3 V, so the voltage comes from
// analogReadMilliVolts() (factory calibration), not a straight 3.3/4095
// scaling. The last few degrees of the pot's travel read 4095 and about 3.1 V.

void loop() {
  int raw = analogRead(POT_PIN);           // raw 12-bit code
  float volts = analogReadMilliVolts(POT_PIN) / 1000.0f;
  Serial.printf("Pot: %4d  (%.2f V)\\n", raw, volts);
  delay(200);
}`,
    components: [
      { type: 'wokwi-potentiometer', id: 's3-pot1', x: 420, y: 200, properties: {} },
    ],
    wires: [
      {
        id: 's3pt-vcc',
        start: { componentId: 'esp32-s3', pinName: '3V3.2' },
        end: { componentId: 's3-pot1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 's3pt-gnd',
        start: { componentId: 'esp32-s3', pinName: 'GND.2' },
        end: { componentId: 's3-pot1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 's3pt-sig',
        start: { componentId: 'esp32-s3', pinName: '1' },
        end: { componentId: 's3-pot1', pinName: 'SIG' },
        color: '#aa44ff',
      },
    ],
  },

  // ─── ESP32-C3 ─────────────────────────────────────────────────────────────
  {
    id: 'c3-ili9341',
    title: 'ESP32-C3: ILI9341 TFT Display (SPI)',
    description:
      'Draws a filled screen, a rounded rectangle and text on a 320x240 ILI9341 TFT from an ESP32-C3 over hardware SPI (FSPI: SCK=4, MISO=5, MOSI=6, CS=7).',
    category: 'displays',
    difficulty: 'intermediate',
    libraries: ['Adafruit ILI9341', 'Adafruit GFX Library'],
    boardType: 'esp32-c3',
    boardFilter: 'esp32-c3',
    tags: ['esp32-c3', 'ili9341', 'tft', 'spi', 'display'],
    code: `// ILI9341 320x240 TFT on ESP32-C3 hardware SPI (FSPI)
// SCK=4 MISO=5 MOSI=6 CS=7 are the arduino-esp32 C3 default SPI pins.
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>

#define TFT_SCK   4
#define TFT_MISO  5
#define TFT_MOSI  6
#define TFT_CS    7
#define TFT_DC    3
#define TFT_RST  10

Adafruit_ILI9341 tft = Adafruit_ILI9341(TFT_CS, TFT_DC, TFT_RST);

void setup() {
  Serial.begin(115200);
  SPI.begin(TFT_SCK, TFT_MISO, TFT_MOSI, TFT_CS);
  tft.begin();
  tft.setRotation(1);

  tft.fillScreen(ILI9341_NAVY);
  tft.fillRoundRect(20, 30, 280, 90, 10, ILI9341_RED);

  tft.setCursor(38, 55);
  tft.setTextColor(ILI9341_WHITE);
  tft.setTextSize(4);
  tft.println("ESP32-C3");

  tft.setCursor(38, 150);
  tft.setTextColor(ILI9341_YELLOW);
  tft.setTextSize(2);
  tft.println("TFT via FSPI");

  Serial.println("tft drawn");
}

void loop() {
  delay(2000);
}`,
    components: [
      { type: 'wokwi-ili9341', id: 'c3-tft1', x: 470, y: 70, properties: {} },
    ],
    wires: [
      { id: 'c3tft-sck',  start: { componentId: 'esp32-c3', pinName: '4' }, end: { componentId: 'c3-tft1', pinName: 'SCK'  }, color: '#ff8800' },
      { id: 'c3tft-mosi', start: { componentId: 'esp32-c3', pinName: '6' }, end: { componentId: 'c3-tft1', pinName: 'MOSI' }, color: '#ff8800' },
      { id: 'c3tft-miso', start: { componentId: 'esp32-c3', pinName: '5' }, end: { componentId: 'c3-tft1', pinName: 'MISO' }, color: '#ffaa44' },
      { id: 'c3tft-cs',   start: { componentId: 'esp32-c3', pinName: '7' }, end: { componentId: 'c3-tft1', pinName: 'CS'   }, color: '#00aaff' },
      { id: 'c3tft-dc',   start: { componentId: 'esp32-c3', pinName: '3' }, end: { componentId: 'c3-tft1', pinName: 'D/C'  }, color: '#00cc00' },
      { id: 'c3tft-rst',  start: { componentId: 'esp32-c3', pinName: '10' }, end: { componentId: 'c3-tft1', pinName: 'RST' }, color: '#cc0000' },
      { id: 'c3tft-led',  start: { componentId: 'esp32-c3', pinName: '3V3.1' }, end: { componentId: 'c3-tft1', pinName: 'LED' }, color: '#ffffff' },
      { id: 'c3tft-vcc',  start: { componentId: 'esp32-c3', pinName: '3V3.2' }, end: { componentId: 'c3-tft1', pinName: 'VCC' }, color: '#ff0000' },
      { id: 'c3tft-gnd',  start: { componentId: 'esp32-c3', pinName: 'GND.1' }, end: { componentId: 'c3-tft1', pinName: 'GND' }, color: '#000000' },
    ],
  },
  {
    id: 'c3-oled-i2c',
    title: 'ESP32-C3: SSD1306 OLED Display',
    description:
      'Display text on a 128×64 SSD1306 OLED over I2C from the ESP32-C3 (default Wire pins SDA=GPIO8, SCL=GPIO9).',
    libraries: ['Adafruit SSD1306', 'Adafruit GFX Library', 'Adafruit BusIO'],
    category: 'displays',
    difficulty: 'intermediate',
    boardType: 'esp32-c3',
    boardFilter: 'esp32-c3',
    tags: ['esp32-c3', 'i2c', 'ssd1306', 'oled', 'display'],
    code: `// ESP32-C3 — SSD1306 OLED Display (I2C 128×64)
// Requires: Adafruit SSD1306, Adafruit GFX Library
// Wiring: SDA → GPIO8  |  SCL → GPIO9  |  VCC → 3V3  |  GND → GND
// GPIO8/9 are the arduino-esp32 default Wire pins on the C3 (GPIO8 is
// also a boot-strap pin — fine as I2C SDA, it idles HIGH).

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

int counter = 0;

void setup() {
  Serial.begin(115200);
  Wire.begin(8, 9);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 not found!");
    while (true) delay(10);
  }
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Hello");
  display.println("C3!");
  display.display();
  Serial.println("OLED ready!");
}

void loop() {
  counter++;
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Hello");
  display.println("C3!");
  display.setTextSize(1);
  display.setCursor(0, 48);
  display.printf("Count: %d", counter);
  display.display();
  Serial.printf("Frame: %d\\n", counter);
  delay(1000);
}`,
    components: [{ type: 'wokwi-ssd1306', id: 'c3-oled1', x: 420, y: 130, properties: {} }],
    wires: [
      {
        id: 'c3o-vcc',
        start: { componentId: 'esp32-c3', pinName: '3V3.1' },
        end: { componentId: 'c3-oled1', pinName: '3V3' },
        color: '#ff4444',
      },
      {
        id: 'c3o-gnd',
        start: { componentId: 'esp32-c3', pinName: 'GND.8' },
        end: { componentId: 'c3-oled1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'c3o-sda',
        start: { componentId: 'esp32-c3', pinName: '8' },
        end: { componentId: 'c3-oled1', pinName: 'DATA' },
        color: '#22aaff',
      },
      {
        id: 'c3o-scl',
        start: { componentId: 'esp32-c3', pinName: '9' },
        end: { componentId: 'c3-oled1', pinName: 'CLK' },
        color: '#ff8800',
      },
    ],
  },
  {
    id: 'c3-potentiometer',
    title: 'ESP32-C3: Potentiometer (ADC)',
    description:
      "Read a potentiometer with the ESP32-C3 12-bit ADC on GPIO0 (ADC1_CH0) and print the raw value and the calibrated voltage (analogReadMilliVolts). At the default 12 dB the C3 measures only up to about 2.73 V, so the top ~17 % of the pot's travel reads the same.",
    category: 'sensors',
    difficulty: 'beginner',
    boardType: 'esp32-c3',
    boardFilter: 'esp32-c3',
    tags: ['esp32-c3', 'adc', 'potentiometer', 'analog'],
    code: `// ESP32-C3 — Potentiometer on the ADC
// Pot: SIG → GPIO0 (ADC1_CH0)  |  VCC → 3V3  |  GND → GND

#define POT_PIN 0  // ADC1_CH0

void setup() {
  Serial.begin(115200);
  Serial.println("ESP32-C3 ADC ready — turn the pot!");
}

// At the default 12 dB attenuation the C3 measures only up to about 2.73 V
// (Espressif rates it for 0-2.5 V), so the last ~17 % of the pot's travel,
// from about 2.73 V to 3.3 V, reads the same: 4095 and about 2.73 V. The
// voltage comes from analogReadMilliVolts() (factory calibration), not
// a straight 3.3/4095 scaling, which is wrong everywhere on this chip.

void loop() {
  int raw = analogRead(POT_PIN);           // raw 12-bit code
  float volts = analogReadMilliVolts(POT_PIN) / 1000.0f;
  Serial.printf("Pot: %4d  (%.2f V)\\n", raw, volts);
  delay(200);
}`,
    components: [
      { type: 'wokwi-potentiometer', id: 'c3-pot1', x: 420, y: 200, properties: {} },
    ],
    wires: [
      {
        id: 'c3pt-vcc',
        start: { componentId: 'esp32-c3', pinName: '3V3.2' },
        end: { componentId: 'c3-pot1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'c3pt-gnd',
        start: { componentId: 'esp32-c3', pinName: 'GND.3' },
        end: { componentId: 'c3-pot1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'c3pt-sig',
        start: { componentId: 'esp32-c3', pinName: '0' },
        end: { componentId: 'c3-pot1', pinName: 'SIG' },
        color: '#aa44ff',
      },
    ],
  },

];

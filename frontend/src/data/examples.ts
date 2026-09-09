/**
 * Arduino Example Projects
 *
 * Collection of example projects that users can load and run
 */

import { circuitExamples } from './examples-circuits';
import { analogExamples } from './examples-analog';
import { digitalExamples } from './examples-digital';
import { hundredDaysExamples } from './examples-100-days';
// Pro overlay examples (the Pico W WiFi showcase) — resolves to the real list
// when built with the overlay (VITE_PRO_BUILD), else an empty stub in OSS.
// Static import so the build-time SSR prerender + gallery + sitemap pick them
// up. See pro/frontend/src/pro/data/proExamples.ts (overlay) and
// src/__pro_stub__/data/proExamples.ts (OSS no-op).
import { proExamples } from '@pro/data/proExamples';
import { epaperExamples } from './examples-displays-epaper';
import { retroIntelExamples } from './examples-retro-intel';
import { robotDesktopExamples } from './examples-robot-desktop';
import { microsdExamples } from './examples-storage-microsd';
import { infraredExamples } from './examples-infrared';
import { esp32MqttExamples } from './examples-esp32-mqtt';
import { esp32s3TftExamples } from './examples-esp32s3-tft';
import { jsemuChipExamples } from './examples-jsemu-chips';

/** Per-board setup for multi-board examples */
export interface ExampleBoard {
  /** Must match a BoardKind — determines the board instance ID (first board of a kind → boardKind string) */
  boardKind: string;
  x: number;
  y: number;
  /** Arduino/firmware code loaded into this board's file group */
  code?: string;
  /** Full multi-file workspace for this board's file group. Names may carry
   *  '/' folder paths ("apps/badge/__init__.py") — the explorer renders them
   *  as a tree. Takes precedence over `code`; the FIRST entry becomes the
   *  active/main file, so lead with the sketch. */
  files?: Array<{ name: string; content: string }>;
  /** Files pre-loaded into the Pi VFS (path → content). Only used for raspberry-pi-3. */
  vfsFiles?: Record<string, string>;
  /** Uploads pre-loaded onto a board's BUILT-IN microSD slot (a ProBoardDef
   *  with builtInSdCsPin, e.g. the XIAO ESP32S3 Sense) — the same shape the
   *  SD Card panel persists on board.sdFiles. */
  sdFiles?: Array<{ name: string; contentB64: string }>;
}

export interface ExampleProject {
  id: string;
  title: string;
  description: string;
  category: 'basics' | 'sensors' | 'displays' | 'communication' | 'games' | 'robotics' | 'circuits';
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  /** Target board — defaults to 'arduino-uno' if omitted. Ignored when boards[] is set. */
  boardType?:
    | 'arduino-uno'
    | 'arduino-nano'
    | 'arduino-mega'
    | 'raspberry-pi-pico'
    | 'pi-pico-w'
    | 'esp32'
    | 'esp32-s3'
    | 'esp32-c3'
    | 'esp32-cam'
    // Overlay-registered boards (proBoardRegistry) use their kind string.
    | (string & {});
  /** Board filter key used in the gallery board selector. Derived from boardType if omitted. */
  boardFilter?: string;
  /**
   * Multi-board setup. When present, ALL boards are replaced with these entries.
   * Board instance IDs are deterministic: first board of a kind uses boardKind as its ID.
   * Wire componentIds reference these IDs directly.
   */
  boards?: ExampleBoard[];
  /** Code for single-board examples (ignored when boards[] is set, or when files[] is provided). */
  code: string;
  /**
   * Optional language mode for the active board. When 'micropython' or
   * 'espidf', loadExample switches the board into that mode before
   * populating files.
   */
  languageMode?: 'arduino' | 'micropython' | 'espidf';
  /**
   * Optional multi-file payload for single-board examples. When present it
   * overrides ``code`` — every entry is loaded into the active file group as-is.
   * Used by the MicroPython gallery to ship projects that have main.py plus
   * helper modules (ssd1306.py, BlynkLib.py, …).
   */
  files?: Array<{ name: string; content: string }>;
  /** Free-form tags surfaced in the gallery search box (board kind, sensors, protocol, …). */
  tags?: string[];
  components: Array<{
    type: string;
    id: string;
    x: number;
    y: number;
    properties: Record<string, any>;
  }>;
  wires: Array<{
    id: string;
    start: { componentId: string; pinName: string };
    end: { componentId: string; pinName: string };
    color: string;
  }>;
  thumbnail?: string;
  /** Arduino libraries required by this example (auto-installed when loading). */
  libraries?: string[];
}

const legacyExamples: ExampleProject[] = [
  // ── SSD1306 OLED — 4-pin I2C module (velxio-ssd1306-i2c-4pin) across boards.
  //    The cheap GND/VCC/SCL/SDA module beginners actually own (issue #215). ──
  {
    id: 'uno-oled-4pin-i2c',
    title: 'Arduino Uno: SSD1306 OLED (4-pin I2C)',
    description:
      'Drive the cheap 4-pin SSD1306 OLED module (GND/VCC/SCL/SDA) over I2C from an Arduino Uno (SDA=A4, SCL=A5). Shows "Hello Velxio!" with a live counter.',
    libraries: ['Adafruit SSD1306', 'Adafruit GFX Library'],
    category: 'displays',
    difficulty: 'intermediate',
    boardFilter: 'arduino-uno',
    boards: [
      {
        boardKind: 'arduino-uno',
        x: 60,
        y: 60,
        code: `// Arduino Uno — SSD1306 128x64 OLED (4-pin I2C module)
// Wiring: SDA -> A4  |  SCL -> A5  |  VCC -> 5V  |  GND -> GND
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);
int n = 0;

void setup() {
  Serial.begin(115200);
  Wire.begin();
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 not found!");
    while (true) delay(10);
  }
  display.clearDisplay();
  Serial.println("OLED ready");
}

void loop() {
  n++;
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Hello");
  display.println("Velxio!");
  display.setTextSize(1);
  display.setCursor(0, 48);
  display.print("Count: ");
  display.print(n);
  display.display();
  delay(500);
}`,
      },
    ],
    code: '',
    components: [{ type: 'velxio-ssd1306-i2c-4pin', id: 'oled', x: 470, y: 100, properties: {} }],
    wires: [
      {
        id: 'w-vcc',
        start: { componentId: 'arduino-uno', pinName: '5V' },
        end: { componentId: 'oled', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'w-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND.2' },
        end: { componentId: 'oled', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w-sda',
        start: { componentId: 'arduino-uno', pinName: 'A4' },
        end: { componentId: 'oled', pinName: 'SDA' },
        color: '#22aaff',
      },
      {
        id: 'w-scl',
        start: { componentId: 'arduino-uno', pinName: 'A5' },
        end: { componentId: 'oled', pinName: 'SCL' },
        color: '#ff8800',
      },
    ],
  },
  {
    id: 'esp32-oled-4pin-i2c',
    title: 'ESP32: SSD1306 OLED (4-pin I2C)',
    description:
      'Drive the cheap 4-pin SSD1306 OLED module (GND/VCC/SCL/SDA) over I2C from an ESP32 (SDA=21, SCL=22).',
    libraries: ['Adafruit SSD1306', 'Adafruit GFX Library', 'Adafruit BusIO'],
    category: 'displays',
    difficulty: 'intermediate',
    boardFilter: 'esp32',
    boards: [
      {
        boardKind: 'esp32',
        x: 60,
        y: 60,
        code: `// ESP32 — SSD1306 128x64 OLED (4-pin I2C module)
// Wiring: SDA -> 21  |  SCL -> 22  |  VCC -> 3V3  |  GND -> GND
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);
int n = 0;

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 not found!");
    while (true) delay(10);
  }
  display.clearDisplay();
  Serial.println("OLED ready");
}

void loop() {
  n++;
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Hello");
  display.println("Velxio!");
  display.setTextSize(1);
  display.setCursor(0, 48);
  display.printf("Count: %d", n);
  display.display();
  delay(500);
}`,
      },
    ],
    code: '',
    components: [{ type: 'velxio-ssd1306-i2c-4pin', id: 'oled', x: 470, y: 100, properties: {} }],
    wires: [
      {
        id: 'w-vcc',
        start: { componentId: 'esp32', pinName: '3V3' },
        end: { componentId: 'oled', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'w-gnd',
        start: { componentId: 'esp32', pinName: 'GND' },
        end: { componentId: 'oled', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w-sda',
        start: { componentId: 'esp32', pinName: '21' },
        end: { componentId: 'oled', pinName: 'SDA' },
        color: '#22aaff',
      },
      {
        id: 'w-scl',
        start: { componentId: 'esp32', pinName: '22' },
        end: { componentId: 'oled', pinName: 'SCL' },
        color: '#ff8800',
      },
    ],
  },
  // ── MicroPython libraries are files (no Library Manager, no requirements) ──
  {
    id: 'esp32-micropython-external-library',
    title: 'ESP32 + MicroPython: use an external library',
    description:
      "How a MicroPython project uses a library in Velxio: there is no requirements.txt and no package manager — the driver is a .py file in the workspace. Every file here is copied onto the board's filesystem before main.py runs, so `import ssd1306` picks up the ssd1306.py next to it and draws on the wired OLED. The toolbar's Library Manager installs ARDUINO libraries and has no effect in MicroPython mode.",
    category: 'displays',
    difficulty: 'beginner',
    boardType: 'esp32',
    languageMode: 'micropython',
    tags: ['esp32', 'micropython', 'library', 'module', 'import', 'ssd1306', 'oled', 'i2c'],
    code: '',
    files: [
      {
        name: 'main.py',
        content: `# ESP32 + MicroPython: use an external library.
#
# MicroPython has no Library Manager here: a library IS a .py file in the
# project. Every file in this workspace is written to the board's filesystem
# before main.py runs, so the "import ssd1306" below resolves to the ssd1306.py
# sitting next to this file (open it in the explorer). To use another driver,
# add a new file and paste it in - that is the whole mechanism.
#
# (The toolbar's Library Manager installs ARDUINO libraries. In MicroPython
# mode it has no effect on the run.)
from machine import Pin, I2C
import ssd1306
import time

# Velxio decodes the hardware I2C controller (no bit-banged buses):
# ESP32 SDA = GPIO21, SCL = GPIO22.
i2c = I2C(0, sda=Pin(21), scl=Pin(22))
oled = ssd1306.SSD1306_I2C(128, 64, i2c)

n = 0
while True:
    oled.fill(0)
    oled.text("ssd1306.py", 0, 0)
    oled.text("imported OK", 0, 12)
    oled.text("count: {}".format(n), 0, 32)
    oled.text("MicroPython", 0, 52)
    oled.show()
    print("tick", n)
    n += 1
    time.sleep(1)`,
      },
      {
        // The stock MicroPython firmware ships no display drivers, so the
        // project carries the one it needs: micropython-lib's ssd1306 driver,
        // unmodified. This is exactly what a user would paste in.
        name: 'ssd1306.py',
        content: `# MicroPython SSD1306 OLED driver, I2C and SPI interfaces

from micropython import const
import framebuf


# register definitions
SET_CONTRAST = const(0x81)
SET_ENTIRE_ON = const(0xA4)
SET_NORM_INV = const(0xA6)
SET_DISP = const(0xAE)
SET_MEM_ADDR = const(0x20)
SET_COL_ADDR = const(0x21)
SET_PAGE_ADDR = const(0x22)
SET_DISP_START_LINE = const(0x40)
SET_SEG_REMAP = const(0xA0)
SET_MUX_RATIO = const(0xA8)
SET_COM_OUT_DIR = const(0xC0)
SET_DISP_OFFSET = const(0xD3)
SET_COM_PIN_CFG = const(0xDA)
SET_DISP_CLK_DIV = const(0xD5)
SET_PRECHARGE = const(0xD9)
SET_VCOM_DESEL = const(0xDB)
SET_CHARGE_PUMP = const(0x8D)

# Subclassing FrameBuffer provides support for graphics primitives
# http://docs.micropython.org/en/latest/pyboard/library/framebuf.html
class SSD1306(framebuf.FrameBuffer):
    def __init__(self, width, height, external_vcc):
        self.width = width
        self.height = height
        self.external_vcc = external_vcc
        self.pages = self.height // 8
        self.buffer = bytearray(self.pages * self.width)
        super().__init__(self.buffer, self.width, self.height, framebuf.MONO_VLSB)
        self.init_display()

    def init_display(self):
        for cmd in (
            SET_DISP | 0x00,  # off
            # address setting
            SET_MEM_ADDR,
            0x00,  # horizontal
            # resolution and layout
            SET_DISP_START_LINE | 0x00,
            SET_SEG_REMAP | 0x01,  # column addr 127 mapped to SEG0
            SET_MUX_RATIO,
            self.height - 1,
            SET_COM_OUT_DIR | 0x08,  # scan from COM[N] to COM0
            SET_DISP_OFFSET,
            0x00,
            SET_COM_PIN_CFG,
            0x02 if self.width > 2 * self.height else 0x12,
            # timing and driving scheme
            SET_DISP_CLK_DIV,
            0x80,
            SET_PRECHARGE,
            0x22 if self.external_vcc else 0xF1,
            SET_VCOM_DESEL,
            0x30,  # 0.83*Vcc
            # display
            SET_CONTRAST,
            0xFF,  # maximum
            SET_ENTIRE_ON,  # output follows RAM contents
            SET_NORM_INV,  # not inverted
            # charge pump
            SET_CHARGE_PUMP,
            0x10 if self.external_vcc else 0x14,
            SET_DISP | 0x01,
        ):  # on
            self.write_cmd(cmd)
        self.fill(0)
        self.show()

    def poweroff(self):
        self.write_cmd(SET_DISP | 0x00)

    def poweron(self):
        self.write_cmd(SET_DISP | 0x01)

    def contrast(self, contrast):
        self.write_cmd(SET_CONTRAST)
        self.write_cmd(contrast)

    def invert(self, invert):
        self.write_cmd(SET_NORM_INV | (invert & 1))

    def show(self):
        x0 = 0
        x1 = self.width - 1
        if self.width == 64:
            # displays with width of 64 pixels are shifted by 32
            x0 += 32
            x1 += 32
        self.write_cmd(SET_COL_ADDR)
        self.write_cmd(x0)
        self.write_cmd(x1)
        self.write_cmd(SET_PAGE_ADDR)
        self.write_cmd(0)
        self.write_cmd(self.pages - 1)
        self.write_data(self.buffer)


class SSD1306_I2C(SSD1306):
    def __init__(self, width, height, i2c, addr=0x3C, external_vcc=False):
        self.i2c = i2c
        self.addr = addr
        self.temp = bytearray(2)
        self.write_list = [b"\\x40", None]  # Co=0, D/C#=1
        super().__init__(width, height, external_vcc)

    def write_cmd(self, cmd):
        self.temp[0] = 0x80  # Co=1, D/C#=0
        self.temp[1] = cmd
        self.i2c.writeto(self.addr, self.temp)

    def write_data(self, buf):
        self.write_list[1] = buf
        self.i2c.writevto(self.addr, self.write_list)


class SSD1306_SPI(SSD1306):
    def __init__(self, width, height, spi, dc, res, cs, external_vcc=False):
        self.rate = 10 * 1024 * 1024
        dc.init(dc.OUT, value=0)
        res.init(res.OUT, value=0)
        cs.init(cs.OUT, value=1)
        self.spi = spi
        self.dc = dc
        self.res = res
        self.cs = cs
        import time

        self.res(1)
        time.sleep_ms(1)
        self.res(0)
        time.sleep_ms(10)
        self.res(1)
        super().__init__(width, height, external_vcc)

    def write_cmd(self, cmd):
        self.spi.init(baudrate=self.rate, polarity=0, phase=0)
        self.cs(1)
        self.dc(0)
        self.cs(0)
        self.spi.write(bytearray([cmd]))
        self.cs(1)

    def write_data(self, buf):
        self.spi.init(baudrate=self.rate, polarity=0, phase=0)
        self.cs(1)
        self.dc(1)
        self.cs(0)
        self.spi.write(buf)
        self.cs(1)`,
      },
    ],
    components: [{ type: 'velxio-ssd1306-i2c-4pin', id: 'oled', x: 470, y: 100, properties: {} }],
    wires: [
      {
        id: 'w-vcc',
        start: { componentId: 'esp32', pinName: '3V3' },
        end: { componentId: 'oled', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'w-gnd',
        start: { componentId: 'esp32', pinName: 'GND' },
        end: { componentId: 'oled', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w-sda',
        start: { componentId: 'esp32', pinName: '21' },
        end: { componentId: 'oled', pinName: 'SDA' },
        color: '#22aaff',
      },
      {
        id: 'w-scl',
        start: { componentId: 'esp32', pinName: '22' },
        end: { componentId: 'oled', pinName: 'SCL' },
        color: '#ff8800',
      },
    ],
  },
  // ── Pure ESP-IDF (issue #139): user app_main(), no Arduino core. ──
  {
    id: 'esp32-idf-blink',
    title: 'ESP32: Pure ESP-IDF Blink',
    description:
      'Blink an LED from a pure ESP-IDF project — app_main(), FreeRTOS delays and the GPIO driver, no Arduino core. Pick "ESP-IDF" in the language selector to write more projects like this.',
    category: 'basics',
    difficulty: 'intermediate',
    boardType: 'esp32',
    languageMode: 'espidf',
    tags: ['esp32', 'esp-idf', 'freertos', 'gpio'],
    code: '',
    files: [
      {
        name: 'main.c',
        content: `// Pure ESP-IDF blink — no Arduino core, just IDF APIs.
// app_main() is the ESP-IDF entry point (instead of setup()/loop()).
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "esp_log.h"

#define LED_PIN GPIO_NUM_2

static const char *TAG = "blink";

void app_main(void)
{
    ESP_LOGI(TAG, "ESP-IDF blink starting");
    gpio_reset_pin(LED_PIN);
    gpio_set_direction(LED_PIN, GPIO_MODE_OUTPUT);

    int level = 0;
    while (1) {
        level = !level;
        gpio_set_level(LED_PIN, level);
        ESP_LOGI(TAG, "LED %s", level ? "on" : "off");
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
`,
      },
    ],
    components: [
      // 220R keeps the LED under its 20 mA rating on a 3.3 V GPIO.
      { type: 'wokwi-resistor', id: 'r-led', x: 340, y: 120, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'led-ext', x: 470, y: 100, properties: { color: 'red' } },
    ],
    wires: [
      {
        id: 'w-gpio2-r',
        start: { componentId: 'esp32', pinName: '2' },
        end: { componentId: 'r-led', pinName: '1' },
        color: '#e74c3c',
      },
      {
        id: 'w-r-led',
        start: { componentId: 'r-led', pinName: '2' },
        end: { componentId: 'led-ext', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w-gnd',
        start: { componentId: 'led-ext', pinName: 'C' },
        end: { componentId: 'esp32', pinName: 'GND' },
        color: '#2c3e50',
      },
    ],
  },
  {
    id: 'pico-oled-4pin-i2c',
    title: 'Raspberry Pi Pico: SSD1306 OLED (4-pin I2C)',
    description:
      'Drive the cheap 4-pin SSD1306 OLED module (GND/VCC/SCL/SDA) over I2C from a Raspberry Pi Pico (SDA=GP4, SCL=GP5).',
    libraries: ['Adafruit SSD1306', 'Adafruit GFX Library'],
    category: 'displays',
    difficulty: 'intermediate',
    boardFilter: 'raspberry-pi-pico',
    boards: [
      {
        boardKind: 'raspberry-pi-pico',
        x: 60,
        y: 60,
        code: `// Raspberry Pi Pico — SSD1306 128x64 OLED (4-pin I2C module)
// Wiring: SDA -> GP4  |  SCL -> GP5  |  VCC -> 3V3  |  GND -> GND
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);
int n = 0;

void setup() {
  Serial.begin(115200);
  Wire.setSDA(4);
  Wire.setSCL(5);
  Wire.begin();
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 not found!");
    while (true) delay(10);
  }
  display.clearDisplay();
  Serial.println("OLED ready");
}

void loop() {
  n++;
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Hello");
  display.println("Velxio!");
  display.setTextSize(1);
  display.setCursor(0, 48);
  display.print("Count: ");
  display.print(n);
  display.display();
  delay(500);
}`,
      },
    ],
    code: '',
    components: [{ type: 'velxio-ssd1306-i2c-4pin', id: 'oled', x: 470, y: 100, properties: {} }],
    wires: [
      {
        id: 'w-vcc',
        start: { componentId: 'raspberry-pi-pico', pinName: '3V3' },
        end: { componentId: 'oled', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'w-gnd',
        start: { componentId: 'raspberry-pi-pico', pinName: 'GND.3' },
        end: { componentId: 'oled', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w-sda',
        start: { componentId: 'raspberry-pi-pico', pinName: 'GP4' },
        end: { componentId: 'oled', pinName: 'SDA' },
        color: '#22aaff',
      },
      {
        id: 'w-scl',
        start: { componentId: 'raspberry-pi-pico', pinName: 'GP5' },
        end: { componentId: 'oled', pinName: 'SCL' },
        color: '#ff8800',
      },
    ],
  },
  {
    id: 'stm32-oled-4pin-i2c',
    title: 'STM32 Blue Pill: SSD1306 OLED (4-pin I2C)',
    description:
      'Drive the cheap 4-pin SSD1306 OLED module (GND/VCC/SCL/SDA) over I2C1 from an STM32 Blue Pill (SDA=PB7, SCL=PB6).',
    libraries: ['Adafruit SSD1306', 'Adafruit GFX Library'],
    category: 'displays',
    difficulty: 'intermediate',
    boardFilter: 'stm32-bluepill',
    boards: [
      {
        boardKind: 'stm32-bluepill',
        x: 60,
        y: 60,
        code: `// STM32 Blue Pill (F103) — SSD1306 128x64 OLED (4-pin I2C module)
// Wiring: SDA -> PB7  |  SCL -> PB6  |  VCC -> 3V3  |  GND -> GND
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);
int n = 0;

void setup() {
  Serial.begin(115200);
  Wire.begin();
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 not found!");
    while (true) delay(10);
  }
  display.clearDisplay();
  Serial.println("OLED ready");
}

void loop() {
  n++;
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Hello");
  display.println("Velxio!");
  display.setTextSize(1);
  display.setCursor(0, 48);
  display.print("Count: ");
  display.print(n);
  display.display();
  delay(500);
}`,
      },
    ],
    code: '',
    components: [{ type: 'velxio-ssd1306-i2c-4pin', id: 'oled', x: 470, y: 100, properties: {} }],
    wires: [
      {
        id: 'w-vcc',
        start: { componentId: 'stm32-bluepill', pinName: '3V3' },
        end: { componentId: 'oled', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'w-gnd',
        start: { componentId: 'stm32-bluepill', pinName: 'GND' },
        end: { componentId: 'oled', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w-sda',
        start: { componentId: 'stm32-bluepill', pinName: 'PB7' },
        end: { componentId: 'oled', pinName: 'SDA' },
        color: '#22aaff',
      },
      {
        id: 'w-scl',
        start: { componentId: 'stm32-bluepill', pinName: 'PB6' },
        end: { componentId: 'oled', pinName: 'SCL' },
        color: '#ff8800',
      },
    ],
  },
  {
    id: 'ky-040-rotary-encoder',
    title: 'KY-040 Rotary Encoder',
    description:
      'Read a KY-040 rotary encoder with an Arduino Uno. Turn the knob to move a counter (CLK/DT quadrature) and press the shaft (SW) to reset it. Open the Serial Monitor to watch the position.',
    category: 'basics',
    difficulty: 'beginner',
    boardType: 'arduino-uno',
    boardFilter: 'arduino-uno',
    code: `// KY-040 rotary encoder — turn the knob to move the counter,
// press the shaft (SW) to reset. The encoder drives CLK/DT in quadrature;
// we sample DT on each CLK rising edge to get the direction.
const int PIN_CLK = 2;   // CLK (A)
const int PIN_DT  = 3;   // DT  (B)
const int PIN_SW  = 4;   // SW  (push button, active LOW)

int counter = 0;
int lastClk = HIGH;

void setup() {
  pinMode(PIN_CLK, INPUT_PULLUP);
  pinMode(PIN_DT, INPUT_PULLUP);
  pinMode(PIN_SW, INPUT_PULLUP);
  Serial.begin(115200);
  Serial.println("KY-040 rotary encoder ready");
  lastClk = digitalRead(PIN_CLK);
}

void loop() {
  int clk = digitalRead(PIN_CLK);
  if (clk != lastClk && clk == HIGH) {      // CLK rising edge
    if (digitalRead(PIN_DT) == LOW) {
      counter++;                            // DT LOW  -> clockwise
    } else {
      counter--;                            // DT HIGH -> counter-clockwise
    }
    Serial.print("position: ");
    Serial.println(counter);
  }
  lastClk = clk;

  if (digitalRead(PIN_SW) == LOW) {
    counter = 0;
    Serial.println("button pressed -> reset");
    delay(200);                             // simple debounce
  }
}`,
    components: [{ type: 'wokwi-ky-040', id: 'enc1', x: 360, y: 90, properties: {} }],
    wires: [
      {
        id: 'w-enc-clk',
        start: { componentId: 'enc1', pinName: 'CLK' },
        end: { componentId: 'arduino-uno', pinName: '2' },
        color: '#f59e0b',
      },
      {
        id: 'w-enc-dt',
        start: { componentId: 'enc1', pinName: 'DT' },
        end: { componentId: 'arduino-uno', pinName: '3' },
        color: '#10b981',
      },
      {
        id: 'w-enc-sw',
        start: { componentId: 'enc1', pinName: 'SW' },
        end: { componentId: 'arduino-uno', pinName: '4' },
        color: '#3b82f6',
      },
      {
        id: 'w-enc-vcc',
        start: { componentId: 'enc1', pinName: 'VCC' },
        end: { componentId: 'arduino-uno', pinName: '5V' },
        color: '#ef4444',
      },
      {
        id: 'w-enc-gnd',
        start: { componentId: 'enc1', pinName: 'GND' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#1f2937',
      },
    ],
    tags: ['rotary', 'encoder', 'ky-040', 'input', 'knob', 'arduino'],
  },
  {
    id: 'stm32-bluepill-blink',
    title: 'STM32 Blue Pill Blink',
    description:
      'Blink the onboard PC13 LED and print to Serial on an STM32F103 Blue Pill (QEMU / libqemu-arm)',
    category: 'basics',
    difficulty: 'beginner',
    boardFilter: 'stm32-bluepill',
    boards: [
      {
        boardKind: 'stm32-bluepill',
        x: 100,
        y: 100,
        code: `// STM32 Blue Pill (STM32F103C8) blink + serial
// Onboard LED is on PC13 (active LOW). Runs under QEMU via libqemu-arm.

void setup() {
  pinMode(PC13, OUTPUT);
  Serial.begin(115200);
  Serial.println("velxio stm32 blink");
}

void loop() {
  digitalWrite(PC13, HIGH);
  delay(200);
  digitalWrite(PC13, LOW);
  delay(200);
}`,
      },
    ],
    code: '',
    components: [],
    wires: [],
    tags: ['stm32', 'blue pill', 'f103', 'qemu', 'blink', 'cortex-m3'],
  },
  {
    id: 'stm32-bluepill-serial-counter',
    title: 'STM32 Serial Counter',
    description:
      'STM32 Blue Pill prints an incrementing counter and uptime to Serial every second. Open the Serial Monitor to watch it. Onboard PC13 LED blinks as a heartbeat.',
    category: 'communication',
    difficulty: 'beginner',
    boardFilter: 'stm32-bluepill',
    boards: [
      {
        boardKind: 'stm32-bluepill',
        x: 100,
        y: 100,
        code: `// STM32 Blue Pill — serial counter (USART1, 115200 baud)
unsigned long n = 0;

void setup() {
  Serial.begin(115200);
  pinMode(PC13, OUTPUT);
  Serial.println("STM32 Blue Pill ready");
}

void loop() {
  n++;
  Serial.print("count=");
  Serial.print(n);
  Serial.print("  uptime_ms=");
  Serial.println(millis());
  digitalWrite(PC13, n % 2 ? HIGH : LOW);  // heartbeat
  delay(1000);
}`,
      },
    ],
    code: '',
    components: [],
    wires: [],
    tags: ['stm32', 'blue pill', 'serial', 'usart', 'qemu'],
  },
  {
    id: 'stm32-f4-discovery-blink',
    title: 'STM32F4 Discovery LED Blink',
    description:
      'Blink the onboard PD12 green LED and print to Serial on an STM32F4 Discovery (STM32F407VG, Cortex-M4) under QEMU.',
    category: 'basics',
    difficulty: 'beginner',
    boardFilter: 'stm32-f4-discovery',
    boards: [
      {
        boardKind: 'stm32-f4-discovery',
        x: 100,
        y: 100,
        code: `// STM32F4 Discovery (STM32F407VG) — onboard LEDs PD12..PD15 (active HIGH).
// PD12 green, PD13 orange, PD14 red, PD15 blue. Runs under QEMU (libqemu-arm).

void setup() {
  pinMode(PD12, OUTPUT);
  Serial.begin(115200);
  Serial.println("velxio stm32f4 discovery");
}

void loop() {
  digitalWrite(PD12, HIGH);
  delay(200);
  digitalWrite(PD12, LOW);
  delay(200);
}`,
      },
    ],
    code: '',
    components: [],
    wires: [],
    tags: ['stm32', 'discovery', 'f407', 'cortex-m4', 'qemu', 'blink'],
  },
  {
    id: 'stm32-olimex-h405-blink',
    title: 'Olimex STM32-H405 Blink',
    description:
      'Blink the onboard PC12 status LED and print to Serial on an Olimex STM32-H405 (STM32F405RG, Cortex-M4) under QEMU.',
    category: 'basics',
    difficulty: 'beginner',
    boardFilter: 'stm32-olimex-h405',
    boards: [
      {
        boardKind: 'stm32-olimex-h405',
        x: 100,
        y: 100,
        code: `// Olimex STM32-H405 (STM32F405RG) — onboard status LED on PC12 (active HIGH).

void setup() {
  pinMode(PC12, OUTPUT);
  Serial.begin(115200);
  Serial.println("velxio olimex h405");
}

void loop() {
  digitalWrite(PC12, HIGH);
  delay(250);
  digitalWrite(PC12, LOW);
  delay(250);
}`,
      },
    ],
    code: '',
    components: [],
    wires: [],
    tags: ['stm32', 'olimex', 'h405', 'f405', 'cortex-m4', 'qemu'],
  },
  {
    id: 'stm32-netduino-plus2-blink',
    title: 'Netduino Plus 2 Blink',
    description:
      'Blink the onboard PA10 LED and print to Serial on a Netduino Plus 2 (STM32F405, Cortex-M4) under QEMU.',
    category: 'basics',
    difficulty: 'beginner',
    boardFilter: 'stm32-netduino-plus2',
    boards: [
      {
        boardKind: 'stm32-netduino-plus2',
        x: 100,
        y: 100,
        code: `// Netduino Plus 2 (STM32F405) — onboard LED on PA10 (active HIGH).

void setup() {
  pinMode(PA10, OUTPUT);
  Serial.begin(115200);
  Serial.println("velxio netduino plus 2");
}

void loop() {
  digitalWrite(PA10, HIGH);
  delay(300);
  digitalWrite(PA10, LOW);
  delay(300);
}`,
      },
    ],
    code: '',
    components: [],
    wires: [],
    tags: ['stm32', 'netduino', 'f405', 'cortex-m4', 'qemu', 'blink'],
  },
  {
    id: 'stm32-netduino2-serial',
    title: 'Netduino 2 Serial Counter',
    description:
      'Netduino 2 (STM32F205, Cortex-M3) prints an incrementing counter over Serial. GPIO/LED support arrives once the F205 SoC is wired; serial works today under QEMU.',
    category: 'communication',
    difficulty: 'beginner',
    boardFilter: 'stm32-netduino2',
    boards: [
      {
        boardKind: 'stm32-netduino2',
        x: 100,
        y: 100,
        code: `// Netduino 2 (STM32F205) — serial counter at 115200 baud.
// Onboard LED is on PA10; GPIO becomes visual once the F205 SoC is wired.
unsigned long n = 0;

void setup() {
  Serial.begin(115200);
  pinMode(PA10, OUTPUT);
  Serial.println("Netduino 2 ready");
}

void loop() {
  n++;
  Serial.print("count=");
  Serial.print(n);
  Serial.print("  uptime_ms=");
  Serial.println(millis());
  digitalWrite(PA10, n % 2 ? HIGH : LOW);
  delay(1000);
}`,
      },
    ],
    code: '',
    components: [],
    wires: [],
    tags: ['stm32', 'netduino', 'f205', 'serial', 'qemu'],
  },
  {
    id: 'stm32-blackpill-f401-blink',
    title: 'STM32 Black Pill (F401) Blink',
    description:
      'Blink the onboard PC13 LED and print to Serial on an STM32F401CE Black Pill (Cortex-M4) under QEMU.',
    category: 'basics',
    difficulty: 'beginner',
    boardFilter: 'stm32-blackpill-f401',
    boards: [
      {
        boardKind: 'stm32-blackpill-f401',
        x: 100,
        y: 100,
        code: `// STM32 Black Pill (STM32F401CE) — onboard LED on PC13 (active LOW).

void setup() {
  pinMode(PC13, OUTPUT);
  Serial.begin(115200);
  Serial.println("velxio stm32 f401 blackpill");
}

void loop() {
  digitalWrite(PC13, LOW);   // LED on
  delay(200);
  digitalWrite(PC13, HIGH);  // LED off
  delay(200);
}`,
      },
    ],
    code: '',
    components: [],
    wires: [],
    tags: ['stm32', 'black pill', 'f401', 'cortex-m4', 'qemu', 'blink'],
  },
  {
    id: 'stm32-bluepill-f103cb-blink',
    title: 'STM32 Blue Pill (F103CB) Blink',
    description:
      'Blink the onboard PC13 LED and print to Serial on an STM32F103CB Blue Pill (Cortex-M3, 128KB flash) under QEMU.',
    category: 'basics',
    difficulty: 'beginner',
    boardFilter: 'stm32-bluepill-f103cb',
    boards: [
      {
        boardKind: 'stm32-bluepill-f103cb',
        x: 100,
        y: 100,
        code: `// STM32 Blue Pill (STM32F103CB, 128KB flash) — onboard LED on PC13 (active LOW).

void setup() {
  pinMode(PC13, OUTPUT);
  Serial.begin(115200);
  Serial.println("velxio stm32 f103cb blue pill");
}

void loop() {
  digitalWrite(PC13, LOW);   // LED on
  delay(200);
  digitalWrite(PC13, HIGH);  // LED off
  delay(200);
}`,
      },
    ],
    code: '',
    components: [],
    wires: [],
    tags: ['stm32', 'blue pill', 'f103cb', 'cortex-m3', 'qemu', 'blink'],
  },
  {
    id: 'stm32-uno-gpio-mirror',
    title: '[STM32 + Arduino] GPIO Mirror',
    description:
      'Cross-board demo: the STM32 Blue Pill toggles PA1 every 500 ms (wired to Arduino Uno pin 2). The Uno reads pin 2 and mirrors it to its built-in LED (pin 13). Shows heterogeneous multi-board simulation — QEMU STM32 driving an avr8js Arduino.',
    category: 'communication',
    difficulty: 'intermediate',
    boardFilter: 'stm32-bluepill',
    boards: [
      {
        boardKind: 'stm32-bluepill',
        x: 80,
        y: 100,
        code: `// STM32 Blue Pill — drives PA1 as a 1 Hz square wave.
// Wiring: STM32 PA1 -> Uno pin 2,  STM32 GND -> Uno GND.
void setup() {
  pinMode(PA1, OUTPUT);
  pinMode(PC13, OUTPUT);
  Serial.begin(115200);
  Serial.println("STM32 driving PA1");
}

void loop() {
  digitalWrite(PA1, HIGH);
  digitalWrite(PC13, LOW);   // onboard LED on (active-low)
  Serial.println("PA1 -> HIGH");
  delay(500);
  digitalWrite(PA1, LOW);
  digitalWrite(PC13, HIGH);
  Serial.println("PA1 -> LOW");
  delay(500);
}`,
      },
      {
        boardKind: 'arduino-uno',
        x: 520,
        y: 100,
        code: `// Arduino Uno — reads pin 2 (from STM32 PA1) and mirrors to LED 13.
const int IN_PIN = 2;
void setup() {
  pinMode(IN_PIN, INPUT);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
  Serial.println("Uno mirroring pin 2 -> LED 13");
}
void loop() {
  int v = digitalRead(IN_PIN);
  digitalWrite(LED_BUILTIN, v);
  Serial.print("pin2=");
  Serial.println(v ? "HIGH" : "LOW");
  delay(100);
}`,
      },
    ],
    code: '',
    components: [],
    wires: [
      {
        id: 'w-pa1-d2',
        start: { componentId: 'stm32-bluepill', pinName: 'PA1' },
        end: { componentId: 'arduino-uno', pinName: '2' },
        color: '#22cc22',
      },
      {
        id: 'w-gnd',
        start: { componentId: 'stm32-bluepill', pinName: 'GND' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
    ],
    tags: ['stm32', 'arduino', 'multi-board', 'gpio', 'interconnect', 'qemu'],
  },
  {
    id: 'stm32-uno-serial-link',
    title: '[STM32 + Arduino] Serial Link',
    description:
      'Cross-board UART: the STM32 Blue Pill sends a "PING n" message over USART1 (PA9 TX) into the Arduino Uno RX (pin 0). The Uno reads each line and blinks LED 13 + echoes "[Uno] got: ..." to its own Serial Monitor. Watch both monitors.',
    category: 'communication',
    difficulty: 'intermediate',
    boardFilter: 'stm32-bluepill',
    boards: [
      {
        boardKind: 'stm32-bluepill',
        x: 80,
        y: 100,
        code: `// STM32 Blue Pill — sends PING over USART1 (PA9 = TX).
// Wiring: STM32 PA9 -> Uno pin 0 (RX),  STM32 GND -> Uno GND.
unsigned long n = 0;
void setup() {
  Serial.begin(9600);   // USART1
  pinMode(PC13, OUTPUT);
}
void loop() {
  n++;
  Serial.print("PING ");
  Serial.println(n);
  digitalWrite(PC13, n % 2 ? HIGH : LOW);
  delay(1000);
}`,
      },
      {
        boardKind: 'arduino-uno',
        x: 520,
        y: 100,
        code: `// Arduino Uno — receives lines from STM32 on RX (pin 0), blinks LED 13.
String buf;
void setup() {
  Serial.begin(9600);
  pinMode(LED_BUILTIN, OUTPUT);
}
void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\\n') {
      Serial.print("[Uno] got: ");
      Serial.println(buf);
      digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
      buf = "";
    } else if (c != '\\r') {
      buf += c;
    }
  }
}`,
      },
    ],
    code: '',
    components: [],
    wires: [
      {
        id: 'w-tx-rx',
        start: { componentId: 'stm32-bluepill', pinName: 'PA9' },
        end: { componentId: 'arduino-uno', pinName: '0' },
        color: '#ff8800',
      },
      {
        id: 'w-gnd',
        start: { componentId: 'stm32-bluepill', pinName: 'GND' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
    ],
    tags: ['stm32', 'arduino', 'multi-board', 'serial', 'uart', 'interconnect', 'qemu'],
  },
  {
    id: 'stm32-esp32-gpio-sync',
    title: '[STM32 + ESP32] GPIO Sync',
    description:
      'Cross-board demo: the STM32 Blue Pill toggles PA1 (wired to ESP32 GPIO4). The ESP32 reads GPIO4 and prints its state + mirrors it onto GPIO2. Two QEMU backends (libqemu-arm + libqemu-xtensa) talking over a wire.',
    category: 'communication',
    difficulty: 'advanced',
    boardFilter: 'stm32-bluepill',
    boards: [
      {
        boardKind: 'stm32-bluepill',
        x: 80,
        y: 100,
        code: `// STM32 Blue Pill — drives PA1 at 1 Hz.
// Wiring: STM32 PA1 -> ESP32 GPIO4,  STM32 GND -> ESP32 GND.
void setup() {
  pinMode(PA1, OUTPUT);
  pinMode(PC13, OUTPUT);
  Serial.begin(115200);
}
void loop() {
  digitalWrite(PA1, HIGH); digitalWrite(PC13, LOW);
  Serial.println("PA1 HIGH"); delay(700);
  digitalWrite(PA1, LOW);  digitalWrite(PC13, HIGH);
  Serial.println("PA1 LOW");  delay(700);
}`,
      },
      {
        boardKind: 'esp32',
        x: 520,
        y: 100,
        code: `// ESP32 — reads GPIO4 (from STM32 PA1), mirrors to GPIO2.
void setup() {
  pinMode(4, INPUT);
  pinMode(2, OUTPUT);
  Serial.begin(115200);
  Serial.println("ESP32 watching GPIO4");
}
void loop() {
  int v = digitalRead(4);
  digitalWrite(2, v);
  Serial.print("GPIO4=");
  Serial.println(v);
  delay(100);
}`,
      },
    ],
    code: '',
    components: [],
    wires: [
      {
        id: 'w-pa1-gpio4',
        start: { componentId: 'stm32-bluepill', pinName: 'PA1' },
        end: { componentId: 'esp32', pinName: '4' },
        color: '#22cc22',
      },
      {
        id: 'w-gnd',
        start: { componentId: 'stm32-bluepill', pinName: 'GND' },
        end: { componentId: 'esp32', pinName: 'GND' },
        color: '#000000',
      },
    ],
    tags: ['stm32', 'esp32', 'multi-board', 'gpio', 'interconnect', 'qemu'],
  },
  {
    id: 'stm32-blackpill-blink',
    title: 'STM32 Black Pill Blink',
    description:
      'Blink the onboard PC13 LED and print to Serial on an STM32F411 Black Pill (Cortex-M4, QEMU / libqemu-arm).',
    category: 'basics',
    difficulty: 'beginner',
    boardFilter: 'stm32-blackpill',
    boards: [
      {
        boardKind: 'stm32-blackpill',
        x: 100,
        y: 100,
        code: `// STM32 Black Pill (STM32F411CE, Cortex-M4) blink + serial.
// Onboard LED is on PC13 (active LOW).
void setup() {
  pinMode(PC13, OUTPUT);
  Serial.begin(115200);
  Serial.println("velxio black pill blink");
}

void loop() {
  digitalWrite(PC13, LOW);   // LED on (active-low)
  delay(150);
  digitalWrite(PC13, HIGH);  // LED off
  delay(150);
}`,
      },
    ],
    code: '',
    components: [],
    wires: [],
    tags: ['stm32', 'black pill', 'f411', 'cortex-m4', 'qemu', 'blink'],
  },
  {
    id: 'stm32-bluepill-blackpill-gpio',
    title: '[STM32 + STM32] Blue Pill → Black Pill',
    description:
      'Two different STM32 boards talking: the Blue Pill (F103) toggles PA1, wired to the Black Pill (F411) PA0. The Black Pill reads PA0 and mirrors it to its onboard PC13 LED. Both run on separate libqemu-arm QEMU instances.',
    category: 'communication',
    difficulty: 'intermediate',
    boardFilter: 'stm32-bluepill',
    boards: [
      {
        boardKind: 'stm32-bluepill',
        x: 80,
        y: 100,
        code: `// Blue Pill (F103) — drives PA1 at ~1.5 Hz.
// Wiring: BluePill PA1 -> BlackPill PA0,  GND -> GND.
void setup() {
  pinMode(PA1, OUTPUT);
  pinMode(PC13, OUTPUT);
  Serial.begin(115200);
}
void loop() {
  digitalWrite(PA1, HIGH); digitalWrite(PC13, LOW);
  Serial.println("PA1 HIGH"); delay(350);
  digitalWrite(PA1, LOW);  digitalWrite(PC13, HIGH);
  Serial.println("PA1 LOW");  delay(350);
}`,
      },
      {
        boardKind: 'stm32-blackpill',
        x: 480,
        y: 100,
        code: `// Black Pill (F411) — reads PA0 (from Blue Pill PA1), mirrors to PC13 LED.
void setup() {
  pinMode(PA0, INPUT);
  pinMode(PC13, OUTPUT);
  Serial.begin(115200);
  Serial.println("Black Pill watching PA0");
}
void loop() {
  int v = digitalRead(PA0);
  digitalWrite(PC13, v ? LOW : HIGH);  // PC13 active-low: LED on when PA0 HIGH
  Serial.print("PA0=");
  Serial.println(v ? "HIGH" : "LOW");
  delay(80);
}`,
      },
    ],
    code: '',
    components: [],
    wires: [
      {
        id: 'w-pa1-pa0',
        start: { componentId: 'stm32-bluepill', pinName: 'PA1' },
        end: { componentId: 'stm32-blackpill', pinName: 'PA0' },
        color: '#22cc22',
      },
      {
        id: 'w-gnd',
        start: { componentId: 'stm32-bluepill', pinName: 'GND' },
        end: { componentId: 'stm32-blackpill', pinName: 'GND' },
        color: '#000000',
      },
    ],
    tags: ['stm32', 'blue pill', 'black pill', 'multi-board', 'gpio', 'interconnect', 'qemu'],
  },
  {
    id: 'stm32-bluepill-bmp280',
    title: 'STM32: BMP280 Weather Sensor (I2C)',
    description:
      'Read temperature and pressure from a BMP280 over I2C1 on an STM32 Blue Pill (SCL=PB6, SDA=PB7). The sensor runs as a QEMU I2C slave; values stream to the Serial Monitor. Demonstrates the STM32 hardware I2C master peripheral end to end.',
    libraries: ['Adafruit BMP280 Library', 'Adafruit Unified Sensor'],
    category: 'sensors',
    difficulty: 'intermediate',
    boardFilter: 'stm32-bluepill',
    boards: [
      {
        boardKind: 'stm32-bluepill',
        x: 100,
        y: 90,
        code: `// STM32 Blue Pill (F103) — BMP280 over I2C1
// Wiring: SDA -> PB7  |  SCL -> PB6  |  VCC -> 3V3  |  GND -> GND
// Requires: Adafruit BMP280 Library, Adafruit Unified Sensor

#include <Wire.h>
#include <Adafruit_BMP280.h>

Adafruit_BMP280 bmp;   // I2C

void setup() {
  Serial.begin(115200);
  Wire.begin();        // I2C1: SCL=PB6, SDA=PB7
  if (!bmp.begin(0x76)) {
    Serial.println("BMP280 not found! Check wiring.");
    while (true) delay(10);
  }
  bmp.setSampling(Adafruit_BMP280::MODE_NORMAL,
                  Adafruit_BMP280::SAMPLING_X2,
                  Adafruit_BMP280::SAMPLING_X16,
                  Adafruit_BMP280::FILTER_X16,
                  Adafruit_BMP280::STANDBY_MS_500);
  Serial.println("BMP280 ready");
}

void loop() {
  float tempC    = bmp.readTemperature();
  float pressure = bmp.readPressure() / 100.0F; // hPa
  Serial.print("Temp: ");
  Serial.print(tempC);
  Serial.print(" C  Pressure: ");
  Serial.print(pressure);
  Serial.println(" hPa");
  delay(2000);
}`,
      },
    ],
    code: '',
    components: [
      {
        type: 'velxio-bmp280',
        id: 'bmp1',
        x: 460,
        y: 150,
        properties: { temperature: '25', pressure: '1013.25' },
      },
    ],
    wires: [
      {
        id: 'bmp-vcc',
        start: { componentId: 'stm32-bluepill', pinName: '3V3' },
        end: { componentId: 'bmp1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'bmp-gnd',
        start: { componentId: 'stm32-bluepill', pinName: 'GND' },
        end: { componentId: 'bmp1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'bmp-sda',
        start: { componentId: 'stm32-bluepill', pinName: 'PB7' },
        end: { componentId: 'bmp1', pinName: 'SDA' },
        color: '#22aaff',
      },
      {
        id: 'bmp-scl',
        start: { componentId: 'stm32-bluepill', pinName: 'PB6' },
        end: { componentId: 'bmp1', pinName: 'SCL' },
        color: '#ff8800',
      },
    ],
    tags: ['stm32', 'blue pill', 'i2c', 'bmp280', 'sensor', 'qemu'],
  },
  {
    id: 'stm32-bluepill-oled',
    title: 'STM32: SSD1306 OLED Display (I2C)',
    description:
      'Drive a 128x64 SSD1306 OLED over I2C1 from an STM32 Blue Pill (SCL=PB6, SDA=PB7). The framebuffer writes are captured by the QEMU I2C slave and rendered on the canvas. Shows "Hello Velxio!" with a live frame counter.',
    libraries: ['Adafruit SSD1306', 'Adafruit GFX Library'],
    category: 'displays',
    difficulty: 'intermediate',
    boardFilter: 'stm32-bluepill',
    boards: [
      {
        boardKind: 'stm32-bluepill',
        x: 100,
        y: 90,
        code: `// STM32 Blue Pill (F103) — SSD1306 128x64 OLED over I2C1
// Wiring: SDA -> PB7  |  SCL -> PB6  |  VCC -> 3V3  |  GND -> GND
// Requires: Adafruit SSD1306, Adafruit GFX Library

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

int counter = 0;

void setup() {
  Serial.begin(115200);
  Wire.begin();        // I2C1: SCL=PB6, SDA=PB7
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 not found!");
    while (true) delay(10);
  }
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Hello");
  display.println("Velxio!");
  display.display();
  Serial.println("OLED ready");
}

void loop() {
  counter++;
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Hello");
  display.println("Velxio!");
  display.setTextSize(1);
  display.setCursor(0, 48);
  display.print("Count: ");
  display.print(counter);
  display.display();
  Serial.print("Frame: ");
  Serial.println(counter);
  delay(1000);
}`,
      },
    ],
    code: '',
    components: [{ type: 'wokwi-ssd1306', id: 'oled1', x: 460, y: 120, properties: {} }],
    wires: [
      {
        id: 'oled-vcc',
        start: { componentId: 'stm32-bluepill', pinName: '3V3' },
        end: { componentId: 'oled1', pinName: 'VIN' },
        color: '#ff4444',
      },
      {
        id: 'oled-gnd',
        start: { componentId: 'stm32-bluepill', pinName: 'GND' },
        end: { componentId: 'oled1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'oled-sda',
        start: { componentId: 'stm32-bluepill', pinName: 'PB7' },
        end: { componentId: 'oled1', pinName: 'DATA' },
        color: '#22aaff',
      },
      {
        id: 'oled-scl',
        start: { componentId: 'stm32-bluepill', pinName: 'PB6' },
        end: { componentId: 'oled1', pinName: 'CLK' },
        color: '#ff8800',
      },
    ],
    tags: ['stm32', 'blue pill', 'i2c', 'ssd1306', 'oled', 'display', 'qemu'],
  },
  {
    id: 'stm32-bluepill-mpu6050',
    title: 'STM32: MPU6050 IMU (I2C)',
    description:
      'Read the WHO_AM_I id and accelerometer axes from an MPU6050 6-axis IMU over I2C1 on the STM32 Blue Pill (SCL=PB6, SDA=PB7). The sensor runs as a QEMU I2C slave; raw Wire reads stream to the Serial Monitor.',
    category: 'sensors',
    difficulty: 'intermediate',
    boardFilter: 'stm32-bluepill',
    boards: [
      {
        boardKind: 'stm32-bluepill',
        x: 100,
        y: 90,
        code: `// STM32 Blue Pill (F103) — MPU6050 6-axis IMU over I2C1
// Wiring: SDA -> PB7  |  SCL -> PB6  |  VCC -> 3V3  |  GND -> GND
#include <Wire.h>

const uint8_t MPU = 0x68;

void setup() {
  Serial.begin(115200);
  Wire.begin();              // I2C1: SCL=PB6, SDA=PB7
  // Wake the device (clear SLEEP bit in PWR_MGMT_1).
  Wire.beginTransmission(MPU); Wire.write(0x6B); Wire.write(0x00); Wire.endTransmission();
  // WHO_AM_I (0x75) should read 0x68.
  Wire.beginTransmission(MPU); Wire.write(0x75); Wire.endTransmission(false);
  Wire.requestFrom(MPU, (uint8_t)1);
  uint8_t who = Wire.read();
  Serial.print("MPU6050 WHO_AM_I = 0x"); Serial.println(who, HEX);
}

void loop() {
  // Burst-read the 6 accelerometer bytes starting at ACCEL_XOUT_H (0x3B).
  Wire.beginTransmission(MPU); Wire.write(0x3B); Wire.endTransmission(false);
  Wire.requestFrom(MPU, (uint8_t)6);
  int16_t ax = (Wire.read() << 8) | Wire.read();
  int16_t ay = (Wire.read() << 8) | Wire.read();
  int16_t az = (Wire.read() << 8) | Wire.read();
  Serial.print("AX="); Serial.print(ax);
  Serial.print("  AY="); Serial.print(ay);
  Serial.print("  AZ="); Serial.println(az);
  delay(1000);
}`,
      },
    ],
    code: '',
    components: [{ type: 'wokwi-mpu6050', id: 'mpu1', x: 460, y: 150, properties: {} }],
    wires: [
      {
        id: 'mpu-vcc',
        start: { componentId: 'stm32-bluepill', pinName: '3V3' },
        end: { componentId: 'mpu1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'mpu-gnd',
        start: { componentId: 'stm32-bluepill', pinName: 'GND' },
        end: { componentId: 'mpu1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'mpu-sda',
        start: { componentId: 'stm32-bluepill', pinName: 'PB7' },
        end: { componentId: 'mpu1', pinName: 'SDA' },
        color: '#22aaff',
      },
      {
        id: 'mpu-scl',
        start: { componentId: 'stm32-bluepill', pinName: 'PB6' },
        end: { componentId: 'mpu1', pinName: 'SCL' },
        color: '#ff8800',
      },
    ],
    tags: ['stm32', 'blue pill', 'i2c', 'mpu6050', 'imu', 'sensor', 'qemu'],
  },
  {
    id: 'stm32-bluepill-rtc',
    title: 'STM32: DS1307 RTC Clock (I2C)',
    description:
      'Read the current time and date from a DS1307 real-time clock over I2C1 on the STM32 Blue Pill (SCL=PB6, SDA=PB7). The QEMU DS1307 slave returns the live system clock in BCD, ticking once a second in the Serial Monitor.',
    category: 'sensors',
    difficulty: 'intermediate',
    boardFilter: 'stm32-bluepill',
    boards: [
      {
        boardKind: 'stm32-bluepill',
        x: 100,
        y: 90,
        code: `// STM32 Blue Pill (F103) — DS1307 RTC over I2C1
// Wiring: SDA -> PB7  |  SCL -> PB6  |  VCC -> 3V3  |  GND -> GND
#include <Wire.h>

const uint8_t DS_ADDR = 0x68;   // 'RTC' is a reserved STM32 HAL macro

uint8_t bcd2dec(uint8_t b) { return (b >> 4) * 10 + (b & 0x0F); }

void setup() {
  Serial.begin(115200);
  Wire.begin();              // I2C1: SCL=PB6, SDA=PB7
  Serial.println("DS1307 RTC ready");
}

void loop() {
  // Read 7 timekeeping registers starting at 0x00.
  Wire.beginTransmission(DS_ADDR); Wire.write(0x00); Wire.endTransmission(false);
  Wire.requestFrom(DS_ADDR, (uint8_t)7);
  uint8_t ss = bcd2dec(Wire.read() & 0x7F);
  uint8_t mm = bcd2dec(Wire.read());
  uint8_t hh = bcd2dec(Wire.read() & 0x3F);
  Wire.read();                       // day-of-week (unused)
  uint8_t dd = bcd2dec(Wire.read());
  uint8_t mo = bcd2dec(Wire.read());
  uint8_t yy = bcd2dec(Wire.read());
  char buf[48];
  sprintf(buf, "Time %02d:%02d:%02d   Date %02d/%02d/20%02d", hh, mm, ss, dd, mo, yy);
  Serial.println(buf);
  delay(1000);
}`,
      },
    ],
    code: '',
    components: [{ type: 'wokwi-ds1307', id: 'rtc1', x: 460, y: 150, properties: {} }],
    wires: [
      {
        id: 'rtc-vcc',
        start: { componentId: 'stm32-bluepill', pinName: '3V3' },
        end: { componentId: 'rtc1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'rtc-gnd',
        start: { componentId: 'stm32-bluepill', pinName: 'GND' },
        end: { componentId: 'rtc1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'rtc-sda',
        start: { componentId: 'stm32-bluepill', pinName: 'PB7' },
        end: { componentId: 'rtc1', pinName: 'SDA' },
        color: '#22aaff',
      },
      {
        id: 'rtc-scl',
        start: { componentId: 'stm32-bluepill', pinName: 'PB6' },
        end: { componentId: 'rtc1', pinName: 'SCL' },
        color: '#ff8800',
      },
    ],
    tags: ['stm32', 'blue pill', 'i2c', 'ds1307', 'rtc', 'clock', 'qemu'],
  },
  {
    id: 'stm32-blackpill-oled',
    title: 'STM32 Black Pill: SSD1306 OLED (I2C)',
    description:
      'Drive a 128x64 SSD1306 OLED over I2C1 from an STM32 Black Pill (F411, Cortex-M4; SCL=PB6, SDA=PB7). Proves the I2C display path works on the F4 board too. Shows "Black Pill" with a live counter.',
    libraries: ['Adafruit SSD1306', 'Adafruit GFX Library'],
    category: 'displays',
    difficulty: 'intermediate',
    boardFilter: 'stm32-blackpill',
    boards: [
      {
        boardKind: 'stm32-blackpill',
        x: 100,
        y: 90,
        code: `// STM32 Black Pill (F411) — SSD1306 128x64 OLED over I2C1
// Wiring: SDA -> PB7  |  SCL -> PB6  |  VCC -> 3V3  |  GND -> GND
// Requires: Adafruit SSD1306, Adafruit GFX Library
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);
int counter = 0;

void setup() {
  Serial.begin(115200);
  Wire.begin();
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 not found!");
    while (true) delay(10);
  }
  Serial.println("OLED ready");
}

void loop() {
  counter++;
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(2);
  display.setCursor(0, 0);
  display.println("Black");
  display.println("Pill F4");
  display.setTextSize(1);
  display.setCursor(0, 52);
  display.print("count: "); display.print(counter);
  display.display();
  Serial.print("Frame: "); Serial.println(counter);
  delay(1000);
}`,
      },
    ],
    code: '',
    components: [{ type: 'wokwi-ssd1306', id: 'bpoled1', x: 460, y: 120, properties: {} }],
    wires: [
      {
        id: 'bpo-vcc',
        start: { componentId: 'stm32-blackpill', pinName: '3V3' },
        end: { componentId: 'bpoled1', pinName: 'VIN' },
        color: '#ff4444',
      },
      {
        id: 'bpo-gnd',
        start: { componentId: 'stm32-blackpill', pinName: 'GND' },
        end: { componentId: 'bpoled1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'bpo-sda',
        start: { componentId: 'stm32-blackpill', pinName: 'PB7' },
        end: { componentId: 'bpoled1', pinName: 'DATA' },
        color: '#22aaff',
      },
      {
        id: 'bpo-scl',
        start: { componentId: 'stm32-blackpill', pinName: 'PB6' },
        end: { componentId: 'bpoled1', pinName: 'CLK' },
        color: '#ff8800',
      },
    ],
    tags: ['stm32', 'black pill', 'f411', 'i2c', 'ssd1306', 'oled', 'qemu'],
  },
  {
    id: 'stm32-bluepill-weather-station',
    title: 'STM32: Weather Station (BMP280 + OLED)',
    description:
      'A complete I2C dashboard on the STM32 Blue Pill: read temperature and pressure from a BMP280 and render them live on an SSD1306 OLED, both sharing the same I2C1 bus (BMP280 0x76, OLED 0x3C, SCL=PB6/SDA=PB7). Exercises I2C read and write on one bus.',
    libraries: [
      'Adafruit BMP280 Library',
      'Adafruit Unified Sensor',
      'Adafruit SSD1306',
      'Adafruit GFX Library',
    ],
    category: 'sensors',
    difficulty: 'intermediate',
    boardFilter: 'stm32-bluepill',
    boards: [
      {
        boardKind: 'stm32-bluepill',
        x: 100,
        y: 90,
        code: `// STM32 Blue Pill (F103) — Weather station: BMP280 + SSD1306 on one I2C bus
// Wiring: both devices SDA -> PB7, SCL -> PB6, VCC -> 3V3, GND -> GND
// Requires: Adafruit BMP280 Library, Adafruit Unified Sensor, Adafruit SSD1306, Adafruit GFX Library
#include <Wire.h>
#include <Adafruit_BMP280.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_BMP280 bmp;
Adafruit_SSD1306 display(128, 64, &Wire, -1);

void setup() {
  Serial.begin(115200);
  Wire.begin();
  if (!bmp.begin(0x76)) Serial.println("BMP280 not found");
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("OLED not found");
  display.setTextColor(SSD1306_WHITE);
  Serial.println("Weather station ready");
}

void loop() {
  float t = bmp.readTemperature();
  float p = bmp.readPressure() / 100.0F;   // hPa
  display.clearDisplay();
  display.setTextSize(1); display.setCursor(0, 0);
  display.println("Velxio Weather");
  display.setTextSize(2); display.setCursor(0, 16);
  display.print(t, 1); display.println(" C");
  display.setTextSize(1); display.setCursor(0, 52);
  display.print(p, 1); display.print(" hPa");
  display.display();
  Serial.print("T="); Serial.print(t); Serial.print(" C  P="); Serial.print(p); Serial.println(" hPa");
  delay(1000);
}`,
      },
    ],
    code: '',
    components: [
      {
        type: 'velxio-bmp280',
        id: 'wbmp1',
        x: 470,
        y: 80,
        properties: { temperature: '23.5', pressure: '1011.2' },
      },
      { type: 'wokwi-ssd1306', id: 'woled1', x: 470, y: 250, properties: {} },
    ],
    wires: [
      {
        id: 'w-bmp-vcc',
        start: { componentId: 'stm32-bluepill', pinName: '3V3' },
        end: { componentId: 'wbmp1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'w-bmp-gnd',
        start: { componentId: 'stm32-bluepill', pinName: 'GND' },
        end: { componentId: 'wbmp1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w-bmp-sda',
        start: { componentId: 'stm32-bluepill', pinName: 'PB7' },
        end: { componentId: 'wbmp1', pinName: 'SDA' },
        color: '#22aaff',
      },
      {
        id: 'w-bmp-scl',
        start: { componentId: 'stm32-bluepill', pinName: 'PB6' },
        end: { componentId: 'wbmp1', pinName: 'SCL' },
        color: '#ff8800',
      },
      {
        id: 'w-oled-vcc',
        start: { componentId: 'wbmp1', pinName: 'VCC' },
        end: { componentId: 'woled1', pinName: 'VIN' },
        color: '#ff4444',
      },
      {
        id: 'w-oled-gnd',
        start: { componentId: 'wbmp1', pinName: 'GND' },
        end: { componentId: 'woled1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w-oled-sda',
        start: { componentId: 'wbmp1', pinName: 'SDA' },
        end: { componentId: 'woled1', pinName: 'DATA' },
        color: '#22aaff',
      },
      {
        id: 'w-oled-scl',
        start: { componentId: 'wbmp1', pinName: 'SCL' },
        end: { componentId: 'woled1', pinName: 'CLK' },
        color: '#ff8800',
      },
    ],
    tags: ['stm32', 'blue pill', 'i2c', 'bmp280', 'ssd1306', 'weather', 'dashboard', 'qemu'],
  },
  {
    id: 'stm32-bluepill-7segment',
    title: 'STM32: 7-Segment Counter',
    description:
      'Count 0-9 on a 7-segment display driven by seven GPIO pins (PA0-PA6 = segments A-G) on the STM32 Blue Pill. Pure digital output: each digit pattern is written to the segment pins. Common-cathode (COM -> GND).',
    category: 'basics',
    difficulty: 'beginner',
    boardFilter: 'stm32-bluepill',
    boards: [
      {
        boardKind: 'stm32-bluepill',
        x: 100,
        y: 90,
        code: `// STM32 Blue Pill (F103) — 7-segment counter 0-9
// Segments A..G on PA0..PA6, common cathode (COM -> GND).
const int seg[7] = { PA0, PA1, PA2, PA3, PA4, PA5, PA6 }; // A B C D E F G
// Bit i (i=0..6) maps to segment seg[i]. 1 = segment lit.
const uint8_t pattern[10] = {
  0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F
};

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < 7; i++) pinMode(seg[i], OUTPUT);
}

void loop() {
  for (int d = 0; d < 10; d++) {
    uint8_t p = pattern[d];
    for (int i = 0; i < 7; i++) digitalWrite(seg[i], (p >> i) & 1);
    Serial.print("digit = "); Serial.println(d);
    delay(800);
  }
}`,
      },
    ],
    code: '',
    components: [
      { type: 'wokwi-7segment', id: 'seg1', x: 470, y: 140, properties: { common: 'cathode' } },
    ],
    wires: [
      {
        id: 's-a',
        start: { componentId: 'stm32-bluepill', pinName: 'PA0' },
        end: { componentId: 'seg1', pinName: 'A' },
        color: '#ff5555',
      },
      {
        id: 's-b',
        start: { componentId: 'stm32-bluepill', pinName: 'PA1' },
        end: { componentId: 'seg1', pinName: 'B' },
        color: '#ff9955',
      },
      {
        id: 's-c',
        start: { componentId: 'stm32-bluepill', pinName: 'PA2' },
        end: { componentId: 'seg1', pinName: 'C' },
        color: '#ffdd55',
      },
      {
        id: 's-d',
        start: { componentId: 'stm32-bluepill', pinName: 'PA3' },
        end: { componentId: 'seg1', pinName: 'D' },
        color: '#88dd55',
      },
      {
        id: 's-e',
        start: { componentId: 'stm32-bluepill', pinName: 'PA4' },
        end: { componentId: 'seg1', pinName: 'E' },
        color: '#55ddcc',
      },
      {
        id: 's-f',
        start: { componentId: 'stm32-bluepill', pinName: 'PA5' },
        end: { componentId: 'seg1', pinName: 'F' },
        color: '#5599ff',
      },
      {
        id: 's-g',
        start: { componentId: 'stm32-bluepill', pinName: 'PA6' },
        end: { componentId: 'seg1', pinName: 'G' },
        color: '#aa77ff',
      },
      {
        id: 's-com',
        start: { componentId: 'stm32-bluepill', pinName: 'GND' },
        end: { componentId: 'seg1', pinName: 'COM' },
        color: '#000000',
      },
    ],
    tags: ['stm32', 'blue pill', 'gpio', '7-segment', 'display', 'counter'],
  },
  {
    id: 'stm32-bluepill-rgb',
    title: 'STM32: RGB LED Color Cycle',
    description:
      'Cycle an RGB LED through red, green and blue using three GPIO pins (PA0=R, PA1=G, PA2=B) on the STM32 Blue Pill. Pure digital output; common-cathode (COM -> GND).',
    category: 'basics',
    difficulty: 'beginner',
    boardFilter: 'stm32-bluepill',
    boards: [
      {
        boardKind: 'stm32-bluepill',
        x: 100,
        y: 90,
        code: `// STM32 Blue Pill (F103) — RGB LED color cycle
// R=PA0, G=PA1, B=PA2, common cathode (COM -> GND).
const int PIN_R = PA0, PIN_G = PA1, PIN_B = PA2;

void setup() {
  Serial.begin(115200);
  pinMode(PIN_R, OUTPUT); pinMode(PIN_G, OUTPUT); pinMode(PIN_B, OUTPUT);
}

void show(bool r, bool g, bool b, const char* name) {
  digitalWrite(PIN_R, r); digitalWrite(PIN_G, g); digitalWrite(PIN_B, b);
  Serial.println(name);
  delay(700);
}

void loop() {
  show(true,  false, false, "RED");
  show(false, true,  false, "GREEN");
  show(false, false, true,  "BLUE");
  show(true,  true,  false, "YELLOW");
  show(false, true,  true,  "CYAN");
  show(true,  false, true,  "MAGENTA");
}`,
      },
    ],
    code: '',
    components: [
      { type: 'wokwi-resistor', id: 'r-rgb1-r', x: 320, y: 160, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-rgb1-g', x: 320, y: 186, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-rgb1-b', x: 320, y: 212, properties: { value: '220' } },
      { type: 'wokwi-rgb-led', id: 'rgb1', x: 470, y: 150, properties: {} }],
    wires: [
      {
        id: 'rgb-r',
        start: { componentId: 'stm32-bluepill', pinName: 'PA0' },
        end: { componentId: 'r-rgb1-r', pinName: '1' },
        color: '#ff3333',
      },
      {
        id: 'w-r-rgb1-r',
        start: { componentId: 'r-rgb1-r', pinName: '2' },
        end: { componentId: 'rgb1', pinName: 'R' },
        color: '#e74c3c',
      },
      {
        id: 'rgb-g',
        start: { componentId: 'stm32-bluepill', pinName: 'PA1' },
        end: { componentId: 'r-rgb1-g', pinName: '1' },
        color: '#33cc33',
      },
      {
        id: 'w-r-rgb1-g',
        start: { componentId: 'r-rgb1-g', pinName: '2' },
        end: { componentId: 'rgb1', pinName: 'G' },
        color: '#e74c3c',
      },
      {
        id: 'rgb-b',
        start: { componentId: 'stm32-bluepill', pinName: 'PA2' },
        end: { componentId: 'r-rgb1-b', pinName: '1' },
        color: '#3366ff',
      },
      {
        id: 'w-r-rgb1-b',
        start: { componentId: 'r-rgb1-b', pinName: '2' },
        end: { componentId: 'rgb1', pinName: 'B' },
        color: '#e74c3c',
      },
      {
        id: 'rgb-com',
        start: { componentId: 'stm32-bluepill', pinName: 'GND' },
        end: { componentId: 'rgb1', pinName: 'COM' },
        color: '#000000',
      },
    ],
    tags: ['stm32', 'blue pill', 'gpio', 'rgb-led', 'led'],
  },
  {
    id: 'stm32-bluepill-button',
    title: 'STM32: Push Button -> LED',
    description:
      'Read a push button on PA0 (INPUT_PULLUP) and mirror it to the onboard PC13 LED on the STM32 Blue Pill. Pressing the button drives the GPIO input LOW; the firmware lights the LED while pressed. Demonstrates GPIO input injection.',
    category: 'basics',
    difficulty: 'beginner',
    boardFilter: 'stm32-bluepill',
    boards: [
      {
        boardKind: 'stm32-bluepill',
        x: 100,
        y: 90,
        code: `// STM32 Blue Pill (F103) — push button on PA0 -> onboard PC13 LED
// Button between PA0 and GND. PC13 LED is active-LOW.
const int BTN = PA0;
const int LED = PC13;

void setup() {
  Serial.begin(115200);
  pinMode(BTN, INPUT_PULLUP);
  pinMode(LED, OUTPUT);
  digitalWrite(LED, HIGH);     // LED off (active-low)
  Serial.println("Press the button");
}

void loop() {
  bool pressed = (digitalRead(BTN) == LOW);
  digitalWrite(LED, pressed ? LOW : HIGH);   // pressed -> LED on
  static bool last = false;
  if (pressed != last) {
    Serial.println(pressed ? "PRESSED -> LED ON" : "released -> LED OFF");
    last = pressed;
  }
  delay(20);
}`,
      },
    ],
    code: '',
    components: [
      { type: 'wokwi-pushbutton', id: 'btn1', x: 470, y: 160, properties: { color: 'green' } },
    ],
    wires: [
      {
        id: 'btn-sig',
        start: { componentId: 'stm32-bluepill', pinName: 'PA0' },
        end: { componentId: 'btn1', pinName: '1.l' },
        color: '#22aaff',
      },
      {
        id: 'btn-gnd',
        start: { componentId: 'stm32-bluepill', pinName: 'GND' },
        end: { componentId: 'btn1', pinName: '2.l' },
        color: '#000000',
      },
    ],
    tags: ['stm32', 'blue pill', 'gpio', 'button', 'input', 'pushbutton'],
  },
  {
    id: 'stm32-bluepill-switch',
    title: 'STM32: Slide Switch -> LED',
    description:
      'Read a slide switch on PA0 and reflect its position on the onboard PC13 LED of the STM32 Blue Pill. Flipping the switch drives the GPIO input HIGH/LOW. Demonstrates GPIO input injection from a latching element.',
    category: 'basics',
    difficulty: 'beginner',
    boardFilter: 'stm32-bluepill',
    boards: [
      {
        boardKind: 'stm32-bluepill',
        x: 100,
        y: 90,
        code: `// STM32 Blue Pill (F103) — slide switch on PA0 -> onboard PC13 LED
// Switch common (pin 2) -> PA0, ends to GND / 3V3. PC13 LED is active-LOW.
const int SW = PA0;
const int LED = PC13;

void setup() {
  Serial.begin(115200);
  pinMode(SW, INPUT);
  pinMode(LED, OUTPUT);
  Serial.println("Flip the switch");
}

void loop() {
  bool on = (digitalRead(SW) == HIGH);
  digitalWrite(LED, on ? LOW : HIGH);    // switch ON -> LED on
  static int last = -1;
  if ((int)on != last) {
    Serial.println(on ? "switch ON  -> LED ON" : "switch OFF -> LED OFF");
    last = on;
  }
  delay(50);
}`,
      },
    ],
    code: '',
    components: [{ type: 'wokwi-slide-switch', id: 'sw1', x: 470, y: 160, properties: {} }],
    wires: [
      {
        id: 'sw-sig',
        start: { componentId: 'stm32-bluepill', pinName: 'PA0' },
        end: { componentId: 'sw1', pinName: '2' },
        color: '#22aaff',
      },
      {
        id: 'sw-gnd',
        start: { componentId: 'stm32-bluepill', pinName: 'GND' },
        end: { componentId: 'sw1', pinName: '1' },
        color: '#000000',
      },
      {
        id: 'sw-vcc',
        start: { componentId: 'stm32-bluepill', pinName: '3V3' },
        end: { componentId: 'sw1', pinName: '3' },
        color: '#ff4444',
      },
    ],
    tags: ['stm32', 'blue pill', 'gpio', 'switch', 'input', 'slide-switch'],
  },
  {
    id: 'stm32-bluepill-stepper',
    title: 'STM32: Stepper Motor',
    description:
      'Rotate a stepper motor with the four-pin full-step sequence driven by GPIO pins (PA0-PA3) on the STM32 Blue Pill. Pure digital output: the firmware energizes coils A+, B+, A-, B- in order to step the rotor.',
    category: 'motors',
    difficulty: 'intermediate',
    boardFilter: 'stm32-bluepill',
    boards: [
      {
        boardKind: 'stm32-bluepill',
        x: 100,
        y: 90,
        code: `// STM32 Blue Pill (F103) — bipolar stepper, full-step sequence
// Coils: A+ = PA0, A- = PA1, B+ = PA2, B- = PA3
const int Ap = PA0, An = PA1, Bp = PA2, Bn = PA3;

// Full-step order energizing one coil at a time: A+, B+, A-, B-
const uint8_t seq[4][4] = {
  { 1, 0, 0, 0 },   // A+
  { 0, 0, 1, 0 },   // B+
  { 0, 1, 0, 0 },   // A-
  { 0, 0, 0, 1 },   // B-
};

void setup() {
  Serial.begin(115200);
  pinMode(Ap, OUTPUT); pinMode(An, OUTPUT);
  pinMode(Bp, OUTPUT); pinMode(Bn, OUTPUT);
  Serial.println("Stepper running");
}

void loop() {
  static int s = 0;
  digitalWrite(Ap, seq[s][0]); digitalWrite(An, seq[s][1]);
  digitalWrite(Bp, seq[s][2]); digitalWrite(Bn, seq[s][3]);
  Serial.print("step "); Serial.println(s);
  s = (s + 1) % 4;
  delay(300);
}`,
      },
    ],
    code: '',
    components: [{ type: 'wokwi-stepper-motor', id: 'stp1', x: 470, y: 150, properties: {} }],
    wires: [
      {
        id: 'stp-ap',
        start: { componentId: 'stm32-bluepill', pinName: 'PA0' },
        end: { componentId: 'stp1', pinName: 'A+' },
        color: '#ff5555',
      },
      {
        id: 'stp-an',
        start: { componentId: 'stm32-bluepill', pinName: 'PA1' },
        end: { componentId: 'stp1', pinName: 'A-' },
        color: '#ff9955',
      },
      {
        id: 'stp-bp',
        start: { componentId: 'stm32-bluepill', pinName: 'PA2' },
        end: { componentId: 'stp1', pinName: 'B+' },
        color: '#55aaff',
      },
      {
        id: 'stp-bn',
        start: { componentId: 'stm32-bluepill', pinName: 'PA3' },
        end: { componentId: 'stp1', pinName: 'B-' },
        color: '#aa77ff',
      },
    ],
    tags: ['stm32', 'blue pill', 'gpio', 'stepper', 'motor'],
  },
  {
    id: 'uno-stepper-a4988',
    title: 'Arduino Uno: Stepper + A4988',
    description:
      'Spin a bipolar stepper motor from an Arduino Uno through an A4988 driver. The MCU only pulses STEP and sets DIR; the A4988 drives the coils. The rotor turns continuously.',
    category: 'motors',
    difficulty: 'intermediate',
    boardFilter: 'arduino-uno',
    boards: [
      {
        boardKind: 'arduino-uno',
        x: 40,
        y: 80,
        code: `// Arduino Uno + A4988 stepper driver (STEP/DIR)
// D3 -> STEP, D4 -> DIR. One STEP pulse = one step; DIR sets direction.
const int STEP_PIN = 3, DIR_PIN = 4;

void setup() {
  pinMode(STEP_PIN, OUTPUT);
  pinMode(DIR_PIN, OUTPUT);
  digitalWrite(DIR_PIN, HIGH);   // HIGH = clockwise
  Serial.begin(115200);
  Serial.println("A4988 stepper running");
}

void loop() {
  digitalWrite(STEP_PIN, HIGH);
  delayMicroseconds(800);
  digitalWrite(STEP_PIN, LOW);
  delayMicroseconds(800);
}`,
      },
    ],
    code: '',
    components: [
      { type: 'velxio-a4988', id: 'drv1', x: 330, y: 70, properties: {} },
      { type: 'wokwi-stepper-motor', id: 'stp1', x: 560, y: 120, properties: {} },
    ],
    wires: [
      {
        id: 'u-step',
        start: { componentId: 'arduino-uno', pinName: '3' },
        end: { componentId: 'drv1', pinName: 'STEP' },
        color: '#f59e0b',
      },
      {
        id: 'u-dir',
        start: { componentId: 'arduino-uno', pinName: '4' },
        end: { componentId: 'drv1', pinName: 'DIR' },
        color: '#10b981',
      },
      {
        id: 'u-1a',
        start: { componentId: 'drv1', pinName: '1A' },
        end: { componentId: 'stp1', pinName: 'B+' },
        color: '#ff5555',
      },
      {
        id: 'u-1b',
        start: { componentId: 'drv1', pinName: '1B' },
        end: { componentId: 'stp1', pinName: 'B-' },
        color: '#ff9955',
      },
      {
        id: 'u-2a',
        start: { componentId: 'drv1', pinName: '2A' },
        end: { componentId: 'stp1', pinName: 'A+' },
        color: '#55aaff',
      },
      {
        id: 'u-2b',
        start: { componentId: 'drv1', pinName: '2B' },
        end: { componentId: 'stp1', pinName: 'A-' },
        color: '#aa77ff',
      },
    ],
    tags: ['arduino', 'uno', 'stepper', 'motor', 'a4988', 'driver'],
  },
  {
    id: 'esp32-stepper-a4988',
    title: 'ESP32: Stepper + A4988',
    description:
      'Spin a bipolar stepper motor from an ESP32 through an A4988 driver (STEP = GPIO26, DIR = GPIO27).',
    category: 'motors',
    difficulty: 'intermediate',
    boardFilter: 'esp32',
    boards: [
      {
        boardKind: 'esp32',
        x: 40,
        y: 80,
        code: `// ESP32 + A4988 stepper driver (STEP/DIR)
// GPIO26 -> STEP, GPIO27 -> DIR.
const int STEP_PIN = 26, DIR_PIN = 27;

void setup() {
  pinMode(STEP_PIN, OUTPUT);
  pinMode(DIR_PIN, OUTPUT);
  digitalWrite(DIR_PIN, HIGH);
  Serial.begin(115200);
  Serial.println("A4988 stepper running");
}

void loop() {
  digitalWrite(STEP_PIN, HIGH);
  delayMicroseconds(800);
  digitalWrite(STEP_PIN, LOW);
  delayMicroseconds(800);
}`,
      },
    ],
    code: '',
    components: [
      { type: 'velxio-a4988', id: 'drv1', x: 330, y: 70, properties: {} },
      { type: 'wokwi-stepper-motor', id: 'stp1', x: 560, y: 120, properties: {} },
    ],
    wires: [
      {
        id: 'e-step',
        start: { componentId: 'esp32', pinName: '26' },
        end: { componentId: 'drv1', pinName: 'STEP' },
        color: '#f59e0b',
      },
      {
        id: 'e-dir',
        start: { componentId: 'esp32', pinName: '27' },
        end: { componentId: 'drv1', pinName: 'DIR' },
        color: '#10b981',
      },
      {
        id: 'e-1a',
        start: { componentId: 'drv1', pinName: '1A' },
        end: { componentId: 'stp1', pinName: 'B+' },
        color: '#ff5555',
      },
      {
        id: 'e-1b',
        start: { componentId: 'drv1', pinName: '1B' },
        end: { componentId: 'stp1', pinName: 'B-' },
        color: '#ff9955',
      },
      {
        id: 'e-2a',
        start: { componentId: 'drv1', pinName: '2A' },
        end: { componentId: 'stp1', pinName: 'A+' },
        color: '#55aaff',
      },
      {
        id: 'e-2b',
        start: { componentId: 'drv1', pinName: '2B' },
        end: { componentId: 'stp1', pinName: 'A-' },
        color: '#aa77ff',
      },
    ],
    tags: ['esp32', 'stepper', 'motor', 'a4988', 'driver'],
  },
  {
    id: 'pico-stepper-a4988',
    title: 'Raspberry Pi Pico: Stepper + A4988',
    description:
      'Spin a bipolar stepper motor from a Raspberry Pi Pico through an A4988 driver (STEP = GP3, DIR = GP4).',
    category: 'motors',
    difficulty: 'intermediate',
    boardFilter: 'raspberry-pi-pico',
    boards: [
      {
        boardKind: 'raspberry-pi-pico',
        x: 40,
        y: 80,
        code: `// Raspberry Pi Pico + A4988 stepper driver (STEP/DIR)
// GP3 -> STEP, GP4 -> DIR.
const int STEP_PIN = 3, DIR_PIN = 4;

void setup() {
  pinMode(STEP_PIN, OUTPUT);
  pinMode(DIR_PIN, OUTPUT);
  digitalWrite(DIR_PIN, HIGH);
  Serial.begin(115200);
  Serial.println("A4988 stepper running");
}

void loop() {
  digitalWrite(STEP_PIN, HIGH);
  delayMicroseconds(800);
  digitalWrite(STEP_PIN, LOW);
  delayMicroseconds(800);
}`,
      },
    ],
    code: '',
    components: [
      { type: 'velxio-a4988', id: 'drv1', x: 330, y: 70, properties: {} },
      { type: 'wokwi-stepper-motor', id: 'stp1', x: 560, y: 120, properties: {} },
    ],
    wires: [
      {
        id: 'p-step',
        start: { componentId: 'raspberry-pi-pico', pinName: 'GP3' },
        end: { componentId: 'drv1', pinName: 'STEP' },
        color: '#f59e0b',
      },
      {
        id: 'p-dir',
        start: { componentId: 'raspberry-pi-pico', pinName: 'GP4' },
        end: { componentId: 'drv1', pinName: 'DIR' },
        color: '#10b981',
      },
      {
        id: 'p-1a',
        start: { componentId: 'drv1', pinName: '1A' },
        end: { componentId: 'stp1', pinName: 'B+' },
        color: '#ff5555',
      },
      {
        id: 'p-1b',
        start: { componentId: 'drv1', pinName: '1B' },
        end: { componentId: 'stp1', pinName: 'B-' },
        color: '#ff9955',
      },
      {
        id: 'p-2a',
        start: { componentId: 'drv1', pinName: '2A' },
        end: { componentId: 'stp1', pinName: 'A+' },
        color: '#55aaff',
      },
      {
        id: 'p-2b',
        start: { componentId: 'drv1', pinName: '2B' },
        end: { componentId: 'stp1', pinName: 'A-' },
        color: '#aa77ff',
      },
    ],
    tags: ['raspberry pi pico', 'rp2040', 'stepper', 'motor', 'a4988', 'driver'],
  },
  {
    id: 'blink-led',
    title: 'Blink LED',
    description: 'Classic Arduino blink example - toggle an LED on and off',
    category: 'basics',
    difficulty: 'beginner',
    code: `// Blink LED Example
// Toggles the built-in LED on pin 13

void setup() {
  pinMode(13, OUTPUT);
}

void loop() {
  digitalWrite(13, HIGH);
  delay(1000);
  digitalWrite(13, LOW);
  delay(1000);
}`,
    components: [
      {
        type: 'wokwi-arduino-uno',
        id: 'arduino-uno',
        x: 100,
        y: 100,
        properties: {},
      },
    ],
    wires: [],
  },
  {
    id: 'traffic-light',
    title: 'Traffic Light',
    description: 'Simulate a traffic light with red, yellow, and green LEDs',
    category: 'basics',
    difficulty: 'beginner',
    code: `// Traffic Light Simulator
// Red -> Yellow -> Green -> Yellow -> Red

const int RED_PIN = 13;
const int YELLOW_PIN = 12;
const int GREEN_PIN = 11;

void setup() {
  pinMode(RED_PIN, OUTPUT);
  pinMode(YELLOW_PIN, OUTPUT);
  pinMode(GREEN_PIN, OUTPUT);
}

void loop() {
  // Red light
  digitalWrite(RED_PIN, HIGH);
  delay(3000);
  digitalWrite(RED_PIN, LOW);

  // Yellow light
  digitalWrite(YELLOW_PIN, HIGH);
  delay(1000);
  digitalWrite(YELLOW_PIN, LOW);

  // Green light
  digitalWrite(GREEN_PIN, HIGH);
  delay(3000);
  digitalWrite(GREEN_PIN, LOW);

  // Yellow light again
  digitalWrite(YELLOW_PIN, HIGH);
  delay(1000);
  digitalWrite(YELLOW_PIN, LOW);
}`,
    components: [
      {
        type: 'wokwi-arduino-uno',
        id: 'arduino-uno',
        x: 100,
        y: 100,
        properties: {},
      },
      {
        type: 'wokwi-led',
        id: 'led-red',
        x: 460,
        y: 100,
        properties: { color: 'red', pin: 13 },
      },
      {
        type: 'wokwi-led',
        id: 'led-yellow',
        x: 460,
        y: 200,
        properties: { color: 'yellow', pin: 12 },
      },
      {
        type: 'wokwi-led',
        id: 'led-green',
        x: 460,
        y: 300,
        properties: { color: 'green', pin: 11 },
      },
      // Series current-limiting resistors — one per LED. 220Ω is the
      // textbook value for a 5 V supply and a standard red/yellow/green
      // diode. Without them ngspice can't converge on a forward-biased
      // short and the LEDs stay dark on the canvas.
      {
        type: 'wokwi-resistor',
        id: 'r-red',
        x: 320,
        y: 110,
        properties: { value: '220' },
      },
      {
        type: 'wokwi-resistor',
        id: 'r-yellow',
        x: 320,
        y: 210,
        properties: { value: '220' },
      },
      {
        type: 'wokwi-resistor',
        id: 'r-green',
        x: 320,
        y: 310,
        properties: { value: '220' },
      },
    ],
    wires: [
      // Pin → resistor → LED anode (current-limit) → GND (cathode).
      {
        id: 'wire-red-pin',
        start: { componentId: 'arduino-uno', pinName: '13' },
        end: { componentId: 'r-red', pinName: '1' },
        color: '#ff0000',
      },
      {
        id: 'wire-red',
        start: { componentId: 'r-red', pinName: '2' },
        end: { componentId: 'led-red', pinName: 'A' },
        color: '#ff0000',
      },
      {
        id: 'wire-yellow-pin',
        start: { componentId: 'arduino-uno', pinName: '12' },
        end: { componentId: 'r-yellow', pinName: '1' },
        color: '#ffaa00',
      },
      {
        id: 'wire-yellow',
        start: { componentId: 'r-yellow', pinName: '2' },
        end: { componentId: 'led-yellow', pinName: 'A' },
        color: '#ffaa00',
      },
      {
        id: 'wire-green-pin',
        start: { componentId: 'arduino-uno', pinName: '11' },
        end: { componentId: 'r-green', pinName: '1' },
        color: '#00ff00',
      },
      {
        id: 'wire-green',
        start: { componentId: 'r-green', pinName: '2' },
        end: { componentId: 'led-green', pinName: 'A' },
        color: '#00ff00',
      },
      {
        id: 'wire-red-gnd',
        start: { componentId: 'led-red', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'wire-yellow-gnd',
        start: { componentId: 'led-yellow', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'wire-green-gnd',
        start: { componentId: 'led-green', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'button-led',
    title: 'Button Control',
    description: 'Control an LED with a pushbutton',
    category: 'basics',
    difficulty: 'beginner',
    code: `// Button LED Control
// Press button to turn LED on

const int BUTTON_PIN = 2;
const int LED_PIN = 13;

void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  int buttonState = digitalRead(BUTTON_PIN);

  if (buttonState == LOW) {
    digitalWrite(LED_PIN, HIGH);
  } else {
    digitalWrite(LED_PIN, LOW);
  }
}`,
    components: [
      {
        type: 'wokwi-arduino-uno',
        id: 'arduino-uno',
        x: 100,
        y: 100,
        properties: {},
      },
      {
        type: 'wokwi-pushbutton',
        id: 'button-1',
        x: 400,
        y: 100,
        properties: {},
      },
      {
        type: 'wokwi-led',
        id: 'led-1',
        x: 460,
        y: 250,
        properties: { color: 'red', pin: 13 },
      },
      // Series 220Ω current limiter — protects the LED from the
      // 5 V Arduino rail (textbook value).
      {
        type: 'wokwi-resistor',
        id: 'r-led',
        x: 320,
        y: 270,
        properties: { value: '220' },
      },
    ],
    wires: [
      {
        id: 'wire-button',
        start: { componentId: 'arduino-uno', pinName: '2' },
        end: { componentId: 'button-1', pinName: '1.l' },
        color: '#00aaff',
      },
      {
        id: 'wire-led-pin',
        start: { componentId: 'arduino-uno', pinName: '13' },
        end: { componentId: 'r-led', pinName: '1' },
        color: '#ff0000',
      },
      {
        id: 'wire-led',
        start: { componentId: 'r-led', pinName: '2' },
        end: { componentId: 'led-1', pinName: 'A' },
        color: '#ff0000',
      },
      {
        id: 'wire-led-gnd',
        start: { componentId: 'led-1', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'wire-button-gnd',
        start: { componentId: 'button-1', pinName: '2.l' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'fade-led',
    title: 'Fade LED',
    description: 'Smoothly fade an LED using PWM',
    category: 'basics',
    difficulty: 'beginner',
    code: `// Fade LED with PWM
// Smoothly fade LED brightness

const int LED_PIN = 9; // PWM pin

int brightness = 0;
int fadeAmount = 5;

void setup() {
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  analogWrite(LED_PIN, brightness);

  brightness += fadeAmount;

  if (brightness <= 0 || brightness >= 255) {
    fadeAmount = -fadeAmount;
  }

  delay(30);
}`,
    components: [
      {
        type: 'wokwi-arduino-uno',
        id: 'arduino-uno',
        x: 100,
        y: 100,
        properties: {},
      },
      {
        type: 'wokwi-led',
        id: 'led-1',
        x: 460,
        y: 150,
        properties: { color: 'blue', pin: 9 },
      },
      // Series 220Ω current limiter (textbook value for blue LED + 5 V).
      {
        type: 'wokwi-resistor',
        id: 'r-led',
        x: 320,
        y: 170,
        properties: { value: '220' },
      },
    ],
    wires: [
      {
        id: 'wire-led-pin',
        start: { componentId: 'arduino-uno', pinName: '9' },
        end: { componentId: 'r-led', pinName: '1' },
        color: '#0000ff',
      },
      {
        id: 'wire-led',
        start: { componentId: 'r-led', pinName: '2' },
        end: { componentId: 'led-1', pinName: 'A' },
        color: '#0000ff',
      },
      {
        id: 'wire-led-gnd',
        start: { componentId: 'led-1', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'serial-hello',
    title: 'Serial Hello World',
    description: 'Send messages through serial communication',
    category: 'communication',
    difficulty: 'beginner',
    code: `// Serial Communication Example
// Send messages to Serial Monitor

void setup() {
  Serial.begin(9600);
  Serial.println("Hello, Arduino!");
  Serial.println("System initialized");
}

void loop() {
  Serial.print("Uptime: ");
  Serial.print(millis() / 1000);
  Serial.println(" seconds");
  delay(2000);
}`,
    components: [
      {
        type: 'wokwi-arduino-uno',
        id: 'arduino-uno',
        x: 100,
        y: 100,
        properties: {},
      },
    ],
    wires: [],
  },
  {
    id: 'rgb-led',
    title: 'RGB LED Colors',
    description: 'Cycle through colors with an RGB LED',
    category: 'basics',
    difficulty: 'intermediate',
    code: `// RGB LED Color Cycling
// Display different colors

const int RED_PIN = 9;
const int GREEN_PIN = 10;
const int BLUE_PIN = 11;

void setup() {
  pinMode(RED_PIN, OUTPUT);
  pinMode(GREEN_PIN, OUTPUT);
  pinMode(BLUE_PIN, OUTPUT);
}

void setColor(int red, int green, int blue) {
  analogWrite(RED_PIN, red);
  analogWrite(GREEN_PIN, green);
  analogWrite(BLUE_PIN, blue);
}

void loop() {
  // Red
  setColor(255, 0, 0);
  delay(1000);

  // Green
  setColor(0, 255, 0);
  delay(1000);

  // Blue
  setColor(0, 0, 255);
  delay(1000);

  // Yellow
  setColor(255, 255, 0);
  delay(1000);

  // Cyan
  setColor(0, 255, 255);
  delay(1000);

  // Magenta
  setColor(255, 0, 255);
  delay(1000);

  // White
  setColor(255, 255, 255);
  delay(1000);
}`,
    components: [
      { type: 'wokwi-resistor', id: 'r-rgb-led-1-r', x: 180, y: 260, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-rgb-led-1-g', x: 180, y: 286, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-rgb-led-1-b', x: 180, y: 312, properties: { value: '220' } },
      {
        type: 'wokwi-arduino-uno',
        id: 'arduino-uno',
        x: 100,
        y: 100,
        properties: {},
      },
      {
        type: 'wokwi-rgb-led',
        id: 'rgb-led-1',
        x: 400,
        y: 150,
        properties: {},
      },
    ],
    wires: [
      {
        id: 'wire-red',
        start: { componentId: 'arduino-uno', pinName: '9' },
        end: { componentId: 'r-rgb-led-1-r', pinName: '1' },
        color: '#ff0000',
      },
      {
        id: 'w-r-rgb-led-1-r',
        start: { componentId: 'r-rgb-led-1-r', pinName: '2' },
        end: { componentId: 'rgb-led-1', pinName: 'R' },
        color: '#e74c3c',
      },
      {
        id: 'wire-green',
        start: { componentId: 'arduino-uno', pinName: '10' },
        end: { componentId: 'r-rgb-led-1-g', pinName: '1' },
        color: '#00ff00',
      },
      {
        id: 'w-r-rgb-led-1-g',
        start: { componentId: 'r-rgb-led-1-g', pinName: '2' },
        end: { componentId: 'rgb-led-1', pinName: 'G' },
        color: '#e74c3c',
      },
      {
        id: 'wire-blue',
        start: { componentId: 'arduino-uno', pinName: '11' },
        end: { componentId: 'r-rgb-led-1-b', pinName: '1' },
        color: '#0000ff',
      },
      {
        id: 'w-r-rgb-led-1-b',
        start: { componentId: 'r-rgb-led-1-b', pinName: '2' },
        end: { componentId: 'rgb-led-1', pinName: 'B' },
        color: '#e74c3c',
      },
      {
        id: 'wire-rgb-gnd',
        start: { componentId: 'rgb-led-1', pinName: 'COM' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'simon-says',
    title: 'Simon Says Game',
    description: 'Memory game with LEDs and buttons',
    category: 'games',
    difficulty: 'advanced',
    code: `// Simon Says Game
// Memory game with 4 LEDs and buttons

const int LED_PINS[] = {8, 9, 10, 11};
const int BUTTON_PINS[] = {2, 3, 4, 5};
const int NUM_LEDS = 4;

int sequence[100];
int sequenceLength = 0;
int currentStep = 0;

void setup() {
  Serial.begin(9600);

  for (int i = 0; i < NUM_LEDS; i++) {
    pinMode(LED_PINS[i], OUTPUT);
    pinMode(BUTTON_PINS[i], INPUT_PULLUP);
  }

  randomSeed(millis());
  newGame();
}

void newGame() {
  sequenceLength = 1;
  currentStep = 0;
  addToSequence();
  playSequence();
}

void addToSequence() {
  sequence[sequenceLength - 1] = random(0, NUM_LEDS);
}

void playSequence() {
  for (int i = 0; i < sequenceLength; i++) {
    flashLED(sequence[i]);
    delay(500);
  }
}

void flashLED(int led) {
  digitalWrite(LED_PINS[led], HIGH);
  delay(300);
  digitalWrite(LED_PINS[led], LOW);
}

void loop() {
  for (int i = 0; i < NUM_LEDS; i++) {
    if (digitalRead(BUTTON_PINS[i]) == LOW) {
      flashLED(i);

      if (i == sequence[currentStep]) {
        currentStep++;
        if (currentStep == sequenceLength) {
          delay(1000);
          sequenceLength++;
          currentStep = 0;
          addToSequence();
          playSequence();
        }
      } else {
        // Wrong button - game over
        for (int j = 0; j < 3; j++) {
          for (int k = 0; k < NUM_LEDS; k++) {
            digitalWrite(LED_PINS[k], HIGH);
          }
          delay(200);
          for (int k = 0; k < NUM_LEDS; k++) {
            digitalWrite(LED_PINS[k], LOW);
          }
          delay(200);
        }
        newGame();
      }

      delay(300);
      while (digitalRead(BUTTON_PINS[i]) == LOW);
    }
  }
}`,
    components: [
      {
        type: 'wokwi-arduino-uno',
        id: 'arduino-uno',
        x: 100,
        y: 100,
        properties: {},
      },
      {
        type: 'wokwi-led',
        id: 'led-red',
        x: 500,
        y: 100,
        properties: { color: 'red', pin: 8 },
      },
      {
        type: 'wokwi-led',
        id: 'led-green',
        x: 600,
        y: 100,
        properties: { color: 'green', pin: 9 },
      },
      {
        type: 'wokwi-led',
        id: 'led-blue',
        x: 500,
        y: 200,
        properties: { color: 'blue', pin: 10 },
      },
      {
        type: 'wokwi-led',
        id: 'led-yellow',
        x: 600,
        y: 200,
        properties: { color: 'yellow', pin: 11 },
      },
      // Series 220Ω current limiters — one per LED.
      {
        type: 'wokwi-resistor',
        id: 'r-led-red',
        x: 380,
        y: 110,
        properties: { value: '220' },
      },
      {
        type: 'wokwi-resistor',
        id: 'r-led-green',
        x: 380,
        y: 130,
        properties: { value: '220' },
      },
      {
        type: 'wokwi-resistor',
        id: 'r-led-blue',
        x: 380,
        y: 210,
        properties: { value: '220' },
      },
      {
        type: 'wokwi-resistor',
        id: 'r-led-yellow',
        x: 380,
        y: 230,
        properties: { value: '220' },
      },
      {
        type: 'wokwi-pushbutton',
        id: 'button-red',
        x: 450,
        y: 300,
        properties: {},
      },
      {
        type: 'wokwi-pushbutton',
        id: 'button-green',
        x: 550,
        y: 300,
        properties: {},
      },
      {
        type: 'wokwi-pushbutton',
        id: 'button-blue',
        x: 450,
        y: 400,
        properties: {},
      },
      {
        type: 'wokwi-pushbutton',
        id: 'button-yellow',
        x: 550,
        y: 400,
        properties: {},
      },
    ],
    wires: [
      {
        id: 'wire-led-red-pin',
        start: { componentId: 'arduino-uno', pinName: '8' },
        end: { componentId: 'r-led-red', pinName: '1' },
        color: '#ff0000',
      },
      {
        id: 'wire-led-red',
        start: { componentId: 'r-led-red', pinName: '2' },
        end: { componentId: 'led-red', pinName: 'A' },
        color: '#ff0000',
      },
      {
        id: 'wire-led-green-pin',
        start: { componentId: 'arduino-uno', pinName: '9' },
        end: { componentId: 'r-led-green', pinName: '1' },
        color: '#00ff00',
      },
      {
        id: 'wire-led-green',
        start: { componentId: 'r-led-green', pinName: '2' },
        end: { componentId: 'led-green', pinName: 'A' },
        color: '#00ff00',
      },
      {
        id: 'wire-led-blue-pin',
        start: { componentId: 'arduino-uno', pinName: '10' },
        end: { componentId: 'r-led-blue', pinName: '1' },
        color: '#0000ff',
      },
      {
        id: 'wire-led-blue',
        start: { componentId: 'r-led-blue', pinName: '2' },
        end: { componentId: 'led-blue', pinName: 'A' },
        color: '#0000ff',
      },
      {
        id: 'wire-led-yellow-pin',
        start: { componentId: 'arduino-uno', pinName: '11' },
        end: { componentId: 'r-led-yellow', pinName: '1' },
        color: '#ffaa00',
      },
      {
        id: 'wire-led-yellow',
        start: { componentId: 'r-led-yellow', pinName: '2' },
        end: { componentId: 'led-yellow', pinName: 'A' },
        color: '#ffaa00',
      },
      {
        id: 'wire-button-red',
        start: { componentId: 'arduino-uno', pinName: '2' },
        end: { componentId: 'button-red', pinName: '1.l' },
        color: '#00aaff',
      },
      {
        id: 'wire-button-green',
        start: { componentId: 'arduino-uno', pinName: '3' },
        end: { componentId: 'button-green', pinName: '1.l' },
        color: '#00aaff',
      },
      {
        id: 'wire-button-blue',
        start: { componentId: 'arduino-uno', pinName: '4' },
        end: { componentId: 'button-blue', pinName: '1.l' },
        color: '#00aaff',
      },
      {
        id: 'wire-button-yellow',
        start: { componentId: 'arduino-uno', pinName: '5' },
        end: { componentId: 'button-yellow', pinName: '1.l' },
        color: '#00aaff',
      },
      {
        id: 'wire-led-red-gnd',
        start: { componentId: 'led-red', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'wire-led-green-gnd',
        start: { componentId: 'led-green', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'wire-led-blue-gnd',
        start: { componentId: 'led-blue', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'wire-led-yellow-gnd',
        start: { componentId: 'led-yellow', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'wire-btn-red-gnd',
        start: { componentId: 'button-red', pinName: '2.l' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'wire-btn-green-gnd',
        start: { componentId: 'button-green', pinName: '2.l' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'wire-btn-blue-gnd',
        start: { componentId: 'button-blue', pinName: '2.l' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'wire-btn-yellow-gnd',
        start: { componentId: 'button-yellow', pinName: '2.l' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'pico-doom-raycaster',
    title: 'Pico Doom — Raycaster Demo',
    description:
      'Wolfenstein / early-Doom-style first-person 3D corridor on a Pi Pico + ILI9341 TFT. DDA raycasting at 160 rays/frame, no framebuffer (columns drawn straight to the TFT via drawFastVLine). Forward/back move, two more buttons turn the player. 16×16 tile map with 5 wall palettes (slate, blood, brown, toxic green, bronze door). The full id Software Doom needs the WAD assets shoehorned into 2 MB of flash with custom compression that the emulator cannot reproduce — this is the visual demo the Pico hardware actually runs in real life.',
    libraries: ['Adafruit GFX Library', 'Adafruit ILI9341'],
    category: 'games',
    difficulty: 'advanced',
    boardType: 'raspberry-pi-pico',
    tags: ['pico', 'rp2040', 'doom', 'raycaster', 'tft', 'ili9341', '3d', 'game'],
    code: `/*
 * Pico Doom — A Wolf3D-style raycaster running on Raspberry Pi Pico.
 *
 * Hardware
 *   Raspberry Pi Pico (RP2040) + ILI9341 SPI TFT (320x240, landscape)
 *   4 pushbuttons: forward, backward, turn left, turn right
 *
 * Pins
 *   SPI0:  SCK=GP18  MOSI=GP19  CS=GP17  DC=GP20  RST=GP21  LED=GP22
 *   Buttons (active LOW, INPUT_PULLUP):
 *          FWD=GP10  BACK=GP11  LEFT=GP12  RIGHT=GP13
 */

#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>
#include <math.h>

#define TFT_CS    17
#define TFT_DC    20
#define TFT_RST   21
#define TFT_LED   22
#define BTN_FWD   10
#define BTN_BACK  11
#define BTN_LEFT  12
#define BTN_RIGHT 13

Adafruit_ILI9341 tft(TFT_CS, TFT_DC, TFT_RST);

#define MAP_W 16
#define MAP_H 16
const uint8_t worldMap[MAP_H][MAP_W] = {
  {1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1},
  {1,0,0,0,0,0,0,2,2,2,0,0,0,0,0,1},
  {1,0,1,1,0,0,0,0,0,0,0,0,1,1,0,1},
  {1,0,1,0,0,0,3,3,0,0,0,0,0,0,0,1},
  {1,0,1,0,0,0,0,0,0,0,4,4,4,0,0,1},
  {1,0,1,1,1,0,0,5,5,0,0,0,0,0,0,1},
  {1,0,0,0,0,0,0,0,0,0,0,2,0,0,0,1},
  {1,0,3,3,3,3,0,0,0,2,2,0,0,0,0,1},
  {1,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1},
  {1,0,0,0,0,5,5,0,0,3,0,0,0,0,0,1},
  {1,4,0,0,0,0,0,0,0,0,0,0,0,0,0,1},
  {1,4,0,0,0,2,2,2,0,0,0,0,0,5,0,1},
  {1,4,0,0,0,0,0,0,0,0,3,3,3,0,0,1},
  {1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1},
  {1,0,0,4,4,4,4,4,4,0,0,0,0,0,0,1},
  {1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1},
};

float posX = 8.5f, posY = 8.5f;
float dirX = -1.0f, dirY = 0.0f;
float planeX = 0.0f, planeY = 0.66f;

#define SCREEN_W 320
#define SCREEN_H 240
#define HUD_H    40
#define VIEW_H   (SCREEN_H - HUD_H)
#define HALF_VH  (VIEW_H / 2)
#define SKY_COLOR   0x18C3
#define FLOOR_COLOR 0x4208

uint16_t wallColor(uint8_t tile, bool nsFace) {
  uint16_t c;
  switch (tile) {
    case 1: c = 0x8410; break;  // slate gray
    case 2: c = 0xC800; break;  // blood red
    case 3: c = 0x4A60; break;  // brown
    case 4: c = 0x32A0; break;  // toxic green
    case 5: c = 0xFD20; break;  // bronze door
    default: c = 0xFFFF; break;
  }
  if (nsFace) c = (c >> 1) & 0x7BEFu;
  return c;
}

void drawTitleScreen() {
  tft.fillScreen(ILI9341_BLACK);
  tft.setTextSize(6);
  tft.setTextColor(0xC800);
  tft.setCursor(60, 40);
  tft.print("DOOM");
  tft.setTextSize(2);
  tft.setTextColor(0xFFE0);
  tft.setCursor(50, 110);
  tft.print("Pico Edition");
  tft.setTextSize(1);
  tft.setTextColor(0xC618);
  tft.setCursor(40, 160);
  tft.print("FWD/BACK move   LEFT/RIGHT turn");
  tft.setTextSize(2);
  tft.setTextColor(0xFFFF);
  tft.setCursor(56, 200);
  tft.print("Press FWD to start");
  while (digitalRead(BTN_FWD) == HIGH) delay(40);
  while (digitalRead(BTN_FWD) == LOW)  delay(40);
}

void drawHUD() {
  tft.fillRect(0, SCREEN_H - HUD_H, SCREEN_W, HUD_H, 0x2104);
  tft.drawFastHLine(0, SCREEN_H - HUD_H, SCREEN_W, 0x52AA);
  tft.setTextSize(2);
  tft.setTextColor(0xFFE0);
  tft.setCursor(8, SCREEN_H - 28);
  tft.print("HP:100  ARM:50  AMMO:50");
}

void renderFrame() {
  tft.fillRect(0, 0,       SCREEN_W, HALF_VH, SKY_COLOR);
  tft.fillRect(0, HALF_VH, SCREEN_W, HALF_VH, FLOOR_COLOR);

  for (int x = 0; x < SCREEN_W; x += 2) {
    float cameraX = 2.0f * x / SCREEN_W - 1.0f;
    float rayDirX = dirX + planeX * cameraX;
    float rayDirY = dirY + planeY * cameraX;

    int mapX = (int)posX, mapY = (int)posY;
    float deltaDistX = (rayDirX == 0) ? 1e30f : fabsf(1.0f / rayDirX);
    float deltaDistY = (rayDirY == 0) ? 1e30f : fabsf(1.0f / rayDirY);

    int stepX, stepY;
    float sideDistX, sideDistY;
    if (rayDirX < 0) { stepX = -1; sideDistX = (posX - mapX)        * deltaDistX; }
    else             { stepX =  1; sideDistX = (mapX + 1.0f - posX) * deltaDistX; }
    if (rayDirY < 0) { stepY = -1; sideDistY = (posY - mapY)        * deltaDistY; }
    else             { stepY =  1; sideDistY = (mapY + 1.0f - posY) * deltaDistY; }

    bool hit = false, nsFace = false;
    int  iter = 0;
    while (!hit && iter++ < 64) {
      if (sideDistX < sideDistY) { sideDistX += deltaDistX; mapX += stepX; nsFace = false; }
      else                       { sideDistY += deltaDistY; mapY += stepY; nsFace = true;  }
      if (mapX < 0 || mapY < 0 || mapX >= MAP_W || mapY >= MAP_H) break;
      if (worldMap[mapY][mapX] > 0) hit = true;
    }
    if (!hit) continue;

    float perpDist = nsFace
      ? (mapY - posY + (1.0f - stepY) * 0.5f) / rayDirY
      : (mapX - posX + (1.0f - stepX) * 0.5f) / rayDirX;
    if (perpDist < 0.0001f) perpDist = 0.0001f;

    int lineH = (int)(VIEW_H / perpDist);
    int drawStart = HALF_VH - lineH / 2;
    int drawEnd   = HALF_VH + lineH / 2;
    if (drawStart < 0)      drawStart = 0;
    if (drawEnd   > VIEW_H) drawEnd   = VIEW_H;

    uint16_t color = wallColor(worldMap[mapY][mapX], nsFace);
    tft.drawFastVLine(x,     drawStart, drawEnd - drawStart, color);
    tft.drawFastVLine(x + 1, drawStart, drawEnd - drawStart, color);
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(TFT_LED, OUTPUT);
  digitalWrite(TFT_LED, HIGH);
  pinMode(BTN_FWD,   INPUT_PULLUP);
  pinMode(BTN_BACK,  INPUT_PULLUP);
  pinMode(BTN_LEFT,  INPUT_PULLUP);
  pinMode(BTN_RIGHT, INPUT_PULLUP);
  tft.begin();
  tft.setRotation(3);
  drawTitleScreen();
  tft.fillScreen(ILI9341_BLACK);
  drawHUD();
  Serial.println(F("Pico Doom — raycaster ready"));
}

unsigned long lastFrameMs = 0;
const float MOVE_SPEED = 0.10f;
const float ROT_SPEED  = 0.08f;

void loop() {
  unsigned long now = millis();
  if (now - lastFrameMs < 100) return;
  lastFrameMs = now;

  if (digitalRead(BTN_FWD) == LOW) {
    float nx = posX + dirX * MOVE_SPEED;
    float ny = posY + dirY * MOVE_SPEED;
    if (nx > 0 && nx < MAP_W && worldMap[(int)posY][(int)nx] == 0) posX = nx;
    if (ny > 0 && ny < MAP_H && worldMap[(int)ny][(int)posX] == 0) posY = ny;
  }
  if (digitalRead(BTN_BACK) == LOW) {
    float nx = posX - dirX * MOVE_SPEED;
    float ny = posY - dirY * MOVE_SPEED;
    if (nx > 0 && nx < MAP_W && worldMap[(int)posY][(int)nx] == 0) posX = nx;
    if (ny > 0 && ny < MAP_H && worldMap[(int)ny][(int)posX] == 0) posY = ny;
  }
  auto rotate = [](float &x, float &y, float a) {
    float ox = x;
    x = x * cosf(a) - y * sinf(a);
    y = ox * sinf(a) + y * cosf(a);
  };
  if (digitalRead(BTN_LEFT) == LOW)  { rotate(dirX, dirY,  ROT_SPEED); rotate(planeX, planeY,  ROT_SPEED); }
  if (digitalRead(BTN_RIGHT) == LOW) { rotate(dirX, dirY, -ROT_SPEED); rotate(planeX, planeY, -ROT_SPEED); }
  renderFrame();
}
`,
    components: [
      { type: 'wokwi-ili9341', id: 'tft1', x: 460, y: 60, properties: {} },
      {
        type: 'wokwi-pushbutton',
        id: 'btn-fwd',
        x: 220,
        y: 420,
        properties: { color: 'red', label: 'FWD' },
      },
      {
        type: 'wokwi-pushbutton',
        id: 'btn-back',
        x: 220,
        y: 520,
        properties: { color: 'blue', label: 'BACK' },
      },
      {
        type: 'wokwi-pushbutton',
        id: 'btn-left',
        x: 130,
        y: 470,
        properties: { color: 'green', label: 'LEFT' },
      },
      {
        type: 'wokwi-pushbutton',
        id: 'btn-right',
        x: 310,
        y: 470,
        properties: { color: 'green', label: 'RIGHT' },
      },
    ],
    wires: [
      // Power
      {
        id: 'w-tft-vcc',
        start: { componentId: 'raspberry-pi-pico', pinName: '3V3' },
        end: { componentId: 'tft1', pinName: 'VCC' },
        color: '#ff0000',
      },
      {
        id: 'w-tft-gnd',
        start: { componentId: 'raspberry-pi-pico', pinName: 'GND.5' },
        end: { componentId: 'tft1', pinName: 'GND' },
        color: '#000000',
      },
      // SPI bus + control lines to the ILI9341. MISO is GP16 — the
      // sketch's 3-arg Adafruit_ILI9341(CS, DC, RST) constructor uses
      // hardware SPI0, whose MISO pin is GP16. The driver writes only
      // (no register reads), so MISO is electrically idle, but the
      // wire is included so the circuit is didactically complete.
      {
        id: 'w-tft-sck',
        start: { componentId: 'raspberry-pi-pico', pinName: 'GP18' },
        end: { componentId: 'tft1', pinName: 'SCK' },
        color: '#ff8800',
      },
      {
        id: 'w-tft-mosi',
        start: { componentId: 'raspberry-pi-pico', pinName: 'GP19' },
        end: { componentId: 'tft1', pinName: 'MOSI' },
        color: '#ff8800',
      },
      {
        id: 'w-tft-miso',
        start: { componentId: 'raspberry-pi-pico', pinName: 'GP16' },
        end: { componentId: 'tft1', pinName: 'MISO' },
        color: '#ffaa44',
      },
      {
        id: 'w-tft-cs',
        start: { componentId: 'raspberry-pi-pico', pinName: 'GP17' },
        end: { componentId: 'tft1', pinName: 'CS' },
        color: '#00aaff',
      },
      {
        id: 'w-tft-dc',
        start: { componentId: 'raspberry-pi-pico', pinName: 'GP20' },
        end: { componentId: 'tft1', pinName: 'D/C' },
        color: '#00cc00',
      },
      {
        id: 'w-tft-rst',
        start: { componentId: 'raspberry-pi-pico', pinName: 'GP21' },
        end: { componentId: 'tft1', pinName: 'RST' },
        color: '#cc0000',
      },
      {
        id: 'w-tft-led',
        start: { componentId: 'raspberry-pi-pico', pinName: 'GP22' },
        end: { componentId: 'tft1', pinName: 'LED' },
        color: '#ffffff',
      },
      // Buttons signal + GND each
      {
        id: 'w-btn-fwd',
        start: { componentId: 'raspberry-pi-pico', pinName: 'GP10' },
        end: { componentId: 'btn-fwd', pinName: '1.l' },
        color: '#ff4444',
      },
      {
        id: 'w-btn-back',
        start: { componentId: 'raspberry-pi-pico', pinName: 'GP11' },
        end: { componentId: 'btn-back', pinName: '1.l' },
        color: '#4477ff',
      },
      {
        id: 'w-btn-left',
        start: { componentId: 'raspberry-pi-pico', pinName: 'GP12' },
        end: { componentId: 'btn-left', pinName: '1.l' },
        color: '#44cc44',
      },
      {
        id: 'w-btn-right',
        start: { componentId: 'raspberry-pi-pico', pinName: 'GP13' },
        end: { componentId: 'btn-right', pinName: '1.l' },
        color: '#cccc44',
      },
      {
        id: 'w-gnd-fwd',
        start: { componentId: 'btn-fwd', pinName: '2.l' },
        end: { componentId: 'raspberry-pi-pico', pinName: 'GND.1' },
        color: '#000000',
      },
      {
        id: 'w-gnd-back',
        start: { componentId: 'btn-back', pinName: '2.l' },
        end: { componentId: 'raspberry-pi-pico', pinName: 'GND.2' },
        color: '#000000',
      },
      {
        id: 'w-gnd-left',
        start: { componentId: 'btn-left', pinName: '2.l' },
        end: { componentId: 'raspberry-pi-pico', pinName: 'GND.3' },
        color: '#000000',
      },
      {
        id: 'w-gnd-right',
        start: { componentId: 'btn-right', pinName: '2.l' },
        end: { componentId: 'raspberry-pi-pico', pinName: 'GND.4' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'tft-display',
    title: 'TFT ILI9341 Display',
    description:
      'Color TFT display demo: fills, text, and a bouncing ball animation using the Adafruit ILI9341 library (240x320)',
    libraries: ['Adafruit GFX Library', 'Adafruit ILI9341'],
    category: 'displays',
    difficulty: 'intermediate',
    code: `// TFT ILI9341 Display Demo (240x320)
// Library: Adafruit ILI9341 + Adafruit GFX
// Connect: CS=10, DC/RS=9, RST=8, LED=7, MOSI=11(SPI), SCK=13(SPI)

#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>
#include <SPI.h>

#define TFT_CS   10
#define TFT_DC    9
#define TFT_RST   8
#define TFT_LED   7

Adafruit_ILI9341 tft(TFT_CS, TFT_DC, TFT_RST);

// Background color: blue (visible on dark simulator canvas)
#define BG_COLOR 0x001F

// Ball state
int ballX = 120, ballY = 200;
int ballDX = 3, ballDY = 2;
const int BALL_R = 10;

// Play-field boundaries
const int FX = 5, FY = 110, FW = 230, FH = 200;

void drawStaticUI() {
  tft.fillScreen(BG_COLOR);

  // Title
  tft.setTextSize(3);
  tft.setTextColor(tft.color565(255, 220, 0));
  tft.setCursor(20, 10);
  tft.print("VELXIO TFT");

  // Subtitle
  tft.setTextSize(2);
  tft.setTextColor(tft.color565(180, 180, 255));
  tft.setCursor(30, 50);
  tft.print("ILI9341 Demo");

  // Color palette bars
  tft.fillRect(10, 82, 70, 18, tft.color565(220, 50, 50));
  tft.fillRect(85, 82, 70, 18, tft.color565(50, 200, 50));
  tft.fillRect(160, 82, 70, 18, tft.color565(50, 100, 240));

  // Play-field border
  tft.drawRect(FX, FY, FW, FH, tft.color565(80, 80, 130));
}

void setup() {
  pinMode(TFT_LED, OUTPUT);
  digitalWrite(TFT_LED, HIGH);

  tft.begin();
  drawStaticUI();
}

void loop() {
  // Erase old ball
  tft.fillCircle(ballX, ballY, BALL_R, BG_COLOR);

  // Update position
  ballX += ballDX;
  ballY += ballDY;

  // Bounce off field borders
  if (ballX < FX + BALL_R + 1 || ballX > FX + FW - BALL_R - 1) ballDX = -ballDX;
  if (ballY < FY + BALL_R + 1 || ballY > FY + FH - BALL_R - 1) ballDY = -ballDY;

  // Draw ball
  tft.fillCircle(ballX, ballY, BALL_R, tft.color565(255, 140, 0));

  delay(30);
}
`,
    components: [
      {
        type: 'wokwi-arduino-uno',
        id: 'arduino-uno',
        x: 80,
        y: 220,
        properties: {},
      },
      {
        type: 'wokwi-ili9341',
        id: 'tft1',
        x: 300,
        y: 30,
        properties: {},
      },
    ],
    wires: [
      {
        id: 'w-sck',
        start: { componentId: 'arduino-uno', pinName: '13' },
        end: { componentId: 'tft1', pinName: 'SCK' },
        color: '#ff8800',
      },
      {
        id: 'w-mosi',
        start: { componentId: 'arduino-uno', pinName: '11' },
        end: { componentId: 'tft1', pinName: 'MOSI' },
        color: '#ff8800',
      },
      {
        id: 'w-cs',
        start: { componentId: 'arduino-uno', pinName: '10' },
        end: { componentId: 'tft1', pinName: 'CS' },
        color: '#00aaff',
      },
      {
        id: 'w-dc',
        start: { componentId: 'arduino-uno', pinName: '9' },
        end: { componentId: 'tft1', pinName: 'D/C' },
        color: '#00cc00',
      },
      {
        id: 'w-rst',
        start: { componentId: 'arduino-uno', pinName: '8' },
        end: { componentId: 'tft1', pinName: 'RST' },
        color: '#cc0000',
      },
      {
        id: 'w-led',
        start: { componentId: 'arduino-uno', pinName: '7' },
        end: { componentId: 'tft1', pinName: 'LED' },
        color: '#ffffff',
      },
    ],
  },
  {
    id: 'lcd-hello',
    title: 'LCD 20x4 Display',
    description: 'Display text on a 20x4 LCD using the LiquidCrystal library',
    category: 'displays',
    difficulty: 'intermediate',
    libraries: ['LiquidCrystal'],
    code: `// LiquidCrystal Library - Hello World
// Demonstrates the use a 20x4 LCD display

#include <LiquidCrystal.h>

// initialize the library by associating any needed LCD interface pin
// with the arduino pin number it is connected to
const int rs = 12, en = 11, d4 = 5, d5 = 4, d6 = 3, d7 = 2;
LiquidCrystal lcd(rs, en, d4, d5, d6, d7);

void setup() {
  // set up the LCD's number of columns and rows:
  lcd.begin(20, 4);
  // Print a message to the LCD.
  lcd.print("Hello, Arduino!");
  lcd.setCursor(0, 1);
  lcd.print("Velxio Emulator");
  lcd.setCursor(0, 2);
  lcd.print("LCD 2004 Test");
}

void loop() {
  // set the cursor to column 0, line 3
  lcd.setCursor(0, 3);
  // print the number of seconds since reset:
  lcd.print("Uptime: ");
  lcd.print(millis() / 1000);
}
`,
    components: [
      {
        type: 'wokwi-arduino-uno',
        id: 'arduino-uno',
        x: 100,
        y: 100,
        properties: {},
      },
      {
        type: 'wokwi-lcd2004',
        id: 'lcd1',
        x: 450,
        y: 100,
        properties: { pins: 'full' },
      },
    ],
    wires: [
      {
        id: 'w-rs',
        start: { componentId: 'arduino-uno', pinName: '12' },
        end: { componentId: 'lcd1', pinName: 'RS' },
        color: 'green',
      },
      {
        id: 'w-en',
        start: { componentId: 'arduino-uno', pinName: '11' },
        end: { componentId: 'lcd1', pinName: 'E' },
        color: 'green',
      },
      {
        id: 'w-d4',
        start: { componentId: 'arduino-uno', pinName: '5' },
        end: { componentId: 'lcd1', pinName: 'D4' },
        color: 'blue',
      },
      {
        id: 'w-d5',
        start: { componentId: 'arduino-uno', pinName: '4' },
        end: { componentId: 'lcd1', pinName: 'D5' },
        color: 'blue',
      },
      {
        id: 'w-d6',
        start: { componentId: 'arduino-uno', pinName: '3' },
        end: { componentId: 'lcd1', pinName: 'D6' },
        color: 'blue',
      },
      {
        id: 'w-d7',
        start: { componentId: 'arduino-uno', pinName: '2' },
        end: { componentId: 'lcd1', pinName: 'D7' },
        color: 'blue',
      },
      // Power / Contrast logic is usually handled internally or ignored in basic simulation
    ],
  },
  // ─── Protocol Test Examples ──────────────────────────────────────────────
  {
    id: 'serial-echo',
    title: 'Serial Echo (USART)',
    description:
      'Tests Serial communication: echoes typed characters back and prints status. Open the Serial Monitor to interact.',
    category: 'communication',
    difficulty: 'beginner',
    code: `// Serial Echo — USART Protocol Test
// Open the Serial Monitor to send and receive data.
// Everything you type is echoed back with extra info.

void setup() {
  Serial.begin(9600);
  Serial.println("=============================");
  Serial.println("  Serial Echo Test (USART)");
  Serial.println("=============================");
  Serial.println("Type something and press Send.");
  Serial.println();

  // Print system info
  Serial.print("CPU Clock: ");
  Serial.print(F_CPU / 1000000);
  Serial.println(" MHz");
  Serial.print("Baud rate: 9600");
  Serial.println();
  Serial.println();
}

unsigned long charCount = 0;

void loop() {
  if (Serial.available() > 0) {
    char c = Serial.read();
    charCount++;

    Serial.print("[");
    Serial.print(charCount);
    Serial.print("] Received: '");
    Serial.print(c);
    Serial.print("' (ASCII ");
    Serial.print((int)c);
    Serial.println(")");
  }

  // Periodic heartbeat
  static unsigned long lastBeat = 0;
  if (millis() - lastBeat >= 5000) {
    lastBeat = millis();
    Serial.print("Uptime: ");
    Serial.print(millis() / 1000);
    Serial.print("s | Chars received: ");
    Serial.println(charCount);
  }
}
`,
    components: [{ type: 'wokwi-arduino-uno', id: 'arduino-uno', x: 100, y: 100, properties: {} }],
    wires: [],
  },
  {
    id: 'serial-led-control',
    title: 'Serial LED Control',
    description:
      'Control an LED via Serial commands: send "1" or "0". Tests USART RX + GPIO output together.',
    category: 'communication',
    difficulty: 'beginner',
    code: `// Serial LED Control
// Send "1" to turn LED ON, "0" to turn LED OFF.
// Demonstrates Serial input controlling hardware.

const int LED_PIN = 13;

void setup() {
  Serial.begin(9600);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Serial.println("=========================");
  Serial.println(" Serial LED Controller");
  Serial.println("=========================");
  Serial.println("Send '1' = LED ON");
  Serial.println("Send '0' = LED OFF");
  Serial.println("Send '?' = Status");
  Serial.println();
}

bool ledState = false;

void loop() {
  if (Serial.available() > 0) {
    char cmd = Serial.read();

    switch (cmd) {
      case '1':
        digitalWrite(LED_PIN, HIGH);
        ledState = true;
        Serial.println("[OK] LED is ON");
        break;
      case '0':
        digitalWrite(LED_PIN, LOW);
        ledState = false;
        Serial.println("[OK] LED is OFF");
        break;
      case '?':
        Serial.print("[STATUS] LED is ");
        Serial.println(ledState ? "ON" : "OFF");
        Serial.print("[STATUS] Uptime: ");
        Serial.print(millis() / 1000);
        Serial.println("s");
        break;
      default:
        if (cmd >= 32) { // ignore control chars
          Serial.print("[ERR] Unknown command: '");
          Serial.print(cmd);
          Serial.println("'  (use 1, 0, or ?)");
        }
        break;
    }
  }
}
`,
    components: [
      { type: 'wokwi-resistor', id: 'r-led-1-a', x: 280, y: 120, properties: { value: '220' } },
      { type: 'wokwi-arduino-uno', id: 'arduino-uno', x: 100, y: 100, properties: {} },
      { type: 'wokwi-led', id: 'led-1', x: 400, y: 120, properties: { color: 'green' } },
    ],
    wires: [
      {
        id: 'w-led',
        start: { componentId: 'arduino-uno', pinName: '13' },
        end: { componentId: 'r-led-1-a', pinName: '1' },
        color: '#00cc00',
      },
      {
        id: 'w-r-led-1-a',
        start: { componentId: 'r-led-1-a', pinName: '2' },
        end: { componentId: 'led-1', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w-led-gnd',
        start: { componentId: 'led-1', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'i2c-scanner',
    title: 'I2C Scanner (TWI)',
    description:
      'Scans the I2C bus and reports all devices found. SSD1306 OLED (0x3C) is wired on canvas; virtual devices at 0x48, 0x50, 0x68 also respond.',
    category: 'communication',
    difficulty: 'intermediate',
    code: `// I2C Bus Scanner — TWI Protocol Test
// Scans all 127 I2C addresses and reports which ones respond with ACK.
// The emulator has virtual devices at:
//   0x48 = Temperature sensor
//   0x50 = EEPROM
//   0x68 = DS1307 RTC

#include <Wire.h>

void setup() {
  Wire.begin();
  Serial.begin(9600);

  Serial.println("===========================");
  Serial.println("  I2C Bus Scanner (TWI)");
  Serial.println("===========================");
  Serial.println("Scanning...");
  Serial.println();

  int devicesFound = 0;

  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    byte error = Wire.endTransmission();

    if (error == 0) {
      Serial.print("  Device found at 0x");
      if (addr < 16) Serial.print("0");
      Serial.print(addr, HEX);

      // Identify known addresses
      switch (addr) {
        case 0x27: Serial.print("  (PCF8574 LCD backpack)"); break;
        case 0x3C: Serial.print("  (SSD1306 OLED)"); break;
        case 0x48: Serial.print("  (Temperature sensor)"); break;
        case 0x50: Serial.print("  (EEPROM)"); break;
        case 0x68: Serial.print("  (DS1307 RTC)"); break;
        case 0x76: Serial.print("  (BME280 sensor)"); break;
        case 0x77: Serial.print("  (BMP180/BMP280)"); break;
      }
      Serial.println();
      devicesFound++;
    }
  }

  Serial.println();
  Serial.print("Scan complete. ");
  Serial.print(devicesFound);
  Serial.println(" device(s) found.");

  if (devicesFound == 0) {
    Serial.println("No I2C devices found. Check connections.");
  }
}

void loop() {
  // Rescan every 10 seconds
  delay(10000);
  Serial.println("\\nRescanning...");
  setup();
}
`,
    components: [
      { type: 'wokwi-arduino-uno', id: 'arduino-uno', x: 100, y: 100, properties: {} },
      { type: 'wokwi-ssd1306', id: 'ssd1306-1', x: 420, y: 100, properties: {} },
      { type: 'wokwi-ds1307', id: 'rtc1', x: 420, y: 280, properties: {} },
    ],
    wires: [
      // SDA bus (shared)
      {
        id: 'wire-sda',
        start: { componentId: 'arduino-uno', pinName: 'A4' },
        end: { componentId: 'ssd1306-1', pinName: 'DATA' },
        color: '#2196f3',
      },
      {
        id: 'wire-sda-rtc',
        start: { componentId: 'ssd1306-1', pinName: 'DATA' },
        end: { componentId: 'rtc1', pinName: 'SDA' },
        color: '#2196f3',
      },
      // SCL bus (shared)
      {
        id: 'wire-scl',
        start: { componentId: 'arduino-uno', pinName: 'A5' },
        end: { componentId: 'ssd1306-1', pinName: 'CLK' },
        color: '#ff9800',
      },
      {
        id: 'wire-scl-rtc',
        start: { componentId: 'ssd1306-1', pinName: 'CLK' },
        end: { componentId: 'rtc1', pinName: 'SCL' },
        color: '#ff9800',
      },
      // Power + ground for both devices
      {
        id: 'wire-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND.1' },
        end: { componentId: 'ssd1306-1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'wire-gnd-rtc',
        start: { componentId: 'ssd1306-1', pinName: 'GND' },
        end: { componentId: 'rtc1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'wire-vcc',
        start: { componentId: 'arduino-uno', pinName: '5V' },
        end: { componentId: 'ssd1306-1', pinName: 'VIN' },
        color: '#ff0000',
      },
      {
        id: 'wire-vcc-rtc',
        start: { componentId: 'ssd1306-1', pinName: 'VIN' },
        end: { componentId: 'rtc1', pinName: 'VCC' },
        color: '#ff0000',
      },
    ],
  },
  {
    id: 'i2c-rtc-read',
    title: 'I2C RTC Clock (DS1307)',
    description:
      'Reads time from a virtual DS1307 RTC via I2C and prints it to Serial. Tests TWI read transactions.',
    category: 'communication',
    difficulty: 'intermediate',
    code: `// I2C RTC Reader — DS1307 at address 0x68
// Reads hours:minutes:seconds from the virtual RTC
// and prints to Serial Monitor every second.

#include <Wire.h>

#define DS1307_ADDR 0x68

byte bcdToDec(byte val) {
  return ((val >> 4) * 10) + (val & 0x0F);
}

void setup() {
  Wire.begin();
  Serial.begin(9600);

  Serial.println("===========================");
  Serial.println("  DS1307 RTC Reader (I2C)");
  Serial.println("===========================");
  Serial.println();
}

void loop() {
  // Set register pointer to 0 (seconds)
  Wire.beginTransmission(DS1307_ADDR);
  Wire.write(0x00);
  Wire.endTransmission();

  // Request 7 bytes: sec, min, hr, dow, date, month, year
  Wire.requestFrom(DS1307_ADDR, 7);

  if (Wire.available() >= 7) {
    byte sec   = bcdToDec(Wire.read() & 0x7F);
    byte min   = bcdToDec(Wire.read());
    byte hr    = bcdToDec(Wire.read() & 0x3F);
    byte dow   = bcdToDec(Wire.read());
    byte date  = bcdToDec(Wire.read());
    byte month = bcdToDec(Wire.read());
    byte year  = bcdToDec(Wire.read());

    // Print formatted time
    Serial.print("Time: ");
    if (hr < 10) Serial.print("0");
    Serial.print(hr);
    Serial.print(":");
    if (min < 10) Serial.print("0");
    Serial.print(min);
    Serial.print(":");
    if (sec < 10) Serial.print("0");
    Serial.print(sec);

    Serial.print("  Date: ");
    if (date < 10) Serial.print("0");
    Serial.print(date);
    Serial.print("/");
    if (month < 10) Serial.print("0");
    Serial.print(month);
    Serial.print("/20");
    if (year < 10) Serial.print("0");
    Serial.println(year);
  } else {
    Serial.println("Error: Could not read RTC");
  }

  delay(1000);
}
`,
    components: [
      { type: 'wokwi-arduino-uno', id: 'arduino-uno', x: 100, y: 100, properties: {} },
      { type: 'wokwi-ds1307', id: 'rtc1', x: 480, y: 200, properties: {} },
    ],
    wires: [
      {
        id: 'w-sda',
        start: { componentId: 'arduino-uno', pinName: 'A4' },
        end: { componentId: 'rtc1', pinName: 'SDA' },
        color: '#0066cc',
      },
      {
        id: 'w-scl',
        start: { componentId: 'arduino-uno', pinName: 'A5' },
        end: { componentId: 'rtc1', pinName: 'SCL' },
        color: '#ffaa00',
      },
      {
        id: 'w-vcc',
        start: { componentId: 'arduino-uno', pinName: '5V' },
        end: { componentId: 'rtc1', pinName: 'VCC' },
        color: '#ff0000',
      },
      {
        id: 'w-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND' },
        end: { componentId: 'rtc1', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'i2c-eeprom-rw',
    title: 'I2C EEPROM Read/Write',
    description:
      'Writes data to a virtual I2C EEPROM (0x50) and reads it back. Tests TWI write+read transactions.',
    category: 'communication',
    difficulty: 'intermediate',
    code: `// I2C EEPROM Read/Write Test
// Virtual EEPROM at address 0x50
// Writes values to registers, then reads them back.

#include <Wire.h>

#define EEPROM_ADDR 0x50

void writeEEPROM(byte reg, byte value) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write(reg);    // register address
  Wire.write(value);  // data
  Wire.endTransmission();
  delay(5); // EEPROM write cycle time
}

byte readEEPROM(byte reg) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write(reg);
  Wire.endTransmission();

  Wire.requestFrom(EEPROM_ADDR, 1);
  if (Wire.available()) {
    return Wire.read();
  }
  return 0xFF;
}

void setup() {
  Wire.begin();
  Serial.begin(9600);

  Serial.println("============================");
  Serial.println(" I2C EEPROM R/W Test (0x50)");
  Serial.println("============================");
  Serial.println();

  // Write test pattern
  Serial.println("Writing test data...");
  for (byte i = 0; i < 8; i++) {
    byte value = (i + 1) * 10;  // 10, 20, 30, ...
    writeEEPROM(i, value);
    Serial.print("  Write reg[");
    Serial.print(i);
    Serial.print("] = ");
    Serial.println(value);
  }

  Serial.println();
  Serial.println("Reading back...");

  // Read back and verify
  byte errors = 0;
  for (byte i = 0; i < 8; i++) {
    byte expected = (i + 1) * 10;
    byte actual = readEEPROM(i);
    Serial.print("  Read  reg[");
    Serial.print(i);
    Serial.print("] = ");
    Serial.print(actual);

    if (actual == expected) {
      Serial.println("  [OK]");
    } else {
      Serial.print("  [FAIL] expected ");
      Serial.println(expected);
      errors++;
    }
  }

  Serial.println();
  if (errors == 0) {
    Serial.println("All tests PASSED!");
  } else {
    Serial.print(errors);
    Serial.println(" test(s) FAILED.");
  }
}

void loop() {
  // Nothing to do
  delay(1000);
}
`,
    components: [{ type: 'wokwi-arduino-uno', id: 'arduino-uno', x: 100, y: 100, properties: {} }],
    wires: [],
  },
  {
    id: 'spi-loopback',
    title: 'SPI Loopback Test',
    description:
      'Tests SPI by sending bytes and reading responses. Demonstrates MOSI/MISO/SCK/SS protocol.',
    category: 'communication',
    difficulty: 'intermediate',
    code: `// SPI Loopback Test
// Sends bytes via SPI and logs the exchange.
// Without a physical slave, the emulator returns the sent byte.

#include <SPI.h>

#define SS_PIN 10

void setup() {
  Serial.begin(9600);
  Serial.println("========================");
  Serial.println("  SPI Protocol Test");
  Serial.println("========================");
  Serial.println();

  pinMode(SS_PIN, OUTPUT);
  digitalWrite(SS_PIN, HIGH);
  SPI.begin();
  SPI.setClockDivider(SPI_CLOCK_DIV16);

  Serial.println("SPI initialized.");
  Serial.print("Clock divider: 16 (");
  Serial.print(F_CPU / 16);
  Serial.println(" Hz)");
  Serial.println();

  // Send test pattern
  Serial.println("Sending test pattern via SPI:");
  byte testData[] = {0xAA, 0x55, 0xFF, 0x00, 0x42, 0xDE, 0xAD, 0xBE};

  digitalWrite(SS_PIN, LOW);  // Select slave

  for (int i = 0; i < sizeof(testData); i++) {
    byte sent = testData[i];
    byte received = SPI.transfer(sent);

    Serial.print("  TX: 0x");
    if (sent < 16) Serial.print("0");
    Serial.print(sent, HEX);
    Serial.print("  RX: 0x");
    if (received < 16) Serial.print("0");
    Serial.print(received, HEX);

    if (sent == received) {
      Serial.println("  (loopback OK)");
    } else {
      Serial.println();
    }
  }

  digitalWrite(SS_PIN, HIGH);  // Deselect slave

  Serial.println();
  Serial.println("SPI test complete.");
}

void loop() {
  delay(1000);
}
`,
    components: [{ type: 'wokwi-arduino-uno', id: 'arduino-uno', x: 100, y: 100, properties: {} }],
    wires: [],
  },
  {
    id: 'multi-protocol',
    title: 'Multi-Protocol Demo',
    description:
      'Uses Serial + I2C + SPI together. Reads RTC via I2C, sends SPI data, and logs everything to Serial.',
    category: 'communication',
    difficulty: 'advanced',
    code: `// Multi-Protocol Demo: Serial + I2C + SPI
// Demonstrates all three major communication protocols
// working together in a single sketch.

#include <Wire.h>
#include <SPI.h>

#define DS1307_ADDR 0x68
#define EEPROM_ADDR 0x50
#define SS_PIN 10

byte bcdToDec(byte val) {
  return ((val >> 4) * 10) + (val & 0x0F);
}

void readRTC(byte &hr, byte &min, byte &sec) {
  Wire.beginTransmission(DS1307_ADDR);
  Wire.write(0x00);
  Wire.endTransmission();
  Wire.requestFrom(DS1307_ADDR, 3);
  sec = bcdToDec(Wire.read() & 0x7F);
  min = bcdToDec(Wire.read());
  hr  = bcdToDec(Wire.read() & 0x3F);
}

void writeEEPROM(byte reg, byte value) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write(reg);
  Wire.write(value);
  Wire.endTransmission();
  delay(5);
}

byte readEEPROM(byte reg) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write(reg);
  Wire.endTransmission();
  Wire.requestFrom(EEPROM_ADDR, 1);
  return Wire.available() ? Wire.read() : 0xFF;
}

byte spiTransfer(byte data) {
  digitalWrite(SS_PIN, LOW);
  byte result = SPI.transfer(data);
  digitalWrite(SS_PIN, HIGH);
  return result;
}

void setup() {
  Serial.begin(9600);
  Wire.begin();
  pinMode(SS_PIN, OUTPUT);
  digitalWrite(SS_PIN, HIGH);
  SPI.begin();

  Serial.println("===================================");
  Serial.println(" Multi-Protocol Demo");
  Serial.println(" Serial (USART) + I2C (TWI) + SPI");
  Serial.println("===================================");
  Serial.println();

  // ── I2C: Scan bus ──
  Serial.println("[I2C] Scanning bus...");
  int found = 0;
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.print("  Found device at 0x");
      if (addr < 16) Serial.print("0");
      Serial.println(addr, HEX);
      found++;
    }
  }
  Serial.print("  ");
  Serial.print(found);
  Serial.println(" device(s) on I2C bus.");
  Serial.println();

  // ── I2C: Write/read EEPROM ──
  Serial.println("[I2C] EEPROM write/read test:");
  writeEEPROM(0, 42);
  writeEEPROM(1, 99);
  byte v0 = readEEPROM(0);
  byte v1 = readEEPROM(1);
  Serial.print("  Wrote 42, read ");
  Serial.print(v0);
  Serial.println(v0 == 42 ? " [OK]" : " [FAIL]");
  Serial.print("  Wrote 99, read ");
  Serial.print(v1);
  Serial.println(v1 == 99 ? " [OK]" : " [FAIL]");
  Serial.println();

  // ── SPI: Transfer test ──
  Serial.println("[SPI] Transfer test:");
  byte spiData[] = {0xAA, 0x55, 0x42};
  for (int i = 0; i < 3; i++) {
    byte rx = spiTransfer(spiData[i]);
    Serial.print("  TX=0x");
    if (spiData[i] < 16) Serial.print("0");
    Serial.print(spiData[i], HEX);
    Serial.print(" RX=0x");
    if (rx < 16) Serial.print("0");
    Serial.println(rx, HEX);
  }
  Serial.println();

  Serial.println("Setup complete. Reading RTC...");
  Serial.println();
}

void loop() {
  // ── Serial: Print RTC time every 2 seconds ──
  byte hr, min, sec;
  readRTC(hr, min, sec);

  Serial.print("[RTC] ");
  if (hr < 10) Serial.print("0");
  Serial.print(hr);
  Serial.print(":");
  if (min < 10) Serial.print("0");
  Serial.print(min);
  Serial.print(":");
  if (sec < 10) Serial.print("0");
  Serial.print(sec);

  Serial.print("  |  Uptime: ");
  Serial.print(millis() / 1000);
  Serial.println("s");

  delay(2000);
}
`,
    components: [{ type: 'wokwi-arduino-uno', id: 'arduino-uno', x: 100, y: 100, properties: {} }],
    wires: [],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // Raspberry Pi Pico (RP2040) Examples
  // ──────────────────────────────────────────────────────────────────────────

  {
    id: 'pico-blink',
    title: '[Pico] Blink LED',
    description: 'Classic blink example on Raspberry Pi Pico — GPIO25 built-in LED',
    category: 'basics',
    difficulty: 'beginner',
    boardType: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — Blink LED
// Toggles the onboard LED on GPIO 25

void setup() {
  pinMode(LED_BUILTIN, OUTPUT); // GPIO 25
  Serial.begin(115200);
  Serial.println("Pico Blink Example");
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.println("LED ON");
  delay(500);

  digitalWrite(LED_BUILTIN, LOW);
  Serial.println("LED OFF");
  delay(500);
}
`,
    components: [
      { type: 'wokwi-led', id: 'led-blink', x: 400, y: 120, properties: { color: 'green' } },
      { type: 'wokwi-resistor', id: 'r1', x: 400, y: 200, properties: { value: '220' } },
    ],
    wires: [
      {
        id: 'w1',
        start: { componentId: 'arduino-uno', pinName: 'GP25' },
        end: { componentId: 'led-blink', pinName: 'A' },
        color: '#00cc00',
      },
      {
        id: 'w2',
        start: { componentId: 'led-blink', pinName: 'C' },
        end: { componentId: 'r1', pinName: '1' },
        color: '#999999',
      },
      {
        id: 'w3',
        start: { componentId: 'r1', pinName: '2' },
        end: { componentId: 'arduino-uno', pinName: 'GND.1' },
        color: '#000000',
      },
    ],
  },

  {
    id: 'pico-serial-echo',
    title: '[Pico] Serial Echo',
    description: 'Echo serial input back with a timestamp — tests UART on RP2040',
    category: 'communication',
    difficulty: 'beginner',
    boardType: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — Serial Echo Test
// Echoes received characters and prints a heartbeat every 2 seconds

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("=== Pico Serial Echo ===");
  Serial.println("Type something and press Enter.");
  Serial.println();
}

unsigned long lastHeartbeat = 0;

void loop() {
  // Echo any incoming characters
  while (Serial.available()) {
    char c = Serial.read();
    Serial.print("Echo: ");
    Serial.println(c);
  }

  // Heartbeat every 2 seconds
  if (millis() - lastHeartbeat >= 2000) {
    lastHeartbeat = millis();
    Serial.print("[Heartbeat] Uptime: ");
    Serial.print(millis() / 1000);
    Serial.println("s");
  }
}
`,
    components: [
      { type: 'wokwi-resistor', id: 'r-led-rx-a', x: 280, y: 120, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'led-rx', x: 400, y: 120, properties: { color: 'yellow' } },
    ],
    wires: [
      {
        id: 'w1',
        start: { componentId: 'arduino-uno', pinName: 'GP0' },
        end: { componentId: 'r-led-rx-a', pinName: '1' },
        color: '#ff8800',
      },
      {
        id: 'w-r-led-rx-a',
        start: { componentId: 'r-led-rx-a', pinName: '2' },
        end: { componentId: 'led-rx', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w2',
        start: { componentId: 'led-rx', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND.1' },
        color: '#000000',
      },
    ],
  },

  {
    id: 'pico-serial-led-control',
    title: '[Pico] Serial LED Control',
    description: 'Control the Pico LED via serial commands (1=ON, 0=OFF, ?=status)',
    category: 'communication',
    difficulty: 'beginner',
    boardType: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — Serial LED Control
// Send '1' to turn LED ON, '0' to turn OFF, '?' for status

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
  delay(500);
  Serial.println("=== Pico LED Control ===");
  Serial.println("Commands: 1=ON  0=OFF  ?=status");
}

void loop() {
  if (Serial.available()) {
    char cmd = Serial.read();
    switch (cmd) {
      case '1':
        digitalWrite(LED_BUILTIN, HIGH);
        Serial.println("LED: ON");
        break;
      case '0':
        digitalWrite(LED_BUILTIN, LOW);
        Serial.println("LED: OFF");
        break;
      case '?':
        Serial.print("LED: ");
        Serial.println(digitalRead(LED_BUILTIN) ? "ON" : "OFF");
        break;
      default:
        if (cmd >= ' ') {
          Serial.print("Unknown command: ");
          Serial.println(cmd);
        }
        break;
    }
  }
}
`,
    components: [
      { type: 'wokwi-led', id: 'led-status', x: 400, y: 120, properties: { color: 'green' } },
      { type: 'wokwi-resistor', id: 'r1', x: 400, y: 200, properties: { value: '220' } },
    ],
    wires: [
      {
        id: 'w1',
        start: { componentId: 'arduino-uno', pinName: 'GP2' },
        end: { componentId: 'led-status', pinName: 'A' },
        color: '#00cc00',
      },
      {
        id: 'w2',
        start: { componentId: 'led-status', pinName: 'C' },
        end: { componentId: 'r1', pinName: '1' },
        color: '#999999',
      },
      {
        id: 'w3',
        start: { componentId: 'r1', pinName: '2' },
        end: { componentId: 'arduino-uno', pinName: 'GND.1' },
        color: '#000000',
      },
    ],
  },

  {
    id: 'pico-i2c-scanner',
    title: '[Pico] I2C Scanner',
    description: 'Scan the I2C bus on the Pico for connected devices',
    category: 'communication',
    difficulty: 'intermediate',
    boardType: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — I2C Scanner
// Scans I2C bus (Wire / I2C0: SDA=GP4, SCL=GP5) for devices

#include <Wire.h>

void setup() {
  Serial.begin(115200);
  delay(500);
  Wire.begin(); // SDA=GP4, SCL=GP5 by default on Pico
  Serial.println("=== Pico I2C Scanner ===");
  Serial.println("Default I2C0: SDA=GP4, SCL=GP5");
  Serial.println();
}

void loop() {
  Serial.println("Scanning I2C bus...");
  int found = 0;

  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    byte error = Wire.endTransmission();

    if (error == 0) {
      found++;
      Serial.print("  Device found at 0x");
      if (addr < 16) Serial.print("0");
      Serial.print(addr, HEX);

      // Identify known addresses
      switch (addr) {
        case 0x48: Serial.print(" (Temperature sensor)"); break;
        case 0x50: Serial.print(" (EEPROM)"); break;
        case 0x68: Serial.print(" (DS1307 RTC)"); break;
        case 0x27: Serial.print(" (LCD backpack)"); break;
        case 0x3C: Serial.print(" (SSD1306 OLED)"); break;
        default: break;
      }
      Serial.println();
    }
  }

  Serial.print("Scan complete. Found ");
  Serial.print(found);
  Serial.println(" device(s).");
  Serial.println();
  delay(5000);
}
`,
    components: [
      { type: 'wokwi-resistor', id: 'r-led-scan-a', x: 280, y: 100, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-led-found-a', x: 280, y: 180, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'led-scan', x: 400, y: 100, properties: { color: 'blue' } },
      { type: 'wokwi-led', id: 'led-found', x: 400, y: 180, properties: { color: 'green' } },
    ],
    wires: [
      {
        id: 'w1',
        start: { componentId: 'arduino-uno', pinName: 'GP12' },
        end: { componentId: 'r-led-scan-a', pinName: '1' },
        color: '#4488ff',
      },
      {
        id: 'w-r-led-scan-a',
        start: { componentId: 'r-led-scan-a', pinName: '2' },
        end: { componentId: 'led-scan', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w2',
        start: { componentId: 'arduino-uno', pinName: 'GP10' },
        end: { componentId: 'r-led-found-a', pinName: '1' },
        color: '#00cc00',
      },
      {
        id: 'w-r-led-found-a',
        start: { componentId: 'r-led-found-a', pinName: '2' },
        end: { componentId: 'led-found', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w3',
        start: { componentId: 'led-scan', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND.1' },
        color: '#000000',
      },
      {
        id: 'w4',
        start: { componentId: 'led-found', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND.1' },
        color: '#000000',
      },
    ],
  },

  {
    id: 'pico-i2c-rtc-read',
    title: '[Pico] I2C RTC Read',
    description: 'Read time from a virtual DS1307 RTC over I2C on Raspberry Pi Pico',
    category: 'communication',
    difficulty: 'intermediate',
    boardType: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — I2C DS1307 RTC Read
// Reads time from virtual RTC at address 0x68

#include <Wire.h>

byte bcdToDec(byte val) {
  return ((val >> 4) * 10) + (val & 0x0F);
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Wire.begin();
  Serial.println("=== Pico I2C RTC Read ===");
  Serial.println("Reading DS1307 at 0x68 (system time)");
  Serial.println();
}

void loop() {
  // Set register pointer to 0
  Wire.beginTransmission(0x68);
  Wire.write(0x00);
  Wire.endTransmission();

  // Read 7 bytes: sec, min, hr, dow, date, month, year
  Wire.requestFrom(0x68, 7);
  if (Wire.available() >= 7) {
    byte sec   = bcdToDec(Wire.read() & 0x7F);
    byte min   = bcdToDec(Wire.read());
    byte hr    = bcdToDec(Wire.read() & 0x3F);
    byte dow   = bcdToDec(Wire.read());
    byte date  = bcdToDec(Wire.read());
    byte month = bcdToDec(Wire.read());
    byte year  = bcdToDec(Wire.read());

    const char* days[] = {"", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};

    Serial.print("Time: ");
    if (hr < 10) Serial.print('0'); Serial.print(hr); Serial.print(':');
    if (min < 10) Serial.print('0'); Serial.print(min); Serial.print(':');
    if (sec < 10) Serial.print('0'); Serial.print(sec);
    Serial.print("  Date: ");
    Serial.print(days[dow]); Serial.print(' ');
    if (date < 10) Serial.print('0'); Serial.print(date); Serial.print('/');
    if (month < 10) Serial.print('0'); Serial.print(month); Serial.print('/');
    Serial.print("20"); if (year < 10) Serial.print('0'); Serial.println(year);
  } else {
    Serial.println("RTC not responding!");
  }

  delay(1000);
}
`,
    components: [
      { type: 'wokwi-resistor', id: 'r-led-i2c-a', x: 280, y: 80, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-led-rtc-a', x: 280, y: 180, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'led-i2c', x: 400, y: 100, properties: { color: 'blue' } },
      { type: 'wokwi-led', id: 'led-rtc', x: 400, y: 180, properties: { color: 'yellow' } },
    ],
    wires: [
      {
        id: 'w-sda',
        start: { componentId: 'arduino-uno', pinName: 'GP12' },
        end: { componentId: 'r-led-i2c-a', pinName: '1' },
        color: '#4488ff',
      },
      {
        id: 'w-r-led-i2c-a',
        start: { componentId: 'r-led-i2c-a', pinName: '2' },
        end: { componentId: 'led-i2c', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w-scl',
        start: { componentId: 'arduino-uno', pinName: 'GP10' },
        end: { componentId: 'r-led-rtc-a', pinName: '1' },
        color: '#ffaa00',
      },
      {
        id: 'w-r-led-rtc-a',
        start: { componentId: 'r-led-rtc-a', pinName: '2' },
        end: { componentId: 'led-rtc', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w-sda-gnd',
        start: { componentId: 'led-i2c', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND.1' },
        color: '#000000',
      },
      {
        id: 'w-scl-gnd',
        start: { componentId: 'led-rtc', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND.1' },
        color: '#000000',
      },
    ],
  },

  {
    id: 'pico-i2c-eeprom-rw',
    title: '[Pico] I2C EEPROM R/W',
    description: 'Write and read back data to a virtual I2C EEPROM on the Pico',
    category: 'communication',
    difficulty: 'intermediate',
    boardType: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — I2C EEPROM Read/Write
// Writes data to virtual EEPROM at 0x50 and reads it back

#include <Wire.h>

#define EEPROM_ADDR 0x50

void eepromWrite(byte memAddr, byte data) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write(memAddr);
  Wire.write(data);
  Wire.endTransmission();
  delay(5); // EEPROM write cycle
}

byte eepromRead(byte memAddr) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write(memAddr);
  Wire.endTransmission();
  Wire.requestFrom(EEPROM_ADDR, 1);
  return Wire.available() ? Wire.read() : 0xFF;
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Wire.begin();
  Serial.println("=== Pico I2C EEPROM Test ===");
  Serial.println();

  // Write 8 bytes
  Serial.println("Writing 8 bytes...");
  byte testData[] = {0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE};
  for (int i = 0; i < 8; i++) {
    eepromWrite(i, testData[i]);
    Serial.print("  ["); Serial.print(i);
    Serial.print("] = 0x");
    if (testData[i] < 16) Serial.print('0');
    Serial.println(testData[i], HEX);
  }
  Serial.println();

  // Read back
  Serial.println("Reading back...");
  int pass = 0;
  for (int i = 0; i < 8; i++) {
    byte val = eepromRead(i);
    Serial.print("  ["); Serial.print(i);
    Serial.print("] = 0x");
    if (val < 16) Serial.print('0');
    Serial.print(val, HEX);
    if (val == testData[i]) {
      Serial.println(" OK");
      pass++;
    } else {
      Serial.print(" FAIL (expected 0x");
      Serial.print(testData[i], HEX);
      Serial.println(")");
    }
  }

  Serial.println();
  Serial.print("Result: ");
  Serial.print(pass);
  Serial.println("/8 passed");
}

void loop() {
  delay(10000);
}
`,
    components: [
      { type: 'wokwi-resistor', id: 'r-led-write-a', x: 280, y: 100, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-led-read-a', x: 280, y: 180, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'led-write', x: 400, y: 100, properties: { color: 'red' } },
      { type: 'wokwi-led', id: 'led-read', x: 400, y: 180, properties: { color: 'green' } },
    ],
    wires: [
      {
        id: 'w-sda',
        start: { componentId: 'arduino-uno', pinName: 'GP12' },
        end: { componentId: 'r-led-write-a', pinName: '1' },
        color: '#ff4444',
      },
      {
        id: 'w-r-led-write-a',
        start: { componentId: 'r-led-write-a', pinName: '2' },
        end: { componentId: 'led-write', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w-scl',
        start: { componentId: 'arduino-uno', pinName: 'GP10' },
        end: { componentId: 'r-led-read-a', pinName: '1' },
        color: '#00cc00',
      },
      {
        id: 'w-r-led-read-a',
        start: { componentId: 'r-led-read-a', pinName: '2' },
        end: { componentId: 'led-read', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w-write-gnd',
        start: { componentId: 'led-write', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND.1' },
        color: '#000000',
      },
      {
        id: 'w-read-gnd',
        start: { componentId: 'led-read', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND.1' },
        color: '#000000',
      },
    ],
  },

  {
    id: 'pico-spi-loopback',
    title: '[Pico] SPI Loopback',
    description: 'SPI loopback test on RP2040 — sends and receives bytes via SPI0',
    category: 'communication',
    difficulty: 'intermediate',
    boardType: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — SPI Loopback Test
// Sends bytes over SPI0 and reads the loopback response
// Default SPI0 pins: MISO=GP16, MOSI=GP19, SCK=GP18, CS=GP17

#include <SPI.h>

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("=== Pico SPI Loopback Test ===");
  Serial.println("SPI0: MISO=GP16, MOSI=GP19, SCK=GP18");
  Serial.println();

  SPI.begin();
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));

  // Send test bytes
  byte testBytes[] = {0x55, 0xAA, 0xFF, 0x00, 0x42};
  int count = sizeof(testBytes);

  Serial.println("Sending bytes and reading loopback:");
  for (int i = 0; i < count; i++) {
    byte rxByte = SPI.transfer(testBytes[i]);
    Serial.print("  TX: 0x");
    if (testBytes[i] < 16) Serial.print('0');
    Serial.print(testBytes[i], HEX);
    Serial.print("  RX: 0x");
    if (rxByte < 16) Serial.print('0');
    Serial.print(rxByte, HEX);
    Serial.print("  ");
    Serial.println(rxByte == testBytes[i] ? "MATCH" : "DIFFER");
  }

  SPI.endTransaction();
  Serial.println();
  Serial.println("SPI test complete.");
}

void loop() {
  delay(10000);
}
`,
    components: [
      { type: 'wokwi-resistor', id: 'r-led-mosi-a', x: 280, y: 100, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-led-miso-a', x: 280, y: 180, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-led-sck-a', x: 280, y: 260, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'led-mosi', x: 400, y: 100, properties: { color: 'red' } },
      { type: 'wokwi-led', id: 'led-miso', x: 400, y: 180, properties: { color: 'green' } },
      { type: 'wokwi-led', id: 'led-sck', x: 400, y: 260, properties: { color: 'yellow' } },
    ],
    wires: [
      {
        id: 'w-mosi',
        start: { componentId: 'arduino-uno', pinName: 'GP7' },
        end: { componentId: 'r-led-mosi-a', pinName: '1' },
        color: '#ff4444',
      },
      {
        id: 'w-r-led-mosi-a',
        start: { componentId: 'r-led-mosi-a', pinName: '2' },
        end: { componentId: 'led-mosi', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w-miso',
        start: { componentId: 'arduino-uno', pinName: 'GP4' },
        end: { componentId: 'r-led-miso-a', pinName: '1' },
        color: '#00cc00',
      },
      {
        id: 'w-r-led-miso-a',
        start: { componentId: 'r-led-miso-a', pinName: '2' },
        end: { componentId: 'led-miso', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w-sck',
        start: { componentId: 'arduino-uno', pinName: 'GP6' },
        end: { componentId: 'r-led-sck-a', pinName: '1' },
        color: '#ffaa00',
      },
      {
        id: 'w-r-led-sck-a',
        start: { componentId: 'r-led-sck-a', pinName: '2' },
        end: { componentId: 'led-sck', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w-mosi-gnd',
        start: { componentId: 'led-mosi', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND.1' },
        color: '#000000',
      },
      {
        id: 'w-miso-gnd',
        start: { componentId: 'led-miso', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND.1' },
        color: '#000000',
      },
      {
        id: 'w-sck-gnd',
        start: { componentId: 'led-sck', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND.1' },
        color: '#000000',
      },
    ],
  },

  {
    id: 'pico-adc-read',
    title: '[Pico] ADC Read',
    description: 'Read analog values from GPIO26-28 and internal temperature sensor',
    category: 'sensors',
    difficulty: 'beginner',
    boardType: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — ADC Read Test
// Reads analog values from A0-A2 (GPIO26-28) and the internal temp sensor

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("=== Pico ADC Read ===");
  Serial.println("A0=GP26  A1=GP27  A2=GP28  Temp=internal");
  Serial.println("12-bit resolution (0-4095), 3.3V ref");
  Serial.println();

  analogReadResolution(12);
}

void loop() {
  int a0 = analogRead(A0);
  int a1 = analogRead(A1);
  int a2 = analogRead(A2);

  // Internal temperature sensor on channel 4
  // T = 27 - (V - 0.706) / 0.001721
  int tempRaw = analogRead(A3); // Channel 4 mapped to A3 by Pico core
  float voltage = tempRaw * 3.3f / 4095.0f;
  float tempC = 27.0f - (voltage - 0.706f) / 0.001721f;

  Serial.print("A0: "); Serial.print(a0);
  Serial.print("  A1: "); Serial.print(a1);
  Serial.print("  A2: "); Serial.print(a2);
  Serial.print("  Temp: "); Serial.print(tempC, 1); Serial.println(" C");

  delay(1000);
}
`,
    components: [
      { type: 'wokwi-resistor', id: 'r-led-temp-a', x: 280, y: 320, properties: { value: '220' } },
      { type: 'wokwi-potentiometer', id: 'pot-a0', x: 400, y: 80, properties: {} },
      { type: 'wokwi-potentiometer', id: 'pot-a1', x: 400, y: 200, properties: {} },
      { type: 'wokwi-led', id: 'led-temp', x: 400, y: 320, properties: { color: 'red' } },
    ],
    wires: [
      {
        id: 'w-a0',
        start: { componentId: 'arduino-uno', pinName: 'A0' },
        end: { componentId: 'pot-a0', pinName: 'SIG' },
        color: '#4488ff',
      },
      {
        id: 'w-a1',
        start: { componentId: 'arduino-uno', pinName: 'A1' },
        end: { componentId: 'pot-a1', pinName: 'SIG' },
        color: '#44cc44',
      },
      {
        id: 'w-temp',
        start: { componentId: 'arduino-uno', pinName: 'GP2' },
        end: { componentId: 'r-led-temp-a', pinName: '1' },
        color: '#ff4444',
      },
      {
        id: 'w-r-led-temp-a',
        start: { componentId: 'r-led-temp-a', pinName: '2' },
        end: { componentId: 'led-temp', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w-pot-a0-vcc',
        start: { componentId: 'arduino-uno', pinName: '3V3' },
        end: { componentId: 'pot-a0', pinName: 'VCC' },
        color: '#ff0000',
      },
      {
        id: 'w-pot-a0-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND.1' },
        end: { componentId: 'pot-a0', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w-pot-a1-vcc',
        start: { componentId: 'arduino-uno', pinName: '3V3' },
        end: { componentId: 'pot-a1', pinName: 'VCC' },
        color: '#ff0000',
      },
      {
        id: 'w-pot-a1-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND.1' },
        end: { componentId: 'pot-a1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w-temp-gnd',
        start: { componentId: 'led-temp', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND.1' },
        color: '#000000',
      },
    ],
  },

  {
    id: 'pico-multi-protocol',
    title: '[Pico] Multi-Protocol Demo',
    description: 'Comprehensive test: Serial + I2C + SPI + ADC on the Raspberry Pi Pico',
    category: 'communication',
    difficulty: 'advanced',
    boardType: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — Multi-Protocol Demo
// Tests Serial, I2C, SPI, and ADC all together

#include <Wire.h>
#include <SPI.h>

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
  delay(500);

  Serial.println("==============================");
  Serial.println(" Pico Multi-Protocol Demo");
  Serial.println("==============================");
  Serial.println();

  // ── 1. I2C Scanner ──
  Wire.begin();
  Serial.println("[I2C] Scanning bus...");
  int found = 0;
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      found++;
      Serial.print("  Found device at 0x");
      if (addr < 16) Serial.print('0');
      Serial.println(addr, HEX);
    }
  }
  Serial.print("  Total devices: "); Serial.println(found);
  Serial.println();

  // ── 2. I2C EEPROM R/W ──
  Serial.println("[I2C] EEPROM test at 0x50...");
  Wire.beginTransmission(0x50);
  Wire.write(0x00); // register 0
  Wire.write(0x42); // data
  Wire.endTransmission();
  delay(5);

  Wire.beginTransmission(0x50);
  Wire.write(0x00);
  Wire.endTransmission();
  Wire.requestFrom(0x50, 1);
  if (Wire.available()) {
    byte val = Wire.read();
    Serial.print("  Wrote 0x42, Read 0x");
    Serial.print(val, HEX);
    Serial.println(val == 0x42 ? " — OK" : " — FAIL");
  }
  Serial.println();

  // ── 3. I2C RTC ──
  Serial.println("[I2C] Reading DS1307 RTC at 0x68...");
  Wire.beginTransmission(0x68);
  Wire.write(0x00);
  Wire.endTransmission();
  Wire.requestFrom(0x68, 3);
  if (Wire.available() >= 3) {
    byte sec = ((Wire.read() & 0x7F) >> 4) * 10 + (Wire.read() & 0x0F);
    byte min2 = Wire.read();
    (void)sec; (void)min2;
    Serial.println("  RTC responded OK");
  }
  Serial.println();

  // ── 4. SPI Loopback ──
  Serial.println("[SPI] Loopback test...");
  SPI.begin();
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  byte tx = 0xAB;
  byte rx = SPI.transfer(tx);
  Serial.print("  TX: 0x"); Serial.print(tx, HEX);
  Serial.print("  RX: 0x"); Serial.println(rx, HEX);
  SPI.endTransaction();
  Serial.println();

  // ── 5. ADC ──
  Serial.println("[ADC] Reading analog channels...");
  analogReadResolution(12);
  int a0 = analogRead(A0);
  Serial.print("  A0 (GP26): "); Serial.println(a0);
  Serial.println();

  // ── 6. GPIO ──
  Serial.println("[GPIO] Blinking LED...");
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_BUILTIN, HIGH);
    delay(200);
    digitalWrite(LED_BUILTIN, LOW);
    delay(200);
  }
  Serial.println("  3 blinks done");
  Serial.println();

  Serial.println("=== All protocol tests complete ===");
}

void loop() {
  // Heartbeat
  static unsigned long last = 0;
  if (millis() - last >= 3000) {
    last = millis();
    Serial.print("[Heartbeat] ");
    Serial.print(millis() / 1000);
    Serial.println("s");
  }
}
`,
    components: [
      { type: 'wokwi-resistor', id: 'r-led-i2c-a', x: 280, y: 80, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-led-spi-a', x: 280, y: 160, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-led-gpio-a', x: 280, y: 360, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'led-i2c', x: 400, y: 80, properties: { color: 'blue' } },
      { type: 'wokwi-led', id: 'led-spi', x: 400, y: 160, properties: { color: 'yellow' } },
      { type: 'wokwi-potentiometer', id: 'pot-adc', x: 400, y: 240, properties: {} },
      { type: 'wokwi-led', id: 'led-gpio', x: 400, y: 360, properties: { color: 'green' } },
    ],
    wires: [
      {
        id: 'w-i2c',
        start: { componentId: 'arduino-uno', pinName: 'GP12' },
        end: { componentId: 'r-led-i2c-a', pinName: '1' },
        color: '#4488ff',
      },
      {
        id: 'w-r-led-i2c-a',
        start: { componentId: 'r-led-i2c-a', pinName: '2' },
        end: { componentId: 'led-i2c', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w-spi',
        start: { componentId: 'arduino-uno', pinName: 'GP7' },
        end: { componentId: 'r-led-spi-a', pinName: '1' },
        color: '#ffaa00',
      },
      {
        id: 'w-r-led-spi-a',
        start: { componentId: 'r-led-spi-a', pinName: '2' },
        end: { componentId: 'led-spi', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w-adc',
        start: { componentId: 'arduino-uno', pinName: 'A0' },
        end: { componentId: 'pot-adc', pinName: 'SIG' },
        color: '#cc44cc',
      },
      {
        id: 'w-gpio',
        start: { componentId: 'arduino-uno', pinName: 'GP2' },
        end: { componentId: 'r-led-gpio-a', pinName: '1' },
        color: '#00cc00',
      },
      {
        id: 'w-r-led-gpio-a',
        start: { componentId: 'r-led-gpio-a', pinName: '2' },
        end: { componentId: 'led-gpio', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w-i2c-gnd',
        start: { componentId: 'led-i2c', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND.1' },
        color: '#000000',
      },
      {
        id: 'w-spi-gnd',
        start: { componentId: 'led-spi', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND.1' },
        color: '#000000',
      },
      {
        id: 'w-gpio-gnd',
        start: { componentId: 'led-gpio', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND.1' },
        color: '#000000',
      },
      {
        id: 'w-pot-adc-vcc',
        start: { componentId: 'arduino-uno', pinName: '3V3' },
        end: { componentId: 'pot-adc', pinName: 'VCC' },
        color: '#ff0000',
      },
      {
        id: 'w-pot-adc-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND.1' },
        end: { componentId: 'pot-adc', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },
  // ─── ESP32 Examples ───────────────────────────────────────────────────────
  {
    id: 'esp32-blink-led',
    title: 'ESP32 Blink LED',
    description:
      'Blink the built-in LED on GPIO2 and an external red LED on GPIO4. Verifies ESP32 emulation is working.',
    category: 'basics',
    difficulty: 'beginner',
    boardType: 'esp32',
    code: `// ESP32 Blink LED
// Blinks the built-in LED (GPIO2) and an external LED (GPIO4)
// Requires arduino-esp32 2.0.17 (IDF 4.4.x) — see docs/ESP32_EMULATION.md


#define LED_BUILTIN_PIN 2   // Built-in blue LED on ESP32 DevKit
#define LED_EXT_PIN     4   // External red LED


void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN_PIN, OUTPUT);
  pinMode(LED_EXT_PIN, OUTPUT);
  Serial.println("ESP32 Blink ready!");
}

void loop() {
  digitalWrite(LED_BUILTIN_PIN, HIGH);
  digitalWrite(LED_EXT_PIN, HIGH);
  Serial.println("LED ON");
  delay(500);

  digitalWrite(LED_BUILTIN_PIN, LOW);
  digitalWrite(LED_EXT_PIN, LOW);
  Serial.println("LED OFF");
  delay(500);
}`,
    components: [
      // 220 Ohm current-limiting resistor in series with the external LED —
      // never drive an LED straight off a GPIO. (3.3V - ~2V)/220R ~= 6 mA,
      // well under the LED's 20 mA rating.
      { type: 'wokwi-resistor', id: 'r-led', x: 320, y: 205, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'led-ext', x: 470, y: 190, properties: { color: 'red' } },
    ],
    wires: [
      // GPIO4 → resistor → LED anode
      {
        id: 'w-gpio4-r',
        start: { componentId: 'arduino-uno', pinName: '4' },
        end: { componentId: 'r-led', pinName: '1' },
        color: '#e74c3c',
      },
      {
        id: 'w-r-led',
        start: { componentId: 'r-led', pinName: '2' },
        end: { componentId: 'led-ext', pinName: 'A' },
        color: '#e74c3c',
      },
      // LED cathode → GND
      {
        id: 'w-gnd',
        start: { componentId: 'led-ext', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#2c3e50',
      },
    ],
  },
  {
    // The gallery had NO example using neopixel / led-ring / neopixel-matrix,
    // which is why nothing ever executed them and they were dark on every
    // board except the AVR for months. One per decode path, so the deploy's
    // pixel smoke and a human both have something to look at: the AVR
    // bit-bangs the line, the ESP32 hands it to the RMT peripheral, and the
    // RP2040 drives it from PIO.
    id: 'uno-neopixel-colours',
    title: 'Arduino Uno NeoPixel colours',
    description:
      'Cycle one WS2812 pixel through red, green and blue on an Uno. The AVR bit-bangs the data line, so the part decodes it from the pin edges.',
    category: 'basics',
    difficulty: 'beginner',
    boardType: 'arduino-uno',
    libraries: ['Adafruit NeoPixel'],
    code: `// Arduino Uno — one WS2812 pixel, three colours.
#include <Adafruit_NeoPixel.h>

#define PIN        6   // DIN. Any digital pin works.
#define NUM_PIXELS 1

Adafruit_NeoPixel pixels(NUM_PIXELS, PIN, NEO_GRB + NEO_KHZ800);

void setup() {
  Serial.begin(9600);
  pixels.begin();
  pixels.setBrightness(255);
}

void loop() {
  // The colour ORDER flag only permutes these three bytes — it can never turn
  // a dark pixel on, so it is not the thing to change when nothing lights.
  pixels.setPixelColor(0, pixels.Color(255, 0, 0)); pixels.show();
  Serial.println("red");   delay(1000);
  pixels.setPixelColor(0, pixels.Color(0, 255, 0)); pixels.show();
  Serial.println("green"); delay(1000);
  pixels.setPixelColor(0, pixels.Color(0, 0, 255)); pixels.show();
  Serial.println("blue");  delay(1000);
}`,
    components: [
      { type: 'wokwi-neopixel', id: 'npx', x: 470, y: 180, properties: { r: 0, g: 0, b: 0 } },
    ],
    wires: [
      {
        id: 'w-npx-vdd',
        start: { componentId: 'arduino-uno', pinName: '5V' },
        end: { componentId: 'npx', pinName: 'VDD' },
        color: '#e74c3c',
      },
      {
        id: 'w-npx-vss',
        start: { componentId: 'arduino-uno', pinName: 'GND.1' },
        end: { componentId: 'npx', pinName: 'VSS' },
        color: '#2c3e50',
      },
      {
        id: 'w-npx-din',
        start: { componentId: 'npx', pinName: 'DIN' },
        end: { componentId: 'arduino-uno', pinName: '6' },
        color: '#22c55e',
      },
    ],
  },
  {
    id: 'esp32-neopixel-colours',
    title: 'ESP32 NeoPixel colours',
    description:
      'The same pixel on an ESP32. Adafruit_NeoPixel drives it through the RMT peripheral here, so the pad never toggles at bit rate and the engine hands the decoded frame to the part.',
    category: 'basics',
    difficulty: 'beginner',
    boardType: 'esp32',
    libraries: ['Adafruit NeoPixel'],
    code: `// ESP32 — one WS2812 pixel on GPIO18, driven over RMT.
#include <Adafruit_NeoPixel.h>

#define PIN        18
#define NUM_PIXELS 1

Adafruit_NeoPixel pixels(NUM_PIXELS, PIN, NEO_GRB + NEO_KHZ800);

void setup() {
  Serial.begin(115200);
  pixels.begin();
  pixels.setBrightness(255);
}

void loop() {
  pixels.setPixelColor(0, pixels.Color(255, 0, 0)); pixels.show();
  Serial.println("red");   delay(1000);
  pixels.setPixelColor(0, pixels.Color(0, 255, 0)); pixels.show();
  Serial.println("green"); delay(1000);
  pixels.setPixelColor(0, pixels.Color(0, 0, 255)); pixels.show();
  Serial.println("blue");  delay(1000);
}`,
    components: [
      { type: 'wokwi-neopixel', id: 'npx', x: 470, y: 180, properties: { r: 0, g: 0, b: 0 } },
    ],
    wires: [
      {
        id: 'w-npx-vdd',
        start: { componentId: 'esp32', pinName: '3V3' },
        end: { componentId: 'npx', pinName: 'VDD' },
        color: '#e74c3c',
      },
      {
        id: 'w-npx-vss',
        start: { componentId: 'esp32', pinName: 'GND' },
        end: { componentId: 'npx', pinName: 'VSS' },
        color: '#2c3e50',
      },
      {
        id: 'w-npx-din',
        start: { componentId: 'npx', pinName: 'DIN' },
        end: { componentId: 'esp32', pinName: '18' },
        color: '#22c55e',
      },
    ],
  },
  {
    id: 'esp32-serial-echo',
    title: 'ESP32 Serial Echo',
    description:
      'ESP32 reads from Serial and echoes back. Demonstrates multi-UART and Serial Monitor integration.',
    category: 'communication',
    difficulty: 'beginner',
    boardType: 'esp32',
    code: `// ESP32 Serial Echo
// Echoes anything received on Serial (UART0) back to the sender.
// Open the Serial Monitor, type something, and see it echoed back.



void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("ESP32 Serial Echo ready!");
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

  // ── Multi-board example ──────────────────────────────────────────────────

  {
    id: 'pi-to-arduino-led-control',
    title: '[Pi + Arduino] Serial LED Control',
    description:
      'Raspberry Pi 3B controls two LEDs on an Arduino Uno via UART serial. Pi sends commands (LED1_ON, LED2_ON…) from a Python script; Arduino parses them and drives the LEDs.',
    category: 'communication',
    difficulty: 'advanced',
    code: '', // unused — each board has its own code in boards[]
    boards: [
      {
        boardKind: 'raspberry-pi-3',
        x: 80,
        y: 80,
        vfsFiles: {
          'script.py': `#!/usr/bin/env python3
# Pi -> Arduino Serial LED Controller
# ------------------------------------
# Wiring (real hardware):
#   Pi GPIO14 (TX) --> Arduino pin 0 (RX)
#   Pi GPIO15 (RX) <-- Arduino pin 1 (TX)
#   Pi GND         --- Arduino GND
#
# How to run in the emulator:
#   1. Start the Pi  ("Start Pi" button)
#   2. Compile & Run the Arduino sketch
#   3. Click Upload in the File System panel
#   4. Run: python3 /home/pi/script.py
import time

try:
    import serial
    port = serial.Serial('/dev/ttyAMA0', baudrate=9600, timeout=1)
    def send_cmd(cmd):
        port.write((cmd + '\\n').encode())
        time.sleep(0.2)
        resp = port.readline().decode(errors='replace').strip()
        if resp:
            print("  Arduino:", resp)
    def cleanup(): port.close()
except ImportError:
    def send_cmd(cmd):
        print("  [demo] ->", cmd)
        time.sleep(0.5)
    def cleanup(): pass

print("=== Pi LED Controller ===")
time.sleep(1)

steps = [
    ("LED1_ON",  "Red LED ON"),
    ("ALL_OFF",  "All LEDs OFF"),
    ("LED2_ON",  "Green LED ON"),
    ("ALL_OFF",  "All LEDs OFF"),
    ("ALL_ON",   "Both LEDs ON"),
    ("ALL_OFF",  "All LEDs OFF"),
]

for cmd, label in steps:
    print(label)
    send_cmd(cmd)
    time.sleep(1)

print("Done!")
cleanup()
`,
        },
      },
      {
        boardKind: 'arduino-uno',
        x: 560,
        y: 80,
        code: `// Pi -> Arduino Serial LED Control
// Listens on hardware Serial (pins 0/1, 9600 baud) for commands
// sent by the Raspberry Pi Python script.
//
// Commands:
//   LED1_ON  / LED1_OFF  - Red LED  (pin 8)
//   LED2_ON  / LED2_OFF  - Green LED (pin 9)
//   ALL_ON   / ALL_OFF   - Both LEDs

const int LED1 = 8;   // Red
const int LED2 = 9;   // Green

String buf = "";

void setup() {
  pinMode(LED1, OUTPUT);
  pinMode(LED2, OUTPUT);
  Serial.begin(9600);
  Serial.println("Arduino ready — waiting for Pi commands...");
}

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\\n') {
      buf.trim();
      processCommand(buf);
      buf = "";
    } else {
      buf += c;
    }
  }
}

void processCommand(const String& cmd) {
  if      (cmd == "LED1_ON")  { digitalWrite(LED1, HIGH); Serial.println("LED1: ON");  }
  else if (cmd == "LED1_OFF") { digitalWrite(LED1, LOW);  Serial.println("LED1: OFF"); }
  else if (cmd == "LED2_ON")  { digitalWrite(LED2, HIGH); Serial.println("LED2: ON");  }
  else if (cmd == "LED2_OFF") { digitalWrite(LED2, LOW);  Serial.println("LED2: OFF"); }
  else if (cmd == "ALL_ON")   { digitalWrite(LED1, HIGH); digitalWrite(LED2, HIGH); Serial.println("Both: ON");  }
  else if (cmd == "ALL_OFF")  { digitalWrite(LED1, LOW);  digitalWrite(LED2, LOW);  Serial.println("Both: OFF"); }
  else if (cmd.length() > 0)  { Serial.print("Unknown: "); Serial.println(cmd); }
}
`,
      },
    ],
    components: [
      // Red LED + 220Ω resistor for LED1 (Arduino pin 8)
      { type: 'wokwi-led', id: 'led1', x: 840, y: 100, properties: { color: 'red' } },
      { type: 'wokwi-resistor', id: 'res1', x: 840, y: 200, properties: { value: '220' } },
      // Green LED + 220Ω resistor for LED2 (Arduino pin 9)
      { type: 'wokwi-led', id: 'led2', x: 840, y: 320, properties: { color: 'green' } },
      { type: 'wokwi-resistor', id: 'res2', x: 840, y: 420, properties: { value: '220' } },
    ],
    wires: [
      // ── Serial UART cross-connection ──────────────────────────────────────
      // Pi GPIO14 (TX) → Arduino pin 0 (RX)
      {
        id: 'w-uart-tx',
        start: { componentId: 'raspberry-pi-3', pinName: 'GPIO14' },
        end: { componentId: 'arduino-uno', pinName: '0' },
        color: '#ff8800',
      },
      // Arduino pin 1 (TX) → Pi GPIO15 (RX)
      {
        id: 'w-uart-rx',
        start: { componentId: 'arduino-uno', pinName: '1' },
        end: { componentId: 'raspberry-pi-3', pinName: 'GPIO15' },
        color: '#00aaff',
      },
      // Common GND
      {
        id: 'w-gnd',
        start: { componentId: 'raspberry-pi-3', pinName: 'GND' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },

      // ── LED 1 (Red) — Arduino pin 8 → res1 → led1 → GND ─────────────────
      {
        id: 'w-led1-sig',
        start: { componentId: 'arduino-uno', pinName: '8' },
        end: { componentId: 'res1', pinName: '1' },
        color: '#ff2222',
      },
      {
        id: 'w-led1-mid',
        start: { componentId: 'res1', pinName: '2' },
        end: { componentId: 'led1', pinName: 'A' },
        color: '#ff2222',
      },
      {
        id: 'w-led1-gnd',
        start: { componentId: 'led1', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },

      // ── LED 2 (Green) — Arduino pin 9 → res2 → led2 → GND ───────────────
      {
        id: 'w-led2-sig',
        start: { componentId: 'arduino-uno', pinName: '9' },
        end: { componentId: 'res2', pinName: '1' },
        color: '#22cc22',
      },
      {
        id: 'w-led2-mid',
        start: { componentId: 'res2', pinName: '2' },
        end: { componentId: 'led2', pinName: 'A' },
        color: '#22cc22',
      },
      {
        id: 'w-led2-gnd',
        start: { componentId: 'led2', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },

  // ─── Dual Raspberry Pi Pico W — Multi-protocol bench ────────────────────────
  // These three examples reproduce the exact wiring patterns the user reported
  // at https://velxio.dev/project/cb406120-d40e-4225-bbfd-1b362a64445a — two
  // Pico W boards talking to each other over UART / I2C / digital GPIO.
  // The wire-aware Interconnect router (see frontend/src/simulation/Interconnect.ts)
  // routes pin transitions and UART byte shortcuts between any two simulators
  // along the wires defined here.

  {
    id: 'dual-pico-serial1-passthrough',
    title: '[2× Pico W] Serial1 Passthrough (UART0)',
    description:
      'Two Raspberry Pi Pico W boards talking over Serial1 (UART0 on GP0/GP1). Pico A sends "PING #N" every second; Pico B replies "PONG #N". Open the Serial Monitor on each board to see the conversation.',
    category: 'communication',
    difficulty: 'intermediate',
    boardFilter: 'raspberry-pi-pico',
    code: '',
    boards: [
      {
        boardKind: 'pi-pico-w',
        x: 100,
        y: 120,
        code: `// Pico A — Serial1 ping/pong sender
//
// Wiring to Pico B:
//   A.GP0 (TX) ──> B.GP1 (RX)
//   A.GP1 (RX) <── B.GP0 (TX)
//   A.GND     ──── B.GND
//
// Open the Serial Monitor on Pico A to see PONG replies coming back.

void setup() {
  Serial.begin(115200);   // USB-CDC console
  Serial1.begin(9600);    // UART0 on GP0(TX)/GP1(RX)
  pinMode(LED_BUILTIN, OUTPUT);
  delay(500);
  Serial.println("Pico A ready — sending PING every second.");
}

unsigned long lastSend = 0;
uint32_t counter = 0;
String rx = "";

void loop() {
  // Send a PING every 1 s
  if (millis() - lastSend >= 1000) {
    lastSend = millis();
    counter++;
    Serial1.print("PING #");
    Serial1.println(counter);
    digitalWrite(LED_BUILTIN, HIGH);
  }

  // Echo any reply from Pico B onto the USB console
  while (Serial1.available()) {
    char c = (char)Serial1.read();
    if (c == '\\n') {
      Serial.print("[A] got: ");
      Serial.println(rx);
      rx = "";
      digitalWrite(LED_BUILTIN, LOW);
    } else if (c != '\\r') {
      rx += c;
    }
  }
}
`,
      },
      {
        boardKind: 'pi-pico-w',
        x: 520,
        y: 120,
        code: `// Pico B — Serial1 ping/pong responder
//
// Wiring to Pico A:
//   B.GP0 (TX) ──> A.GP1 (RX)
//   B.GP1 (RX) <── A.GP0 (TX)
//   B.GND     ──── A.GND
//
// Open the Serial Monitor on Pico B to see PINGs as they arrive.

void setup() {
  Serial.begin(115200);
  Serial1.begin(9600);
  pinMode(LED_BUILTIN, OUTPUT);
  delay(500);
  Serial.println("Pico B ready — replying PONG to every PING.");
}

String rx = "";

void loop() {
  while (Serial1.available()) {
    char c = (char)Serial1.read();
    if (c == '\\n') {
      Serial.print("[B] got: ");
      Serial.println(rx);
      // Echo back as PONG with the same number
      // rx looks like "PING #42" — strip the prefix and reply.
      int hash = rx.indexOf('#');
      String n = (hash >= 0) ? rx.substring(hash + 1) : "?";
      Serial1.print("PONG #");
      Serial1.println(n);
      digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
      rx = "";
    } else if (c != '\\r') {
      rx += c;
    }
  }
}
`,
      },
    ],
    components: [],
    wires: [
      // A.GP0 (TX) → B.GP1 (RX)
      {
        id: 'w-a-tx-b-rx',
        start: { componentId: 'pi-pico-w', pinName: 'GP0' },
        end: { componentId: 'pi-pico-w-2', pinName: 'GP1' },
        color: '#22cc22',
      },
      // B.GP0 (TX) → A.GP1 (RX)
      {
        id: 'w-b-tx-a-rx',
        start: { componentId: 'pi-pico-w-2', pinName: 'GP0' },
        end: { componentId: 'pi-pico-w', pinName: 'GP1' },
        color: '#ffaa00',
      },
      // GND ↔ GND
      {
        id: 'w-gnd',
        start: { componentId: 'pi-pico-w', pinName: 'GND' },
        end: { componentId: 'pi-pico-w-2', pinName: 'GND' },
        color: '#000000',
      },
    ],
    tags: ['rp2040', 'pico', 'multi-board', 'uart', 'serial1', 'serial-passthrough'],
  },

  {
    id: 'dual-pico-bidirectional-handshake',
    title: '[2× Pico W] Bidirectional Digital Handshake',
    description:
      "Two Picos signal each other over independent digital lines. Pico A drives GP15 (data) and watches GP14 (ack); Pico B reads GP15 and pulses GP14 on every transition to acknowledge. Each board's Serial Monitor logs every event, so you can see the round-trip on both sides.",
    category: 'communication',
    difficulty: 'beginner',
    boardFilter: 'raspberry-pi-pico',
    code: '',
    boards: [
      {
        boardKind: 'pi-pico-w',
        x: 100,
        y: 120,
        code: `// Pico A — sender + ack listener
//
// Wiring to Pico B:
//   A.GP15 (DATA out) ──> B.GP15 (DATA in)
//   A.GP14 (ACK in)   <── B.GP14 (ACK out)
//   A.GND             ─── B.GND
//
// Every second, A toggles GP15 and waits up to 200 ms for B's ack
// pulse on GP14. Both events get logged to Serial.

const int DATA_OUT = 15;
const int ACK_IN   = 14;

void setup() {
  Serial.begin(115200);
  pinMode(DATA_OUT, OUTPUT);
  pinMode(ACK_IN,   INPUT);
  pinMode(LED_BUILTIN, OUTPUT);
  delay(300);
  Serial.println("Pico A — handshake ready.");
}

uint32_t counter   = 0;
int      lastAck   = LOW;
bool     dataState = false;

void loop() {
  // Toggle the data line every second
  dataState = !dataState;
  digitalWrite(DATA_OUT, dataState ? HIGH : LOW);
  digitalWrite(LED_BUILTIN, dataState ? HIGH : LOW);
  counter++;
  Serial.print("[A] sent #");
  Serial.print(counter);
  Serial.print(" DATA=");
  Serial.println(dataState ? "HIGH" : "LOW");

  // Watch for an ack pulse from B for up to 200 ms
  uint32_t deadline = millis() + 200;
  bool acked = false;
  while (millis() < deadline) {
    int v = digitalRead(ACK_IN);
    if (v != lastAck) {
      lastAck = v;
      acked = true;
      Serial.print("[A] ack edge (ACK=");
      Serial.print(v ? "HIGH" : "LOW");
      Serial.println(")");
      break;
    }
  }
  if (!acked) Serial.println("[A] no ack within 200 ms");

  delay(800);
}
`,
      },
      {
        boardKind: 'pi-pico-w',
        x: 520,
        y: 120,
        code: `// Pico B — receiver + ack pulser
//
// Reads GP15 (DATA in). On every transition, toggles GP14 (ACK out)
// to tell Pico A it saw the change. Built-in LED mirrors GP15 so
// you can watch the data line visually.

const int DATA_IN  = 15;
const int ACK_OUT  = 14;

void setup() {
  Serial.begin(115200);
  pinMode(DATA_IN,  INPUT);
  pinMode(ACK_OUT,  OUTPUT);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(ACK_OUT, LOW);
  delay(300);
  Serial.println("Pico B — handshake responder ready.");
}

int  lastData = -1;
bool ack      = false;

void loop() {
  int d = digitalRead(DATA_IN);
  if (d != lastData) {
    lastData = d;
    digitalWrite(LED_BUILTIN, d);
    Serial.print("[B] DATA=");
    Serial.print(d ? "HIGH" : "LOW");
    // Toggle ACK to acknowledge the edge
    ack = !ack;
    digitalWrite(ACK_OUT, ack ? HIGH : LOW);
    Serial.print("  → ACK=");
    Serial.println(ack ? "HIGH" : "LOW");
  }
}
`,
      },
    ],
    components: [],
    wires: [
      // DATA: A.GP15 → B.GP15
      {
        id: 'w-data',
        start: { componentId: 'pi-pico-w', pinName: 'GP15' },
        end: { componentId: 'pi-pico-w-2', pinName: 'GP15' },
        color: '#22cc22',
      },
      // ACK: B.GP14 → A.GP14
      {
        id: 'w-ack',
        start: { componentId: 'pi-pico-w-2', pinName: 'GP14' },
        end: { componentId: 'pi-pico-w', pinName: 'GP14' },
        color: '#ffaa00',
      },
      // GND
      {
        id: 'w-gnd',
        start: { componentId: 'pi-pico-w', pinName: 'GND' },
        end: { componentId: 'pi-pico-w-2', pinName: 'GND' },
        color: '#000000',
      },
    ],
    tags: ['rp2040', 'pico', 'multi-board', 'gpio', 'handshake', 'bidirectional'],
  },

  {
    id: 'dual-pico-digital-mirror',
    title: '[2× Pico W] Digital GPIO Mirror',
    description:
      "Simplest possible cross-board test. Pico A toggles GP15 every 500 ms; Pico B reads GP15 as a digital input and mirrors its state to its built-in LED. Watch each Pico's Serial Monitor to confirm the wire is alive.",
    category: 'basics',
    difficulty: 'beginner',
    boardFilter: 'raspberry-pi-pico',
    code: '',
    boards: [
      {
        boardKind: 'pi-pico-w',
        x: 100,
        y: 120,
        code: `// Pico A — Digital signal generator
// Toggles GP15 at 1 Hz (500 ms HIGH, 500 ms LOW).
//
// Wiring to Pico B:
//   A.GP15 ─── B.GP15  (signal)
//   A.GND  ─── B.GND   (common ground)

const int OUT_PIN = 15;

void setup() {
  Serial.begin(115200);
  pinMode(OUT_PIN, OUTPUT);
  pinMode(LED_BUILTIN, OUTPUT);
  delay(300);
  Serial.println("Pico A — pulse generator on GP15.");
}

void loop() {
  digitalWrite(OUT_PIN, HIGH);
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.println("GP15 → HIGH");
  delay(500);

  digitalWrite(OUT_PIN, LOW);
  digitalWrite(LED_BUILTIN, LOW);
  Serial.println("GP15 → LOW");
  delay(500);
}
`,
      },
      {
        boardKind: 'pi-pico-w',
        x: 520,
        y: 120,
        code: `// Pico B — Digital signal mirror
// Reads GP15 as input and copies the state to LED_BUILTIN.

const int IN_PIN = 15;

void setup() {
  Serial.begin(115200);
  pinMode(IN_PIN, INPUT);
  pinMode(LED_BUILTIN, OUTPUT);
  delay(300);
  Serial.println("Pico B — mirroring GP15 state to built-in LED.");
}

int lastState = -1;

void loop() {
  int s = digitalRead(IN_PIN);
  digitalWrite(LED_BUILTIN, s);
  if (s != lastState) {
    Serial.print("GP15 read: ");
    Serial.println(s ? "HIGH" : "LOW");
    lastState = s;
  }
}
`,
      },
    ],
    components: [],
    wires: [
      // Signal: A.GP15 ↔ B.GP15
      {
        id: 'w-sig',
        start: { componentId: 'pi-pico-w', pinName: 'GP15' },
        end: { componentId: 'pi-pico-w-2', pinName: 'GP15' },
        color: '#22cc22',
      },
      // Ground
      {
        id: 'w-gnd',
        start: { componentId: 'pi-pico-w', pinName: 'GND' },
        end: { componentId: 'pi-pico-w-2', pinName: 'GND' },
        color: '#000000',
      },
    ],
    tags: ['rp2040', 'pico', 'multi-board', 'gpio', 'digital'],
  },

  // ─── Arduino Nano Examples ────────────────────────────────────────────────
  {
    id: 'nano-blink',
    title: 'Nano: Blink LED',
    description: 'Blink the built-in LED on pin 13 of the Arduino Nano.',
    category: 'basics',
    difficulty: 'beginner',
    boardType: 'arduino-nano',
    boardFilter: 'arduino-nano',
    code: `// Arduino Nano — Blink LED
// Built-in LED is on pin 13

void setup() {
  pinMode(13, OUTPUT);
  Serial.begin(9600);
  Serial.println("Nano Blink ready!");
}

void loop() {
  digitalWrite(13, HIGH);
  Serial.println("ON");
  delay(500);
  digitalWrite(13, LOW);
  Serial.println("OFF");
  delay(500);
}`,
    components: [],
    wires: [],
  },
  {
    id: 'nano-serial',
    title: 'Nano: Serial Hello',
    description: 'Print Hello World and uptime every second from Arduino Nano via Serial.',
    category: 'communication',
    difficulty: 'beginner',
    boardType: 'arduino-nano',
    boardFilter: 'arduino-nano',
    code: `// Arduino Nano — Serial Hello World

void setup() {
  Serial.begin(9600);
  delay(200);
  Serial.println("=== Arduino Nano Serial Demo ===");
  Serial.println("Hello from Nano!");
  Serial.println();
}

unsigned long lastPrint = 0;
int count = 0;

void loop() {
  if (millis() - lastPrint >= 1000) {
    lastPrint = millis();
    count++;
    Serial.print("Uptime: ");
    Serial.print(millis() / 1000);
    Serial.print("s  |  Loop #");
    Serial.println(count);
  }
}`,
    components: [],
    wires: [],
  },
  {
    id: 'nano-button-led',
    title: 'Nano: Button + LED',
    description: 'Press a button on pin 2 to light up an LED on pin 13 on the Arduino Nano.',
    category: 'basics',
    difficulty: 'beginner',
    boardType: 'arduino-nano',
    boardFilter: 'arduino-nano',
    code: `// Arduino Nano — Button controls LED

const int BTN = 2;
const int LED = 13;

void setup() {
  pinMode(BTN, INPUT_PULLUP);
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
  Serial.println("Button LED ready — press button on pin 2");
}

void loop() {
  bool pressed = digitalRead(BTN) == LOW;
  digitalWrite(LED, pressed ? HIGH : LOW);
}`,
    components: [
      { type: 'wokwi-pushbutton', id: 'btn1', x: 420, y: 120, properties: {} },
      { type: 'wokwi-led', id: 'led1', x: 420, y: 260, properties: { color: 'red' } },
      // 220 ohm between each GPIO and its LED — (5V - ~2V) / 220R ~= 14 mA,
      // under the LED's 20 mA. This is the series resistor it was missing:
      // without it the circuit checker computes a short and refuses to run.
      { type: 'wokwi-resistor', id: 'r-led1', x: 420, y: 200, properties: { value: '220' } },
    ],
    wires: [
      {
        id: 'w-btn',
        start: { componentId: 'arduino-uno', pinName: '2' },
        end: { componentId: 'btn1', pinName: '1.l' },
        color: '#00aaff',
      },
      {
        id: 'w-led',
        start: { componentId: 'arduino-uno', pinName: '13' },
        end: { componentId: 'r-led1', pinName: '1' },
        color: '#ff4444',
      },
      {
        id: 'w-led-gnd',
        start: { componentId: 'led1', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w-btn-gnd',
        start: { componentId: 'btn1', pinName: '2.l' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w-led-r',
        start: { componentId: 'r-led1', pinName: '2' },
        end: { componentId: 'led1', pinName: 'A' },
        color: '#ff4444',
      },
    ],
  },
  {
    id: 'nano-fade',
    title: 'Nano: PWM Fade',
    description: 'Fade an LED in and out using PWM on pin 9 of the Arduino Nano.',
    category: 'basics',
    difficulty: 'beginner',
    boardType: 'arduino-nano',
    boardFilter: 'arduino-nano',
    code: `// Arduino Nano — PWM LED Fade

const int LED_PIN = 9;  // PWM pin

void setup() {
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(9600);
  Serial.println("Nano PWM Fade demo");
}

void loop() {
  // Fade in
  for (int b = 0; b <= 255; b += 5) {
    analogWrite(LED_PIN, b);
    delay(10);
  }
  // Fade out
  for (int b = 255; b >= 0; b -= 5) {
    analogWrite(LED_PIN, b);
    delay(10);
  }
}`,
    components: [
      { type: 'wokwi-led', id: 'led-fade', x: 420, y: 160, properties: { color: 'blue' } },
      { type: 'wokwi-resistor', id: 'r-fade', x: 420, y: 240, properties: { value: '220' } },
    ],
    wires: [
      {
        id: 'w-fade',
        start: { componentId: 'arduino-uno', pinName: '9' },
        end: { componentId: 'led-fade', pinName: 'A' },
        color: '#2244ff',
      },
      {
        id: 'w-fade-r',
        start: { componentId: 'led-fade', pinName: 'C' },
        end: { componentId: 'r-fade', pinName: '1' },
        color: '#888888',
      },
      {
        id: 'w-fade-gnd',
        start: { componentId: 'r-fade', pinName: '2' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },

  // ─── Arduino Mega Examples ────────────────────────────────────────────────
  {
    id: 'mega-blink',
    title: 'Mega: Blink LED',
    description: 'Blink the built-in LED on pin 13 of the Arduino Mega 2560.',
    category: 'basics',
    difficulty: 'beginner',
    boardType: 'arduino-mega' as any,
    boardFilter: 'arduino-mega',
    code: `// Arduino Mega 2560 — Blink LED

void setup() {
  pinMode(13, OUTPUT);
  Serial.begin(9600);
  Serial.println("Mega Blink ready!");
}

void loop() {
  digitalWrite(13, HIGH);
  Serial.println("LED ON");
  delay(500);
  digitalWrite(13, LOW);
  Serial.println("LED OFF");
  delay(500);
}`,
    components: [],
    wires: [],
  },
  {
    id: 'mega-serial',
    title: 'Mega: Serial Hello',
    description: 'Hello World via Serial on Arduino Mega — tests all 4 UART ports.',
    category: 'communication',
    difficulty: 'beginner',
    boardType: 'arduino-mega' as any,
    boardFilter: 'arduino-mega',
    code: `// Arduino Mega — Serial Hello World
// Mega has 4 hardware UARTs: Serial, Serial1, Serial2, Serial3

void setup() {
  Serial.begin(9600);
  delay(200);
  Serial.println("=== Arduino Mega Serial Demo ===");
  Serial.println("Hello from Mega 2560!");
  Serial.print("Flash: 256 KB | RAM: 8 KB | CPU: ATmega2560 @ 16 MHz");
  Serial.println();
}

int counter = 0;

void loop() {
  delay(1000);
  counter++;
  Serial.print("[");
  Serial.print(counter);
  Serial.print("] Uptime: ");
  Serial.print(millis() / 1000);
  Serial.println("s");
}`,
    components: [],
    wires: [],
  },
  {
    id: 'mega-led-chase',
    title: 'Mega: 8-LED Chase',
    description:
      "Knight-Rider style LED chase across 8 LEDs on pins 2–9. Shows off the Mega's many I/O pins.",
    category: 'basics',
    difficulty: 'beginner',
    boardType: 'arduino-mega' as any,
    boardFilter: 'arduino-mega',
    code: `// Arduino Mega — 8-LED Knight Rider Chase

const int LEDS[] = {2, 3, 4, 5, 6, 7, 8, 9};
const int N = 8;

void setup() {
  for (int i = 0; i < N; i++) {
    pinMode(LEDS[i], OUTPUT);
  }
  Serial.begin(9600);
  Serial.println("Mega LED Chase ready!");
}

void loop() {
  // Chase forward
  for (int i = 0; i < N; i++) {
    digitalWrite(LEDS[i], HIGH);
    delay(80);
    digitalWrite(LEDS[i], LOW);
  }
  // Chase backward
  for (int i = N - 2; i > 0; i--) {
    digitalWrite(LEDS[i], HIGH);
    delay(80);
    digitalWrite(LEDS[i], LOW);
  }
}`,
    components: [
      { type: 'wokwi-led', id: 'led2', x: 420, y: 80, properties: { color: 'red' } },
      { type: 'wokwi-led', id: 'led3', x: 460, y: 80, properties: { color: 'orange' } },
      { type: 'wokwi-led', id: 'led4', x: 500, y: 80, properties: { color: 'yellow' } },
      { type: 'wokwi-led', id: 'led5', x: 540, y: 80, properties: { color: 'green' } },
      { type: 'wokwi-led', id: 'led6', x: 580, y: 80, properties: { color: 'blue' } },
      { type: 'wokwi-led', id: 'led7', x: 620, y: 80, properties: { color: 'purple' } },
      { type: 'wokwi-led', id: 'led8', x: 660, y: 80, properties: { color: 'white' } },
      { type: 'wokwi-led', id: 'led9', x: 700, y: 80, properties: { color: 'red' } },
      // 220 ohm between each GPIO and its LED — (5V - ~2V) / 220R ~= 14 mA,
      // under the LED's 20 mA. One series resistor per LED: without them the
      // circuit checker sees a short and blocks Run for the whole example.
      { type: 'wokwi-resistor', id: 'mr-led2', x: 420, y: 20, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'mr-led3', x: 460, y: 20, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'mr-led4', x: 500, y: 20, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'mr-led5', x: 540, y: 20, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'mr-led6', x: 580, y: 20, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'mr-led7', x: 620, y: 20, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'mr-led8', x: 660, y: 20, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'mr-led9', x: 700, y: 20, properties: { value: '220' } },
    ],
    wires: [
      {
        id: 'w2',
        start: { componentId: 'arduino-uno', pinName: '2' },
        end: { componentId: 'mr-led2', pinName: '1' },
        color: '#ff2222',
      },
      {
        id: 'w3',
        start: { componentId: 'arduino-uno', pinName: '3' },
        end: { componentId: 'mr-led3', pinName: '1' },
        color: '#ff8800',
      },
      {
        id: 'w4',
        start: { componentId: 'arduino-uno', pinName: '4' },
        end: { componentId: 'mr-led4', pinName: '1' },
        color: '#ffcc00',
      },
      {
        id: 'w5',
        start: { componentId: 'arduino-uno', pinName: '5' },
        end: { componentId: 'mr-led5', pinName: '1' },
        color: '#22bb22',
      },
      {
        id: 'w6',
        start: { componentId: 'arduino-uno', pinName: '6' },
        end: { componentId: 'mr-led6', pinName: '1' },
        color: '#2244ff',
      },
      {
        id: 'w7',
        start: { componentId: 'arduino-uno', pinName: '7' },
        end: { componentId: 'mr-led7', pinName: '1' },
        color: '#aa44ff',
      },
      {
        id: 'w8',
        start: { componentId: 'arduino-uno', pinName: '8' },
        end: { componentId: 'mr-led8', pinName: '1' },
        color: '#ffffff',
      },
      {
        id: 'w9',
        start: { componentId: 'arduino-uno', pinName: '9' },
        end: { componentId: 'mr-led9', pinName: '1' },
        color: '#ff2222',
      },
      {
        id: 'w2-gnd',
        start: { componentId: 'led2', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w3-gnd',
        start: { componentId: 'led3', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w4-gnd',
        start: { componentId: 'led4', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w5-gnd',
        start: { componentId: 'led5', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w6-gnd',
        start: { componentId: 'led6', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w7-gnd',
        start: { componentId: 'led7', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w8-gnd',
        start: { componentId: 'led8', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w9-gnd',
        start: { componentId: 'led9', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w2-r',
        start: { componentId: 'mr-led2', pinName: '2' },
        end: { componentId: 'led2', pinName: 'A' },
        color: '#ff2222',
      },
      {
        id: 'w3-r',
        start: { componentId: 'mr-led3', pinName: '2' },
        end: { componentId: 'led3', pinName: 'A' },
        color: '#ff8800',
      },
      {
        id: 'w4-r',
        start: { componentId: 'mr-led4', pinName: '2' },
        end: { componentId: 'led4', pinName: 'A' },
        color: '#ffcc00',
      },
      {
        id: 'w5-r',
        start: { componentId: 'mr-led5', pinName: '2' },
        end: { componentId: 'led5', pinName: 'A' },
        color: '#22bb22',
      },
      {
        id: 'w6-r',
        start: { componentId: 'mr-led6', pinName: '2' },
        end: { componentId: 'led6', pinName: 'A' },
        color: '#2244ff',
      },
      {
        id: 'w7-r',
        start: { componentId: 'mr-led7', pinName: '2' },
        end: { componentId: 'led7', pinName: 'A' },
        color: '#aa44ff',
      },
      {
        id: 'w8-r',
        start: { componentId: 'mr-led8', pinName: '2' },
        end: { componentId: 'led8', pinName: 'A' },
        color: '#ffffff',
      },
      {
        id: 'w9-r',
        start: { componentId: 'mr-led9', pinName: '2' },
        end: { componentId: 'led9', pinName: 'A' },
        color: '#ff2222',
      },
    ],
  },
  {
    id: 'mega-serial-control',
    title: 'Mega: Serial LED Control',
    description: "Send '1'–'8' over Serial to toggle individual LEDs on the Arduino Mega.",
    category: 'communication',
    difficulty: 'intermediate',
    boardType: 'arduino-mega' as any,
    boardFilter: 'arduino-mega',
    code: `// Arduino Mega — Serial-controlled LEDs
// Send '1' through '8' to toggle individual LEDs on pins 2-9
// Send 'a' to turn all on, 'x' to turn all off

const int LEDS[] = {2, 3, 4, 5, 6, 7, 8, 9};
const int N = 8;
bool states[8] = {false};

void setup() {
  for (int i = 0; i < N; i++) {
    pinMode(LEDS[i], OUTPUT);
  }
  Serial.begin(9600);
  Serial.println("=== Mega LED Controller ===");
  Serial.println("Send 1-8 to toggle LEDs");
  Serial.println("Send 'a' = all ON, 'x' = all OFF");
}

void loop() {
  if (Serial.available()) {
    char c = Serial.read();
    if (c >= '1' && c <= '8') {
      int idx = c - '1';
      states[idx] = !states[idx];
      digitalWrite(LEDS[idx], states[idx] ? HIGH : LOW);
      Serial.print("LED "); Serial.print(idx+1);
      Serial.println(states[idx] ? " ON" : " OFF");
    } else if (c == 'a') {
      for (int i = 0; i < N; i++) { states[i] = true; digitalWrite(LEDS[i], HIGH); }
      Serial.println("All LEDs ON");
    } else if (c == 'x') {
      for (int i = 0; i < N; i++) { states[i] = false; digitalWrite(LEDS[i], LOW); }
      Serial.println("All LEDs OFF");
    }
  }
}`,
    components: [
      { type: 'wokwi-led', id: 'mled2', x: 420, y: 80, properties: { color: 'red' } },
      { type: 'wokwi-led', id: 'mled3', x: 460, y: 80, properties: { color: 'orange' } },
      { type: 'wokwi-led', id: 'mled4', x: 500, y: 80, properties: { color: 'yellow' } },
      { type: 'wokwi-led', id: 'mled5', x: 540, y: 80, properties: { color: 'green' } },
      { type: 'wokwi-led', id: 'mled6', x: 580, y: 80, properties: { color: 'blue' } },
      { type: 'wokwi-led', id: 'mled7', x: 620, y: 80, properties: { color: 'purple' } },
      { type: 'wokwi-led', id: 'mled8', x: 660, y: 80, properties: { color: 'white' } },
      { type: 'wokwi-led', id: 'mled9', x: 700, y: 80, properties: { color: 'red' } },
      // 220 ohm between each GPIO and its LED — (5V - ~2V) / 220R ~= 14 mA,
      // under the LED's 20 mA. One series resistor per LED, as everywhere else.
      { type: 'wokwi-resistor', id: 'msr-mled2', x: 420, y: 20, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'msr-mled3', x: 460, y: 20, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'msr-mled4', x: 500, y: 20, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'msr-mled5', x: 540, y: 20, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'msr-mled6', x: 580, y: 20, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'msr-mled7', x: 620, y: 20, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'msr-mled8', x: 660, y: 20, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'msr-mled9', x: 700, y: 20, properties: { value: '220' } },
    ],
    wires: [
      {
        id: 'mw2',
        start: { componentId: 'arduino-uno', pinName: '2' },
        end: { componentId: 'msr-mled2', pinName: '1' },
        color: '#ff2222',
      },
      {
        id: 'mw3',
        start: { componentId: 'arduino-uno', pinName: '3' },
        end: { componentId: 'msr-mled3', pinName: '1' },
        color: '#ff8800',
      },
      {
        id: 'mw4',
        start: { componentId: 'arduino-uno', pinName: '4' },
        end: { componentId: 'msr-mled4', pinName: '1' },
        color: '#ffcc00',
      },
      {
        id: 'mw5',
        start: { componentId: 'arduino-uno', pinName: '5' },
        end: { componentId: 'msr-mled5', pinName: '1' },
        color: '#22bb22',
      },
      {
        id: 'mw6',
        start: { componentId: 'arduino-uno', pinName: '6' },
        end: { componentId: 'msr-mled6', pinName: '1' },
        color: '#2244ff',
      },
      {
        id: 'mw7',
        start: { componentId: 'arduino-uno', pinName: '7' },
        end: { componentId: 'msr-mled7', pinName: '1' },
        color: '#aa44ff',
      },
      {
        id: 'mw8',
        start: { componentId: 'arduino-uno', pinName: '8' },
        end: { componentId: 'msr-mled8', pinName: '1' },
        color: '#ffffff',
      },
      {
        id: 'mw9',
        start: { componentId: 'arduino-uno', pinName: '9' },
        end: { componentId: 'msr-mled9', pinName: '1' },
        color: '#ff2222',
      },
      {
        id: 'mw2-gnd',
        start: { componentId: 'mled2', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'mw3-gnd',
        start: { componentId: 'mled3', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'mw4-gnd',
        start: { componentId: 'mled4', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'mw5-gnd',
        start: { componentId: 'mled5', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'mw6-gnd',
        start: { componentId: 'mled6', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'mw7-gnd',
        start: { componentId: 'mled7', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'mw8-gnd',
        start: { componentId: 'mled8', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'mw9-gnd',
        start: { componentId: 'mled9', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'mw2-r',
        start: { componentId: 'msr-mled2', pinName: '2' },
        end: { componentId: 'mled2', pinName: 'A' },
        color: '#ff2222',
      },
      {
        id: 'mw3-r',
        start: { componentId: 'msr-mled3', pinName: '2' },
        end: { componentId: 'mled3', pinName: 'A' },
        color: '#ff8800',
      },
      {
        id: 'mw4-r',
        start: { componentId: 'msr-mled4', pinName: '2' },
        end: { componentId: 'mled4', pinName: 'A' },
        color: '#ffcc00',
      },
      {
        id: 'mw5-r',
        start: { componentId: 'msr-mled5', pinName: '2' },
        end: { componentId: 'mled5', pinName: 'A' },
        color: '#22bb22',
      },
      {
        id: 'mw6-r',
        start: { componentId: 'msr-mled6', pinName: '2' },
        end: { componentId: 'mled6', pinName: 'A' },
        color: '#2244ff',
      },
      {
        id: 'mw7-r',
        start: { componentId: 'msr-mled7', pinName: '2' },
        end: { componentId: 'mled7', pinName: 'A' },
        color: '#aa44ff',
      },
      {
        id: 'mw8-r',
        start: { componentId: 'msr-mled8', pinName: '2' },
        end: { componentId: 'mled8', pinName: 'A' },
        color: '#ffffff',
      },
      {
        id: 'mw9-r',
        start: { componentId: 'msr-mled9', pinName: '2' },
        end: { componentId: 'mled9', pinName: 'A' },
        color: '#ff2222',
      },
    ],
  },

  // ─── ESP32-C3 (RISC-V via QEMU lcgamboa) Examples ─────────────────────────
  {
    id: 'c3-blink',
    title: 'ESP32-C3: Blink LED',
    description:
      'Blink an LED on GPIO 8 of the ESP32-C3. Runs through the QEMU lcgamboa backend (libqemu-riscv32) at 160 MHz.',
    category: 'basics',
    difficulty: 'beginner',
    boardType: 'esp32-c3',
    boardFilter: 'esp32-c3',
    code: `// ESP32-C3 — Blink LED on GPIO 8
// Runs via QEMU libqemu-riscv32 (esp32c3-picsimlab machine)

#define LED_PIN 8

void setup() {
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(115200);
  Serial.println("ESP32-C3 Blink ready!");
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
      { type: 'wokwi-led', id: 'c3-led1', x: 440, y: 160, properties: { color: 'green' } },
      { type: 'wokwi-resistor', id: 'c3-r1', x: 440, y: 240, properties: { value: '220' } },
    ],
    wires: [
      {
        id: 'c3w1',
        start: { componentId: 'arduino-uno', pinName: '8' },
        end: { componentId: 'c3-led1', pinName: 'A' },
        color: '#22cc22',
      },
      {
        id: 'c3w2',
        start: { componentId: 'c3-led1', pinName: 'C' },
        end: { componentId: 'c3-r1', pinName: '1' },
        color: '#888888',
      },
      {
        id: 'c3w3',
        start: { componentId: 'c3-r1', pinName: '2' },
        end: { componentId: 'arduino-uno', pinName: 'GND.9' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'c3-serial',
    title: 'ESP32-C3: Serial Hello',
    description:
      'Print Hello World and a heartbeat every second from ESP32-C3 via Serial. Runs in the browser.',
    category: 'communication',
    difficulty: 'beginner',
    boardType: 'esp32-c3',
    boardFilter: 'esp32-c3',
    code: `// ESP32-C3 — Serial Hello World
// Open Serial Monitor at 115200 baud

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("=== ESP32-C3 Serial Demo ===");
  Serial.println("RV32IMC @ 160 MHz — QEMU libqemu-riscv32");
  Serial.println();
}

int tick = 0;

void loop() {
  delay(1000);
  tick++;
  Serial.print("[");
  Serial.print(tick);
  Serial.print("] Uptime: ");
  Serial.print(millis() / 1000);
  Serial.println("s");
}`,
    components: [],
    wires: [],
  },
  {
    id: 'c3-rgb',
    title: 'ESP32-C3: RGB LED',
    description:
      'Cycle through red, green, and blue on an RGB LED using GPIO 6, 7, 8 on the ESP32-C3.',
    category: 'basics',
    difficulty: 'beginner',
    boardType: 'esp32-c3',
    boardFilter: 'esp32-c3',
    code: `// ESP32-C3 — RGB LED color cycle
// R=GPIO6  G=GPIO7  B=GPIO8

#define R_PIN 6
#define G_PIN 7
#define B_PIN 8

void setup() {
  pinMode(R_PIN, OUTPUT);
  pinMode(G_PIN, OUTPUT);
  pinMode(B_PIN, OUTPUT);
  Serial.begin(115200);
  Serial.println("ESP32-C3 RGB LED demo");
}

void setRGB(bool r, bool g, bool b) {
  digitalWrite(R_PIN, r ? HIGH : LOW);
  digitalWrite(G_PIN, g ? HIGH : LOW);
  digitalWrite(B_PIN, b ? HIGH : LOW);
}

void loop() {
  setRGB(1,0,0); Serial.println("RED");   delay(600);
  setRGB(0,1,0); Serial.println("GREEN"); delay(600);
  setRGB(0,0,1); Serial.println("BLUE");  delay(600);
  setRGB(1,1,0); Serial.println("YELLOW");delay(600);
  setRGB(0,1,1); Serial.println("CYAN");  delay(600);
  setRGB(1,0,1); Serial.println("MAGENTA");delay(600);
  setRGB(1,1,1); Serial.println("WHITE"); delay(600);
  setRGB(0,0,0); Serial.println("OFF");   delay(300);
}`,
    components: [
      { type: 'wokwi-resistor', id: 'r-c3-rgb1-r', x: 320, y: 160, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-c3-rgb1-g', x: 320, y: 186, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-c3-rgb1-b', x: 320, y: 212, properties: { value: '220' } },
      { type: 'wokwi-rgb-led', id: 'c3-rgb1', x: 440, y: 160, properties: {} }],
    wires: [
      {
        id: 'c3-rw1',
        start: { componentId: 'arduino-uno', pinName: '6' },
        end: { componentId: 'r-c3-rgb1-r', pinName: '1' },
        color: '#ff2222',
      },
      {
        id: 'w-r-c3-rgb1-r',
        start: { componentId: 'r-c3-rgb1-r', pinName: '2' },
        end: { componentId: 'c3-rgb1', pinName: 'R' },
        color: '#e74c3c',
      },
      {
        id: 'c3-rw2',
        start: { componentId: 'arduino-uno', pinName: '7' },
        end: { componentId: 'r-c3-rgb1-g', pinName: '1' },
        color: '#22cc22',
      },
      {
        id: 'w-r-c3-rgb1-g',
        start: { componentId: 'r-c3-rgb1-g', pinName: '2' },
        end: { componentId: 'c3-rgb1', pinName: 'G' },
        color: '#e74c3c',
      },
      {
        id: 'c3-rw3',
        start: { componentId: 'arduino-uno', pinName: '8' },
        end: { componentId: 'r-c3-rgb1-b', pinName: '1' },
        color: '#2244ff',
      },
      {
        id: 'w-r-c3-rgb1-b',
        start: { componentId: 'r-c3-rgb1-b', pinName: '2' },
        end: { componentId: 'c3-rgb1', pinName: 'B' },
        color: '#e74c3c',
      },
      {
        id: 'c3-rw4',
        start: { componentId: 'c3-rgb1', pinName: 'COM' },
        end: { componentId: 'arduino-uno', pinName: 'GND.8' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'c3-button',
    title: 'ESP32-C3: Button + LED',
    description:
      'Press a button on GPIO 9 to toggle an LED on GPIO 8. Tests GPIO input on the browser ESP32-C3 emulator.',
    category: 'basics',
    difficulty: 'beginner',
    boardType: 'esp32-c3',
    boardFilter: 'esp32-c3',
    code: `// ESP32-C3 — Button controls LED
// Button on GPIO9 (INPUT_PULLUP), LED on GPIO8

#define BTN_PIN 9
#define LED_PIN 8

void setup() {
  pinMode(BTN_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(115200);
  Serial.println("ESP32-C3 Button+LED ready");
  Serial.println("Hold button to light LED");
}

void loop() {
  bool pressed = digitalRead(BTN_PIN) == LOW;
  digitalWrite(LED_PIN, pressed ? HIGH : LOW);
  if (pressed) Serial.println("Button pressed!");
  delay(50);
}`,
    components: [
      { type: 'wokwi-pushbutton', id: 'c3-btn1', x: 440, y: 120, properties: {} },
      // 220 ohm in series with the LED — never hang an LED straight off a
      // GPIO. (3.3V - ~2.8V for the blue one) / 220R ~= 2 mA, comfortably
      // under the 20 mA it takes. Without it the circuit checker computes
      // 506 mA and rightly refuses to run: on real hardware that LED would
      // not last long.
      { type: 'wokwi-resistor', id: 'c3-r-led', x: 440, y: 200, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'c3-led-btn', x: 440, y: 260, properties: { color: 'blue' } },
    ],
    wires: [
      {
        id: 'c3-bw1',
        start: { componentId: 'arduino-uno', pinName: '9' },
        end: { componentId: 'c3-btn1', pinName: '1.l' },
        color: '#00aaff',
      },
      {
        id: 'c3-bw2',
        start: { componentId: 'arduino-uno', pinName: '8' },
        end: { componentId: 'c3-r-led', pinName: '1' },
        color: '#2244ff',
      },
      {
        id: 'c3-bw2b',
        start: { componentId: 'c3-r-led', pinName: '2' },
        end: { componentId: 'c3-led-btn', pinName: 'A' },
        color: '#2244ff',
      },
      {
        id: 'c3-bw3',
        start: { componentId: 'c3-led-btn', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND.8' },
        color: '#000000',
      },
      {
        id: 'c3-bw4',
        start: { componentId: 'c3-btn1', pinName: '2.l' },
        end: { componentId: 'arduino-uno', pinName: 'GND.9' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'c3-serial-echo',
    title: 'ESP32-C3: Serial Echo',
    description: 'Type in Serial Monitor and see it echoed back by the ESP32-C3 browser emulator.',
    category: 'communication',
    difficulty: 'beginner',
    boardType: 'esp32-c3',
    boardFilter: 'esp32-c3',
    code: `// ESP32-C3 — Serial Echo
// Open Serial Monitor at 115200 baud, type anything

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("ESP32-C3 Serial Echo");
  Serial.println("Type anything and press Enter...");
}

void loop() {
  if (Serial.available()) {
    String line = Serial.readStringUntil('\\n');
    line.trim();
    if (line.length() > 0) {
      Serial.print("Echo: ");
      Serial.println(line);
    }
  }
}`,
    components: [],
    wires: [],
  },

  // ─── 7-Segment Display Examples ──────────────────────────────────────────
  {
    id: 'uno-7segment',
    title: 'Uno: 7-Segment Counter',
    description:
      'Count 0–9 on a 7-segment display driven directly from pins 2–8 on the Arduino Uno.',
    category: 'displays',
    difficulty: 'beginner',
    boardFilter: 'arduino-uno',
    code: `// Arduino Uno — 7-Segment Display Counter 0-9
// Segments: a=2, b=3, c=4, d=5, e=6, f=7, g=8
// Common cathode display

// Segment pins: a b c d e f g
const int SEG[7] = {2, 3, 4, 5, 6, 7, 8};

// Digit patterns [a,b,c,d,e,f,g] (1=ON)
const bool DIGITS[10][7] = {
  {1,1,1,1,1,1,0}, // 0
  {0,1,1,0,0,0,0}, // 1
  {1,1,0,1,1,0,1}, // 2
  {1,1,1,1,0,0,1}, // 3
  {0,1,1,0,0,1,1}, // 4
  {1,0,1,1,0,1,1}, // 5
  {1,0,1,1,1,1,1}, // 6
  {1,1,1,0,0,0,0}, // 7
  {1,1,1,1,1,1,1}, // 8
  {1,1,1,1,0,1,1}, // 9
};

void showDigit(int d) {
  for (int i = 0; i < 7; i++)
    digitalWrite(SEG[i], DIGITS[d][i] ? HIGH : LOW);
}

void setup() {
  for (int i = 0; i < 7; i++) pinMode(SEG[i], OUTPUT);
  Serial.begin(9600);
  Serial.println("7-Segment Counter ready");
}

void loop() {
  for (int d = 0; d <= 9; d++) {
    showDigit(d);
    Serial.println(d);
    delay(800);
  }
}`,
    components: [
      {
        type: 'wokwi-7segment',
        id: 'seg1',
        x: 440,
        y: 140,
        properties: { common: 'cathode', color: 'red' },
      },
    ],
    wires: [
      {
        id: 'seg-a',
        start: { componentId: 'arduino-uno', pinName: '2' },
        end: { componentId: 'seg1', pinName: 'A' },
        color: '#ff4444',
      },
      {
        id: 'seg-b',
        start: { componentId: 'arduino-uno', pinName: '3' },
        end: { componentId: 'seg1', pinName: 'B' },
        color: '#ff8800',
      },
      {
        id: 'seg-c',
        start: { componentId: 'arduino-uno', pinName: '4' },
        end: { componentId: 'seg1', pinName: 'C' },
        color: '#ffcc00',
      },
      {
        id: 'seg-d',
        start: { componentId: 'arduino-uno', pinName: '5' },
        end: { componentId: 'seg1', pinName: 'D' },
        color: '#44cc44',
      },
      {
        id: 'seg-e',
        start: { componentId: 'arduino-uno', pinName: '6' },
        end: { componentId: 'seg1', pinName: 'E' },
        color: '#4488ff',
      },
      {
        id: 'seg-f',
        start: { componentId: 'arduino-uno', pinName: '7' },
        end: { componentId: 'seg1', pinName: 'F' },
        color: '#aa44ff',
      },
      {
        id: 'seg-g',
        start: { componentId: 'arduino-uno', pinName: '8' },
        end: { componentId: 'seg1', pinName: 'G' },
        color: '#ffffff',
      },
      {
        id: 'seg-gnd',
        start: { componentId: 'seg1', pinName: 'COM' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'pico-7segment',
    title: 'Pico: 7-Segment Counter',
    description: 'Count 0–9 on a 7-segment display driven from GPIO 2–8 on the Raspberry Pi Pico.',
    category: 'displays',
    difficulty: 'beginner',
    boardType: 'raspberry-pi-pico',
    boardFilter: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — 7-Segment Display Counter 0-9
// Segments: a=2, b=3, c=4, d=5, e=6, f=7, g=8

const int SEG[7] = {2, 3, 4, 5, 6, 7, 8};

const bool DIGITS[10][7] = {
  {1,1,1,1,1,1,0}, // 0
  {0,1,1,0,0,0,0}, // 1
  {1,1,0,1,1,0,1}, // 2
  {1,1,1,1,0,0,1}, // 3
  {0,1,1,0,0,1,1}, // 4
  {1,0,1,1,0,1,1}, // 5
  {1,0,1,1,1,1,1}, // 6
  {1,1,1,0,0,0,0}, // 7
  {1,1,1,1,1,1,1}, // 8
  {1,1,1,1,0,1,1}, // 9
};

void showDigit(int d) {
  for (int i = 0; i < 7; i++)
    digitalWrite(SEG[i], DIGITS[d][i] ? HIGH : LOW);
}

void setup() {
  for (int i = 0; i < 7; i++) pinMode(SEG[i], OUTPUT);
  Serial.begin(115200);
  Serial.println("Pico 7-Segment Counter");
}

void loop() {
  for (int d = 0; d <= 9; d++) {
    showDigit(d);
    Serial.print("Digit: ");
    Serial.println(d);
    delay(700);
  }
}`,
    components: [
      {
        type: 'wokwi-7segment',
        id: 'pico-seg1',
        x: 440,
        y: 140,
        properties: { common: 'cathode', color: 'green' },
      },
    ],
    wires: [
      {
        id: 'ps-a',
        start: { componentId: 'arduino-uno', pinName: 'GP2' },
        end: { componentId: 'pico-seg1', pinName: 'A' },
        color: '#ff4444',
      },
      {
        id: 'ps-b',
        start: { componentId: 'arduino-uno', pinName: 'GP3' },
        end: { componentId: 'pico-seg1', pinName: 'B' },
        color: '#ff8800',
      },
      {
        id: 'ps-c',
        start: { componentId: 'arduino-uno', pinName: 'GP4' },
        end: { componentId: 'pico-seg1', pinName: 'C' },
        color: '#ffcc00',
      },
      {
        id: 'ps-d',
        start: { componentId: 'arduino-uno', pinName: 'GP5' },
        end: { componentId: 'pico-seg1', pinName: 'D' },
        color: '#44cc44',
      },
      {
        id: 'ps-e',
        start: { componentId: 'arduino-uno', pinName: 'GP6' },
        end: { componentId: 'pico-seg1', pinName: 'E' },
        color: '#4488ff',
      },
      {
        id: 'ps-f',
        start: { componentId: 'arduino-uno', pinName: 'GP7' },
        end: { componentId: 'pico-seg1', pinName: 'F' },
        color: '#aa44ff',
      },
      {
        id: 'ps-g',
        start: { componentId: 'arduino-uno', pinName: 'GP8' },
        end: { componentId: 'pico-seg1', pinName: 'G' },
        color: '#ffffff',
      },
      {
        id: 'ps-gnd',
        start: { componentId: 'pico-seg1', pinName: 'COM' },
        end: { componentId: 'arduino-uno', pinName: 'GND.1' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'esp32-7segment',
    title: 'ESP32: 7-Segment Counter',
    description:
      'Count 0–9 on a 7-segment display driven from GPIO 12, 13, 14, 25, 26, 27, 32 on the ESP32.',
    category: 'displays',
    difficulty: 'beginner',
    boardType: 'esp32',
    boardFilter: 'esp32',
    code: `// ESP32 — 7-Segment Display Counter 0-9
// Segments: a=12, b=13, c=14, d=25, e=26, f=27, g=32


const int SEG[7] = {12, 13, 14, 25, 26, 27, 32};

const bool DIGITS[10][7] = {
  {1,1,1,1,1,1,0}, // 0
  {0,1,1,0,0,0,0}, // 1
  {1,1,0,1,1,0,1}, // 2
  {1,1,1,1,0,0,1}, // 3
  {0,1,1,0,0,1,1}, // 4
  {1,0,1,1,0,1,1}, // 5
  {1,0,1,1,1,1,1}, // 6
  {1,1,1,0,0,0,0}, // 7
  {1,1,1,1,1,1,1}, // 8
  {1,1,1,1,0,1,1}, // 9
};


void showDigit(int d) {
  for (int i = 0; i < 7; i++)
    digitalWrite(SEG[i], DIGITS[d][i] ? HIGH : LOW);
}

void setup() {
  for (int i = 0; i < 7; i++) pinMode(SEG[i], OUTPUT);
  Serial.begin(115200);
  Serial.println("ESP32 7-Segment Counter");
}

void loop() {
  for (int d = 0; d <= 9; d++) {
    showDigit(d);
    Serial.print("Digit: "); Serial.println(d);
    delay(700);
  }
}`,
    components: [
      {
        type: 'wokwi-7segment',
        id: 'esp-seg1',
        x: 440,
        y: 140,
        properties: { common: 'cathode', color: 'orange' },
      },
    ],
    wires: [
      {
        id: 'es-a',
        start: { componentId: 'arduino-uno', pinName: '12' },
        end: { componentId: 'esp-seg1', pinName: 'A' },
        color: '#ff4444',
      },
      {
        id: 'es-b',
        start: { componentId: 'arduino-uno', pinName: '13' },
        end: { componentId: 'esp-seg1', pinName: 'B' },
        color: '#ff8800',
      },
      {
        id: 'es-c',
        start: { componentId: 'arduino-uno', pinName: '14' },
        end: { componentId: 'esp-seg1', pinName: 'C' },
        color: '#ffcc00',
      },
      {
        id: 'es-d',
        start: { componentId: 'arduino-uno', pinName: '25' },
        end: { componentId: 'esp-seg1', pinName: 'D' },
        color: '#44cc44',
      },
      {
        id: 'es-e',
        start: { componentId: 'arduino-uno', pinName: '26' },
        end: { componentId: 'esp-seg1', pinName: 'E' },
        color: '#4488ff',
      },
      {
        id: 'es-f',
        start: { componentId: 'arduino-uno', pinName: '27' },
        end: { componentId: 'esp-seg1', pinName: 'F' },
        color: '#aa44ff',
      },
      {
        id: 'es-g',
        start: { componentId: 'arduino-uno', pinName: '32' },
        end: { componentId: 'esp-seg1', pinName: 'G' },
        color: '#ffffff',
      },
      {
        id: 'es-gnd',
        start: { componentId: 'esp-seg1', pinName: 'COM' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },

  // ─── More Arduino Uno Examples ────────────────────────────────────────────
  {
    id: 'uno-potentiometer',
    title: 'Uno: Potentiometer → Serial',
    description: 'Read an analog potentiometer on A0 and print the value to Serial Monitor.',
    category: 'sensors',
    difficulty: 'beginner',
    boardFilter: 'arduino-uno',
    code: `// Arduino Uno — Potentiometer ADC reading

const int POT_PIN = A0;

void setup() {
  Serial.begin(9600);
  Serial.println("Potentiometer demo — turn the knob!");
}

void loop() {
  int raw = analogRead(POT_PIN);          // 0–1023
  float voltage = raw * (5.0 / 1023.0);  // convert to volts
  float percent  = raw / 10.23;

  Serial.print("ADC: ");
  Serial.print(raw);
  Serial.print("  |  ");
  Serial.print(voltage, 2);
  Serial.print(" V  |  ");
  Serial.print(percent, 1);
  Serial.println(" %");

  delay(200);
}`,
    components: [{ type: 'wokwi-potentiometer', id: 'pot1', x: 440, y: 160, properties: {} }],
    wires: [
      {
        id: 'w-pot-sig',
        start: { componentId: 'arduino-uno', pinName: 'A0' },
        end: { componentId: 'pot1', pinName: 'SIG' },
        color: '#aa44ff',
      },
      {
        id: 'w-pot-vcc',
        start: { componentId: 'arduino-uno', pinName: '5V' },
        end: { componentId: 'pot1', pinName: 'VCC' },
        color: '#ff0000',
      },
      {
        id: 'w-pot-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND' },
        end: { componentId: 'pot1', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'uno-rgb-cycle',
    title: 'Uno: RGB LED Cycle',
    description:
      'Cycle through 7 colors on an RGB LED connected to pins 9 (R), 10 (G), 11 (B) using PWM.',
    category: 'basics',
    difficulty: 'beginner',
    boardFilter: 'arduino-uno',
    code: `// Arduino Uno — RGB LED color cycle using PWM

#define R_PIN 9
#define G_PIN 10
#define B_PIN 11

void setColor(int r, int g, int b) {
  analogWrite(R_PIN, r);
  analogWrite(G_PIN, g);
  analogWrite(B_PIN, b);
}

void setup() {
  Serial.begin(9600);
  Serial.println("RGB LED Cycle — 7 colors");
}

void loop() {
  setColor(255,   0,   0); Serial.println("RED");     delay(600);
  setColor(  0, 255,   0); Serial.println("GREEN");   delay(600);
  setColor(  0,   0, 255); Serial.println("BLUE");    delay(600);
  setColor(255, 255,   0); Serial.println("YELLOW");  delay(600);
  setColor(  0, 255, 255); Serial.println("CYAN");    delay(600);
  setColor(255,   0, 255); Serial.println("MAGENTA"); delay(600);
  setColor(255, 255, 255); Serial.println("WHITE");   delay(600);
  setColor(  0,   0,   0); Serial.println("OFF");     delay(300);
}`,
    components: [
      { type: 'wokwi-resistor', id: 'r-rgb1-r', x: 320, y: 160, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-rgb1-g', x: 320, y: 186, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-rgb1-b', x: 320, y: 212, properties: { value: '220' } },
      { type: 'wokwi-rgb-led', id: 'rgb1', x: 440, y: 160, properties: {} }],
    wires: [
      {
        id: 'w-r',
        start: { componentId: 'arduino-uno', pinName: '9' },
        end: { componentId: 'r-rgb1-r', pinName: '1' },
        color: '#ff2222',
      },
      {
        id: 'w-r-rgb1-r',
        start: { componentId: 'r-rgb1-r', pinName: '2' },
        end: { componentId: 'rgb1', pinName: 'R' },
        color: '#e74c3c',
      },
      {
        id: 'w-g',
        start: { componentId: 'arduino-uno', pinName: '10' },
        end: { componentId: 'r-rgb1-g', pinName: '1' },
        color: '#22cc22',
      },
      {
        id: 'w-r-rgb1-g',
        start: { componentId: 'r-rgb1-g', pinName: '2' },
        end: { componentId: 'rgb1', pinName: 'G' },
        color: '#e74c3c',
      },
      {
        id: 'w-b',
        start: { componentId: 'arduino-uno', pinName: '11' },
        end: { componentId: 'r-rgb1-b', pinName: '1' },
        color: '#2244ff',
      },
      {
        id: 'w-r-rgb1-b',
        start: { componentId: 'r-rgb1-b', pinName: '2' },
        end: { componentId: 'rgb1', pinName: 'B' },
        color: '#e74c3c',
      },
      {
        id: 'w-rgb-gnd',
        start: { componentId: 'rgb1', pinName: 'COM' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },

  // ─── More Pico Examples ───────────────────────────────────────────────────
  {
    id: 'pico-button-led',
    title: 'Pico: Button + LED',
    description: 'Press a button on GP2 to light up an LED on GP3 on the Raspberry Pi Pico.',
    category: 'basics',
    difficulty: 'beginner',
    boardType: 'raspberry-pi-pico',
    boardFilter: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — Button controls LED
// Button on GP2 (INPUT_PULLUP), LED on GP3

#define BTN_PIN 2
#define LED_PIN 3

void setup() {
  pinMode(BTN_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(115200);
  Serial.println("Pico Button+LED ready — press button on GP2");
}

void loop() {
  bool pressed = digitalRead(BTN_PIN) == LOW;
  digitalWrite(LED_PIN, pressed ? HIGH : LOW);
}`,
    components: [
      { type: 'wokwi-pushbutton', id: 'pico-btn1', x: 440, y: 120, properties: {} },
      // 220 ohm in series with the LED — as in every other example. An LED
      // hung straight off a GPIO goes over the current limit and the circuit
      // checker blocks it, rightly.
      { type: 'wokwi-resistor', id: 'pico-r-led', x: 440, y: 200, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'pico-led-btn', x: 440, y: 260, properties: { color: 'yellow' } },
    ],
    wires: [
      {
        id: 'pb-btn',
        start: { componentId: 'arduino-uno', pinName: 'GP2' },
        end: { componentId: 'pico-btn1', pinName: '1.l' },
        color: '#00aaff',
      },
      {
        id: 'pb-led',
        start: { componentId: 'arduino-uno', pinName: 'GP3' },
        end: { componentId: 'pico-r-led', pinName: '1' },
        color: '#ffcc00',
      },
      {
        id: 'pb-led-r',
        start: { componentId: 'pico-r-led', pinName: '2' },
        end: { componentId: 'pico-led-btn', pinName: 'A' },
        color: '#ffcc00',
      },
      {
        id: 'pb-led-gnd',
        start: { componentId: 'pico-led-btn', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'GND.1' },
        color: '#000000',
      },
      {
        id: 'pb-btn-gnd',
        start: { componentId: 'pico-btn1', pinName: '2.l' },
        end: { componentId: 'arduino-uno', pinName: 'GND.1' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'pico-rgb',
    title: 'Pico: RGB LED Cycle',
    description:
      'Cycle through colors on an RGB LED using GPIO 6 (R), 7 (G), 8 (B) on the Raspberry Pi Pico.',
    category: 'basics',
    difficulty: 'beginner',
    boardType: 'raspberry-pi-pico',
    boardFilter: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — RGB LED color cycle

#define R_PIN 6
#define G_PIN 7
#define B_PIN 8

void setRGB(bool r, bool g, bool b) {
  digitalWrite(R_PIN, r ? HIGH : LOW);
  digitalWrite(G_PIN, g ? HIGH : LOW);
  digitalWrite(B_PIN, b ? HIGH : LOW);
}

void setup() {
  pinMode(R_PIN, OUTPUT);
  pinMode(G_PIN, OUTPUT);
  pinMode(B_PIN, OUTPUT);
  Serial.begin(115200);
  Serial.println("Pico RGB LED demo");
}

void loop() {
  setRGB(1,0,0); Serial.println("RED");    delay(600);
  setRGB(0,1,0); Serial.println("GREEN");  delay(600);
  setRGB(0,0,1); Serial.println("BLUE");   delay(600);
  setRGB(1,1,0); Serial.println("YELLOW"); delay(600);
  setRGB(0,1,1); Serial.println("CYAN");   delay(600);
  setRGB(1,0,1); Serial.println("MAGENTA");delay(600);
  setRGB(0,0,0); Serial.println("OFF");    delay(300);
}`,
    components: [
      { type: 'wokwi-resistor', id: 'r-pico-rgb1-r', x: 320, y: 160, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-pico-rgb1-g', x: 320, y: 186, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-pico-rgb1-b', x: 320, y: 212, properties: { value: '220' } },
      { type: 'wokwi-rgb-led', id: 'pico-rgb1', x: 440, y: 160, properties: {} }],
    wires: [
      {
        id: 'pr-r',
        start: { componentId: 'arduino-uno', pinName: 'GP6' },
        end: { componentId: 'r-pico-rgb1-r', pinName: '1' },
        color: '#ff2222',
      },
      {
        id: 'w-r-pico-rgb1-r',
        start: { componentId: 'r-pico-rgb1-r', pinName: '2' },
        end: { componentId: 'pico-rgb1', pinName: 'R' },
        color: '#e74c3c',
      },
      {
        id: 'pr-g',
        start: { componentId: 'arduino-uno', pinName: 'GP7' },
        end: { componentId: 'r-pico-rgb1-g', pinName: '1' },
        color: '#22cc22',
      },
      {
        id: 'w-r-pico-rgb1-g',
        start: { componentId: 'r-pico-rgb1-g', pinName: '2' },
        end: { componentId: 'pico-rgb1', pinName: 'G' },
        color: '#e74c3c',
      },
      {
        id: 'pr-b',
        start: { componentId: 'arduino-uno', pinName: 'GP8' },
        end: { componentId: 'r-pico-rgb1-b', pinName: '1' },
        color: '#2244ff',
      },
      {
        id: 'w-r-pico-rgb1-b',
        start: { componentId: 'r-pico-rgb1-b', pinName: '2' },
        end: { componentId: 'pico-rgb1', pinName: 'B' },
        color: '#e74c3c',
      },
      {
        id: 'pr-gnd',
        start: { componentId: 'pico-rgb1', pinName: 'COM' },
        end: { componentId: 'arduino-uno', pinName: 'GND.1' },
        color: '#000000',
      },
    ],
  },

  // ─── Arduino Uno — Sensor Examples ───────────────────────────────────────
  {
    id: 'uno-dht22',
    title: 'Uno: DHT22 Temperature & Humidity',
    description: 'Read temperature and humidity using a DHT22 sensor on pin 7.',
    libraries: ['DHT sensor library'],
    category: 'sensors',
    difficulty: 'beginner',
    boardFilter: 'arduino-uno',
    code: `// Arduino Uno — DHT22 Temperature & Humidity Sensor
// Requires: Adafruit DHT sensor library (install via Library Manager)
// Wiring: DATA → pin 7  |  VCC → 5V  |  GND → GND

#include <DHT.h>

#define DHT_PIN  7
#define DHT_TYPE DHT22

DHT dht(DHT_PIN, DHT_TYPE);

void setup() {
  Serial.begin(9600);
  dht.begin();
  Serial.println("DHT22 Sensor ready!");
}

void loop() {
  delay(2000);
  float humidity = dht.readHumidity();
  float tempC    = dht.readTemperature();
  float tempF    = dht.readTemperature(true);

  if (isnan(humidity) || isnan(tempC)) {
    Serial.println("ERROR: Failed to read from DHT22!");
    return;
  }

  Serial.print("Humidity   : "); Serial.print(humidity, 1); Serial.println(" %");
  Serial.print("Temperature: "); Serial.print(tempC, 1);  Serial.print(" C  /  ");
  Serial.print(tempF, 1); Serial.println(" F");
  float heatIdx = dht.computeHeatIndex(tempF, humidity);
  Serial.print("Heat Index : "); Serial.print(heatIdx, 1); Serial.println(" F");
  Serial.println("---");
}`,
    components: [
      {
        type: 'wokwi-dht22',
        id: 'uno-dht1',
        x: 430,
        y: 150,
        properties: { temperature: '25', humidity: '60' },
      },
    ],
    wires: [
      {
        id: 'ud-vcc',
        start: { componentId: 'arduino-uno', pinName: '5V' },
        end: { componentId: 'uno-dht1', pinName: 'VCC' },
        color: '#ff0000',
      },
      {
        id: 'ud-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND' },
        end: { componentId: 'uno-dht1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'ud-sda',
        start: { componentId: 'arduino-uno', pinName: '7' },
        end: { componentId: 'uno-dht1', pinName: 'SDA' },
        color: '#22aaff',
      },
    ],
  },
  {
    id: 'uno-hcsr04',
    title: 'Uno: HC-SR04 Ultrasonic Distance',
    description:
      'Measure distance with an HC-SR04 ultrasonic sensor. TRIG on pin 9, ECHO on pin 10.',
    category: 'sensors',
    difficulty: 'beginner',
    boardFilter: 'arduino-uno',
    code: `// Arduino Uno — HC-SR04 Ultrasonic Distance Sensor
// Wiring: TRIG → pin 9  |  ECHO → pin 10  |  VCC → 5V  |  GND → GND

#define TRIG_PIN 9
#define ECHO_PIN 10

void setup() {
  Serial.begin(9600);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  Serial.println("HC-SR04 Ultrasonic Sensor ready");
}

long measureCm() {
  // Send 10 µs trigger pulse
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  // Read echo duration (30 ms timeout ≈ 5 m max)
  long duration = pulseIn(ECHO_PIN, HIGH, 30000UL);
  return (duration == 0) ? -1 : (long)(duration * 0.0343 / 2.0);
}

void loop() {
  long cm = measureCm();
  if (cm < 0) {
    Serial.println("Out of range (> 4 m)");
  } else {
    Serial.print("Distance: "); Serial.print(cm); Serial.println(" cm");
  }
  delay(500);
}`,
    components: [
      { type: 'wokwi-hc-sr04', id: 'uno-sr1', x: 420, y: 150, properties: { distance: '30' } },
    ],
    wires: [
      {
        id: 'us-vcc',
        start: { componentId: 'arduino-uno', pinName: '5V' },
        end: { componentId: 'uno-sr1', pinName: 'VCC' },
        color: '#ff0000',
      },
      {
        id: 'us-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND' },
        end: { componentId: 'uno-sr1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'us-trig',
        start: { componentId: 'arduino-uno', pinName: '9' },
        end: { componentId: 'uno-sr1', pinName: 'TRIG' },
        color: '#ff8800',
      },
      {
        id: 'us-echo',
        start: { componentId: 'arduino-uno', pinName: '10' },
        end: { componentId: 'uno-sr1', pinName: 'ECHO' },
        color: '#22cc22',
      },
    ],
  },
  {
    id: 'uno-pir',
    title: 'Uno: PIR Motion Detector',
    description:
      'Detect movement with a PIR infrared sensor on pin 4. The built-in LED on pin 13 lights up when motion is detected.',
    category: 'sensors',
    difficulty: 'beginner',
    boardFilter: 'arduino-uno',
    code: `// Arduino Uno — PIR Passive Infrared Motion Sensor
// Wiring: OUT → pin 4  |  VCC → 5V  |  GND → GND

#define PIR_PIN 4
#define LED_PIN 13  // built-in LED

bool prevMotion = false;

void setup() {
  Serial.begin(9600);
  pinMode(PIR_PIN, INPUT);
  pinMode(LED_PIN, OUTPUT);
  Serial.println("PIR Motion Sensor ready — waiting for motion...");
  delay(2000); // sensor warm-up
}

void loop() {
  bool motion = (digitalRead(PIR_PIN) == HIGH);
  if (motion && !prevMotion) {
    Serial.println(">>> MOTION DETECTED! <<<");
    digitalWrite(LED_PIN, HIGH);
  } else if (!motion && prevMotion) {
    Serial.println("No motion.");
    digitalWrite(LED_PIN, LOW);
  }
  prevMotion = motion;
  delay(200);
}`,
    components: [
      { type: 'wokwi-pir-motion-sensor', id: 'uno-pir1', x: 430, y: 150, properties: {} },
    ],
    wires: [
      {
        id: 'pir-vcc',
        start: { componentId: 'arduino-uno', pinName: '5V' },
        end: { componentId: 'uno-pir1', pinName: 'VCC' },
        color: '#ff0000',
      },
      {
        id: 'pir-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND' },
        end: { componentId: 'uno-pir1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'pir-out',
        start: { componentId: 'arduino-uno', pinName: '4' },
        end: { componentId: 'uno-pir1', pinName: 'OUT' },
        color: '#ffcc00',
      },
    ],
  },
  {
    id: 'uno-servo',
    title: 'Uno: Servo Motor Sweep',
    description:
      'Sweep a servo motor smoothly from 0° to 180° and back using pin 9 (PWM). Uses the built-in Servo library.',
    category: 'robotics',
    difficulty: 'beginner',
    boardFilter: 'arduino-uno',
    libraries: ['Servo'],
    code: `// Arduino Uno — Servo Motor Sweep
// Wiring: PWM → pin 9  |  V+ → 5V  |  GND → GND
// Uses the built-in Servo library (no install needed)

#include <Servo.h>

#define SERVO_PIN 9

Servo myServo;

void setup() {
  myServo.attach(SERVO_PIN);
  Serial.begin(9600);
  Serial.println("Servo Sweep demo");
}

void loop() {
  // Sweep 0 → 180
  for (int angle = 0; angle <= 180; angle += 2) {
    myServo.write(angle);
    delay(15);
  }
  Serial.println("180 deg reached");
  delay(400);

  // Sweep 180 → 0
  for (int angle = 180; angle >= 0; angle -= 2) {
    myServo.write(angle);
    delay(15);
  }
  Serial.println("0 deg reached");
  delay(400);
}`,
    components: [{ type: 'wokwi-servo', id: 'uno-sv1', x: 420, y: 150, properties: {} }],
    wires: [
      {
        id: 'sv-vcc',
        start: { componentId: 'arduino-uno', pinName: '5V' },
        end: { componentId: 'uno-sv1', pinName: 'V+' },
        color: '#ff0000',
      },
      {
        id: 'sv-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND' },
        end: { componentId: 'uno-sv1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'sv-pwm',
        start: { componentId: 'arduino-uno', pinName: '9' },
        end: { componentId: 'uno-sv1', pinName: 'PWM' },
        color: '#ff8800',
      },
    ],
  },
  {
    id: 'uno-photoresistor',
    title: 'Uno: Photoresistor Light Sensor',
    description:
      'Read analog light level from a photoresistor module on A0. An LED on pin 9 dims proportionally to compensate for darkness.',
    category: 'sensors',
    difficulty: 'beginner',
    boardFilter: 'arduino-uno',
    code: `// Arduino Uno — Photoresistor Light Sensor + PWM LED
// Sensor : AO → A0  |  VCC → 5V  |  GND → GND
// LED    : pin 9 (PWM), current-limiting resistor 220 Ω

#define PHOTO_PIN A0
#define LED_PIN   9

void setup() {
  Serial.begin(9600);
  pinMode(LED_PIN, OUTPUT);
  Serial.println("Photoresistor demo — try covering the sensor!");
}

void loop() {
  int raw     = analogRead(PHOTO_PIN);          // 0–1023
  int percent = map(raw, 0, 1023, 0, 100);
  // Invert: brighter environment → lower LED brightness
  int ledPWM  = map(raw, 0, 1023, 255, 0);
  analogWrite(LED_PIN, ledPWM);

  Serial.print("Light: "); Serial.print(percent);
  Serial.print("%  ADC="); Serial.print(raw);
  Serial.print("  LED="); Serial.println(ledPWM);
  delay(200);
}`,
    components: [
      { type: 'wokwi-photoresistor-sensor', id: 'uno-photo1', x: 430, y: 140, properties: {} },
      { type: 'wokwi-led', id: 'uno-photo-led', x: 430, y: 280, properties: { color: 'yellow' } },
      {
        type: 'wokwi-resistor',
        id: 'uno-photo-r',
        x: 430,
        y: 340,
        properties: { value: '220' },
      },
    ],
    wires: [
      {
        id: 'ph-vcc',
        start: { componentId: 'arduino-uno', pinName: '5V' },
        end: { componentId: 'uno-photo1', pinName: 'VCC' },
        color: '#ff0000',
      },
      {
        id: 'ph-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND' },
        end: { componentId: 'uno-photo1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'ph-ao',
        start: { componentId: 'arduino-uno', pinName: 'A0' },
        end: { componentId: 'uno-photo1', pinName: 'AO' },
        color: '#aa44ff',
      },
      {
        id: 'ph-led-a',
        start: { componentId: 'arduino-uno', pinName: '9' },
        end: { componentId: 'uno-photo-led', pinName: 'A' },
        color: '#ffcc00',
      },
      {
        id: 'ph-led-c',
        start: { componentId: 'uno-photo-led', pinName: 'C' },
        end: { componentId: 'uno-photo-r', pinName: '1' },
        color: '#888888',
      },
      {
        id: 'ph-r-gnd',
        start: { componentId: 'uno-photo-r', pinName: '2' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'uno-ntc',
    title: 'Uno: NTC Thermistor Temperature',
    description:
      'Calculate temperature from an NTC 10k thermistor sensor on A1 using the Steinhart–Hart equation.',
    category: 'sensors',
    difficulty: 'intermediate',
    boardFilter: 'arduino-uno',
    code: `// Arduino Uno — NTC Thermistor Temperature Sensor
// Wiring: OUT → A1  |  VCC → 5V  |  GND → GND

#define NTC_PIN A1

// Thermistor parameters for a 10 kΩ NTC (B = 3950)
const float VCC         = 5.0;
const float SERIES_R    = 10000.0;  // series resistor (10 kΩ)
const float NOM_R       = 10000.0;  // nominal resistance at 25 °C
const float B_COEFF     = 3950.0;   // Beta coefficient
const float NOM_TEMP_K  = 298.15;   // 25 °C in Kelvin

float readTempC() {
  int   raw  = analogRead(NTC_PIN);
  float v    = raw * (VCC / 1023.0);
  // Divider modelled by Velxio's ntc-temperature-sensor:
  //   VCC → R_pull (10k) → A1 → R_NTC → GND.
  // Higher temperature → R_NTC drops → V FALLS, so
  //   r = R_pull * v / (VCC - v)
  float r    = SERIES_R * v / (VCC - v);
  // Steinhart–Hart simplified equation
  float st   = log(r / NOM_R) / B_COEFF + 1.0 / NOM_TEMP_K;
  return (1.0 / st) - 273.15;
}

void setup() {
  Serial.begin(9600);
  Serial.println("NTC Thermistor Temperature Sensor");
}

void loop() {
  float tc = readTempC();
  float tf = tc * 9.0 / 5.0 + 32.0;
  Serial.print("Temperature: ");
  Serial.print(tc, 2); Serial.print(" C  /  ");
  Serial.print(tf, 2); Serial.println(" F");
  delay(1000);
}`,
    components: [
      {
        type: 'wokwi-ntc-temperature-sensor',
        id: 'uno-ntc1',
        x: 430,
        y: 150,
        properties: { temperature: '25' },
      },
    ],
    wires: [
      {
        id: 'ntc-vcc',
        start: { componentId: 'arduino-uno', pinName: '5V' },
        end: { componentId: 'uno-ntc1', pinName: 'VCC' },
        color: '#ff0000',
      },
      {
        id: 'ntc-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND' },
        end: { componentId: 'uno-ntc1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'ntc-out',
        start: { componentId: 'arduino-uno', pinName: 'A1' },
        end: { componentId: 'uno-ntc1', pinName: 'OUT' },
        color: '#aa44ff',
      },
    ],
  },

  // ─── Raspberry Pi Pico — Sensor Examples ─────────────────────────────────
  {
    id: 'pico-dht22',
    title: 'Pico: DHT22 Temperature & Humidity',
    description:
      'Read temperature and humidity from a DHT22 sensor on GP7 using the Raspberry Pi Pico.',
    libraries: ['DHT sensor library'],
    category: 'sensors',
    difficulty: 'beginner',
    boardType: 'raspberry-pi-pico',
    boardFilter: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — DHT22 Temperature & Humidity
// Requires: Adafruit DHT sensor library (install via Library Manager)
// Wiring: DATA → GP7  |  VCC → 3.3V  |  GND → GND

#include <DHT.h>

#define DHT_PIN  7   // GPIO 7
#define DHT_TYPE DHT22

DHT dht(DHT_PIN, DHT_TYPE);

void setup() {
  Serial.begin(115200);
  dht.begin();
  delay(1000);
  Serial.println("Pico DHT22 ready!");
}

void loop() {
  delay(2000);
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (isnan(h) || isnan(t)) {
    Serial.println("DHT22 read error!");
    return;
  }
  Serial.print("Temp: "); Serial.print(t, 1); Serial.print(" C   ");
  Serial.print("Humidity: "); Serial.print(h, 1); Serial.println(" %");
}`,
    components: [
      {
        type: 'wokwi-dht22',
        id: 'pico-dht1',
        x: 430,
        y: 150,
        properties: { temperature: '22', humidity: '55' },
      },
    ],
    wires: [
      {
        id: 'pcd-vcc',
        start: { componentId: 'arduino-uno', pinName: '3.3V' },
        end: { componentId: 'pico-dht1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'pcd-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND.1' },
        end: { componentId: 'pico-dht1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'pcd-sda',
        start: { componentId: 'arduino-uno', pinName: 'GP7' },
        end: { componentId: 'pico-dht1', pinName: 'SDA' },
        color: '#22aaff',
      },
    ],
  },
  {
    id: 'pico-hcsr04',
    title: 'Pico: HC-SR04 Ultrasonic Distance',
    description:
      'Measure distance with an HC-SR04 sensor on the Raspberry Pi Pico. TRIG on D5 (GP17), ECHO on D6 (GP18).',
    category: 'sensors',
    difficulty: 'beginner',
    boardType: 'raspberry-pi-pico',
    boardFilter: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — HC-SR04 Ultrasonic Distance Sensor
// Wiring: TRIG → D5(GP17)  |  ECHO → D6(GP18)  |  VCC → 3.3V  |  GND → GND

#define TRIG_PIN 17  // GPIO 17 (D5)
#define ECHO_PIN 18  // GPIO 18 (D6)

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  Serial.println("Pico HC-SR04 ready");
}

long measureCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long d = pulseIn(ECHO_PIN, HIGH, 30000UL);
  return (d == 0) ? -1 : (long)(d * 0.0343 / 2.0);
}

void loop() {
  long cm = measureCm();
  if (cm < 0) {
    Serial.println("Out of range");
  } else {
    Serial.print("Distance: "); Serial.print(cm); Serial.println(" cm");
  }
  delay(500);
}`,
    components: [
      { type: 'wokwi-hc-sr04', id: 'pico-sr1', x: 420, y: 150, properties: { distance: '25' } },
    ],
    wires: [
      {
        id: 'pcs-vcc',
        start: { componentId: 'arduino-uno', pinName: '3.3V' },
        end: { componentId: 'pico-sr1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'pcs-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND.1' },
        end: { componentId: 'pico-sr1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'pcs-trig',
        start: { componentId: 'arduino-uno', pinName: 'GP5' },
        end: { componentId: 'pico-sr1', pinName: 'TRIG' },
        color: '#ff8800',
      },
      {
        id: 'pcs-echo',
        start: { componentId: 'arduino-uno', pinName: 'GP6' },
        end: { componentId: 'pico-sr1', pinName: 'ECHO' },
        color: '#22cc22',
      },
    ],
  },
  {
    id: 'pico-pir',
    title: 'Pico: PIR Motion Detector',
    description:
      'Detect movement with a PIR sensor on D4 (GP16). The built-in LED (GP25) activates when motion is detected.',
    category: 'sensors',
    difficulty: 'beginner',
    boardType: 'raspberry-pi-pico',
    boardFilter: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — PIR Motion Sensor
// Wiring: OUT → D4(GP16)  |  VCC → 3.3V  |  GND → GND

#define PIR_PIN 16  // GPIO 16 (D4)
#define LED_PIN 25  // on-board LED (LED_BUILTIN on Pico)

bool prevMotion = false;

void setup() {
  Serial.begin(115200);
  pinMode(PIR_PIN, INPUT);
  pinMode(LED_PIN, OUTPUT);
  Serial.println("Pico PIR Motion Sensor — warming up...");
  delay(2000);
  Serial.println("Ready!");
}

void loop() {
  bool motion = (digitalRead(PIR_PIN) == HIGH);
  if (motion && !prevMotion) {
    Serial.println(">>> MOTION DETECTED! <<<");
    digitalWrite(LED_PIN, HIGH);
  } else if (!motion && prevMotion) {
    Serial.println("Calm.");
    digitalWrite(LED_PIN, LOW);
  }
  prevMotion = motion;
  delay(100);
}`,
    components: [
      { type: 'wokwi-pir-motion-sensor', id: 'pico-pir1', x: 430, y: 150, properties: {} },
    ],
    wires: [
      {
        id: 'pp-vcc',
        start: { componentId: 'arduino-uno', pinName: '3.3V' },
        end: { componentId: 'pico-pir1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'pp-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND.1' },
        end: { componentId: 'pico-pir1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'pp-out',
        start: { componentId: 'arduino-uno', pinName: 'GP4' },
        end: { componentId: 'pico-pir1', pinName: 'OUT' },
        color: '#ffcc00',
      },
    ],
  },
  {
    id: 'pico-servo',
    title: 'Pico: Servo Motor Sweep',
    description:
      'Sweep a servo motor from 0° to 180° and back on the Raspberry Pi Pico using D3 / GP15 (PWM).',
    category: 'robotics',
    difficulty: 'beginner',
    boardType: 'raspberry-pi-pico',
    boardFilter: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — Servo Motor Sweep
// Wiring: PWM → D3(GP15)  |  V+ → 3.3V  |  GND → GND
// Uses built-in Servo library

#include <Servo.h>

#define SERVO_PIN 15  // GPIO 15 (D3)

Servo myServo;

void setup() {
  myServo.attach(SERVO_PIN);
  Serial.begin(115200);
  Serial.println("Pico Servo Sweep");
}

void loop() {
  for (int a = 0; a <= 180; a += 3) { myServo.write(a); delay(20); }
  Serial.println("180°"); delay(300);
  for (int a = 180; a >= 0; a -= 3) { myServo.write(a); delay(20); }
  Serial.println("0°");   delay(300);
}`,
    components: [{ type: 'wokwi-servo', id: 'pico-sv1', x: 420, y: 150, properties: {} }],
    wires: [
      {
        id: 'psv-vcc',
        start: { componentId: 'arduino-uno', pinName: '3.3V' },
        end: { componentId: 'pico-sv1', pinName: 'V+' },
        color: '#ff4444',
      },
      {
        id: 'psv-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND.1' },
        end: { componentId: 'pico-sv1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'psv-pwm',
        start: { componentId: 'arduino-uno', pinName: 'GP3' },
        end: { componentId: 'pico-sv1', pinName: 'PWM' },
        color: '#ff8800',
      },
    ],
  },
  {
    id: 'pico-ntc',
    title: 'Pico: NTC Thermistor Temperature',
    description:
      'Read temperature from an NTC 10k thermistor on the Pico ADC pin A0 (GP26) using the Steinhart–Hart equation.',
    category: 'sensors',
    difficulty: 'intermediate',
    boardType: 'raspberry-pi-pico',
    boardFilter: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — NTC Thermistor Temperature Sensor
// Wiring: OUT → A0 (GP26)  |  VCC → 3.3V  |  GND → GND

#define NTC_PIN A0  // GP26 on Pico

const float VCC        = 3.3;
const float SERIES_R   = 10000.0;
const float NOM_R      = 10000.0;
const float B_COEFF    = 3950.0;
const float NOM_TEMP_K = 298.15; // 25 °C

float readTempC() {
  int   raw = analogRead(NTC_PIN);
  float v   = raw * (VCC / 1023.0);
  // VCC → R_pull → A1 → R_NTC → GND (the divider Velxio models)
  float r   = SERIES_R * v / (VCC - v);
  float st  = log(r / NOM_R) / B_COEFF + 1.0 / NOM_TEMP_K;
  return (1.0 / st) - 273.15;
}

void setup() {
  Serial.begin(115200);
  analogReadResolution(10);
  Serial.println("Pico NTC Temperature Sensor");
}

void loop() {
  float tc = readTempC();
  Serial.print("Temperature: "); Serial.print(tc, 2); Serial.println(" C");
  delay(1000);
}`,
    components: [
      {
        type: 'wokwi-ntc-temperature-sensor',
        id: 'pico-ntc1',
        x: 430,
        y: 150,
        properties: { temperature: '25' },
      },
    ],
    wires: [
      {
        id: 'pnt-vcc',
        start: { componentId: 'arduino-uno', pinName: '3.3V' },
        end: { componentId: 'pico-ntc1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'pnt-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND.1' },
        end: { componentId: 'pico-ntc1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'pnt-out',
        start: { componentId: 'arduino-uno', pinName: 'A0' },
        end: { componentId: 'pico-ntc1', pinName: 'OUT' },
        color: '#aa44ff',
      },
    ],
  },
  {
    id: 'pico-joystick',
    title: 'Pico: Analog Joystick',
    description:
      'Read X/Y axes and button press from an analog joystick. VERT on A0 (GP26), HORZ on A1 (GP27), SEL button on D4 (GP16).',
    category: 'sensors',
    difficulty: 'beginner',
    boardType: 'raspberry-pi-pico',
    boardFilter: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — Analog Joystick
// Wiring: VERT → A0(GP26)  |  HORZ → A1(GP27)  |  SEL → D4(GP16)
//         VCC → 3.3V  |  GND → GND

#define JOY_VERT A0   // GP26
#define JOY_HORZ A1   // GP27
#define JOY_BTN  16   // GP16 (D4)

void setup() {
  Serial.begin(115200);
  pinMode(JOY_BTN, INPUT_PULLUP);
  analogReadResolution(10);
  Serial.println("Pico Analog Joystick ready");
}

void loop() {
  int x   = analogRead(JOY_HORZ); // 0–1023
  int y   = analogRead(JOY_VERT); // 0–1023
  bool btn = (digitalRead(JOY_BTN) == LOW);

  // Map to -100..+100
  int xP = map(x, 0, 1023, -100, 100);
  int yP = map(y, 0, 1023, -100, 100);

  Serial.print("X="); Serial.print(xP);
  Serial.print("  Y="); Serial.print(yP);
  Serial.print("  BTN="); Serial.println(btn ? "PRESSED" : "---");
  delay(150);
}`,
    components: [
      { type: 'wokwi-analog-joystick', id: 'pico-joy1', x: 420, y: 140, properties: {} },
    ],
    wires: [
      {
        id: 'pj-vcc',
        start: { componentId: 'arduino-uno', pinName: '3.3V' },
        end: { componentId: 'pico-joy1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'pj-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND.1' },
        end: { componentId: 'pico-joy1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'pj-vert',
        start: { componentId: 'arduino-uno', pinName: 'A0' },
        end: { componentId: 'pico-joy1', pinName: 'VERT' },
        color: '#22aaff',
      },
      {
        id: 'pj-horz',
        start: { componentId: 'arduino-uno', pinName: 'A1' },
        end: { componentId: 'pico-joy1', pinName: 'HORZ' },
        color: '#22cc44',
      },
      {
        id: 'pj-sel',
        start: { componentId: 'arduino-uno', pinName: 'GP4' },
        end: { componentId: 'pico-joy1', pinName: 'SEL' },
        color: '#aa44ff',
      },
    ],
  },

  // ─── ESP32 — Sensor Examples ──────────────────────────────────────────────
  {
    id: 'esp32-dht22',
    title: 'ESP32: DHT22 Temperature & Humidity',
    description: 'Read temperature and humidity from a DHT22 sensor on GPIO4 of the ESP32.',
    libraries: ['DHT sensor library', 'Adafruit Unified Sensor'],
    category: 'sensors',
    difficulty: 'beginner',
    boardType: 'esp32',
    boardFilter: 'esp32',
    code: `// ESP32 — DHT22 Temperature & Humidity Sensor
// Requires: Adafruit DHT sensor library
// Wiring: DATA → GPIO4  |  VCC → 3V3  |  GND → GND

#include <DHT.h>

#define DHT_PIN  4    // GPIO 4
#define DHT_TYPE DHT22

DHT dht(DHT_PIN, DHT_TYPE);


void setup() {
  Serial.begin(115200);
  dht.begin();
  delay(2000);
  Serial.println("ESP32 DHT22 ready!");
}

void loop() {
  delay(2000);

  float h = dht.readHumidity();
  float t = dht.readTemperature();

  if (isnan(h) || isnan(t)) {
    Serial.println("DHT22: waiting for sensor...");
    return;
  }
  Serial.printf("Temp: %.1f C   Humidity: %.1f %%\\n", t, h);
}`,
    components: [
      {
        type: 'wokwi-dht22',
        id: 'e32-dht1',
        x: 430,
        y: 150,
        properties: { temperature: '28', humidity: '65' },
      },
    ],
    wires: [
      {
        id: 'e32d-vcc',
        start: { componentId: 'arduino-uno', pinName: '3V3' },
        end: { componentId: 'e32-dht1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'e32d-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND' },
        end: { componentId: 'e32-dht1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'e32d-sda',
        start: { componentId: 'arduino-uno', pinName: '4' },
        end: { componentId: 'e32-dht1', pinName: 'SDA' },
        color: '#22aaff',
      },
    ],
  },
  {
    id: 'esp32-hcsr04',
    title: 'ESP32: HC-SR04 Ultrasonic Distance',
    description:
      'Measure distance with an HC-SR04 sensor on ESP32. TRIG on GPIO18, ECHO on GPIO19.',
    category: 'sensors',
    difficulty: 'beginner',
    boardType: 'esp32',
    boardFilter: 'esp32',
    code: `// ESP32 — HC-SR04 Ultrasonic Distance Sensor
// Wiring: TRIG → D18  |  ECHO → D19  |  VCC → 3V3  |  GND → GND


#define TRIG_PIN 18
#define ECHO_PIN 19


void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  Serial.println("ESP32 HC-SR04 ready");
}

long measureCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long d = pulseIn(ECHO_PIN, HIGH, 30000UL);
  return (d == 0) ? -1 : (long)(d * 0.0343 / 2.0);
}

void loop() {
  long cm = measureCm();
  if (cm < 0) Serial.println("Out of range");
  else        Serial.printf("Distance: %ld cm\\n", cm);
  delay(500);
}`,
    components: [
      { type: 'wokwi-hc-sr04', id: 'e32-sr1', x: 420, y: 150, properties: { distance: '40' } },
    ],
    wires: [
      {
        id: 'e32s-vcc',
        start: { componentId: 'arduino-uno', pinName: '3V3' },
        end: { componentId: 'e32-sr1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'e32s-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND' },
        end: { componentId: 'e32-sr1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'e32s-trig',
        start: { componentId: 'arduino-uno', pinName: '18' },
        end: { componentId: 'e32-sr1', pinName: 'TRIG' },
        color: '#ff8800',
      },
      {
        id: 'e32s-echo',
        start: { componentId: 'arduino-uno', pinName: '19' },
        end: { componentId: 'e32-sr1', pinName: 'ECHO' },
        color: '#22cc22',
      },
    ],
  },
  {
    id: 'esp32-mpu6050',
    title: 'ESP32: MPU-6050 Accelerometer',
    description:
      'Read 3-axis acceleration and gyroscope data from an MPU-6050 over I2C (SDA=D21, SCL=D22).',
    libraries: ['Adafruit MPU6050', 'Adafruit Unified Sensor', 'Adafruit BusIO'],
    category: 'sensors',
    difficulty: 'intermediate',
    boardType: 'esp32',
    boardFilter: 'esp32',
    code: `// ESP32 — MPU-6050 Accelerometer & Gyroscope (I2C)
// Requires: Adafruit MPU6050, Adafruit Unified Sensor libraries
// Wiring: SDA → D21  |  SCL → D22  |  VCC → 3V3  |  GND → GND

#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Wire.h>

Adafruit_MPU6050 mpu;


void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22); // SDA=21, SCL=22
  if (!mpu.begin()) {
    Serial.println("MPU6050 not found! Check wiring.");
    while (true) delay(10);
  }
  mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  Serial.println("MPU6050 ready!");
}

void loop() {
  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);

  Serial.printf("Accel X=%.2f Y=%.2f Z=%.2f m/s²\\n",
    a.acceleration.x, a.acceleration.y, a.acceleration.z);
  Serial.printf("Gyro  X=%.2f Y=%.2f Z=%.2f rad/s\\n",
    g.gyro.x, g.gyro.y, g.gyro.z);
  Serial.printf("Temp: %.1f C\\n---\\n", temp.temperature);
  delay(500);
}`,
    components: [{ type: 'wokwi-mpu6050', id: 'e32-mpu1', x: 420, y: 150, properties: {} }],
    wires: [
      {
        id: 'e32m-vcc',
        start: { componentId: 'arduino-uno', pinName: '3V3' },
        end: { componentId: 'e32-mpu1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'e32m-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND' },
        end: { componentId: 'e32-mpu1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'e32m-sda',
        start: { componentId: 'arduino-uno', pinName: '21' },
        end: { componentId: 'e32-mpu1', pinName: 'SDA' },
        color: '#22aaff',
      },
      {
        id: 'e32m-scl',
        start: { componentId: 'arduino-uno', pinName: '22' },
        end: { componentId: 'e32-mpu1', pinName: 'SCL' },
        color: '#ff8800',
      },
    ],
  },
  {
    id: 'esp32-pir',
    title: 'ESP32: PIR Motion Detector',
    description:
      'Detect motion with a PIR sensor on GPIO5 of the ESP32. Logs events to Serial with timestamps.',
    category: 'sensors',
    difficulty: 'beginner',
    boardType: 'esp32',
    boardFilter: 'esp32',
    code: `// ESP32 — PIR Motion Sensor
// Wiring: OUT → D5  |  VCC → 3V3  |  GND → GND


#define PIR_PIN 5
#define LED_PIN 2   // built-in blue LED on ESP32 DevKit

bool prevMotion = false;
unsigned long detections = 0;


void setup() {
  Serial.begin(115200);
  pinMode(PIR_PIN, INPUT);
  pinMode(LED_PIN, OUTPUT);
  Serial.println("ESP32 PIR Motion Sensor");
  delay(2000); // warm-up
  Serial.println("Ready!");
}

void loop() {
  bool motion = (digitalRead(PIR_PIN) == HIGH);
  if (motion && !prevMotion) {
    detections++;
    Serial.printf("[%lu ms] Motion detected! (count: %lu)\\n",
                  millis(), detections);
    digitalWrite(LED_PIN, HIGH);
  } else if (!motion && prevMotion) {
    Serial.println("No motion.");
    digitalWrite(LED_PIN, LOW);
  }
  prevMotion = motion;
  delay(100);
}`,
    components: [
      { type: 'wokwi-pir-motion-sensor', id: 'e32-pir1', x: 430, y: 150, properties: {} },
    ],
    wires: [
      {
        id: 'e32p-vcc',
        start: { componentId: 'arduino-uno', pinName: '3V3' },
        end: { componentId: 'e32-pir1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'e32p-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND' },
        end: { componentId: 'e32-pir1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'e32p-out',
        start: { componentId: 'arduino-uno', pinName: '5' },
        end: { componentId: 'e32-pir1', pinName: 'OUT' },
        color: '#ffcc00',
      },
    ],
  },
  {
    id: 'esp32-servo',
    title: 'ESP32: Servo Motor + Potentiometer',
    description:
      'Control a servo motor angle directly with a potentiometer. The servo follows the pot position in real time.',
    libraries: ['ESP32Servo'],
    category: 'robotics',
    difficulty: 'beginner',
    boardType: 'esp32',
    boardFilter: 'esp32',
    code: `// ESP32 — Servo controlled by Potentiometer
// Servo: PWM → D13  |  V+ → 3V3  |  GND → GND
// Pot  : SIG → D34  |  VCC → 3V3  |  GND → GND

#include <ESP32Servo.h>

#define SERVO_PIN 13
#define POT_PIN   34  // input-only GPIO (ADC)

Servo myServo;


void setup() {
  Serial.begin(115200);
  myServo.attach(SERVO_PIN, 500, 2400); // standard servo pulse range
  Serial.println("ESP32 Servo + Pot control");
}

void loop() {
  int raw   = analogRead(POT_PIN);         // 0–4095 (12-bit ADC)
  int angle = map(raw, 0, 4095, 0, 180);
  myServo.write(angle);
  Serial.printf("Pot: %4d  Angle: %3d deg\\n", raw, angle);
  delay(20);
}`,
    components: [
      { type: 'wokwi-servo', id: 'e32-sv1', x: 420, y: 140, properties: {} },
      { type: 'wokwi-potentiometer', id: 'e32-pot1', x: 420, y: 280, properties: {} },
    ],
    wires: [
      {
        id: 'e32sv-vcc',
        start: { componentId: 'arduino-uno', pinName: '3V3' },
        end: { componentId: 'e32-sv1', pinName: 'V+' },
        color: '#ff4444',
      },
      {
        id: 'e32sv-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND' },
        end: { componentId: 'e32-sv1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'e32sv-pwm',
        start: { componentId: 'arduino-uno', pinName: '13' },
        end: { componentId: 'e32-sv1', pinName: 'PWM' },
        color: '#ff8800',
      },
      {
        id: 'e32pt-vcc',
        start: { componentId: 'arduino-uno', pinName: '3V3' },
        end: { componentId: 'e32-pot1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'e32pt-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND2' },
        end: { componentId: 'e32-pot1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'e32pt-sig',
        start: { componentId: 'arduino-uno', pinName: '34' },
        end: { componentId: 'e32-pot1', pinName: 'SIG' },
        color: '#aa44ff',
      },
    ],
  },
  {
    id: 'esp32-joystick',
    title: 'ESP32: Analog Joystick',
    description:
      'Read X/Y axes and button click from an analog joystick on the ESP32. X on D35, Y on D34, button on GPIO15.',
    category: 'sensors',
    difficulty: 'beginner',
    boardType: 'esp32',
    boardFilter: 'esp32',
    code: `// ESP32 — Analog Joystick
// Wiring: HORZ → D35 | VERT → D34 | SEL → D15
//         VCC → 3V3  | GND → GND


#define JOY_HORZ 35  // input-only ADC pin
#define JOY_VERT 34  // input-only ADC pin
#define JOY_BTN  15  // GPIO with pull-up


void setup() {
  Serial.begin(115200);
  pinMode(JOY_BTN, INPUT_PULLUP);
  Serial.println("ESP32 Joystick ready");
}

void loop() {
  int x    = analogRead(JOY_HORZ); // 0–4095
  int y    = analogRead(JOY_VERT); // 0–4095
  bool btn = (digitalRead(JOY_BTN) == LOW);

  int xPct = map(x, 0, 4095, -100, 100);
  int yPct = map(y, 0, 4095, -100, 100);

  Serial.printf("X=%4d(%4d%%) Y=%4d(%4d%%) BTN=%s\\n",
    x, xPct, y, yPct, btn ? "PRESSED" : "---");
  delay(100);
}`,
    components: [{ type: 'wokwi-analog-joystick', id: 'e32-joy1', x: 420, y: 140, properties: {} }],
    wires: [
      {
        id: 'e32j-vcc',
        start: { componentId: 'arduino-uno', pinName: '3V3' },
        end: { componentId: 'e32-joy1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'e32j-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND' },
        end: { componentId: 'e32-joy1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'e32j-vert',
        start: { componentId: 'arduino-uno', pinName: '34' },
        end: { componentId: 'e32-joy1', pinName: 'VERT' },
        color: '#22aaff',
      },
      {
        id: 'e32j-horz',
        start: { componentId: 'arduino-uno', pinName: '35' },
        end: { componentId: 'e32-joy1', pinName: 'HORZ' },
        color: '#22cc44',
      },
      {
        id: 'e32j-sel',
        start: { componentId: 'arduino-uno', pinName: '15' },
        end: { componentId: 'e32-joy1', pinName: 'SEL' },
        color: '#aa44ff',
      },
    ],
  },

  // ─── ESP32-C3 — Sensor Examples ───────────────────────────────────────────
  {
    id: 'c3-dht22',
    title: 'ESP32-C3: DHT22 Temperature & Humidity',
    description:
      'Read temperature and humidity with a DHT22 sensor on GPIO3 of the ESP32-C3 RISC-V board.',
    libraries: ['DHT sensor library', 'Adafruit Unified Sensor'],
    category: 'sensors',
    difficulty: 'beginner',
    boardType: 'esp32-c3',
    boardFilter: 'esp32-c3',
    code: `// ESP32-C3 — DHT22 Temperature & Humidity Sensor
// Requires: Adafruit DHT sensor library
// Wiring: DATA → GPIO3  |  VCC → 3V3  |  GND → GND

#include <DHT.h>

#define DHT_PIN  3    // GPIO 3
#define DHT_TYPE DHT22

DHT dht(DHT_PIN, DHT_TYPE);


void setup() {
  Serial.begin(115200);
  dht.begin();
  delay(2000);
  Serial.println("ESP32-C3 DHT22 ready!");
}

void loop() {
  delay(2000);

  float h = dht.readHumidity();
  float t = dht.readTemperature();

  if (isnan(h) || isnan(t)) {
    Serial.println("DHT22: waiting for sensor...");
    return;
  }
  Serial.printf("Temp: %.1f C   Humidity: %.1f %%\\n", t, h);
}`,
    components: [
      {
        type: 'wokwi-dht22',
        id: 'c3-dht1',
        x: 430,
        y: 150,
        properties: { temperature: '26', humidity: '58' },
      },
    ],
    wires: [
      {
        id: 'c3d-vcc',
        start: { componentId: 'arduino-uno', pinName: '3V3' },
        end: { componentId: 'c3-dht1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'c3d-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND.9' },
        end: { componentId: 'c3-dht1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'c3d-sda',
        start: { componentId: 'arduino-uno', pinName: '3' },
        end: { componentId: 'c3-dht1', pinName: 'SDA' },
        color: '#22aaff',
      },
    ],
  },
  {
    id: 'c3-hcsr04',
    title: 'ESP32-C3: HC-SR04 Ultrasonic Distance',
    description:
      'Measure distance with an HC-SR04 sensor on the ESP32-C3. TRIG on GPIO5, ECHO on GPIO6.',
    category: 'sensors',
    difficulty: 'beginner',
    boardType: 'esp32-c3',
    boardFilter: 'esp32-c3',
    code: `// ESP32-C3 — HC-SR04 Ultrasonic Distance Sensor
// Wiring: TRIG → GPIO5  |  ECHO → GPIO6  |  VCC → 3V3  |  GND → GND

#define TRIG_PIN 5
#define ECHO_PIN 6

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  Serial.println("ESP32-C3 HC-SR04 ready");
}

long measureCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long d = pulseIn(ECHO_PIN, HIGH, 30000UL);
  return (d == 0) ? -1 : (long)(d * 0.0343 / 2.0);
}

void loop() {
  long cm = measureCm();
  if (cm < 0) Serial.println("Out of range");
  else        Serial.printf("Distance: %ld cm\\n", cm);
  delay(500);
}`,
    components: [
      { type: 'wokwi-hc-sr04', id: 'c3-sr1', x: 420, y: 150, properties: { distance: '35' } },
    ],
    wires: [
      {
        id: 'c3s-vcc',
        start: { componentId: 'arduino-uno', pinName: '3V3' },
        end: { componentId: 'c3-sr1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'c3s-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND.9' },
        end: { componentId: 'c3-sr1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'c3s-trig',
        start: { componentId: 'arduino-uno', pinName: '5' },
        end: { componentId: 'c3-sr1', pinName: 'TRIG' },
        color: '#ff8800',
      },
      {
        id: 'c3s-echo',
        start: { componentId: 'arduino-uno', pinName: '6' },
        end: { componentId: 'c3-sr1', pinName: 'ECHO' },
        color: '#22cc22',
      },
    ],
  },
  {
    id: 'c3-pir',
    title: 'ESP32-C3: PIR Motion Detector',
    description:
      'Detect motion with a PIR sensor on GPIO7 of the ESP32-C3. Prints detection events and count to Serial.',
    category: 'sensors',
    difficulty: 'beginner',
    boardType: 'esp32-c3',
    boardFilter: 'esp32-c3',
    code: `// ESP32-C3 — PIR Motion Sensor
// Wiring: OUT → GPIO7  |  VCC → 3V3  |  GND → GND

#define PIR_PIN  7
#define LED_PIN  8  // onboard LED on GPIO8

bool prevMotion = false;
unsigned long count = 0;

void setup() {
  Serial.begin(115200);
  pinMode(PIR_PIN, INPUT);
  pinMode(LED_PIN, OUTPUT);
  Serial.println("ESP32-C3 PIR Motion Sensor");
  delay(2000); // warm-up
  Serial.println("Ready!");
}

void loop() {
  bool motion = (digitalRead(PIR_PIN) == HIGH);
  if (motion && !prevMotion) {
    count++;
    Serial.printf("[%lu ms] MOTION! (count=%lu)\\n", millis(), count);
    digitalWrite(LED_PIN, HIGH);
  } else if (!motion && prevMotion) {
    Serial.println("Still.");
    digitalWrite(LED_PIN, LOW);
  }
  prevMotion = motion;
  delay(100);
}`,
    components: [
      { type: 'wokwi-pir-motion-sensor', id: 'c3-pir1', x: 430, y: 150, properties: {} },
    ],
    wires: [
      {
        id: 'c3p-vcc',
        start: { componentId: 'arduino-uno', pinName: '3V3' },
        end: { componentId: 'c3-pir1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'c3p-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND.9' },
        end: { componentId: 'c3-pir1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'c3p-out',
        start: { componentId: 'arduino-uno', pinName: '7' },
        end: { componentId: 'c3-pir1', pinName: 'OUT' },
        color: '#ffcc00',
      },
    ],
  },
  {
    id: 'c3-servo',
    title: 'ESP32-C3: Servo Motor Sweep',
    description: 'Sweep a servo motor from 0° to 180° and back on the ESP32-C3 using GPIO10 (PWM).',
    libraries: ['ESP32Servo'],
    category: 'robotics',
    difficulty: 'beginner',
    boardType: 'esp32-c3',
    boardFilter: 'esp32-c3',
    code: `// ESP32-C3 — Servo Motor Sweep
// Wiring: PWM → GPIO10  |  V+ → 3V3  |  GND → GND
// Uses ESP32Servo library

#include <ESP32Servo.h>

#define SERVO_PIN 10

Servo myServo;

void setup() {
  Serial.begin(115200);
  myServo.attach(SERVO_PIN, 500, 2400);
  Serial.println("ESP32-C3 Servo Sweep");
}

void loop() {
  for (int a = 0; a <= 180; a += 3) { myServo.write(a); delay(20); }
  Serial.println("180 deg"); delay(300);
  for (int a = 180; a >= 0; a -= 3) { myServo.write(a); delay(20); }
  Serial.println("0 deg");   delay(300);
}`,
    components: [{ type: 'wokwi-servo', id: 'c3-sv1', x: 420, y: 150, properties: {} }],
    wires: [
      {
        id: 'c3sv-vcc',
        start: { componentId: 'arduino-uno', pinName: '3V3' },
        end: { componentId: 'c3-sv1', pinName: 'V+' },
        color: '#ff4444',
      },
      {
        id: 'c3sv-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND.9' },
        end: { componentId: 'c3-sv1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'c3sv-pwm',
        start: { componentId: 'arduino-uno', pinName: '10' },
        end: { componentId: 'c3-sv1', pinName: 'PWM' },
        color: '#ff8800',
      },
    ],
  },

  // ── ESP32-C3 WiFi & Bluetooth Examples ─────────────────────────────────────

  {
    id: 'esp32c3-wifi-scan',
    title: 'ESP32-C3 WiFi Scan',
    description:
      'Scan for available WiFi networks on the ESP32-C3 (RISC-V). The emulated ESP32-C3 will find the "Velxio-GUEST" access point.',
    category: 'communication',
    difficulty: 'beginner',
    boardType: 'esp32-c3',
    boardFilter: 'esp32-c3',
    code: `#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("ESP32-C3 WiFi Scanner");
  Serial.println("=====================");

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);

  Serial.println("Scanning for networks...");
  int n = WiFi.scanNetworks();
  if (n == 0) {
    Serial.println("No networks found");
  } else {
    Serial.printf("Found %d networks:\\n", n);
    for (int i = 0; i < n; i++) {
      Serial.printf("  %d: %-20s  %d dBm  %s\\n",
        i + 1,
        WiFi.SSID(i).c_str(),
        WiFi.RSSI(i),
        WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "Open" : "Encrypted");
    }
  }
  Serial.println("\\nDone! Scan again in 10 seconds...");
}

void loop() {
  delay(10000);
  setup();  // re-scan
}
`,
    components: [],
    wires: [],
  },

  {
    id: 'esp32c3-wifi-connect',
    title: 'ESP32-C3 WiFi Connect',
    description:
      'Connect the ESP32-C3 to the virtual "Velxio-GUEST" WiFi network and print the assigned IP address. Uses channel 6 for faster connection.',
    category: 'communication',
    difficulty: 'beginner',
    boardType: 'esp32-c3',
    boardFilter: 'esp32-c3',
    code: `#include <WiFi.h>

const char* ssid = "Velxio-GUEST";

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("ESP32-C3 WiFi Connection Demo");
  Serial.println("=============================");
  Serial.printf("Connecting to %s", ssid);

  WiFi.begin(ssid, "", 6);  // channel 6, no password

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println(" Connected!");
  Serial.printf("IP Address: %s\\n", WiFi.localIP().toString().c_str());
  Serial.printf("MAC Address: %s\\n", WiFi.macAddress().c_str());
  Serial.printf("Signal Strength (RSSI): %d dBm\\n", WiFi.RSSI());
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi still connected - IP: " + WiFi.localIP().toString());
  } else {
    Serial.println("WiFi disconnected! Reconnecting...");
    WiFi.begin(ssid, "", 6);
  }
  delay(5000);
}
`,
    components: [],
    wires: [],
  },

  {
    id: 'esp32c3-http-server',
    title: 'ESP32-C3 HTTP Server',
    description:
      'Run a simple web server on the ESP32-C3. After connecting to WiFi, the server responds with an HTML page. Access it via the IoT Gateway link.',
    category: 'communication',
    difficulty: 'intermediate',
    boardType: 'esp32-c3',
    boardFilter: 'esp32-c3',
    code: `#include <WiFi.h>
#include <WebServer.h>

const char* ssid = "Velxio-GUEST";
WebServer server(80);

int requestCount = 0;

void handleRoot() {
  requestCount++;
  String html = "<!DOCTYPE html><html><head>";
  html += "<meta charset='utf-8'>";
  html += "<meta name='viewport' content='width=device-width,initial-scale=1'>";
  html += "<title>ESP32-C3 Web Server</title>";
  html += "<style>body{font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 20px;";
  html += "background:#1a1a2e;color:#e0e0e0}h1{color:#00d4ff}";
  html += ".card{background:#16213e;padding:20px;border-radius:10px;margin:10px 0}";
  html += ".stat{color:#00d4ff;font-size:1.2em}</style></head><body>";
  html += "<h1>Hello from ESP32-C3!</h1>";
  html += "<div class='card'><p>This page is served by an ESP32-C3 (RISC-V) running in the Velxio simulator.</p>";
  html += "<p>Requests served: <span class='stat'>" + String(requestCount) + "</span></p>";
  html += "<p>Uptime: <span class='stat'>" + String(millis() / 1000) + "s</span></p>";
  html += "<p>Free heap: <span class='stat'>" + String(ESP.getFreeHeap()) + " bytes</span></p>";
  html += "</div></body></html>";
  server.send(200, "text/html", html);
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("ESP32-C3 HTTP Server");

  WiFi.begin(ssid, "", 6);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println(" Connected!");

  server.on("/", handleRoot);
  server.on("/api/hello", []() {
    server.send(200, "application/json", "{\\"message\\":\\"Hello from ESP32-C3!\\"}");
  });
  server.begin();

  Serial.printf("Server started at: http://%s/\\n", WiFi.localIP().toString().c_str());
  Serial.println("Open the IoT Gateway link to access it from your browser.");
}

void loop() {
  server.handleClient();
}
`,
    components: [],
    wires: [],
  },

  {
    id: 'esp32c3-ble-advertise',
    title: 'ESP32-C3 BLE Advertise',
    description:
      'Initialize BLE 5.0 and start advertising on the ESP32-C3. Note: The ESP32-C3 only supports BLE (no Classic Bluetooth). BLE initialization is detected but actual communication is not emulated.',
    category: 'communication',
    difficulty: 'intermediate',
    boardType: 'esp32-c3',
    boardFilter: 'esp32-c3',
    code: `#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

BLEServer* pServer = nullptr;
BLECharacteristic* pCharacteristic = nullptr;
bool deviceConnected = false;
int counter = 0;

class MyServerCallbacks: public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) {
    deviceConnected = true;
    Serial.println("BLE client connected!");
  }
  void onDisconnect(BLEServer* pServer) {
    deviceConnected = false;
    Serial.println("BLE client disconnected");
    pServer->startAdvertising();
  }
};

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("ESP32-C3 BLE Advertise Demo");
  Serial.println("===========================");
  Serial.println("Note: ESP32-C3 supports BLE 5.0 only (no Classic BT).");
  Serial.println("BLE init is detected but communication is not emulated.");
  Serial.println();

  BLEDevice::init("Velxio-ESP32C3");
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);
  pCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_UUID,
    BLECharacteristic::PROPERTY_READ |
    BLECharacteristic::PROPERTY_WRITE |
    BLECharacteristic::PROPERTY_NOTIFY
  );
  pCharacteristic->addDescriptor(new BLE2902());
  pCharacteristic->setValue("Hello from Velxio C3!");

  pService->start();
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->start();

  Serial.println("BLE advertising started!");
  Serial.println("Device name: Velxio-ESP32C3");
  Serial.printf("Service UUID: %s\\n", SERVICE_UUID);
}

void loop() {
  if (deviceConnected) {
    counter++;
    String value = "Count: " + String(counter);
    pCharacteristic->setValue(value.c_str());
    pCharacteristic->notify();
    Serial.printf("Notified: %s\\n", value.c_str());
  }
  delay(2000);
}
`,
    components: [],
    wires: [],
  },

  // ── ESP32 WiFi & Bluetooth Examples ───────────────────────────────────────

  {
    id: 'esp32-wifi-scan',
    title: 'ESP32 WiFi Scan',
    description:
      'Scan for available WiFi networks and display them in Serial Monitor. The emulated ESP32 will find the "Velxio-GUEST" access point.',
    category: 'communication',
    difficulty: 'beginner',
    boardType: 'esp32',
    boardFilter: 'esp32',
    code: `#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("ESP32 WiFi Scanner");
  Serial.println("==================");

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);

  Serial.println("Scanning for networks...");
  int n = WiFi.scanNetworks();
  if (n == 0) {
    Serial.println("No networks found");
  } else {
    Serial.printf("Found %d networks:\\n", n);
    for (int i = 0; i < n; i++) {
      Serial.printf("  %d: %-20s  %d dBm  %s\\n",
        i + 1,
        WiFi.SSID(i).c_str(),
        WiFi.RSSI(i),
        WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "Open" : "Encrypted");
    }
  }
  Serial.println("\\nDone! Scan again in 10 seconds...");
}

void loop() {
  delay(10000);
  setup();  // re-scan
}
`,
    components: [],
    wires: [],
  },

  {
    id: 'esp32-wifi-connect',
    title: 'ESP32 WiFi Connect',
    description:
      'Connect to the virtual "Velxio-GUEST" WiFi network and print the assigned IP address. Uses channel 6 for faster connection.',
    category: 'communication',
    difficulty: 'beginner',
    boardType: 'esp32',
    boardFilter: 'esp32',
    code: `#include <WiFi.h>

const char* ssid = "Velxio-GUEST";

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("ESP32 WiFi Connection Demo");
  Serial.println("==========================");
  Serial.printf("Connecting to %s", ssid);

  WiFi.begin(ssid, "", 6);  // channel 6, no password

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println(" Connected!");
  Serial.printf("IP Address: %s\\n", WiFi.localIP().toString().c_str());
  Serial.printf("MAC Address: %s\\n", WiFi.macAddress().c_str());
  Serial.printf("Signal Strength (RSSI): %d dBm\\n", WiFi.RSSI());
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi still connected - IP: " + WiFi.localIP().toString());
  } else {
    Serial.println("WiFi disconnected! Reconnecting...");
    WiFi.begin(ssid, "", 6);
  }
  delay(5000);
}
`,
    components: [],
    wires: [],
  },

  {
    id: 'esp32-http-server',
    title: 'ESP32 HTTP Server',
    description:
      'Run a simple web server on the ESP32. After connecting to WiFi, the server responds with an HTML page. Access it via the IoT Gateway link.',
    category: 'communication',
    difficulty: 'intermediate',
    boardType: 'esp32',
    boardFilter: 'esp32',
    code: `#include <WiFi.h>
#include <WebServer.h>

const char* ssid = "Velxio-GUEST";
WebServer server(80);

int requestCount = 0;

void handleRoot() {
  requestCount++;
  String html = "<!DOCTYPE html><html><head>";
  html += "<meta charset='utf-8'>";
  html += "<meta name='viewport' content='width=device-width,initial-scale=1'>";
  html += "<title>ESP32 Web Server</title>";
  html += "<style>body{font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 20px;";
  html += "background:#1a1a2e;color:#e0e0e0}h1{color:#00d4ff}";
  html += ".card{background:#16213e;padding:20px;border-radius:10px;margin:10px 0}";
  html += ".stat{color:#00d4ff;font-size:1.2em}</style></head><body>";
  html += "<h1>Hello from ESP32!</h1>";
  html += "<div class='card'><p>This page is served by an ESP32 running in the Velxio simulator.</p>";
  html += "<p>Requests served: <span class='stat'>" + String(requestCount) + "</span></p>";
  html += "<p>Uptime: <span class='stat'>" + String(millis() / 1000) + "s</span></p>";
  html += "<p>Free heap: <span class='stat'>" + String(ESP.getFreeHeap()) + " bytes</span></p>";
  html += "</div></body></html>";
  server.send(200, "text/html", html);
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("ESP32 HTTP Server");

  WiFi.begin(ssid, "", 6);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println(" Connected!");

  server.on("/", handleRoot);
  server.on("/api/hello", []() {
    server.send(200, "application/json", "{\\"message\\":\\"Hello from ESP32!\\"}");
  });
  server.begin();

  Serial.printf("Server started at: http://%s/\\n", WiFi.localIP().toString().c_str());
  Serial.println("Open the IoT Gateway link to access it from your browser.");
}

void loop() {
  server.handleClient();
}
`,
    components: [],
    wires: [],
  },

  {
    id: 'esp32-ble-advertise',
    title: 'ESP32 BLE Advertise',
    description:
      'Initialize BLE and start advertising. Note: BLE initialization is detected but actual BLE communication is not emulated in the current simulator.',
    category: 'communication',
    difficulty: 'intermediate',
    boardType: 'esp32',
    boardFilter: 'esp32',
    code: `#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

BLEServer* pServer = nullptr;
BLECharacteristic* pCharacteristic = nullptr;
bool deviceConnected = false;
int counter = 0;

class MyServerCallbacks: public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) {
    deviceConnected = true;
    Serial.println("BLE client connected!");
  }
  void onDisconnect(BLEServer* pServer) {
    deviceConnected = false;
    Serial.println("BLE client disconnected");
    // Restart advertising
    pServer->startAdvertising();
  }
};

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("ESP32 BLE Advertise Demo");
  Serial.println("========================");
  Serial.println("Note: BLE init is detected but communication");
  Serial.println("is not emulated in the simulator.");
  Serial.println();

  BLEDevice::init("Velxio-ESP32");
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);
  pCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_UUID,
    BLECharacteristic::PROPERTY_READ |
    BLECharacteristic::PROPERTY_WRITE |
    BLECharacteristic::PROPERTY_NOTIFY
  );
  pCharacteristic->addDescriptor(new BLE2902());
  pCharacteristic->setValue("Hello from Velxio!");

  pService->start();
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->start();

  Serial.println("BLE advertising started!");
  Serial.println("Device name: Velxio-ESP32");
  Serial.printf("Service UUID: %s\\n", SERVICE_UUID);
}

void loop() {
  if (deviceConnected) {
    counter++;
    String value = "Count: " + String(counter);
    pCharacteristic->setValue(value.c_str());
    pCharacteristic->notify();
    Serial.printf("Notified: %s\\n", value.c_str());
  }
  delay(2000);
}
`,
    components: [],
    wires: [],
  },

  // ── ESP32 BMP280 Weather Station ─────────────────────────────────────────────
  {
    id: 'esp32-bmp280',
    title: 'ESP32: BMP280 Weather Station',
    description:
      'Read temperature and pressure from a BMP280 barometric sensor over I2C (SDA=D21, SCL=D22).',
    libraries: ['Adafruit BMP280 Library', 'Adafruit Unified Sensor', 'Adafruit BusIO'],
    category: 'sensors',
    difficulty: 'intermediate',
    boardType: 'esp32',
    boardFilter: 'esp32',
    code: `// ESP32 — BMP280 Barometric Pressure & Temperature (I2C)
// Requires: Adafruit BMP280 Library, Adafruit Unified Sensor
// Wiring: SDA → D21  |  SCL → D22  |  VCC → 3V3  |  GND → GND

#include <Wire.h>
#include <Adafruit_BMP280.h>

Adafruit_BMP280 bmp;

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  if (!bmp.begin(0x76)) {
    Serial.println("BMP280 not found! Check wiring.");
    while (true) delay(10);
  }
  bmp.setSampling(Adafruit_BMP280::MODE_NORMAL,
                  Adafruit_BMP280::SAMPLING_X2,
                  Adafruit_BMP280::SAMPLING_X16,
                  Adafruit_BMP280::FILTER_X16,
                  Adafruit_BMP280::STANDBY_MS_500);
  Serial.println("BMP280 ready!");
}

void loop() {
  float tempC    = bmp.readTemperature();
  float pressure = bmp.readPressure() / 100.0F; // hPa
  float altitude = bmp.readAltitude(1013.25);    // m

  Serial.printf("Temp: %.2f C  Pressure: %.2f hPa  Altitude: %.1f m\\n",
                tempC, pressure, altitude);
  delay(2000);
}`,
    components: [
      {
        type: 'velxio-bmp280',
        id: 'e32-bmp1',
        x: 420,
        y: 150,
        properties: { temperature: '25', pressure: '1013.25' },
      },
    ],
    wires: [
      {
        id: 'e32b-vcc',
        start: { componentId: 'arduino-uno', pinName: '3V3' },
        end: { componentId: 'e32-bmp1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'e32b-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND' },
        end: { componentId: 'e32-bmp1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'e32b-sda',
        start: { componentId: 'arduino-uno', pinName: '21' },
        end: { componentId: 'e32-bmp1', pinName: 'SDA' },
        color: '#22aaff',
      },
      {
        id: 'e32b-scl',
        start: { componentId: 'arduino-uno', pinName: '22' },
        end: { componentId: 'e32-bmp1', pinName: 'SCL' },
        color: '#ff8800',
      },
    ],
  },

  // ── ESP32 SSD1306 OLED Display ────────────────────────────────────────────────
  {
    id: 'esp32-oled',
    title: 'ESP32: SSD1306 OLED Display',
    description: 'Display text and graphics on a 128×64 SSD1306 OLED over I2C (SDA=D21, SCL=D22).',
    libraries: ['Adafruit SSD1306', 'Adafruit GFX Library', 'Adafruit BusIO'],
    category: 'displays',
    difficulty: 'intermediate',
    boardType: 'esp32',
    boardFilter: 'esp32',
    code: `// ESP32 — SSD1306 OLED Display (I2C 128×64)
// Requires: Adafruit SSD1306, Adafruit GFX Library
// Wiring: SDA → D21  |  SCL → D22  |  VCC → 3V3  |  GND → GND

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

int counter = 0;

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 not found!");
    while (true) delay(10);
  }
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Hello");
  display.println("Velxio!");
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
  display.println("Velxio!");
  display.setTextSize(1);
  display.setCursor(0, 48);
  display.printf("Count: %d", counter);
  display.display();
  Serial.printf("Frame: %d\\n", counter);
  delay(1000);
}`,
    components: [{ type: 'wokwi-ssd1306', id: 'e32-oled1', x: 420, y: 130, properties: {} }],
    wires: [
      {
        id: 'e32o-vcc',
        start: { componentId: 'arduino-uno', pinName: '3V3' },
        end: { componentId: 'e32-oled1', pinName: '3V3' },
        color: '#ff4444',
      },
      {
        id: 'e32o-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND' },
        end: { componentId: 'e32-oled1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'e32o-sda',
        start: { componentId: 'arduino-uno', pinName: '21' },
        end: { componentId: 'e32-oled1', pinName: 'DATA' },
        color: '#22aaff',
      },
      {
        id: 'e32o-scl',
        start: { componentId: 'arduino-uno', pinName: '22' },
        end: { componentId: 'e32-oled1', pinName: 'CLK' },
        color: '#ff8800',
      },
    ],
  },

  // ─── ATtiny85 Examples ───────────────────────────────────────────────────────

  {
    id: 'attiny85-blink',
    title: 'ATtiny85: Blink LED',
    description:
      'Blink an external LED on PB1 (Digispark pin 1) through a 220 Ohm current-limit resistor.',
    category: 'basics',
    difficulty: 'beginner',
    boardFilter: 'attiny85',
    boards: [
      {
        boardKind: 'attiny85',
        x: 120,
        y: 160,
        code: `// ATtiny85 — Blink an LED wired to PB1 (Digispark pin 1)
// PB1 -> 220 Ohm -> LED anode; LED cathode -> GND

void setup() {
  pinMode(1, OUTPUT);
}

void loop() {
  digitalWrite(1, HIGH);
  delay(500);
  digitalWrite(1, LOW);
  delay(500);
}`,
      },
    ],
    code: '',
    components: [
      { type: 'wokwi-led', id: 'tiny-led1', x: 360, y: 140, properties: { color: 'green' } },
      { type: 'wokwi-resistor', id: 'tiny-r1', x: 360, y: 220, properties: { value: '220' } },
    ],
    wires: [
      {
        id: 'tinyw1',
        start: { componentId: 'attiny85', pinName: 'PB1' },
        end: { componentId: 'tiny-led1', pinName: 'A' },
        color: '#22cc22',
      },
      {
        id: 'tinyw2',
        start: { componentId: 'tiny-led1', pinName: 'C' },
        end: { componentId: 'tiny-r1', pinName: '1' },
        color: '#888888',
      },
      {
        id: 'tinyw3',
        start: { componentId: 'tiny-r1', pinName: '2' },
        end: { componentId: 'attiny85', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },

  {
    id: 'attiny85-button-led',
    title: 'ATtiny85: Button + LED',
    description:
      'Press the button on PB0 to light the LED on PB1. Uses internal pull-up resistor — no external resistor needed.',
    category: 'basics',
    difficulty: 'beginner',
    boardFilter: 'attiny85',
    boards: [
      {
        boardKind: 'attiny85',
        x: 100,
        y: 150,
        code: `// ATtiny85 — Button on PB0, LED on PB1
// Button wiring: one leg to PB0, other leg to GND
// INPUT_PULLUP means HIGH = released, LOW = pressed

void setup() {
  pinMode(0, INPUT_PULLUP);  // PB0 — button with internal pull-up
  pinMode(1, OUTPUT);         // PB1 — LED
}

void loop() {
  bool pressed = (digitalRead(0) == LOW);
  digitalWrite(1, pressed ? HIGH : LOW);
}`,
      },
    ],
    code: '',
    components: [
      { type: 'wokwi-pushbutton', id: 'tiny-btn1', x: 380, y: 130, properties: { color: 'green' } },
      { type: 'wokwi-led', id: 'tiny-led1', x: 380, y: 240, properties: { color: 'red' } },
      {
        type: 'wokwi-resistor',
        id: 'tiny-btn-r1',
        x: 380,
        y: 320,
        properties: { value: '220' },
      },
    ],
    wires: [
      {
        id: 'tb-pb0',
        start: { componentId: 'attiny85', pinName: 'PB0' },
        end: { componentId: 'tiny-btn1', pinName: '1.l' },
        color: '#ffcc00',
      },
      {
        id: 'tb-gnd1',
        start: { componentId: 'attiny85', pinName: 'GND' },
        end: { componentId: 'tiny-btn1', pinName: '2.l' },
        color: '#000000',
      },
      {
        id: 'tb-pb1',
        start: { componentId: 'attiny85', pinName: 'PB1' },
        end: { componentId: 'tiny-led1', pinName: 'A' },
        color: '#ff4444',
      },
      {
        id: 'tb-led-r',
        start: { componentId: 'tiny-led1', pinName: 'C' },
        end: { componentId: 'tiny-btn-r1', pinName: '1' },
        color: '#888888',
      },
      {
        id: 'tb-gnd2',
        start: { componentId: 'tiny-btn-r1', pinName: '2' },
        end: { componentId: 'attiny85', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },

  {
    id: 'attiny85-pwm-fade',
    title: 'ATtiny85: PWM LED Fade',
    description:
      'Smoothly fade an LED in and out using analogWrite() on PB1 (OC0B). Shows Timer0 PWM on the ATtiny85.',
    category: 'basics',
    difficulty: 'intermediate',
    boardFilter: 'attiny85',
    boards: [
      {
        boardKind: 'attiny85',
        x: 100,
        y: 150,
        code: `// ATtiny85 — PWM LED fade on PB1 (OC0B / Timer0)
// analogWrite() uses Timer0 on the ATtiny85

void setup() {
  pinMode(1, OUTPUT);  // PB1 = OC0B (PWM capable)
}

void loop() {
  // Fade in
  for (int brightness = 0; brightness <= 255; brightness++) {
    analogWrite(1, brightness);
    delay(6);
  }
  // Fade out
  for (int brightness = 255; brightness >= 0; brightness--) {
    analogWrite(1, brightness);
    delay(6);
  }
  delay(200);
}`,
      },
    ],
    code: '',
    components: [
      { type: 'wokwi-led', id: 'tiny-fade-led', x: 380, y: 200, properties: { color: 'yellow' } },
      {
        type: 'wokwi-resistor',
        id: 'tiny-fade-r1',
        x: 380,
        y: 300,
        properties: { value: '220' },
      },
    ],
    wires: [
      {
        id: 'tf-pb1',
        start: { componentId: 'attiny85', pinName: 'PB1' },
        end: { componentId: 'tiny-fade-led', pinName: 'A' },
        color: '#ffcc00',
      },
      {
        id: 'tf-led-r',
        start: { componentId: 'tiny-fade-led', pinName: 'C' },
        end: { componentId: 'tiny-fade-r1', pinName: '1' },
        color: '#888888',
      },
      {
        id: 'tf-gnd',
        start: { componentId: 'attiny85', pinName: 'GND' },
        end: { componentId: 'tiny-fade-r1', pinName: '2' },
        color: '#000000',
      },
    ],
  },

  {
    id: 'attiny85-ntc-sensor',
    title: 'ATtiny85: NTC Temperature Sensor',
    description:
      'Read temperature from an NTC thermistor on PB3 (ADC3). The LED on PB1 blinks faster as temperature rises.',
    category: 'sensors',
    difficulty: 'intermediate',
    boardFilter: 'attiny85',
    boards: [
      {
        boardKind: 'attiny85',
        x: 100,
        y: 150,
        code: `// ATtiny85 — NTC Thermistor on PB3 (ADC3)
// Wiring: NTC between VCC and PB3, 10k resistor between PB3 and GND
// LED on PB1: blinks faster when temperature increases

#define NTC_PIN  3   // PB3 = ADC3
#define LED_PIN  1   // PB1

const float VCC        = 5.0;
const float SERIES_R   = 10000.0;
const float NOM_R      = 10000.0;   // NTC nominal resistance at 25°C
const float NOM_TEMP   = 25.0;
const float B_COEFF    = 3950.0;

float readTemperature() {
  int raw = analogRead(NTC_PIN);
  // R_NTC sits on the LOW side, so raw/1023 = R_NTC / (R_NTC + SERIES_R):
  //   R_NTC = SERIES_R / (1023/raw - 1)
  float resistance = SERIES_R / (1023.0 / raw - 1.0);
  float steinhart = resistance / NOM_R;
  steinhart = log(steinhart) / B_COEFF;
  steinhart += 1.0 / (NOM_TEMP + 273.15);
  return (1.0 / steinhart) - 273.15;
}

void setup() {
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  float temp = readTemperature();
  // Blink delay: 1000ms at 0°C down to 100ms at 100°C
  int blinkDelay = (int)(1000.0 - temp * 9.0);
  blinkDelay = constrain(blinkDelay, 100, 1000);

  digitalWrite(LED_PIN, HIGH);
  delay(blinkDelay / 2);
  digitalWrite(LED_PIN, LOW);
  delay(blinkDelay / 2);
}`,
      },
    ],
    code: '',
    components: [
      {
        type: 'wokwi-ntc-temperature-sensor',
        id: 'tiny-ntc1',
        x: 380,
        y: 150,
        properties: { temperature: '25' },
      },
      { type: 'wokwi-led', id: 'tiny-ntc-led', x: 380, y: 300, properties: { color: 'red' } },
      {
        type: 'wokwi-resistor',
        id: 'tiny-ntc-r1',
        x: 380,
        y: 380,
        properties: { value: '220' },
      },
    ],
    wires: [
      {
        id: 'tn-vcc',
        start: { componentId: 'attiny85', pinName: 'VCC' },
        end: { componentId: 'tiny-ntc1', pinName: 'VCC' },
        color: '#ff4444',
      },
      {
        id: 'tn-gnd',
        start: { componentId: 'attiny85', pinName: 'GND' },
        end: { componentId: 'tiny-ntc1', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'tn-out',
        start: { componentId: 'attiny85', pinName: 'PB3' },
        end: { componentId: 'tiny-ntc1', pinName: 'OUT' },
        color: '#aa44ff',
      },
      {
        id: 'tn-led',
        start: { componentId: 'attiny85', pinName: 'PB1' },
        end: { componentId: 'tiny-ntc-led', pinName: 'A' },
        color: '#ff4444',
      },
      {
        id: 'tn-led-r',
        start: { componentId: 'tiny-ntc-led', pinName: 'C' },
        end: { componentId: 'tiny-ntc-r1', pinName: '1' },
        color: '#888888',
      },
      {
        id: 'tn-lgnd',
        start: { componentId: 'tiny-ntc-r1', pinName: '2' },
        end: { componentId: 'attiny85', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },

  // ── ESP32-CAM examples ─────────────────────────────────────────────────────
  // Demos the QEMU-emulated OV2640 + I²S camera path. The user's webcam
  // (browser getUserMedia) feeds the firmware's esp_camera_fb_get() through
  // the simulator's velxio_push_camera_frame ctypes binding. See
  // test/test-esp32-cam/autosearch/14_complete_emulation.md for the
  // forensic trace of the 9 silent bugs that had to be fixed to make this
  // work. Both examples assume the user clicks the "Camera" button in the
  // canvas header and grants webcam permission.

  {
    id: 'esp32cam-webcam-demo',
    title: 'ESP32-CAM: Webcam Demo',
    description:
      'Init the OV2640 camera, verify chip-id over SCCB, then loop on esp_camera_fb_get() and print frame metadata to Serial. The simplest "is the emulation alive" sketch — click Camera in the canvas header to start streaming your webcam.',
    category: 'sensors',
    difficulty: 'beginner',
    boardType: 'esp32-cam',
    boardFilter: 'esp32-cam',
    code: `// Velxio ESP32-CAM webcam demo — minimal
// Click the "Camera" button in the canvas header to start streaming
// your webcam frames into the emulated OV2640.

#include "esp_camera.h"

// AI-Thinker ESP32-CAM pinout
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("=== Velxio ESP32-CAM webcam demo ===");

  camera_config_t cfg = {};
  cfg.ledc_channel = LEDC_CHANNEL_0;
  cfg.ledc_timer   = LEDC_TIMER_0;
  cfg.pin_d0 = Y2_GPIO_NUM; cfg.pin_d1 = Y3_GPIO_NUM;
  cfg.pin_d2 = Y4_GPIO_NUM; cfg.pin_d3 = Y5_GPIO_NUM;
  cfg.pin_d4 = Y6_GPIO_NUM; cfg.pin_d5 = Y7_GPIO_NUM;
  cfg.pin_d6 = Y8_GPIO_NUM; cfg.pin_d7 = Y9_GPIO_NUM;
  cfg.pin_xclk     = XCLK_GPIO_NUM;
  cfg.pin_pclk     = PCLK_GPIO_NUM;
  cfg.pin_vsync    = VSYNC_GPIO_NUM;
  cfg.pin_href     = HREF_GPIO_NUM;
  cfg.pin_sccb_sda = SIOD_GPIO_NUM;
  cfg.pin_sccb_scl = SIOC_GPIO_NUM;
  cfg.pin_pwdn     = PWDN_GPIO_NUM;
  cfg.pin_reset    = RESET_GPIO_NUM;
  cfg.xclk_freq_hz = 20000000;
  cfg.pixel_format = PIXFORMAT_JPEG;
  cfg.frame_size   = FRAMESIZE_QVGA;
  cfg.jpeg_quality = 12;
  cfg.fb_count     = 1;
  cfg.fb_location  = CAMERA_FB_IN_DRAM;

  esp_err_t err = esp_camera_init(&cfg);
  if (err != ESP_OK) {
    Serial.printf("camera_init FAIL: 0x%x\\n", err);
    while (1) delay(1000);
  }
  Serial.println("camera_init OK");

  sensor_t* s = esp_camera_sensor_get();
  if (s) {
    Serial.printf("OV2640 PID=0x%02X VER=0x%02X MIDH=0x%02X MIDL=0x%02X\\n",
                  s->id.PID, s->id.VER, s->id.MIDH, s->id.MIDL);
  }
  Serial.println("Click 'Camera' in the canvas header to start streaming.");
}

void loop() {
  static uint32_t n = 0;
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    static uint32_t nulls = 0;
    if (++nulls % 20 == 0) Serial.printf("waiting... (%u nulls)\\n", nulls);
    delay(200);
    return;
  }
  n++;
  Serial.printf("frame %u: %u bytes %ux%u fmt=%d  head=%02X %02X %02X %02X\\n",
                n, fb->len, fb->width, fb->height, fb->format,
                fb->buf[0], fb->buf[1], fb->buf[2], fb->buf[3]);
  esp_camera_fb_return(fb);
  delay(100);
}
`,
    components: [],
    wires: [],
  },

  {
    id: 'esp32cam-lcd-preview',
    title: 'ESP32-CAM + ILI9341 Live Preview',
    description:
      'Webcam frames decoded in-place with jpg2rgb565() and rendered to a 320×240 SPI TFT (160×120 centered, 1/2 scale). Status bar shows fps, frame counter, decode-fail counter and a live pulse. Requires Adafruit GFX + Adafruit ILI9341 libraries.',
    category: 'displays',
    difficulty: 'intermediate',
    boardType: 'esp32-cam',
    boardFilter: 'esp32-cam',
    libraries: ['Adafruit GFX Library', 'Adafruit BusIO', 'Adafruit ILI9341'],
    code: `// ESP32-CAM live webcam preview on ILI9341 320×240 TFT
// Click "Camera" in the canvas header → grant permission → see your
// face on the TFT.
//
// Wiring (already done by this example's diagram):
//   ILI9341 ↔ ESP32-CAM
//   CS  → 15   RST → 2    D/C → 14
//   MOSI→ 13   SCK → 12   MISO unused

#include "esp_camera.h"
#include "img_converters.h"   // jpg2rgb565 — built into esp32-camera
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>

// Camera pins (AI-Thinker)
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

// TFT pins
#define TFT_CS    15
#define TFT_DC    14
#define TFT_RST    2
#define TFT_MOSI  13
#define TFT_SCK   12

SPIClass tftSPI(VSPI);
Adafruit_ILI9341 tft = Adafruit_ILI9341(&tftSPI, TFT_DC, TFT_CS, TFT_RST);

// 160×120 preview centered in the 320×240 TFT. After the worker
// added batched spi_batch WS messages, transferring 38 KB/frame is
// no longer the dominant cost in the emulator.
#define PREVIEW_W 160
#define PREVIEW_H 120
#define PREVIEW_X  80
#define PREVIEW_Y  60
static uint8_t rgbBuf[PREVIEW_W * PREVIEW_H * 2];

#define STATUS_REFRESH_EVERY 5

uint32_t frame_count = 0, decode_fails = 0, null_fb = 0;
unsigned long start_ms = 0;

void draw_status_bar(uint32_t bytes_in, bool decoded) {
  tft.fillRect(0, 0, 320, PREVIEW_Y, ILI9341_BLACK);
  tft.setTextSize(1);
  tft.setTextColor(ILI9341_WHITE, ILI9341_BLACK);
  tft.setCursor(8, 6);
  tft.print("VELXIO ESP32-CAM live preview");
  tft.setCursor(8, 22);
  tft.printf("frame %4u   %4u B   %s",
             (unsigned)frame_count, (unsigned)bytes_in,
             decoded ? "decode OK   " : "decode FAIL ");
  unsigned long elapsed = millis() - start_ms;
  float fps = elapsed > 0 ? (1000.0f * frame_count) / (float)elapsed : 0.0f;
  tft.setCursor(8, 38);
  tft.printf("fps %4.1f   fails %u   nulls %u",
             fps, (unsigned)decode_fails, (unsigned)null_fb);
  tft.fillCircle(308, 14, 6,
    (frame_count & 1) ? ILI9341_GREEN : ILI9341_DARKGREEN);
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("=== ESP32-CAM + ILI9341 live preview ===");

  tftSPI.begin(TFT_SCK, -1, TFT_MOSI, TFT_CS);
  tft.begin();
  tft.setRotation(1);
  tft.fillScreen(ILI9341_NAVY);
  tft.setTextSize(3);
  tft.setTextColor(ILI9341_WHITE);
  tft.setCursor(20, 10); tft.print("VELXIO");
  tft.setTextSize(1);
  tft.setCursor(20, 38);
  tft.setTextColor(ILI9341_CYAN);
  tft.print("ESP32-CAM live preview");

  camera_config_t cfg = {};
  cfg.ledc_channel = LEDC_CHANNEL_0;
  cfg.ledc_timer   = LEDC_TIMER_0;
  cfg.pin_d0 = Y2_GPIO_NUM; cfg.pin_d1 = Y3_GPIO_NUM;
  cfg.pin_d2 = Y4_GPIO_NUM; cfg.pin_d3 = Y5_GPIO_NUM;
  cfg.pin_d4 = Y6_GPIO_NUM; cfg.pin_d5 = Y7_GPIO_NUM;
  cfg.pin_d6 = Y8_GPIO_NUM; cfg.pin_d7 = Y9_GPIO_NUM;
  cfg.pin_xclk = XCLK_GPIO_NUM;  cfg.pin_pclk = PCLK_GPIO_NUM;
  cfg.pin_vsync = VSYNC_GPIO_NUM; cfg.pin_href = HREF_GPIO_NUM;
  cfg.pin_sccb_sda = SIOD_GPIO_NUM;
  cfg.pin_sccb_scl = SIOC_GPIO_NUM;
  cfg.pin_pwdn = PWDN_GPIO_NUM;
  cfg.pin_reset = RESET_GPIO_NUM;
  cfg.xclk_freq_hz = 20000000;
  cfg.pixel_format = PIXFORMAT_JPEG;
  cfg.frame_size   = FRAMESIZE_QVGA;
  cfg.jpeg_quality = 12;
  cfg.fb_count     = 1;
  cfg.fb_location  = CAMERA_FB_IN_DRAM;

  esp_err_t err = esp_camera_init(&cfg);
  if (err != ESP_OK) {
    tft.setCursor(20, 100);
    tft.setTextColor(ILI9341_RED);
    tft.setTextSize(2);
    tft.printf("camera_init FAIL 0x%x", err);
    while (1) delay(1000);
  }

  tft.setCursor(20, 100);
  tft.setTextColor(ILI9341_GREEN);
  tft.print("camera_init OK");
  tft.setCursor(20, 130);
  tft.setTextColor(ILI9341_YELLOW);
  tft.print("Waiting for webcam frames...");
  tft.setCursor(20, 150);
  tft.print("Click 'Camera' in the toolbar.");

  start_ms = millis();
  delay(800);
  tft.fillScreen(ILI9341_BLACK);
}

void loop() {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    null_fb++;
    delay(50);
    return;
  }
  frame_count++;
  size_t fb_len = fb->len;
  bool ok = jpg2rgb565(fb->buf, fb->len, rgbBuf, JPG_SCALE_2X);
  esp_camera_fb_return(fb);
  if (ok) {
    tft.drawRGBBitmap(PREVIEW_X, PREVIEW_Y,
                      (uint16_t*)rgbBuf, PREVIEW_W, PREVIEW_H);
  } else {
    decode_fails++;
    tft.fillRect(PREVIEW_X, PREVIEW_Y,
                 PREVIEW_W, PREVIEW_H, ILI9341_DARKGREY);
    tft.drawLine(PREVIEW_X, PREVIEW_Y,
                 PREVIEW_X + PREVIEW_W, PREVIEW_Y + PREVIEW_H, ILI9341_RED);
    tft.drawLine(PREVIEW_X + PREVIEW_W, PREVIEW_Y,
                 PREVIEW_X, PREVIEW_Y + PREVIEW_H, ILI9341_RED);
  }
  // Throttled status-bar redraw — text writes hit SPI too.
  if (frame_count % STATUS_REFRESH_EVERY == 0) {
    draw_status_bar((uint32_t)fb_len, ok);
  }
}
`,
    components: [
      {
        type: 'wokwi-ili9341',
        id: 'tft1',
        x: 360,
        y: 100,
        // Rotated 90 CW, which fixes both complaints at once. The module is
        // portrait with its header along the BOTTOM edge, and the sketch draws
        // setRotation(1) landscape - per the part's own MADCTL mapping
        // (ComplexParts writePixel: rot-1 content's top edge lies on the
        // canvas's LEFT edge), so upright viewing needs the module turned a
        // quarter clockwise, exactly like the physical bench setup. The same
        // turn brings the header to the LEFT edge, facing the board, so the
        // wires run straight between the two instead of over the glass.
        properties: { rotation: 90 },
      },
    ],
    wires: [
      // SPI bus
      {
        id: 'cam-w-mosi',
        start: { componentId: 'arduino-uno', pinName: '13' },
        end: { componentId: 'tft1', pinName: 'MOSI' },
        color: '#3498db',
      },
      {
        id: 'cam-w-sck',
        start: { componentId: 'arduino-uno', pinName: '12' },
        end: { componentId: 'tft1', pinName: 'SCK' },
        color: '#27ae60',
      },
      {
        id: 'cam-w-cs',
        start: { componentId: 'arduino-uno', pinName: '15' },
        end: { componentId: 'tft1', pinName: 'CS' },
        color: '#e67e22',
      },
      {
        id: 'cam-w-dc',
        start: { componentId: 'arduino-uno', pinName: '14' },
        end: { componentId: 'tft1', pinName: 'D/C' },
        color: '#f1c40f',
      },
      {
        id: 'cam-w-rst',
        start: { componentId: 'arduino-uno', pinName: '2' },
        end: { componentId: 'tft1', pinName: 'RST' },
        color: '#ecf0f1',
      },
      // Power
      {
        id: 'cam-w-vcc',
        start: { componentId: 'arduino-uno', pinName: '3V3' },
        end: { componentId: 'tft1', pinName: 'VCC' },
        color: '#e74c3c',
      },
      {
        id: 'cam-w-led',
        start: { componentId: 'arduino-uno', pinName: '3V3' },
        end: { componentId: 'tft1', pinName: 'LED' },
        color: '#e74c3c',
      },
      {
        id: 'cam-w-gnd',
        start: { componentId: 'arduino-uno', pinName: 'GND.2' },
        end: { componentId: 'tft1', pinName: 'GND' },
        color: '#2c3e50',
      },
    ],
  },

  {
    id: 'esp32-doom',
    title: 'ESP32 Doom — Raycaster (ILI9341)',
    description:
      'A Wolfenstein / early-Doom style first-person raycaster on an ESP32 + ILI9341 320x240 colour TFT. The whole screen is redrawn every frame over hardware SPI (VSPI) with Adafruit_ILI9341 block writes (one startWrite/endWrite burst per frame), plus distance fog and darker E/W faces for depth. Four buttons move and turn the player; an auto-demo walks the 16x16 map when idle. Built as an emulation-speed benchmark — it overlays the on-device FPS and prints frame/FPS stats over Serial.',
    libraries: ['Adafruit GFX Library', 'Adafruit ILI9341', 'Adafruit BusIO'],
    category: 'games',
    difficulty: 'advanced',
    boardType: 'esp32',
    tags: ['esp32', 'doom', 'raycaster', 'ili9341', 'tft', '3d', 'game', 'benchmark'],
    code: `/*
 * VELXIO DOOM - ESP32 raycaster on an ILI9341 320x240 color TFT.
 *
 * Purpose: stress-test Velxio's QEMU ESP32 emulation by redrawing the whole
 * 320x240 screen every frame with a Wolfenstein/early-Doom style raycaster.
 * Rendering uses Adafruit_ILI9341 over HARDWARE SPI (VSPI) with the fast
 * block-transfer transaction API: a single startWrite()/endWrite() per frame
 * and writeFastVLine() column fills, so each frame is one big SPI burst
 * (the path QEMU forwards to the display sim as batched bytes).
 *
 * Every 10 frames it prints "STAT frame=.. t_ms=.. devfps=.." over Serial so
 * the host can compute BOTH on-device FPS (frames per emulated second) and
 * emulation speed (frames per real wall-clock second).
 *
 * Wiring (VSPI):  SCK=18  MOSI=23  MISO=19  CS=5  DC=2  RST=4  LED/VCC=3V3
 * Buttons (active-LOW, INPUT_PULLUP, other leg to GND):
 *   FWD=32  BACK=33  LEFT=25  RIGHT=26   (auto-demo runs with no input)
 */
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>
#include <math.h>

#define TFT_SCK  18
#define TFT_MOSI 23
#define TFT_MISO 19
#define TFT_DC    2
#define TFT_CS    5
#define TFT_RST   4

#define BTN_FWD   32
#define BTN_BACK  33
#define BTN_LEFT  25
#define BTN_RIGHT 26

#define RGB565(r, g, b) ((uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3)))

SPIClass tftSPI(VSPI);
Adafruit_ILI9341 tft = Adafruit_ILI9341(&tftSPI, TFT_DC, TFT_CS, TFT_RST);

static const int SCREEN_W = 320;
static const int SCREEN_H = 240;

#define MAP_W 16
#define MAP_H 16
const uint8_t worldMap[MAP_H][MAP_W] = {
  {1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1},
  {1,0,0,0,0,0,0,2,2,2,0,0,0,0,0,1},
  {1,0,1,1,0,0,0,0,0,0,0,0,3,3,0,1},
  {1,0,1,0,0,0,4,4,0,0,0,0,0,0,0,1},
  {1,0,1,0,0,0,0,0,0,0,5,5,5,0,0,1},
  {1,0,1,1,1,0,0,2,2,0,0,0,0,0,0,1},
  {1,0,0,0,0,0,0,0,0,0,0,3,0,0,0,1},
  {1,0,4,4,4,4,0,0,0,2,2,0,0,0,0,1},
  {1,0,0,0,0,0,0,0,0,0,0,0,0,5,5,1},
  {1,0,0,0,0,3,3,0,0,4,0,0,0,0,0,1},
  {1,0,2,2,0,0,0,0,0,0,0,1,1,0,0,1},
  {1,0,0,0,0,0,5,5,0,0,0,0,0,0,0,1},
  {1,0,3,0,0,0,0,0,0,2,2,2,0,0,0,1},
  {1,0,0,0,4,4,0,0,0,0,0,0,0,3,0,1},
  {1,0,0,0,0,0,0,0,5,0,0,0,0,0,0,1},
  {1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1},
};

static uint16_t wallColor(uint8_t t) {
  switch (t) {
    case 1: return RGB565(150, 150, 165); // slate
    case 2: return RGB565(190,  35,  35); // blood
    case 3: return RGB565(165, 100,  45); // brown
    case 4: return RGB565( 45, 180,  70); // toxic green
    case 5: return RGB565(180, 140,  50); // bronze door
  }
  return RGB565(100, 100, 100);
}

// Darken an RGB565 colour by a 0..256 factor (256 = unchanged).
static uint16_t shade(uint16_t c, uint16_t f) {
  uint16_t r = (c >> 11) & 0x1F, g = (c >> 5) & 0x3F, b = c & 0x1F;
  r = (r * f) >> 8; g = (g * f) >> 8; b = (b * f) >> 8;
  return (uint16_t)((r << 11) | (g << 5) | b);
}

const uint16_t CEIL_COLOR  = RGB565(28, 28, 44);
const uint16_t FLOOR_COLOR = RGB565(48, 42, 36);

// Player camera (DDA raycaster state).
float posX = 8.5f, posY = 8.5f;
float dirX = -1.0f, dirY = 0.0f;
float planeX = 0.0f, planeY = 0.66f;

uint32_t frames = 0;
uint32_t fpsT0 = 0;
int fpsWhole = 0, fpsFrac = 0;

static void rotate(float a) {
  float od = dirX;
  dirX = dirX * cosf(a) - dirY * sinf(a);
  dirY = od   * sinf(a) + dirY * cosf(a);
  float op = planeX;
  planeX = planeX * cosf(a) - planeY * sinf(a);
  planeY = op     * sinf(a) + planeY * cosf(a);
}

static bool isWall(float x, float y) {
  int mx = (int)x, my = (int)y;
  if (mx < 0 || mx >= MAP_W || my < 0 || my >= MAP_H) return true;
  return worldMap[my][mx] != 0;
}

static void moveStep(float dist) {
  float nx = posX + dirX * dist;
  float ny = posY + dirY * dist;
  if (!isWall(nx, posY)) posX = nx;
  if (!isWall(posX, ny)) posY = ny;
}

static void handleInput() {
  bool any = false;
  if (digitalRead(BTN_FWD)   == LOW) { moveStep( 0.10f); any = true; }
  if (digitalRead(BTN_BACK)  == LOW) { moveStep(-0.10f); any = true; }
  if (digitalRead(BTN_LEFT)  == LOW) { rotate( 0.06f);   any = true; }
  if (digitalRead(BTN_RIGHT) == LOW) { rotate(-0.06f);   any = true; }
  if (!any) {
    // Auto-demo: walk forward, slowly pan, and turn hard if about to hit a wall.
    rotate(0.013f);
    moveStep(0.05f);
    if (isWall(posX + dirX * 0.25f, posY + dirY * 0.25f)) rotate(0.25f);
  }
}

static void renderFrame() {
  tft.startWrite();
  for (int x = 0; x < SCREEN_W; x++) {
    float cameraX = 2.0f * x / (float)SCREEN_W - 1.0f;
    float rayDirX = dirX + planeX * cameraX;
    float rayDirY = dirY + planeY * cameraX;

    int mapX = (int)posX, mapY = (int)posY;
    float deltaX = (rayDirX == 0.0f) ? 1e30f : fabsf(1.0f / rayDirX);
    float deltaY = (rayDirY == 0.0f) ? 1e30f : fabsf(1.0f / rayDirY);

    int stepX, stepY;
    float sideX, sideY;
    if (rayDirX < 0) { stepX = -1; sideX = (posX - mapX) * deltaX; }
    else             { stepX =  1; sideX = (mapX + 1.0f - posX) * deltaX; }
    if (rayDirY < 0) { stepY = -1; sideY = (posY - mapY) * deltaY; }
    else             { stepY =  1; sideY = (mapY + 1.0f - posY) * deltaY; }

    int side = 0;
    uint8_t tile = 1;
    for (int guard = 0; guard < 64; guard++) {
      if (sideX < sideY) { sideX += deltaX; mapX += stepX; side = 0; }
      else               { sideY += deltaY; mapY += stepY; side = 1; }
      if (mapX < 0 || mapX >= MAP_W || mapY < 0 || mapY >= MAP_H) { tile = 1; break; }
      tile = worldMap[mapY][mapX];
      if (tile != 0) break;
    }

    float perp = (side == 0) ? (sideX - deltaX) : (sideY - deltaY);
    if (perp < 0.05f) perp = 0.05f;

    int lineH = (int)(SCREEN_H / perp);
    int drawStart = SCREEN_H / 2 - lineH / 2;
    int drawEnd   = SCREEN_H / 2 + lineH / 2;
    if (drawStart < 0) drawStart = 0;
    if (drawEnd > SCREEN_H - 1) drawEnd = SCREEN_H - 1;

    // Distance fog + darker E/W faces for a sense of depth.
    float fog = 1.0f - perp / 16.0f;
    if (fog < 0.18f) fog = 0.18f;
    uint16_t f = (uint16_t)(fog * 256.0f);
    if (side == 1) f = (f * 180) >> 8;
    uint16_t col = shade(wallColor(tile), f);

    if (drawStart > 0)
      tft.writeFastVLine(x, 0, drawStart, CEIL_COLOR);
    tft.writeFastVLine(x, drawStart, drawEnd - drawStart + 1, col);
    if (drawEnd < SCREEN_H - 1)
      tft.writeFastVLine(x, drawEnd + 1, SCREEN_H - 1 - drawEnd, FLOOR_COLOR);
  }
  tft.endWrite();
}

static void drawHud() {
  tft.fillRect(0, 0, 168, 16, RGB565(0, 0, 0));
  tft.setTextSize(1);
  tft.setTextColor(RGB565(0, 255, 80));
  tft.setCursor(4, 4);
  tft.print("VELXIO DOOM  FPS ");
  tft.print(fpsWhole);
  tft.print('.');
  tft.print(fpsFrac);
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("VELXIO DOOM raycaster -- ESP32 + ILI9341 (Adafruit, HW SPI)");
  pinMode(BTN_FWD,   INPUT_PULLUP);
  pinMode(BTN_BACK,  INPUT_PULLUP);
  pinMode(BTN_LEFT,  INPUT_PULLUP);
  pinMode(BTN_RIGHT, INPUT_PULLUP);

  tftSPI.begin(TFT_SCK, TFT_MISO, TFT_MOSI, TFT_CS);
  tft.begin(40000000); // 40 MHz nominal SPI
  tft.setRotation(1);  // landscape 320x240
  tft.fillScreen(RGB565(0, 0, 0));
  tft.setTextSize(3);
  tft.setTextColor(RGB565(0, 255, 80));
  tft.setCursor(36, 96);
  tft.print("VELXIO DOOM");
  tft.setTextSize(1);
  tft.setTextColor(RGB565(180, 180, 180));
  tft.setCursor(60, 140);
  tft.print("raycaster emulation benchmark");
  delay(600);
  fpsT0 = millis();
}

void loop() {
  handleInput();
  renderFrame();
  drawHud();
  frames++;

  if (frames % 10 == 0) {
    uint32_t now = millis();
    uint32_t dms = now - fpsT0;
    if (dms == 0) dms = 1;
    // FPS x10 (tenths), integer math to avoid %f (nano newlib has no float printf).
    uint32_t fps_x10 = (10u * 1000u * 10u) / dms;
    fpsWhole = fps_x10 / 10;
    fpsFrac  = fps_x10 % 10;
    fpsT0 = now;
    Serial.print("STAT frame=");
    Serial.print(frames);
    Serial.print(" t_ms=");
    Serial.print(now);
    Serial.print(" devfps=");
    Serial.print(fpsWhole);
    Serial.print('.');
    Serial.println(fpsFrac);
  }
}
`,
    components: [
      { type: 'wokwi-ili9341', id: 'tft1', x: 380, y: 40, properties: {} },
      { type: 'wokwi-pushbutton', id: 'btn_fwd', x: 360, y: 330, properties: { color: 'green' } },
      { type: 'wokwi-pushbutton', id: 'btn_back', x: 470, y: 330, properties: { color: 'red' } },
      { type: 'wokwi-pushbutton', id: 'btn_left', x: 580, y: 330, properties: { color: 'blue' } },
      {
        type: 'wokwi-pushbutton',
        id: 'btn_right',
        x: 690,
        y: 330,
        properties: { color: 'yellow' },
      },
    ],
    wires: [
      {
        id: 'd-sck',
        start: { componentId: 'esp32', pinName: '18' },
        end: { componentId: 'tft1', pinName: 'SCK' },
        color: '#27ae60',
      },
      {
        id: 'd-mosi',
        start: { componentId: 'esp32', pinName: '23' },
        end: { componentId: 'tft1', pinName: 'MOSI' },
        color: '#3498db',
      },
      {
        id: 'd-miso',
        start: { componentId: 'esp32', pinName: '19' },
        end: { componentId: 'tft1', pinName: 'MISO' },
        color: '#9b59b6',
      },
      {
        id: 'd-cs',
        start: { componentId: 'esp32', pinName: '5' },
        end: { componentId: 'tft1', pinName: 'CS' },
        color: '#e67e22',
      },
      {
        id: 'd-dc',
        start: { componentId: 'esp32', pinName: '2' },
        end: { componentId: 'tft1', pinName: 'D/C' },
        color: '#f1c40f',
      },
      {
        id: 'd-rst',
        start: { componentId: 'esp32', pinName: '4' },
        end: { componentId: 'tft1', pinName: 'RST' },
        color: '#ecf0f1',
      },
      {
        id: 'd-vcc',
        start: { componentId: 'esp32', pinName: '3V3' },
        end: { componentId: 'tft1', pinName: 'VCC' },
        color: '#e74c3c',
      },
      {
        id: 'd-led',
        start: { componentId: 'esp32', pinName: '3V3' },
        end: { componentId: 'tft1', pinName: 'LED' },
        color: '#e74c3c',
      },
      {
        id: 'd-gnd',
        start: { componentId: 'esp32', pinName: 'GND' },
        end: { componentId: 'tft1', pinName: 'GND' },
        color: '#2c3e50',
      },
      {
        id: 'd-bf-s',
        start: { componentId: 'esp32', pinName: '32' },
        end: { componentId: 'btn_fwd', pinName: '1.l' },
        color: '#16a085',
      },
      {
        id: 'd-bf-g',
        start: { componentId: 'esp32', pinName: 'GND' },
        end: { componentId: 'btn_fwd', pinName: '2.l' },
        color: '#000000',
      },
      {
        id: 'd-bb-s',
        start: { componentId: 'esp32', pinName: '33' },
        end: { componentId: 'btn_back', pinName: '1.l' },
        color: '#c0392b',
      },
      {
        id: 'd-bb-g',
        start: { componentId: 'esp32', pinName: 'GND2' },
        end: { componentId: 'btn_back', pinName: '2.l' },
        color: '#000000',
      },
      {
        id: 'd-bl-s',
        start: { componentId: 'esp32', pinName: '25' },
        end: { componentId: 'btn_left', pinName: '1.l' },
        color: '#2980b9',
      },
      {
        id: 'd-bl-g',
        start: { componentId: 'esp32', pinName: 'GND' },
        end: { componentId: 'btn_left', pinName: '2.l' },
        color: '#000000',
      },
      {
        id: 'd-br-s',
        start: { componentId: 'esp32', pinName: '26' },
        end: { componentId: 'btn_right', pinName: '1.l' },
        color: '#f39c12',
      },
      {
        id: 'd-br-g',
        start: { componentId: 'esp32', pinName: 'GND2' },
        end: { componentId: 'btn_right', pinName: '2.l' },
        color: '#000000',
      },
    ],
  },

  // ── Raspberry Pi 3 / 4 / 5 — single-board GPIO examples ──────────────────
  // These run a Python (gpiozero) script on the QEMU Linux board. gpiozero is
  // board-agnostic (works on Pi 3/4/5). Only DIGITAL GPIO is wired — output
  // (LEDs, RGB) and input (button, PIR) — since the Pi has no ADC and PWM is
  // not simulated. To run: Start the Pi, click Upload in the File System
  // panel, then `python3 /home/pi/script.py`.
  {
    id: 'pi3-blink-led',
    title: '[Pi 3] Blink an LED',
    description:
      'Raspberry Pi 3 blinks a red LED on GPIO17 with gpiozero. Start the Pi, click Upload in the File System panel, then run: python3 /home/pi/script.py',
    category: 'basics',
    difficulty: 'beginner',
    code: '',
    boards: [
      {
        boardKind: 'raspberry-pi-3',
        x: 80,
        y: 80,
        vfsFiles: {
          'script.py': `#!/usr/bin/env python3
# Raspberry Pi 3 - Blink an LED
# Wiring: GPIO17 -> LED(+)  ;  LED(-) -> GND   (add a 220 ohm series
# resistor on real hardware; the simulator's LED needs none).
from gpiozero import LED
from time import sleep

led = LED(17)
print("Blinking LED on GPIO17 - Ctrl-C to stop")
try:
    while True:
        led.on()
        print("LED ON")
        sleep(1)
        led.off()
        print("LED OFF")
        sleep(1)
except KeyboardInterrupt:
    led.off()
    print("Stopped")
`,
        },
      },
    ],
    components: [
      { type: 'wokwi-resistor', id: 'r-pi3b-led', x: 410, y: 180, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'pi3b-led', x: 540, y: 160, properties: { color: 'red' } },
    ],
    wires: [
      {
        id: 'w-sig',
        start: { componentId: 'raspberry-pi-3', pinName: 'GPIO17' },
        end: { componentId: 'r-pi3b-led', pinName: '1' },
        color: '#e74c3c',
      },
      {
        id: 'w-sig-r',
        start: { componentId: 'r-pi3b-led', pinName: '2' },
        end: { componentId: 'pi3b-led', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w-gnd',
        start: { componentId: 'pi3b-led', pinName: 'C' },
        end: { componentId: 'raspberry-pi-3', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'pi3-running-lights',
    title: '[Pi 3] Running Lights (5 LEDs)',
    description:
      'Raspberry Pi 3 sweeps a Knight-Rider pattern across 5 LEDs on GPIO17/27/22/5/6 with gpiozero. Start the Pi, Upload, then run: python3 /home/pi/script.py',
    category: 'basics',
    difficulty: 'intermediate',
    code: '',
    boards: [
      {
        boardKind: 'raspberry-pi-3',
        x: 80,
        y: 80,
        vfsFiles: {
          'script.py': `#!/usr/bin/env python3
# Raspberry Pi 3 - Knight Rider / running lights across 5 LEDs
from gpiozero import LED
from time import sleep

pins = [17, 27, 22, 5, 6]
leds = [LED(p) for p in pins]
print("Running lights on GPIO", pins, "- Ctrl-C to stop")
try:
    while True:
        for i in range(len(leds)):
            leds[i].on()
            print("LED", pins[i], "ON")
            sleep(0.12)
            leds[i].off()
        for i in range(len(leds) - 2, 0, -1):
            leds[i].on()
            print("LED", pins[i], "ON")
            sleep(0.12)
            leds[i].off()
except KeyboardInterrupt:
    for led in leds:
        led.off()
    print("Stopped")
`,
        },
      },
    ],
    components: [
      { type: 'wokwi-resistor', id: 'r-pi3r-led1', x: 410, y: 80, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'pi3r-led1', x: 540, y: 60, properties: { color: 'red' } },
      { type: 'wokwi-resistor', id: 'r-pi3r-led2', x: 410, y: 160, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'pi3r-led2', x: 540, y: 140, properties: { color: 'orange' } },
      { type: 'wokwi-resistor', id: 'r-pi3r-led3', x: 410, y: 240, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'pi3r-led3', x: 540, y: 220, properties: { color: 'yellow' } },
      { type: 'wokwi-resistor', id: 'r-pi3r-led4', x: 410, y: 320, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'pi3r-led4', x: 540, y: 300, properties: { color: 'green' } },
      { type: 'wokwi-resistor', id: 'r-pi3r-led5', x: 410, y: 400, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'pi3r-led5', x: 540, y: 380, properties: { color: 'blue' } },
    ],
    wires: [
      {
        id: 'w1',
        start: { componentId: 'raspberry-pi-3', pinName: 'GPIO17' },
        end: { componentId: 'r-pi3r-led1', pinName: '1' },
        color: '#e74c3c',
      },
      {
        id: 'w1-r',
        start: { componentId: 'r-pi3r-led1', pinName: '2' },
        end: { componentId: 'pi3r-led1', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w2',
        start: { componentId: 'raspberry-pi-3', pinName: 'GPIO27' },
        end: { componentId: 'r-pi3r-led2', pinName: '1' },
        color: '#e67e22',
      },
      {
        id: 'w2-r',
        start: { componentId: 'r-pi3r-led2', pinName: '2' },
        end: { componentId: 'pi3r-led2', pinName: 'A' },
        color: '#e67e22',
      },
      {
        id: 'w3',
        start: { componentId: 'raspberry-pi-3', pinName: 'GPIO22' },
        end: { componentId: 'r-pi3r-led3', pinName: '1' },
        color: '#f1c40f',
      },
      {
        id: 'w3-r',
        start: { componentId: 'r-pi3r-led3', pinName: '2' },
        end: { componentId: 'pi3r-led3', pinName: 'A' },
        color: '#f1c40f',
      },
      {
        id: 'w4',
        start: { componentId: 'raspberry-pi-3', pinName: 'GPIO5' },
        end: { componentId: 'r-pi3r-led4', pinName: '1' },
        color: '#2ecc71',
      },
      {
        id: 'w4-r',
        start: { componentId: 'r-pi3r-led4', pinName: '2' },
        end: { componentId: 'pi3r-led4', pinName: 'A' },
        color: '#2ecc71',
      },
      {
        id: 'w5',
        start: { componentId: 'raspberry-pi-3', pinName: 'GPIO6' },
        end: { componentId: 'r-pi3r-led5', pinName: '1' },
        color: '#3498db',
      },
      {
        id: 'w5-r',
        start: { componentId: 'r-pi3r-led5', pinName: '2' },
        end: { componentId: 'pi3r-led5', pinName: 'A' },
        color: '#3498db',
      },
      {
        id: 'g1',
        start: { componentId: 'pi3r-led1', pinName: 'C' },
        end: { componentId: 'raspberry-pi-3', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'g2',
        start: { componentId: 'pi3r-led2', pinName: 'C' },
        end: { componentId: 'raspberry-pi-3', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'g3',
        start: { componentId: 'pi3r-led3', pinName: 'C' },
        end: { componentId: 'raspberry-pi-3', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'g4',
        start: { componentId: 'pi3r-led4', pinName: 'C' },
        end: { componentId: 'raspberry-pi-3', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'g5',
        start: { componentId: 'pi3r-led5', pinName: 'C' },
        end: { componentId: 'raspberry-pi-3', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'pi4-button-led',
    title: '[Pi 4] Button Toggles LED',
    description:
      'Raspberry Pi 4 reads a push button on GPIO2 and toggles an LED on GPIO17 with gpiozero. Start the Pi, Upload, run python3 /home/pi/script.py, then click the button.',
    category: 'basics',
    difficulty: 'beginner',
    code: '',
    boards: [
      {
        boardKind: 'raspberry-pi-4',
        x: 80,
        y: 80,
        vfsFiles: {
          'script.py': `#!/usr/bin/env python3
# Raspberry Pi 4 - Button toggles an LED
# Wiring: button GPIO2 <-> GND (internal pull-up; pressed reads LOW).
#         LED on GPIO17 -> LED(+) ; LED(-) -> GND
from gpiozero import Button, LED
from time import sleep

button = Button(2)   # pull_up=True by default
led = LED(17)
print("Press the button to toggle the LED - Ctrl-C to stop")
state = False
try:
    while True:
        button.wait_for_press()
        state = not state
        led.value = state
        print("LED", "ON" if state else "OFF")
        sleep(0.3)   # simple debounce
except KeyboardInterrupt:
    led.off()
    print("Stopped")
`,
        },
      },
    ],
    components: [
      { type: 'wokwi-pushbutton', id: 'pi4-btn', x: 540, y: 120, properties: { color: 'green' } },
      { type: 'wokwi-resistor', id: 'r-pi4-led', x: 410, y: 320, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'pi4-led', x: 540, y: 300, properties: { color: 'blue' } },
    ],
    wires: [
      {
        id: 'w-btn',
        start: { componentId: 'raspberry-pi-4', pinName: 'GPIO2' },
        end: { componentId: 'pi4-btn', pinName: '1.l' },
        color: '#00aaff',
      },
      {
        id: 'w-btn-gnd',
        start: { componentId: 'pi4-btn', pinName: '2.l' },
        end: { componentId: 'raspberry-pi-4', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w-led',
        start: { componentId: 'raspberry-pi-4', pinName: 'GPIO17' },
        end: { componentId: 'r-pi4-led', pinName: '1' },
        color: '#3498db',
      },
      {
        id: 'w-led-r',
        start: { componentId: 'r-pi4-led', pinName: '2' },
        end: { componentId: 'pi4-led', pinName: 'A' },
        color: '#3498db',
      },
      {
        id: 'w-led-gnd',
        start: { componentId: 'pi4-led', pinName: 'C' },
        end: { componentId: 'raspberry-pi-4', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'pi4-rgb-color-cycle',
    title: '[Pi 4] RGB LED Color Cycle',
    description:
      'Raspberry Pi 4 cycles a common-cathode RGB LED through 7 colors using digital on/off on GPIO17/27/22 (gpiozero RGBLED, pwm=False). Start the Pi, Upload, run python3 /home/pi/script.py',
    category: 'basics',
    difficulty: 'intermediate',
    code: '',
    boards: [
      {
        boardKind: 'raspberry-pi-4',
        x: 80,
        y: 80,
        vfsFiles: {
          'script.py': `#!/usr/bin/env python3
# Raspberry Pi 4 - RGB LED color cycle (digital, 7 colors)
# Wiring: R->GPIO17, G->GPIO27, B->GPIO22, COM->GND (common cathode).
# pwm=False -> each channel is plain on/off, so no PWM is needed.
from gpiozero import RGBLED
from time import sleep

rgb = RGBLED(red=17, green=27, blue=22, pwm=False)
colors = [
    ("red",     (1, 0, 0)),
    ("green",   (0, 1, 0)),
    ("blue",    (0, 0, 1)),
    ("yellow",  (1, 1, 0)),
    ("cyan",    (0, 1, 1)),
    ("magenta", (1, 0, 1)),
    ("white",   (1, 1, 1)),
]
print("Cycling RGB colors - Ctrl-C to stop")
try:
    while True:
        for name, value in colors:
            rgb.color = value
            print(name)
            sleep(1)
except KeyboardInterrupt:
    rgb.off()
    print("Stopped")
`,
        },
      },
    ],
    components: [
      { type: 'wokwi-resistor', id: 'r-pi4-rgb-r', x: 440, y: 160, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-pi4-rgb-g', x: 440, y: 186, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-pi4-rgb-b', x: 440, y: 212, properties: { value: '220' } },
      { type: 'wokwi-rgb-led', id: 'pi4-rgb', x: 560, y: 160, properties: {} }],
    wires: [
      {
        id: 'w-r',
        start: { componentId: 'raspberry-pi-4', pinName: 'GPIO17' },
        end: { componentId: 'r-pi4-rgb-r', pinName: '1' },
        color: '#e74c3c',
      },
      {
        id: 'w-r-pi4-rgb-r',
        start: { componentId: 'r-pi4-rgb-r', pinName: '2' },
        end: { componentId: 'pi4-rgb', pinName: 'R' },
        color: '#e74c3c',
      },
      {
        id: 'w-g',
        start: { componentId: 'raspberry-pi-4', pinName: 'GPIO27' },
        end: { componentId: 'r-pi4-rgb-g', pinName: '1' },
        color: '#2ecc71',
      },
      {
        id: 'w-r-pi4-rgb-g',
        start: { componentId: 'r-pi4-rgb-g', pinName: '2' },
        end: { componentId: 'pi4-rgb', pinName: 'G' },
        color: '#e74c3c',
      },
      {
        id: 'w-b',
        start: { componentId: 'raspberry-pi-4', pinName: 'GPIO22' },
        end: { componentId: 'r-pi4-rgb-b', pinName: '1' },
        color: '#3498db',
      },
      {
        id: 'w-r-pi4-rgb-b',
        start: { componentId: 'r-pi4-rgb-b', pinName: '2' },
        end: { componentId: 'pi4-rgb', pinName: 'B' },
        color: '#e74c3c',
      },
      {
        id: 'w-com',
        start: { componentId: 'pi4-rgb', pinName: 'COM' },
        end: { componentId: 'raspberry-pi-4', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'pi5-pir-motion-alarm',
    title: '[Pi 5] PIR Motion Alarm',
    description:
      'Raspberry Pi 5 lights an LED on GPIO17 whenever a PIR motion sensor on GPIO4 detects movement (gpiozero MotionSensor). Start the Pi, Upload, run python3 /home/pi/script.py, then trigger the PIR.',
    category: 'sensors',
    difficulty: 'intermediate',
    code: '',
    boards: [
      {
        boardKind: 'raspberry-pi-5',
        x: 80,
        y: 80,
        vfsFiles: {
          'script.py': `#!/usr/bin/env python3
# Raspberry Pi 5 - PIR motion alarm
# Wiring: PIR VCC->5V, GND->GND, OUT->GPIO4 ; LED on GPIO17.
from gpiozero import MotionSensor, LED
from time import sleep

pir = MotionSensor(4)
led = LED(17)
print("Motion alarm armed - trigger the PIR sensor (Ctrl-C to stop)")
try:
    while True:
        if pir.motion_detected:
            led.on()
            print("Motion detected!")
        else:
            led.off()
        sleep(0.2)
except KeyboardInterrupt:
    led.off()
    print("Stopped")
`,
        },
      },
    ],
    components: [
      { type: 'wokwi-pir-motion-sensor', id: 'pi5-pir', x: 540, y: 120, properties: {} },
      { type: 'wokwi-resistor', id: 'r-pi5-led', x: 430, y: 340, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'pi5-led', x: 560, y: 320, properties: { color: 'red' } },
    ],
    wires: [
      {
        id: 'w-vcc',
        start: { componentId: 'raspberry-pi-5', pinName: '5V' },
        end: { componentId: 'pi5-pir', pinName: 'VCC' },
        color: '#e74c3c',
      },
      {
        id: 'w-pir-gnd',
        start: { componentId: 'pi5-pir', pinName: 'GND' },
        end: { componentId: 'raspberry-pi-5', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'w-out',
        start: { componentId: 'pi5-pir', pinName: 'OUT' },
        end: { componentId: 'raspberry-pi-5', pinName: 'GPIO4' },
        color: '#f1c40f',
      },
      {
        id: 'w-led',
        start: { componentId: 'raspberry-pi-5', pinName: 'GPIO17' },
        end: { componentId: 'r-pi5-led', pinName: '1' },
        color: '#e74c3c',
      },
      {
        id: 'w-led-r',
        start: { componentId: 'r-pi5-led', pinName: '2' },
        end: { componentId: 'pi5-led', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w-led-gnd',
        start: { componentId: 'pi5-led', pinName: 'C' },
        end: { componentId: 'raspberry-pi-5', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },
  {
    id: 'pi5-traffic-light',
    title: '[Pi 5] Traffic Light',
    description:
      'Raspberry Pi 5 runs a red/yellow/green traffic-light state machine on GPIO17/27/22 with gpiozero. Start the Pi, Upload, then run: python3 /home/pi/script.py',
    category: 'basics',
    difficulty: 'intermediate',
    code: '',
    boards: [
      {
        boardKind: 'raspberry-pi-5',
        x: 80,
        y: 80,
        vfsFiles: {
          'script.py': `#!/usr/bin/env python3
# Raspberry Pi 5 - Traffic light state machine
# Wiring: red->GPIO17, yellow->GPIO27, green->GPIO22 (each LED- -> GND).
from gpiozero import LED
from time import sleep

red = LED(17)
yellow = LED(27)
green = LED(22)
print("Traffic light running - Ctrl-C to stop")
try:
    while True:
        red.on(); yellow.off(); green.off()
        print("RED")
        sleep(3)
        red.off(); green.on()
        print("GREEN")
        sleep(3)
        green.off(); yellow.on()
        print("YELLOW")
        sleep(1)
        yellow.off()
except KeyboardInterrupt:
    red.off(); yellow.off(); green.off()
    print("Stopped")
`,
        },
      },
    ],
    components: [
      { type: 'wokwi-resistor', id: 'r-pi5-red-a', x: 420, y: 80, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-pi5-yellow-a', x: 420, y: 200, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'r-pi5-green-a', x: 420, y: 320, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'pi5-red', x: 540, y: 80, properties: { color: 'red' } },
      { type: 'wokwi-led', id: 'pi5-yellow', x: 540, y: 200, properties: { color: 'yellow' } },
      { type: 'wokwi-led', id: 'pi5-green', x: 540, y: 320, properties: { color: 'green' } },
    ],
    wires: [
      {
        id: 'w-r',
        start: { componentId: 'raspberry-pi-5', pinName: 'GPIO17' },
        end: { componentId: 'r-pi5-red-a', pinName: '1' },
        color: '#e74c3c',
      },
      {
        id: 'w-r-pi5-red-a',
        start: { componentId: 'r-pi5-red-a', pinName: '2' },
        end: { componentId: 'pi5-red', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w-y',
        start: { componentId: 'raspberry-pi-5', pinName: 'GPIO27' },
        end: { componentId: 'r-pi5-yellow-a', pinName: '1' },
        color: '#f1c40f',
      },
      {
        id: 'w-r-pi5-yellow-a',
        start: { componentId: 'r-pi5-yellow-a', pinName: '2' },
        end: { componentId: 'pi5-yellow', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'w-g',
        start: { componentId: 'raspberry-pi-5', pinName: 'GPIO22' },
        end: { componentId: 'r-pi5-green-a', pinName: '1' },
        color: '#2ecc71',
      },
      {
        id: 'w-r-pi5-green-a',
        start: { componentId: 'r-pi5-green-a', pinName: '2' },
        end: { componentId: 'pi5-green', pinName: 'A' },
        color: '#e74c3c',
      },
      {
        id: 'g-r',
        start: { componentId: 'pi5-red', pinName: 'C' },
        end: { componentId: 'raspberry-pi-5', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'g-y',
        start: { componentId: 'pi5-yellow', pinName: 'C' },
        end: { componentId: 'raspberry-pi-5', pinName: 'GND' },
        color: '#000000',
      },
      {
        id: 'g-g',
        start: { componentId: 'pi5-green', pinName: 'C' },
        end: { componentId: 'raspberry-pi-5', pinName: 'GND' },
        color: '#000000',
      },
    ],
  },
];

// Merge legacy examples with circuit-focused examples (analog, digital gates,
// electromechanical) plus the board-less analog SPICE suite. Declared after
// all arrays exist so the export is a single immutable value — safe from
// tree-shaking quirks.
export const exampleProjects: ExampleProject[] = [
  ...legacyExamples,
  ...circuitExamples,
  ...analogExamples,
  ...digitalExamples,
  ...hundredDaysExamples,
  ...proExamples,
  ...epaperExamples,
  ...retroIntelExamples,
  ...robotDesktopExamples,
  ...microsdExamples,
  ...infraredExamples,
  ...esp32MqttExamples,
  ...esp32s3TftExamples,
  ...jsemuChipExamples,
];

// Get examples by category
export function getExamplesByCategory(category: ExampleProject['category']): ExampleProject[] {
  return exampleProjects.filter((example) => example.category === category);
}

// Get example by ID
export function getExampleById(id: string): ExampleProject | undefined {
  return exampleProjects.find((example) => example.id === id);
}

/**
 * Overlay seam: a private build can append gallery examples for the boards it
 * registers at runtime. Push-based (the exported array is the single source
 * the gallery and /example/:slug both read), idempotent per example id.
 */
let proExamplesVersion = 0;
const proExamplesListeners = new Set<() => void>();

export function registerProExamples(examples: ExampleProject[]): void {
  for (const ex of examples) {
    if (!exampleProjects.some((e) => e.id === ex.id)) exampleProjects.push(ex);
  }
  // Overlay registration can land AFTER a direct-URL page render resolved the
  // array (the @pro import is dynamic) — notify subscribers so example pages
  // re-render instead of sticking on a 404 (same contract as proRoutes).
  proExamplesVersion++;
  for (const l of proExamplesListeners) l();
}

export function subscribeProExamples(cb: () => void): () => void {
  proExamplesListeners.add(cb);
  return () => proExamplesListeners.delete(cb);
}

/**
 * Has the pro overlay had its chance to register examples?
 *
 * A direct link to a PRO example (/example/pi5-opencv-vision) races the
 * overlay's dynamic import: the page resolves the gallery before
 * registerProExamples has run, concluded "not found", and flashed a 404 —
 * full marketing header included — before re-rendering into the editor.
 * The page needs to distinguish "not in the gallery" from "not in the
 * gallery YET". main.tsx flips this: immediately when no overlay is
 * configured, otherwise when the overlay's import settles (either way).
 */
let proExamplesSettled = false;

export function markProExamplesSettled(): void {
  if (proExamplesSettled) return;
  proExamplesSettled = true;
  proExamplesVersion++;
  for (const l of proExamplesListeners) l();
}

export function areProExamplesSettled(): boolean {
  return proExamplesSettled;
}

export function getProExamplesVersion(): number {
  return proExamplesVersion;
}

// Get all categories
export function getCategories(): ExampleProject['category'][] {
  return ['basics', 'sensors', 'displays', 'communication', 'games', 'robotics'];
}

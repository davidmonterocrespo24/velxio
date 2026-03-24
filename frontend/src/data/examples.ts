/**
 * Arduino Example Projects
 *
 * Collection of example projects that users can load and run
 */

/** Per-board setup for multi-board examples */
export interface ExampleBoard {
  /** Must match a BoardKind — determines the board instance ID (first board of a kind → boardKind string) */
  boardKind: string;
  x: number;
  y: number;
  /** Arduino/firmware code loaded into this board's file group */
  code?: string;
  /** Files pre-loaded into the Pi VFS (path → content). Only used for raspberry-pi-3. */
  vfsFiles?: Record<string, string>;
}

export interface ExampleProject {
  id: string;
  title: string;
  description: string;
  category: 'basics' | 'sensors' | 'displays' | 'communication' | 'games' | 'robotics';
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  /** Target board — defaults to 'arduino-uno' if omitted. Ignored when boards[] is set. */
  boardType?: 'arduino-uno' | 'arduino-nano' | 'arduino-mega' | 'raspberry-pi-pico' | 'esp32' | 'esp32-c3';
  /** Board filter key used in the gallery board selector. Derived from boardType if omitted. */
  boardFilter?: string;
  /**
   * Multi-board setup. When present, ALL boards are replaced with these entries.
   * Board instance IDs are deterministic: first board of a kind uses boardKind as its ID.
   * Wire componentIds reference these IDs directly.
   */
  boards?: ExampleBoard[];
  /** Code for single-board examples (ignored when boards[] is set) */
  code: string;
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

export const exampleProjects: ExampleProject[] = [
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
        x: 400,
        y: 100,
        properties: { color: 'red', pin: 13 },
      },
      {
        type: 'wokwi-led',
        id: 'led-yellow',
        x: 400,
        y: 200,
        properties: { color: 'yellow', pin: 12 },
      },
      {
        type: 'wokwi-led',
        id: 'led-green',
        x: 400,
        y: 300,
        properties: { color: 'green', pin: 11 },
      },
    ],
    wires: [
      {
        id: 'wire-red',
        start: { componentId: 'arduino-uno', pinName: '13' },
        end: { componentId: 'led-red', pinName: 'A' },
        color: '#ff0000',
      },
      {
        id: 'wire-yellow',
        start: { componentId: 'arduino-uno', pinName: '12' },
        end: { componentId: 'led-yellow', pinName: 'A' },
        color: '#ffaa00',
      },
      {
        id: 'wire-green',
        start: { componentId: 'arduino-uno', pinName: '11' },
        end: { componentId: 'led-green', pinName: 'A' },
        color: '#00ff00',
      },
      { id: 'wire-red-gnd',    start: { componentId: 'led-red',    pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'wire-yellow-gnd', start: { componentId: 'led-yellow', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'wire-green-gnd',  start: { componentId: 'led-green',  pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
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
        x: 400,
        y: 250,
        properties: { color: 'red', pin: 13 },
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
        id: 'wire-led',
        start: { componentId: 'arduino-uno', pinName: '13' },
        end: { componentId: 'led-1', pinName: 'A' },
        color: '#ff0000',
      },
      { id: 'wire-led-gnd',    start: { componentId: 'led-1',    pinName: 'C'   }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'wire-button-gnd', start: { componentId: 'button-1', pinName: '2.l' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
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
        x: 400,
        y: 150,
        properties: { color: 'blue', pin: 9 },
      },
    ],
    wires: [
      {
        id: 'wire-led',
        start: { componentId: 'arduino-uno', pinName: '9' },
        end: { componentId: 'led-1', pinName: 'A' },
        color: '#0000ff',
      },
      { id: 'wire-led-gnd', start: { componentId: 'led-1', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
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
        end: { componentId: 'rgb-led-1', pinName: 'R' },
        color: '#ff0000',
      },
      {
        id: 'wire-green',
        start: { componentId: 'arduino-uno', pinName: '10' },
        end: { componentId: 'rgb-led-1', pinName: 'G' },
        color: '#00ff00',
      },
      {
        id: 'wire-blue',
        start: { componentId: 'arduino-uno', pinName: '11' },
        end: { componentId: 'rgb-led-1', pinName: 'B' },
        color: '#0000ff',
      },
      { id: 'wire-rgb-gnd', start: { componentId: 'rgb-led-1', pinName: 'COM' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
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
        x: 450,
        y: 100,
        properties: { color: 'red', pin: 8 },
      },
      {
        type: 'wokwi-led',
        id: 'led-green',
        x: 550,
        y: 100,
        properties: { color: 'green', pin: 9 },
      },
      {
        type: 'wokwi-led',
        id: 'led-blue',
        x: 450,
        y: 200,
        properties: { color: 'blue', pin: 10 },
      },
      {
        type: 'wokwi-led',
        id: 'led-yellow',
        x: 550,
        y: 200,
        properties: { color: 'yellow', pin: 11 },
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
        id: 'wire-led-red',
        start: { componentId: 'arduino-uno', pinName: '8' },
        end: { componentId: 'led-red', pinName: 'A' },
        color: '#ff0000',
      },
      {
        id: 'wire-led-green',
        start: { componentId: 'arduino-uno', pinName: '9' },
        end: { componentId: 'led-green', pinName: 'A' },
        color: '#00ff00',
      },
      {
        id: 'wire-led-blue',
        start: { componentId: 'arduino-uno', pinName: '10' },
        end: { componentId: 'led-blue', pinName: 'A' },
        color: '#0000ff',
      },
      {
        id: 'wire-led-yellow',
        start: { componentId: 'arduino-uno', pinName: '11' },
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
      { id: 'wire-led-red-gnd',    start: { componentId: 'led-red',    pinName: 'C'   }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'wire-led-green-gnd',  start: { componentId: 'led-green',  pinName: 'C'   }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'wire-led-blue-gnd',   start: { componentId: 'led-blue',   pinName: 'C'   }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'wire-led-yellow-gnd', start: { componentId: 'led-yellow', pinName: 'C'   }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'wire-btn-red-gnd',    start: { componentId: 'button-red',    pinName: '2.l' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'wire-btn-green-gnd',  start: { componentId: 'button-green',  pinName: '2.l' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'wire-btn-blue-gnd',   start: { componentId: 'button-blue',   pinName: '2.l' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'wire-btn-yellow-gnd', start: { componentId: 'button-yellow', pinName: '2.l' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
    ],
  },
  {
    id: 'tft-display',
    title: 'TFT ILI9341 Display',
    description: 'Color TFT display demo: fills, text, and a bouncing ball animation using the Adafruit ILI9341 library (240x320)',
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
      { id: 'w-sck',  start: { componentId: 'arduino-uno', pinName: '13' }, end: { componentId: 'tft1', pinName: 'SCK'  }, color: '#ff8800' },
      { id: 'w-mosi', start: { componentId: 'arduino-uno', pinName: '11' }, end: { componentId: 'tft1', pinName: 'MOSI' }, color: '#ff8800' },
      { id: 'w-cs',   start: { componentId: 'arduino-uno', pinName: '10' }, end: { componentId: 'tft1', pinName: 'CS'   }, color: '#00aaff' },
      { id: 'w-dc',   start: { componentId: 'arduino-uno', pinName: '9'  }, end: { componentId: 'tft1', pinName: 'D/C'  }, color: '#00cc00' },
      { id: 'w-rst',  start: { componentId: 'arduino-uno', pinName: '8'  }, end: { componentId: 'tft1', pinName: 'RST'  }, color: '#cc0000' },
      { id: 'w-led',  start: { componentId: 'arduino-uno', pinName: '7'  }, end: { componentId: 'tft1', pinName: 'LED'  }, color: '#ffffff' },
    ],
  },
  {
    id: 'lcd-hello',
    title: 'LCD 20x4 Display',
    description: 'Display text on a 20x4 LCD using the LiquidCrystal library',
    category: 'displays',
    difficulty: 'intermediate',
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
      { id: 'w-rs', start: { componentId: 'arduino-uno', pinName: '12' }, end: { componentId: 'lcd1', pinName: 'RS' }, color: 'green' },
      { id: 'w-en', start: { componentId: 'arduino-uno', pinName: '11' }, end: { componentId: 'lcd1', pinName: 'E' }, color: 'green' },
      { id: 'w-d4', start: { componentId: 'arduino-uno', pinName: '5' }, end: { componentId: 'lcd1', pinName: 'D4' }, color: 'blue' },
      { id: 'w-d5', start: { componentId: 'arduino-uno', pinName: '4' }, end: { componentId: 'lcd1', pinName: 'D5' }, color: 'blue' },
      { id: 'w-d6', start: { componentId: 'arduino-uno', pinName: '3' }, end: { componentId: 'lcd1', pinName: 'D6' }, color: 'blue' },
      { id: 'w-d7', start: { componentId: 'arduino-uno', pinName: '2' }, end: { componentId: 'lcd1', pinName: 'D7' }, color: 'blue' },
      // Power / Contrast logic is usually handled internally or ignored in basic simulation
    ],
  },
  // ─── Protocol Test Examples ──────────────────────────────────────────────
  {
    id: 'serial-echo',
    title: 'Serial Echo (USART)',
    description: 'Tests Serial communication: echoes typed characters back and prints status. Open the Serial Monitor to interact.',
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
    components: [
      { type: 'wokwi-arduino-uno', id: 'arduino-uno', x: 100, y: 100, properties: {} },
    ],
    wires: [],
  },
  {
    id: 'serial-led-control',
    title: 'Serial LED Control',
    description: 'Control an LED via Serial commands: send "1" or "0". Tests USART RX + GPIO output together.',
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
      { type: 'wokwi-arduino-uno', id: 'arduino-uno', x: 100, y: 100, properties: {} },
      { type: 'wokwi-led', id: 'led-1', x: 400, y: 120, properties: { color: 'green' } },
    ],
    wires: [
      { id: 'w-led', start: { componentId: 'arduino-uno', pinName: '13' }, end: { componentId: 'led-1', pinName: 'A' }, color: '#00cc00' },
      { id: 'w-led-gnd', start: { componentId: 'led-1', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
    ],
  },
  {
    id: 'i2c-scanner',
    title: 'I2C Scanner (TWI)',
    description: 'Scans the I2C bus and reports all devices found. SSD1306 OLED (0x3C) is wired on canvas; virtual devices at 0x48, 0x50, 0x68 also respond.',
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
      { type: 'wokwi-ssd1306', id: 'ssd1306-1', x: 420, y: 120, properties: {} },
    ],
    wires: [
      { id: 'wire-sda',  start: { componentId: 'arduino-uno', pinName: 'A4' },   end: { componentId: 'ssd1306-1', pinName: 'DATA' }, color: '#2196f3' },
      { id: 'wire-scl',  start: { componentId: 'arduino-uno', pinName: 'A5' },   end: { componentId: 'ssd1306-1', pinName: 'CLK'  }, color: '#ff9800' },
      { id: 'wire-gnd',  start: { componentId: 'arduino-uno', pinName: 'GND.1' }, end: { componentId: 'ssd1306-1', pinName: 'GND'  }, color: '#000000' },
      { id: 'wire-vcc',  start: { componentId: 'arduino-uno', pinName: '5V' },   end: { componentId: 'ssd1306-1', pinName: 'VIN'  }, color: '#ff0000' },
    ],
  },
  {
    id: 'i2c-rtc-read',
    title: 'I2C RTC Clock (DS1307)',
    description: 'Reads time from a virtual DS1307 RTC via I2C and prints it to Serial. Tests TWI read transactions.',
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
    ],
    wires: [],
  },
  {
    id: 'i2c-eeprom-rw',
    title: 'I2C EEPROM Read/Write',
    description: 'Writes data to a virtual I2C EEPROM (0x50) and reads it back. Tests TWI write+read transactions.',
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
    components: [
      { type: 'wokwi-arduino-uno', id: 'arduino-uno', x: 100, y: 100, properties: {} },
    ],
    wires: [],
  },
  {
    id: 'spi-loopback',
    title: 'SPI Loopback Test',
    description: 'Tests SPI by sending bytes and reading responses. Demonstrates MOSI/MISO/SCK/SS protocol.',
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
    components: [
      { type: 'wokwi-arduino-uno', id: 'arduino-uno', x: 100, y: 100, properties: {} },
    ],
    wires: [],
  },
  {
    id: 'multi-protocol',
    title: 'Multi-Protocol Demo',
    description: 'Uses Serial + I2C + SPI together. Reads RTC via I2C, sends SPI data, and logs everything to Serial.',
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
    components: [
      { type: 'wokwi-arduino-uno', id: 'arduino-uno', x: 100, y: 100, properties: {} },
    ],
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
      { type: 'wokwi-resistor', id: 'r1', x: 400, y: 200, properties: { resistance: '220' } },
    ],
    wires: [
      { id: 'w1', start: { componentId: 'nano-rp2040', pinName: 'D2' }, end: { componentId: 'led-blink', pinName: 'A' }, color: '#00cc00' },
      { id: 'w2', start: { componentId: 'led-blink', pinName: 'C' }, end: { componentId: 'r1', pinName: '1' }, color: '#999999' },
      { id: 'w3', start: { componentId: 'r1', pinName: '2' }, end: { componentId: 'nano-rp2040', pinName: 'GND.1' }, color: '#000000' },
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
      { type: 'wokwi-led', id: 'led-rx', x: 400, y: 120, properties: { color: 'yellow' } },
    ],
    wires: [
      { id: 'w1', start: { componentId: 'nano-rp2040', pinName: 'TX' }, end: { componentId: 'led-rx', pinName: 'A' }, color: '#ff8800' },
      { id: 'w2', start: { componentId: 'led-rx', pinName: 'C' }, end: { componentId: 'nano-rp2040', pinName: 'GND.1' }, color: '#000000' },
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
      { type: 'wokwi-resistor', id: 'r1', x: 400, y: 200, properties: { resistance: '220' } },
    ],
    wires: [
      { id: 'w1', start: { componentId: 'nano-rp2040', pinName: 'D2' }, end: { componentId: 'led-status', pinName: 'A' }, color: '#00cc00' },
      { id: 'w2', start: { componentId: 'led-status', pinName: 'C' }, end: { componentId: 'r1', pinName: '1' }, color: '#999999' },
      { id: 'w3', start: { componentId: 'r1', pinName: '2' }, end: { componentId: 'nano-rp2040', pinName: 'GND.1' }, color: '#000000' },
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
      { type: 'wokwi-led', id: 'led-scan', x: 400, y: 100, properties: { color: 'blue' } },
      { type: 'wokwi-led', id: 'led-found', x: 400, y: 180, properties: { color: 'green' } },
    ],
    wires: [
      { id: 'w1', start: { componentId: 'nano-rp2040', pinName: 'D12' }, end: { componentId: 'led-scan', pinName: 'A' }, color: '#4488ff' },
      { id: 'w2', start: { componentId: 'nano-rp2040', pinName: 'D10' }, end: { componentId: 'led-found', pinName: 'A' }, color: '#00cc00' },
      { id: 'w3', start: { componentId: 'led-scan',  pinName: 'C' }, end: { componentId: 'nano-rp2040', pinName: 'GND.1' }, color: '#000000' },
      { id: 'w4', start: { componentId: 'led-found', pinName: 'C' }, end: { componentId: 'nano-rp2040', pinName: 'GND.1' }, color: '#000000' },
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
      { type: 'wokwi-led', id: 'led-i2c', x: 400, y: 100, properties: { color: 'blue' } },
      { type: 'wokwi-led', id: 'led-rtc', x: 400, y: 180, properties: { color: 'yellow' } },
    ],
    wires: [
      { id: 'w-sda', start: { componentId: 'nano-rp2040', pinName: 'D12' }, end: { componentId: 'led-i2c', pinName: 'A' }, color: '#4488ff' },
      { id: 'w-scl', start: { componentId: 'nano-rp2040', pinName: 'D10' }, end: { componentId: 'led-rtc', pinName: 'A' }, color: '#ffaa00' },
      { id: 'w-sda-gnd', start: { componentId: 'led-i2c', pinName: 'C' }, end: { componentId: 'nano-rp2040', pinName: 'GND.1' }, color: '#000000' },
      { id: 'w-scl-gnd', start: { componentId: 'led-rtc', pinName: 'C' }, end: { componentId: 'nano-rp2040', pinName: 'GND.1' }, color: '#000000' },
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
      { type: 'wokwi-led', id: 'led-write', x: 400, y: 100, properties: { color: 'red' } },
      { type: 'wokwi-led', id: 'led-read', x: 400, y: 180, properties: { color: 'green' } },
    ],
    wires: [
      { id: 'w-sda', start: { componentId: 'nano-rp2040', pinName: 'D12' }, end: { componentId: 'led-write', pinName: 'A' }, color: '#ff4444' },
      { id: 'w-scl', start: { componentId: 'nano-rp2040', pinName: 'D10' }, end: { componentId: 'led-read', pinName: 'A' }, color: '#00cc00' },
      { id: 'w-write-gnd', start: { componentId: 'led-write', pinName: 'C' }, end: { componentId: 'nano-rp2040', pinName: 'GND.1' }, color: '#000000' },
      { id: 'w-read-gnd',  start: { componentId: 'led-read',  pinName: 'C' }, end: { componentId: 'nano-rp2040', pinName: 'GND.1' }, color: '#000000' },
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
      { type: 'wokwi-led', id: 'led-mosi', x: 400, y: 100, properties: { color: 'red' } },
      { type: 'wokwi-led', id: 'led-miso', x: 400, y: 180, properties: { color: 'green' } },
      { type: 'wokwi-led', id: 'led-sck', x: 400, y: 260, properties: { color: 'yellow' } },
    ],
    wires: [
      { id: 'w-mosi', start: { componentId: 'nano-rp2040', pinName: 'D7' }, end: { componentId: 'led-mosi', pinName: 'A' }, color: '#ff4444' },
      { id: 'w-miso', start: { componentId: 'nano-rp2040', pinName: 'D4' }, end: { componentId: 'led-miso', pinName: 'A' }, color: '#00cc00' },
      { id: 'w-sck', start: { componentId: 'nano-rp2040', pinName: 'D6' }, end: { componentId: 'led-sck', pinName: 'A' }, color: '#ffaa00' },
      { id: 'w-mosi-gnd', start: { componentId: 'led-mosi', pinName: 'C' }, end: { componentId: 'nano-rp2040', pinName: 'GND.1' }, color: '#000000' },
      { id: 'w-miso-gnd', start: { componentId: 'led-miso', pinName: 'C' }, end: { componentId: 'nano-rp2040', pinName: 'GND.1' }, color: '#000000' },
      { id: 'w-sck-gnd',  start: { componentId: 'led-sck',  pinName: 'C' }, end: { componentId: 'nano-rp2040', pinName: 'GND.1' }, color: '#000000' },
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
      { type: 'wokwi-potentiometer', id: 'pot-a0', x: 400, y: 80, properties: {} },
      { type: 'wokwi-potentiometer', id: 'pot-a1', x: 400, y: 200, properties: {} },
      { type: 'wokwi-led', id: 'led-temp', x: 400, y: 320, properties: { color: 'red' } },
    ],
    wires: [
      { id: 'w-a0', start: { componentId: 'nano-rp2040', pinName: 'A0' }, end: { componentId: 'pot-a0', pinName: 'SIG' }, color: '#4488ff' },
      { id: 'w-a1', start: { componentId: 'nano-rp2040', pinName: 'A1' }, end: { componentId: 'pot-a1', pinName: 'SIG' }, color: '#44cc44' },
      { id: 'w-temp', start: { componentId: 'nano-rp2040', pinName: 'D2' }, end: { componentId: 'led-temp', pinName: 'A' }, color: '#ff4444' },
      { id: 'w-pot-a0-vcc', start: { componentId: 'nano-rp2040', pinName: '3V3' },  end: { componentId: 'pot-a0', pinName: 'VCC' }, color: '#ff0000' },
      { id: 'w-pot-a0-gnd', start: { componentId: 'nano-rp2040', pinName: 'GND.1' }, end: { componentId: 'pot-a0', pinName: 'GND' }, color: '#000000' },
      { id: 'w-pot-a1-vcc', start: { componentId: 'nano-rp2040', pinName: '3V3' },  end: { componentId: 'pot-a1', pinName: 'VCC' }, color: '#ff0000' },
      { id: 'w-pot-a1-gnd', start: { componentId: 'nano-rp2040', pinName: 'GND.1' }, end: { componentId: 'pot-a1', pinName: 'GND' }, color: '#000000' },
      { id: 'w-temp-gnd',   start: { componentId: 'led-temp',    pinName: 'C'   },   end: { componentId: 'nano-rp2040', pinName: 'GND.1' }, color: '#000000' },
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
      { type: 'wokwi-led', id: 'led-i2c', x: 400, y: 80, properties: { color: 'blue' } },
      { type: 'wokwi-led', id: 'led-spi', x: 400, y: 160, properties: { color: 'yellow' } },
      { type: 'wokwi-potentiometer', id: 'pot-adc', x: 400, y: 240, properties: {} },
      { type: 'wokwi-led', id: 'led-gpio', x: 400, y: 360, properties: { color: 'green' } },
    ],
    wires: [
      { id: 'w-i2c', start: { componentId: 'nano-rp2040', pinName: 'D12' }, end: { componentId: 'led-i2c', pinName: 'A' }, color: '#4488ff' },
      { id: 'w-spi', start: { componentId: 'nano-rp2040', pinName: 'D7' }, end: { componentId: 'led-spi', pinName: 'A' }, color: '#ffaa00' },
      { id: 'w-adc', start: { componentId: 'nano-rp2040', pinName: 'A0' }, end: { componentId: 'pot-adc', pinName: 'SIG' }, color: '#cc44cc' },
      { id: 'w-gpio', start: { componentId: 'nano-rp2040', pinName: 'D2' }, end: { componentId: 'led-gpio', pinName: 'A' }, color: '#00cc00' },
      { id: 'w-i2c-gnd',     start: { componentId: 'led-i2c',  pinName: 'C'   }, end: { componentId: 'nano-rp2040', pinName: 'GND.1' }, color: '#000000' },
      { id: 'w-spi-gnd',     start: { componentId: 'led-spi',  pinName: 'C'   }, end: { componentId: 'nano-rp2040', pinName: 'GND.1' }, color: '#000000' },
      { id: 'w-gpio-gnd',    start: { componentId: 'led-gpio', pinName: 'C'   }, end: { componentId: 'nano-rp2040', pinName: 'GND.1' }, color: '#000000' },
      { id: 'w-pot-adc-vcc', start: { componentId: 'nano-rp2040', pinName: '3V3'   }, end: { componentId: 'pot-adc', pinName: 'VCC' }, color: '#ff0000' },
      { id: 'w-pot-adc-gnd', start: { componentId: 'nano-rp2040', pinName: 'GND.1' }, end: { componentId: 'pot-adc', pinName: 'GND' }, color: '#000000' },
    ],
  },
  // ─── ESP32 Examples ───────────────────────────────────────────────────────
  {
    id: 'esp32-blink-led',
    title: 'ESP32 Blink LED',
    description: 'Blink the built-in LED on GPIO2 and an external red LED on GPIO4. Verifies ESP32 emulation is working.',
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
      { type: 'wokwi-led', id: 'led-ext', x: 460, y: 190, properties: { color: 'red' } },
    ],
    wires: [
      // GPIO4 → LED anode
      { id: 'w-gpio4-led', start: { componentId: 'esp32', pinName: '4' }, end: { componentId: 'led-ext', pinName: 'A' }, color: '#e74c3c' },
      // LED cathode → GND
      { id: 'w-gnd',       start: { componentId: 'led-ext', pinName: 'C' }, end: { componentId: 'esp32', pinName: 'GND' }, color: '#2c3e50' },
    ],
  },
  {
    id: 'esp32-serial-echo',
    title: 'ESP32 Serial Echo',
    description: 'ESP32 reads from Serial and echoes back. Demonstrates multi-UART and Serial Monitor integration.',
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
    description: 'Raspberry Pi 3B controls two LEDs on an Arduino Uno via UART serial. Pi sends commands (LED1_ON, LED2_ON…) from a Python script; Arduino parses them and drives the LEDs.',
    category: 'communication',
    difficulty: 'advanced',
    code: '',   // unused — each board has its own code in boards[]
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
      { type: 'wokwi-led',      id: 'led1',  x: 840, y: 100, properties: { color: 'red'   } },
      { type: 'wokwi-resistor', id: 'res1',  x: 840, y: 200, properties: { resistance: '220' } },
      // Green LED + 220Ω resistor for LED2 (Arduino pin 9)
      { type: 'wokwi-led',      id: 'led2',  x: 840, y: 320, properties: { color: 'green' } },
      { type: 'wokwi-resistor', id: 'res2',  x: 840, y: 420, properties: { resistance: '220' } },
    ],
    wires: [
      // ── Serial UART cross-connection ──────────────────────────────────────
      // Pi GPIO14 (TX) → Arduino pin 0 (RX)
      { id: 'w-uart-tx', start: { componentId: 'raspberry-pi-3', pinName: 'GPIO14' }, end: { componentId: 'arduino-uno', pinName: '0' }, color: '#ff8800' },
      // Arduino pin 1 (TX) → Pi GPIO15 (RX)
      { id: 'w-uart-rx', start: { componentId: 'arduino-uno', pinName: '1' }, end: { componentId: 'raspberry-pi-3', pinName: 'GPIO15' }, color: '#00aaff' },
      // Common GND
      { id: 'w-gnd', start: { componentId: 'raspberry-pi-3', pinName: 'GND' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },

      // ── LED 1 (Red) — Arduino pin 8 → res1 → led1 → GND ─────────────────
      { id: 'w-led1-sig', start: { componentId: 'arduino-uno', pinName: '8' },  end: { componentId: 'res1', pinName: '1' }, color: '#ff2222' },
      { id: 'w-led1-mid', start: { componentId: 'res1', pinName: '2' },          end: { componentId: 'led1', pinName: 'A'  }, color: '#ff2222' },
      { id: 'w-led1-gnd', start: { componentId: 'led1', pinName: 'C' },          end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },

      // ── LED 2 (Green) — Arduino pin 9 → res2 → led2 → GND ───────────────
      { id: 'w-led2-sig', start: { componentId: 'arduino-uno', pinName: '9' },  end: { componentId: 'res2', pinName: '1' }, color: '#22cc22' },
      { id: 'w-led2-mid', start: { componentId: 'res2', pinName: '2' },          end: { componentId: 'led2', pinName: 'A'  }, color: '#22cc22' },
      { id: 'w-led2-gnd', start: { componentId: 'led2', pinName: 'C' },          end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
    ],
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
    ],
    wires: [
      { id: 'w-btn', start: { componentId: 'arduino-uno', pinName: '2' }, end: { componentId: 'btn1', pinName: '1a' }, color: '#00aaff' },
      { id: 'w-led', start: { componentId: 'arduino-uno', pinName: '13' }, end: { componentId: 'led1', pinName: 'A' }, color: '#ff4444' },
      { id: 'w-led-gnd', start: { componentId: 'led1',  pinName: 'C'  }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'w-btn-gnd', start: { componentId: 'btn1',  pinName: '1b' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
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
      { type: 'wokwi-resistor', id: 'r-fade', x: 420, y: 240, properties: { resistance: '220' } },
    ],
    wires: [
      { id: 'w-fade', start: { componentId: 'arduino-uno', pinName: '9' }, end: { componentId: 'led-fade', pinName: 'A' }, color: '#2244ff' },
      { id: 'w-fade-r', start: { componentId: 'led-fade', pinName: 'C' }, end: { componentId: 'r-fade', pinName: '1' }, color: '#888888' },
      { id: 'w-fade-gnd', start: { componentId: 'r-fade', pinName: '2' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
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
    description: 'Knight-Rider style LED chase across 8 LEDs on pins 2–9. Shows off the Mega\'s many I/O pins.',
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
      { type: 'wokwi-led', id: 'led2', x: 420, y:  80, properties: { color: 'red' } },
      { type: 'wokwi-led', id: 'led3', x: 460, y:  80, properties: { color: 'orange' } },
      { type: 'wokwi-led', id: 'led4', x: 500, y:  80, properties: { color: 'yellow' } },
      { type: 'wokwi-led', id: 'led5', x: 540, y:  80, properties: { color: 'green' } },
      { type: 'wokwi-led', id: 'led6', x: 580, y:  80, properties: { color: 'blue' } },
      { type: 'wokwi-led', id: 'led7', x: 620, y:  80, properties: { color: 'purple' } },
      { type: 'wokwi-led', id: 'led8', x: 660, y:  80, properties: { color: 'white' } },
      { type: 'wokwi-led', id: 'led9', x: 700, y:  80, properties: { color: 'red' } },
    ],
    wires: [
      { id: 'w2', start: { componentId: 'arduino-uno', pinName: '2' }, end: { componentId: 'led2', pinName: 'A' }, color: '#ff2222' },
      { id: 'w3', start: { componentId: 'arduino-uno', pinName: '3' }, end: { componentId: 'led3', pinName: 'A' }, color: '#ff8800' },
      { id: 'w4', start: { componentId: 'arduino-uno', pinName: '4' }, end: { componentId: 'led4', pinName: 'A' }, color: '#ffcc00' },
      { id: 'w5', start: { componentId: 'arduino-uno', pinName: '5' }, end: { componentId: 'led5', pinName: 'A' }, color: '#22bb22' },
      { id: 'w6', start: { componentId: 'arduino-uno', pinName: '6' }, end: { componentId: 'led6', pinName: 'A' }, color: '#2244ff' },
      { id: 'w7', start: { componentId: 'arduino-uno', pinName: '7' }, end: { componentId: 'led7', pinName: 'A' }, color: '#aa44ff' },
      { id: 'w8', start: { componentId: 'arduino-uno', pinName: '8' }, end: { componentId: 'led8', pinName: 'A' }, color: '#ffffff' },
      { id: 'w9', start: { componentId: 'arduino-uno', pinName: '9' }, end: { componentId: 'led9', pinName: 'A' }, color: '#ff2222' },
      { id: 'w2-gnd', start: { componentId: 'led2', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'w3-gnd', start: { componentId: 'led3', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'w4-gnd', start: { componentId: 'led4', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'w5-gnd', start: { componentId: 'led5', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'w6-gnd', start: { componentId: 'led6', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'w7-gnd', start: { componentId: 'led7', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'w8-gnd', start: { componentId: 'led8', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'w9-gnd', start: { componentId: 'led9', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
    ],
  },
  {
    id: 'mega-serial-control',
    title: 'Mega: Serial LED Control',
    description: 'Send \'1\'–\'8\' over Serial to toggle individual LEDs on the Arduino Mega.',
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
      { type: 'wokwi-led', id: 'mled2', x: 420, y:  80, properties: { color: 'red' } },
      { type: 'wokwi-led', id: 'mled3', x: 460, y:  80, properties: { color: 'orange' } },
      { type: 'wokwi-led', id: 'mled4', x: 500, y:  80, properties: { color: 'yellow' } },
      { type: 'wokwi-led', id: 'mled5', x: 540, y:  80, properties: { color: 'green' } },
      { type: 'wokwi-led', id: 'mled6', x: 580, y:  80, properties: { color: 'blue' } },
      { type: 'wokwi-led', id: 'mled7', x: 620, y:  80, properties: { color: 'purple' } },
      { type: 'wokwi-led', id: 'mled8', x: 660, y:  80, properties: { color: 'white' } },
      { type: 'wokwi-led', id: 'mled9', x: 700, y:  80, properties: { color: 'red' } },
    ],
    wires: [
      { id: 'mw2', start: { componentId: 'arduino-uno', pinName: '2' }, end: { componentId: 'mled2', pinName: 'A' }, color: '#ff2222' },
      { id: 'mw3', start: { componentId: 'arduino-uno', pinName: '3' }, end: { componentId: 'mled3', pinName: 'A' }, color: '#ff8800' },
      { id: 'mw4', start: { componentId: 'arduino-uno', pinName: '4' }, end: { componentId: 'mled4', pinName: 'A' }, color: '#ffcc00' },
      { id: 'mw5', start: { componentId: 'arduino-uno', pinName: '5' }, end: { componentId: 'mled5', pinName: 'A' }, color: '#22bb22' },
      { id: 'mw6', start: { componentId: 'arduino-uno', pinName: '6' }, end: { componentId: 'mled6', pinName: 'A' }, color: '#2244ff' },
      { id: 'mw7', start: { componentId: 'arduino-uno', pinName: '7' }, end: { componentId: 'mled7', pinName: 'A' }, color: '#aa44ff' },
      { id: 'mw8', start: { componentId: 'arduino-uno', pinName: '8' }, end: { componentId: 'mled8', pinName: 'A' }, color: '#ffffff' },
      { id: 'mw9', start: { componentId: 'arduino-uno', pinName: '9' }, end: { componentId: 'mled9', pinName: 'A' }, color: '#ff2222' },
      { id: 'mw2-gnd', start: { componentId: 'mled2', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'mw3-gnd', start: { componentId: 'mled3', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'mw4-gnd', start: { componentId: 'mled4', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'mw5-gnd', start: { componentId: 'mled5', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'mw6-gnd', start: { componentId: 'mled6', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'mw7-gnd', start: { componentId: 'mled7', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'mw8-gnd', start: { componentId: 'mled8', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'mw9-gnd', start: { componentId: 'mled9', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
    ],
  },

  // ─── ESP32-C3 (RISC-V browser emulator) Examples ──────────────────────────
  {
    id: 'c3-blink',
    title: 'ESP32-C3: Blink LED',
    description: 'Blink an LED on GPIO 8 of the ESP32-C3. Runs entirely in the browser via the RISC-V emulator — no backend needed.',
    category: 'basics',
    difficulty: 'beginner',
    boardType: 'esp32-c3',
    boardFilter: 'esp32-c3',
    code: `// ESP32-C3 — Blink LED on GPIO 8
// Runs in-browser via RV32IMC emulator (Esp32C3Simulator)

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
      { type: 'wokwi-resistor', id: 'c3-r1', x: 440, y: 240, properties: { resistance: '220' } },
    ],
    wires: [
      { id: 'c3w1', start: { componentId: 'esp32-c3', pinName: '8' }, end: { componentId: 'c3-led1', pinName: 'A' }, color: '#22cc22' },
      { id: 'c3w2', start: { componentId: 'c3-led1', pinName: 'C' }, end: { componentId: 'c3-r1', pinName: '1' }, color: '#888888' },
      { id: 'c3w3', start: { componentId: 'c3-r1', pinName: '2' }, end: { componentId: 'esp32-c3', pinName: 'GND.9' }, color: '#000000' },
    ],
  },
  {
    id: 'c3-serial',
    title: 'ESP32-C3: Serial Hello',
    description: 'Print Hello World and a heartbeat every second from ESP32-C3 via Serial. Runs in the browser.',
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
  Serial.println("RV32IMC @ 160 MHz — browser emulator");
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
    description: 'Cycle through red, green, and blue on an RGB LED using GPIO 6, 7, 8 on the ESP32-C3.',
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
      { type: 'wokwi-rgb-led', id: 'c3-rgb1', x: 440, y: 160, properties: {} },
    ],
    wires: [
      { id: 'c3-rw1', start: { componentId: 'esp32-c3', pinName: '6' }, end: { componentId: 'c3-rgb1', pinName: 'R' }, color: '#ff2222' },
      { id: 'c3-rw2', start: { componentId: 'esp32-c3', pinName: '7' }, end: { componentId: 'c3-rgb1', pinName: 'G' }, color: '#22cc22' },
      { id: 'c3-rw3', start: { componentId: 'esp32-c3', pinName: '8' }, end: { componentId: 'c3-rgb1', pinName: 'B' }, color: '#2244ff' },
      { id: 'c3-rw4', start: { componentId: 'c3-rgb1', pinName: 'COM' }, end: { componentId: 'esp32-c3', pinName: 'GND.8' }, color: '#000000' },
    ],
  },
  {
    id: 'c3-button',
    title: 'ESP32-C3: Button + LED',
    description: 'Press a button on GPIO 9 to toggle an LED on GPIO 8. Tests GPIO input on the browser ESP32-C3 emulator.',
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
      { type: 'wokwi-led', id: 'c3-led-btn', x: 440, y: 260, properties: { color: 'blue' } },
    ],
    wires: [
      { id: 'c3-bw1', start: { componentId: 'esp32-c3', pinName: '9'  }, end: { componentId: 'c3-btn1',    pinName: '1a' }, color: '#00aaff' },
      { id: 'c3-bw2', start: { componentId: 'esp32-c3', pinName: '8'  }, end: { componentId: 'c3-led-btn', pinName: 'A'  }, color: '#2244ff' },
      { id: 'c3-bw3', start: { componentId: 'c3-led-btn', pinName: 'C'  }, end: { componentId: 'esp32-c3', pinName: 'GND.8' }, color: '#000000' },
      { id: 'c3-bw4', start: { componentId: 'c3-btn1',    pinName: '1b' }, end: { componentId: 'esp32-c3', pinName: 'GND.9' }, color: '#000000' },
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
    description: 'Count 0–9 on a 7-segment display driven directly from pins 2–8 on the Arduino Uno.',
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
      { type: 'wokwi-7segment', id: 'seg1', x: 440, y: 140, properties: { common: 'cathode', color: 'red' } },
    ],
    wires: [
      { id: 'seg-a', start: { componentId: 'arduino-uno', pinName: '2' }, end: { componentId: 'seg1', pinName: 'A' }, color: '#ff4444' },
      { id: 'seg-b', start: { componentId: 'arduino-uno', pinName: '3' }, end: { componentId: 'seg1', pinName: 'B' }, color: '#ff8800' },
      { id: 'seg-c', start: { componentId: 'arduino-uno', pinName: '4' }, end: { componentId: 'seg1', pinName: 'C' }, color: '#ffcc00' },
      { id: 'seg-d', start: { componentId: 'arduino-uno', pinName: '5' }, end: { componentId: 'seg1', pinName: 'D' }, color: '#44cc44' },
      { id: 'seg-e', start: { componentId: 'arduino-uno', pinName: '6' }, end: { componentId: 'seg1', pinName: 'E' }, color: '#4488ff' },
      { id: 'seg-f', start: { componentId: 'arduino-uno', pinName: '7' }, end: { componentId: 'seg1', pinName: 'F' }, color: '#aa44ff' },
      { id: 'seg-g', start: { componentId: 'arduino-uno', pinName: '8' }, end: { componentId: 'seg1', pinName: 'G' }, color: '#ffffff' },
      { id: 'seg-gnd', start: { componentId: 'seg1', pinName: 'COM' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
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
      { type: 'wokwi-7segment', id: 'pico-seg1', x: 440, y: 140, properties: { common: 'cathode', color: 'green' } },
    ],
    wires: [
      { id: 'ps-a', start: { componentId: 'nano-rp2040', pinName: 'GP2' }, end: { componentId: 'pico-seg1', pinName: 'A' }, color: '#ff4444' },
      { id: 'ps-b', start: { componentId: 'nano-rp2040', pinName: 'GP3' }, end: { componentId: 'pico-seg1', pinName: 'B' }, color: '#ff8800' },
      { id: 'ps-c', start: { componentId: 'nano-rp2040', pinName: 'GP4' }, end: { componentId: 'pico-seg1', pinName: 'C' }, color: '#ffcc00' },
      { id: 'ps-d', start: { componentId: 'nano-rp2040', pinName: 'GP5' }, end: { componentId: 'pico-seg1', pinName: 'D' }, color: '#44cc44' },
      { id: 'ps-e', start: { componentId: 'nano-rp2040', pinName: 'GP6' }, end: { componentId: 'pico-seg1', pinName: 'E' }, color: '#4488ff' },
      { id: 'ps-f', start: { componentId: 'nano-rp2040', pinName: 'GP7' }, end: { componentId: 'pico-seg1', pinName: 'F' }, color: '#aa44ff' },
      { id: 'ps-g', start: { componentId: 'nano-rp2040', pinName: 'GP8' }, end: { componentId: 'pico-seg1', pinName: 'G' }, color: '#ffffff' },
      { id: 'ps-gnd', start: { componentId: 'pico-seg1', pinName: 'COM' }, end: { componentId: 'nano-rp2040', pinName: 'GND.1' }, color: '#000000' },
    ],
  },
  {
    id: 'esp32-7segment',
    title: 'ESP32: 7-Segment Counter',
    description: 'Count 0–9 on a 7-segment display driven from GPIO 12, 13, 14, 25, 26, 27, 32 on the ESP32.',
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
      { type: 'wokwi-7segment', id: 'esp-seg1', x: 440, y: 140, properties: { common: 'cathode', color: 'orange' } },
    ],
    wires: [
      { id: 'es-a',   start: { componentId: 'esp32', pinName: '12' },  end: { componentId: 'esp-seg1', pinName: 'A' },   color: '#ff4444' },
      { id: 'es-b',   start: { componentId: 'esp32', pinName: '13' },  end: { componentId: 'esp-seg1', pinName: 'B' },   color: '#ff8800' },
      { id: 'es-c',   start: { componentId: 'esp32', pinName: '14' },  end: { componentId: 'esp-seg1', pinName: 'C' },   color: '#ffcc00' },
      { id: 'es-d',   start: { componentId: 'esp32', pinName: '25' },  end: { componentId: 'esp-seg1', pinName: 'D' },   color: '#44cc44' },
      { id: 'es-e',   start: { componentId: 'esp32', pinName: '26' },  end: { componentId: 'esp-seg1', pinName: 'E' },   color: '#4488ff' },
      { id: 'es-f',   start: { componentId: 'esp32', pinName: '27' },  end: { componentId: 'esp-seg1', pinName: 'F' },   color: '#aa44ff' },
      { id: 'es-g',   start: { componentId: 'esp32', pinName: '32' },  end: { componentId: 'esp-seg1', pinName: 'G' },   color: '#ffffff' },
      { id: 'es-gnd', start: { componentId: 'esp-seg1', pinName: 'COM' }, end: { componentId: 'esp32', pinName: 'GND' }, color: '#000000' },
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
    components: [
      { type: 'wokwi-potentiometer', id: 'pot1', x: 440, y: 160, properties: {} },
    ],
    wires: [
      { id: 'w-pot-sig', start: { componentId: 'arduino-uno', pinName: 'A0' }, end: { componentId: 'pot1', pinName: 'SIG' }, color: '#aa44ff' },
      { id: 'w-pot-vcc', start: { componentId: 'arduino-uno', pinName: '5V'  }, end: { componentId: 'pot1', pinName: 'VCC' }, color: '#ff0000' },
      { id: 'w-pot-gnd', start: { componentId: 'arduino-uno', pinName: 'GND' }, end: { componentId: 'pot1', pinName: 'GND' }, color: '#000000' },
    ],
  },
  {
    id: 'uno-rgb-cycle',
    title: 'Uno: RGB LED Cycle',
    description: 'Cycle through 7 colors on an RGB LED connected to pins 9 (R), 10 (G), 11 (B) using PWM.',
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
      { type: 'wokwi-rgb-led', id: 'rgb1', x: 440, y: 160, properties: {} },
    ],
    wires: [
      { id: 'w-r', start: { componentId: 'arduino-uno', pinName: '9'  }, end: { componentId: 'rgb1', pinName: 'R' }, color: '#ff2222' },
      { id: 'w-g', start: { componentId: 'arduino-uno', pinName: '10' }, end: { componentId: 'rgb1', pinName: 'G' }, color: '#22cc22' },
      { id: 'w-b', start: { componentId: 'arduino-uno', pinName: '11' }, end: { componentId: 'rgb1', pinName: 'B' }, color: '#2244ff' },
      { id: 'w-rgb-gnd', start: { componentId: 'rgb1', pinName: 'COM' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
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
      { type: 'wokwi-led', id: 'pico-led-btn', x: 440, y: 260, properties: { color: 'yellow' } },
    ],
    wires: [
      { id: 'pb-btn', start: { componentId: 'nano-rp2040', pinName: 'GP2' }, end: { componentId: 'pico-btn1', pinName: '1a' }, color: '#00aaff' },
      { id: 'pb-led', start: { componentId: 'nano-rp2040', pinName: 'GP3' }, end: { componentId: 'pico-led-btn', pinName: 'A' }, color: '#ffcc00' },
      { id: 'pb-led-gnd', start: { componentId: 'pico-led-btn', pinName: 'C'  }, end: { componentId: 'nano-rp2040', pinName: 'GND.1' }, color: '#000000' },
      { id: 'pb-btn-gnd', start: { componentId: 'pico-btn1',    pinName: '1b' }, end: { componentId: 'nano-rp2040', pinName: 'GND.1' }, color: '#000000' },
    ],
  },
  {
    id: 'pico-rgb',
    title: 'Pico: RGB LED Cycle',
    description: 'Cycle through colors on an RGB LED using GPIO 6 (R), 7 (G), 8 (B) on the Raspberry Pi Pico.',
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
      { type: 'wokwi-rgb-led', id: 'pico-rgb1', x: 440, y: 160, properties: {} },
    ],
    wires: [
      { id: 'pr-r', start: { componentId: 'nano-rp2040', pinName: 'GP6' }, end: { componentId: 'pico-rgb1', pinName: 'R' }, color: '#ff2222' },
      { id: 'pr-g', start: { componentId: 'nano-rp2040', pinName: 'GP7' }, end: { componentId: 'pico-rgb1', pinName: 'G' }, color: '#22cc22' },
      { id: 'pr-b', start: { componentId: 'nano-rp2040', pinName: 'GP8' }, end: { componentId: 'pico-rgb1', pinName: 'B' }, color: '#2244ff' },
      { id: 'pr-gnd', start: { componentId: 'pico-rgb1', pinName: 'COM' }, end: { componentId: 'nano-rp2040', pinName: 'GND.1' }, color: '#000000' },
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
      { type: 'wokwi-dht22', id: 'uno-dht1', x: 430, y: 150, properties: { temperature: '25', humidity: '60' } },
    ],
    wires: [
      { id: 'ud-vcc', start: { componentId: 'arduino-uno', pinName: '5V'  }, end: { componentId: 'uno-dht1', pinName: 'VCC' }, color: '#ff0000' },
      { id: 'ud-gnd', start: { componentId: 'arduino-uno', pinName: 'GND' }, end: { componentId: 'uno-dht1', pinName: 'GND' }, color: '#000000' },
      { id: 'ud-sda', start: { componentId: 'arduino-uno', pinName: '7'   }, end: { componentId: 'uno-dht1', pinName: 'SDA' }, color: '#22aaff' },
    ],
  },
  {
    id: 'uno-hcsr04',
    title: 'Uno: HC-SR04 Ultrasonic Distance',
    description: 'Measure distance with an HC-SR04 ultrasonic sensor. TRIG on pin 9, ECHO on pin 10.',
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
      { id: 'us-vcc',  start: { componentId: 'arduino-uno', pinName: '5V'  }, end: { componentId: 'uno-sr1', pinName: 'VCC'  }, color: '#ff0000' },
      { id: 'us-gnd',  start: { componentId: 'arduino-uno', pinName: 'GND' }, end: { componentId: 'uno-sr1', pinName: 'GND'  }, color: '#000000' },
      { id: 'us-trig', start: { componentId: 'arduino-uno', pinName: '9'   }, end: { componentId: 'uno-sr1', pinName: 'TRIG' }, color: '#ff8800' },
      { id: 'us-echo', start: { componentId: 'arduino-uno', pinName: '10'  }, end: { componentId: 'uno-sr1', pinName: 'ECHO' }, color: '#22cc22' },
    ],
  },
  {
    id: 'uno-pir',
    title: 'Uno: PIR Motion Detector',
    description: 'Detect movement with a PIR infrared sensor on pin 4. The built-in LED on pin 13 lights up when motion is detected.',
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
      { id: 'pir-vcc', start: { componentId: 'arduino-uno', pinName: '5V'  }, end: { componentId: 'uno-pir1', pinName: 'VCC' }, color: '#ff0000' },
      { id: 'pir-gnd', start: { componentId: 'arduino-uno', pinName: 'GND' }, end: { componentId: 'uno-pir1', pinName: 'GND' }, color: '#000000' },
      { id: 'pir-out', start: { componentId: 'arduino-uno', pinName: '4'   }, end: { componentId: 'uno-pir1', pinName: 'OUT' }, color: '#ffcc00' },
    ],
  },
  {
    id: 'uno-servo',
    title: 'Uno: Servo Motor Sweep',
    description: 'Sweep a servo motor smoothly from 0° to 180° and back using pin 9 (PWM). Uses the built-in Servo library.',
    category: 'robotics',
    difficulty: 'beginner',
    boardFilter: 'arduino-uno',
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
    components: [
      { type: 'wokwi-servo', id: 'uno-sv1', x: 420, y: 150, properties: {} },
    ],
    wires: [
      { id: 'sv-vcc', start: { componentId: 'arduino-uno', pinName: '5V'  }, end: { componentId: 'uno-sv1', pinName: 'V+' }, color: '#ff0000' },
      { id: 'sv-gnd', start: { componentId: 'arduino-uno', pinName: 'GND' }, end: { componentId: 'uno-sv1', pinName: 'GND' }, color: '#000000' },
      { id: 'sv-pwm', start: { componentId: 'arduino-uno', pinName: '9'   }, end: { componentId: 'uno-sv1', pinName: 'PWM' }, color: '#ff8800' },
    ],
  },
  {
    id: 'uno-photoresistor',
    title: 'Uno: Photoresistor Light Sensor',
    description: 'Read analog light level from a photoresistor module on A0. An LED on pin 9 dims proportionally to compensate for darkness.',
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
      { type: 'wokwi-led',      id: 'uno-photo-led', x: 430, y: 280, properties: { color: 'yellow' } },
      { type: 'wokwi-resistor', id: 'uno-photo-r',   x: 430, y: 340, properties: { resistance: '220' } },
    ],
    wires: [
      { id: 'ph-vcc',   start: { componentId: 'arduino-uno',  pinName: '5V'  }, end: { componentId: 'uno-photo1',   pinName: 'VCC' }, color: '#ff0000' },
      { id: 'ph-gnd',   start: { componentId: 'arduino-uno',  pinName: 'GND' }, end: { componentId: 'uno-photo1',   pinName: 'GND' }, color: '#000000' },
      { id: 'ph-ao',    start: { componentId: 'arduino-uno',  pinName: 'A0'  }, end: { componentId: 'uno-photo1',   pinName: 'AO'  }, color: '#aa44ff' },
      { id: 'ph-led-a', start: { componentId: 'arduino-uno',  pinName: '9'   }, end: { componentId: 'uno-photo-led', pinName: 'A'  }, color: '#ffcc00' },
      { id: 'ph-led-c', start: { componentId: 'uno-photo-led', pinName: 'C'  }, end: { componentId: 'uno-photo-r',  pinName: '1'  }, color: '#888888' },
      { id: 'ph-r-gnd', start: { componentId: 'uno-photo-r',  pinName: '2'   }, end: { componentId: 'arduino-uno',  pinName: 'GND' }, color: '#000000' },
    ],
  },
  {
    id: 'uno-ntc',
    title: 'Uno: NTC Thermistor Temperature',
    description: 'Calculate temperature from an NTC 10k thermistor sensor on A1 using the Steinhart–Hart equation.',
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
  float r    = SERIES_R * v / (VCC - v);  // voltage divider
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
      { type: 'wokwi-ntc-temperature-sensor', id: 'uno-ntc1', x: 430, y: 150, properties: { temperature: '25' } },
    ],
    wires: [
      { id: 'ntc-vcc', start: { componentId: 'arduino-uno', pinName: '5V'  }, end: { componentId: 'uno-ntc1', pinName: 'VCC' }, color: '#ff0000' },
      { id: 'ntc-gnd', start: { componentId: 'arduino-uno', pinName: 'GND' }, end: { componentId: 'uno-ntc1', pinName: 'GND' }, color: '#000000' },
      { id: 'ntc-out', start: { componentId: 'arduino-uno', pinName: 'A1'  }, end: { componentId: 'uno-ntc1', pinName: 'OUT' }, color: '#aa44ff' },
    ],
  },

  // ─── Raspberry Pi Pico — Sensor Examples ─────────────────────────────────
  {
    id: 'pico-dht22',
    title: 'Pico: DHT22 Temperature & Humidity',
    description: 'Read temperature and humidity from a DHT22 sensor on GP7 using the Raspberry Pi Pico.',
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
      { type: 'wokwi-dht22', id: 'pico-dht1', x: 430, y: 150, properties: { temperature: '22', humidity: '55' } },
    ],
    wires: [
      { id: 'pcd-vcc', start: { componentId: 'nano-rp2040', pinName: '3.3V'  }, end: { componentId: 'pico-dht1', pinName: 'VCC' }, color: '#ff4444' },
      { id: 'pcd-gnd', start: { componentId: 'nano-rp2040', pinName: 'GND.1' }, end: { componentId: 'pico-dht1', pinName: 'GND' }, color: '#000000' },
      { id: 'pcd-sda', start: { componentId: 'nano-rp2040', pinName: 'GP7'   }, end: { componentId: 'pico-dht1', pinName: 'SDA' }, color: '#22aaff' },
    ],
  },
  {
    id: 'pico-hcsr04',
    title: 'Pico: HC-SR04 Ultrasonic Distance',
    description: 'Measure distance with an HC-SR04 sensor on the Raspberry Pi Pico. TRIG on D5 (GP17), ECHO on D6 (GP18).',
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
      { id: 'pcs-vcc',  start: { componentId: 'nano-rp2040', pinName: '3.3V'  }, end: { componentId: 'pico-sr1', pinName: 'VCC'  }, color: '#ff4444' },
      { id: 'pcs-gnd',  start: { componentId: 'nano-rp2040', pinName: 'GND.1' }, end: { componentId: 'pico-sr1', pinName: 'GND'  }, color: '#000000' },
      { id: 'pcs-trig', start: { componentId: 'nano-rp2040', pinName: 'D5'    }, end: { componentId: 'pico-sr1', pinName: 'TRIG' }, color: '#ff8800' },
      { id: 'pcs-echo', start: { componentId: 'nano-rp2040', pinName: 'D6'   }, end: { componentId: 'pico-sr1', pinName: 'ECHO' }, color: '#22cc22' },
    ],
  },
  {
    id: 'pico-pir',
    title: 'Pico: PIR Motion Detector',
    description: 'Detect movement with a PIR sensor on D4 (GP16). The built-in LED (GP25) activates when motion is detected.',
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
      { id: 'pp-vcc', start: { componentId: 'nano-rp2040', pinName: '3.3V'  }, end: { componentId: 'pico-pir1', pinName: 'VCC' }, color: '#ff4444' },
      { id: 'pp-gnd', start: { componentId: 'nano-rp2040', pinName: 'GND.1' }, end: { componentId: 'pico-pir1', pinName: 'GND' }, color: '#000000' },
      { id: 'pp-out', start: { componentId: 'nano-rp2040', pinName: 'D4'    }, end: { componentId: 'pico-pir1', pinName: 'OUT' }, color: '#ffcc00' },
    ],
  },
  {
    id: 'pico-servo',
    title: 'Pico: Servo Motor Sweep',
    description: 'Sweep a servo motor from 0° to 180° and back on the Raspberry Pi Pico using D3 / GP15 (PWM).',
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
    components: [
      { type: 'wokwi-servo', id: 'pico-sv1', x: 420, y: 150, properties: {} },
    ],
    wires: [
      { id: 'psv-vcc', start: { componentId: 'nano-rp2040', pinName: '3.3V'  }, end: { componentId: 'pico-sv1', pinName: 'V+' }, color: '#ff4444' },
      { id: 'psv-gnd', start: { componentId: 'nano-rp2040', pinName: 'GND.1' }, end: { componentId: 'pico-sv1', pinName: 'GND' }, color: '#000000' },
      { id: 'psv-pwm', start: { componentId: 'nano-rp2040', pinName: 'D3'    }, end: { componentId: 'pico-sv1', pinName: 'PWM' }, color: '#ff8800' },
    ],
  },
  {
    id: 'pico-ntc',
    title: 'Pico: NTC Thermistor Temperature',
    description: 'Read temperature from an NTC 10k thermistor on the Pico ADC pin A0 (GP26) using the Steinhart–Hart equation.',
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
      { type: 'wokwi-ntc-temperature-sensor', id: 'pico-ntc1', x: 430, y: 150, properties: { temperature: '25' } },
    ],
    wires: [
      { id: 'pnt-vcc', start: { componentId: 'nano-rp2040', pinName: '3.3V'  }, end: { componentId: 'pico-ntc1', pinName: 'VCC' }, color: '#ff4444' },
      { id: 'pnt-gnd', start: { componentId: 'nano-rp2040', pinName: 'GND.1' }, end: { componentId: 'pico-ntc1', pinName: 'GND' }, color: '#000000' },
      { id: 'pnt-out', start: { componentId: 'nano-rp2040', pinName: 'A0'    }, end: { componentId: 'pico-ntc1', pinName: 'OUT' }, color: '#aa44ff' },
    ],
  },
  {
    id: 'pico-joystick',
    title: 'Pico: Analog Joystick',
    description: 'Read X/Y axes and button press from an analog joystick. VERT on A0 (GP26), HORZ on A1 (GP27), SEL button on D4 (GP16).',
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
      { id: 'pj-vcc',  start: { componentId: 'nano-rp2040', pinName: '3.3V'  }, end: { componentId: 'pico-joy1', pinName: 'VCC'  }, color: '#ff4444' },
      { id: 'pj-gnd',  start: { componentId: 'nano-rp2040', pinName: 'GND.1' }, end: { componentId: 'pico-joy1', pinName: 'GND'  }, color: '#000000' },
      { id: 'pj-vert', start: { componentId: 'nano-rp2040', pinName: 'A0'    }, end: { componentId: 'pico-joy1', pinName: 'VERT' }, color: '#22aaff' },
      { id: 'pj-horz', start: { componentId: 'nano-rp2040', pinName: 'A1'    }, end: { componentId: 'pico-joy1', pinName: 'HORZ' }, color: '#22cc44' },
      { id: 'pj-sel',  start: { componentId: 'nano-rp2040', pinName: 'D4'    }, end: { componentId: 'pico-joy1', pinName: 'SEL'  }, color: '#aa44ff' },
    ],
  },

  // ─── ESP32 — Sensor Examples ──────────────────────────────────────────────
  {
    id: 'esp32-dht22',
    title: 'ESP32: DHT22 Temperature & Humidity',
    description: 'Read temperature and humidity from a DHT22 sensor on GPIO4 of the ESP32.',
    libraries: ['DHT sensor library'],
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

// Disable hardware Timer Group WDTs (QEMU emulation is slower than real time)

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
      { type: 'wokwi-dht22', id: 'e32-dht1', x: 430, y: 150, properties: { temperature: '28', humidity: '65' } },
    ],
    wires: [
      { id: 'e32d-vcc', start: { componentId: 'esp32', pinName: '3V3' }, end: { componentId: 'e32-dht1', pinName: 'VCC' }, color: '#ff4444' },
      { id: 'e32d-gnd', start: { componentId: 'esp32', pinName: 'GND' }, end: { componentId: 'e32-dht1', pinName: 'GND' }, color: '#000000' },
      { id: 'e32d-sda', start: { componentId: 'esp32', pinName: '4'   }, end: { componentId: 'e32-dht1', pinName: 'SDA' }, color: '#22aaff' },
    ],
  },
  {
    id: 'esp32-hcsr04',
    title: 'ESP32: HC-SR04 Ultrasonic Distance',
    description: 'Measure distance with an HC-SR04 sensor on ESP32. TRIG on GPIO18, ECHO on GPIO19.',
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
      { id: 'e32s-vcc',  start: { componentId: 'esp32', pinName: '3V3'   }, end: { componentId: 'e32-sr1', pinName: 'VCC'  }, color: '#ff4444' },
      { id: 'e32s-gnd',  start: { componentId: 'esp32', pinName: 'GND'  }, end: { componentId: 'e32-sr1', pinName: 'GND'  }, color: '#000000' },
      { id: 'e32s-trig', start: { componentId: 'esp32', pinName: '18'   }, end: { componentId: 'e32-sr1', pinName: 'TRIG' }, color: '#ff8800' },
      { id: 'e32s-echo', start: { componentId: 'esp32', pinName: '19'   }, end: { componentId: 'e32-sr1', pinName: 'ECHO' }, color: '#22cc22' },
    ],
  },
  {
    id: 'esp32-mpu6050',
    title: 'ESP32: MPU-6050 Accelerometer',
    description: 'Read 3-axis acceleration and gyroscope data from an MPU-6050 over I2C (SDA=D21, SCL=D22).',
    libraries: ['Adafruit MPU6050', 'Adafruit Unified Sensor'],
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
    components: [
      { type: 'wokwi-mpu6050', id: 'e32-mpu1', x: 420, y: 150, properties: {} },
    ],
    wires: [
      { id: 'e32m-vcc', start: { componentId: 'esp32', pinName: '3V3'   }, end: { componentId: 'e32-mpu1', pinName: 'VCC' }, color: '#ff4444' },
      { id: 'e32m-gnd', start: { componentId: 'esp32', pinName: 'GND' }, end: { componentId: 'e32-mpu1', pinName: 'GND' }, color: '#000000' },
      { id: 'e32m-sda', start: { componentId: 'esp32', pinName: '21'  }, end: { componentId: 'e32-mpu1', pinName: 'SDA' }, color: '#22aaff' },
      { id: 'e32m-scl', start: { componentId: 'esp32', pinName: '22'  }, end: { componentId: 'e32-mpu1', pinName: 'SCL' }, color: '#ff8800' },
    ],
  },
  {
    id: 'esp32-pir',
    title: 'ESP32: PIR Motion Detector',
    description: 'Detect motion with a PIR sensor on GPIO5 of the ESP32. Logs events to Serial with timestamps.',
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
      { id: 'e32p-vcc', start: { componentId: 'esp32', pinName: '3V3'   }, end: { componentId: 'e32-pir1', pinName: 'VCC' }, color: '#ff4444' },
      { id: 'e32p-gnd', start: { componentId: 'esp32', pinName: 'GND' }, end: { componentId: 'e32-pir1', pinName: 'GND' }, color: '#000000' },
      { id: 'e32p-out', start: { componentId: 'esp32', pinName: '5'   }, end: { componentId: 'e32-pir1', pinName: 'OUT' }, color: '#ffcc00' },
    ],
  },
  {
    id: 'esp32-servo',
    title: 'ESP32: Servo Motor + Potentiometer',
    description: 'Control a servo motor angle directly with a potentiometer. The servo follows the pot position in real time.',
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

// Disable hardware Timer Group WDTs (QEMU emulation is slower than real time)

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
      { type: 'wokwi-servo',       id: 'e32-sv1',  x: 420, y: 140, properties: {} },
      { type: 'wokwi-potentiometer', id: 'e32-pot1', x: 420, y: 280, properties: {} },
    ],
    wires: [
      { id: 'e32sv-vcc',  start: { componentId: 'esp32',    pinName: '3V3'   }, end: { componentId: 'e32-sv1',  pinName: 'V+'  }, color: '#ff4444' },
      { id: 'e32sv-gnd',  start: { componentId: 'esp32',    pinName: 'GND'  }, end: { componentId: 'e32-sv1',  pinName: 'GND' }, color: '#000000' },
      { id: 'e32sv-pwm',  start: { componentId: 'esp32',    pinName: '13'   }, end: { componentId: 'e32-sv1',  pinName: 'PWM' }, color: '#ff8800' },
      { id: 'e32pt-vcc',  start: { componentId: 'esp32',    pinName: '3V3'  }, end: { componentId: 'e32-pot1', pinName: 'VCC' }, color: '#ff4444' },
      { id: 'e32pt-gnd',  start: { componentId: 'esp32',    pinName: 'GND2' }, end: { componentId: 'e32-pot1', pinName: 'GND' }, color: '#000000' },
      { id: 'e32pt-sig',  start: { componentId: 'esp32',    pinName: '34'   }, end: { componentId: 'e32-pot1', pinName: 'SIG' }, color: '#aa44ff' },
    ],
  },
  {
    id: 'esp32-joystick',
    title: 'ESP32: Analog Joystick',
    description: 'Read X/Y axes and button click from an analog joystick on the ESP32. X on D35, Y on D34, button on GPIO15.',
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
    components: [
      { type: 'wokwi-analog-joystick', id: 'e32-joy1', x: 420, y: 140, properties: {} },
    ],
    wires: [
      { id: 'e32j-vcc',  start: { componentId: 'esp32', pinName: '3V3'   }, end: { componentId: 'e32-joy1', pinName: 'VCC'  }, color: '#ff4444' },
      { id: 'e32j-gnd',  start: { componentId: 'esp32', pinName: 'GND' }, end: { componentId: 'e32-joy1', pinName: 'GND'  }, color: '#000000' },
      { id: 'e32j-vert', start: { componentId: 'esp32', pinName: '34'  }, end: { componentId: 'e32-joy1', pinName: 'VERT' }, color: '#22aaff' },
      { id: 'e32j-horz', start: { componentId: 'esp32', pinName: '35'  }, end: { componentId: 'e32-joy1', pinName: 'HORZ' }, color: '#22cc44' },
      { id: 'e32j-sel',  start: { componentId: 'esp32', pinName: '15'  }, end: { componentId: 'e32-joy1', pinName: 'SEL'  }, color: '#aa44ff' },
    ],
  },

  // ─── ESP32-C3 — Sensor Examples ───────────────────────────────────────────
  {
    id: 'c3-dht22',
    title: 'ESP32-C3: DHT22 Temperature & Humidity',
    description: 'Read temperature and humidity with a DHT22 sensor on GPIO3 of the ESP32-C3 RISC-V board.',
    libraries: ['DHT sensor library'],
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

// Disable hardware Timer Group WDTs (QEMU emulation is slower than real time)

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
      { type: 'wokwi-dht22', id: 'c3-dht1', x: 430, y: 150, properties: { temperature: '26', humidity: '58' } },
    ],
    wires: [
      { id: 'c3d-vcc', start: { componentId: 'esp32-c3', pinName: '3V3'   }, end: { componentId: 'c3-dht1', pinName: 'VCC' }, color: '#ff4444' },
      { id: 'c3d-gnd', start: { componentId: 'esp32-c3', pinName: 'GND.9' }, end: { componentId: 'c3-dht1', pinName: 'GND' }, color: '#000000' },
      { id: 'c3d-sda', start: { componentId: 'esp32-c3', pinName: '3'     }, end: { componentId: 'c3-dht1', pinName: 'SDA' }, color: '#22aaff' },
    ],
  },
  {
    id: 'c3-hcsr04',
    title: 'ESP32-C3: HC-SR04 Ultrasonic Distance',
    description: 'Measure distance with an HC-SR04 sensor on the ESP32-C3. TRIG on GPIO5, ECHO on GPIO6.',
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
      { id: 'c3s-vcc',  start: { componentId: 'esp32-c3', pinName: '3V3'   }, end: { componentId: 'c3-sr1', pinName: 'VCC'  }, color: '#ff4444' },
      { id: 'c3s-gnd',  start: { componentId: 'esp32-c3', pinName: 'GND.9' }, end: { componentId: 'c3-sr1', pinName: 'GND'  }, color: '#000000' },
      { id: 'c3s-trig', start: { componentId: 'esp32-c3', pinName: '5'     }, end: { componentId: 'c3-sr1', pinName: 'TRIG' }, color: '#ff8800' },
      { id: 'c3s-echo', start: { componentId: 'esp32-c3', pinName: '6'     }, end: { componentId: 'c3-sr1', pinName: 'ECHO' }, color: '#22cc22' },
    ],
  },
  {
    id: 'c3-pir',
    title: 'ESP32-C3: PIR Motion Detector',
    description: 'Detect motion with a PIR sensor on GPIO7 of the ESP32-C3. Prints detection events and count to Serial.',
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
      { id: 'c3p-vcc', start: { componentId: 'esp32-c3', pinName: '3V3'   }, end: { componentId: 'c3-pir1', pinName: 'VCC' }, color: '#ff4444' },
      { id: 'c3p-gnd', start: { componentId: 'esp32-c3', pinName: 'GND.9' }, end: { componentId: 'c3-pir1', pinName: 'GND' }, color: '#000000' },
      { id: 'c3p-out', start: { componentId: 'esp32-c3', pinName: '7'     }, end: { componentId: 'c3-pir1', pinName: 'OUT' }, color: '#ffcc00' },
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
    components: [
      { type: 'wokwi-servo', id: 'c3-sv1', x: 420, y: 150, properties: {} },
    ],
    wires: [
      { id: 'c3sv-vcc', start: { componentId: 'esp32-c3', pinName: '3V3'   }, end: { componentId: 'c3-sv1', pinName: 'V+' }, color: '#ff4444' },
      { id: 'c3sv-gnd', start: { componentId: 'esp32-c3', pinName: 'GND.9' }, end: { componentId: 'c3-sv1', pinName: 'GND' }, color: '#000000' },
      { id: 'c3sv-pwm', start: { componentId: 'esp32-c3', pinName: '10'    }, end: { componentId: 'c3-sv1', pinName: 'PWM' }, color: '#ff8800' },
    ],
  },
];

// Get examples by category
export function getExamplesByCategory(category: ExampleProject['category']): ExampleProject[] {
  return exampleProjects.filter((example) => example.category === category);
}

// Get example by ID
export function getExampleById(id: string): ExampleProject | undefined {
  return exampleProjects.find((example) => example.id === id);
}

// Get all categories
export function getCategories(): ExampleProject['category'][] {
  return ['basics', 'sensors', 'displays', 'communication', 'games', 'robotics'];
}

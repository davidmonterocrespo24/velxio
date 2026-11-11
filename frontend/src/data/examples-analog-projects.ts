/**
 * Analog projects from the blog post "Analog electronics in the browser".
 *
 * Five board-less circuits (Ohm's law, a 5 V linear supply, a transistor night
 * light, a common-emitter amplifier, an op-amp thermostat) and two mixed ones
 * (an Arduino PWM DAC, an ESP32 thermometer with a fan). Every reading the post
 * quotes was measured on these exact circuits in the simulator and checked
 * against the textbook formula.
 *
 * Wires carry their corners so the schematics stay legible; coordinates are
 * canvas pixels, the board (when there is one) sits at (50, 50).
 */
import type { ExampleProject } from './examples';

const C_PWR = '#ff3b3b';
const C_GND = '#000000';
const C_SIG = '#ffaa00';
const C_OUT = '#22d3ee';

function w(
  id: string,
  from: [string, string],
  to: [string, string],
  color: string,
  corners: [number, number][] = [],
) {
  return {
    id,
    start: { componentId: from[0], pinName: from[1] },
    end: { componentId: to[0], pinName: to[1] },
    color,
    waypoints: corners.map(([x, y]) => ({ x, y })),
  };
}

// Board-less circuits simulate as soon as they load; there is no sketch.
const ANALOG_SKETCH = `// Analog circuit, no microcontroller: nothing to program here.
// Change a part's value on the canvas and the circuit re-solves.
void setup() {}
void loop() {}
`;

export const analogProjectExamples: ExampleProject[] = [
  {
    id: 'analog-led-ohms-law',
    title: "LED and Resistor: Ohm's Law",
    description:
      "A 9 V battery drives a red LED through a 470 ohm resistor, with an ammeter in series and a voltmeter across the resistor. The meters show Ohm's law at work: 7.1 V across 470 ohm is 15 mA, and the rest of the 9 V (about 1.8 V) drops across the LED. Change the resistor's value and watch both readings move.",
    category: 'circuits',
    difficulty: 'beginner',
    boardFilter: 'analog',
    code: ANALOG_SKETCH,
    components: [
      { type: 'wokwi-battery-9v', id: 'bat', x: 0, y: 60, properties: {} },
      { type: 'velxio-instr-ammeter', id: 'am', x: 80, y: -40, properties: {} },
      { type: 'wokwi-resistor', id: 'r1', x: 240, y: -10, properties: { value: '470' } },
      { type: 'wokwi-led', id: 'led1', x: 340, y: -46, properties: { color: 'red', flip: true } },
      { type: 'velxio-instr-voltmeter', id: 'vr', x: 130, y: 60, properties: {} },
    ],
    wires: [
      w('w1', ['bat', '+'], ['am', 'A+'], C_PWR, [[24, -4]]),
      w('w2', ['am', 'A-'], ['r1', '1'], C_PWR),
      w('w3', ['r1', '2'], ['led1', 'A'], C_SIG),
      w('w4', ['led1', 'C'], ['bat', '−'], C_GND, [
        [390, -4],
        [390, 160],
        [24, 160],
      ]),
      w('w5', ['r1', '1'], ['vr', 'V+'], C_PWR, [
        [240, 50],
        [120, 50],
        [120, 84],
      ]),
      w('w6', ['r1', '2'], ['vr', 'V-'], C_SIG, [
        [299, 136],
        [110, 136],
        [110, 108],
      ]),
    ],
    tags: ['analog', 'led', 'resistor', 'ohms-law', 'ammeter', 'voltmeter', 'battery', 'beginner'],
  },
  {
    id: 'analog-5v-power-supply',
    title: '5 V Regulated Power Supply (Rectifier + 7805)',
    description:
      'The classic linear supply: a center-tapped 12 V AC transformer (two signal generators in antiphase), a full-wave rectifier with two 1N4007 diodes, a 220 uF reservoir capacitor and a 7805 regulator feeding a 100 ohm load. The capacitor swings about 2 V between charging peaks while the output stays at 5.000 V. Right-click a wire and choose Add to scope to see each stage.',
    category: 'circuits',
    difficulty: 'intermediate',
    boardFilter: 'analog',
    code: ANALOG_SKETCH,
    components: [
      {
        type: 'wokwi-signal-generator',
        id: 'secA',
        x: -40,
        y: -20,
        properties: { waveform: 'sine', frequency: 50, amplitude: 12, offset: 0 },
      },
      {
        type: 'wokwi-signal-generator',
        id: 'secB',
        x: -40,
        y: 120,
        properties: { waveform: 'sine', frequency: 50, amplitude: -12, offset: 0 },
      },
      { type: 'wokwi-diode-1n4007', id: 'd1', x: 80, y: -12, properties: {} },
      { type: 'wokwi-diode-1n4007', id: 'd2', x: 80, y: 128, properties: {} },
      {
        type: 'velxio-capacitor-electrolytic',
        id: 'c1',
        x: 180,
        y: 40,
        properties: { value: '220u' },
      },
      { type: 'wokwi-reg-7805', id: 'u1', x: 240, y: -20, properties: {} },
      { type: 'wokwi-resistor', id: 'rl', x: 340, y: 60, properties: { value: '100' } },
      { type: 'velxio-instr-voltmeter', id: 'vout', x: 330, y: 110, properties: {} },
    ],
    wires: [
      w('w1', ['secA', 'SIG'], ['d1', 'A'], C_SIG),
      w('w2', ['secB', 'SIG'], ['d2', 'A'], C_SIG),
      w('w3', ['d1', 'C'], ['u1', 'VIN'], C_PWR),
      w('w4', ['d2', 'C'], ['c1', '+'], C_PWR, [[189, 144]]),
      w('w5', ['c1', '+'], ['d1', 'C'], C_PWR, [[189, 4]]),
      w('w6', ['secA', 'GND'], ['secB', 'GND'], C_GND, [
        [60, 28],
        [60, 168],
      ]),
      w('w7', ['c1', '−'], ['secB', 'GND'], C_GND, [
        [206, 220],
        [60, 220],
        [60, 168],
      ]),
      w('w8', ['u1', 'GND'], ['c1', '−'], C_GND, [
        [276, 220],
        [206, 220],
      ]),
      w('w9', ['u1', 'VOUT'], ['rl', '1'], C_OUT, [
        [322, 4],
        [322, 66],
      ]),
      w('w10', ['rl', '2'], ['u1', 'GND'], C_GND, [
        [470, 66],
        [470, 220],
        [276, 220],
      ]),
      w('w11', ['u1', 'VOUT'], ['vout', 'V+'], C_OUT, [
        [322, 4],
        [322, 134],
      ]),
      w('w12', ['vout', 'V-'], ['u1', 'GND'], C_GND, [
        [310, 158],
        [310, 220],
        [276, 220],
      ]),
    ],
    tags: [
      'analog',
      'power-supply',
      'rectifier',
      'diode',
      '7805',
      'regulator',
      'capacitor',
      'oscilloscope',
      'ac',
    ],
  },
  {
    id: 'analog-night-light',
    title: 'Night Light: LDR and Two Transistors',
    description:
      "An automatic night light with no microcontroller. The light sensor's output turns transistor Q1 on in daylight, which holds Q2 off. When the light falls below about 30 lux, Q1 lets go, Q2 turns on and the LED lights up. The sensor carries a high-resistance LDR (rl10 180 kOhm, gamma 0.9: a GL5549) to put the switch point there; with the stock GL5528 it would wait for about 1 lux. Open the sensor and drag its light level to switch it.",
    category: 'circuits',
    difficulty: 'beginner',
    boardFilter: 'analog',
    code: ANALOG_SKETCH,
    components: [
      {
        type: 'wokwi-power-supply',
        id: 'ps',
        x: -40,
        y: -60,
        properties: { mode: 'dc', voltage: 5, currentLimit: 5 },
      },
      {
        type: 'wokwi-photoresistor-sensor',
        id: 'ldr',
        x: -150,
        y: 70,
        properties: { lux: 20, rl10: 180, gamma: 0.9 },
      },
      { type: 'wokwi-resistor', id: 'rb1', x: 60, y: 110, properties: { value: '10000' } },
      { type: 'wokwi-bjt-2n2222', id: 'q1', x: 140, y: 80, properties: {} },
      { type: 'wokwi-resistor', id: 'rc1', x: 200, y: 20, properties: { value: '10000' } },
      { type: 'wokwi-bjt-2n2222', id: 'q2', x: 300, y: 40, properties: {} },
      { type: 'wokwi-resistor', id: 'rled', x: 300, y: -50, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'led1', x: 360, y: -40, properties: { color: 'yellow' } },
    ],
    wires: [
      w('w1', ['ps', 'SIG'], ['rled', '1'], C_PWR, [[300, -36]]),
      w('w2', ['ps', 'SIG'], ['rc1', '1'], C_PWR, [
        [180, -36],
        [180, 26],
      ]),
      w('w3', ['ps', 'SIG'], ['ldr', 'VCC'], C_PWR, [
        [50, -36],
        [50, 86],
      ]),
      w('w4', ['ps', 'GND'], ['ldr', 'GND'], C_GND, [[40, 96]]),
      w('w5', ['ldr', 'AO'], ['rb1', '1'], C_SIG, [[40, 116]]),
      w('w6', ['rb1', '2'], ['q1', 'B'], C_SIG),
      w('w7', ['q1', 'E'], ['ldr', 'GND'], C_GND, [
        [200, 190],
        [40, 190],
        [40, 96],
      ]),
      w('w8', ['rc1', '2'], ['q1', 'C'], C_SIG, [
        [270, 26],
        [270, 60],
        [200, 60],
      ]),
      w('w9', ['q1', 'C'], ['q2', 'B'], C_SIG, [
        [200, 60],
        [280, 60],
        [280, 76],
      ]),
      w('w10', ['q2', 'E'], ['q1', 'E'], C_GND, [
        [360, 190],
        [200, 190],
      ]),
      w('w11', ['rled', '2'], ['led1', 'A'], C_OUT, [[385, -44]]),
      w('w12', ['led1', 'C'], ['q2', 'C'], C_OUT, [
        [375, 20],
        [360, 20],
      ]),
    ],
    tags: [
      'analog',
      'transistor',
      'bjt',
      '2n2222',
      'ldr',
      'photoresistor',
      'light-sensor',
      'led',
      'switch',
    ],
  },
  {
    id: 'analog-common-emitter-amp',
    title: 'Common-Emitter Transistor Amplifier',
    description:
      'A 2N2222 amplifier with voltage-divider bias. A 0.4 V peak-to-peak, 1 kHz signal enters the base through a coupling capacitor and comes out of the collector about 4.5 times larger and inverted (gain = -Rc/Re = -4.7k/1k). Put the base and the collector on the scope to compare them.',
    category: 'circuits',
    difficulty: 'intermediate',
    boardFilter: 'analog',
    code: ANALOG_SKETCH,
    components: [
      {
        type: 'wokwi-power-supply',
        id: 'ps',
        x: -200,
        y: -160,
        properties: { mode: 'dc', voltage: 9, currentLimit: 5 },
      },
      {
        type: 'wokwi-signal-generator',
        id: 'sig',
        x: -200,
        y: 52,
        properties: { waveform: 'sine', frequency: 1000, amplitude: 0.2, offset: 0 },
      },
      { type: 'wokwi-capacitor', id: 'cin', x: -20, y: 70, properties: { value: '10u' } },
      { type: 'wokwi-resistor', id: 'r1', x: 0, y: -40, properties: { value: '47000' } },
      { type: 'wokwi-resistor', id: 'r2', x: 31, y: 180, properties: { value: '10000' } },
      { type: 'wokwi-bjt-2n2222', id: 'q1', x: 120, y: 40, properties: {} },
      { type: 'wokwi-resistor', id: 'rc', x: 200, y: -40, properties: { value: '4700' } },
      { type: 'wokwi-resistor', id: 're', x: 180, y: 200, properties: { value: '1000' } },
    ],
    wires: [
      w('w1', ['ps', 'SIG'], ['r1', '1'], C_PWR, [
        [-20, -136],
        [-20, -34],
      ]),
      w('w2', ['ps', 'SIG'], ['rc', '1'], C_PWR, [
        [190, -136],
        [190, -34],
      ]),
      w('w3', ['r1', '2'], ['q1', 'B'], C_SIG, [
        [90, -34],
        [90, 76],
      ]),
      w('w4', ['sig', 'SIG'], ['cin', '1'], C_SIG),
      w('w5', ['cin', '2'], ['q1', 'B'], C_SIG),
      w('w6', ['r2', '2'], ['q1', 'B'], C_SIG, [[90, 76]]),
      w('w7', ['rc', '2'], ['q1', 'C'], C_OUT, [
        [270, -34],
        [270, 10],
        [180, 10],
      ]),
      w('w8', ['q1', 'E'], ['re', '1'], C_SIG),
      w('w9', ['sig', 'GND'], ['r2', '1'], C_GND, [
        [-100, 100],
        [-100, 260],
        [10, 260],
        [10, 186],
      ]),
      w('w10', ['re', '2'], ['r2', '1'], C_GND, [
        [250, 206],
        [250, 260],
        [10, 260],
        [10, 186],
      ]),
      w('w11', ['ps', 'GND'], ['sig', 'GND'], C_GND, [
        [-100, -112],
        [-100, 100],
      ]),
    ],
    tags: [
      'analog',
      'transistor',
      'bjt',
      '2n2222',
      'amplifier',
      'common-emitter',
      'bias',
      'oscilloscope',
      'ac',
    ],
  },
  {
    id: 'analog-thermostat-comparator',
    title: 'Thermostat with an LM358 Comparator',
    description:
      "An NTC thermistor and a set-point potentiometer feed the two inputs of an LM358 used as a comparator. Above the set point (about 28 C here) the output goes high and the LED (the fan) turns on. Change the thermistor's temperature or turn the knob to move the threshold.",
    category: 'circuits',
    difficulty: 'intermediate',
    boardFilter: 'analog',
    code: ANALOG_SKETCH,
    components: [
      {
        type: 'wokwi-ntc-temperature-sensor',
        id: 'ntc',
        x: -170,
        y: -20,
        properties: { temperature: 25 },
      },
      { type: 'wokwi-potentiometer', id: 'set', x: -110, y: 110, properties: { value: 478 } },
      { type: 'wokwi-opamp-lm358', id: 'u1', x: 60, y: -10, properties: {} },
      { type: 'wokwi-resistor', id: 'rled', x: 180, y: 16, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'led1', x: 270, y: -20, properties: { color: 'red', flip: true } },
      { type: 'velxio-instr-voltmeter', id: 'vref', x: 60, y: 120, properties: {} },
    ],
    wires: [
      w('w1', ['ntc', 'OUT'], ['u1', 'IN-'], C_SIG, [
        [20, 26],
        [20, 42],
      ]),
      w('w2', ['set', 'SIG'], ['u1', 'IN+'], C_SIG, [
        [-71, 220],
        [30, 220],
        [30, 2],
      ]),
      w('w3', ['u1', 'OUT'], ['rled', '1'], C_OUT, [[150, 22]]),
      w('w4', ['rled', '2'], ['led1', 'A'], C_OUT, [[285, 22]]),
      w('w5', ['led1', 'C'], ['ntc', 'GND'], C_GND, [
        [330, 22],
        [330, 260],
        [-20, 260],
        [-20, 6],
      ]),
      w('w6', ['ntc', 'VCC'], ['set', 'VCC'], C_PWR, [
        [0, 16],
        [0, 240],
        [-61, 240],
      ]),
      w('w7', ['set', 'GND'], ['ntc', 'GND'], C_GND, [
        [-81, 260],
        [-20, 260],
        [-20, 6],
      ]),
      w('w8', ['set', 'SIG'], ['vref', 'V+'], C_SIG, [
        [-71, 220],
        [40, 220],
        [40, 144],
      ]),
      w('w9', ['vref', 'V-'], ['ntc', 'GND'], C_GND, [
        [50, 168],
        [50, 260],
        [-20, 260],
        [-20, 6],
      ]),
    ],
    tags: [
      'analog',
      'opamp',
      'lm358',
      'comparator',
      'ntc',
      'thermistor',
      'temperature',
      'thermostat',
      'potentiometer',
    ],
  },
  {
    id: 'arduino-pwm-dac-opamp',
    title: 'Arduino PWM as a DAC (RC Filter + LM358 Buffer)',
    description:
      "Turn PWM into a real analog voltage. Pin 9's PWM goes through a 10k/10uF low-pass filter, an LM358 voltage follower buffers it, and A0 reads it back. The serial monitor compares the voltage you asked for with the one you got, including where the op-amp runs out of headroom near 5 V.",
    category: 'circuits',
    difficulty: 'intermediate',
    boardType: 'arduino-uno',
    code: `// Arduino as a DAC: PWM through an RC low-pass filter and an op-amp buffer.
// Pin 9 makes PWM; R1/C1 average it into a DC voltage; the LM358 wired as a
// voltage follower copies that voltage without loading the filter; A0 reads
// it back so you can compare what you asked for with what you got. At 255
// the reading stops near 4 V: an LM358 on a 5 V supply cannot drive its output
// all the way up to 5 V.

const int PWM_PIN = 9;
const int SENSE_PIN = A0;
const int steps[] = {0, 64, 128, 192, 255};

void setup() {
  Serial.begin(115200);
  pinMode(PWM_PIN, OUTPUT);
}

void loop() {
  for (int i = 0; i < 5; i++) {
    analogWrite(PWM_PIN, steps[i]);
    delay(2500);                       // the filter settles in 5 x RC = 0.5 s
    float expected = steps[i] * 5.0 / 255.0;
    float measured = analogRead(SENSE_PIN) * 5.0 / 1023.0;
    Serial.print("PWM ");
    Serial.print(steps[i]);
    Serial.print("  expected ");
    Serial.print(expected, 2);
    Serial.print(" V  measured ");
    Serial.print(measured, 2);
    Serial.println(" V");
  }
}
`,
    components: [
      { type: 'wokwi-arduino-uno', id: 'arduino-uno', x: 50, y: 50, properties: {} },
      { type: 'wokwi-resistor', id: 'r1', x: 360, y: 60, properties: { value: '10000' } },
      {
        type: 'velxio-capacitor-electrolytic',
        id: 'c1',
        x: 440,
        y: 100,
        properties: { value: '10u' },
      },
      { type: 'wokwi-opamp-lm358', id: 'u1', x: 520, y: 40, properties: {} },
    ],
    wires: [
      w('w1', ['arduino-uno', '9'], ['r1', '1'], C_SIG, [
        [213, 30],
        [350, 30],
        [350, 66],
      ]),
      w('w2', ['r1', '2'], ['u1', 'IN+'], C_SIG, [
        [490, 66],
        [490, 52],
      ]),
      w('w3', ['r1', '2'], ['c1', '+'], C_SIG, [
        [430, 66],
        [430, 170],
        [449, 170],
      ]),
      w('w4', ['c1', '−'], ['arduino-uno', 'GND.3'], C_GND, [
        [466, 300],
        [229, 300],
      ]),
      w('w5', ['u1', 'OUT'], ['u1', 'IN-'], C_OUT, [
        [620, 72],
        [620, 120],
        [500, 120],
        [500, 92],
      ]),
      w('w6', ['u1', 'OUT'], ['arduino-uno', 'A0'], C_OUT, [
        [620, 72],
        [620, 280],
        [258, 280],
      ]),
    ],
    tags: [
      'analog',
      'mixed',
      'arduino',
      'pwm',
      'dac',
      'rc-filter',
      'low-pass',
      'opamp',
      'lm358',
      'voltage-follower',
    ],
  },
  {
    id: 'esp32-ntc-fan-control',
    title: 'ESP32 Thermometer and Fan (NTC + MOSFET)',
    description:
      "An ESP32 reads an NTC thermistor through a voltage divider, converts it to degrees with the Beta equation, and switches a fan (the green LED) through a 2N7000 MOSFET, with 2 C of hysteresis so it does not chatter. Raise the thermistor's temperature past 30 C to start the fan.",
    category: 'circuits',
    difficulty: 'intermediate',
    boardType: 'esp32',
    code: `// ESP32 thermometer + fan control.
// The NTC module is a voltage divider (10k fixed resistor on top, 10k NTC
// below), so its OUT pin falls as the temperature rises. The ESP32 reads it,
// converts it to degrees with the Beta equation, and switches a fan (the LED)
// through a 2N7000 MOSFET, with 2 degrees of hysteresis so it does not chatter.

#include <math.h>

const int NTC_PIN = 34;
const int FAN_PIN = 25;
const float NTC_BETA = 3950.0;    // from the NTC's datasheet
const float NTC_R0 = 10000.0;     // resistance at 25 C
const float NTC_T0 = 298.15;      // 25 C in kelvin
const float R_FIXED = 10000.0;    // the module's fixed resistor
const float FAN_ON_C = 30.0, FAN_OFF_C = 28.0;
bool fanOn = false;

float readCelsius() {
  long sum = 0;
  for (int i = 0; i < 16; i++) sum += analogRead(NTC_PIN);   // 0..4095
  float v = sum / 16.0 * 3.3 / 4095.0;      // volts at the divider output
  float r = R_FIXED * v / (3.3 - v);        // NTC resistance
  float kelvin = 1.0 / (1.0 / NTC_T0 + log(r / NTC_R0) / NTC_BETA);
  return kelvin - 273.15;
}

void setup() {
  Serial.begin(115200);
  pinMode(FAN_PIN, OUTPUT);
}

void loop() {
  float t = readCelsius();
  if (!fanOn && t >= FAN_ON_C) fanOn = true;
  if (fanOn && t <= FAN_OFF_C) fanOn = false;
  digitalWrite(FAN_PIN, fanOn ? HIGH : LOW);
  Serial.printf("%.1f C  fan %s\\n", t, fanOn ? "ON" : "off");
  delay(1000);
}
`,
    components: [
      { type: 'wokwi-esp32-devkit-v1', id: 'esp32', x: 50, y: 50, properties: {} },
      {
        type: 'wokwi-ntc-temperature-sensor',
        id: 'ntc',
        x: -250,
        y: 60,
        properties: { temperature: 25 },
      },
      { type: 'wokwi-resistor', id: 'rg', x: -120, y: 162, properties: { value: '100' } },
      { type: 'wokwi-mosfet-2n7000', id: 'q1', x: -230, y: 160, properties: {} },
      { type: 'wokwi-resistor', id: 'rfan', x: -330, y: 330, properties: { value: '150' } },
      { type: 'wokwi-led', id: 'fan', x: -250, y: 290, properties: { color: 'green', flip: true } },
    ],
    wires: [
      w('w1', ['ntc', 'OUT'], ['esp32', '34'], C_SIG, [
        [-60, 106],
        [-60, 117],
      ]),
      w('w2', ['ntc', 'VCC'], ['esp32', '3V3'], C_PWR, [
        [-80, 96],
        [-80, -10],
        [210, -10],
        [210, 257],
      ]),
      w('w3', ['ntc', 'GND'], ['esp32', 'GND'], C_GND, [
        [-100, 86],
        [-100, 244],
      ]),
      w('w4', ['esp32', '25'], ['rg', '2'], C_SIG, [[-40, 168]]),
      w('w5', ['rg', '1'], ['q1', 'G'], C_SIG, [
        [-140, 168],
        [-140, 196],
      ]),
      w('w6', ['q1', 'S'], ['esp32', 'GND'], C_GND, [[-170, 244]]),
      w('w7', ['esp32', 'VIN'], ['rfan', '1'], C_PWR, [
        [40, 257],
        [40, 380],
        [-350, 380],
        [-350, 336],
      ]),
      w('w8', ['rfan', '2'], ['fan', 'A'], C_OUT, [[-235, 336]]),
      w('w9', ['fan', 'C'], ['q1', 'D'], C_OUT, [
        [-225, 260],
        [-170, 260],
        [-170, 160],
      ]),
    ],
    tags: [
      'analog',
      'mixed',
      'esp32',
      'ntc',
      'thermistor',
      'temperature',
      'adc',
      'mosfet',
      '2n7000',
      'fan',
      'hysteresis',
    ],
  },
  {
    id: 'esp32-pwm-dac-lm358-12v',
    title: 'ESP32 PWM to 0-12 V (LM358 on a 15 V Supply)',
    description:
      "A 3.3 V microcontroller driving a 12 V signal. GPIO25's PWM goes through a 10k/10uF low-pass filter into an LM358 wired as a non-inverting amplifier with a gain of 3.7, and the op-amp runs from a 15 V bench supply on its V+ pin. The voltmeter shows the output, and a 100k/22k divider brings it back to GPIO34 so the serial monitor compares each target with what came out. Disconnect V+ and the op-amp falls back to the ESP32's 3.3 V: the output stops near 2 V whatever the gain.",
    category: 'circuits',
    difficulty: 'intermediate',
    boardType: 'esp32',
    code: `// ESP32 PWM to 0-12 V: an LM358 on its own 15 V supply.
//
// GPIO25 makes 12-bit PWM at 5 kHz; R1/C1 (10k, 10 uF) average it into a DC
// setpoint between 0 and 3.3 V; the LM358, wired as a non-inverting amplifier
// with a gain of 1 + 27k/10k = 3.7, lifts it to 0..12.2 V. The op-amp is
// powered from the 15 V bench supply on its V+ pin: an op-amp cannot put out
// more than its supply, and on the ESP32's 3.3 V an LM358 stops near 2 V.
// A 100k/22k divider brings the output back under 3.3 V for GPIO34, so the
// sketch prints what it got next to what it asked for. The ESP32's ADC sees
// nothing under about 0.14 V (Espressif rates it from 150 mV up), so the 0 V
// step prints about 0.8 V while the voltmeter shows 0.

const int PWM_PIN = 25;
const int SENSE_PIN = 34;
const float GAIN = 1.0 + 27.0 / 10.0;          // 3.7
const float DIVIDER = (100.0 + 22.0) / 22.0;   // 5.55
const float targets[] = {0.0, 3.0, 6.0, 9.0, 12.0};

void setup() {
  Serial.begin(115200);
  ledcAttach(PWM_PIN, 5000, 12);               // 5 kHz, duty 0..4095
}

void loop() {
  for (float target : targets) {
    int duty = constrain(lround(target / (3.3 * GAIN) * 4095), 0, 4095);
    ledcWrite(PWM_PIN, duty);
    delay(3000);                               // the RC settles in 5 x 0.1 s
    float measured = analogReadMilliVolts(SENSE_PIN) / 1000.0 * DIVIDER;
    Serial.printf("target %5.2f V  duty %4d  measured %5.2f V\\n", target, duty, measured);
  }
}
`,
    components: [
      { type: 'wokwi-esp32-devkit-v1', id: 'esp32', x: 50, y: 50, properties: {} },
      {
        type: 'wokwi-signal-generator',
        id: 'psu',
        x: -600,
        y: 0,
        properties: { waveform: 'dc', offset: 15, frequency: 1000, amplitude: 0 },
      },
      { type: 'wokwi-resistor', id: 'r1', x: -560, y: 162.35, properties: { value: '10000' } },
      {
        type: 'velxio-capacitor-electrolytic',
        id: 'c1',
        x: -480,
        y: 187,
        properties: { value: '10u' },
      },
      { type: 'wokwi-opamp-lm358', id: 'u1', x: -400, y: 156, properties: {} },
      { type: 'wokwi-resistor', id: 'rf', x: -390, y: 242, properties: { value: '27000' } },
      { type: 'wokwi-resistor', id: 'rg', x: -390, y: 277, properties: { value: '10000' } },
      { type: 'velxio-instr-voltmeter', id: 'vm', x: -260, y: 147, properties: {} },
      { type: 'wokwi-resistor', id: 'rt', x: -120, y: 111.35, properties: { value: '100000' } },
      { type: 'wokwi-resistor', id: 'rb', x: -120, y: 205, properties: { value: '22000' } },
    ],
    wires: [
      // PWM out, over the top of the circuit, into the filter.
      w('w1', ['esp32', '25'], ['r1', '1'], C_SIG, [
        [40, 168],
        [40, -30],
        [-610, -30],
        [-610, 168],
      ]),
      w('w2', ['r1', '2'], ['u1', 'IN+'], C_SIG, [[-450, 168]]),
      w('w3', ['c1', '+'], ['r1', '2'], C_SIG, [
        [-471.4, 252],
        [-490, 252],
        [-490, 168],
      ]),
      // The op-amp's supply: 15 V on V+, ground on V-.
      w('w4', ['psu', 'SIG'], ['u1', 'V+'], C_PWR, [[-360, 24]]),
      w('w5', ['psu', 'GND'], ['esp32', 'GND'], C_GND, [
        [-500, 48],
        [-500, 330],
        [30, 330],
        [30, 244],
      ]),
      w('w6', ['u1', 'V-'], ['esp32', 'GND'], C_GND, [
        [-360, 232],
        [-430, 232],
        [-430, 330],
        [30, 330],
        [30, 244],
      ]),
      w('w7', ['c1', '−'], ['esp32', 'GND'], C_GND, [
        [-454.5, 330],
        [30, 330],
        [30, 244],
      ]),
      // Gain of 3.7: 27k from OUT to IN-, 10k from IN- to ground.
      w('w8', ['u1', 'IN-'], ['rf', '1'], C_SIG, [
        [-410, 208],
        [-410, 247.65],
      ]),
      w('w9', ['rf', '2'], ['u1', 'OUT'], C_OUT, [
        [-310, 247.65],
        [-310, 188],
      ]),
      w('w10', ['u1', 'IN-'], ['rg', '1'], C_SIG, [
        [-410, 208],
        [-410, 282.65],
      ]),
      w('w11', ['rg', '2'], ['esp32', 'GND'], C_GND, [
        [-300, 282.65],
        [-300, 330],
        [30, 330],
        [30, 244],
      ]),
      // The output on the voltmeter and, divided by 5.55, on GPIO34.
      w('w12', ['u1', 'OUT'], ['vm', 'V+'], C_OUT, [
        [-290, 188],
        [-290, 171],
      ]),
      w('w13', ['vm', 'V-'], ['esp32', 'GND'], C_GND, [
        [-270, 195],
        [-270, 330],
        [30, 330],
        [30, 244],
      ]),
      w('w14', ['rt', '1'], ['vm', 'V+'], C_OUT, [
        [-275, 117],
        [-275, 171],
      ]),
      w('w15', ['rt', '2'], ['esp32', '34'], C_SIG, [[0, 117]]),
      w('w16', ['rb', '2'], ['esp32', '34'], C_SIG, [
        [-40, 210.65],
        [-40, 117],
      ]),
      w('w17', ['rb', '1'], ['esp32', 'GND'], C_GND, [
        [-130, 210.65],
        [-130, 330],
        [30, 330],
        [30, 244],
      ]),
    ],
    tags: [
      'analog',
      'mixed',
      'esp32',
      'pwm',
      'dac',
      'rc-filter',
      'low-pass',
      'opamp',
      'lm358',
      'non-inverting-amplifier',
      'power-supply',
      'level-shift',
    ],
  },
];

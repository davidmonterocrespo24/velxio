/**
 * Circuit-focused example projects — analog, digital, electromechanical.
 *
 * These examples showcase the SPICE electrical simulation mode with real
 * component models (transistors, op-amps, regulators, gates, relays).
 * Each example has a matching ngspice test in test/test_circuit/test/spice_examples.test.js.
 */
import type { ExampleProject } from './examples';

// ─── Helper: standard Arduino Uno at (100,100) ─────────────────────────────
const UNO = { type: 'wokwi-arduino-uno', id: 'uno', x: 100, y: 100, properties: {} };
const MEGA = { type: 'wokwi-arduino-mega', id: 'mega', x: 80, y: 80, properties: {} };
const ESP32 = { type: 'wokwi-esp32-devkit-v1', id: 'esp32', x: 80, y: 80, properties: {} };

function w(id: string, from: [string,string], to: [string,string], color = '#00aaff') {
  return { id, start: { componentId: from[0], pinName: from[1] }, end: { componentId: to[0], pinName: to[1] }, color };
}

export const circuitExamples: ExampleProject[] = [

  // ════════════════════════════════════════════════════════════════════════════
  // PASSIVE / ANALOG (10 examples)
  // ════════════════════════════════════════════════════════════════════════════

  {
    id: 'voltage-divider',
    title: 'Voltage Divider',
    description: 'R1 + R2 divide 5V into a lower voltage read by ADC. Fundamental analog circuit.',
    category: 'basics', difficulty: 'beginner',
    code: `// Voltage Divider — reads V_out = 5 * R2/(R1+R2)
void setup() { Serial.begin(9600); }
void loop() {
  int raw = analogRead(A0);
  float v = raw * 5.0 / 1023.0;
  Serial.print("V_out = "); Serial.print(v, 3); Serial.println(" V");
  delay(500);
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'r1', x: 350, y: 80, properties: { value: '10000' } },
      { type: 'wokwi-resistor', id: 'r2', x: 350, y: 200, properties: { value: '10000' } },
    ],
    wires: [
      w('w1', ['uno','5V'], ['r1','1'], '#ff0000'),
      w('w2', ['r1','2'], ['r2','1'], '#00aaff'),
      w('w3', ['r2','2'], ['uno','GND'], '#000000'),
      w('w4', ['r1','2'], ['uno','A0'], '#ffaa00'),
    ],
  },

  {
    id: 'rc-low-pass-filter',
    title: 'RC Low-Pass Filter',
    description: 'PWM output filtered by RC gives smooth analog voltage. Classic DAC trick.',
    category: 'basics', difficulty: 'beginner',
    code: `// RC Low-Pass Filter
// PWM on pin 9 → R=10k → C=10uF → smooth DC on A0
void setup() { Serial.begin(9600); analogWrite(9, 128); } // 50% duty
void loop() {
  float v = analogRead(A0) * 5.0 / 1023.0;
  Serial.print("Filtered V = "); Serial.println(v, 2);
  delay(200);
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'r1', x: 350, y: 100, properties: { value: '10000' } },
    ],
    wires: [
      w('w1', ['uno','9'], ['r1','1'], '#00aaff'),
      w('w2', ['r1','2'], ['uno','A0'], '#ffaa00'),
      w('w3', ['r1','2'], ['uno','GND'], '#000000'),
    ],
  },

  {
    id: 'wheatstone-bridge',
    title: 'Wheatstone Bridge',
    description: 'Four-resistor bridge detects tiny resistance changes. Used in strain gauges and load cells.',
    category: 'sensors', difficulty: 'intermediate',
    code: `// Wheatstone Bridge — detects R imbalance
void setup() { Serial.begin(9600); }
void loop() {
  float vA = analogRead(A0) * 5.0 / 1023.0;
  float vB = analogRead(A1) * 5.0 / 1023.0;
  float diff = vA - vB;
  Serial.print("V_diff = "); Serial.print(diff * 1000, 1); Serial.println(" mV");
  delay(500);
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'r1', x: 350, y: 60, properties: { value: '10000' } },
      { type: 'wokwi-resistor', id: 'r2', x: 500, y: 60, properties: { value: '10000' } },
      { type: 'wokwi-resistor', id: 'r3', x: 350, y: 200, properties: { value: '11000' } },
      { type: 'wokwi-resistor', id: 'r4', x: 500, y: 200, properties: { value: '10000' } },
    ],
    wires: [
      w('w1', ['uno','5V'], ['r1','1'], '#ff0000'),
      w('w2', ['uno','5V'], ['r2','1'], '#ff0000'),
      w('w3', ['r1','2'], ['r3','1'], '#00aaff'),
      w('w4', ['r2','2'], ['r4','1'], '#00aaff'),
      w('w5', ['r3','2'], ['uno','GND'], '#000000'),
      w('w6', ['r4','2'], ['uno','GND'], '#000000'),
      w('w7', ['r1','2'], ['uno','A0'], '#ffaa00'),
      w('w8', ['r2','2'], ['uno','A1'], '#ffaa00'),
    ],
  },

  {
    id: 'ntc-temperature',
    title: 'NTC Temperature Sensor',
    description: 'NTC thermistor + 10k pull-up resistor. Calculates temperature via beta model.',
    category: 'sensors', difficulty: 'beginner',
    code: `// NTC Temperature Sensor (beta model)
#define NTC_PIN A0
#define R_PULL 10000.0
#define NTC_R0 10000.0
#define NTC_T0 298.15
#define NTC_BETA 3950.0

void setup() { Serial.begin(9600); }
void loop() {
  int raw = analogRead(NTC_PIN);
  float v = raw * 5.0 / 1023.0;
  float rNtc = R_PULL * v / (5.0 - v);
  float tK = 1.0 / (1.0/NTC_T0 + log(rNtc/NTC_R0)/NTC_BETA);
  float tC = tK - 273.15;
  Serial.print("Temp = "); Serial.print(tC, 1); Serial.println(" C");
  delay(1000);
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'rpull', x: 350, y: 80, properties: { value: '10000' } },
      { type: 'wokwi-ntc-temperature-sensor', id: 'ntc', x: 350, y: 200, properties: { temperature: '25' } },
    ],
    wires: [
      w('w1', ['uno','5V'], ['rpull','1'], '#ff0000'),
      w('w2', ['rpull','2'], ['ntc','1'], '#ffaa00'),
      w('w3', ['ntc','2'], ['uno','GND'], '#000000'),
      w('w4', ['rpull','2'], ['uno','A0'], '#ffaa00'),
    ],
  },

  {
    id: 'led-current-limiting',
    title: 'LED with Current-Limiting Resistor',
    description: 'Calculate R to set LED current to 10mA. I = (Vcc-Vf)/R.',
    category: 'basics', difficulty: 'beginner',
    code: `// LED with current-limiting resistor
// R = (5V - 2V) / 10mA = 300 ohm
void setup() { pinMode(13, OUTPUT); }
void loop() {
  digitalWrite(13, HIGH); delay(1000);
  digitalWrite(13, LOW);  delay(1000);
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'r1', x: 380, y: 120, properties: { value: '330' } },
      { type: 'wokwi-led', id: 'led1', x: 380, y: 220, properties: { color: 'red' } },
    ],
    wires: [
      w('w1', ['uno','13'], ['r1','1'], '#00aaff'),
      w('w2', ['r1','2'], ['led1','A'], '#00aaff'),
      w('w3', ['led1','C'], ['uno','GND'], '#000000'),
    ],
  },

  {
    id: 'parallel-resistors',
    title: 'Parallel Resistors',
    description: 'Three resistors in parallel: R_total = 1/(1/R1+1/R2+1/R3). Measure with ADC.',
    category: 'basics', difficulty: 'beginner',
    code: `// Parallel Resistors — measure equivalent R via voltage divider
// R_series = 10k, R_parallel = 1/(1/10k + 1/10k + 1/10k) = 3.33k
// V_out = 5 * R_par / (R_ser + R_par) = 5 * 3.33 / 13.33 = 1.25V
void setup() { Serial.begin(9600); }
void loop() {
  float v = analogRead(A0) * 5.0 / 1023.0;
  Serial.print("V = "); Serial.println(v, 3);
  delay(500);
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'rs', x: 350, y: 80, properties: { value: '10000' } },
      { type: 'wokwi-resistor', id: 'r1', x: 350, y: 200, properties: { value: '10000' } },
      { type: 'wokwi-resistor', id: 'r2', x: 420, y: 200, properties: { value: '10000' } },
      { type: 'wokwi-resistor', id: 'r3', x: 490, y: 200, properties: { value: '10000' } },
    ],
    wires: [
      w('w1', ['uno','5V'], ['rs','1'], '#ff0000'),
      w('w2', ['rs','2'], ['r1','1'], '#ffaa00'),
      w('w3', ['rs','2'], ['r2','1'], '#ffaa00'),
      w('w4', ['rs','2'], ['r3','1'], '#ffaa00'),
      w('w5', ['r1','2'], ['uno','GND'], '#000000'),
      w('w6', ['r2','2'], ['uno','GND'], '#000000'),
      w('w7', ['r3','2'], ['uno','GND'], '#000000'),
      w('w8', ['rs','2'], ['uno','A0'], '#ffaa00'),
    ],
  },

  {
    id: 'pot-adc-reader',
    title: 'Potentiometer ADC Reader',
    description: 'Turn the potentiometer knob to vary the voltage on A0 from 0 to 5V.',
    category: 'basics', difficulty: 'beginner',
    code: `// Potentiometer reader
void setup() { Serial.begin(9600); }
void loop() {
  int raw = analogRead(A0);
  float pct = raw * 100.0 / 1023.0;
  Serial.print("Position: "); Serial.print(pct, 1); Serial.println("%");
  delay(200);
}`,
    components: [
      UNO,
      { type: 'wokwi-potentiometer', id: 'pot', x: 380, y: 160, properties: {} },
    ],
    wires: [
      w('w1', ['uno','5V'], ['pot','VCC'], '#ff0000'),
      w('w2', ['pot','GND'], ['uno','GND'], '#000000'),
      w('w3', ['pot','SIG'], ['uno','A0'], '#ffaa00'),
    ],
  },

  {
    id: 'photoresistor-light',
    title: 'Photoresistor Light Sensor',
    description: 'LDR + pull-down resistor. Brighter light = lower LDR resistance = higher voltage.',
    category: 'sensors', difficulty: 'beginner',
    code: `// Photoresistor light sensor
void setup() { Serial.begin(9600); }
void loop() {
  int raw = analogRead(A0);
  float lux = map(raw, 0, 1023, 0, 100);
  Serial.print("Light: "); Serial.print(lux, 0); Serial.println("%");
  delay(300);
}`,
    components: [
      UNO,
      { type: 'wokwi-photoresistor-sensor', id: 'ldr', x: 380, y: 100, properties: { lux: '500' } },
      { type: 'wokwi-resistor', id: 'rpull', x: 380, y: 220, properties: { value: '10000' } },
    ],
    wires: [
      w('w1', ['uno','5V'], ['ldr','VCC'], '#ff0000'),
      w('w2', ['ldr','SIG'], ['rpull','1'], '#ffaa00'),
      w('w3', ['rpull','2'], ['uno','GND'], '#000000'),
      w('w4', ['ldr','SIG'], ['uno','A0'], '#ffaa00'),
    ],
  },

  {
    id: 'multi-led-bar',
    title: 'LED Bar Graph',
    description: '5 LEDs driven from digital pins with individual resistors. Bargraph display.',
    category: 'basics', difficulty: 'beginner',
    code: `// LED Bar Graph — 5 LEDs on pins 2-6
void setup() { for(int i=2;i<=6;i++) pinMode(i,OUTPUT); }
void loop() {
  for(int i=2;i<=6;i++) { digitalWrite(i,HIGH); delay(200); }
  for(int i=6;i>=2;i--) { digitalWrite(i,LOW);  delay(200); }
}`,
    components: [
      UNO,
      ...Array.from({length:5}, (_,i) => ({ type: 'wokwi-resistor', id: `r${i}`, x: 350, y: 60+i*50, properties: { value: '220' } })),
      ...Array.from({length:5}, (_,i) => ({ type: 'wokwi-led', id: `led${i}`, x: 450, y: 60+i*50, properties: { color: ['red','yellow','green','blue','white'][i] } })),
    ],
    wires: [
      ...Array.from({length:5}, (_,i) => w(`wa${i}`, ['uno',`${i+2}`], [`r${i}`,'1'])),
      ...Array.from({length:5}, (_,i) => w(`wb${i}`, [`r${i}`,'2'], [`led${i}`,'A'])),
      ...Array.from({length:5}, (_,i) => w(`wc${i}`, [`led${i}`,'C'], ['uno','GND'], '#000000')),
    ],
  },

  {
    id: 'capacitor-charge-curve',
    title: 'Capacitor Charging Curve',
    description: 'Charge a capacitor through a resistor, read the exponential V(t) via ADC.',
    category: 'basics', difficulty: 'intermediate',
    code: `// RC Charging — observe exponential curve
// tau = R*C = 10k * 100uF = 1 second
void setup() {
  Serial.begin(9600);
  pinMode(8, OUTPUT);
  digitalWrite(8, HIGH); // start charging
}
void loop() {
  float v = analogRead(A0) * 5.0 / 1023.0;
  Serial.print("V_cap = "); Serial.println(v, 3);
  delay(100);
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'r1', x: 380, y: 100, properties: { value: '10000' } },
    ],
    wires: [
      w('w1', ['uno','8'], ['r1','1'], '#00aaff'),
      w('w2', ['r1','2'], ['uno','A0'], '#ffaa00'),
      w('w3', ['r1','2'], ['uno','GND'], '#000000'),
    ],
  },

  // ════════════════════════════════════════════════════════════════════════════
  // TRANSISTOR / SEMICONDUCTOR (8 examples)
  // ════════════════════════════════════════════════════════════════════════════

  {
    id: 'npn-led-switch',
    title: 'NPN Transistor LED Switch',
    description: '2N2222 NPN switches a high-current LED from a low-current MCU pin.',
    category: 'basics', difficulty: 'intermediate',
    code: `// NPN switch — pin 9 drives base through 1k, collector drives LED
void setup() { pinMode(9, OUTPUT); }
void loop() {
  digitalWrite(9, HIGH); delay(1000);
  digitalWrite(9, LOW);  delay(1000);
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'rb', x: 380, y: 100, properties: { value: '1000' } },
      { type: 'wokwi-resistor', id: 'rc', x: 480, y: 60, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'led1', x: 480, y: 160, properties: { color: 'green' } },
    ],
    wires: [
      w('w1', ['uno','9'], ['rb','1']),
      w('w2', ['uno','5V'], ['rc','1'], '#ff0000'),
      w('w3', ['rc','2'], ['led1','A']),
      w('w4', ['led1','C'], ['uno','GND'], '#000000'),
    ],
  },

  {
    id: 'pnp-high-side-switch',
    title: 'PNP High-Side Switch',
    description: '2N3906 PNP switches a load to Vcc when base is pulled LOW.',
    category: 'basics', difficulty: 'intermediate',
    code: `// PNP high-side switch
// Pin 9 LOW = load ON, Pin 9 HIGH = load OFF
void setup() { pinMode(9, OUTPUT); }
void loop() {
  digitalWrite(9, LOW);  delay(2000); // ON
  digitalWrite(9, HIGH); delay(2000); // OFF
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'rb', x: 380, y: 100, properties: { value: '1000' } },
      { type: 'wokwi-resistor', id: 'rl', x: 480, y: 200, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'led1', x: 480, y: 280, properties: { color: 'red' } },
    ],
    wires: [
      w('w1', ['uno','9'], ['rb','1']),
      w('w2', ['rl','2'], ['led1','A']),
      w('w3', ['led1','C'], ['uno','GND'], '#000000'),
    ],
  },

  {
    id: 'mosfet-pwm-led',
    title: 'MOSFET PWM LED Dimmer',
    description: '2N7000 N-MOSFET driven by PWM. Vgs=3.3V fully enhances the FET.',
    category: 'basics', difficulty: 'intermediate',
    code: `// MOSFET PWM LED dimmer
void setup() { pinMode(9, OUTPUT); }
void loop() {
  for(int b=0; b<=255; b+=5) { analogWrite(9, b); delay(30); }
  for(int b=255; b>=0; b-=5) { analogWrite(9, b); delay(30); }
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'rl', x: 420, y: 60, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'led1', x: 420, y: 160, properties: { color: 'white' } },
    ],
    wires: [
      w('w1', ['uno','5V'], ['rl','1'], '#ff0000'),
      w('w2', ['rl','2'], ['led1','A']),
      w('w3', ['led1','C'], ['uno','GND'], '#000000'),
    ],
  },

  {
    id: 'diode-rectifier',
    title: 'Half-Wave Rectifier',
    description: 'Diode passes only positive half-cycles. Read rectified output on ADC.',
    category: 'basics', difficulty: 'intermediate',
    code: `// Half-wave rectifier — observe on Serial plotter
void setup() { Serial.begin(115200); }
void loop() {
  int raw = analogRead(A0);
  Serial.println(raw);
  delay(5);
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'rl', x: 420, y: 200, properties: { value: '1000' } },
    ],
    wires: [
      w('w1', ['rl','2'], ['uno','GND'], '#000000'),
      w('w2', ['rl','1'], ['uno','A0'], '#ffaa00'),
    ],
  },

  {
    id: 'zener-regulator',
    title: 'Zener Voltage Regulator',
    description: '5.1V Zener clamps output. Even if input varies, output stays at 5.1V.',
    category: 'basics', difficulty: 'intermediate',
    code: `// Zener 5.1V regulator
// Input = 9V battery, Rs = 220 ohm, Zener clamps to 5.1V
void setup() { Serial.begin(9600); }
void loop() {
  float v = analogRead(A0) * 5.0 / 1023.0;
  Serial.print("V_regulated = "); Serial.println(v, 2);
  delay(500);
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'rs', x: 380, y: 100, properties: { value: '220' } },
    ],
    wires: [
      w('w1', ['rs','2'], ['uno','A0'], '#ffaa00'),
      w('w2', ['rs','2'], ['uno','GND'], '#000000'),
    ],
  },

  {
    id: 'schottky-reverse-protection',
    title: 'Reverse Polarity Protection',
    description: 'Schottky diode protects circuit from accidental reverse battery connection.',
    category: 'basics', difficulty: 'beginner',
    code: `// Schottky reverse-polarity protection
// 1N5817: low Vf = 0.3V, minimal power loss
void setup() { Serial.begin(9600); }
void loop() {
  Serial.println("Protected circuit running...");
  delay(1000);
}`,
    components: [ UNO ],
    wires: [],
  },

  {
    id: 'bjt-common-emitter',
    title: 'Common-Emitter Amplifier',
    description: 'NPN BJT amplifies a small AC signal. Gain = -Rc/Re.',
    category: 'basics', difficulty: 'advanced',
    code: `// Common-emitter amplifier
// Biased at Vcc/2, gain ~ -Rc/Re = -4.7
void setup() { Serial.begin(115200); }
void loop() {
  int raw = analogRead(A0);
  Serial.println(raw);
  delay(1);
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'rb1', x: 350, y: 60, properties: { value: '47000' } },
      { type: 'wokwi-resistor', id: 'rb2', x: 350, y: 180, properties: { value: '10000' } },
      { type: 'wokwi-resistor', id: 'rc', x: 450, y: 60, properties: { value: '4700' } },
      { type: 'wokwi-resistor', id: 're', x: 450, y: 280, properties: { value: '1000' } },
    ],
    wires: [
      w('w1', ['uno','5V'], ['rb1','1'], '#ff0000'),
      w('w2', ['uno','5V'], ['rc','1'], '#ff0000'),
      w('w3', ['rb1','2'], ['rb2','1']),
      w('w4', ['rb2','2'], ['uno','GND'], '#000000'),
      w('w5', ['re','2'], ['uno','GND'], '#000000'),
      w('w6', ['rc','2'], ['uno','A0'], '#ffaa00'),
    ],
  },

  {
    id: 'darlington-high-current',
    title: 'Darlington Pair (High Current)',
    description: 'Two NPN BJTs cascaded for beta-squared current gain. Drives heavy loads from MCU.',
    category: 'basics', difficulty: 'advanced',
    code: `// Darlington pair — drives a high-current load
void setup() { pinMode(9, OUTPUT); }
void loop() {
  analogWrite(9, 128); // 50% duty
  delay(1000);
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'rb', x: 380, y: 100, properties: { value: '10000' } },
      { type: 'wokwi-resistor', id: 'rl', x: 480, y: 100, properties: { value: '100' } },
    ],
    wires: [
      w('w1', ['uno','9'], ['rb','1']),
      w('w2', ['uno','5V'], ['rl','1'], '#ff0000'),
      w('w3', ['rl','2'], ['uno','GND'], '#000000'),
    ],
  },

  // ════════════════════════════════════════════════════════════════════════════
  // OP-AMP (5 examples)
  // ════════════════════════════════════════════════════════════════════════════

  {
    id: 'opamp-inverting',
    title: 'Inverting Amplifier (LM358)',
    description: 'Vout = -(Rf/Rin) * Vin. Gain=-10 with Rin=1k, Rf=10k.',
    category: 'basics', difficulty: 'intermediate',
    code: `// Inverting amplifier — gain = -Rf/Rin = -10
void setup() { Serial.begin(9600); }
void loop() {
  float vin = analogRead(A0) * 5.0 / 1023.0;
  float vout = analogRead(A1) * 5.0 / 1023.0;
  Serial.print("Vin="); Serial.print(vin,2);
  Serial.print(" Vout="); Serial.println(vout,2);
  delay(500);
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'rin', x: 350, y: 100, properties: { value: '1000' } },
      { type: 'wokwi-resistor', id: 'rf', x: 350, y: 200, properties: { value: '10000' } },
    ],
    wires: [
      w('w1', ['rin','2'], ['rf','1']),
      w('w2', ['rf','2'], ['uno','A1'], '#ffaa00'),
      w('w3', ['rin','1'], ['uno','A0'], '#ffaa00'),
    ],
  },

  {
    id: 'opamp-voltage-follower',
    title: 'Voltage Follower (Buffer)',
    description: 'Op-amp with 100% feedback. Vout = Vin. High Z input, low Z output.',
    category: 'basics', difficulty: 'beginner',
    code: `// Voltage follower — Vout tracks Vin exactly
void setup() { Serial.begin(9600); }
void loop() {
  float vin = analogRead(A0) * 5.0 / 1023.0;
  float vout = analogRead(A1) * 5.0 / 1023.0;
  Serial.print("Vin="); Serial.print(vin,3);
  Serial.print(" Vout="); Serial.println(vout,3);
  delay(500);
}`,
    components: [
      UNO,
      { type: 'wokwi-potentiometer', id: 'pot', x: 350, y: 160, properties: {} },
    ],
    wires: [
      w('w1', ['uno','5V'], ['pot','VCC'], '#ff0000'),
      w('w2', ['pot','GND'], ['uno','GND'], '#000000'),
      w('w3', ['pot','SIG'], ['uno','A0'], '#ffaa00'),
      w('w4', ['pot','SIG'], ['uno','A1'], '#ffaa00'),
    ],
  },

  {
    id: 'opamp-comparator',
    title: 'Comparator with LED',
    description: 'Op-amp compares pot voltage vs 2.5V reference. LED indicates which is higher.',
    category: 'basics', difficulty: 'intermediate',
    code: `// Comparator — LED lights when pot > 2.5V
void setup() { Serial.begin(9600); }
void loop() {
  float vpot = analogRead(A0) * 5.0 / 1023.0;
  Serial.print("Pot = "); Serial.print(vpot,2);
  Serial.println(vpot > 2.5 ? " > ref -> LED ON" : " < ref -> LED OFF");
  delay(300);
}`,
    components: [
      UNO,
      { type: 'wokwi-potentiometer', id: 'pot', x: 350, y: 120, properties: {} },
      { type: 'wokwi-led', id: 'led1', x: 480, y: 200, properties: { color: 'green' } },
      { type: 'wokwi-resistor', id: 'rl', x: 480, y: 120, properties: { value: '220' } },
    ],
    wires: [
      w('w1', ['uno','5V'], ['pot','VCC'], '#ff0000'),
      w('w2', ['pot','GND'], ['uno','GND'], '#000000'),
      w('w3', ['pot','SIG'], ['uno','A0'], '#ffaa00'),
      w('w4', ['rl','2'], ['led1','A']),
      w('w5', ['led1','C'], ['uno','GND'], '#000000'),
    ],
  },

  {
    id: 'opamp-difference',
    title: 'Difference Amplifier',
    description: 'Vout = Gain * (V2 - V1). Useful for bridge sensors and differential signals.',
    category: 'sensors', difficulty: 'advanced',
    code: `// Difference amplifier — Gain=10, Vout = 10*(V2-V1)
void setup() { Serial.begin(9600); }
void loop() {
  float v1 = analogRead(A0) * 5.0 / 1023.0;
  float v2 = analogRead(A1) * 5.0 / 1023.0;
  float vout = analogRead(A2) * 5.0 / 1023.0;
  Serial.print("V1="); Serial.print(v1,2);
  Serial.print(" V2="); Serial.print(v2,2);
  Serial.print(" Vout="); Serial.println(vout,2);
  delay(500);
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'r1', x: 350, y: 80, properties: { value: '10000' } },
      { type: 'wokwi-resistor', id: 'r2', x: 350, y: 160, properties: { value: '100000' } },
      { type: 'wokwi-resistor', id: 'r3', x: 350, y: 240, properties: { value: '10000' } },
      { type: 'wokwi-resistor', id: 'r4', x: 350, y: 320, properties: { value: '100000' } },
    ],
    wires: [
      w('w1', ['r1','1'], ['uno','A0'], '#ffaa00'),
      w('w2', ['r3','1'], ['uno','A1'], '#ffaa00'),
      w('w3', ['r1','2'], ['r2','1']),
      w('w4', ['r2','2'], ['uno','A2'], '#ffaa00'),
    ],
  },

  {
    id: 'opamp-schmitt-trigger',
    title: 'Schmitt Trigger',
    description: 'Op-amp with positive feedback creates hysteresis. Cleans up noisy signals.',
    category: 'basics', difficulty: 'advanced',
    code: `// Schmitt trigger — cleans noisy input
void setup() { Serial.begin(9600); }
void loop() {
  int raw = analogRead(A0);
  int out = analogRead(A1);
  Serial.print(raw); Serial.print(","); Serial.println(out);
  delay(10);
}`,
    components: [
      UNO,
      { type: 'wokwi-potentiometer', id: 'pot', x: 350, y: 160, properties: {} },
      { type: 'wokwi-resistor', id: 'rin', x: 450, y: 100, properties: { value: '10000' } },
      { type: 'wokwi-resistor', id: 'rfb', x: 450, y: 200, properties: { value: '100000' } },
    ],
    wires: [
      w('w1', ['uno','5V'], ['pot','VCC'], '#ff0000'),
      w('w2', ['pot','GND'], ['uno','GND'], '#000000'),
      w('w3', ['pot','SIG'], ['rin','1']),
      w('w4', ['rin','2'], ['rfb','1']),
      w('w5', ['rfb','2'], ['uno','A1'], '#ffaa00'),
      w('w6', ['pot','SIG'], ['uno','A0'], '#ffaa00'),
    ],
  },

  // ════════════════════════════════════════════════════════════════════════════
  // LOGIC GATES (6 examples)
  // ════════════════════════════════════════════════════════════════════════════

  {
    id: 'and-gate-alarm',
    title: 'AND Gate Alarm',
    description: 'Buzzer sounds only when BOTH buttons are pressed (AND logic).',
    category: 'basics', difficulty: 'beginner',
    code: `// AND gate alarm — both buttons must be pressed
void setup() { pinMode(2, INPUT_PULLUP); pinMode(3, INPUT_PULLUP); pinMode(8, OUTPUT); }
void loop() {
  bool a = !digitalRead(2);
  bool b = !digitalRead(3);
  digitalWrite(8, a && b ? HIGH : LOW);
}`,
    components: [
      UNO,
      { type: 'wokwi-pushbutton', id: 'btn1', x: 350, y: 80, properties: {} },
      { type: 'wokwi-pushbutton', id: 'btn2', x: 350, y: 180, properties: {} },
      { type: 'wokwi-led', id: 'led1', x: 480, y: 130, properties: { color: 'red' } },
      { type: 'wokwi-resistor', id: 'rl', x: 480, y: 60, properties: { value: '220' } },
    ],
    wires: [
      w('w1', ['uno','2'], ['btn1','1.l']),
      w('w2', ['btn1','2.l'], ['uno','GND'], '#000000'),
      w('w3', ['uno','3'], ['btn2','1.l']),
      w('w4', ['btn2','2.l'], ['uno','GND'], '#000000'),
      w('w5', ['uno','8'], ['rl','1']),
      w('w6', ['rl','2'], ['led1','A']),
      w('w7', ['led1','C'], ['uno','GND'], '#000000'),
    ],
  },

  {
    id: 'xor-toggle-detector',
    title: 'XOR Toggle Detector',
    description: 'XOR gate detects when two switches are in different positions.',
    category: 'basics', difficulty: 'beginner',
    code: `// XOR — LED on when switches differ
void setup() { pinMode(2,INPUT_PULLUP); pinMode(3,INPUT_PULLUP); pinMode(13,OUTPUT); }
void loop() {
  bool a = !digitalRead(2), b = !digitalRead(3);
  digitalWrite(13, a != b);
}`,
    components: [
      UNO,
      { type: 'wokwi-pushbutton', id: 'sw1', x: 350, y: 80, properties: {} },
      { type: 'wokwi-pushbutton', id: 'sw2', x: 350, y: 180, properties: {} },
    ],
    wires: [
      w('w1', ['uno','2'], ['sw1','1.l']),
      w('w2', ['sw1','2.l'], ['uno','GND'], '#000000'),
      w('w3', ['uno','3'], ['sw2','1.l']),
      w('w4', ['sw2','2.l'], ['uno','GND'], '#000000'),
    ],
  },

  {
    id: 'nand-sr-latch',
    title: 'NAND SR Latch',
    description: 'Two cross-coupled NAND gates form a Set-Reset latch. Memory without a clock!',
    category: 'basics', difficulty: 'intermediate',
    code: `// Software NAND SR latch simulation
bool q = false;
void setup() { Serial.begin(9600); pinMode(2,INPUT_PULLUP); pinMode(3,INPUT_PULLUP); pinMode(13,OUTPUT); }
void loop() {
  bool s = !digitalRead(2), r = !digitalRead(3);
  if(s && !r) q = true;
  if(r && !s) q = false;
  digitalWrite(13, q);
  Serial.print("S="); Serial.print(s); Serial.print(" R="); Serial.print(r);
  Serial.print(" Q="); Serial.println(q);
  delay(200);
}`,
    components: [
      UNO,
      { type: 'wokwi-pushbutton', id: 'setBtn', x: 350, y: 80, properties: {} },
      { type: 'wokwi-pushbutton', id: 'rstBtn', x: 350, y: 180, properties: {} },
      { type: 'wokwi-led', id: 'qled', x: 480, y: 130, properties: { color: 'green' } },
      { type: 'wokwi-resistor', id: 'rl', x: 480, y: 60, properties: { value: '220' } },
    ],
    wires: [
      w('w1', ['uno','2'], ['setBtn','1.l']),
      w('w2', ['setBtn','2.l'], ['uno','GND'], '#000000'),
      w('w3', ['uno','3'], ['rstBtn','1.l']),
      w('w4', ['rstBtn','2.l'], ['uno','GND'], '#000000'),
      w('w5', ['uno','13'], ['rl','1']),
      w('w6', ['rl','2'], ['qled','A']),
      w('w7', ['qled','C'], ['uno','GND'], '#000000'),
    ],
  },

  {
    id: 'full-adder',
    title: 'Full Adder (1-bit)',
    description: 'Sum = A XOR B XOR Cin, Cout = (A AND B) OR (Cin AND (A XOR B)).',
    category: 'basics', difficulty: 'intermediate',
    code: `// 1-bit full adder in software
void setup() { Serial.begin(9600); pinMode(2,INPUT_PULLUP); pinMode(3,INPUT_PULLUP); pinMode(4,INPUT_PULLUP); }
void loop() {
  bool a=!digitalRead(2), b=!digitalRead(3), cin=!digitalRead(4);
  bool sum = a ^ b ^ cin;
  bool cout = (a&b) | (cin&(a^b));
  Serial.print("A="); Serial.print(a); Serial.print(" B="); Serial.print(b);
  Serial.print(" Cin="); Serial.print(cin); Serial.print(" Sum="); Serial.print(sum);
  Serial.print(" Cout="); Serial.println(cout);
  delay(300);
}`,
    components: [
      UNO,
      { type: 'wokwi-pushbutton', id: 'bA', x: 350, y: 60, properties: {} },
      { type: 'wokwi-pushbutton', id: 'bB', x: 350, y: 140, properties: {} },
      { type: 'wokwi-pushbutton', id: 'bCin', x: 350, y: 220, properties: {} },
      { type: 'wokwi-led', id: 'sumLed', x: 480, y: 100, properties: { color: 'green' } },
      { type: 'wokwi-led', id: 'coutLed', x: 480, y: 200, properties: { color: 'red' } },
    ],
    wires: [
      w('w1', ['uno','2'], ['bA','1.l']),
      w('w2', ['bA','2.l'], ['uno','GND'], '#000000'),
      w('w3', ['uno','3'], ['bB','1.l']),
      w('w4', ['bB','2.l'], ['uno','GND'], '#000000'),
      w('w5', ['uno','4'], ['bCin','1.l']),
      w('w6', ['bCin','2.l'], ['uno','GND'], '#000000'),
    ],
  },

  {
    id: 'binary-counter-leds',
    title: '4-bit Binary Counter',
    description: 'Count from 0 to 15 displayed on 4 LEDs. Each LED = one bit.',
    category: 'basics', difficulty: 'beginner',
    code: `// 4-bit binary counter on LEDs
int count = 0;
void setup() { for(int i=2;i<=5;i++) pinMode(i,OUTPUT); }
void loop() {
  for(int i=0;i<4;i++) digitalWrite(i+2, (count>>i)&1);
  count = (count+1) % 16;
  delay(500);
}`,
    components: [
      UNO,
      ...Array.from({length:4}, (_,i) => ({ type: 'wokwi-resistor', id: `r${i}`, x: 380, y: 60+i*60, properties: { value: '220' } })),
      ...Array.from({length:4}, (_,i) => ({ type: 'wokwi-led', id: `led${i}`, x: 460, y: 60+i*60, properties: { color: ['red','yellow','green','blue'][i] } })),
    ],
    wires: [
      ...Array.from({length:4}, (_,i) => w(`wa${i}`, ['uno',`${i+2}`], [`r${i}`,'1'])),
      ...Array.from({length:4}, (_,i) => w(`wb${i}`, [`r${i}`,'2'], [`led${i}`,'A'])),
      ...Array.from({length:4}, (_,i) => w(`wc${i}`, [`led${i}`,'C'], ['uno','GND'], '#000000')),
    ],
  },

  {
    id: 'logic-probe',
    title: 'Logic Probe (HIGH/LOW/FLOATING)',
    description: 'Read any digital pin state and show on 3 LEDs: green=HIGH, red=LOW, yellow=floating.',
    category: 'basics', difficulty: 'intermediate',
    code: `// Logic probe — tests pin 7
void setup() {
  pinMode(10,OUTPUT); pinMode(11,OUTPUT); pinMode(12,OUTPUT); // R,Y,G
  pinMode(7,INPUT);
  Serial.begin(9600);
}
void loop() {
  int val = digitalRead(7);
  digitalWrite(12, val == HIGH);  // Green = HIGH
  digitalWrite(10, val == LOW);   // Red = LOW
  Serial.println(val ? "HIGH" : "LOW");
  delay(200);
}`,
    components: [
      UNO,
      { type: 'wokwi-led', id: 'gLed', x: 400, y: 60, properties: { color: 'green' } },
      { type: 'wokwi-led', id: 'rLed', x: 400, y: 140, properties: { color: 'red' } },
      { type: 'wokwi-resistor', id: 'rg', x: 400, y: 10, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'rr', x: 400, y: 90, properties: { value: '220' } },
    ],
    wires: [
      w('w1', ['uno','12'], ['rg','1']),
      w('w2', ['rg','2'], ['gLed','A']),
      w('w3', ['gLed','C'], ['uno','GND'], '#000000'),
      w('w4', ['uno','10'], ['rr','1']),
      w('w5', ['rr','2'], ['rLed','A']),
      w('w6', ['rLed','C'], ['uno','GND'], '#000000'),
    ],
  },

  // ════════════════════════════════════════════════════════════════════════════
  // ELECTROMECHANICAL (4 examples)
  // ════════════════════════════════════════════════════════════════════════════

  {
    id: 'relay-led-switch',
    title: 'Relay-Controlled LED',
    description: 'NPN transistor drives a relay. Relay switches an LED connected to a separate supply.',
    category: 'robotics', difficulty: 'intermediate',
    code: `// Relay control via NPN transistor
void setup() { pinMode(9, OUTPUT); }
void loop() {
  digitalWrite(9, HIGH); delay(2000); // relay ON
  digitalWrite(9, LOW);  delay(2000); // relay OFF
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'rb', x: 380, y: 100, properties: { value: '1000' } },
      { type: 'wokwi-led', id: 'led1', x: 500, y: 200, properties: { color: 'red' } },
      { type: 'wokwi-resistor', id: 'rl', x: 500, y: 120, properties: { value: '220' } },
    ],
    wires: [
      w('w1', ['uno','9'], ['rb','1']),
      w('w2', ['rl','2'], ['led1','A']),
      w('w3', ['led1','C'], ['uno','GND'], '#000000'),
    ],
  },

  {
    id: 'optocoupler-signal',
    title: 'Optocoupler Signal Isolation',
    description: '4N25 optocoupler isolates MCU from a higher-voltage circuit.',
    category: 'communication', difficulty: 'intermediate',
    code: `// Optocoupler 4N25 — MCU drives LED side, reads phototransistor side
void setup() { pinMode(9,OUTPUT); Serial.begin(9600); }
void loop() {
  digitalWrite(9,HIGH); delay(500);
  int val = analogRead(A0);
  Serial.print("Isolated signal: "); Serial.println(val);
  digitalWrite(9,LOW); delay(500);
  val = analogRead(A0);
  Serial.print("Isolated signal: "); Serial.println(val);
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'rled', x: 380, y: 80, properties: { value: '270' } },
      { type: 'wokwi-resistor', id: 'rpull', x: 500, y: 80, properties: { value: '10000' } },
    ],
    wires: [
      w('w1', ['uno','9'], ['rled','1']),
      w('w2', ['uno','5V'], ['rpull','1'], '#ff0000'),
      w('w3', ['rpull','2'], ['uno','A0'], '#ffaa00'),
    ],
  },

  {
    id: 'l293d-motor-control',
    title: 'DC Motor Control (L293D)',
    description: 'L293D H-bridge drives a DC motor forward, reverse, and brake.',
    category: 'robotics', difficulty: 'intermediate',
    code: `// L293D motor control — forward, reverse, brake
#define EN 9
#define IN1 7
#define IN2 8
void setup() { pinMode(EN,OUTPUT); pinMode(IN1,OUTPUT); pinMode(IN2,OUTPUT); }
void forward()  { digitalWrite(IN1,HIGH); digitalWrite(IN2,LOW);  analogWrite(EN,200); }
void reverse()  { digitalWrite(IN1,LOW);  digitalWrite(IN2,HIGH); analogWrite(EN,200); }
void brake()    { digitalWrite(IN1,LOW);  digitalWrite(IN2,LOW);  analogWrite(EN,0);   }
void loop() {
  forward(); delay(2000);
  brake();   delay(500);
  reverse(); delay(2000);
  brake();   delay(500);
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'rm', x: 450, y: 200, properties: { value: '10' } },
    ],
    wires: [
      w('w1', ['rm','2'], ['uno','GND'], '#000000'),
    ],
  },

  {
    id: 'l293d-speed-pwm',
    title: 'Motor Speed Control (PWM)',
    description: 'Potentiometer controls motor speed via PWM on L293D enable pin.',
    category: 'robotics', difficulty: 'intermediate',
    code: `// Motor speed via potentiometer + L293D
#define EN 9
#define IN1 7
#define IN2 8
void setup() { pinMode(EN,OUTPUT); pinMode(IN1,OUTPUT); pinMode(IN2,OUTPUT);
  digitalWrite(IN1,HIGH); digitalWrite(IN2,LOW); }
void loop() {
  int pot = analogRead(A0);
  int speed = map(pot, 0, 1023, 0, 255);
  analogWrite(EN, speed);
  Serial.print("Speed: "); Serial.println(speed);
  delay(100);
}`,
    components: [
      UNO,
      { type: 'wokwi-potentiometer', id: 'pot', x: 350, y: 200, properties: {} },
    ],
    wires: [
      w('w1', ['uno','5V'], ['pot','VCC'], '#ff0000'),
      w('w2', ['pot','GND'], ['uno','GND'], '#000000'),
      w('w3', ['pot','SIG'], ['uno','A0'], '#ffaa00'),
    ],
  },

  // ════════════════════════════════════════════════════════════════════════════
  // POWER / REGULATOR (3 examples)
  // ════════════════════════════════════════════════════════════════════════════

  {
    id: 'power-supply-7805',
    title: '7805 Regulated Power Supply',
    description: '9V battery → 7805 → stable 5V for the Arduino. Classic linear regulator.',
    category: 'basics', difficulty: 'beginner',
    code: `// 7805 power supply — regulated 5V from 9V battery
// The 7805 provides stable 5V regardless of battery voltage (7-12V range)
void setup() { Serial.begin(9600); }
void loop() {
  float v = analogRead(A0) * 5.0 / 1023.0;
  Serial.print("Regulated voltage: "); Serial.print(v,2); Serial.println(" V");
  delay(1000);
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'rload', x: 420, y: 160, properties: { value: '1000' } },
    ],
    wires: [
      w('w1', ['rload','1'], ['uno','A0'], '#ffaa00'),
      w('w2', ['rload','2'], ['uno','GND'], '#000000'),
    ],
  },

  {
    id: 'lm317-adjustable-psu',
    title: 'LM317 Adjustable PSU',
    description: 'LM317 with R1/R2 divider. Vout = 1.25 * (1 + R2/R1). Set any voltage 1.25-37V.',
    category: 'basics', difficulty: 'intermediate',
    code: `// LM317 adjustable regulator
// R1 = 240, R2 = 720 -> Vout = 1.25 * (1 + 720/240) = 5.0V
void setup() { Serial.begin(9600); }
void loop() {
  float v = analogRead(A0) * 5.0 / 1023.0;
  Serial.print("LM317 Vout = "); Serial.print(v,2); Serial.println(" V");
  delay(500);
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'r1', x: 380, y: 100, properties: { value: '240' } },
      { type: 'wokwi-resistor', id: 'r2', x: 380, y: 200, properties: { value: '720' } },
    ],
    wires: [
      w('w1', ['r1','2'], ['r2','1']),
      w('w2', ['r2','2'], ['uno','GND'], '#000000'),
      w('w3', ['r1','1'], ['uno','A0'], '#ffaa00'),
    ],
  },

  {
    id: 'battery-voltage-monitor',
    title: 'Battery Voltage Monitor',
    description: 'Voltage divider scales 9V battery down to 0-5V range for ADC measurement.',
    category: 'sensors', difficulty: 'beginner',
    code: `// Battery voltage monitor
// R1=20k + R2=10k divider: V_adc = V_bat * 10k / 30k
// V_bat = V_adc * 3
void setup() { Serial.begin(9600); }
void loop() {
  float vAdc = analogRead(A0) * 5.0 / 1023.0;
  float vBat = vAdc * 3.0;
  Serial.print("Battery: "); Serial.print(vBat,1); Serial.println(" V");
  if(vBat < 7.0) Serial.println("WARNING: Battery low!");
  delay(1000);
}`,
    components: [
      UNO,
      { type: 'wokwi-resistor', id: 'r1', x: 350, y: 80, properties: { value: '20000' } },
      { type: 'wokwi-resistor', id: 'r2', x: 350, y: 200, properties: { value: '10000' } },
    ],
    wires: [
      w('w1', ['r1','2'], ['r2','1']),
      w('w2', ['r2','2'], ['uno','GND'], '#000000'),
      w('w3', ['r1','2'], ['uno','A0'], '#ffaa00'),
    ],
  },

  // ════════════════════════════════════════════════════════════════════════════
  // ESP32 / MEGA / NANO (4 board-specific examples)
  // ════════════════════════════════════════════════════════════════════════════

  {
    id: 'esp32-dual-adc',
    title: 'ESP32 Dual ADC Reader',
    description: 'ESP32 reads two analog channels (GPIO34, GPIO35) simultaneously at 12-bit resolution.',
    category: 'sensors', difficulty: 'beginner',
    boardType: 'esp32',
    code: `// ESP32 dual ADC — 12-bit, 3.3V reference
void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
}
void loop() {
  int ch1 = analogRead(34);
  int ch2 = analogRead(35);
  float v1 = ch1 * 3.3 / 4095.0;
  float v2 = ch2 * 3.3 / 4095.0;
  Serial.printf("CH1=%.3fV  CH2=%.3fV\\n", v1, v2);
  delay(500);
}`,
    components: [
      ESP32,
      { type: 'wokwi-potentiometer', id: 'pot1', x: 400, y: 80, properties: {} },
      { type: 'wokwi-potentiometer', id: 'pot2', x: 400, y: 220, properties: {} },
    ],
    wires: [
      w('w1', ['esp32','3V3'], ['pot1','VCC'], '#ff0000'),
      w('w2', ['pot1','GND'], ['esp32','GND'], '#000000'),
      w('w3', ['pot1','SIG'], ['esp32','34'], '#ffaa00'),
      w('w4', ['esp32','3V3'], ['pot2','VCC'], '#ff0000'),
      w('w5', ['pot2','GND'], ['esp32','GND'], '#000000'),
      w('w6', ['pot2','SIG'], ['esp32','35'], '#ffaa00'),
    ],
  },

  {
    id: 'mega-multi-led',
    title: 'Arduino Mega 16-LED Bar',
    description: 'Arduino Mega drives 16 LEDs from pins 22-37. Knight Rider scanner effect.',
    category: 'basics', difficulty: 'beginner',
    boardType: 'arduino-mega',
    code: `// Arduino Mega — 16-LED Knight Rider
void setup() { for(int i=22;i<=37;i++) pinMode(i,OUTPUT); }
void loop() {
  for(int i=22;i<=37;i++) { digitalWrite(i,HIGH); delay(50); digitalWrite(i,LOW); }
  for(int i=37;i>=22;i--) { digitalWrite(i,HIGH); delay(50); digitalWrite(i,LOW); }
}`,
    components: [
      MEGA,
      ...Array.from({length:8}, (_,i) => ({ type: 'wokwi-led', id: `led${i}`, x: 400+i*30, y: 300, properties: { color: 'red' } })),
    ],
    wires: [
      ...Array.from({length:8}, (_,i) => w(`wl${i}`, ['mega',`${22+i}`], [`led${i}`,'A'])),
      ...Array.from({length:8}, (_,i) => w(`wg${i}`, [`led${i}`,'C'], ['mega','GND'], '#000000')),
    ],
  },

  {
    id: 'nano-sensor-station',
    title: 'Arduino Nano Sensor Station',
    description: 'Compact weather station: NTC + photoresistor on Nano. Reads temp and light.',
    category: 'sensors', difficulty: 'beginner',
    boardType: 'arduino-nano',
    code: `// Nano sensor station — NTC + LDR
#define NTC_PIN A0
#define LDR_PIN A1
void setup() { Serial.begin(9600); }
void loop() {
  int tempRaw = analogRead(NTC_PIN);
  int lightRaw = analogRead(LDR_PIN);
  float tempV = tempRaw * 5.0 / 1023.0;
  float lightPct = lightRaw * 100.0 / 1023.0;
  Serial.print("Temp_V="); Serial.print(tempV,2);
  Serial.print("  Light="); Serial.print(lightPct,0); Serial.println("%");
  delay(1000);
}`,
    components: [
      { type: 'wokwi-arduino-nano', id: 'nano', x: 100, y: 100, properties: {} },
      { type: 'wokwi-ntc-temperature-sensor', id: 'ntc', x: 350, y: 80, properties: { temperature: '22' } },
      { type: 'wokwi-resistor', id: 'rntc', x: 350, y: 160, properties: { value: '10000' } },
      { type: 'wokwi-photoresistor-sensor', id: 'ldr', x: 350, y: 240, properties: { lux: '300' } },
      { type: 'wokwi-resistor', id: 'rldr', x: 350, y: 320, properties: { value: '10000' } },
    ],
    wires: [
      w('w1', ['nano','5V'], ['ntc','1'], '#ff0000'),
      w('w2', ['ntc','2'], ['rntc','1']),
      w('w3', ['rntc','2'], ['nano','GND'], '#000000'),
      w('w4', ['ntc','2'], ['nano','A0'], '#ffaa00'),
      w('w5', ['nano','5V'], ['ldr','VCC'], '#ff0000'),
      w('w6', ['ldr','SIG'], ['rldr','1']),
      w('w7', ['rldr','2'], ['nano','GND'], '#000000'),
      w('w8', ['ldr','SIG'], ['nano','A1'], '#ffaa00'),
    ],
  },

  {
    id: 'esp32-pwm-led-rgb',
    title: 'ESP32 LEDC PWM RGB',
    description: 'ESP32 LEDC peripheral drives RGB LED with independent PWM channels.',
    category: 'basics', difficulty: 'intermediate',
    boardType: 'esp32',
    code: `// ESP32 LEDC PWM — RGB LED color cycling
#define R_PIN 16
#define G_PIN 17
#define B_PIN 18
void setup() {
  ledcAttach(R_PIN, 5000, 8);
  ledcAttach(G_PIN, 5000, 8);
  ledcAttach(B_PIN, 5000, 8);
}
void loop() {
  for(int h=0; h<360; h+=5) {
    float r,g,b;
    // HSV to RGB (S=1, V=1)
    int i = h/60; float f = h/60.0-i;
    switch(i%6) {
      case 0: r=1; g=f;   b=0;   break;
      case 1: r=1-f; g=1; b=0;   break;
      case 2: r=0; g=1;   b=f;   break;
      case 3: r=0; g=1-f; b=1;   break;
      case 4: r=f; g=0;   b=1;   break;
      case 5: r=1; g=0;   b=1-f; break;
    }
    ledcWrite(R_PIN, (int)(r*255));
    ledcWrite(G_PIN, (int)(g*255));
    ledcWrite(B_PIN, (int)(b*255));
    delay(30);
  }
}`,
    components: [
      ESP32,
      { type: 'wokwi-rgb-led', id: 'rgb', x: 400, y: 150, properties: {} },
      { type: 'wokwi-resistor', id: 'rr', x: 380, y: 80, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'rg', x: 420, y: 80, properties: { value: '220' } },
      { type: 'wokwi-resistor', id: 'rb', x: 460, y: 80, properties: { value: '220' } },
    ],
    wires: [
      w('w1', ['esp32','16'], ['rr','1']),
      w('w2', ['rr','2'], ['rgb','R'], '#ff0000'),
      w('w3', ['esp32','17'], ['rg','1']),
      w('w4', ['rg','2'], ['rgb','G'], '#00ff00'),
      w('w5', ['esp32','18'], ['rb','1']),
      w('w6', ['rb','2'], ['rgb','B'], '#0000ff'),
      w('w7', ['rgb','COM'], ['esp32','GND'], '#000000'),
    ],
  },
];

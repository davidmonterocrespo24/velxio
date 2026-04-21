/**
 * Analog-only circuit examples (no Arduino board).
 *
 * These 30 examples exercise the ngspice-WASM SPICE backend with standalone
 * analog circuits: passive dividers & filters, diode rectifiers/clippers,
 * BJT/MOSFET stages, op-amp topologies. Every circuit uses a
 * `signal-generator` as the source (and ground reference, since its `GND`
 * pin is the only one canonicalised to SPICE node 0 — `battery-9v −` is not).
 *
 * All circuits are tagged `boardFilter: 'analog'` so the gallery can group
 * them together and so the preview / loader know to skip the implicit
 * Arduino board.
 *
 * Layout note: each circuit fits inside roughly 560 × 320 px so the
 * CircuitPreview cards render cleanly. Component sizes come from
 * InlineComponentSVGs.tsx / COMP_DEFS in CircuitPreview.tsx.
 */
import type { ExampleProject } from './examples';

// ── Helpers ────────────────────────────────────────────────────────────────

function w(
  id: string,
  from: [string, string],
  to: [string, string],
  color = '#00aaff',
) {
  return {
    id,
    start: { componentId: from[0], pinName: from[1] },
    end: { componentId: to[0], pinName: to[1] },
    color,
  };
}

// Colors used throughout
const C_PWR = '#ff3b3b';   // power / V+
const C_GND = '#000000';   // ground
const C_SIG = '#ffaa00';   // signal
const C_OUT = '#22d3ee';   // output
const C_WIRE = '#00aaff';  // generic signal

// Standard placeholder sketch text so the editor has something non-empty
// when the user loads an analog example.
const ANALOG_SKETCH = `// Analog-only circuit — no Arduino sketch required.
// Toggle the electrical-simulation (⚡) button to run the SPICE engine.
void setup() {}
void loop() {}
`;

// Base example skeleton — cuts down per-circuit boilerplate.
function analog(
  id: string,
  title: string,
  description: string,
  difficulty: ExampleProject['difficulty'],
  components: ExampleProject['components'],
  wires: ExampleProject['wires'],
): ExampleProject {
  return {
    id,
    title,
    description,
    category: 'circuits',
    difficulty,
    boardFilter: 'analog',
    code: ANALOG_SKETCH,
    components,
    wires,
  };
}

// ── Component shortcuts ────────────────────────────────────────────────────

function sigGen(id: string, x: number, y: number, props: Record<string, any>) {
  return { type: 'wokwi-signal-generator', id, x, y, properties: props };
}
function res(id: string, x: number, y: number, value: string) {
  return { type: 'wokwi-resistor', id, x, y, properties: { value } };
}
function cap(id: string, x: number, y: number, value: string) {
  return { type: 'wokwi-capacitor', id, x, y, properties: { value } };
}
function ind(id: string, x: number, y: number, value: string) {
  return { type: 'wokwi-inductor', id, x, y, properties: { value } };
}
function diode(id: string, x: number, y: number, kind = 'wokwi-diode-1n4007') {
  return { type: kind, id, x, y, properties: {} };
}
function zener(id: string, x: number, y: number) {
  return { type: 'wokwi-zener-1n4733', id, x, y, properties: {} };
}
function bjtNpn(id: string, x: number, y: number) {
  return { type: 'wokwi-bjt-2n2222', id, x, y, properties: {} };
}
function bjtPnp(id: string, x: number, y: number) {
  return { type: 'wokwi-bjt-bc557', id, x, y, properties: {} };
}
function mosN(id: string, x: number, y: number) {
  return { type: 'wokwi-mosfet-2n7000', id, x, y, properties: {} };
}
function mosP(id: string, x: number, y: number) {
  return { type: 'wokwi-mosfet-irf9540', id, x, y, properties: {} };
}
function opamp(id: string, x: number, y: number) {
  return { type: 'wokwi-opamp-lm358', id, x, y, properties: {} };
}
function vmeter(id: string, x: number, y: number) {
  return { type: 'wokwi-instr-voltmeter', id, x, y, properties: {} };
}
function ammeter(id: string, x: number, y: number) {
  return { type: 'wokwi-instr-ammeter', id, x, y, properties: {} };
}

// ── Examples ───────────────────────────────────────────────────────────────

export const analogExamples: ExampleProject[] = [

  // ════════════════════════════════════════════════════════════════════════
  // PASSIVE  (1–7)
  // ════════════════════════════════════════════════════════════════════════

  analog(
    'an-voltage-divider',
    'Voltage Divider',
    'Two resistors divide a 5 V DC source in half. Classic first SPICE demo — expect 2.5 V across R2.',
    'beginner',
    [
      sigGen('src', 60, 160, { waveform: 'dc', offset: 5, amplitude: 0, frequency: 1 }),
      res('r1', 260, 120, '10000'),
      res('r2', 260, 220, '10000'),
      vmeter('vm', 420, 180),
    ],
    [
      w('w1', ['src', 'SIG'], ['r1', '1'], C_PWR),
      w('w2', ['r1', '2'],    ['r2', '1'], C_SIG),
      w('w3', ['r2', '2'],    ['src', 'GND'], C_GND),
      w('w4', ['r1', '2'],    ['vm', 'V+'], C_OUT),
      w('w5', ['src', 'GND'], ['vm', 'V-'], C_GND),
    ],
  ),

  analog(
    'an-series-resistors',
    'Series Resistors',
    'Three resistors in series carry the same current — ammeter reads V/(R1+R2+R3).',
    'beginner',
    [
      sigGen('src', 60, 160, { waveform: 'dc', offset: 10, amplitude: 0, frequency: 1 }),
      res('r1', 220, 120, '1000'),
      res('r2', 360, 120, '2200'),
      res('r3', 500, 120, '4700'),
      ammeter('am', 300, 240),
    ],
    [
      w('w1', ['src', 'SIG'], ['r1', '1'], C_PWR),
      w('w2', ['r1', '2'],    ['r2', '1'], C_WIRE),
      w('w3', ['r2', '2'],    ['r3', '1'], C_WIRE),
      w('w4', ['r3', '2'],    ['am', 'A+'], C_SIG),
      w('w5', ['am', 'A-'],   ['src', 'GND'], C_GND),
    ],
  ),

  analog(
    'an-parallel-resistors',
    'Parallel Resistors',
    'Three resistors in parallel — total resistance is the reciprocal of the reciprocal sum. Ammeter shows total current.',
    'beginner',
    [
      sigGen('src', 60, 180, { waveform: 'dc', offset: 5, amplitude: 0, frequency: 1 }),
      res('r1', 320, 100, '1000'),
      res('r2', 320, 180, '1000'),
      res('r3', 320, 260, '1000'),
      ammeter('am', 180, 280),
    ],
    [
      w('w1', ['src', 'SIG'], ['r1', '1'], C_PWR),
      w('w2', ['src', 'SIG'], ['r2', '1'], C_PWR),
      w('w3', ['src', 'SIG'], ['r3', '1'], C_PWR),
      w('w4', ['r1', '2'],    ['am', 'A+'], C_SIG),
      w('w5', ['r2', '2'],    ['am', 'A+'], C_SIG),
      w('w6', ['r3', '2'],    ['am', 'A+'], C_SIG),
      w('w7', ['am', 'A-'],   ['src', 'GND'], C_GND),
    ],
  ),

  analog(
    'an-rc-low-pass',
    'RC Low-Pass Filter',
    '1 kHz sine through R = 1.6 kΩ and C = 100 nF. fc ≈ 1 kHz — output attenuated by −3 dB.',
    'beginner',
    [
      sigGen('src', 60, 180, { waveform: 'sine', frequency: 1000, amplitude: 1, offset: 0 }),
      res('r1', 260, 140, '1600'),
      cap('c1', 400, 240, '100n'),
      vmeter('vm', 520, 180),
    ],
    [
      w('w1', ['src', 'SIG'], ['r1', '1'], C_SIG),
      w('w2', ['r1', '2'],    ['c1', '1'], C_OUT),
      w('w3', ['c1', '2'],    ['src', 'GND'], C_GND),
      w('w4', ['r1', '2'],    ['vm', 'V+'], C_OUT),
      w('w5', ['src', 'GND'], ['vm', 'V-'], C_GND),
    ],
  ),

  analog(
    'an-rc-high-pass',
    'RC High-Pass Filter',
    'Swap the R and C of a low-pass and you get a high-pass. 1 kHz sine through C — R — GND.',
    'beginner',
    [
      sigGen('src', 60, 180, { waveform: 'sine', frequency: 1000, amplitude: 1, offset: 0 }),
      cap('c1', 240, 140, '100n'),
      res('r1', 400, 240, '1600'),
      vmeter('vm', 520, 180),
    ],
    [
      w('w1', ['src', 'SIG'], ['c1', '1'], C_SIG),
      w('w2', ['c1', '2'],    ['r1', '1'], C_OUT),
      w('w3', ['r1', '2'],    ['src', 'GND'], C_GND),
      w('w4', ['c1', '2'],    ['vm', 'V+'], C_OUT),
      w('w5', ['src', 'GND'], ['vm', 'V-'], C_GND),
    ],
  ),

  analog(
    'an-rl-low-pass',
    'RL Low-Pass Filter',
    'Inductor in series, resistor to ground. High frequencies dropped across L; low frequencies pass through.',
    'intermediate',
    [
      sigGen('src', 60, 180, { waveform: 'sine', frequency: 5000, amplitude: 1, offset: 0 }),
      ind('l1', 240, 140, '10m'),
      res('r1', 400, 240, '1000'),
      vmeter('vm', 520, 180),
    ],
    [
      w('w1', ['src', 'SIG'], ['l1', '1'], C_SIG),
      w('w2', ['l1', '2'],    ['r1', '1'], C_OUT),
      w('w3', ['r1', '2'],    ['src', 'GND'], C_GND),
      w('w4', ['l1', '2'],    ['vm', 'V+'], C_OUT),
      w('w5', ['src', 'GND'], ['vm', 'V-'], C_GND),
    ],
  ),

  analog(
    'an-rlc-series-resonance',
    'Series RLC Resonant Circuit',
    'L = 1 mH, C = 1 µF gives fr ≈ 5 kHz. Sweep the signal generator — Vc peaks at resonance (Q-dependent).',
    'intermediate',
    [
      sigGen('src', 60, 180, { waveform: 'sine', frequency: 5000, amplitude: 1, offset: 0 }),
      res('r1', 240, 140, '10'),
      ind('l1', 360, 140, '1m'),
      cap('c1', 500, 240, '1u'),
      vmeter('vm', 620, 180),
    ],
    [
      w('w1', ['src', 'SIG'], ['r1', '1'], C_SIG),
      w('w2', ['r1', '2'],    ['l1', '1'], C_WIRE),
      w('w3', ['l1', '2'],    ['c1', '1'], C_OUT),
      w('w4', ['c1', '2'],    ['src', 'GND'], C_GND),
      w('w5', ['l1', '2'],    ['vm', 'V+'], C_OUT),
      w('w6', ['src', 'GND'], ['vm', 'V-'], C_GND),
    ],
  ),

  // ════════════════════════════════════════════════════════════════════════
  // DIODES  (8–14)
  // ════════════════════════════════════════════════════════════════════════

  analog(
    'an-half-wave-rectifier',
    'Half-Wave Rectifier',
    'Single diode passes only the positive half-cycle of a 50 Hz sine. Load resistor drops the rectified voltage.',
    'beginner',
    [
      sigGen('src', 60, 180, { waveform: 'sine', frequency: 50, amplitude: 8, offset: 0 }),
      diode('d1', 240, 140),
      res('r1', 420, 240, '1000'),
      vmeter('vm', 560, 180),
    ],
    [
      w('w1', ['src', 'SIG'], ['d1', 'A'], C_SIG),
      w('w2', ['d1', 'C'],    ['r1', '1'], C_OUT),
      w('w3', ['r1', '2'],    ['src', 'GND'], C_GND),
      w('w4', ['d1', 'C'],    ['vm', 'V+'], C_OUT),
      w('w5', ['src', 'GND'], ['vm', 'V-'], C_GND),
    ],
  ),

  analog(
    'an-bridge-rectifier',
    'Full-Wave Bridge Rectifier',
    'Four diodes in a bridge rectify both halves of the AC input. Load R1 sees full-wave pulses at 2× the input frequency.',
    'intermediate',
    [
      sigGen('src', 60, 200, { waveform: 'sine', frequency: 50, amplitude: 10, offset: 0 }),
      diode('d1', 260, 100),
      diode('d2', 380, 100),
      diode('d3', 260, 280),
      diode('d4', 380, 280),
      res('r1', 540, 200, '2200'),
      vmeter('vm', 680, 200),
    ],
    [
      // Bridge: SIG -> d1 anode, d3 cathode; GND -> d2 anode, d4 cathode
      // + rail (top): d1 cathode, d2 cathode
      // − rail (bottom): d3 anode, d4 anode
      w('w1',  ['src', 'SIG'], ['d1', 'A'],  C_SIG),
      w('w2',  ['src', 'SIG'], ['d3', 'C'],  C_SIG),
      w('w3',  ['src', 'GND'], ['d2', 'A'],  C_GND),
      w('w4',  ['src', 'GND'], ['d4', 'C'],  C_GND),
      w('w5',  ['d1', 'C'],    ['d2', 'C'],  C_OUT),
      w('w6',  ['d3', 'A'],    ['d4', 'A'],  '#666666'),
      w('w7',  ['d1', 'C'],    ['r1', '1'],  C_OUT),
      w('w8',  ['r1', '2'],    ['d3', 'A'],  '#666666'),
      w('w9',  ['r1', '1'],    ['vm', 'V+'], C_OUT),
      w('w10', ['r1', '2'],    ['vm', 'V-'], '#666666'),
    ],
  ),

  analog(
    'an-smoothed-rectifier',
    'Smoothed Half-Wave Rectifier',
    'Half-wave rectifier followed by a 100 µF reservoir cap. Output is near-DC with ripple inversely proportional to C.',
    'intermediate',
    [
      sigGen('src', 60, 180, { waveform: 'sine', frequency: 50, amplitude: 10, offset: 0 }),
      diode('d1', 240, 140),
      cap('c1', 400, 240, '100u'),
      res('r1', 540, 240, '1000'),
      vmeter('vm', 680, 180),
    ],
    [
      w('w1', ['src', 'SIG'], ['d1', 'A'], C_SIG),
      w('w2', ['d1', 'C'],    ['c1', '1'], C_OUT),
      w('w3', ['c1', '1'],    ['r1', '1'], C_OUT),
      w('w4', ['c1', '2'],    ['src', 'GND'], C_GND),
      w('w5', ['r1', '2'],    ['src', 'GND'], C_GND),
      w('w6', ['c1', '1'],    ['vm', 'V+'], C_OUT),
      w('w7', ['src', 'GND'], ['vm', 'V-'], C_GND),
    ],
  ),

  analog(
    'an-zener-regulator',
    'Zener Shunt Regulator',
    'Series resistor + reverse-biased zener clamps the output to Vz (5.1 V for a 1N4733) despite changing input.',
    'intermediate',
    [
      sigGen('src', 60, 180, { waveform: 'dc', offset: 12, amplitude: 0, frequency: 1 }),
      res('r1', 240, 140, '220'),
      zener('d1', 400, 240),
      res('rl', 540, 240, '2200'),
      vmeter('vm', 680, 180),
    ],
    [
      w('w1', ['src', 'SIG'], ['r1', '1'], C_PWR),
      w('w2', ['r1', '2'],    ['d1', 'C'], C_OUT),
      w('w3', ['r1', '2'],    ['rl', '1'], C_OUT),
      w('w4', ['d1', 'A'],    ['src', 'GND'], C_GND),
      w('w5', ['rl', '2'],    ['src', 'GND'], C_GND),
      w('w6', ['r1', '2'],    ['vm', 'V+'], C_OUT),
      w('w7', ['src', 'GND'], ['vm', 'V-'], C_GND),
    ],
  ),

  analog(
    'an-diode-clipper',
    'Diode Clipper',
    'Two diodes to VCC/GND via a series resistor limit the output swing to roughly ±0.7 V — symmetric clipping.',
    'intermediate',
    [
      sigGen('src', 60, 180, { waveform: 'sine', frequency: 1000, amplitude: 5, offset: 0 }),
      res('r1', 240, 180, '1000'),
      diode('d1', 400, 100),
      diode('d2', 400, 280),
      vmeter('vm', 560, 180),
    ],
    [
      w('w1', ['src', 'SIG'], ['r1', '1'], C_SIG),
      w('w2', ['r1', '2'],    ['d1', 'A'], C_OUT),
      w('w3', ['r1', '2'],    ['d2', 'C'], C_OUT),
      w('w4', ['d1', 'C'],    ['src', 'GND'], C_GND),  // upper clip to 0 (really D inside ±0.7 both sides)
      w('w5', ['d2', 'A'],    ['src', 'GND'], C_GND),
      w('w6', ['r1', '2'],    ['vm', 'V+'], C_OUT),
      w('w7', ['src', 'GND'], ['vm', 'V-'], C_GND),
    ],
  ),

  analog(
    'an-diode-clamper',
    'Diode Clamper (DC Restorer)',
    'Series cap + parallel diode shifts the signal so its negative peak sits at 0 V. Output swings 0 → 2·Vpeak.',
    'intermediate',
    [
      sigGen('src', 60, 180, { waveform: 'sine', frequency: 1000, amplitude: 5, offset: 0 }),
      cap('c1', 240, 180, '1u'),
      diode('d1', 400, 240),
      res('rl', 540, 240, '10000'),
      vmeter('vm', 680, 180),
    ],
    [
      w('w1', ['src', 'SIG'], ['c1', '1'], C_SIG),
      w('w2', ['c1', '2'],    ['d1', 'C'], C_OUT),
      w('w3', ['c1', '2'],    ['rl', '1'], C_OUT),
      w('w4', ['d1', 'A'],    ['src', 'GND'], C_GND),
      w('w5', ['rl', '2'],    ['src', 'GND'], C_GND),
      w('w6', ['c1', '2'],    ['vm', 'V+'], C_OUT),
      w('w7', ['src', 'GND'], ['vm', 'V-'], C_GND),
    ],
  ),

  analog(
    'an-voltage-doubler',
    'Voltage Doubler (Villard / Greinacher)',
    'Two caps + two diodes extract roughly 2·Vpeak DC from an AC input. First stage clamps, second stage peak-detects.',
    'advanced',
    [
      sigGen('src', 60, 200, { waveform: 'sine', frequency: 50, amplitude: 8, offset: 0 }),
      cap('c1', 220, 200, '10u'),
      diode('d1', 360, 120),
      diode('d2', 500, 200),
      cap('c2', 640, 280, '100u'),
      res('rl', 780, 280, '10000'),
      vmeter('vm', 860, 160),
    ],
    [
      w('w1', ['src', 'SIG'], ['c1', '1'], C_SIG),
      w('w2', ['c1', '2'],    ['d1', 'C'], C_WIRE),  // D1 cathode = n1 → clamps negative excursion to ~−0.7
      w('w3', ['d1', 'A'],    ['src', 'GND'], C_GND), // D1 anode = GND
      w('w4', ['c1', '2'],    ['d2', 'A'], C_WIRE),  // D2 anode = n1 (now swings 0 → +2·Vpeak)
      w('w5', ['d2', 'C'],    ['c2', '1'], C_OUT),   // D2 cathode → vout
      w('w6', ['c2', '1'],    ['rl', '1'], C_OUT),
      w('w7', ['c2', '2'],    ['src', 'GND'], C_GND),
      w('w8', ['rl', '2'],    ['src', 'GND'], C_GND),
      w('w9', ['c2', '1'],    ['vm', 'V+'], C_OUT),
      w('w10', ['src', 'GND'], ['vm', 'V-'], C_GND),
    ],
  ),

  // ════════════════════════════════════════════════════════════════════════
  // BJT  (15–20)
  // ════════════════════════════════════════════════════════════════════════

  analog(
    'an-bjt-common-emitter',
    'BJT Common-Emitter Amplifier',
    'Classic voltage amplifier: base biased by a divider, emitter degenerated by Re, collector resistor sets gain.',
    'advanced',
    [
      sigGen('vcc', 60, 40,  { waveform: 'dc',   offset: 12, amplitude: 0, frequency: 1 }),
      sigGen('src', 60, 240, { waveform: 'sine', frequency: 1000, amplitude: 0.05, offset: 0 }),
      res('rb1', 240, 60,  '47000'),
      res('rb2', 240, 200, '10000'),
      res('rc',  440, 60,  '4700'),
      res('re',  440, 300, '1000'),
      cap('cin', 220, 260, '10u'),
      bjtNpn('q1', 360, 160),
      vmeter('vm', 600, 120),
    ],
    [
      w('w1', ['vcc', 'SIG'], ['rb1', '1'], C_PWR),
      w('w2', ['rb1', '2'],   ['rb2', '1'], C_WIRE),
      w('w3', ['rb2', '2'],   ['vcc', 'GND'], C_GND),
      w('w4', ['rb1', '2'],   ['q1', 'B'],  C_SIG),
      w('w5', ['vcc', 'SIG'], ['rc', '1'],  C_PWR),
      w('w6', ['rc', '2'],    ['q1', 'C'],  C_OUT),
      w('w7', ['q1', 'E'],    ['re', '1'],  C_WIRE),
      w('w8', ['re', '2'],    ['vcc', 'GND'], C_GND),
      w('w9', ['src', 'SIG'], ['cin', '1'], C_SIG),
      w('w10', ['cin', '2'],  ['q1', 'B'],  C_SIG),
      w('w11', ['src', 'GND'], ['vcc', 'GND'], C_GND),
      w('w12', ['q1', 'C'],   ['vm', 'V+'], C_OUT),
      w('w13', ['vcc', 'GND'], ['vm', 'V-'], C_GND),
    ],
  ),

  analog(
    'an-bjt-emitter-follower',
    'BJT Emitter Follower',
    'Common-collector buffer: unity voltage gain, high input impedance, low output impedance. Great as a driver stage.',
    'intermediate',
    [
      sigGen('vcc', 60, 40,  { waveform: 'dc',   offset: 12, amplitude: 0, frequency: 1 }),
      sigGen('src', 60, 240, { waveform: 'sine', frequency: 1000, amplitude: 1, offset: 6 }),
      res('rb', 260, 80, '100000'),
      bjtNpn('q1', 420, 160),
      res('re', 500, 300, '1000'),
      vmeter('vm', 640, 220),
    ],
    [
      w('w1', ['vcc', 'SIG'], ['q1', 'C'],   C_PWR),
      w('w2', ['src', 'SIG'], ['rb', '1'],   C_SIG),
      w('w3', ['rb',  '2'],   ['q1', 'B'],   C_SIG),
      w('w4', ['q1',  'E'],   ['re', '1'],   C_OUT),
      w('w5', ['re',  '2'],   ['vcc', 'GND'], C_GND),
      w('w6', ['src', 'GND'], ['vcc', 'GND'], C_GND),
      w('w7', ['q1',  'E'],   ['vm', 'V+'],  C_OUT),
      w('w8', ['vcc', 'GND'], ['vm', 'V-'],  C_GND),
    ],
  ),

  analog(
    'an-bjt-switch',
    'BJT as a Switch',
    'Base driven into saturation through Rb; collector pulled up via a load resistor. DC step input toggles Vce between ~0.2 V and Vcc.',
    'beginner',
    [
      sigGen('vcc', 60, 40,  { waveform: 'dc',   offset: 9, amplitude: 0, frequency: 1 }),
      sigGen('src', 60, 240, { waveform: 'square', frequency: 100, amplitude: 2, offset: 2 }),
      res('rb', 260, 240, '4700'),
      res('rl', 440, 60,  '1000'),
      bjtNpn('q1', 420, 160),
      vmeter('vm', 600, 160),
    ],
    [
      w('w1', ['vcc', 'SIG'], ['rl', '1'],   C_PWR),
      w('w2', ['rl',  '2'],   ['q1', 'C'],   C_OUT),
      w('w3', ['src', 'SIG'], ['rb', '1'],   C_SIG),
      w('w4', ['rb',  '2'],   ['q1', 'B'],   C_SIG),
      w('w5', ['q1',  'E'],   ['vcc', 'GND'], C_GND),
      w('w6', ['src', 'GND'], ['vcc', 'GND'], C_GND),
      w('w7', ['q1',  'C'],   ['vm', 'V+'],  C_OUT),
      w('w8', ['vcc', 'GND'], ['vm', 'V-'],  C_GND),
    ],
  ),

  analog(
    'an-darlington',
    'Darlington Pair',
    'Two cascaded NPNs multiply β — β_total ≈ β1·β2. Used when a single transistor can’t supply enough base current for a heavy load.',
    'advanced',
    [
      sigGen('vcc', 60, 40,  { waveform: 'dc',   offset: 12, amplitude: 0, frequency: 1 }),
      sigGen('src', 60, 260, { waveform: 'dc',   offset: 2, amplitude: 0, frequency: 1 }),
      res('rb', 260, 200, '10000'),
      bjtNpn('q1', 360, 140),
      bjtNpn('q2', 500, 200),
      res('rl', 620, 80,  '220'),
      vmeter('vm', 720, 180),
    ],
    [
      w('w1', ['vcc', 'SIG'], ['rl', '1'],   C_PWR),
      w('w2', ['rl',  '2'],   ['q1', 'C'],   C_OUT),
      w('w3', ['q1',  'C'],   ['q2', 'C'],   C_PWR),
      w('w4', ['src', 'SIG'], ['rb', '1'],   C_SIG),
      w('w5', ['rb',  '2'],   ['q1', 'B'],   C_SIG),
      w('w6', ['q1',  'E'],   ['q2', 'B'],   C_WIRE),
      w('w7', ['q2',  'E'],   ['vcc', 'GND'], C_GND),
      w('w8', ['src', 'GND'], ['vcc', 'GND'], C_GND),
      w('w9', ['q2',  'C'],   ['vm', 'V+'],  C_OUT),
      w('w10', ['vcc', 'GND'], ['vm', 'V-'], C_GND),
    ],
  ),

  analog(
    'an-current-mirror',
    'NPN Current Mirror',
    'Reference current in Q1 is mirrored through Q2’s collector — matched transistors + shared Vbe make the collector currents equal.',
    'advanced',
    [
      sigGen('vcc', 60, 40,  { waveform: 'dc', offset: 12, amplitude: 0, frequency: 1 }),
      res('rref', 240, 40,  '10000'),
      bjtNpn('q1', 320, 160),
      bjtNpn('q2', 520, 160),
      res('rload', 620, 40, '4700'),
      ammeter('am', 720, 160),
    ],
    [
      w('w1', ['vcc', 'SIG'], ['rref', '1'], C_PWR),
      w('w2', ['rref', '2'],  ['q1', 'C'],   C_WIRE),
      w('w3', ['q1',  'C'],   ['q1', 'B'],   C_WIRE),
      w('w4', ['q1',  'B'],   ['q2', 'B'],   C_WIRE),
      w('w5', ['vcc', 'SIG'], ['rload', '1'], C_PWR),
      w('w6', ['rload', '2'], ['am', 'A+'],  C_OUT),
      w('w7', ['am', 'A-'],   ['q2', 'C'],   C_OUT),
      w('w8', ['q1',  'E'],   ['vcc', 'GND'], C_GND),
      w('w9', ['q2',  'E'],   ['vcc', 'GND'], C_GND),
    ],
  ),

  analog(
    'an-bjt-diff-pair',
    'BJT Differential Pair',
    'Long-tailed pair: a shared emitter tail resistor steers current between Q1 and Q2 according to the differential input.',
    'advanced',
    [
      sigGen('vcc', 60, 40,  { waveform: 'dc',   offset: 12, amplitude: 0, frequency: 1 }),
      sigGen('in1', 60, 220, { waveform: 'sine', frequency: 1000, amplitude: 0.02, offset: 2.5 }),
      sigGen('in2', 60, 360, { waveform: 'dc',   offset: 2.5, amplitude: 0, frequency: 1 }),
      res('rc1', 300, 40, '4700'),
      res('rc2', 500, 40, '4700'),
      bjtNpn('q1', 280, 180),
      bjtNpn('q2', 500, 180),
      res('rtail', 400, 320, '4700'),
      vmeter('vm',  620, 120),
    ],
    [
      w('w1', ['vcc', 'SIG'], ['rc1', '1'], C_PWR),
      w('w2', ['vcc', 'SIG'], ['rc2', '1'], C_PWR),
      w('w3', ['rc1', '2'],   ['q1', 'C'],  C_WIRE),
      w('w4', ['rc2', '2'],   ['q2', 'C'],  C_OUT),
      w('w5', ['in1', 'SIG'], ['q1', 'B'],  C_SIG),
      w('w6', ['in2', 'SIG'], ['q2', 'B'],  C_SIG),
      w('w7', ['q1',  'E'],   ['rtail', '1'], C_WIRE),
      w('w8', ['q2',  'E'],   ['rtail', '1'], C_WIRE),
      w('w9', ['rtail', '2'], ['vcc', 'GND'], C_GND),
      w('w10', ['in1', 'GND'], ['vcc', 'GND'], C_GND),
      w('w11', ['in2', 'GND'], ['vcc', 'GND'], C_GND),
      w('w12', ['q2', 'C'],   ['vm', 'V+'], C_OUT),
      w('w13', ['vcc', 'GND'], ['vm', 'V-'], C_GND),
    ],
  ),

  // ════════════════════════════════════════════════════════════════════════
  // MOSFET  (21–23)
  // ════════════════════════════════════════════════════════════════════════

  analog(
    'an-mosfet-switch',
    'MOSFET Low-Side Switch',
    '2N7000 NMOS with a pull-down gate resistor. Gate drive above Vth turns the device on and sinks current from the load to GND.',
    'beginner',
    [
      sigGen('vcc', 60, 40,  { waveform: 'dc',   offset: 12, amplitude: 0, frequency: 1 }),
      sigGen('src', 60, 260, { waveform: 'square', frequency: 100, amplitude: 2, offset: 2 }),
      res('rg', 240, 240, '100'),
      res('rl', 420, 60,  '470'),
      mosN('m1', 420, 160),
      res('rgp', 240, 340, '100000'),
      vmeter('vm', 600, 160),
    ],
    [
      w('w1', ['vcc', 'SIG'], ['rl', '1'],  C_PWR),
      w('w2', ['rl', '2'],    ['m1', 'D'],  C_OUT),
      w('w3', ['src', 'SIG'], ['rg', '1'],  C_SIG),
      w('w4', ['rg', '2'],    ['m1', 'G'],  C_SIG),
      w('w5', ['m1', 'G'],    ['rgp', '1'], C_SIG),
      w('w6', ['rgp', '2'],   ['vcc', 'GND'], C_GND),
      w('w7', ['m1', 'S'],    ['vcc', 'GND'], C_GND),
      w('w8', ['src', 'GND'], ['vcc', 'GND'], C_GND),
      w('w9', ['m1', 'D'],    ['vm', 'V+'], C_OUT),
      w('w10', ['vcc', 'GND'], ['vm', 'V-'], C_GND),
    ],
  ),

  analog(
    'an-mosfet-common-source',
    'MOSFET Common-Source Amplifier',
    '2N7000 as a small-signal amp: drain resistor sets gain, source resistor stabilises bias. AC-coupled signal input.',
    'advanced',
    [
      sigGen('vcc', 60, 40,  { waveform: 'dc',   offset: 12, amplitude: 0, frequency: 1 }),
      sigGen('src', 60, 260, { waveform: 'sine', frequency: 1000, amplitude: 0.1, offset: 0 }),
      res('rg1', 240, 40,  '1000000'),
      res('rg2', 240, 200, '470000'),
      res('rd',  420, 40,  '4700'),
      res('rs',  420, 300, '1000'),
      cap('cin', 220, 260, '10u'),
      mosN('m1', 380, 160),
      vmeter('vm', 560, 120),
    ],
    [
      w('w1', ['vcc', 'SIG'], ['rg1', '1'], C_PWR),
      w('w2', ['rg1', '2'],   ['rg2', '1'], C_WIRE),
      w('w3', ['rg2', '2'],   ['vcc', 'GND'], C_GND),
      w('w4', ['rg1', '2'],   ['m1', 'G'],  C_SIG),
      w('w5', ['vcc', 'SIG'], ['rd', '1'],  C_PWR),
      w('w6', ['rd', '2'],    ['m1', 'D'],  C_OUT),
      w('w7', ['m1', 'S'],    ['rs', '1'],  C_WIRE),
      w('w8', ['rs', '2'],    ['vcc', 'GND'], C_GND),
      w('w9', ['src', 'SIG'], ['cin', '1'], C_SIG),
      w('w10', ['cin', '2'],  ['m1', 'G'],  C_SIG),
      w('w11', ['src', 'GND'], ['vcc', 'GND'], C_GND),
      w('w12', ['m1', 'D'],   ['vm', 'V+'], C_OUT),
      w('w13', ['vcc', 'GND'], ['vm', 'V-'], C_GND),
    ],
  ),

  analog(
    'an-mosfet-pmos-highside',
    'PMOS High-Side Switch',
    'P-channel MOSFET (IRF9540) sources current from VCC when the gate is pulled below VCC−|Vth|. Ideal for load switching.',
    'intermediate',
    [
      sigGen('vcc', 60, 40,  { waveform: 'dc',   offset: 12, amplitude: 0, frequency: 1 }),
      sigGen('ctrl', 60, 260, { waveform: 'square', frequency: 5, amplitude: 6, offset: 6 }),
      res('rg', 240, 220, '1000'),
      mosP('m1', 420, 140),
      res('rl', 540, 260, '220'),
      vmeter('vm', 680, 260),
    ],
    [
      w('w1', ['vcc', 'SIG'], ['m1', 'S'],   C_PWR),
      w('w2', ['ctrl', 'SIG'], ['rg', '1'],  C_SIG),
      w('w3', ['rg', '2'],    ['m1', 'G'],   C_SIG),
      w('w4', ['m1', 'D'],    ['rl', '1'],   C_OUT),
      w('w5', ['rl', '2'],    ['vcc', 'GND'], C_GND),
      w('w6', ['ctrl', 'GND'], ['vcc', 'GND'], C_GND),
      w('w7', ['m1', 'D'],    ['vm', 'V+'],  C_OUT),
      w('w8', ['vcc', 'GND'], ['vm', 'V-'],  C_GND),
    ],
  ),

  // ════════════════════════════════════════════════════════════════════════
  // OP-AMPS  (24–30)
  // ════════════════════════════════════════════════════════════════════════

  analog(
    'an-opamp-inverting',
    'Op-Amp Inverting Amplifier',
    'Gain = −Rf/Rin. Rf = 10 k, Rin = 1 k → gain = −10. LM358 single-supply model clamps the output to [0, VCC−1.5].',
    'intermediate',
    [
      sigGen('src', 60, 200, { waveform: 'sine', frequency: 500, amplitude: 0.2, offset: 2.5 }),
      res('rin', 240, 160, '1000'),
      res('rf',  420, 60,  '10000'),
      opamp('u1', 400, 180),
      sigGen('vref', 60, 360, { waveform: 'dc', offset: 2.5, amplitude: 0, frequency: 1 }),
      vmeter('vm', 580, 180),
    ],
    [
      w('w1', ['src', 'SIG'], ['rin', '1'],  C_SIG),
      w('w2', ['rin', '2'],   ['u1', 'IN-'], C_SIG),
      w('w3', ['u1', 'IN-'],  ['rf', '1'],   C_SIG),
      w('w4', ['rf', '2'],    ['u1', 'OUT'], C_OUT),
      w('w5', ['vref', 'SIG'], ['u1', 'IN+'], C_WIRE),
      w('w6', ['vref', 'GND'], ['src', 'GND'], C_GND),
      w('w7', ['u1', 'OUT'],  ['vm', 'V+'],  C_OUT),
      w('w8', ['src', 'GND'], ['vm', 'V-'],  C_GND),
    ],
  ),

  analog(
    'an-opamp-non-inverting',
    'Op-Amp Non-Inverting Amplifier',
    'Gain = 1 + Rf/Rg. Rf = 10 k, Rg = 1 k → gain = +11. Output in-phase with input.',
    'intermediate',
    [
      sigGen('src', 60, 180, { waveform: 'sine', frequency: 500, amplitude: 0.1, offset: 2.5 }),
      opamp('u1', 280, 180),
      res('rf', 460, 80,  '10000'),
      res('rg', 460, 280, '1000'),
      vmeter('vm', 600, 180),
    ],
    [
      w('w1', ['src', 'SIG'], ['u1', 'IN+'], C_SIG),
      w('w2', ['u1', 'OUT'],  ['rf', '1'],   C_OUT),
      w('w3', ['rf', '2'],    ['u1', 'IN-'], C_WIRE),
      w('w4', ['u1', 'IN-'],  ['rg', '1'],   C_WIRE),
      w('w5', ['rg', '2'],    ['src', 'GND'], C_GND),
      w('w6', ['u1', 'OUT'],  ['vm', 'V+'],  C_OUT),
      w('w7', ['src', 'GND'], ['vm', 'V-'],  C_GND),
    ],
  ),

  analog(
    'an-opamp-follower',
    'Op-Amp Voltage Follower',
    'Unity-gain buffer: output tracks the non-inverting input exactly. Infinite input impedance, near-zero output impedance.',
    'beginner',
    [
      sigGen('src', 60, 180, { waveform: 'sine', frequency: 200, amplitude: 1, offset: 2.5 }),
      opamp('u1', 280, 180),
      res('rl', 460, 260, '1000'),
      vmeter('vm', 600, 180),
    ],
    [
      w('w1', ['src', 'SIG'], ['u1', 'IN+'], C_SIG),
      w('w2', ['u1', 'OUT'],  ['u1', 'IN-'], C_WIRE),
      w('w3', ['u1', 'OUT'],  ['rl', '1'],   C_OUT),
      w('w4', ['rl', '2'],    ['src', 'GND'], C_GND),
      w('w5', ['u1', 'OUT'],  ['vm', 'V+'],  C_OUT),
      w('w6', ['src', 'GND'], ['vm', 'V-'],  C_GND),
    ],
  ),

  analog(
    'an-opamp-summing',
    'Op-Amp Summing Amplifier',
    'Virtual-ground summing junction: V_out = −Rf · (V1/R1 + V2/R2). Two-input mixer with unity gain per channel.',
    'advanced',
    [
      sigGen('v1', 60, 100, { waveform: 'dc', offset: 1, amplitude: 0, frequency: 1 }),
      sigGen('v2', 60, 260, { waveform: 'dc', offset: 2, amplitude: 0, frequency: 1 }),
      res('r1',  240, 100, '10000'),
      res('r2',  240, 260, '10000'),
      res('rf',  420, 40,  '10000'),
      opamp('u1', 420, 160),
      sigGen('vref', 60, 400, { waveform: 'dc', offset: 2.5, amplitude: 0, frequency: 1 }),
      vmeter('vm', 600, 180),
    ],
    [
      w('w1', ['v1', 'SIG'],  ['r1', '1'],   C_SIG),
      w('w2', ['v2', 'SIG'],  ['r2', '1'],   C_SIG),
      w('w3', ['r1', '2'],    ['u1', 'IN-'], C_WIRE),
      w('w4', ['r2', '2'],    ['u1', 'IN-'], C_WIRE),
      w('w5', ['u1', 'IN-'],  ['rf', '1'],   C_WIRE),
      w('w6', ['rf', '2'],    ['u1', 'OUT'], C_OUT),
      w('w7', ['vref', 'SIG'], ['u1', 'IN+'], C_WIRE),
      w('w8', ['v1', 'GND'],  ['v2', 'GND'], C_GND),
      w('w9', ['v2', 'GND'],  ['vref', 'GND'], C_GND),
      w('w10', ['u1', 'OUT'], ['vm', 'V+'],  C_OUT),
      w('w11', ['v1', 'GND'], ['vm', 'V-'],  C_GND),
    ],
  ),

  analog(
    'an-opamp-integrator',
    'Op-Amp Integrator',
    'Rf replaced by a cap: V_out = −(1/RC) ∫V_in dt. Square-wave in → triangle-wave out. Classic analog-computer building block.',
    'advanced',
    [
      sigGen('src', 60, 200, { waveform: 'square', frequency: 200, amplitude: 1, offset: 2.5 }),
      res('rin', 240, 160, '10000'),
      cap('cf', 420, 60, '100n'),
      opamp('u1', 400, 180),
      sigGen('vref', 60, 360, { waveform: 'dc', offset: 2.5, amplitude: 0, frequency: 1 }),
      vmeter('vm', 580, 180),
    ],
    [
      w('w1', ['src', 'SIG'], ['rin', '1'],  C_SIG),
      w('w2', ['rin', '2'],   ['u1', 'IN-'], C_SIG),
      w('w3', ['u1', 'IN-'],  ['cf', '1'],   C_SIG),
      w('w4', ['cf', '2'],    ['u1', 'OUT'], C_OUT),
      w('w5', ['vref', 'SIG'], ['u1', 'IN+'], C_WIRE),
      w('w6', ['vref', 'GND'], ['src', 'GND'], C_GND),
      w('w7', ['u1', 'OUT'],  ['vm', 'V+'],  C_OUT),
      w('w8', ['src', 'GND'], ['vm', 'V-'],  C_GND),
    ],
  ),

  analog(
    'an-opamp-comparator',
    'Op-Amp Comparator',
    'Open-loop op-amp compares V_in against a reference. Output saturates high when IN+ > IN-, low otherwise.',
    'intermediate',
    [
      sigGen('src', 60, 140, { waveform: 'sine', frequency: 100, amplitude: 2.5, offset: 2.5 }),
      sigGen('vref', 60, 300, { waveform: 'dc', offset: 2.5, amplitude: 0, frequency: 1 }),
      opamp('u1', 280, 200),
      res('rl', 460, 260, '10000'),
      vmeter('vm', 600, 200),
    ],
    [
      w('w1', ['src', 'SIG'],  ['u1', 'IN+'], C_SIG),
      w('w2', ['vref', 'SIG'], ['u1', 'IN-'], C_WIRE),
      w('w3', ['u1', 'OUT'],   ['rl', '1'],   C_OUT),
      w('w4', ['rl', '2'],     ['src', 'GND'], C_GND),
      w('w5', ['vref', 'GND'], ['src', 'GND'], C_GND),
      w('w6', ['u1', 'OUT'],   ['vm', 'V+'],  C_OUT),
      w('w7', ['src', 'GND'],  ['vm', 'V-'],  C_GND),
    ],
  ),

  analog(
    'an-schmitt-trigger',
    'Op-Amp Schmitt Trigger',
    'Positive feedback (R2 from OUT to IN+) adds hysteresis: two switching thresholds instead of one. Cleans up noisy signals.',
    'advanced',
    [
      sigGen('src', 60, 180, { waveform: 'sine', frequency: 100, amplitude: 2.5, offset: 2.5 }),
      sigGen('vref', 60, 360, { waveform: 'dc', offset: 2.5, amplitude: 0, frequency: 1 }),
      res('r1', 240, 220, '10000'),
      opamp('u1', 360, 180),
      res('r2', 520, 100, '10000'),
      vmeter('vm', 620, 220),
    ],
    [
      w('w1', ['src', 'SIG'],  ['r1', '1'],   C_SIG),
      w('w2', ['r1', '2'],     ['u1', 'IN+'], C_SIG),
      w('w3', ['vref', 'SIG'], ['u1', 'IN-'], C_WIRE),
      w('w4', ['u1', 'OUT'],   ['r2', '1'],   C_OUT),
      w('w5', ['r2', '2'],     ['u1', 'IN+'], C_SIG),
      w('w6', ['vref', 'GND'], ['src', 'GND'], C_GND),
      w('w7', ['u1', 'OUT'],   ['vm', 'V+'],  C_OUT),
      w('w8', ['src', 'GND'],  ['vm', 'V-'],  C_GND),
    ],
  ),
];

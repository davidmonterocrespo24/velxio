/**
 * A bipolar stepper behind an L293D turns (velxio/velxio-prod#170).
 *
 * The steppers follow each coil pin's board pin, found by the wire walk
 * (traceDetailed). The walk crosses resistors and transistors, never a
 * driver chip, and the L293D had no part logic: a stepper on its outputs
 * resolved every coil to nothing, subscribed to no pin, and never moved,
 * without a word. That is the Arduino Stepper library's own wiring for a
 * bipolar motor: pins 8-11 into a quadruple half-H driver (SN754410NE, the
 * L293D's twin), its outputs to the two coils
 * (docs.arduino.cc/learn/electronics/stepper-motors); TI lists bipolar
 * stepping motors among the L293D's loads (SLRS008D 8.1, 9.3.3).
 *
 * The L293D now claims OUT1-OUT4 as chip-like pads and drives them from its
 * inputs, gated by their enable (Table 1: H on EN, A to Y; EN low, off), so
 * whatever is wired to an output, a stepper coil included, follows it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/SensorParts';
import '../simulation/parts/BasicParts';
import '../simulation/parts/MotorDriverParts';
import { PinManager } from '../simulation/PinManager';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { traceDetailed } from '../simulation/PinTrace';
import { SYNTHETIC_CHIP_PIN_BASE } from '../simulation/customChips/syntheticPins';

const UNO = 'arduino-uno';
const at = (componentId: string, pinName: string) => ({ componentId, pinName });

/** Uno pins 8-11 on IN1-IN4, the enables on `enable`, a stepper's coils on OUT1-OUT4. */
function wireUp(enable: { board: string } | 'rail', stepper = { id: 'st1', type: 'stepper-motor', pins: ['A+', 'A-', 'B+', 'B-'] }) {
  const links: Array<[ReturnType<typeof at>, ReturnType<typeof at>]> = [
    [at(UNO, '8'), at('u1', 'IN1')],
    [at(UNO, '9'), at('u1', 'IN2')],
    [at(UNO, '10'), at('u1', 'IN3')],
    [at(UNO, '11'), at('u1', 'IN4')],
    [at(UNO, '5V'), at('u1', 'VCC1')],
    [at(UNO, '5V'), at('u1', 'VCC2')],
    [at('u1', 'GND.1'), at(UNO, 'GND.1')],
    [at('u1', 'OUT1'), at(stepper.id, stepper.pins[0]!)],
    [at('u1', 'OUT2'), at(stepper.id, stepper.pins[1]!)],
    [at('u1', 'OUT3'), at(stepper.id, stepper.pins[2]!)],
    [at('u1', 'OUT4'), at(stepper.id, stepper.pins[3]!)],
  ];
  if (enable === 'rail') {
    links.push([at(UNO, '5V'), at('u1', 'EN1')], [at(UNO, '5V'), at('u1', 'EN2')]);
  } else {
    links.push([at(UNO, enable.board), at('u1', 'EN1')], [at(UNO, enable.board), at('u1', 'EN2')]);
  }
  useSimulatorStore.setState({
    boards: [{ id: UNO, boardKind: UNO }],
    components: [
      { id: 'u1', metadataId: 'motor-driver-l293d', properties: {} },
      { id: stepper.id, metadataId: stepper.type, properties: {} },
    ],
    wires: links.map(([a, b], i) => ({ id: `w${i}`, start: a, end: b })),
  } as never);
}

const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

/** Attach a part the way the canvas does, with the real wire walk. */
function attach(id: string, metadataId: string, el: Record<string, unknown>, pm: PinManager): void {
  const logic = PartSimulationRegistry.get(metadataId);
  if (!logic?.attachEvents) return;
  const getPin = (pin: string) => traceDetailed(useSimulatorStore.getState(), id, pin, 0).arduinoPin;
  stops.push(logic.attachEvents(el as never, { pinManager: pm } as never, getPin, id));
}

/** The Stepper library's four-wire sequence on pins 8-11 (IN1-IN4). */
const SEQUENCE = [
  [true, false, true, false],
  [false, true, true, false],
  [false, true, false, true],
  [true, false, false, true],
];
function step(pm: PinManager, n: number): void {
  const levels = SEQUENCE[((n % 4) + 4) % 4]!;
  levels.forEach((level, i) => pm.triggerPinChange(8 + i, level, 'mcu'));
}

describe('a stepper behind an L293D (velxio/velxio-prod#170)', () => {
  it('its coils resolve to the driver outputs, not to nothing', () => {
    wireUp('rail');
    for (const coil of ['A+', 'A-', 'B+', 'B-']) {
      const pin = traceDetailed(useSimulatorStore.getState(), 'st1', coil, 0).arduinoPin;
      expect(pin, coil).not.toBeNull();
      expect(pin!).toBeGreaterThanOrEqual(SYNTHETIC_CHIP_PIN_BASE);
    }
  });

  it('turns 1.8 degrees per full step, both ways, with the enables on 5V', () => {
    wireUp('rail');
    const pm = new PinManager();
    const el: Record<string, unknown> = { angle: 0 };
    attach('u1', 'motor-driver-l293d', {}, pm);
    attach('st1', 'stepper-motor', el, pm);
    step(pm, 0);
    const start = el.angle as number;
    for (let n = 1; n <= 8; n++) step(pm, n);
    expect(((el.angle as number) - start + 360) % 360).toBeCloseTo(14.4, 6);
    for (let n = 7; n >= 0; n--) step(pm, n);
    expect(el.angle as number).toBeCloseTo(start, 6);
  });

  it('does not follow the inputs while the enables are LOW: the outputs are off', () => {
    wireUp({ board: '12' });
    const pm = new PinManager();
    const el: Record<string, unknown> = { angle: 0 };
    attach('u1', 'motor-driver-l293d', {}, pm);
    attach('st1', 'stepper-motor', el, pm);
    pm.triggerPinChange(12, true, 'mcu');
    step(pm, 0);
    const start = el.angle as number;
    pm.triggerPinChange(12, false, 'mcu');
    // The two coils go off one after the other, which the stepper model
    // reads as at most a half step; eight steps on the inputs are not taken.
    for (let n = 1; n <= 8; n++) step(pm, n);
    expect(Math.abs((el.angle as number) - start)).toBeLessThanOrEqual(0.9 + 1e-9);
    // Enabled again on the step it was left on, it is where it was ...
    pm.triggerPinChange(12, true, 'mcu');
    expect(el.angle as number).toBeCloseTo(start, 6);
    // ... and the next step is one step.
    step(pm, 9);
    expect(((el.angle as number) - start + 360) % 360).toBeCloseTo(1.8, 6);
  });

  it('drives the two-motor biaxial stepper the same way', () => {
    wireUp('rail', { id: 'bx', type: 'biaxial-stepper', pins: ['A1+', 'A1-', 'B1+', 'B1-'] });
    const pm = new PinManager();
    const el: Record<string, unknown> = { outerHandAngle: 0, innerHandAngle: 0 };
    attach('u1', 'motor-driver-l293d', {}, pm);
    attach('bx', 'biaxial-stepper', el, pm);
    step(pm, 0);
    const start = el.outerHandAngle as number;
    for (let n = 1; n <= 4; n++) step(pm, n);
    expect(((el.outerHandAngle as number) - start + 360) % 360).toBeCloseTo(7.2, 6);
  });
});

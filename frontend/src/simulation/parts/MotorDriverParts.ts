/**
 * MotorDriverParts.ts — simulation logic for motor drivers.
 *
 * a4988 — Pololu-style bipolar stepper driver with a STEP/DIR interface.
 *   The MCU pulses STEP (one rising edge = one step) and sets DIR for the
 *   direction; MS1/MS2/MS3 select microstepping. The driver's coil outputs
 *   (1A/1B = coil A, 2A/2B = coil B) wire to a bipolar stepper's A+/A-/B+/B-.
 *
 *   We model the driver, not the coil waveform: on each STEP rising edge we
 *   rotate the connected wokwi-stepper-motor (or wokwi-biaxial-stepper) by one
 *   (micro)step in the DIR direction. This matches how real STEP/DIR drivers
 *   behave and how AccelStepper / the Stepper library drive them.
 */

import { PartSimulationRegistry } from './PartSimulationRegistry';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { traceDetailed } from '../PinTrace';
import { registerChipLikePads } from '../customChips/chipLikePads';
import { syntheticChipPin } from '../customChips/syntheticPins';

/** Find the DOM element wired to `componentId`'s `pinName`, or null. */
function getConnectedElement(componentId: string, pinName: string): HTMLElement | null {
  const { wires } = useSimulatorStore.getState();
  for (const wire of wires) {
    let otherId: string | null = null;
    if (wire.start.componentId === componentId && wire.start.pinName === pinName) {
      otherId = wire.end.componentId;
    } else if (wire.end.componentId === componentId && wire.end.pinName === pinName) {
      otherId = wire.start.componentId;
    }
    if (otherId) {
      const el = document.getElementById(otherId);
      if (el) return el;
    }
  }
  return null;
}

const STEPPER_TAGS = ['wokwi-stepper-motor', 'wokwi-biaxial-stepper'];
const FULL_STEP_DEG = 1.8;

PartSimulationRegistry.register('a4988', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pinManager = (simulator as any).pinManager;
    if (!pinManager) return () => {};

    const pinSTEP = getArduinoPinHelper('STEP');
    const pinDIR = getArduinoPinHelper('DIR');
    const pinEN = getArduinoPinHelper('ENABLE');
    const pinMS1 = getArduinoPinHelper('MS1');
    const pinMS2 = getArduinoPinHelper('MS2');
    const pinMS3 = getArduinoPinHelper('MS3');

    // Locate the stepper wired to any coil output.
    function findMotor(): (HTMLElement & { angle?: number }) | null {
      for (const out of ['1A', '1B', '2A', '2B']) {
        const el = getConnectedElement(componentId, out);
        if (el && STEPPER_TAGS.includes(el.tagName.toLowerCase())) {
          return el as HTMLElement & { angle?: number };
        }
      }
      return null;
    }
    const motor = findMotor();

    let dirHigh = false;
    let enabled = true; // EN is active-LOW; unconnected = enabled (tied to GND)
    let ms1 = false;
    let ms2 = false;
    let ms3 = false;
    let prevStep = false;
    let cumAngle = motor ? Number(motor.angle) || 0 : 0;

    function microFactor(): number {
      // MS3 MS2 MS1 -> full/half/quarter/eighth/sixteenth (A4988 truth table).
      const code = (ms3 ? 4 : 0) | (ms2 ? 2 : 0) | (ms1 ? 1 : 0);
      switch (code) {
        case 1: return 2; // half
        case 2: return 4; // quarter
        case 3: return 8; // eighth
        case 7: return 16; // sixteenth
        default: return 1; // full
      }
    }

    const unsubs: (() => void)[] = [];
    const sub = (pin: number | null, cb: (s: boolean) => void) => {
      if (pin !== null) {
        unsubs.push(pinManager.onPinChange(pin, (_: number, s: boolean) => cb(s)));
      }
    };

    sub(pinDIR, (s) => (dirHigh = s));
    sub(pinEN, (s) => (enabled = !s)); // active-low
    sub(pinMS1, (s) => (ms1 = s));
    sub(pinMS2, (s) => (ms2 = s));
    sub(pinMS3, (s) => (ms3 = s));

    if (pinSTEP !== null) {
      unsubs.push(
        pinManager.onPinChange(pinSTEP, (_: number, s: boolean) => {
          if (s && !prevStep && enabled && motor) {
            const stepAngle = FULL_STEP_DEG / microFactor();
            cumAngle += dirHigh ? stepAngle : -stepAngle;
            motor.angle = ((cumAngle % 360) + 360) % 360;
          }
          prevStep = s;
        }),
      );
    }

    return () => unsubs.forEach((u) => u());
  },
});

// ─── L293D quadruple half-H driver ──────────────────────────────────────────

/**
 * l293d — what its outputs do, for everything that follows a pin.
 *
 * The circuit solve models the chip's outputs (componentToSpice), but the
 * parts that follow a PIN found by the wire walk (the steppers, an LED's
 * digital fallback, a buzzer) saw nothing: the walk crosses resistors and
 * transistors, not a driver chip, so a stepper on OUT1-OUT4 resolved every
 * coil to nothing and never moved (velxio/velxio-prod#170). That is the
 * Arduino Stepper library's own wiring for a bipolar motor.
 *
 * So the chip claims its four outputs as chip-like pads (the walk mints one
 * synthetic pin per output, shared with whatever is wired to it) and drives
 * them from its inputs: each output follows its input while its pair's
 * enable is HIGH and is off while it is LOW (TI SLRS008D, Table 1). An input
 * held at a level reads that level: a supply rail HIGH, ground LOW, and an
 * open input HIGH, since each sits on a current source from VCC1 (Figure 3).
 * A chopped input or enable (analogWrite) reaches the output as a duty, the
 * product of the two, and as the edges themselves.
 */
const L293D_ID = 'motor-driver-l293d';
const L293D_OUTPUTS: ReadonlyArray<{ out: string; input: string; enable: string }> = [
  { out: 'OUT1', input: 'IN1', enable: 'EN1' },
  { out: 'OUT2', input: 'IN2', enable: 'EN1' },
  { out: 'OUT3', input: 'IN3', enable: 'EN2' },
  { out: 'OUT4', input: 'IN4', enable: 'EN2' },
];
registerChipLikePads(
  L293D_ID,
  L293D_OUTPUTS.map((o) => o.out),
);

const GROUND_RAIL = /^(GND|AGND|DGND|PGND|VSS|0V)/i;

PartSimulationRegistry.register(L293D_ID, {
  attachEvents: (_element, simulator, _getArduinoPinHelper, componentId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pinManager = (simulator as any).pinManager;
    if (!pinManager) return () => {};

    const unsubs: (() => void)[] = [];
    /** Each input's time-average level, 0..1. */
    const level = new Map<string, number>();

    const watch = (name: string) => {
      let hit: { arduinoPin: number | null; railName?: string };
      try {
        hit = traceDetailed(useSimulatorStore.getState(), componentId, name, 0);
      } catch {
        hit = { arduinoPin: null };
      }
      const pin = hit.arduinoPin;
      if (pin === null) {
        level.set(name, 1); // open: the input's current source holds it HIGH
        return;
      }
      if (pin < 0) {
        level.set(name, GROUND_RAIL.test(hit.railName ?? '') ? 0 : 1);
        return;
      }
      const duty = typeof pinManager.getPwmValue === 'function' ? Number(pinManager.getPwmValue(pin)) || 0 : 0;
      level.set(name, duty > 0 ? duty : pinManager.getPinState(pin) ? 1 : 0);
      unsubs.push(
        pinManager.onPinChange(pin, (_p: number, high: boolean) => {
          level.set(name, high ? 1 : 0);
          update();
        }),
      );
      if (typeof pinManager.onPwmChange === 'function') {
        unsubs.push(
          pinManager.onPwmChange(pin, (_p: number, d: number) => {
            level.set(name, d);
            update();
          }),
        );
      }
    };

    const update = () => {
      for (const o of L293D_OUTPUTS) {
        const duty = (level.get(o.enable) ?? 1) * (level.get(o.input) ?? 1);
        const pin = syntheticChipPin(componentId, o.out);
        pinManager.triggerPinChange(pin, duty > 0.01);
        if (typeof pinManager.updatePwm === 'function' && duty > 0 && duty < 1) pinManager.updatePwm(pin, duty);
      }
    };

    for (const name of new Set(L293D_OUTPUTS.flatMap((o) => [o.enable, o.input]))) watch(name);
    update();
    return () => unsubs.forEach((u) => u());
  },
});

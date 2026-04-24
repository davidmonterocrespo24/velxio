/**
 * BasicParts.ts — Simulation logic for the catalog's most common interactive
 * components (pushbuttons, LEDs, switches, keypads, steppers, rotary dials).
 *
 * Migrated in CORE-002c-step4 from the legacy `PartSimulationLogic` shape
 * (4-arg `attachEvents(element, simulator, getArduinoPin, componentId)`) to
 * the narrow SDK `PartSimulation` contract (2-arg `attachEvents(element,
 * SimulatorHandle)`). Every part is authored against `@velxio/sdk` and
 * registered via `PartRegistry.registerSdkPart` — no leakage of
 * `pinManager`, `spi`, `i2cBus`, or `cpu` from the host.
 */

import type { PartSimulation, PinState } from '@velxio/sdk';
import { definePartSimulation } from '@velxio/sdk';
import type { PartRegistry } from './PartSimulationRegistry';
import { useElectricalStore } from '../../store/useElectricalStore';
import { emitPropertyChange } from './partUtils';

// PinState is `0 | 1 | 'z' | 'x'`. Only `1` is HIGH at runtime; `'z'` / `'x'`
// are treated as LOW (matches the pre-migration boolean contract).
const isHigh = (state: PinState): boolean => state === 1;

// ─── Pushbuttons ──────────────────────────────────────────────────────────────

function pushButtonPart(): PartSimulation {
  return definePartSimulation({
    attachEvents: (element, handle) => {
      const arduinoPin =
        handle.getArduinoPin('1.l') ??
        handle.getArduinoPin('2.l') ??
        handle.getArduinoPin('1.r') ??
        handle.getArduinoPin('2.r');

      const onPress = () => {
        if (arduinoPin !== null) handle.setPinState(arduinoPin, false); // Active LOW
        (element as HTMLElement & { pressed: boolean }).pressed = true;
        emitPropertyChange(handle.componentId, 'pressed', true);
      };
      const onRelease = () => {
        if (arduinoPin !== null) handle.setPinState(arduinoPin, true);
        (element as HTMLElement & { pressed: boolean }).pressed = false;
        emitPropertyChange(handle.componentId, 'pressed', false);
      };

      element.addEventListener('button-press', onPress);
      element.addEventListener('button-release', onRelease);
      return () => {
        element.removeEventListener('button-press', onPress);
        element.removeEventListener('button-release', onRelease);
      };
    },
  });
}

export const pushbuttonPart = pushButtonPart();
export const pushbutton6mmPart = pushButtonPart();

// ─── Slide switch ─────────────────────────────────────────────────────────────

export const slideSwitchPart: PartSimulation = definePartSimulation({
  attachEvents: (element, handle) => {
    const arduinoPin = handle.getArduinoPin('2') ?? handle.getArduinoPin('1');

    const readValue = (): boolean => {
      const raw = (element as HTMLElement & { value: unknown }).value;
      return raw === 1 || raw === '1';
    };

    let state = readValue();
    if (arduinoPin !== null) handle.setPinState(arduinoPin, state);
    emitPropertyChange(handle.componentId, 'value', state ? 1 : 0);

    const onChange = () => {
      state = readValue();
      if (arduinoPin !== null) handle.setPinState(arduinoPin, state);
      emitPropertyChange(handle.componentId, 'value', state ? 1 : 0);
    };

    element.addEventListener('change', onChange);
    element.addEventListener('input', onChange);
    return () => {
      element.removeEventListener('change', onChange);
      element.removeEventListener('input', onChange);
    };
  },
});

// ─── DIP Switch 8 ─────────────────────────────────────────────────────────────

export const dipSwitch8Part: PartSimulation = definePartSimulation({
  attachEvents: (element, handle) => {
    const pins: (number | null)[] = [];
    for (let i = 1; i <= 8; i++) {
      pins.push(handle.getArduinoPin(`${i}A`) ?? handle.getArduinoPin(`${i}a`));
    }

    const readValues = (): number[] =>
      (element as HTMLElement & { values?: number[] }).values ?? new Array(8).fill(0);

    const initial = readValues();
    pins.forEach((pin, i) => {
      if (pin !== null) handle.setPinState(pin, initial[i] === 1);
    });

    const onChange = () => {
      const values = readValues();
      pins.forEach((pin, i) => {
        if (pin !== null) handle.setPinState(pin, values[i] === 1);
      });
    };

    element.addEventListener('change', onChange);
    element.addEventListener('input', onChange);
    return () => {
      element.removeEventListener('change', onChange);
      element.removeEventListener('input', onChange);
    };
  },
});

// ─── LED ──────────────────────────────────────────────────────────────────────
//
// The LED reads branch current from the electrical store (SPICE-driven
// brightness) and falls back to digital pin state when no solve has landed
// yet. The digital fallback needs `onPinChange` on the anode and cathode —
// the special GND wiring case (`pin === -1`) stays recognised and short-
// circuits the subscription.

const HOLD_MS = 500;

export const ledPart: PartSimulation = definePartSimulation({
  attachEvents: (element, handle) => {
    const el = element as HTMLElement & { value: boolean; brightness: number };
    const subs: Array<{ dispose(): void } | (() => void)> = [];
    let anodeHigh = false;
    let cathodeLow = false;
    let lastSpiceBrightness = 0;
    let lastSpiceTs = 0;

    const update = () => {
      const { branchCurrents, timeWaveforms } = useElectricalStore.getState();
      const iKey = `v_${handle.componentId}_sense`;
      let raw = branchCurrents[iKey];
      if (timeWaveforms) {
        const samples = timeWaveforms.branches.get(iKey);
        if (samples && samples.length > 0) {
          let sum = 0;
          for (const s of samples) sum += Math.abs(s);
          raw = sum / samples.length;
        }
      }
      if (raw !== undefined) {
        const current = Math.abs(raw);
        lastSpiceBrightness = Math.min(1, current / 0.02);
        lastSpiceTs = Date.now();
        el.value = current > 1e-6;
        el.brightness = lastSpiceBrightness;
        return;
      }
      if (Date.now() - lastSpiceTs < HOLD_MS && lastSpiceTs > 0) {
        el.value = lastSpiceBrightness > 1e-3;
        el.brightness = lastSpiceBrightness;
        return;
      }
      lastSpiceBrightness = 0;
      el.value = anodeHigh && cathodeLow;
      el.brightness = el.value ? 1 : 0;
    };

    const cathodePin = handle.getArduinoPin('C');
    if (cathodePin === -1) {
      cathodeLow = true;
    } else if (cathodePin !== null && cathodePin >= 0) {
      subs.push(
        handle.onPinChange('C', (s) => {
          cathodeLow = !isHigh(s);
          update();
        }),
      );
    }

    const anodePin = handle.getArduinoPin('A');
    if (anodePin !== null && anodePin >= 0) {
      subs.push(
        handle.onPinChange('A', (s) => {
          anodeHigh = isHigh(s);
          update();
        }),
      );
    }

    const unsubElectrical = useElectricalStore.subscribe((state, prev) => {
      if (
        state.branchCurrents !== prev.branchCurrents ||
        state.timeWaveforms !== prev.timeWaveforms
      )
        update();
    });
    subs.push(unsubElectrical);

    update();

    return () => {
      for (const sub of subs) {
        if (typeof sub === 'function') sub();
        else sub.dispose();
      }
    };
  },
});

// ─── LED Bar Graph ────────────────────────────────────────────────────────────

export const ledBarGraphPart: PartSimulation = definePartSimulation({
  attachEvents: (element, handle) => {
    const el = element as HTMLElement & { values: number[] };
    const values = new Array(10).fill(0) as number[];
    const disposables: Array<{ dispose(): void }> = [];

    for (let i = 1; i <= 10; i++) {
      const pin = handle.getArduinoPin(`A${i}`);
      if (pin === null) continue;
      const idx = i - 1;
      disposables.push(
        handle.onPinChange(`A${i}`, (s) => {
          values[idx] = isHigh(s) ? 1 : 0;
          el.values = [...values];
        }),
      );
    }

    return () => disposables.forEach((d) => d.dispose());
  },
});

// ─── KY-040 Rotary Encoder ────────────────────────────────────────────────────

export const ky040Part: PartSimulation = definePartSimulation({
  attachEvents: (element, handle) => {
    const pinCLK = handle.getArduinoPin('CLK');
    const pinDT = handle.getArduinoPin('DT');
    const pinSW = handle.getArduinoPin('SW');

    if (pinSW !== null) handle.setPinState(pinSW, true);
    if (pinCLK !== null) handle.setPinState(pinCLK, true);
    if (pinDT !== null) handle.setPinState(pinDT, true);

    function emitPulse(dtLevel: boolean) {
      if (pinDT !== null) handle.setPinState(pinDT, dtLevel);
      if (pinCLK !== null) {
        handle.setPinState(pinCLK, false);
        setTimeout(() => {
          if (pinCLK !== null) handle.setPinState(pinCLK, true);
          setTimeout(() => {
            if (pinCLK !== null) handle.setPinState(pinCLK, false);
            if (pinDT !== null) handle.setPinState(pinDT, true);
          }, 1);
        }, 1);
      }
    }

    const onCW = () => emitPulse(false);
    const onCCW = () => emitPulse(true);
    const onPress = () => {
      if (pinSW !== null) handle.setPinState(pinSW, false);
    };
    const onRelease = () => {
      if (pinSW !== null) handle.setPinState(pinSW, true);
    };

    element.addEventListener('rotate-cw', onCW);
    element.addEventListener('rotate-ccw', onCCW);
    element.addEventListener('button-press', onPress);
    element.addEventListener('button-release', onRelease);

    return () => {
      element.removeEventListener('rotate-cw', onCW);
      element.removeEventListener('rotate-ccw', onCCW);
      element.removeEventListener('button-press', onPress);
      element.removeEventListener('button-release', onRelease);
    };
  },
});

// ─── Biaxial Stepper ──────────────────────────────────────────────────────────

const STEP_ANGLE = 1.8;
// Full-step table: [A+, B+, A-, B-]
const stepTable: [boolean, boolean, boolean, boolean][] = [
  [true, false, false, false],
  [false, true, false, false],
  [false, false, true, false],
  [false, false, false, true],
];

function stepIndexFromCoils(
  ap: boolean,
  bp: boolean,
  am: boolean,
  bm: boolean,
): number {
  for (let i = 0; i < stepTable.length; i++) {
    const [tap, tbp, tam, tbm] = stepTable[i];
    if (ap === tap && bp === tbp && am === tam && bm === tbm) return i;
  }
  return -1;
}

export const biaxialStepperPart: PartSimulation = definePartSimulation({
  attachEvents: (element, handle) => {
    const el = element as HTMLElement & { outerHandAngle: number; innerHandAngle: number };

    function makeMotorTracker(
      pinNameAminus: string,
      pinNameAplus: string,
      pinNameBplus: string,
      pinNameBminus: string,
      setAngle: (deg: number) => void,
    ) {
      let aMinus = false,
        aPlus = false,
        bPlus = false,
        bMinus = false;
      let cumAngle = 0;
      let prevIdx = -1;
      const disposables: Array<{ dispose(): void }> = [];

      function onCoilChange() {
        const idx = stepIndexFromCoils(aPlus, bPlus, aMinus, bMinus);
        if (idx < 0) return;
        if (prevIdx < 0) {
          prevIdx = idx;
          return;
        }
        const diff = (idx - prevIdx + 4) % 4;
        if (diff === 1) cumAngle += STEP_ANGLE;
        else if (diff === 3) cumAngle -= STEP_ANGLE;
        prevIdx = idx;
        setAngle(((cumAngle % 360) + 360) % 360);
      }

      disposables.push(
        handle.onPinChange(pinNameAminus, (s) => {
          aMinus = isHigh(s);
          onCoilChange();
        }),
      );
      disposables.push(
        handle.onPinChange(pinNameAplus, (s) => {
          aPlus = isHigh(s);
          onCoilChange();
        }),
      );
      disposables.push(
        handle.onPinChange(pinNameBplus, (s) => {
          bPlus = isHigh(s);
          onCoilChange();
        }),
      );
      disposables.push(
        handle.onPinChange(pinNameBminus, (s) => {
          bMinus = isHigh(s);
          onCoilChange();
        }),
      );

      return () => disposables.forEach((d) => d.dispose());
    }

    const cleanup1 = makeMotorTracker('A1-', 'A1+', 'B1+', 'B1-', (deg) => {
      el.outerHandAngle = deg;
    });
    const cleanup2 = makeMotorTracker('A2-', 'A2+', 'B2+', 'B2-', (deg) => {
      el.innerHandAngle = deg;
    });

    return () => {
      cleanup1();
      cleanup2();
    };
  },
});

// ─── Membrane Keypad ──────────────────────────────────────────────────────────

export const membraneKeypadPart: PartSimulation = definePartSimulation({
  attachEvents: (element, handle) => {
    const colPins: (number | null)[] = [
      handle.getArduinoPin('C1'),
      handle.getArduinoPin('C2'),
      handle.getArduinoPin('C3'),
      handle.getArduinoPin('C4'),
    ];

    const pressedKeys = new Set<string>();
    const activeRows = new Set<number>();
    const disposables: Array<{ dispose(): void }> = [];

    const updateCol = (col: number) => {
      const cPin = colPins[col];
      if (cPin === null) return;
      const colLow = [...activeRows].some((r) => pressedKeys.has(`${r},${col}`));
      handle.setPinState(cPin, !colLow);
    };

    for (let r = 0; r < 4; r++) {
      const row = r;
      const rowPinName = `R${r + 1}`;
      if (handle.getArduinoPin(rowPinName) === null) continue;
      disposables.push(
        handle.onPinChange(rowPinName, (s) => {
          if (!isHigh(s)) {
            activeRows.add(row);
          } else {
            activeRows.delete(row);
          }
          for (let col = 0; col < 4; col++) updateCol(col);
        }),
      );
    }

    const onPress = (e: Event) => {
      const { row, column } = (e as CustomEvent).detail;
      pressedKeys.add(`${row},${column}`);
      if (activeRows.has(row)) updateCol(column);
    };
    const onRelease = (e: Event) => {
      const { row, column } = (e as CustomEvent).detail;
      pressedKeys.delete(`${row},${column}`);
      updateCol(column);
    };

    element.addEventListener('button-press', onPress);
    element.addEventListener('button-release', onRelease);
    return () => {
      disposables.forEach((d) => d.dispose());
      element.removeEventListener('button-press', onPress);
      element.removeEventListener('button-release', onRelease);
    };
  },
});

// ─── Rotary Dialer ────────────────────────────────────────────────────────────

export const rotaryDialerPart: PartSimulation = definePartSimulation({
  attachEvents: (element, handle) => {
    const dialPin = handle.getArduinoPin('DIAL');
    const pulsePin = handle.getArduinoPin('PULSE');
    if (dialPin === null || pulsePin === null) return () => {};

    handle.setPinState(dialPin, true);
    handle.setPinState(pulsePin, true);

    const onDialStart = () => {
      handle.setPinState(dialPin, false);
    };

    const onDialEnd = (e: Event) => {
      const digit = (e as CustomEvent).detail.digit as number;
      const pulseCount = digit === 0 ? 10 : digit;
      let i = 0;
      const firePulse = () => {
        if (i < pulseCount) {
          handle.setPinState(pulsePin, false);
          setTimeout(() => {
            handle.setPinState(pulsePin, true);
            i++;
            setTimeout(firePulse, 60);
          }, 60);
        } else {
          handle.setPinState(dialPin, true);
          console.log(`[RotaryDialer] dialed ${digit}`);
        }
      };
      setTimeout(firePulse, 100);
    };

    element.addEventListener('dial-start', onDialStart);
    element.addEventListener('dial-end', onDialEnd);
    return () => {
      element.removeEventListener('dial-start', onDialStart);
      element.removeEventListener('dial-end', onDialEnd);
    };
  },
});

// ─── Seeding ──────────────────────────────────────────────────────────────────

/**
 * Register every BasicParts entry on the given registry. Called once at
 * boot by `src/builtin/registerCoreParts.ts`; order of registration
 * matches the pre-migration sequence so the PartRegistry Map stays
 * deterministic for diagnostics.
 */
export function registerBasicParts(registry: PartRegistry): void {
  registry.registerSdkPart('pushbutton', pushbuttonPart);
  registry.registerSdkPart('pushbutton-6mm', pushbutton6mmPart);
  registry.registerSdkPart('slide-switch', slideSwitchPart);
  registry.registerSdkPart('dip-switch-8', dipSwitch8Part);
  registry.registerSdkPart('led', ledPart);
  registry.registerSdkPart('led-bar-graph', ledBarGraphPart);
  registry.registerSdkPart('ky-040', ky040Part);
  registry.registerSdkPart('biaxial-stepper', biaxialStepperPart);
  registry.registerSdkPart('membrane-keypad', membraneKeypadPart);
  registry.registerSdkPart('rotary-dialer', rotaryDialerPart);
}

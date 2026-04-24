/**
 * SensorParts.ts — Simulation logic for sensors, stepper motor, and NeoPixel devices.
 *
 * Migrated to the SDK-native `definePartSimulation()` shape (CORE-002c-step4 4/5).
 *
 * Implements:
 *  - tilt-switch, ntc-temperature-sensor, gas-sensor, flame-sensor,
 *    heart-beat-sensor, big-sound-sensor, small-sound-sensor,
 *    stepper-motor, led-ring, neopixel-matrix, neopixel,
 *    pir-motion-sensor  → SDK shape (`handle.setPinState`,
 *    `handle.setAnalogValue`, `handle.onPinChange`,
 *    `handle.onSensorControlUpdate`, `handle.cyclesNow`,
 *    `handle.schedulePinChange`, `handle.clockHz`).
 *
 * Kept on the legacy 3-arg / `onPinStateChange` shape:
 *  - `ks2e-m-dc5` — observation-only relay that uses the `onPinStateChange`
 *    hook (a different entry point than `attachEvents`, not covered by
 *    `definePartSimulation`).
 *  - `hc-sr04` — the ESP32 path delegates protocol emulation to the backend
 *    QEMU worker via `simulator.registerSensor('hc-sr04', …)`, which is
 *    deliberately outside the board-agnostic SDK (tracked as a follow-up
 *    under step4a: "ESP32 I2C/sensor slaves via backend QEMU stays out of
 *    SDK scope; plugin I²C support needs the ESP32 bridge SDK"). The
 *    AVR/RP2040 path is SDK-compatible in isolation, but keeping the two
 *    branches together preserves the single `hc-sr04` registration.
 */

import type { PartSimulation, PinState } from '@velxio/sdk';
import { definePartSimulation } from '@velxio/sdk';
import type { PartRegistry } from './PartSimulationRegistry';
import { emitPropertyChange } from './partUtils';
import { registerSensorUpdate, unregisterSensorUpdate } from '../SensorUpdateRegistry';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const isHigh = (state: PinState): boolean => state === 1;

/**
 * Standard Disposable for the `disposables` bag pattern every migrated part
 * below uses. Keeping the shape explicit keeps the closures typecheck-clean
 * without pulling the SDK `Disposable` type in at every call site.
 */
type Disposable = { dispose(): void };

// ─── tilt-switch ─────────────────────────────────────────────────────────────

const tiltSwitchPart = definePartSimulation({
  attachEvents: (element, handle) => {
    const pin = handle.getArduinoPin('OUT');
    if (pin === null) return () => {};

    let tilted = false;

    const triggerToggle = () => {
      tilted = !tilted;
      handle.setPinState(pin, tilted);
      console.log(
        `[TiltSwitch] pin ${pin} → ${tilted ? 'HIGH (tilted)' : 'LOW (upright)'}`,
      );
    };

    handle.setPinState(pin, false);
    element.addEventListener('click', triggerToggle);

    const sensorDisp = handle.onSensorControlUpdate((values) => {
      if (values.toggle === true) triggerToggle();
    });

    return () => {
      element.removeEventListener('click', triggerToggle);
      sensorDisp.dispose();
    };
  },
});

// ─── ntc-temperature-sensor ──────────────────────────────────────────────────

const ntcTemperatureSensorPart = definePartSimulation({
  attachEvents: (element, handle) => {
    const tempToVolts = (temp: number) =>
      Math.max(0, Math.min(5, 2.5 - (temp - 25) * 0.02));

    handle.setAnalogValue('OUT', tempToVolts(25));

    const onInput = () => {
      const val = (element as HTMLInputElement & { value?: string }).value;
      if (val !== undefined) {
        const num = parseFloat(val);
        if (Number.isFinite(num)) {
          handle.setAnalogValue('OUT', (num / 1023.0) * 5.0);
        }
      }
    };
    element.addEventListener('input', onInput);

    const sensorDisp = handle.onSensorControlUpdate((values) => {
      if ('temperature' in values) {
        const temp = values.temperature as number;
        handle.setAnalogValue('OUT', tempToVolts(temp));
        emitPropertyChange(handle.componentId, 'temperature', temp);
      }
    });

    return () => {
      element.removeEventListener('input', onInput);
      sensorDisp.dispose();
    };
  },
});

// ─── Shared mid-range analog sensor with DOUT LED indicator ──────────────────

interface MidRangeSensorOptions {
  /** Baseline volts injected on AOUT at attach time. */
  baselineVolts: number;
  /** The DOM property toggled by DOUT pin transitions ('ledD0', 'ledSignal', 'led1'). */
  doutElementProp: string;
  /** The SensorControlPanel key that drives AOUT (e.g. 'gasLevel', 'soundLevel'). */
  panelKey: string;
  /** Power-LED DOM property (true at boot). */
  powerElementProp: string;
  /** Custom AOUT mapper (intensity → volts). Defaults to `(v/1023) * 5.0`. */
  panelToVolts?: (value: number) => number;
}

function buildMidRangeAnalogSensor(opts: MidRangeSensorOptions): PartSimulation {
  const panelToVolts = opts.panelToVolts ?? ((v: number) => (v / 1023) * 5.0);

  return definePartSimulation({
    attachEvents: (element, handle) => {
      const el = element as HTMLElement & Record<string, unknown>;
      el[opts.powerElementProp] = true;

      const disposables: Disposable[] = [];

      handle.setAnalogValue('AOUT', opts.baselineVolts);

      // DOUT from Arduino → threshold LED indicator on the element.
      disposables.push(
        handle.onPinChange('DOUT', (state) => {
          el[opts.doutElementProp] = isHigh(state);
        }),
      );

      const onInput = () => {
        const val = (element as HTMLInputElement & { value?: string }).value;
        if (val !== undefined) {
          const num = parseFloat(val);
          if (Number.isFinite(num)) {
            handle.setAnalogValue('AOUT', (num / 1023.0) * 5.0);
          }
        }
      };
      element.addEventListener('input', onInput);
      disposables.push({
        dispose: () => element.removeEventListener('input', onInput),
      });

      disposables.push(
        handle.onSensorControlUpdate((values) => {
          if (opts.panelKey in values) {
            handle.setAnalogValue(
              'AOUT',
              panelToVolts(values[opts.panelKey] as number),
            );
          }
        }),
      );

      return () => disposables.forEach((d) => d.dispose());
    },
  });
}

const gasSensorPart = buildMidRangeAnalogSensor({
  baselineVolts: 1.5,
  doutElementProp: 'ledD0',
  panelKey: 'gasLevel',
  powerElementProp: 'ledPower',
});

const bigSoundSensorPart = buildMidRangeAnalogSensor({
  baselineVolts: 2.5,
  doutElementProp: 'led1',
  panelKey: 'soundLevel',
  powerElementProp: 'led2',
});

const smallSoundSensorPart = buildMidRangeAnalogSensor({
  baselineVolts: 2.5,
  doutElementProp: 'ledSignal',
  panelKey: 'soundLevel',
  powerElementProp: 'ledPower',
});

const flameSensorPart = buildMidRangeAnalogSensor({
  baselineVolts: 4.5,
  doutElementProp: 'ledSignal',
  panelKey: 'intensity',
  powerElementProp: 'ledPower',
  // 0 = no flame → high voltage (5V); 1023 = flame → low voltage (0V).
  panelToVolts: (v) => 5.0 - (v / 1023) * 5.0,
});

// ─── heart-beat-sensor ───────────────────────────────────────────────────────

const heartBeatSensorPart = definePartSimulation({
  attachEvents: (_element, handle) => {
    const pin = handle.getArduinoPin('OUT');
    if (pin === null) return () => {};

    handle.setPinState(pin, false);

    const intervalId = setInterval(() => {
      handle.setPinState(pin, true);
      setTimeout(() => handle.setPinState(pin, false), 100);
    }, 1000);

    return () => clearInterval(intervalId);
  },
});

// ─── stepper-motor ───────────────────────────────────────────────────────────

const stepperMotorPart = definePartSimulation({
  attachEvents: (element, handle) => {
    const el = element as HTMLElement & { angle?: number };
    const STEP_ANGLE = 1.8;

    const coils = { aMinus: false, aPlus: false, bPlus: false, bMinus: false };
    let cumAngle = el.angle ?? 0;
    let prevStepIndex = -1;

    const stepTable: ReadonlyArray<readonly [boolean, boolean, boolean, boolean]> = [
      [true, false, false, false],
      [false, true, false, false],
      [false, false, true, false],
      [false, false, false, true],
    ];

    const coilToStepIndex = (): number => {
      for (let i = 0; i < stepTable.length; i++) {
        const [ap, bp, am, bm] = stepTable[i];
        if (
          coils.aPlus === ap &&
          coils.bPlus === bp &&
          coils.aMinus === am &&
          coils.bMinus === bm
        ) {
          return i;
        }
      }
      return -1;
    };

    const onCoilChange = () => {
      const idx = coilToStepIndex();
      if (idx < 0) return;
      if (prevStepIndex < 0) {
        prevStepIndex = idx;
        return;
      }
      const diff = (idx - prevStepIndex + 4) % 4;
      if (diff === 1) cumAngle += STEP_ANGLE;
      else if (diff === 3) cumAngle -= STEP_ANGLE;
      prevStepIndex = idx;
      el.angle = ((cumAngle % 360) + 360) % 360;
    };

    const disposables: Disposable[] = [
      handle.onPinChange('A-', (s) => {
        coils.aMinus = isHigh(s);
        onCoilChange();
      }),
      handle.onPinChange('A+', (s) => {
        coils.aPlus = isHigh(s);
        onCoilChange();
      }),
      handle.onPinChange('B+', (s) => {
        coils.bPlus = isHigh(s);
        onCoilChange();
      }),
      handle.onPinChange('B-', (s) => {
        coils.bMinus = isHigh(s);
        onCoilChange();
      }),
    ];

    return () => disposables.forEach((d) => d.dispose());
  },
});

// ─── WS2812B NeoPixel decode helper ──────────────────────────────────────────

/**
 * Decode WS2812B bit-stream from DIN pin changes.
 *
 * Uses `handle.cyclesNow()` for the bit-timing threshold; the old legacy
 * implementation reached into `simulator.cpu.cycles`, which is now forbidden
 * from an SDK-shaped part. Threshold values (RESET_CYCLES=800,
 * BIT1_THRESHOLD=8) are preserved byte-for-byte so decoding stays
 * bit-identical to the pre-migration path.
 */
function createNeopixelDecoder(
  handle: Parameters<NonNullable<PartSimulation['attachEvents']>>[1],
  onPixel: (index: number, r: number, g: number, b: number) => void,
): Disposable {
  const RESET_CYCLES = 800;
  const BIT1_THRESHOLD = 8;

  let lastRisingCycle = 0;
  let lastFallingCycle = 0;
  let lastHigh = false;

  let bitBuf = 0;
  let bitsCollected = 0;
  let byteBuf: number[] = [];
  let pixelIndex = 0;

  return handle.onPinChange('DIN', (state) => {
    const now = handle.cyclesNow();
    const high = isHigh(state);

    if (high) {
      const lowDur = now - lastFallingCycle;
      if (lowDur > RESET_CYCLES) {
        pixelIndex = 0;
        byteBuf = [];
        bitBuf = 0;
        bitsCollected = 0;
      }
      lastRisingCycle = now;
      lastHigh = true;
    } else {
      if (lastHigh) {
        const highDur = now - lastRisingCycle;
        const bit = highDur > BIT1_THRESHOLD ? 1 : 0;

        bitBuf = (bitBuf << 1) | bit;
        bitsCollected++;

        if (bitsCollected === 8) {
          byteBuf.push(bitBuf & 0xff);
          bitBuf = 0;
          bitsCollected = 0;

          if (byteBuf.length === 3) {
            const g = byteBuf[0];
            const r = byteBuf[1];
            const b = byteBuf[2];
            onPixel(pixelIndex++, r, g, b);
            byteBuf = [];
          }
        }
      }
      lastFallingCycle = now;
      lastHigh = false;
    }
  });
}

// ─── led-ring (WS2812B NeoPixel ring) ────────────────────────────────────────

const ledRingPart = definePartSimulation({
  attachEvents: (element, handle) => {
    const pinDIN = handle.getArduinoPin('DIN');
    if (pinDIN === null) return () => {};

    const el = element as HTMLElement & {
      setPixel?: (i: number, rgb: { r: number; g: number; b: number }) => void;
    };

    const disp = createNeopixelDecoder(handle, (index, r, g, b) => {
      try {
        el.setPixel?.(index, { r, g, b });
      } catch {
        // element not yet upgraded — ignore
      }
    });

    return () => disp.dispose();
  },
});

// ─── neopixel-matrix (WS2812B matrix grid) ───────────────────────────────────

const neopixelMatrixPart = definePartSimulation({
  attachEvents: (element, handle) => {
    const pinDIN = handle.getArduinoPin('DIN');
    if (pinDIN === null) return () => {};

    type MatrixElement = HTMLElement & {
      cols?: number;
      setPixel?: (
        row: number,
        col: number,
        rgb: { r: number; g: number; b: number },
      ) => void;
    };
    const el = element as MatrixElement;

    const disp = createNeopixelDecoder(handle, (index, r, g, b) => {
      const cols = el.cols ?? 8;
      const row = Math.floor(index / cols);
      const col = index % cols;
      try {
        el.setPixel?.(row, col, { r, g, b });
      } catch {
        // ignore
      }
    });

    return () => disp.dispose();
  },
});

// ─── neopixel (single addressable RGB LED) ───────────────────────────────────

const neopixelPart = definePartSimulation({
  attachEvents: (element, handle) => {
    const pinDIN = handle.getArduinoPin('DIN');
    if (pinDIN === null) return () => {};

    const el = element as HTMLElement & { r?: number; g?: number; b?: number };

    const disp = createNeopixelDecoder(handle, (_index, r, g, b) => {
      el.r = r / 255;
      el.g = g / 255;
      el.b = b / 255;
    });

    return () => disp.dispose();
  },
});

// ─── pir-motion-sensor ───────────────────────────────────────────────────────

const pirMotionSensorPart = definePartSimulation({
  attachEvents: (element, handle) => {
    const pin = handle.getArduinoPin('OUT');
    if (pin === null) return () => {};

    handle.setPinState(pin, false);

    let timer: ReturnType<typeof setTimeout> | null = null;

    const triggerMotion = () => {
      if (timer !== null) clearTimeout(timer);
      handle.setPinState(pin, true);
      console.log('[PIR] Motion detected → OUT HIGH');
      timer = setTimeout(() => {
        handle.setPinState(pin, false);
        timer = null;
        console.log('[PIR] Motion ended → OUT LOW');
      }, 3000);
    };

    element.addEventListener('click', triggerMotion);

    const sensorDisp = handle.onSensorControlUpdate((values) => {
      if (values.trigger === true) triggerMotion();
    });

    return () => {
      element.removeEventListener('click', triggerMotion);
      if (timer !== null) clearTimeout(timer);
      sensorDisp.dispose();
    };
  },
});

// ─── Legacy parts (ks2e-m-dc5, hc-sr04) ──────────────────────────────────────

/**
 * Kept on the legacy `registry.register()` shape — `onPinStateChange` is a
 * different entry point than `attachEvents` (observation-only, no cleanup),
 * and `hc-sr04`'s ESP32 branch uses `simulator.registerSensor` which is
 * backend-QEMU specific and deliberately excluded from the SDK surface.
 */
function registerLegacySensorParts(registry: PartRegistry): void {
  // ks2e-m-dc5 — relay observer.
  registry.register('ks2e-m-dc5', {
    onPinStateChange: (pinName, state, _element) => {
      if (pinName === 'COIL1' || pinName === 'COIL2') {
        console.log(
          `[Relay KS2E] ${pinName} → ${state ? 'ACTIVATED' : 'RELEASED'}`,
        );
      }
    },
  });

  // hc-sr04 — ultrasonic distance sensor.
  //
  // ESP32 path (when the simulator exposes `registerSensor`) delegates to
  // the backend QEMU worker. AVR/RP2040 path uses `schedulePinChange` for
  // cycle-accurate ECHO pulse generation. Keeping them in one legacy entry
  // because the ESP32 code path isn't yet portable to the board-agnostic
  // SDK (follow-up under CORE-003c ESP32 bridge SDK).
  registry.register('hc-sr04', {
    attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
      const trigPin = getArduinoPinHelper('TRIG');
      const echoPin = getArduinoPinHelper('ECHO');
      if (trigPin === null || echoPin === null) return () => {};

      const el = element as HTMLElement & { distance?: string | number };
      let distanceCm = parseFloat(String(el.distance ?? '')) || 10;

      // ── ESP32 path: delegate protocol to backend QEMU worker ──
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const simAny = simulator as any;
      const handledNatively =
        typeof simAny.registerSensor === 'function' &&
        simAny.registerSensor('hc-sr04', trigPin, {
          distance: distanceCm,
          echo_pin: echoPin,
        });

      if (handledNatively) {
        registerSensorUpdate(componentId, (values) => {
          if ('distance' in values) {
            distanceCm = Math.max(2, Math.min(400, values.distance as number));
          }
          simAny.updateSensor(trigPin, {
            distance: distanceCm,
            echo_pin: echoPin,
          });
        });

        return () => {
          simAny.unregisterSensor(trigPin);
          unregisterSensorUpdate(componentId);
        };
      }

      // ── AVR / RP2040 path: local pin scheduling ──
      simulator.setPinState(echoPin, false);

      const cleanup = simulator.pinManager.onPinChange(
        trigPin,
        (_: number, state: boolean) => {
          if (!state) return;
          if (typeof simulator.schedulePinChange === 'function') {
            const clockHz: number =
              typeof simAny.getClockHz === 'function'
                ? simAny.getClockHz()
                : 16_000_000;
            const now = simulator.getCurrentCycles() as number;
            const processingCycles = Math.round(600e-6 * clockHz);
            const echoCycles = Math.round((distanceCm / 17150) * clockHz);
            simulator.schedulePinChange(echoPin, true, now + processingCycles);
            simulator.schedulePinChange(
              echoPin,
              false,
              now + processingCycles + echoCycles,
            );
            console.log(
              `[HC-SR04] Scheduled ECHO (${distanceCm} cm, echo=${(
                echoCycles /
                (clockHz / 1e6)
              ).toFixed(1)} µs)`,
            );
          } else {
            const echoMs = Math.max(1, distanceCm / 17.15);
            setTimeout(() => {
              simulator.setPinState(echoPin, true);
              setTimeout(() => {
                simulator.setPinState(echoPin, false);
              }, echoMs);
            }, 1);
          }
        },
      );

      registerSensorUpdate(componentId, (values) => {
        if ('distance' in values) {
          distanceCm = Math.max(2, Math.min(400, values.distance as number));
        }
      });

      return () => {
        cleanup();
        unregisterSensorUpdate(componentId);
      };
    },
  });
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerSensorParts(registry: PartRegistry): void {
  registry.registerSdkPart('tilt-switch', tiltSwitchPart);
  registry.registerSdkPart('ntc-temperature-sensor', ntcTemperatureSensorPart);
  registry.registerSdkPart('gas-sensor', gasSensorPart);
  registry.registerSdkPart('flame-sensor', flameSensorPart);
  registry.registerSdkPart('heart-beat-sensor', heartBeatSensorPart);
  registry.registerSdkPart('big-sound-sensor', bigSoundSensorPart);
  registry.registerSdkPart('small-sound-sensor', smallSoundSensorPart);
  registry.registerSdkPart('stepper-motor', stepperMotorPart);
  registry.registerSdkPart('led-ring', ledRingPart);
  registry.registerSdkPart('neopixel-matrix', neopixelMatrixPart);
  registry.registerSdkPart('neopixel', neopixelPart);
  registry.registerSdkPart('pir-motion-sensor', pirMotionSensorPart);
  registerLegacySensorParts(registry);
}

/**
 * SensorParts.ts — Simulation logic for sensors, stepper motor, and NeoPixel devices.
 *
 * Implements:
 *  - tilt-switch
 *  - ntc-temperature-sensor
 *  - photodiode
 *  - gas-sensor (MQ-series)
 *  - flame-sensor
 *  - heart-beat-sensor
 *  - big-sound-sensor
 *  - small-sound-sensor
 *  - stepper-motor (NEMA full-step decode)
 *  - led-ring (WS2812B NeoPixel ring)
 *  - neopixel-matrix (WS2812B NeoPixel matrix)
 *  - pir-motion-sensor
 *  - hc-sr04
 */

import { PartSimulationRegistry } from './PartSimulationRegistry';
import { requestLine, releaseLineGap, recordPartGap } from '../line/requestLine';
import { setAdcVoltage, emitPropertyChange, analogRailVolts, guestMillis } from './partUtils';
import { registerSensorUpdate, unregisterSensorUpdate } from '../SensorUpdateRegistry';
import { useSimulatorStore } from '../../store/useSimulatorStore';

// ─── Tilt Switch ─────────────────────────────────────────────────────────────

/**
 * Tilt switch — click the element to toggle between tilted (OUT HIGH) and
 * upright (OUT LOW). Also controllable via SensorControlPanel "Toggle tilt" button.
 */
PartSimulationRegistry.register('tilt-switch', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const pin = getArduinoPinHelper('OUT');
    if (pin === null) return () => {};

    let tilted = false;

    const triggerToggle = () => {
      tilted = !tilted;
      simulator.setPinState(pin, tilted);
      console.log(`[TiltSwitch] pin ${pin} → ${tilted ? 'HIGH (tilted)' : 'LOW (upright)'}`);
    };

    // Start LOW (upright)
    simulator.setPinState(pin, false);
    element.addEventListener('click', triggerToggle);

    // SensorControlPanel callback
    registerSensorUpdate(componentId, (values) => {
      if (values.toggle === true) triggerToggle();
    });

    return () => {
      element.removeEventListener('click', triggerToggle);
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── NTC Temperature Sensor ──────────────────────────────────────────────────

/**
 * NTC thermistor sensor — injects analog voltage representing temperature.
 * Default 25°C → 2.5V. SensorControlPanel slider adjusts temperature.
 *
 * The injected OUT voltage uses the SAME β-model voltage divider the circuit
 * (and the example sketch) assume: a 10k pull-up from VCC to OUT and the NTC
 * from OUT to GND, so V_OUT = VCC · R_ntc / (R_ntc + R_pull) with
 * R_ntc(T) = R0 · exp(β · (1/T − 1/T0)).  This makes the injected ADC voltage
 * decode straight back to the slider value (set 50°C → read 50°C).  When the
 * electrical (SPICE) engine is active it drives A0 from the ngspice solve
 * instead, using the matching topology in componentToSpice.ts — both agree.
 *
 * VCC is the rail of the board the sensor is wired to, not a constant 5. The
 * divider used to assume 5 V everywhere, which on a 3.3 V board put the node
 * above the ADC's full scale: the slider read 1.4°C where it said 25, and
 * everything below ~11°C pinned at the same saturated value (issue #233). The
 * SPICE path already used the board's rail, so the two only agreed on AVR.
 */
PartSimulationRegistry.register('ntc-temperature-sensor', {
  attachEvents: (_element, simulator, getArduinoPinHelper, componentId) => {
    const pin = getArduinoPinHelper('OUT');

    const NTC_R0 = 10_000;
    const NTC_BETA = 3950;
    const R_PULL = 10_000;
    const vcc = analogRailVolts(simulator);
    const tempToVolts = (temp: number) => {
      const rNtc = NTC_R0 * Math.exp(NTC_BETA * (1 / (temp + 273.15) - 1 / 298.15));
      return Math.max(0, Math.min(vcc, vcc * (rNtc / (rNtc + R_PULL))));
    };

    // Room temperature default
    if (pin !== null) setAdcVoltage(simulator, pin, tempToVolts(25));

    registerSensorUpdate(componentId, (values) => {
      if ('temperature' in values) {
        if (pin !== null) {
          setAdcVoltage(simulator, pin, tempToVolts(values.temperature as number));
        }
        // Mirror to store — the SPICE ntc-temperature-sensor handler
        // reads comp.properties.temperature when computing R_ntc.
        emitPropertyChange(componentId, 'temperature', values.temperature);
      }
    });

    return () => {
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── Photodiode ──────────────────────────────────────────────────────────────

/**
 * Photodiode — 2-terminal passive, reverse-biased light sensor. The SPICE
 * emitter (componentToSpice.ts) reads `properties.lux` and drives a current
 * source (100 nA/lux). This handler wires the SensorControlPanel slider so
 * moving it updates the store → netlist rebuild → re-solve.
 */
PartSimulationRegistry.register('photodiode', {
  attachEvents: (_element, _simulator, _getArduinoPinHelper, componentId) => {
    registerSensorUpdate(componentId, (values) => {
      if ('lux' in values) {
        emitPropertyChange(componentId, 'lux', values.lux);
      }
    });

    return () => {
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── Gas Sensor (MQ-series) ──────────────────────────────────────────────────

/**
 * Gas sensor — injects analog voltage on AOUT.
 * Default 1.5V (clean air / low gas). SensorControlPanel slider adjusts level (0–1023).
 * Higher value → higher voltage (more gas detected).
 */
PartSimulationRegistry.register('gas-sensor', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const pinAOUT = getArduinoPinHelper('AOUT');
    const pinDOUT = getArduinoPinHelper('DOUT');
    const pinManager = (simulator as any).pinManager;

    const el = element as any;
    el.ledPower = true;

    const unsubscribers: (() => void)[] = [];

    // Inject baseline analog voltage (1.5V ≈ clean air / low gas)
    if (pinAOUT !== null) {
      setAdcVoltage(simulator, pinAOUT, 1.5);
    }

    // DOUT from Arduino → threshold LED indicator
    if (pinDOUT !== null && pinManager) {
      unsubscribers.push(
        pinManager.onPinChange(pinDOUT, (_: number, state: boolean) => {
          el.ledD0 = state;
        }),
      );
    }

    // Allow element to update analog value if it fires input events
    const onInput = () => {
      const val = (el as any).value;
      if (val !== undefined && pinAOUT !== null) {
        setAdcVoltage(simulator, pinAOUT, (val / 1023.0) * 5.0);
      }
    };
    element.addEventListener('input', onInput);
    unsubscribers.push(() => element.removeEventListener('input', onInput));

    registerSensorUpdate(componentId, (values) => {
      if ('gasLevel' in values && pinAOUT !== null) {
        setAdcVoltage(simulator, pinAOUT, ((values.gasLevel as number) / 1023) * 5.0);
      }
    });

    return () => {
      unsubscribers.forEach((u) => u());
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── Flame Sensor ────────────────────────────────────────────────────────────

/**
 * Flame sensor — injects analog voltage on AOUT.
 * Default 4.5V (no flame). SensorControlPanel slider: 0 = no flame (high V),
 * 1023 = intense flame (low V).
 */
PartSimulationRegistry.register('flame-sensor', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const pinAOUT = getArduinoPinHelper('AOUT');
    const pinDOUT = getArduinoPinHelper('DOUT');
    const pinManager = (simulator as any).pinManager;

    const el = element as any;
    el.ledPower = true;

    const unsubscribers: (() => void)[] = [];

    if (pinAOUT !== null) {
      setAdcVoltage(simulator, pinAOUT, 4.5); // no flame = high voltage
    }

    if (pinDOUT !== null && pinManager) {
      unsubscribers.push(
        pinManager.onPinChange(pinDOUT, (_: number, state: boolean) => {
          el.ledSignal = state;
        }),
      );
    }

    const onInput = () => {
      const val = (el as any).value;
      if (val !== undefined && pinAOUT !== null) {
        setAdcVoltage(simulator, pinAOUT, (val / 1023.0) * 5.0);
      }
    };
    element.addEventListener('input', onInput);
    unsubscribers.push(() => element.removeEventListener('input', onInput));

    registerSensorUpdate(componentId, (values) => {
      if ('intensity' in values && pinAOUT !== null) {
        // 0 = no flame → high voltage (4.5V); 1023 = flame → low voltage (0.2V)
        const volts = 5.0 - ((values.intensity as number) / 1023) * 5.0;
        setAdcVoltage(simulator, pinAOUT, volts);
      }
    });

    return () => {
      unsubscribers.forEach((u) => u());
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── Heart Beat Sensor ───────────────────────────────────────────────────────

/**
 * Heart beat sensor (KY-039 / optical pulse module) — drives OUT with a
 * photoplethysmogram, the waveform an optical pulse sensor really produces.
 *
 * The module has ONE output pin and sketches read it BOTH ways, so the part
 * drives both meanings of that pin, exactly as the hardware does:
 *
 *  - analogRead / ADC: the PPG itself — a fast systolic upstroke, the dicrotic
 *    notch of the aortic valve closing, then the slow diastolic decay. Sampled
 *    into the channel at HB_SAMPLE_MS.
 *  - digitalRead: one short pulse per beat, the way the module's on-board
 *    comparator reports it. Emitted while the systolic peak is above
 *    HB_BEAT_LEVEL, which is ~12% of the cycle (~96 ms at 72 BPM) — the same
 *    shape as the fixed 100 ms pulse this part used to emit, so sketches that
 *    count digital edges keep working.
 *
 * Until this the part ONLY pulsed the digital pin and never touched the ADC,
 * so every sketch reading the module the usual way (analogRead / ADC.read())
 * saw a flat zero and reported 0 BPM. The notch is deliberately kept below the
 * level a beat-detection threshold sits at, so a naive `value > THRESHOLD`
 * peak counter sees one peak per cycle, not two.
 *
 * Rate comes from the `bpm` property and from the sensor control panel.
 */

const HB_DEFAULT_BPM = 72;
const HB_MIN_BPM = 30;
const HB_MAX_BPM = 220;
/** Sampling period of the analog output. 50 Hz is smooth on a 128 px trace. */
const HB_SAMPLE_MS = 20;
/** Rest and peak of the analog swing, as a fraction of the board's ADC rail. */
const HB_LEVEL_LOW = 0.15;
const HB_LEVEL_HIGH = 0.95;
/** Waveform level the digital comparator output follows. Above the notch. */
const HB_BEAT_LEVEL = 0.55;
/**
 * Give up on the ADC after this many failed writes. `setAdcVoltage` answers
 * false when OUT is not wired to an ADC-capable pad, and the RP2040 branch
 * warns on every call — retrying 50x a second would flood the console. A few
 * tries still cover a simulator that is not up yet on the first tick.
 */
const HB_ANALOG_TRIES = 16;

/**
 * One cardiac cycle as [phase, level] control points, cosine-eased between
 * them. Phase runs 0..1 over one beat; level runs 0 (diastolic floor) to 1
 * (systolic peak).
 */
const HB_WAVEFORM: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.06],
  [0.09, 1.0], // systolic peak
  [0.2, 0.34], // rapid fall
  [0.3, 0.42], // dicrotic notch
  [0.42, 0.28],
  [1.0, 0.06], // diastolic decay back to the floor
];

/** Level of the pulse waveform at `phase` (any real; only the fraction matters). */
export function heartBeatLevel(phase: number): number {
  const p = phase - Math.floor(phase);
  for (let i = 1; i < HB_WAVEFORM.length; i++) {
    const [p1, v1] = HB_WAVEFORM[i];
    if (p <= p1) {
      const [p0, v0] = HB_WAVEFORM[i - 1];
      const t = (p - p0) / (p1 - p0);
      return v0 + (v1 - v0) * (0.5 - 0.5 * Math.cos(Math.PI * t));
    }
  }
  return HB_WAVEFORM[HB_WAVEFORM.length - 1][1];
}

function heartBeatClampBpm(value: unknown, fallback: number): number {
  const n = parseFloat(String(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(HB_MAX_BPM, Math.max(HB_MIN_BPM, n));
}

PartSimulationRegistry.register('heart-beat-sensor', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const pin = getArduinoPinHelper('OUT');
    if (pin === null) return () => {};

    const el = element as HTMLElement & { bpm?: string | number };
    let bpm = heartBeatClampBpm(el.bpm, HB_DEFAULT_BPM);

    const rail = analogRailVolts(simulator);
    const voltsFor = (level: number) =>
      rail * (HB_LEVEL_LOW + level * (HB_LEVEL_HIGH - HB_LEVEL_LOW));

    let phase = 0;
    // Negative, not 0: a clock legitimately reads 0 on the first tick, and a
    // `last === 0` sentinel would then re-arm on the tick after.
    let last = -1;
    let onGuestClock = false;
    let beat = false;
    let analogOk = false;
    let analogTries = 0;

    const writeAnalog = (level: number) => {
      if (!analogOk && analogTries >= HB_ANALOG_TRIES) return;
      analogTries++;
      if (setAdcVoltage(simulator, pin, voltsFor(level))) analogOk = true;
    };

    // Rest level first, so a sketch that reads before the first tick sees the
    // sensor sitting at its baseline rather than at a phantom 0 V.
    simulator.setPinState(pin, false);
    writeAnalog(heartBeatLevel(0));

    const tick = () => {
      // Beat on the clock the SKETCH sees. An emulated board runs slower than
      // real time, and a waveform stepped by the browser's clock sweeps past a
      // guest managing a couple of loop iterations a second: it samples at
      // effectively random phases and the BPM it computes from its own millis()
      // is nowhere near the rate configured here. On the guest clock the sketch
      // gets the same samples per beat it would get on real hardware, however
      // fast or slow the emulator happens to be running.
      const guest = guestMillis(simulator);
      const useGuest = guest !== null;
      const now = useGuest
        ? (guest as number)
        : typeof performance !== 'undefined'
          ? performance.now()
          : Date.now();
      // Switching clocks (the engine came up, or went away) restarts the delta
      // rather than integrating the offset between two unrelated timebases.
      const dt =
        last < 0 || useGuest !== onGuestClock ? HB_SAMPLE_MS : Math.min(now - last, 1000);
      onGuestClock = useGuest;
      last = now;
      // Advance the phase rather than recomputing it from an epoch: the
      // waveform then stays continuous when the rate changes mid-beat.
      phase = (phase + (dt / 1000) * (bpm / 60)) % 1;

      const level = heartBeatLevel(phase);
      writeAnalog(level);

      const nextBeat = level >= HB_BEAT_LEVEL;
      if (nextBeat !== beat) {
        beat = nextBeat;
        simulator.setPinState(pin, beat);
        // The Wokwi element is a static SVG with no LED property to drive, so
        // the visible beat is a brightness lift on the element itself.
        if (el.style) el.style.filter = beat ? 'brightness(1.4)' : '';
      }
    };

    const intervalId = setInterval(tick, HB_SAMPLE_MS);

    registerSensorUpdate(componentId, (values) => {
      if ('bpm' in values) {
        bpm = heartBeatClampBpm(values.bpm, bpm);
        el.bpm = bpm;
        emitPropertyChange(componentId, 'bpm', bpm);
      }
    });

    return () => {
      clearInterval(intervalId);
      unregisterSensorUpdate(componentId);
      if (el.style) el.style.filter = '';
      simulator.setPinState(pin, false);
    };
  },
});

// ─── Big Sound Sensor ────────────────────────────────────────────────────────

/**
 * Big sound sensor (FC-04) — injects mid-range analog on AOUT.
 * SensorControlPanel slider adjusts sound level (0–1023).
 */
PartSimulationRegistry.register('big-sound-sensor', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const pinAOUT = getArduinoPinHelper('AOUT');
    const pinDOUT = getArduinoPinHelper('DOUT');
    const pinManager = (simulator as any).pinManager;

    const el = element as any;
    el.led2 = true; // Power LED

    const unsubscribers: (() => void)[] = [];

    if (pinAOUT !== null) {
      setAdcVoltage(simulator, pinAOUT, 2.5);
    }

    if (pinDOUT !== null && pinManager) {
      unsubscribers.push(
        pinManager.onPinChange(pinDOUT, (_: number, state: boolean) => {
          el.led1 = state;
        }),
      );
    }

    const onInput = () => {
      const val = (el as any).value;
      if (val !== undefined && pinAOUT !== null) {
        setAdcVoltage(simulator, pinAOUT, (val / 1023.0) * 5.0);
      }
    };
    element.addEventListener('input', onInput);
    unsubscribers.push(() => element.removeEventListener('input', onInput));

    registerSensorUpdate(componentId, (values) => {
      if ('soundLevel' in values && pinAOUT !== null) {
        setAdcVoltage(simulator, pinAOUT, ((values.soundLevel as number) / 1023) * 5.0);
      }
    });

    return () => {
      unsubscribers.forEach((u) => u());
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── Small Sound Sensor ──────────────────────────────────────────────────────

/**
 * Small sound sensor (KY-038) — injects mid-range analog on AOUT.
 * SensorControlPanel slider adjusts sound level (0–1023).
 */
PartSimulationRegistry.register('small-sound-sensor', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const pinAOUT = getArduinoPinHelper('AOUT');
    const pinDOUT = getArduinoPinHelper('DOUT');
    const pinManager = (simulator as any).pinManager;

    const el = element as any;
    el.ledPower = true;

    const unsubscribers: (() => void)[] = [];

    if (pinAOUT !== null) {
      setAdcVoltage(simulator, pinAOUT, 2.5);
    }

    if (pinDOUT !== null && pinManager) {
      unsubscribers.push(
        pinManager.onPinChange(pinDOUT, (_: number, state: boolean) => {
          el.ledSignal = state;
        }),
      );
    }

    const onInput = () => {
      const val = (el as any).value;
      if (val !== undefined && pinAOUT !== null) {
        setAdcVoltage(simulator, pinAOUT, (val / 1023.0) * 5.0);
      }
    };
    element.addEventListener('input', onInput);
    unsubscribers.push(() => element.removeEventListener('input', onInput));

    registerSensorUpdate(componentId, (values) => {
      if ('soundLevel' in values && pinAOUT !== null) {
        setAdcVoltage(simulator, pinAOUT, ((values.soundLevel as number) / 1023) * 5.0);
      }
    });

    return () => {
      unsubscribers.forEach((u) => u());
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── Stepper Motor (NEMA full-step decode) ───────────────────────────────────

/**
 * Stepper motor — monitors the 4 coil pins (A-, A+, B+, B-).
 * Uses a full-step lookup table to detect direction of rotation and
 * accumulates the shaft angle (1.8° per step = 200 steps per revolution).
 */
PartSimulationRegistry.register('stepper-motor', {
  attachEvents: (element, simulator, getArduinoPinHelper) => {
    const pinManager = (simulator as any).pinManager;
    if (!pinManager) return () => {};

    const el = element as any;
    const STEP_ANGLE = 1.8; // degrees per step

    const pinAMinus = getArduinoPinHelper('A-');
    const pinAPlus = getArduinoPinHelper('A+');
    const pinBPlus = getArduinoPinHelper('B+');
    const pinBMinus = getArduinoPinHelper('B-');

    const coils = { aMinus: false, aPlus: false, bPlus: false, bMinus: false };
    let cumAngle = el.angle ?? 0;
    // Track the magnetic-field electrical angle instead of matching a fixed
    // coil table. The rotor follows the net field vector of the two coils, so
    // this works for ANY drive mode the firmware (or a driver) produces:
    // wave-drive (one coil), full-step two-phase (two coils), or half-step.
    let prevField = Number.NaN; // previous field angle in radians, NaN = unset

    function onCoilChange() {
      // Coil currents: +1 / 0 / -1 from the H-bridge terminal pair.
      const a = (coils.aPlus ? 1 : 0) - (coils.aMinus ? 1 : 0);
      const b = (coils.bPlus ? 1 : 0) - (coils.bMinus ? 1 : 0);
      if (a === 0 && b === 0) return; // no field → rotor holds position

      const field = Math.atan2(b, a); // electrical angle of the field vector
      if (Number.isNaN(prevField)) {
        prevField = field;
        return;
      }
      // Shortest signed rotation between the two field angles.
      let delta = field - prevField;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      prevField = field;

      // One quarter electrical turn (90°, π/2 rad) = one full mechanical step.
      cumAngle += (delta / (Math.PI / 2)) * STEP_ANGLE;
      el.angle = ((cumAngle % 360) + 360) % 360;
    }

    const unsubscribers: (() => void)[] = [];

    if (pinAMinus !== null) {
      unsubscribers.push(
        pinManager.onPinChange(pinAMinus, (_: number, s: boolean) => {
          coils.aMinus = s;
          onCoilChange();
        }),
      );
    }
    if (pinAPlus !== null) {
      unsubscribers.push(
        pinManager.onPinChange(pinAPlus, (_: number, s: boolean) => {
          coils.aPlus = s;
          onCoilChange();
        }),
      );
    }
    if (pinBPlus !== null) {
      unsubscribers.push(
        pinManager.onPinChange(pinBPlus, (_: number, s: boolean) => {
          coils.bPlus = s;
          onCoilChange();
        }),
      );
    }
    if (pinBMinus !== null) {
      unsubscribers.push(
        pinManager.onPinChange(pinBMinus, (_: number, s: boolean) => {
          coils.bMinus = s;
          onCoilChange();
        }),
      );
    }

    return () => unsubscribers.forEach((u) => u());
  },
});

// ─── WS2812B NeoPixel decode helper ──────────────────────────────────────────

/**
 * Decode WS2812B bit-stream from DIN pin changes for NeoPixel devices.
 */
/**
 * WS2812/NeoPixel bit-bang decoder, shared. Exported because a board is not
 * the only thing that carries an addressable LED: any part with one on board
 * (the reSpeaker Lite's RGB, driven by whatever host is wired to it) needs the
 * same decode, and re-implementing it per part is how two of them drift.
 */
export function createNeopixelDecoder(
  simulator: any,
  pinDIN: number,
  onPixel: (index: number, r: number, g: number, b: number) => void,
): () => void {
  const pinManager = simulator.pinManager;
  if (!pinManager) return () => {};

  // The line is decoded from how LONG the pad stays high, so this needs the
  // board's own clock. Every simulator answers getCurrentCycles()/getClockHz();
  // reading `simulator.cpu.cycles` instead only ever worked on the AVR, because
  // it is the only one that has a `cpu`. The RP2040 does bit-bang the line —
  // measured 241 edges and 5 completed frames for one two-colour sketch — but
  // every edge timestamped at cycle 0, so every high measured 0 cycles, every
  // bit decoded as 0, and the part painted #000000 on every frame. Reading
  // black off a real signal looks exactly like a part that does nothing.
  // Prefer NANOSECONDS. A cycle count is the wrong ruler for a signal a
  // PERIPHERAL emits: the RP2040/RP2350 PIO steps between CPU instructions off
  // its own divider, so several pixel edges land inside one cycle and read back
  // as simultaneous. Cycles remain the fallback for cores that bit-bang from
  // CPU code (the AVR), where they are exact.
  let unitHz = Number(simulator.getClockHz?.()) || 16_000_000;
  const readNanos = (): number => {
    const ns = simulator.getCurrentNanos?.();
    if (typeof ns === 'number' && ns >= 0) {
      unitHz = 1e9;
      return ns;
    }
    const c = simulator.getCurrentCycles?.();
    if (typeof c === 'number' && c >= 0) return c;
    const legacy = simulator.cpu?.cycles;
    return typeof legacy === 'number' ? legacy : -1;
  };
  const readCycles = readNanos;
  // A board with no cycle counter cannot be decoded from edges at all (the
  // ESP32 shim answers -1: its guest runs in an engine or in QEMU). Refuse
  // rather than decode garbage — those boards deliver whole frames instead,
  // through attachWs2812Part's hardware feed, and a decoder running on a
  // broken clock would paint black straight over them.
  if (readCycles() < 0) return () => {};

  // Classify each bit AGAINST ITS OWN BIT PERIOD, not against an absolute
  // width. A WS2812 '1' holds the line high for ~56% of the bit period and a
  // '0' for ~28%, and that RATIO is the one thing every engine reproduces: it
  // is 70/125 vs 35/125 on real silicon, 2/3 vs 1/3 under rp2040js (which does
  // not model PIO instruction delays, so its waveform is ~3x fast), and 7/10 vs
  // 2/10 under rp2350js. An absolute threshold is right for exactly one of
  // those three and silently reads 0x00 or 0xFF for the others.
  //
  // Seeded from the nominal 1.25 us bit period so the very first edge pair of a
  // run has something to compare against; every completed bit replaces it with
  // what this board actually produces.
  const perSecond = () => unitHz;
  let periodRef = Math.max(2, Math.round(perSecond() * 1.25e-6));
  // The only threshold that stays absolute, because it separates FRAMES rather
  // than bits: a WS2812 latches after >50 us low, which no bit period comes
  // near on any engine.
  const latchGap = () => Math.max(8 * periodRef, Math.round(perSecond() * 50e-6));

  let lastRisingCycle = 0;
  let lastFallingCycle = 0;
  let lastHigh = false;

  let bitBuf = 0;
  let bitsCollected = 0;
  let byteBuf: number[] = [];
  let pixelIndex = 0;

  let lastHighDur = 0;
  // The first bit after a latch is held until its low arrives, because only
  // then is this board's bit period known. Classifying it against the seeded
  // period got the top bit of every frame's first byte wrong on the RP2040
  // (0xFF read back 0x80 — a green pixel at half brightness). Only ever the
  // FIRST bit of a frame, so the last bit is never left pending and no pixel
  // is dropped at the end of a run.
  let pendingHigh = -1;

  /** Fold one decoded bit into the frame, emitting a pixel every 24. */
  const pushBit = (bit: number) => {
    bitBuf = (bitBuf << 1) | bit;
    bitsCollected++;
    if (bitsCollected < 8) return;
    byteBuf.push(bitBuf & 0xff);
    bitBuf = 0;
    bitsCollected = 0;
    if (byteBuf.length === 3) {
      const [g, r, b] = byteBuf;
      onPixel(pixelIndex++, r, g, b);
      byteBuf = [];
    }
  };

  const unsub = pinManager.onPinChange(pinDIN, (_: number, high: boolean) => {
    const now = readCycles();

    if (high) {
      const lowDur = now - lastFallingCycle;
      const isLatch = lowDur > latchGap();
      // Learn this board's real bit period from the bit that just finished —
      // its high plus the low that followed. A latch gap is not a bit, so it
      // never pollutes the reference.
      if (!isLatch && lowDur > 0) {
        if (pendingHigh >= 0) periodRef = pendingHigh + lowDur;
        else if (lastHighDur > 0) periodRef = lastHighDur + lowDur;
      }
      if (pendingHigh >= 0) {
        pushBit(pendingHigh * 2 > periodRef ? 1 : 0);
        pendingHigh = -1;
      }
      if (isLatch) {
        pixelIndex = 0;
        byteBuf = [];
        bitBuf = 0;
        bitsCollected = 0;
        // Next bit is the frame's first: hold it for its own period.
        lastHighDur = 0;
      }
      lastRisingCycle = now;
      lastHigh = true;
    } else {
      if (lastHigh) {
        const highDur = now - lastRisingCycle;
        // No measurable time between the edges means this board reports every
        // edge in a frame at the same instant. There is no signal to recover;
        // emitting anyway paints a confident wrong colour (solid black on the
        // RP boards for two releases). Stay silent and let the liveness
        // warning in attachWs2812Part tell the user something real.
        if (periodRef > 0 && (highDur > 0 || lastHighDur > 0)) {
          if (lastHighDur === 0) pendingHigh = highDur; // frame's first bit
          else pushBit(highDur * 2 > periodRef ? 1 : 0);
        }
        lastHighDur = highDur;
      }
      lastFallingCycle = now;
      lastHigh = false;
    }
  });

  return unsub;
}

/** How long a run may go without a single pixel frame before we say so. Long
 *  enough for a cold guest to boot and reach the first show(). */
const NO_PIXEL_GRACE_MS = 6000;

/**
 * Call `next` whenever the simulation re-arms (Run / Reset bump hexEpoch).
 *
 * Same subscription the burnout monitor uses. Imported lazily through the store
 * module the parts already depend on; in a unit test with no live store this
 * degrades to "never fires", which is what the tests want.
 */
function onRunEpoch(next: (epoch: number) => void): () => void {
  try {
    const store = useSimulatorStore as unknown as {
      subscribe?: (fn: (s: { hexEpoch?: number; running?: boolean }) => void) => () => void;
      getState?: () => { hexEpoch?: number; running?: boolean };
    };
    if (typeof store?.subscribe !== 'function') return () => {};
    const seed = store.getState?.();
    if (seed?.running) next(seed.hexEpoch ?? 0);
    return store.subscribe((st) => {
      if (st.running) next(st.hexEpoch ?? 0);
    });
  } catch (_) {
    return () => {};
  }
}

/**
 * Call `next` when the simulation goes from running to stopped.
 *
 * The mirror of `onRunEpoch`, and subscribed through the same store module, so
 * a unit test with no live store gets "never fires" rather than a throw. Only
 * the transition is reported: parts also live on a canvas that never runs
 * (boardless mode), and a level-triggered version would blank those on mount.
 */
function onPowerCut(next: () => void): () => void {
  try {
    const store = useSimulatorStore as unknown as {
      subscribe?: (fn: (s: { running?: boolean }) => void) => () => void;
      getState?: () => { running?: boolean };
    };
    if (typeof store?.subscribe !== 'function') return () => {};
    let wasRunning = !!store.getState?.().running;
    return store.subscribe((st) => {
      const isRunning = !!st.running;
      if (wasRunning && !isRunning) next();
      wasRunning = isRunning;
    });
  } catch (_) {
    return () => {};
  }
}

/**
 * Report, once, that a WS2812 part received nothing for a whole run.
 *
 * Goes to `velxio-circuit-fault`, the channel the dead-solve reporter and the
 * burnout monitor already use, so it lands in the Circuit check group of the
 * output console the user is already reading — rather than inventing a fourth
 * place to look.
 */
function reportNoPixelData(pinDIN: number): void {
  const message =
    `NeoPixel on DIN ${pinDIN}: no pixel data reached this part in the first ` +
    `${NO_PIXEL_GRACE_MS / 1000} s of the run. The usual cause is that this ` +
    `board's core drives WS2812 through a hardware peripheral (RMT on ESP32, ` +
    `PIO on RP2040) that this engine does not decode, and then changing the ` +
    `colour order, the supply pad or the data pin will not help. A board that ` +
    `is merely slow to boot looks the same at this point; if that is what ` +
    `happened, the line below corrects this one.`;
  try {
    window.dispatchEvent(
      new CustomEvent('velxio-circuit-fault', {
        // A heuristic, not a fault: the six-second grace can be wrong about a
        // slow board, and the line below may retract this one.
        detail: { kind: 'no-pixel-data', message, severity: 'warning' },
      }),
    );
  } catch (_) {
    // No DOM (unit tests) — the console line below is the whole report.
  }
  console.warn(`[ws2812] ${message}`);
}

/**
 * Correct a premature no-pixel-data report.
 *
 * The grace period cannot tell "this engine will never decode a pixel" from
 * "this guest has not booted yet": an ESP32-P4 takes over a minute to reach
 * its first show(), and the warning is already out by then. Rather than pick a
 * grace long enough for the slowest board — which would make the warning
 * useless on the fast ones it exists for — say so when the data does arrive.
 */
function reportPixelDataArrivedLate(pinDIN: number, msIntoRun: number): void {
  const message =
    `NeoPixel on DIN ${pinDIN}: pixel data did arrive, ${(msIntoRun / 1000).toFixed(1)} s ` +
    `into the run. This board is slow to boot, not undecodable — disregard the ` +
    `warning above.`;
  try {
    window.dispatchEvent(
      new CustomEvent('velxio-circuit-fault', {
        detail: { kind: 'pixel-data-late', message, severity: 'info' },
      }),
    );
  } catch (_) {
    // No DOM (unit tests) — the console line below is the whole report.
  }
  console.info(`[ws2812] ${message}`);
}

/**
 * Attach a WS2812 part to whichever of the two pixel sources its board has.
 *
 * A NeoPixel is driven one of two ways, and which one is a property of the
 * BOARD, not of the part:
 *
 *  - Bit-banged (AVR, and anything else whose core toggles the pad in a
 *    delay loop). The pixel colours only exist as edge timings on DIN, so
 *    `createNeopixelDecoder` recovers them by counting cycles between edges.
 *
 *  - Driven by a hardware peripheral (RMT on every ESP32; Adafruit_NeoPixel
 *    picks it automatically there). The pad never toggles at bit rate, the
 *    engine decodes the peripheral's stream itself, and the part has to be
 *    HANDED the frame. Boards whose simulator can do that expose
 *    `subscribeWs2812`.
 *
 * Both are attached: a board offers one or the other, never both at once, and
 * subscribing to the source that stays silent costs nothing. Attaching only
 * the decoder is what left the `neopixel` part black on every ESP32 — the
 * sketch ran, the engine had the colours, and nothing on the canvas was
 * listening for them.
 */
function attachWs2812Part(
  simulator: unknown,
  pinDIN: number,
  onPixel: (index: number, r: number, g: number, b: number) => void,
  componentId?: string,
): () => void {
  // A board that KNOWS it cannot carry a pixel stream says so, and that
  // refusal reaches the user through the Circuit check the verifier already
  // prints for a refused sensor. The Linux boards are the case: they carry
  // levels with no timestamps at roughly the rate a Python statement runs, so
  // a 1.25 us bit cell has nowhere to live. Without this the part attaches,
  // decodes nothing, feeds nothing and reports nothing — which reads to a user
  // exactly like their own wiring mistake.
  const declared = (simulator as {
    pixelSupport?: () => { mode: string; why?: string };
  }).pixelSupport?.();
  if (declared && declared.mode === 'none') {
    recordPartGap({
      sensorType: 'ws2812',
      pin: pinDIN,
      why: declared.why ?? 'this board cannot produce a WS2812 data stream',
      componentId,
    });
    return () => {
      if (componentId) releaseLineGap(componentId);
    };
  }
  let gotPixel = false;
  // Set when the no-pixel warning has gone out for this run, so the first
  // frame that turns up afterwards can correct it (see below).
  let warnedAt: number | null = null;
  // Highest pixel index this part has ever been given a colour for, so the
  // power cut below can blank exactly the pixels that are lit.
  let litUpTo = -1;
  const paint = (index: number, r: number, g: number, b: number) => {
    if (!gotPixel && warnedAt !== null) {
      reportPixelDataArrivedLate(pinDIN, Date.now() - warnedAt + NO_PIXEL_GRACE_MS);
      warnedAt = null;
    }
    gotPixel = true;
    if (index > litUpTo) litUpTo = index;
    onPixel(index, r, g, b);
  };

  // Stop is "cut power": a WS2812 holds its last frame in its own latch, and
  // both sources below are edge-triggered, so nothing tells the part the run
  // ended. The strip stayed lit on the canvas after Stop until the next Run
  // overwrote it. Blank it here, the same way stopBoard clears the pin states
  // that the non-addressable LEDs are drawn from.
  const unarmCut = onPowerCut(() => {
    for (let i = 0; i <= litUpTo; i++) onPixel(i, 0, 0, 0);
    litUpTo = -1;
  });

  const unsubDecoder = createNeopixelDecoder(simulator as any, pinDIN, paint);

  const hw = simulator as {
    subscribeWs2812?: (
      pin: number,
      sink: (pixels: Array<{ r: number; g: number; b: number }>) => void,
    ) => () => void;
  };
  const unsubHardware =
    hw.subscribeWs2812?.(pinDIN, (pixels) => {
      pixels.forEach((px, i) => paint(i, px.r, px.g, px.b));
    }) ?? (() => {});

  // Say something when NOTHING arrives.
  //
  // Both sources above fail silently by design: the decoder returns a no-op
  // when the board has no clock, and the hardware feed is an optional chain.
  // A part wired correctly to a board whose engine cannot produce its data
  // therefore sat black and said nothing — that silence is what cost a real
  // user two weeks, not the missing pixels.
  //
  // Deliberately a LIVENESS check and not a capability check. A capability
  // probe answers "yes" for three of the boards that are actually dark: the
  // ESP32 shim exposes subscribeWs2812 whatever engine is behind it, and the
  // RP2040 answers getCurrentCycles() even though its PIO produces no
  // decodable edges. Only observing that no frame arrived is honest.
  //
  // Armed off the store's run epoch, never off attach: parts attach at MOUNT
  // and re-attach on any rewire, so a timer started here would fire long
  // before the user pressed Run.
  let warned = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastEpoch: number | null = null;
  const armed = onRunEpoch((epoch) => {
    if (epoch === lastEpoch) return;
    lastEpoch = epoch;
    gotPixel = false;
    warnedAt = null;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (gotPixel || warned) return;
      warned = true;
      warnedAt = Date.now();
      reportNoPixelData(pinDIN);
    }, NO_PIXEL_GRACE_MS);
  });

  return () => {
    if (timer !== null) clearTimeout(timer);
    armed();
    unarmCut();
    unsubDecoder();
    unsubHardware();
  };
}

// ─── LED Ring (WS2812B NeoPixel ring) ────────────────────────────────────────

PartSimulationRegistry.register('led-ring', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const pinDIN = getArduinoPinHelper('DIN');
    if (pinDIN === null) return () => {};

    const el = element as any;

    const unsub = attachWs2812Part(simulator, pinDIN, (index, r, g, b) => {
      try {
        el.setPixel(index, { r, g, b });
      } catch (_) {
        // setPixel not yet available (element not upgraded) — ignore
      }
    }, componentId);

    return unsub;
  },
});

// ─── NeoPixel Matrix (WS2812B matrix grid) ────────────────────────────────────

PartSimulationRegistry.register('neopixel-matrix', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const pinDIN = getArduinoPinHelper('DIN');
    if (pinDIN === null) return () => {};

    const el = element as any;

    const unsub = attachWs2812Part(simulator, pinDIN, (index, r, g, b) => {
      const cols: number = el.cols ?? 8;
      const row = Math.floor(index / cols);
      const col = index % cols;
      try {
        el.setPixel(row, col, { r, g, b });
      } catch (_) {
        // ignore
      }
    }, componentId);

    return unsub;
  },
});

// ─── Single NeoPixel (WS2812B) ───────────────────────────────────────────────

/**
 * Single addressable RGB LED — decodes the WS2812B data stream on DIN.
 */
PartSimulationRegistry.register('neopixel', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const pinDIN = getArduinoPinHelper('DIN');
    if (pinDIN === null) return () => {};

    const el = element as any;

    const unsub = attachWs2812Part(simulator, pinDIN, (_index, r, g, b) => {
      el.r = r / 255;
      el.g = g / 255;
      el.b = b / 255;
    }, componentId);

    return unsub;
  },
});

// ─── PIR Motion Sensor ───────────────────────────────────────────────────────

/**
 * PIR motion sensor — click the element OR press "Simulate motion" in the
 * SensorControlPanel to trigger a 3-second HIGH pulse on OUT.
 */
PartSimulationRegistry.register('pir-motion-sensor', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const pin = getArduinoPinHelper('OUT');
    if (pin === null) return () => {};

    simulator.setPinState(pin, false); // idle LOW

    let timer: ReturnType<typeof setTimeout> | null = null;

    const triggerMotion = () => {
      if (timer !== null) clearTimeout(timer);
      simulator.setPinState(pin, true);
      console.log('[PIR] Motion detected → OUT HIGH');
      timer = setTimeout(() => {
        simulator.setPinState(pin, false);
        timer = null;
        console.log('[PIR] Motion ended → OUT LOW');
      }, 3000);
    };

    element.addEventListener('click', triggerMotion);

    registerSensorUpdate(componentId, (values) => {
      if (values.trigger === true) triggerMotion();
    });

    return () => {
      element.removeEventListener('click', triggerMotion);
      if (timer !== null) clearTimeout(timer);
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── KS2E-M-DC5 Relay ────────────────────────────────────────────────────────

/**
 * Dual-coil relay — listens for COIL1/COIL2 pin state changes.
 */
PartSimulationRegistry.register('ks2e-m-dc5', {
  onPinStateChange: (pinName, state, _element) => {
    if (pinName === 'COIL1' || pinName === 'COIL2') {
      console.log(`[Relay KS2E] ${pinName} → ${state ? 'ACTIVATED' : 'RELEASED'}`);
    }
  },
});

// ─── HC-SR04 Ultrasonic Distance Sensor ──────────────────────────────────────

/**
 * HC-SR04 — a line-owning sensor: a trigger on one wire, a timed ECHO pulse
 * back on another. The pulse (600 us overhead, then distance_cm / 17150 s) is
 * the MODEL in simulation/line/models/hc-sr04.ts, hosted by the board under
 * the line contract. This part binds the canvas element to it and forwards
 * the distance slider.
 */
PartSimulationRegistry.register('hc-sr04', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const trigPin = getArduinoPinHelper('TRIG');
    const echoPin = getArduinoPinHelper('ECHO');
    if (trigPin === null || echoPin === null) return () => {};

    const el = element as { distance?: string | number };
    const answer = requestLine(simulator, {
      sensor_type: 'hc-sr04',
      pin: trigPin,
      echo_pin: echoPin,
      distance: parseFloat(String(el.distance)) || 10,
    }, { componentId });

    registerSensorUpdate(componentId, (values) => {
      if ('distance' in values && answer.mode !== 'none') {
        answer.update({ distance: values.distance as number });
      }
    });

    return () => {
      if (answer.mode !== 'none') answer.release();
      // A refusal left a gap recorded; drop it so a rewire cannot keep
      // reporting a sensor the user has already moved.
      else releaseLineGap(componentId);
      unregisterSensorUpdate(componentId);
    };
  },
});

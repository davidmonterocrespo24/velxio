import { PartSimulationRegistry } from './PartSimulationRegistry';
import { useElectricalStore } from '../../store/useElectricalStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { emitPropertyChange, firstBoardPin } from './partUtils';
import { releaseLineGap, requestLine } from '../line/requestLine';

/**
 * Boards whose digital inputs are driven from the SPICE solve
 * (connectDigitalInputsToMcu) advertise `spiceDrivenInputs`. For those, the
 * input-control parts below (button / switch) must NOT push a pin level
 * directly — they only flip the component property (pressed / value), which
 * re-solves the circuit, and the connector decides the logic level from the
 * real wiring. Pushing a seed here would bypass the wiring and make a
 * mis-wired button read "correct" instead of like hardware.
 */
function spiceDriven(sim: unknown): boolean {
  return !!(sim as { spiceDrivenInputs?: boolean } | null)?.spiceDrivenInputs;
}

/**
 * Basic Pushbutton implementation (full-size)
 */
PartSimulationRegistry.register('pushbutton', {
  attachEvents: (element, avrSimulator, getArduinoPinHelper, componentId) => {
    // Whichever leg reaches a real pin: the other one is on GND or a rail,
    // and a rail is -1, not null (see firstBoardPin).
    const arduinoPin = firstBoardPin(getArduinoPinHelper, ['1.l', '2.l', '1.r', '2.r']);

    // Seed the input pin HIGH so `digitalRead()` returns HIGH while the
    // button is idle.  avr8js does not auto-simulate INPUT_PULLUP — without
    // this, the firmware reads LOW from the moment loop() starts and
    // believes the button is permanently pressed (the classic "LED is
    // always on, pressing the button does nothing" UX bug).
    if (arduinoPin !== null && !spiceDriven(avrSimulator)) avrSimulator.setPinState(arduinoPin, true);

    const onButtonPress = () => {
      if (arduinoPin !== null && !spiceDriven(avrSimulator)) avrSimulator.setPinState(arduinoPin, false); // Active LOW
      (element as any).pressed = true;
      emitPropertyChange(componentId, 'pressed', true);
    };
    const onButtonRelease = () => {
      if (arduinoPin !== null && !spiceDriven(avrSimulator)) avrSimulator.setPinState(arduinoPin, true);
      (element as any).pressed = false;
      emitPropertyChange(componentId, 'pressed', false);
    };

    element.addEventListener('button-press', onButtonPress);
    element.addEventListener('button-release', onButtonRelease);
    return () => {
      element.removeEventListener('button-press', onButtonPress);
      element.removeEventListener('button-release', onButtonRelease);
    };
  },
});

/**
 * 6mm Pushbutton — same behaviour as the full-size pushbutton
 */
PartSimulationRegistry.register('pushbutton-6mm', {
  attachEvents: (element, avrSimulator, getArduinoPinHelper, componentId) => {
    // Whichever leg reaches a real pin: the other one is on GND or a rail,
    // and a rail is -1, not null (see firstBoardPin).
    const arduinoPin = firstBoardPin(getArduinoPinHelper, ['1.l', '2.l', '1.r', '2.r']);

    // Same INPUT_PULLUP seeding as the full-size pushbutton — see comment
    // in `register('pushbutton', ...)` above for why this is required.
    if (arduinoPin !== null && !spiceDriven(avrSimulator)) avrSimulator.setPinState(arduinoPin, true);

    const onPress = () => {
      if (arduinoPin !== null && !spiceDriven(avrSimulator)) avrSimulator.setPinState(arduinoPin, false);
      (element as any).pressed = true;
      emitPropertyChange(componentId, 'pressed', true);
    };
    const onRelease = () => {
      if (arduinoPin !== null && !spiceDriven(avrSimulator)) avrSimulator.setPinState(arduinoPin, true);
      (element as any).pressed = false;
      emitPropertyChange(componentId, 'pressed', false);
    };

    element.addEventListener('button-press', onPress);
    element.addEventListener('button-release', onRelease);
    return () => {
      element.removeEventListener('button-press', onPress);
      element.removeEventListener('button-release', onRelease);
    };
  },
});

/**
 * Slide Switch — toggles between HIGH and LOW on each click
 */
PartSimulationRegistry.register('slide-switch', {
  attachEvents: (element, avrSimulator, getArduinoPinHelper, componentId) => {
    // Slide switch has pins: 1, 2, 3 — middle pin (2) is the common output
    const arduinoPin = firstBoardPin(getArduinoPinHelper, ['2', '1']);

    // Read initial value from element (0 or 1)
    const raw = (element as any).value;
    let state = raw === 1 || raw === '1';
    if (arduinoPin !== null && !spiceDriven(avrSimulator)) avrSimulator.setPinState(arduinoPin, state);
    emitPropertyChange(componentId, 'value', state ? 1 : 0);

    const onChange = () => {
      const v = (element as any).value;
      state = v === 1 || v === '1';
      if (arduinoPin !== null && !spiceDriven(avrSimulator)) avrSimulator.setPinState(arduinoPin, state);
      emitPropertyChange(componentId, 'value', state ? 1 : 0);
    };

    element.addEventListener('change', onChange);
    // The slide-switch element fires a 'change' event when clicked
    element.addEventListener('input', onChange);
    return () => {
      element.removeEventListener('change', onChange);
      element.removeEventListener('input', onChange);
    };
  },
});

/**
 * DIP Switch 8 — 8 independent toggle switches
 * Pin layout: 1A-8A on one side, 1B-8B on the other
 */
PartSimulationRegistry.register('dip-switch-8', {
  attachEvents: (element, avrSimulator, getArduinoPinHelper) => {
    // Each switch i has pins (i+1)A and (i+1)B; we use the A side as output
    const pins: (number | null)[] = [];
    for (let i = 1; i <= 8; i++) {
      pins.push(getArduinoPinHelper(`${i}A`) ?? getArduinoPinHelper(`${i}a`));
    }

    // Sync initial states
    const values: number[] = (element as any).values || new Array(8).fill(0);
    pins.forEach((pin, i) => {
      if (pin !== null) avrSimulator.setPinState(pin, values[i] === 1);
    });

    const onChange = () => {
      const newValues: number[] = (element as any).values || new Array(8).fill(0);
      pins.forEach((pin, i) => {
        if (pin !== null) {
          const state = newValues[i] === 1;
          avrSimulator.setPinState(pin, state);
        }
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

/**
 * Basic LED implementation.
 *
 * An LED lights up only when current can flow: anode HIGH **and** cathode
 * connected to GND (or a LOW GPIO).  If the cathode is not wired at all the
 * LED stays off regardless of the anode state.
 */

// A real 5mm indicator LED survives ~20 mA (datasheet absolute max ~30 mA).
// A sustained forward current well above that destroys it within moments —
// the classic "LED straight across a 9V battery with no series resistor"
// mistake. A professional simulator must model that, not glow happily. Once
// the solved forward current crosses LED_BURNOUT_A the LED burns out (goes
// dark and stays dark for the rest of the run) and a fault message is shown.
//
// The burnout threshold (100 mA) sits well above both the 20 mA rating AND the
// ~100-150 mA a high-power / RGB channel may legitimately draw, so a merely
// bright LED is never falsely destroyed — only a missing or grossly-undersized
// series resistor trips it. The pre-flight circuitVerifier already warns at the
// 20 mA datasheet limit BEFORE the run starts (the primary, professional
// check); this runtime burnout is the last-resort net for users who click
// "Run Anyway" past that warning, or for faults that only appear mid-run.
const LED_RATED_MAX_A = 0.02;
const LED_BURNOUT_A = 0.1;

/** Surface a circuit fault for an LED — console + a UI event the toolbar shows. */
function reportLedFault(componentId: string, kind: string, message: string): void {
  console.warn(`[led] ${componentId}: ${message}`);
  // Mark it destroyed in the shared burnt set (P4): the canvas renders it
  // charred + a smoke badge, and the solver opens it — same treatment as a
  // burnt resistor/capacitor. (The LED also goes dark via its own update.)
  try {
    useSimulatorStore.getState().markComponentBurnt?.(componentId);
  } catch {
    /* store unavailable (test env) — ignore */
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(
        new CustomEvent('velxio-circuit-fault', {
          detail: { componentId, kind, message },
        }),
      );
    } catch {
      /* CustomEvent unavailable (test env) — the console.warn is enough */
    }
  }
}

function reportLedBurnout(componentId: string, current: number): void {
  const mA = current * 1000;
  const amount = mA >= 1000 ? `${(mA / 1000).toFixed(1)} A` : `${mA.toFixed(0)} mA`;
  reportLedFault(
    componentId,
    'led-burnout',
    `LED burnt out — it drew ${amount}, far above its ~20 mA limit. ` +
      `Add a series resistor between the supply and the LED.`,
  );
}

PartSimulationRegistry.register('led', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId, getPinResolver) => {
    const pinManager = (simulator as any).pinManager;
    if (!pinManager) return () => {};

    const el = element as any;
    const unsubs: (() => void)[] = [];
    let anodeHigh = false;
    let cathodeLow = false;

    // Phase 0 of the mixed-mode simulator project — see
    // ../../../project/sim-mixedmode/phase-00-pin-resolver.md in the
    // velxio-prod repo. PinResolver replaces the direct
    // pinManager.onPinChange + getArduinoPinHelper pattern. For the
    // Phase-0 default impl it's functionally identical; Phase 1+ will
    // swap in a SPICE-resolved impl that watches node voltages and
    // threshold-converts to logic states. Falls back to the legacy
    // path when getPinResolver isn't available (e.g. test harnesses
    // that mock attachEvents with the old 4-arg signature).
    const useResolver = typeof getPinResolver === 'function';
    // Last known SPICE brightness + timestamp. When a solve hasn't
    // landed yet (engine warm-up, between-solve gap, ngspice iteration
    // holes), we hold this value for 500 ms before decaying to zero —
    // prevents visible flicker while still dying visibly if the solver
    // dies for good (useful diagnostic).
    let lastSpiceBrightness = 0;
    let lastSpiceTs = 0;
    // Latches once the LED is destroyed by overcurrent; reset only when the
    // part re-attaches (a fresh Run / reset re-arms it).
    let burnt = false;
    const HOLD_MS = 500;

    const update = () => {
      // A burnt-out LED stays dark for the rest of the run, no matter what
      // the solver reports next.
      if (burnt) {
        el.value = false;
        el.brightness = 0;
        return;
      }
      // SPICE is always active. Use real branch current for analog
      // brightness (0..1). The SPICE mapper emits a V-sense zero-volt
      // source in series with the diode (`V_<componentId>_sense`) so
      // ngspice exposes the branch current as
      // `i(v_<componentId>_sense)` → stored under the
      // `v_<componentId>_sense` key in `branchCurrents`.
      //
      // For `.tran` circuits the scalar current is the last sample
      // (≈ steady state). If a full waveform is available we instead
      // compute the period-averaged |I|, which is what a real observer
      // sees — a 50 Hz rectified LED does not flicker to the eye, it
      // glows at ~Ipeak/π of its peak brightness.
      //
      // Digital fallback (anodeHigh && cathodeLow) is only used if
      // the electrical store can't be loaded at all — e.g. in a
      // Node-side test harness that stubs it out.
      const { branchCurrents, timeWaveforms, window } = useElectricalStore.getState();
      const iKey = `v_${componentId}_sense`;
      let raw = branchCurrents[iKey];
      if (timeWaveforms) {
        const samples = timeWaveforms.branches.get(iKey);
        if (samples && samples.length > 0) {
          let sum = 0;
          for (const s of samples) sum += Math.abs(s);
          raw = sum / samples.length;
        }
      }
      // A publish window is the circuit over the last few tens of
      // milliseconds as the pad states it went through, each with its
      // share. The eye integrates light over about that long, so the LED
      // shows the time-weighted brightness of those states: a 50 ms pulse
      // is on for 50 ms, a software PWM glows at its duty, a scanned LED
      // bar lights every LED for exactly as long as its pin was high
      // (before this, only the state the solver happened to land on was
      // ever shown, and a pulse shorter than a solve plus a gap was lost).
      // The burnout check uses the highest current of the window: a short
      // overcurrent is still an overcurrent.
      let windowBrightness: number | undefined;
      let windowPeak: number | undefined;
      if (!timeWaveforms && window && window.states.length > 1) {
        let seen = false;
        let mean = 0;
        let peak = 0;
        for (const st of window.states) {
          const i = st.branchCurrents[iKey];
          if (i === undefined) continue;
          if (!Number.isFinite(i)) {
            peak = i;
            seen = true;
            break;
          }
          seen = true;
          const a = Math.abs(i);
          if (a > peak) peak = a;
          mean += st.weight * Math.min(1, a / LED_RATED_MAX_A);
        }
        if (seen) {
          windowBrightness = mean;
          windowPeak = peak;
          raw = peak;
        }
      }
      // A non-finite branch current (NaN / Infinity) that ngspice actually
      // returned is NOT "no data" — it means the solver could not find a
      // stable operating point for this LED. In practice that is the textbook
      // degenerate circuit: a forward-biased diode with no series resistor (a
      // near-short across the supply). Burn the LED out rather than silently
      // glowing via the digital fallback (the old behaviour, which let the
      // "missing 220Ω" mistake light up as if it were fine). `raw === undefined`
      // is different — that is the engine warming up, handled by the HOLD /
      // digital-fallback path below.
      if (raw !== undefined && !Number.isFinite(raw)) {
        burnt = true;
        el.value = false;
        el.brightness = 0;
        reportLedFault(
          componentId,
          'led-burnout',
          `LED destroyed — the circuit has no stable solution (the solver returned ` +
            `an undefined current). This almost always means the LED has no series ` +
            `resistor. Add a resistor between the supply and the LED.`,
        );
        return;
      }
      if (raw !== undefined && Number.isFinite(raw)) {
        const current = Math.abs(raw);
        // Destructive overcurrent → burn the LED out (and tell the user why).
        // Latches; the top-of-update guard keeps it dark from here on.
        if (current > LED_BURNOUT_A) {
          burnt = true;
          el.value = false;
          el.brightness = 0;
          reportLedBurnout(componentId, current);
          return;
        }
        lastSpiceBrightness =
          windowBrightness !== undefined && windowPeak !== undefined
            ? windowBrightness
            : Math.min(1, current / LED_RATED_MAX_A);
        lastSpiceTs = Date.now();
        el.value = windowBrightness !== undefined ? windowBrightness > 1e-3 : current > 1e-6;
        el.brightness = lastSpiceBrightness;
        return;
      }
      if (Date.now() - lastSpiceTs < HOLD_MS && lastSpiceTs > 0 && Number.isFinite(lastSpiceBrightness)) {
        el.value = lastSpiceBrightness > 1e-3;
        el.brightness = lastSpiceBrightness;
        return;
      }
      // No SPICE data yet — fall back to digital pin state so the LED
      // still reacts the moment the user wires it to a GPIO, before
      // the first solve lands.
      lastSpiceBrightness = 0;
      el.value = anodeHigh && cathodeLow;
      el.brightness = el.value ? 1 : 0;
    };

    // Cathode + anode pin subscriptions. PinResolver path is preferred
    // (gets SPICE-aware behavior for free in later phases); legacy
    // direct-pinManager path is kept for builds without Phase 0.
    if (useResolver) {
      const cathodeResolver = getPinResolver!('C');
      const anodeResolver = getPinResolver!('A');
      if (cathodeResolver) {
        // Seed initial state. -1 (wired to GND) becomes 'LOW' via the
        // resolver's GND special case, which sets cathodeLow = true.
        cathodeLow = cathodeResolver.getCurrentState() === 'LOW';
        unsubs.push(
          cathodeResolver.onChange((state) => {
            cathodeLow = state === 'LOW';
            update();
          }),
        );
      }
      if (anodeResolver) {
        anodeHigh = anodeResolver.getCurrentState() === 'HIGH';
        unsubs.push(
          anodeResolver.onChange((state) => {
            anodeHigh = state === 'HIGH';
            update();
          }),
        );
      }
    } else {
      const cathodePin = getArduinoPinHelper('C');
      if (cathodePin === -1) {
        cathodeLow = true;
      } else if (cathodePin !== null && cathodePin >= 0) {
        unsubs.push(
          pinManager.onPinChange(cathodePin, (_: number, state: boolean) => {
            cathodeLow = !state;
            update();
          }),
        );
      }

      const anodePin = getArduinoPinHelper('A');
      if (anodePin !== null && anodePin >= 0) {
        unsubs.push(
          pinManager.onPinChange(anodePin, (_: number, state: boolean) => {
            anodeHigh = state;
            update();
          }),
        );
      }
    }

    // Also subscribe to electrical store changes to update brightness
    // whenever the SPICE solver delivers a new result.
    const unsubElectrical = useElectricalStore.subscribe((state, prev) => {
      if (
        state.branchCurrents !== prev.branchCurrents ||
        state.timeWaveforms !== prev.timeWaveforms ||
        state.window !== prev.window
      )
        update();
    });
    unsubs.push(unsubElectrical);

    // Initial paint — SPICE may already have a solved current for this LED
    // (e.g. when the component is added to an already-solved circuit).
    update();

    return () => {
      unsubs.forEach((u) => u());
    };
  },
});

/**
 * LED Bar Graph — 10 LEDs, each driven by one pin
 * Wokwi pin names: A1-A10
 */
PartSimulationRegistry.register('led-bar-graph', {
  attachEvents: (element, avrSimulator, getArduinoPinHelper, _componentId, getPinResolver) => {
    const pinManager = (avrSimulator as any).pinManager;
    if (!pinManager) return () => {};

    // Phase 5 migration: prefer the resolver so each anode pin works
    // through SPICE-resolved thresholds when fed from an active device.
    const useResolver = typeof getPinResolver === 'function';

    const values = new Array(10).fill(0);
    const unsubscribers: (() => void)[] = [];

    for (let i = 1; i <= 10; i++) {
      const idx = i - 1;
      const pinName = `A${i}`;
      if (useResolver) {
        const resolver = getPinResolver!(pinName);
        if (!resolver) continue;
        values[idx] = resolver.getCurrentState() === 'HIGH' ? 1 : 0;
        unsubscribers.push(
          resolver.onChange((state) => {
            values[idx] = state === 'HIGH' ? 1 : 0;
            (element as any).values = [...values];
          }),
        );
      } else {
        const pin = getArduinoPinHelper(pinName);
        if (pin === null) continue;
        unsubscribers.push(
          pinManager.onPinChange(pin, (_p: number, state: boolean) => {
            values[idx] = state ? 1 : 0;
            (element as any).values = [...values];
          }),
        );
      }
    }
    (element as any).values = [...values];

    return () => unsubscribers.forEach((u) => u());
  },
});

// NOTE: '7segment' is registered in ChipParts.ts which supports both direct-drive
// and 74HC595-driven modes. Do not re-register it here.

// ─── KY-040 Rotary Encoder ───────────────────────────────────────────────────

/**
 * KY-040 rotary encoder — maps element events to Arduino CLK/DT/SW pins.
 *
 * The element emits:
 *   - 'rotate-cw'      → clockwise step
 *   - 'rotate-ccw'     → counter-clockwise step
 *   - 'button-press'   → push-button pressed
 *   - 'button-release' → push-button released
 *
 * Most Arduino encoder libraries sample CLK and read DT on a CLK rising edge:
 *   DT LOW  on CLK rising  → clockwise
 *   DT HIGH on CLK rising  → counter-clockwise
 *
 * The SW pin is active LOW (HIGH when not pressed).
 */
PartSimulationRegistry.register('ky-040', {
  attachEvents: (element, simulator, getArduinoPinHelper) => {
    const pinCLK = getArduinoPinHelper('CLK');
    const pinDT = getArduinoPinHelper('DT');
    const pinSW = getArduinoPinHelper('SW');

    // SW starts HIGH (not pressed, active LOW)
    if (pinSW !== null) simulator.setPinState(pinSW, true);
    // CLK and DT start HIGH (idle)
    if (pinCLK !== null) simulator.setPinState(pinCLK, true);
    if (pinDT !== null) simulator.setPinState(pinDT, true);

    /** Emit one encoder pulse: set DT to dtLevel, pulse CLK HIGH→LOW. */
    function emitPulse(dtLevel: boolean) {
      if (pinDT !== null) simulator.setPinState(pinDT, dtLevel);
      if (pinCLK !== null) {
        simulator.setPinState(pinCLK, false); // CLK LOW first
        // Small delay then CLK rising edge (encoder sampled on rising edge)
        setTimeout(() => {
          if (pinCLK !== null) simulator.setPinState(pinCLK, true);
          setTimeout(() => {
            if (pinCLK !== null) simulator.setPinState(pinCLK, false);
            if (pinDT !== null) simulator.setPinState(pinDT, true); // restore DT
          }, 1);
        }, 1);
      }
    }

    const onCW = () => emitPulse(false); // DT LOW  = CW
    const onCCW = () => emitPulse(true); // DT HIGH = CCW
    const onPress = () => {
      if (pinSW !== null) simulator.setPinState(pinSW, false);
    };
    const onRelease = () => {
      if (pinSW !== null) simulator.setPinState(pinSW, true);
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

// ─── Biaxial Stepper Motor ────────────────────────────────────────────────────

/**
 * Biaxial stepper motor — monitors 8 coil pins for two independent motors.
 *
 * Motor 1 pins: A1-, A1+, B1+, B1-  →  outerHandAngle
 * Motor 2 pins: A2-, A2+, B2+, B2-  →  innerHandAngle
 *
 * Full-step decode: each motor uses the same 4-step lookup table as
 * the single stepper-motor. 1.8° per step.
 */
PartSimulationRegistry.register('biaxial-stepper', {
  attachEvents: (element, simulator, getArduinoPinHelper) => {
    const pinManager = (simulator as any).pinManager;
    if (!pinManager) return () => {};

    const el = element as any;
    const STEP_ANGLE = 1.8;

    function makeMotorTracker(
      pinAminus: number | null,
      pinAplus: number | null,
      pinBplus: number | null,
      pinBminus: number | null,
      setAngle: (deg: number) => void,
    ) {
      let aMinus = false,
        aPlus = false,
        bPlus = false,
        bMinus = false;
      let cumAngle = 0;
      let prevField = Number.NaN;
      const unsubs: (() => void)[] = [];

      // Rotor follows the net magnetic-field vector of the two coils — works
      // for wave, two-phase full-step and half-step drive alike.
      function onCoilChange() {
        const a = (aPlus ? 1 : 0) - (aMinus ? 1 : 0);
        const b = (bPlus ? 1 : 0) - (bMinus ? 1 : 0);
        if (a === 0 && b === 0) return;
        const field = Math.atan2(b, a);
        if (Number.isNaN(prevField)) {
          prevField = field;
          return;
        }
        let delta = field - prevField;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        prevField = field;
        cumAngle += (delta / (Math.PI / 2)) * STEP_ANGLE;
        setAngle(((cumAngle % 360) + 360) % 360);
      }

      if (pinAminus !== null)
        unsubs.push(
          pinManager.onPinChange(pinAminus, (_: number, s: boolean) => {
            aMinus = s;
            onCoilChange();
          }),
        );
      if (pinAplus !== null)
        unsubs.push(
          pinManager.onPinChange(pinAplus, (_: number, s: boolean) => {
            aPlus = s;
            onCoilChange();
          }),
        );
      if (pinBplus !== null)
        unsubs.push(
          pinManager.onPinChange(pinBplus, (_: number, s: boolean) => {
            bPlus = s;
            onCoilChange();
          }),
        );
      if (pinBminus !== null)
        unsubs.push(
          pinManager.onPinChange(pinBminus, (_: number, s: boolean) => {
            bMinus = s;
            onCoilChange();
          }),
        );

      return () => unsubs.forEach((u) => u());
    }

    const cleanup1 = makeMotorTracker(
      getArduinoPinHelper('A1-'),
      getArduinoPinHelper('A1+'),
      getArduinoPinHelper('B1+'),
      getArduinoPinHelper('B1-'),
      (deg) => {
        el.outerHandAngle = deg;
      },
    );
    const cleanup2 = makeMotorTracker(
      getArduinoPinHelper('A2-'),
      getArduinoPinHelper('A2+'),
      getArduinoPinHelper('B2+'),
      getArduinoPinHelper('B2-'),
      (deg) => {
        el.innerHandAngle = deg;
      },
    );

    return () => {
      cleanup1();
      cleanup2();
    };
  },
});

// ─── Membrane Keypad ─────────────────────────────────────────────────────────

/**
 * 4×4 membrane keypad — a line-owning part. The matrix itself (which wires a
 * held key shorts together, and what each wire then reads) is the MODEL in
 * simulation/line/models/matrix-keypad.ts, hosted by whichever board the
 * keypad is wired to: in the browser on AVR and RP2040, in the QEMU worker or
 * the in-browser engine on an ESP32. It runs there, inside the guest's own pad
 * events, because a scan reads one wire a few instructions after driving
 * another and nothing outside the emulator can answer that fast.
 *
 * The model does not care which side the sketch scans. The Keypad library
 * drives the COLUMNS and reads the rows; plenty of hand-written sketches do
 * the reverse. The part used to model only the second, so the library never
 * saw a key (issue #327).
 *
 * This part only says where the wires land and which keys are held.
 */
const KEYPAD_ROW_PINS = ['R1', 'R2', 'R3', 'R4'];
const KEYPAD_COL_PINS = ['C1', 'C2', 'C3', 'C4'];

PartSimulationRegistry.register('membrane-keypad', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const rows = KEYPAD_ROW_PINS.map((name) => getArduinoPinHelper(name) ?? -1);
    const cols = KEYPAD_COL_PINS.map((name) => getArduinoPinHelper(name) ?? -1);
    const anchor = [...rows, ...cols].find((pin) => pin >= 0);
    if (anchor === undefined) return () => {};

    const answer = requestLine(
      simulator,
      { sensor_type: 'matrix-keypad', pin: anchor, rows, cols, pressed: [] },
      { componentId },
    );

    const heldKeysMap = new Map<string, [number, number]>();
    const publish = () => {
      if (answer.mode !== 'none') answer.update({ pressed: [...heldKeysMap.values()] });
    };
    const onPress = (e: Event) => {
      const { row, column } = (e as CustomEvent).detail;
      heldKeysMap.set(`${row},${column}`, [row, column]);
      publish();
    };
    const onRelease = (e: Event) => {
      const { row, column } = (e as CustomEvent).detail;
      heldKeysMap.delete(`${row},${column}`);
      publish();
    };

    element.addEventListener('button-press', onPress);
    element.addEventListener('button-release', onRelease);
    return () => {
      element.removeEventListener('button-press', onPress);
      element.removeEventListener('button-release', onRelease);
      if (answer.mode !== 'none') answer.release();
      // A refusal left a gap recorded; drop it so a rewire cannot keep
      // reporting a keypad the user has already moved.
      else releaseLineGap(componentId);
    };
  },
});

// ─── Rotary Dialer ───────────────────────────────────────────────────────────

/**
 * Rotary phone dialer — fires PULSE/DIAL pin signals matching vintage
 * PSTN rotary-dial behaviour:
 *   DIAL goes LOW while the dial is rotating and HIGH when done.
 *   PULSE fires n pulses (digit 0 → 10 pulses) at ~100 ms intervals.
 */
PartSimulationRegistry.register('rotary-dialer', {
  attachEvents: (element, simulator, getArduinoPinHelper) => {
    const dialPin = getArduinoPinHelper('DIAL');
    const pulsePin = getArduinoPinHelper('PULSE');
    if (dialPin === null || pulsePin === null) return () => {};

    // Idle: both HIGH (active LOW signalling)
    simulator.setPinState(dialPin, true);
    simulator.setPinState(pulsePin, true);

    const onDialStart = () => {
      simulator.setPinState(dialPin, false); // LOW = dialing in progress
    };

    const onDialEnd = (e: Event) => {
      const digit = (e as CustomEvent).detail.digit as number;
      const pulseCount = digit === 0 ? 10 : digit;
      let i = 0;
      const firePulse = () => {
        if (i < pulseCount) {
          simulator.setPinState(pulsePin, false); // PULSE LOW
          setTimeout(() => {
            simulator.setPinState(pulsePin, true); // PULSE HIGH
            i++;
            setTimeout(firePulse, 60);
          }, 60);
        } else {
          simulator.setPinState(dialPin, true); // DIAL HIGH = done
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

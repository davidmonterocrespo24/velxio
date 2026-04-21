import { PartSimulationRegistry } from './PartSimulationRegistry';
import { useElectricalStore } from '../../store/useElectricalStore';
import { emitPropertyChange } from './partUtils';

/**
 * Basic Pushbutton implementation (full-size)
 */
PartSimulationRegistry.register('pushbutton', {
  attachEvents: (element, avrSimulator, getArduinoPinHelper, componentId) => {
    const arduinoPin =
      getArduinoPinHelper('1.l') ??
      getArduinoPinHelper('2.l') ??
      getArduinoPinHelper('1.r') ??
      getArduinoPinHelper('2.r');

    const onButtonPress = () => {
      if (arduinoPin !== null) avrSimulator.setPinState(arduinoPin, false); // Active LOW
      (element as any).pressed = true;
      emitPropertyChange(componentId, 'pressed', true);
    };
    const onButtonRelease = () => {
      if (arduinoPin !== null) avrSimulator.setPinState(arduinoPin, true);
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
    const arduinoPin =
      getArduinoPinHelper('1.l') ??
      getArduinoPinHelper('2.l') ??
      getArduinoPinHelper('1.r') ??
      getArduinoPinHelper('2.r');

    const onPress = () => {
      if (arduinoPin !== null) avrSimulator.setPinState(arduinoPin, false);
      (element as any).pressed = true;
      emitPropertyChange(componentId, 'pressed', true);
    };
    const onRelease = () => {
      if (arduinoPin !== null) avrSimulator.setPinState(arduinoPin, true);
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
    const arduinoPin = getArduinoPinHelper('2') ?? getArduinoPinHelper('1');

    // Read initial value from element (0 or 1)
    const raw = (element as any).value;
    let state = raw === 1 || raw === '1';
    if (arduinoPin !== null) avrSimulator.setPinState(arduinoPin, state);
    emitPropertyChange(componentId, 'value', state ? 1 : 0);

    const onChange = () => {
      const v = (element as any).value;
      state = v === 1 || v === '1';
      if (arduinoPin !== null) avrSimulator.setPinState(arduinoPin, state);
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
PartSimulationRegistry.register('led', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const pinManager = (simulator as any).pinManager;
    if (!pinManager) return () => {};

    const el = element as any;
    const unsubs: (() => void)[] = [];
    let anodeHigh = false;
    let cathodeLow = false;
    // Last known SPICE brightness + timestamp. When a solve hasn't
    // landed yet (engine warm-up, between-solve gap, ngspice iteration
    // holes), we hold this value for 500 ms before decaying to zero —
    // prevents visible flicker while still dying visibly if the solver
    // dies for good (useful diagnostic).
    let lastSpiceBrightness = 0;
    let lastSpiceTs = 0;
    const HOLD_MS = 500;

    const update = () => {
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
      const { branchCurrents, timeWaveforms } = useElectricalStore.getState();
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
      // No SPICE data yet — fall back to digital pin state so the LED
      // still reacts the moment the user wires it to a GPIO, before
      // the first solve lands.
      lastSpiceBrightness = 0;
      el.value = anodeHigh && cathodeLow;
      el.brightness = el.value ? 1 : 0;
    };

    // Cathode pin: -1 means wired to GND (always LOW), >=0 means GPIO
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

    // Also subscribe to electrical store changes to update brightness
    // whenever the SPICE solver delivers a new result.
    const unsubElectrical = useElectricalStore.subscribe((state, prev) => {
      if (
        state.branchCurrents !== prev.branchCurrents ||
        state.timeWaveforms !== prev.timeWaveforms
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
  attachEvents: (element, avrSimulator, getArduinoPinHelper) => {
    const pinManager = (avrSimulator as any).pinManager;
    if (!pinManager) return () => {};

    const values = new Array(10).fill(0);
    const unsubscribers: (() => void)[] = [];

    for (let i = 1; i <= 10; i++) {
      const pin = getArduinoPinHelper(`A${i}`);
      if (pin !== null) {
        const idx = i - 1;
        unsubscribers.push(
          pinManager.onPinChange(pin, (_p: number, state: boolean) => {
            values[idx] = state ? 1 : 0;
            (element as any).values = [...values];
          }),
        );
      }
    }

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

    // Full-step table: [A+, B+, A-, B-]
    const stepTable: [boolean, boolean, boolean, boolean][] = [
      [true, false, false, false],
      [false, true, false, false],
      [false, false, true, false],
      [false, false, false, true],
    ];

    function stepIndexFromCoils(ap: boolean, bp: boolean, am: boolean, bm: boolean): number {
      for (let i = 0; i < stepTable.length; i++) {
        const [tap, tbp, tam, tbm] = stepTable[i];
        if (ap === tap && bp === tbp && am === tam && bm === tbm) return i;
      }
      return -1;
    }

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
      let prevIdx = -1;
      const unsubs: (() => void)[] = [];

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
 * 4×4 membrane keypad — simulates the row/column matrix scanning.
 * When the Arduino drives a ROW pin LOW and a key in that row is pressed,
 * the corresponding COL pin is pulled LOW (shorted through the membrane).
 */
PartSimulationRegistry.register('membrane-keypad', {
  attachEvents: (element, simulator, getArduinoPinHelper) => {
    const rowPins: (number | null)[] = [
      getArduinoPinHelper('R1'),
      getArduinoPinHelper('R2'),
      getArduinoPinHelper('R3'),
      getArduinoPinHelper('R4'),
    ];
    const colPins: (number | null)[] = [
      getArduinoPinHelper('C1'),
      getArduinoPinHelper('C2'),
      getArduinoPinHelper('C3'),
      getArduinoPinHelper('C4'),
    ];

    const pressedKeys = new Set<string>(); // 'row,col'
    const activeRows = new Set<number>(); // row indices currently driven LOW
    const cleanups: (() => void)[] = [];

    const updateCol = (col: number) => {
      const cPin = colPins[col];
      if (cPin === null) return;
      const colLow = [...activeRows].some((r) => pressedKeys.has(`${r},${col}`));
      simulator.setPinState(cPin, !colLow);
    };

    for (let r = 0; r < 4; r++) {
      const rPin = rowPins[r];
      if (rPin === null) continue;
      const row = r;
      const c = simulator.pinManager.onPinChange(rPin, (_: number, state: boolean) => {
        if (!state) {
          activeRows.add(row);
        } else {
          activeRows.delete(row);
        }
        for (let col = 0; col < 4; col++) updateCol(col);
      });
      cleanups.push(c);
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
      cleanups.forEach((c) => c());
      element.removeEventListener('button-press', onPress);
      element.removeEventListener('button-release', onRelease);
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

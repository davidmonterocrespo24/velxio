import { PartSimulationRegistry } from './PartSimulationRegistry';

/**
 * Basic Pushbutton implementation (full-size)
 */
PartSimulationRegistry.register('pushbutton', {
    attachEvents: (element, avrSimulator, getArduinoPinHelper) => {
        const arduinoPin =
            getArduinoPinHelper('1.l') ?? getArduinoPinHelper('2.l') ??
            getArduinoPinHelper('1.r') ?? getArduinoPinHelper('2.r');

        if (arduinoPin === null) return () => { };

        const onButtonPress = () => {
            avrSimulator.setPinState(arduinoPin, false); // Active LOW
            (element as any).pressed = true;
        };
        const onButtonRelease = () => {
            avrSimulator.setPinState(arduinoPin, true);
            (element as any).pressed = false;
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
    attachEvents: (element, avrSimulator, getArduinoPinHelper) => {
        const arduinoPin =
            getArduinoPinHelper('1.l') ?? getArduinoPinHelper('2.l') ??
            getArduinoPinHelper('1.r') ?? getArduinoPinHelper('2.r');

        if (arduinoPin === null) return () => { };

        const onPress = () => {
            avrSimulator.setPinState(arduinoPin, false);
            (element as any).pressed = true;
        };
        const onRelease = () => {
            avrSimulator.setPinState(arduinoPin, true);
            (element as any).pressed = false;
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
    attachEvents: (element, avrSimulator, getArduinoPinHelper) => {
        // Slide switch has pins: 1, 2, 3 — middle pin (2) is the common output
        const arduinoPin = getArduinoPinHelper('2') ?? getArduinoPinHelper('1');
        if (arduinoPin === null) return () => { };

        // Read initial value from element (0 or 1)
        let state = (element as any).value === 1;
        avrSimulator.setPinState(arduinoPin, state);

        const onChange = () => {
            state = (element as any).value === 1;
            avrSimulator.setPinState(arduinoPin, state);
            console.log(`[SlideSwitch] pin ${arduinoPin} → ${state ? 'HIGH' : 'LOW'}`);
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
 * Basic LED implementation
 */
PartSimulationRegistry.register('led', {
    onPinStateChange: (pinName, state, element) => {
        if (pinName === 'A') { // Anode
            (element as any).value = state;
        }
    }
});

/**
 * LED Bar Graph — 10 LEDs, each driven by one pin
 * Wokwi pin names: A1-A10
 */
PartSimulationRegistry.register('led-bar-graph', {
    attachEvents: (element, avrSimulator, getArduinoPinHelper) => {
        const pinManager = (avrSimulator as any).pinManager;
        if (!pinManager) return () => { };

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
                    })
                );
            }
        }

        return () => unsubscribers.forEach(u => u());
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
        const pinDT  = getArduinoPinHelper('DT');
        const pinSW  = getArduinoPinHelper('SW');

        // SW starts HIGH (not pressed, active LOW)
        if (pinSW !== null) simulator.setPinState(pinSW, true);
        // CLK and DT start HIGH (idle)
        if (pinCLK !== null) simulator.setPinState(pinCLK, true);
        if (pinDT !== null)  simulator.setPinState(pinDT, true);

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

        const onCW      = () => emitPulse(false); // DT LOW  = CW
        const onCCW     = () => emitPulse(true);  // DT HIGH = CCW
        const onPress   = () => { if (pinSW !== null) simulator.setPinState(pinSW, false); };
        const onRelease = () => { if (pinSW !== null) simulator.setPinState(pinSW, true); };

        element.addEventListener('rotate-cw',      onCW);
        element.addEventListener('rotate-ccw',     onCCW);
        element.addEventListener('button-press',   onPress);
        element.addEventListener('button-release', onRelease);

        return () => {
            element.removeEventListener('rotate-cw',      onCW);
            element.removeEventListener('rotate-ccw',     onCCW);
            element.removeEventListener('button-press',   onPress);
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
            [true,  false, false, false],
            [false, true,  false, false],
            [false, false, true,  false],
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
            pinAminus: number | null, pinAplus: number | null,
            pinBplus: number | null, pinBminus: number | null,
            setAngle: (deg: number) => void,
        ) {
            let aMinus = false, aPlus = false, bPlus = false, bMinus = false;
            let cumAngle = 0;
            let prevIdx = -1;
            const unsubs: (() => void)[] = [];

            function onCoilChange() {
                const idx = stepIndexFromCoils(aPlus, bPlus, aMinus, bMinus);
                if (idx < 0) return;
                if (prevIdx < 0) { prevIdx = idx; return; }
                const diff = (idx - prevIdx + 4) % 4;
                if (diff === 1) cumAngle += STEP_ANGLE;
                else if (diff === 3) cumAngle -= STEP_ANGLE;
                prevIdx = idx;
                setAngle(((cumAngle % 360) + 360) % 360);
            }

            if (pinAminus !== null) unsubs.push(pinManager.onPinChange(pinAminus, (_: number, s: boolean) => { aMinus = s; onCoilChange(); }));
            if (pinAplus  !== null) unsubs.push(pinManager.onPinChange(pinAplus,  (_: number, s: boolean) => { aPlus  = s; onCoilChange(); }));
            if (pinBplus  !== null) unsubs.push(pinManager.onPinChange(pinBplus,  (_: number, s: boolean) => { bPlus  = s; onCoilChange(); }));
            if (pinBminus !== null) unsubs.push(pinManager.onPinChange(pinBminus, (_: number, s: boolean) => { bMinus = s; onCoilChange(); }));

            return () => unsubs.forEach(u => u());
        }

        const cleanup1 = makeMotorTracker(
            getArduinoPinHelper('A1-'), getArduinoPinHelper('A1+'),
            getArduinoPinHelper('B1+'), getArduinoPinHelper('B1-'),
            (deg) => { el.outerHandAngle = deg; },
        );
        const cleanup2 = makeMotorTracker(
            getArduinoPinHelper('A2-'), getArduinoPinHelper('A2+'),
            getArduinoPinHelper('B2+'), getArduinoPinHelper('B2-'),
            (deg) => { el.innerHandAngle = deg; },
        );

        return () => { cleanup1(); cleanup2(); };
    },
});

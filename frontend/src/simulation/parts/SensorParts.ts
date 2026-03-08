/**
 * SensorParts.ts — Simulation logic for sensors, stepper motor, and NeoPixel devices.
 *
 * Implements:
 *  - tilt-switch
 *  - ntc-temperature-sensor
 *  - gas-sensor (MQ-series)
 *  - flame-sensor
 *  - heart-beat-sensor
 *  - big-sound-sensor
 *  - small-sound-sensor
 *  - stepper-motor (NEMA full-step decode)
 *  - led-ring (WS2812B NeoPixel ring)
 *  - neopixel-matrix (WS2812B NeoPixel matrix)
 */

import { PartSimulationRegistry } from './PartSimulationRegistry';
import { setAdcVoltage } from './partUtils';

// ─── Tilt Switch ─────────────────────────────────────────────────────────────

/**
 * Tilt switch — click the element to toggle between tilted (OUT HIGH) and
 * upright (OUT LOW). Starts upright (LOW).
 */
PartSimulationRegistry.register('tilt-switch', {
    attachEvents: (element, simulator, getArduinoPinHelper) => {
        const pin = getArduinoPinHelper('OUT');
        if (pin === null) return () => {};

        let tilted = false;

        const onClick = () => {
            tilted = !tilted;
            simulator.setPinState(pin, tilted);
            console.log(`[TiltSwitch] pin ${pin} → ${tilted ? 'HIGH' : 'LOW'}`);
        };

        // Start LOW (upright)
        simulator.setPinState(pin, false);
        element.addEventListener('click', onClick);
        return () => element.removeEventListener('click', onClick);
    },
});

// ─── NTC Temperature Sensor ──────────────────────────────────────────────────

/**
 * NTC thermistor sensor — injects a mid-range analog voltage on the OUT pin
 * representing room temperature (~25°C, ~2.5V on a 5V divider).
 * Listens to `input` events in case the element ever gains a drag slider.
 */
PartSimulationRegistry.register('ntc-temperature-sensor', {
    attachEvents: (element, simulator, getArduinoPinHelper) => {
        const pin = getArduinoPinHelper('OUT');
        if (pin === null) return () => {};

        // Room temperature default (2.5V = mid-range)
        setAdcVoltage(simulator, pin, 2.5);

        const onInput = () => {
            const val = (element as any).value;
            if (val !== undefined) {
                setAdcVoltage(simulator, pin, (val / 1023.0) * 5.0);
            }
        };
        element.addEventListener('input', onInput);
        return () => element.removeEventListener('input', onInput);
    },
});

// ─── Gas Sensor (MQ-series) ──────────────────────────────────────────────────

/**
 * Gas sensor — injects a low baseline voltage on AOUT (clean air),
 * shows power LED. When Arduino drives DOUT → updates threshold LED D0.
 */
PartSimulationRegistry.register('gas-sensor', {
    attachEvents: (element, simulator, getArduinoPinHelper) => {
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
                })
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

        return () => unsubscribers.forEach(u => u());
    },
});

// ─── Flame Sensor ────────────────────────────────────────────────────────────

/**
 * Flame sensor — injects a low baseline voltage on AOUT (no flame),
 * shows power LED. Arduino driving DOUT → updates signal LED.
 */
PartSimulationRegistry.register('flame-sensor', {
    attachEvents: (element, simulator, getArduinoPinHelper) => {
        const pinAOUT = getArduinoPinHelper('AOUT');
        const pinDOUT = getArduinoPinHelper('DOUT');
        const pinManager = (simulator as any).pinManager;

        const el = element as any;
        el.ledPower = true;

        const unsubscribers: (() => void)[] = [];

        if (pinAOUT !== null) {
            setAdcVoltage(simulator, pinAOUT, 1.5);
        }

        if (pinDOUT !== null && pinManager) {
            unsubscribers.push(
                pinManager.onPinChange(pinDOUT, (_: number, state: boolean) => {
                    el.ledSignal = state;
                })
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

        return () => unsubscribers.forEach(u => u());
    },
});

// ─── Heart Beat Sensor ───────────────────────────────────────────────────────

/**
 * Heart beat sensor — simulates a 60 BPM signal on OUT pin.
 * Every 1000ms: briefly pulls OUT HIGH for 100ms, then LOW again.
 */
PartSimulationRegistry.register('heart-beat-sensor', {
    attachEvents: (element, simulator, getArduinoPinHelper) => {
        const pin = getArduinoPinHelper('OUT');
        if (pin === null) return () => {};

        simulator.setPinState(pin, false);

        const intervalId = setInterval(() => {
            simulator.setPinState(pin, true); // pulse HIGH
            setTimeout(() => simulator.setPinState(pin, false), 100);
        }, 1000);

        return () => clearInterval(intervalId);
    },
});

// ─── Big Sound Sensor ────────────────────────────────────────────────────────

/**
 * Big sound sensor (FC-04) — injects mid-range analog on AOUT,
 * shows power LED (led2). Arduino driving DOUT → signal LED (led1).
 */
PartSimulationRegistry.register('big-sound-sensor', {
    attachEvents: (element, simulator, getArduinoPinHelper) => {
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
                })
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

        return () => unsubscribers.forEach(u => u());
    },
});

// ─── Small Sound Sensor ──────────────────────────────────────────────────────

/**
 * Small sound sensor (KY-038) — injects mid-range analog on AOUT,
 * shows power LED. Arduino driving DOUT → signal LED.
 */
PartSimulationRegistry.register('small-sound-sensor', {
    attachEvents: (element, simulator, getArduinoPinHelper) => {
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
                })
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

        return () => unsubscribers.forEach(u => u());
    },
});

// ─── Stepper Motor (NEMA full-step decode) ───────────────────────────────────

/**
 * Stepper motor — monitors the 4 coil pins (A-, A+, B+, B-).
 * Uses a full-step lookup table to detect direction of rotation and
 * accumulates the shaft angle (1.8° per step = 200 steps per revolution).
 *
 * Full-step sequence (active-HIGH per coil):
 *   Step 0:  A+ = 1, B+ = 0, A- = 0, B- = 0
 *   Step 1:  A+ = 0, B+ = 1, A- = 0, B- = 0
 *   Step 2:  A+ = 0, B+ = 0, A- = 1, B- = 0
 *   Step 3:  A+ = 0, B+ = 0, A- = 0, B- = 1
 */
PartSimulationRegistry.register('stepper-motor', {
    attachEvents: (element, simulator, getArduinoPinHelper) => {
        const pinManager = (simulator as any).pinManager;
        if (!pinManager) return () => {};

        const el = element as any;
        const STEP_ANGLE = 1.8; // degrees per step

        const pinAMinus = getArduinoPinHelper('A-');
        const pinAPlus  = getArduinoPinHelper('A+');
        const pinBPlus  = getArduinoPinHelper('B+');
        const pinBMinus = getArduinoPinHelper('B-');

        const coils = { aMinus: false, aPlus: false, bPlus: false, bMinus: false };
        let cumAngle = el.angle ?? 0;
        let prevStepIndex = -1;

        // Full-step table: index → [A+, B+, A-, B-]
        const stepTable: [boolean, boolean, boolean, boolean][] = [
            [true,  false, false, false], // step 0
            [false, true,  false, false], // step 1
            [false, false, true,  false], // step 2
            [false, false, false, true],  // step 3
        ];

        function coilToStepIndex(): number {
            for (let i = 0; i < stepTable.length; i++) {
                const [ap, bp, am, bm] = stepTable[i];
                if (coils.aPlus === ap && coils.bPlus === bp &&
                    coils.aMinus === am && coils.bMinus === bm) {
                    return i;
                }
            }
            return -1; // energized coil pattern not in full-step table
        }

        function onCoilChange() {
            const idx = coilToStepIndex();
            if (idx < 0) return; // half-step or off state — ignore
            if (prevStepIndex < 0) { prevStepIndex = idx; return; }

            const diff = (idx - prevStepIndex + 4) % 4;
            if (diff === 1) {
                cumAngle += STEP_ANGLE;
            } else if (diff === 3) {
                cumAngle -= STEP_ANGLE;
            }
            prevStepIndex = idx;
            el.angle = ((cumAngle % 360) + 360) % 360;
        }

        const unsubscribers: (() => void)[] = [];

        if (pinAMinus !== null) {
            unsubscribers.push(pinManager.onPinChange(pinAMinus, (_: number, s: boolean) => {
                coils.aMinus = s; onCoilChange();
            }));
        }
        if (pinAPlus !== null) {
            unsubscribers.push(pinManager.onPinChange(pinAPlus, (_: number, s: boolean) => {
                coils.aPlus = s; onCoilChange();
            }));
        }
        if (pinBPlus !== null) {
            unsubscribers.push(pinManager.onPinChange(pinBPlus, (_: number, s: boolean) => {
                coils.bPlus = s; onCoilChange();
            }));
        }
        if (pinBMinus !== null) {
            unsubscribers.push(pinManager.onPinChange(pinBMinus, (_: number, s: boolean) => {
                coils.bMinus = s; onCoilChange();
            }));
        }

        return () => unsubscribers.forEach(u => u());
    },
});

// ─── WS2812B NeoPixel decode helper ──────────────────────────────────────────

/**
 * Decode WS2812B bit-stream from DIN pin changes for NeoPixel devices.
 *
 * Protocol (800 kHz, 16 MHz AVR: 1 tick = 62.5 ns):
 *   - bit 0: HIGH for ~0.35µs (≤8 cycles); LOW for ~0.80µs
 *   - bit 1: HIGH for ~0.70µs (>8 cycles); LOW for ~0.40µs
 *   - RESET: LOW for >50µs (≥800 cycles)
 *
 * We measure HIGH pulse_width via cpu.cycles difference.
 * 8 bits (GRB order from WS2812B) → 1 byte; 3 bytes → 1 pixel.
 */
function createNeopixelDecoder(
    simulator: any,
    pinDIN: number,
    onPixel: (index: number, r: number, g: number, b: number) => void,
): () => void {
    const pinManager = simulator.pinManager;
    if (!pinManager) return () => {};

    const CPU_CYCLES_PER_US = 16; // 16 MHz
    const RESET_CYCLES = 800;     // 50µs × 16 cycles/µs
    const BIT1_THRESHOLD = 8;     // ~0.5µs threshold between bit-0 and bit-1

    let lastRisingCycle = 0;
    let lastFallingCycle = 0;
    let lastHigh = false;

    let bitBuf = 0;
    let bitsCollected = 0;
    let byteBuf: number[] = [];
    let pixelIndex = 0;

    const unsub = pinManager.onPinChange(pinDIN, (_: number, high: boolean) => {
        const cpu = simulator.cpu ?? (simulator as any).cpu;
        const now: number = cpu?.cycles ?? 0;

        if (high) {
            // Rising edge — check if preceding LOW was a RESET
            const lowDur = now - lastFallingCycle;
            if (lowDur > RESET_CYCLES) {
                // RESET pulse received — flush and restart
                pixelIndex = 0;
                byteBuf = [];
                bitBuf = 0;
                bitsCollected = 0;
            }
            lastRisingCycle = now;
            lastHigh = true;
        } else {
            // Falling edge — measure HIGH pulse width
            if (lastHigh) {
                const highDur = now - lastRisingCycle;
                const bit = highDur > BIT1_THRESHOLD ? 1 : 0;

                // WS2812B transmits MSB first
                bitBuf = (bitBuf << 1) | bit;
                bitsCollected++;

                if (bitsCollected === 8) {
                    byteBuf.push(bitBuf & 0xFF);
                    bitBuf = 0;
                    bitsCollected = 0;

                    if (byteBuf.length === 3) {
                        // WS2812B byte order is GRB
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

    return unsub;
}

// ─── LED Ring (WS2812B NeoPixel ring) ────────────────────────────────────────

PartSimulationRegistry.register('led-ring', {
    attachEvents: (element, simulator, getArduinoPinHelper) => {
        const pinDIN = getArduinoPinHelper('DIN');
        if (pinDIN === null) return () => {};

        const el = element as any;

        const unsub = createNeopixelDecoder(
            (simulator as any),
            pinDIN,
            (index, r, g, b) => {
                try {
                    el.setPixel(index, { r, g, b });
                } catch (_) {
                    // setPixel not yet available (element not upgraded) — ignore
                }
            },
        );

        return unsub;
    },
});

// ─── NeoPixel Matrix (WS2812B matrix grid) ────────────────────────────────────

PartSimulationRegistry.register('neopixel-matrix', {
    attachEvents: (element, simulator, getArduinoPinHelper) => {
        const pinDIN = getArduinoPinHelper('DIN');
        if (pinDIN === null) return () => {};

        const el = element as any;

        const unsub = createNeopixelDecoder(
            (simulator as any),
            pinDIN,
            (index, r, g, b) => {
                // cols is set by the element property (default 8)
                const cols: number = el.cols ?? 8;
                const row = Math.floor(index / cols);
                const col = index % cols;
                try {
                    el.setPixel(row, col, { r, g, b });
                } catch (_) {
                    // ignore
                }
            },
        );

        return unsub;
    },
});

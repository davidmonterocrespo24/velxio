/**
 * Integration Tests
 *
 * End-to-end tests that combine real simulators with PinManager and
 * component-style callbacks to verify the full simulation pipeline.
 *
 * Covers:
 * - AVRSimulator + PinManager: HEX execution drives pins, ADC, PWM
 * - RP2040Simulator + PinManager: GPIO updates, setPinState, reset
 * - Board switching: both simulators can share the same PinManager
 * - PWM pipeline: OCR register → PinManager.updatePwm → component callback
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { RP2040Simulator } from '../simulation/RP2040Simulator';
import { PinManager } from '../simulation/PinManager';

// ─── RAF depth-limited mock ───────────────────────────────────────────────────
// Calls execute() once synchronously per start(); prevents infinite recursion.
beforeEach(() => {
  let counter = 0;
  let depth = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    if (depth === 0) {
      depth++;
      cb(0);
      depth--;
    }
    return ++counter;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

// ─── HEX / binary fixtures ────────────────────────────────────────────────────

/**
 * Minimal Intel HEX that sets pin 13 HIGH and loops:
 *   LDI r16, 0xFF  → OUT DDRB → LDI r16, 0x20 → OUT PORTB → RJMP .-2
 */
const BLINK_HEX = ':0A0000000FEF04B900E205B9FFCFCD\n' + ':00000001FF\n';

/** Empty program (EOF record only) */
const EMPTY_HEX = ':00000001FF\n';

/** Create a base64-encoded all-zero binary of the given size in KB */
function zeroBinary(sizeKb = 1): string {
  const bytes = new Uint8Array(sizeKb * 1024);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

// ─── AVRSimulator + PinManager ────────────────────────────────────────────────

describe('Integration — AVRSimulator + PinManager', () => {
  let pm: PinManager;
  let sim: AVRSimulator;

  beforeEach(() => {
    pm = new PinManager();
    sim = new AVRSimulator(pm);
  });
  afterEach(() => sim.stop());

  // ── step()-based tests (no RAF needed) ──────────────────────────────────────

  it('executes BLINK_HEX and drives pin 13 HIGH after 4 instructions', () => {
    sim.loadHex(BLINK_HEX);

    const changes: boolean[] = [];
    pm.onPinChange(13, (_pin, state) => changes.push(state));

    sim.step(); // LDI r16, 0xFF
    sim.step(); // OUT DDRB, r16
    sim.step(); // LDI r16, 0x20
    sim.step(); // OUT PORTB, r16  → pin 13 HIGH

    expect(pm.getPinState(13)).toBe(true);
    expect(changes).toContain(true);
  });

  it('pin 13 is LOW before any instructions execute', () => {
    sim.loadHex(BLINK_HEX);
    expect(pm.getPinState(13)).toBe(false);
  });

  it('LED component callback fires when pin 13 goes HIGH', () => {
    sim.loadHex(BLINK_HEX);

    const ledState = { on: false };
    pm.onPinChange(13, (_pin, state) => {
      ledState.on = state;
    });

    sim.step();
    sim.step();
    sim.step();
    sim.step();

    expect(ledState.on).toBe(true);
  });

  it('pin 13 stays HIGH through the RJMP loop', () => {
    sim.loadHex(BLINK_HEX);
    sim.step();
    sim.step();
    sim.step();
    sim.step(); // set pin HIGH

    for (let i = 0; i < 10; i++) sim.step(); // execute 10 more (RJMP loops)

    expect(pm.getPinState(13)).toBe(true);
  });

  it('ADC channel is accessible and writeable after loadHex()', () => {
    sim.loadHex(EMPTY_HEX);

    const adc = sim.getADC();
    expect(adc).not.toBeNull();

    adc!.channelValues[0] = 3.3; // Inject 3.3V on A0
    expect(adc!.channelValues[0]).toBe(3.3);

    adc!.channelValues[3] = 1.8; // A3
    expect(adc!.channelValues[3]).toBe(1.8);
  });

  it('ADC resets to default on reset()', () => {
    sim.loadHex(EMPTY_HEX);
    sim.getADC()!.channelValues[0] = 4.5;
    sim.reset();
    // Fresh AVRADC: channelValues[0] is unset (undefined) or 0 — either means no voltage
    expect(sim.getADC()!.channelValues[0] ?? 0).toBe(0);
  });

  // ── start()/stop() — one frame via depth-limited RAF ───────────────────────

  it('PWM OCR register write propagates to PinManager via one frame', () => {
    sim.loadHex(EMPTY_HEX);

    const pwmChanges: Array<{ pin: number; dc: number }> = [];
    pm.onPwmChange(9, (pin, dc) => pwmChanges.push({ pin, dc }));

    // Directly set OCR1AL = 128 (pin 9, ~50% duty cycle)
    (sim as any).cpu.data[0x88] = 128;

    sim.start(); // one frame executes, polls PWM registers
    sim.stop();

    expect(pwmChanges.length).toBeGreaterThan(0);
    expect(pwmChanges[0].pin).toBe(9);
    expect(pwmChanges[0].dc).toBeCloseTo(128 / 255, 2);
  });

  it('all six PWM pins propagate their OCR values in one frame', () => {
    sim.loadHex(EMPTY_HEX);

    const PWM_MAP = [
      { addr: 0x47, pin: 6, value: 50 },
      { addr: 0x48, pin: 5, value: 100 },
      { addr: 0x88, pin: 9, value: 150 },
      { addr: 0x8a, pin: 10, value: 200 },
      { addr: 0xb3, pin: 11, value: 25 },
      { addr: 0xb4, pin: 3, value: 75 },
    ];

    const received: Record<number, number> = {};
    PWM_MAP.forEach(({ pin }) => {
      pm.onPwmChange(pin, (_p, dc) => {
        received[pin] = dc;
      });
    });

    const cpu = (sim as any).cpu;
    PWM_MAP.forEach(({ addr, value }) => {
      cpu.data[addr] = value;
    });

    sim.start();
    sim.stop();

    PWM_MAP.forEach(({ pin, value }) => {
      expect(received[pin]).toBeCloseTo(value / 255, 2);
    });
  });

  it('setPinState drives external input pins without throwing', () => {
    sim.loadHex(EMPTY_HEX);
    // setPinState drives external INPUT (button/switch); PinManager tracks CPU PORT OUTPUT.
    // These should not throw regardless of pin range.
    expect(() => sim.setPinState(4, true)).not.toThrow(); // PORTD
    expect(() => sim.setPinState(13, true)).not.toThrow(); // PORTB
    expect(() => sim.setPinState(14, true)).not.toThrow(); // PORTC/A0
  });

  it('multiple onPinChange subscribers all fire for the same pin', () => {
    sim.loadHex(BLINK_HEX);

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    pm.onPinChange(13, cb1);
    pm.onPinChange(13, cb2);

    sim.step();
    sim.step();
    sim.step();
    sim.step();

    expect(cb1).toHaveBeenCalledWith(13, true);
    expect(cb2).toHaveBeenCalledWith(13, true);
  });
});

// ─── RP2040Simulator + PinManager ────────────────────────────────────────────

describe('Integration — RP2040Simulator + PinManager', () => {
  let pm: PinManager;
  let sim: RP2040Simulator;

  beforeEach(() => {
    pm = new PinManager();
    sim = new RP2040Simulator(pm);
  });
  afterEach(() => sim.stop());

  it('triggerPinChange on GPIO25 fires LED_BUILTIN listener', () => {
    sim.loadBinary(zeroBinary());

    const ledState = { on: false };
    pm.onPinChange(25, (_pin, state) => {
      ledState.on = state;
    });

    pm.triggerPinChange(25, true);
    expect(ledState.on).toBe(true);
  });

  it('triggerPinChange HIGH then LOW fires listener twice', () => {
    sim.loadBinary(zeroBinary());

    const cb = vi.fn();
    pm.onPinChange(25, cb);

    pm.triggerPinChange(25, true);
    pm.triggerPinChange(25, false);

    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenNthCalledWith(1, 25, true);
    expect(cb).toHaveBeenNthCalledWith(2, 25, false);
  });

  it('setPinState does not throw for all 30 GPIO pins', () => {
    sim.loadBinary(zeroBinary());
    for (let i = 0; i < 30; i++) {
      expect(() => sim.setPinState(i, true)).not.toThrow();
      expect(() => sim.setPinState(i, false)).not.toThrow();
    }
  });

  it('multiple independent GPIO listeners fire only their own pin', () => {
    sim.loadBinary(zeroBinary());

    const cb7 = vi.fn();
    const cb25 = vi.fn();
    const cb0 = vi.fn();

    pm.onPinChange(7, cb7);
    pm.onPinChange(25, cb25);
    pm.onPinChange(0, cb0);

    pm.triggerPinChange(25, true);

    expect(cb25).toHaveBeenCalledWith(25, true);
    expect(cb7).not.toHaveBeenCalled();
    expect(cb0).not.toHaveBeenCalled();
  });

  it('GPIO listeners are still active after reset()', () => {
    sim.loadBinary(zeroBinary());
    sim.reset();

    const cb = vi.fn();
    pm.onPinChange(25, cb);
    pm.triggerPinChange(25, true);

    expect(cb).toHaveBeenCalledWith(25, true);
  });

  it('getADC() returns null before loadBinary()', () => {
    expect(sim.getADC()).toBeNull();
  });

  it('getADC() returns an object after loadBinary()', () => {
    sim.loadBinary(zeroBinary());
    expect(sim.getADC()).not.toBeNull();
  });
});

// ─── Board switching ──────────────────────────────────────────────────────────

describe('Integration — board switching (AVR ↔ RP2040)', () => {
  it('both simulators share the same PinManager instance', () => {
    const pm = new PinManager();
    const avrSim = new AVRSimulator(pm);
    const rpSim = new RP2040Simulator(pm);

    expect((avrSim as any).pinManager).toBe(pm);
    expect((rpSim as any).pinManager).toBe(pm);
  });

  it('stopping AVR and starting RP2040 does not corrupt PinManager', () => {
    const pm = new PinManager();

    const avrSim = new AVRSimulator(pm);
    avrSim.loadHex(EMPTY_HEX);
    avrSim.start();
    avrSim.stop();

    // Load RP2040 binary (no start() to avoid running 2M ARM cycles in tests)
    const rpSim = new RP2040Simulator(pm);
    rpSim.loadBinary(zeroBinary());

    // PinManager must still dispatch callbacks correctly after board switch
    const cb = vi.fn();
    pm.onPinChange(13, cb);
    pm.triggerPinChange(13, true);
    expect(cb).toHaveBeenCalledWith(13, true);
  });

  it('clearAllListeners resets PinManager between board switches', () => {
    const pm = new PinManager();

    const cb = vi.fn();
    pm.onPinChange(5, cb);
    expect(pm.getListenersCount()).toBe(1);

    pm.clearAllListeners();
    pm.triggerPinChange(5, true);

    expect(cb).not.toHaveBeenCalled();
    expect(pm.getListenersCount()).toBe(0);
  });

  it('AVR pin 13 HIGH does not affect RP2040 GPIO13 listener (no cross-talk)', () => {
    const pm = new PinManager();

    // Step 1: AVR drives pin 13 HIGH via CPU execution
    const avrSim = new AVRSimulator(pm);
    avrSim.loadHex(BLINK_HEX);

    const avrCb = vi.fn();
    pm.onPinChange(13, avrCb);
    avrSim.step();
    avrSim.step();
    avrSim.step();
    avrSim.step();
    expect(pm.getPinState(13)).toBe(true);

    // Step 2: Switch to RP2040 — clear AVR listeners, load RP2040 binary
    pm.clearAllListeners();
    const rpCb = vi.fn();
    pm.onPinChange(13, rpCb);

    const rpSim = new RP2040Simulator(pm);
    rpSim.loadBinary(zeroBinary());

    // Simulate RP2040 driving GPIO13 LOW via triggerPinChange
    pm.triggerPinChange(13, false);
    expect(rpCb).toHaveBeenCalledWith(13, false);
  });
});

// ─── PWM pipeline: OCR → PinManager → component callback ─────────────────────

describe('Integration — PWM pipeline (AVR → PinManager → component)', () => {
  it('OCR1AL=128 → onPwmChange(9) fires with duty 128/255', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm);
    sim.loadHex(EMPTY_HEX);

    const pwmValues: number[] = [];
    pm.onPwmChange(9, (_pin, dc) => pwmValues.push(dc));

    (sim as any).cpu.data[0x88] = 128;
    sim.start();
    sim.stop();

    expect(pwmValues.length).toBeGreaterThan(0);
    expect(pwmValues[0]).toBeCloseTo(128 / 255, 3);
  });

  it('RGB LED component receives correct brightness via PWM', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm);
    sim.loadHex(EMPTY_HEX);

    // Simulate RGB LED component listening to PWM on pins 9, 10, 11
    const rgb = { red: 0, green: 0, blue: 0 };
    pm.onPwmChange(9, (_p, dc) => {
      rgb.red = Math.round(dc * 255);
    });
    pm.onPwmChange(10, (_p, dc) => {
      rgb.green = Math.round(dc * 255);
    });
    pm.onPwmChange(11, (_p, dc) => {
      rgb.blue = Math.round(dc * 255);
    });

    (sim as any).cpu.data[0x88] = 255; // OCR1A → D9  = 100%
    (sim as any).cpu.data[0x8a] = 128; // OCR1B → D10 = ~50%
    (sim as any).cpu.data[0xb3] = 0; // OCR2A → D11 = 0%

    sim.start();
    sim.stop();

    expect(rgb.red).toBe(255);
    expect(rgb.green).toBe(128);
    // OCR2A=0 → updatePwm fires only if it differs from -1 (initial lastOcrValue)
    // With lastOcrValue initialized to -1 and data[0xB3]=0, 0 !== -1 → fires
    expect(rgb.blue).toBe(0);
  });

  it('PWM value does not re-fire if OCR register stays the same', () => {
    const pm = new PinManager();
    const sim = new AVRSimulator(pm);
    sim.loadHex(EMPTY_HEX);

    const pwmCb = vi.fn();
    pm.onPwmChange(9, pwmCb);

    (sim as any).cpu.data[0x88] = 200;
    sim.start(); // frame 1: fires updatePwm(9, 200/255)
    sim.stop();

    const callsAfterFrame1 = pwmCb.mock.calls.length;

    sim.start(); // frame 2: OCR value unchanged → should NOT fire again
    sim.stop();

    expect(pwmCb.mock.calls.length).toBe(callsAfterFrame1); // no additional calls
  });
});

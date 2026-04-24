/**
 * sensor-parts.test.ts
 *
 * Tests simulation logic for sensor and stepper-motor components registered
 * in SensorParts.ts (and stepper-motor in particular).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// Barrel import seeds built-in parts via `registerCoreParts()` (CORE-002c-step2).
import { PartSimulationRegistry } from '../simulation/parts';

// ─── RAF mock (no-op to prevent infinite loops) ───────────────────────────────
beforeEach(() => {
  let counter = 0;
  vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => ++counter);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('setInterval', vi.fn().mockReturnValue(42));
  vi.stubGlobal('clearInterval', vi.fn());
  vi.stubGlobal('setTimeout', vi.fn().mockReturnValue(1));
  vi.stubGlobal('clearTimeout', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

// ─── Mock factories ───────────────────────────────────────────────────────────

function makeElement(props: Record<string, unknown> = {}): HTMLElement {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    ...props,
  } as unknown as HTMLElement;
}

function makeADC() {
  return { channelValues: new Array(8).fill(0) };
}

function makeSimulator(adc?: ReturnType<typeof makeADC> | null) {
  const pinManager = {
    onPinChange: vi.fn().mockReturnValue(() => {}),
    onPwmChange: vi.fn().mockReturnValue(() => {}),
    triggerPinChange: vi.fn(),
  };
  return {
    pinManager,
    getADC: vi.fn().mockReturnValue(adc ?? null),
    setPinState: vi.fn(),
    cpu: { data: new Uint8Array(512).fill(0), cycles: 0 },
  };
}

const pinMap =
  (map: Record<string, number>) =>
  (name: string): number | null =>
    name in map ? map[name] : null;

const noPins = (_name: string): number | null => null;

// ─── SensorParts registration check ──────────────────────────────────────────

describe('SensorParts — registration', () => {
  const SENSOR_IDS = [
    'tilt-switch',
    'ntc-temperature-sensor',
    'gas-sensor',
    'flame-sensor',
    'heart-beat-sensor',
    'big-sound-sensor',
    'small-sound-sensor',
    'stepper-motor',
    'led-ring',
    'neopixel-matrix',
  ];

  it('registers all sensor and stepper component types', () => {
    for (const id of SENSOR_IDS) {
      expect(PartSimulationRegistry.get(id), `missing: ${id}`).toBeDefined();
    }
  });
});

// ─── Tilt Switch ─────────────────────────────────────────────────────────────

describe('tilt-switch — attachEvents', () => {
  it('sets OUT pin LOW on attach (upright), then HIGH after click, then LOW again', () => {
    const logic = PartSimulationRegistry.get('tilt-switch')!;
    const sim = makeSimulator();
    const element = makeElement();

    // Capture addEventListener calls
    const listeners: Record<string, (...args: any[]) => void> = {};
    (element.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: (...args: any[]) => void) => {
        listeners[event] = handler;
      },
    );

    logic.attachEvents!(element, sim as any, pinMap({ OUT: 14 }));

    // Should have started LOW (upright)
    expect(sim.setPinState).toHaveBeenCalledWith(14, false);

    // First click — tilts HIGH
    sim.setPinState.mockClear();
    listeners['click']?.();
    expect(sim.setPinState).toHaveBeenCalledWith(14, true);

    // Second click — returns LOW
    sim.setPinState.mockClear();
    listeners['click']?.();
    expect(sim.setPinState).toHaveBeenCalledWith(14, false);
  });

  it('does nothing when OUT pin is not connected', () => {
    const logic = PartSimulationRegistry.get('tilt-switch')!;
    const sim = makeSimulator();
    const element = makeElement();

    const cleanup = logic.attachEvents!(element, sim as any, noPins);
    expect(cleanup).toBeDefined();
    expect(sim.setPinState).not.toHaveBeenCalled();
  });
});

// ─── NTC Temperature Sensor ──────────────────────────────────────────────────

describe('ntc-temperature-sensor — attachEvents', () => {
  it('injects 2.5V (mid-range) on OUT pin at room temperature', () => {
    const logic = PartSimulationRegistry.get('ntc-temperature-sensor')!;
    const adc = makeADC();
    const sim = makeSimulator(adc);
    const element = makeElement();

    logic.attachEvents!(element, sim as any, pinMap({ OUT: 14 }));

    // Pin 14 = ADC channel 0.  2.5V should be stored in channelValues[0]
    expect(adc.channelValues[0]).toBeCloseTo(2.5, 2);
  });

  it('does nothing when OUT pin is not connected', () => {
    const logic = PartSimulationRegistry.get('ntc-temperature-sensor')!;
    const adc = makeADC();
    const sim = makeSimulator(adc);
    const element = makeElement();

    logic.attachEvents!(element, sim as any, noPins);
    // ADC should remain zeroed
    expect(adc.channelValues[0]).toBe(0);
  });
});

// ─── Gas Sensor ──────────────────────────────────────────────────────────────

describe('gas-sensor — attachEvents', () => {
  it('injects baseline analog voltage on AOUT and sets ledPower=true', () => {
    const logic = PartSimulationRegistry.get('gas-sensor')!;
    const adc = makeADC();
    const sim = makeSimulator(adc);
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ AOUT: 14, DOUT: 7 }));

    // AOUT → ADC channel 0, baseline 1.5V
    expect(adc.channelValues[0]).toBeCloseTo(1.5, 2);
    expect(el.ledPower).toBe(true);
  });

  it('registers pin-change listener for DOUT to update ledD0', () => {
    const logic = PartSimulationRegistry.get('gas-sensor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ DOUT: 7 }));

    // Should have registered a onPinChange listener for DOUT (pin 7)
    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(7, expect.any(Function));

    // Simulate DOUT going HIGH → ledD0 should update
    const handler = sim.pinManager.onPinChange.mock.calls[0][1];
    handler(7, true);
    expect(el.ledD0).toBe(true);

    handler(7, false);
    expect(el.ledD0).toBe(false);
  });
});

// ─── Flame Sensor ────────────────────────────────────────────────────────────

describe('flame-sensor — attachEvents', () => {
  it('injects baseline analog voltage on AOUT and sets ledPower=true', () => {
    const logic = PartSimulationRegistry.get('flame-sensor')!;
    const adc = makeADC();
    const sim = makeSimulator(adc);
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ AOUT: 14 }), 'flame-sensor-test');

    // No-flame baseline = 4.5V (inverse: no flame → high V, flame → low V)
    expect(adc.channelValues[0]).toBeCloseTo(4.5, 2);
    expect(el.ledPower).toBe(true);
  });

  it('updates ledSignal when DOUT pin state changes', () => {
    const logic = PartSimulationRegistry.get('flame-sensor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ DOUT: 8 }));

    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(8, expect.any(Function));

    const handler = sim.pinManager.onPinChange.mock.calls[0][1];
    handler(8, true);
    expect(el.ledSignal).toBe(true);
    handler(8, false);
    expect(el.ledSignal).toBe(false);
  });
});

// ─── Heart Beat Sensor ───────────────────────────────────────────────────────

describe('heart-beat-sensor — attachEvents', () => {
  it('starts OUT pin LOW and sets up an interval for pulse generation', () => {
    const logic = PartSimulationRegistry.get('heart-beat-sensor')!;
    const sim = makeSimulator();
    const element = makeElement();

    logic.attachEvents!(element, sim as any, pinMap({ OUT: 14 }));

    // Should start LOW
    expect(sim.setPinState).toHaveBeenCalledWith(14, false);
    // Should have called setInterval
    expect(setInterval).toHaveBeenCalled();
  });

  it('clears the interval on cleanup', () => {
    const logic = PartSimulationRegistry.get('heart-beat-sensor')!;
    const sim = makeSimulator();
    const element = makeElement();

    const cleanup = logic.attachEvents!(element, sim as any, pinMap({ OUT: 14 }));
    cleanup();

    expect(clearInterval).toHaveBeenCalledWith(42); // 42 is the mock return from setInterval
  });

  it('does nothing when OUT pin is not connected', () => {
    const logic = PartSimulationRegistry.get('heart-beat-sensor')!;
    const sim = makeSimulator();
    const element = makeElement();

    logic.attachEvents!(element, sim as any, noPins);
    expect(setInterval).not.toHaveBeenCalled();
  });
});

// ─── Big Sound Sensor ────────────────────────────────────────────────────────

describe('big-sound-sensor — attachEvents', () => {
  it('injects 2.5V on AOUT and sets led2=true (power LED)', () => {
    const logic = PartSimulationRegistry.get('big-sound-sensor')!;
    const adc = makeADC();
    const sim = makeSimulator(adc);
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ AOUT: 14 }));

    expect(adc.channelValues[0]).toBeCloseTo(2.5, 2);
    expect(el.led2).toBe(true);
  });

  it('updates led1 when DOUT pin changes', () => {
    const logic = PartSimulationRegistry.get('big-sound-sensor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ DOUT: 9 }));

    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(9, expect.any(Function));
    const handler = sim.pinManager.onPinChange.mock.calls[0][1];
    handler(9, true);
    expect(el.led1).toBe(true);
    handler(9, false);
    expect(el.led1).toBe(false);
  });
});

// ─── Small Sound Sensor ──────────────────────────────────────────────────────

describe('small-sound-sensor — attachEvents', () => {
  it('injects 2.5V on AOUT and sets ledPower=true', () => {
    const logic = PartSimulationRegistry.get('small-sound-sensor')!;
    const adc = makeADC();
    const sim = makeSimulator(adc);
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ AOUT: 14 }));

    expect(adc.channelValues[0]).toBeCloseTo(2.5, 2);
    expect(el.ledPower).toBe(true);
  });

  it('updates ledSignal when DOUT pin changes', () => {
    const logic = PartSimulationRegistry.get('small-sound-sensor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;

    logic.attachEvents!(el, sim as any, pinMap({ DOUT: 10 }));

    const handler = sim.pinManager.onPinChange.mock.calls[0][1];
    handler(10, true);
    expect(el.ledSignal).toBe(true);
    handler(10, false);
    expect(el.ledSignal).toBe(false);
  });
});

// ─── Stepper Motor ───────────────────────────────────────────────────────────

describe('stepper-motor — attachEvents', () => {
  it('registers pin-change listeners for all 4 coil pins', () => {
    const logic = PartSimulationRegistry.get('stepper-motor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;
    el.angle = 0;

    const pins = { 'A-': 4, 'A+': 5, 'B+': 6, 'B-': 7 };
    logic.attachEvents!(el, sim as any, pinMap(pins));

    expect(sim.pinManager.onPinChange).toHaveBeenCalledTimes(4);
    const registeredPins = sim.pinManager.onPinChange.mock.calls.map(([p]: [number]) => p);
    expect(registeredPins).toEqual(expect.arrayContaining([4, 5, 6, 7]));
  });

  it('advances angle by 1.8° per forward step (full-step sequence)', () => {
    const logic = PartSimulationRegistry.get('stepper-motor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;
    el.angle = 0;

    const pins = { 'A-': 4, 'A+': 5, 'B+': 6, 'B-': 7 };
    logic.attachEvents!(el, sim as any, pinMap(pins));

    // Collect handlers indexed by pin number
    const handlers: Record<number, (pin: number, s: boolean) => void> = {};
    for (const [pin, handler] of sim.pinManager.onPinChange.mock.calls) {
      handlers[pin as number] = handler;
    }

    // Step 0: A+ = HIGH (others LOW)
    handlers[5]?.(5, true); // A+

    // Step 1: B+ = HIGH, A+ = LOW → should advance angle
    handlers[5]?.(5, false); // A+ LOW
    handlers[6]?.(6, true); // B+ HIGH

    expect(el.angle).toBeCloseTo(1.8, 1);
  });

  it('does nothing with zero coil pins connected', () => {
    const logic = PartSimulationRegistry.get('stepper-motor')!;
    const sim = makeSimulator();
    const el = makeElement() as any;
    el.angle = 0;

    logic.attachEvents!(el, sim as any, noPins);

    expect(sim.pinManager.onPinChange).not.toHaveBeenCalled();
    expect(el.angle).toBe(0);
  });
});

// ─── LED Ring (NeoPixel) ─────────────────────────────────────────────────────

describe('led-ring — attachEvents', () => {
  it('registers a pin-change listener on the DIN pin', () => {
    const logic = PartSimulationRegistry.get('led-ring')!;
    const sim = makeSimulator();
    sim.cpu = { data: new Uint8Array(512), cycles: 0 } as any;
    const el = makeElement() as any;
    el.setPixel = vi.fn();

    logic.attachEvents!(el, sim as any, pinMap({ DIN: 6 }));

    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(6, expect.any(Function));
  });

  it('does nothing when DIN pin is not connected', () => {
    const logic = PartSimulationRegistry.get('led-ring')!;
    const sim = makeSimulator();
    const el = makeElement() as any;

    const cleanup = logic.attachEvents!(el, sim as any, noPins);
    expect(cleanup).toBeDefined();
    expect(sim.pinManager.onPinChange).not.toHaveBeenCalled();
  });
});

// ─── NeoPixel Matrix ─────────────────────────────────────────────────────────

describe('neopixel-matrix — attachEvents', () => {
  it('registers a pin-change listener on the DIN pin', () => {
    const logic = PartSimulationRegistry.get('neopixel-matrix')!;
    const sim = makeSimulator();
    sim.cpu = { data: new Uint8Array(512), cycles: 0 } as any;
    const el = makeElement() as any;
    el.setPixel = vi.fn();
    el.cols = 8;

    logic.attachEvents!(el, sim as any, pinMap({ DIN: 6 }));

    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(6, expect.any(Function));
  });
});

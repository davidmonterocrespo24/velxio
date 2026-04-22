/**
 * Simulation Parts Tests
 *
 * Tests the component simulation logic registered in PartSimulationRegistry.
 * All DOM elements are mocked as plain objects; no real browser APIs are needed.
 *
 * Covers:
 * - PartSimulationRegistry lookup
 * - LED, Pushbutton, Pushbutton-6mm, Slide-switch, DIP-switch-8
 * - LED-bar-graph, 7segment
 * - RGB LED (digital + PWM)
 * - Potentiometer, Slide-potentiometer, Photoresistor-sensor, Analog-joystick
 * - Servo (OCR register polling via RAF)
 * - Buzzer (Web Audio API mock)
 * - LCD1602 (4-bit mode pin registration)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';

// Side-effect imports — register all parts
import '../simulation/parts/BasicParts';
import '../simulation/parts/ComplexParts';
import '../simulation/parts/ChipParts';
import '../simulation/parts/SensorParts';

// ─── RAF depth-limited mock ───────────────────────────────────────────────────
// Calls the callback once synchronously but prevents re-entrancy so that
// animation loops (servo poll → rAF → poll → rAF → …) don't recurse infinitely.
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

// ─── Mock factories ───────────────────────────────────────────────────────────

/** Create a mock DOM element with vi.fn() event listeners */
function makeElement(props: Record<string, unknown> = {}): HTMLElement {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    ...props,
  } as unknown as HTMLElement;
}

/** Create a mock ADC with 8 channels */
function makeADC() {
  return { channelValues: new Array(8).fill(0) };
}

/** Create a mock simulator whose pinManager is accessible via (sim as any).pinManager */
function makeSimulator(adc?: ReturnType<typeof makeADC> | null) {
  const pinManager = {
    onPinChange: vi.fn().mockReturnValue(() => {}),
    onPwmChange: vi.fn().mockReturnValue(() => {}),
    getPwmValue: vi.fn().mockReturnValue(0),
    updatePwm: vi.fn(),
    triggerPinChange: vi.fn(),
  };
  return {
    pinManager,
    getADC: vi.fn().mockReturnValue(adc ?? null),
    setPinState: vi.fn(),
    isRunning: vi.fn().mockReturnValue(true),
    getCurrentCycles: vi.fn().mockReturnValue(1000),
    getClockHz: vi.fn().mockReturnValue(16_000_000),
    cpu: { data: new Uint8Array(512).fill(0), cycles: 1000 },
  };
}

/** Pin helper that always returns the same pin number regardless of pin name */
const pinHelper =
  (pin: number) =>
  (_name: string): number | null =>
    pin;

/** Pin helper that returns null for every name (no connections) */
const noPins = (_name: string): number | null => null;

/** Multi-pin helper: pass an object mapping pin names to pin numbers */
const pinMap =
  (map: Record<string, number>) =>
  (name: string): number | null =>
    name in map ? map[name] : null;

// ─── PartSimulationRegistry ───────────────────────────────────────────────────

describe('PartSimulationRegistry — registration', () => {
  const EXPECTED = [
    'pushbutton',
    'pushbutton-6mm',
    'slide-switch',
    'dip-switch-8',
    'led',
    'led-bar-graph',
    '7segment',
    'rgb-led',
    'potentiometer',
    'slide-potentiometer',
    'photoresistor-sensor',
    'analog-joystick',
    'servo',
    'buzzer',
    'lcd1602',
    'lcd2004',
  ];

  it('registers all expected component types', () => {
    for (const id of EXPECTED) {
      expect(PartSimulationRegistry.get(id), `missing: ${id}`).toBeDefined();
    }
  });

  it('returns undefined for an unknown component id', () => {
    expect(PartSimulationRegistry.get('wokwi-banana')).toBeUndefined();
  });

  it('each registered part has onPinStateChange or attachEvents (or both)', () => {
    for (const id of EXPECTED) {
      const logic = PartSimulationRegistry.get(id)!;
      const hasSomething = !!(logic.onPinStateChange || logic.attachEvents);
      expect(hasSomething, `${id} has no simulation logic`).toBe(true);
    }
  });
});

// ─── LED ─────────────────────────────────────────────────────────────────────

describe('LED — attachEvents (anode + cathode check)', () => {
  it('LED turns on when anode HIGH and cathode wired to GND', () => {
    const logic = PartSimulationRegistry.get('led')!;
    const el = makeElement({ value: false });
    const sim = makeSimulator();
    // A → GPIO pin 13, C → GND (-1)
    logic.attachEvents!(el, sim as any, pinMap({ A: 13, C: -1 }), 'led-1');

    // pinManager.onPinChange should be called for anode (pin 13)
    const calls = sim.pinManager.onPinChange.mock.calls;
    const anodeCall = calls.find((c: any) => c[0] === 13);
    expect(anodeCall).toBeDefined();

    // Simulate anode going HIGH
    anodeCall![1](13, true);
    expect((el as any).value).toBe(true);
  });

  it('LED stays off when anode HIGH but cathode not wired', () => {
    const logic = PartSimulationRegistry.get('led')!;
    const el = makeElement({ value: false });
    const sim = makeSimulator();
    // A → pin 13, C → not wired (null)
    logic.attachEvents!(el, sim as any, pinMap({ A: 13 }), 'led-2');

    const calls = sim.pinManager.onPinChange.mock.calls;
    const anodeCall = calls.find((c: any) => c[0] === 13);
    expect(anodeCall).toBeDefined();

    // Simulate anode going HIGH — should NOT light up
    anodeCall![1](13, true);
    expect((el as any).value).toBe(false);
  });

  it('LED turns off when anode goes LOW', () => {
    const logic = PartSimulationRegistry.get('led')!;
    const el = makeElement({ value: false });
    const sim = makeSimulator();
    logic.attachEvents!(el, sim as any, pinMap({ A: 13, C: -1 }), 'led-3');

    const anodeCall = sim.pinManager.onPinChange.mock.calls.find((c: any) => c[0] === 13);
    anodeCall![1](13, true);
    expect((el as any).value).toBe(true);
    anodeCall![1](13, false);
    expect((el as any).value).toBe(false);
  });
});

// ─── Pushbutton ──────────────────────────────────────────────────────────────

describe('Pushbutton — attachEvents', () => {
  it('registers button-press and button-release event listeners', () => {
    const logic = PartSimulationRegistry.get('pushbutton')!;
    const el = makeElement({ pressed: false });
    const sim = makeSimulator();
    logic.attachEvents!(el, sim as any, pinHelper(7));

    const events = (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(events).toContain('button-press');
    expect(events).toContain('button-release');
  });

  it('calls setPinState(pin, false) on button-press (active LOW)', () => {
    const logic = PartSimulationRegistry.get('pushbutton')!;
    const el = makeElement({ pressed: false });
    const sim = makeSimulator();

    let pressHandler!: () => void;
    (el.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: () => void) => {
        if (event === 'button-press') pressHandler = handler;
      },
    );

    logic.attachEvents!(el, sim as any, pinHelper(7));
    pressHandler();

    expect(sim.setPinState).toHaveBeenCalledWith(7, false);
    expect((el as any).pressed).toBe(true);
  });

  it('calls setPinState(pin, true) on button-release', () => {
    const logic = PartSimulationRegistry.get('pushbutton')!;
    const el = makeElement({ pressed: true });
    const sim = makeSimulator();

    let releaseHandler!: () => void;
    (el.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: () => void) => {
        if (event === 'button-release') releaseHandler = handler;
      },
    );

    logic.attachEvents!(el, sim as any, pinHelper(7));
    releaseHandler();

    expect(sim.setPinState).toHaveBeenCalledWith(7, true);
    expect((el as any).pressed).toBe(false);
  });

  it('cleanup removes both event listeners', () => {
    const logic = PartSimulationRegistry.get('pushbutton')!;
    const el = makeElement();
    const sim = makeSimulator();
    const cleanup = logic.attachEvents!(el, sim as any, pinHelper(2));
    cleanup();
    expect(
      (el.removeEventListener as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('returns no-op cleanup when no pin is connected', () => {
    const logic = PartSimulationRegistry.get('pushbutton')!;
    const el = makeElement();
    const sim = makeSimulator();
    expect(() => logic.attachEvents!(el, sim as any, noPins)()).not.toThrow();
  });
});

// ─── Pushbutton-6mm ──────────────────────────────────────────────────────────

describe('Pushbutton-6mm — attachEvents', () => {
  it('behaves identically to pushbutton (active LOW on press)', () => {
    const logic = PartSimulationRegistry.get('pushbutton-6mm')!;
    const el = makeElement({ pressed: false });
    const sim = makeSimulator();

    let pressHandler!: () => void;
    (el.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: () => void) => {
        if (event === 'button-press') pressHandler = handler;
      },
    );

    logic.attachEvents!(el, sim as any, pinHelper(4));
    pressHandler();
    expect(sim.setPinState).toHaveBeenCalledWith(4, false);
    expect((el as any).pressed).toBe(true);
  });
});

// ─── Slide-switch ─────────────────────────────────────────────────────────────

describe('Slide-switch — attachEvents', () => {
  it('reads initial value=1 and drives pin HIGH immediately', () => {
    const logic = PartSimulationRegistry.get('slide-switch')!;
    const el = makeElement({ value: 1 });
    const sim = makeSimulator();
    logic.attachEvents!(el, sim as any, pinHelper(5));
    expect(sim.setPinState).toHaveBeenCalledWith(5, true);
  });

  it('reads initial value=0 and drives pin LOW immediately', () => {
    const logic = PartSimulationRegistry.get('slide-switch')!;
    const el = makeElement({ value: 0 });
    const sim = makeSimulator();
    logic.attachEvents!(el, sim as any, pinHelper(5));
    expect(sim.setPinState).toHaveBeenCalledWith(5, false);
  });

  it('updates pin state when change event fires', () => {
    const logic = PartSimulationRegistry.get('slide-switch')!;
    const el = makeElement({ value: 0 });
    const sim = makeSimulator();

    let changeHandler!: () => void;
    (el.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: () => void) => {
        if (event === 'change') changeHandler = handler;
      },
    );

    logic.attachEvents!(el, sim as any, pinHelper(6));
    (el as any).value = 1;
    changeHandler();

    expect(sim.setPinState).toHaveBeenLastCalledWith(6, true);
  });

  it('returns no-op when no pin is connected', () => {
    const logic = PartSimulationRegistry.get('slide-switch')!;
    const el = makeElement({ value: 0 });
    const sim = makeSimulator();
    expect(() => logic.attachEvents!(el, sim as any, noPins)()).not.toThrow();
  });
});

// ─── DIP-switch-8 ────────────────────────────────────────────────────────────

describe('DIP-switch-8 — attachEvents', () => {
  it('syncs all 8 initial switch states on attach', () => {
    const logic = PartSimulationRegistry.get('dip-switch-8')!;
    const values = [1, 0, 1, 0, 1, 0, 1, 0];
    const el = makeElement({ values });
    const sim = makeSimulator();

    const helper = pinMap({
      '1A': 2,
      '2A': 3,
      '3A': 4,
      '4A': 5,
      '5A': 6,
      '6A': 7,
      '7A': 8,
      '8A': 9,
    });
    logic.attachEvents!(el, sim as any, helper);

    expect(sim.setPinState.mock.calls.length).toBe(8);
    expect(sim.setPinState).toHaveBeenCalledWith(2, true); // switch 1 ON
    expect(sim.setPinState).toHaveBeenCalledWith(3, false); // switch 2 OFF
    expect(sim.setPinState).toHaveBeenCalledWith(9, false); // switch 8 OFF
  });

  it('updates pins when change event fires', () => {
    const logic = PartSimulationRegistry.get('dip-switch-8')!;
    const el = makeElement({ values: new Array(8).fill(0) });
    const sim = makeSimulator();

    let changeHandler!: () => void;
    (el.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: () => void) => {
        if (event === 'change') changeHandler = handler;
      },
    );

    const helper = pinMap({ '1A': 2 });
    logic.attachEvents!(el, sim as any, helper);

    (el as any).values = [1, 0, 0, 0, 0, 0, 0, 0];
    changeHandler();
    expect(sim.setPinState).toHaveBeenLastCalledWith(2, true);
  });
});

// ─── LED Bar Graph ────────────────────────────────────────────────────────────

describe('LED-bar-graph — attachEvents', () => {
  it('registers onPinChange for all 10 LED pins (A1-A10)', () => {
    const logic = PartSimulationRegistry.get('led-bar-graph')!;
    const el = makeElement({ values: new Array(10).fill(0) });
    const sim = makeSimulator();

    const helper = (name: string): number | null => {
      const idx = parseInt(name.replace('A', ''));
      return isNaN(idx) || idx < 1 || idx > 10 ? null : idx + 1;
    };

    logic.attachEvents!(el, sim as any, helper);
    expect(sim.pinManager.onPinChange.mock.calls.length).toBe(10);
  });

  it('updates element.values[0] when LED A1 pin goes HIGH', () => {
    const logic = PartSimulationRegistry.get('led-bar-graph')!;
    const el = makeElement({ values: new Array(10).fill(0) });
    const sim = makeSimulator();

    const callbacks: Array<(pin: number, state: boolean) => void> = [];
    sim.pinManager.onPinChange.mockImplementation(
      (_pin: number, cb: (pin: number, state: boolean) => void) => {
        callbacks.push(cb);
        return () => {};
      },
    );

    logic.attachEvents!(el, sim as any, pinMap({ A1: 2 }));
    callbacks[0](2, true);
    expect((el as any).values[0]).toBe(1);
  });

  it('cleanup unsubscribes all 10 listeners', () => {
    const unsubMock = vi.fn();
    const logic = PartSimulationRegistry.get('led-bar-graph')!;
    const el = makeElement({ values: new Array(10).fill(0) });
    const sim = makeSimulator();
    sim.pinManager.onPinChange.mockReturnValue(unsubMock);

    const helper = (name: string): number | null => {
      const idx = parseInt(name.replace('A', ''));
      return isNaN(idx) ? null : idx;
    };

    const cleanup = logic.attachEvents!(el, sim as any, helper);
    cleanup();
    expect(unsubMock).toHaveBeenCalledTimes(10);
  });
});

// ─── 7-Segment Display ───────────────────────────────────────────────────────

describe('7segment — attachEvents', () => {
  it('registers onPinChange for all 8 segments (A B C D E F G DP)', () => {
    const logic = PartSimulationRegistry.get('7segment')!;
    const el = makeElement({ values: new Array(8).fill(0) });
    const sim = makeSimulator();

    const helper = pinMap({ A: 2, B: 3, C: 4, D: 5, E: 6, F: 7, G: 8, DP: 9 });
    logic.attachEvents!(el, sim as any, helper);

    expect(sim.pinManager.onPinChange.mock.calls.length).toBe(8);
  });

  it('updates element.values[0] when segment A pin goes HIGH', () => {
    const logic = PartSimulationRegistry.get('7segment')!;
    const el = makeElement({ values: new Array(8).fill(0) });
    const sim = makeSimulator();

    let segACallback!: (pin: number, state: boolean) => void;
    sim.pinManager.onPinChange.mockImplementation(
      (_pin: number, cb: (pin: number, state: boolean) => void) => {
        if (!segACallback) segACallback = cb;
        return () => {};
      },
    );

    logic.attachEvents!(el, sim as any, pinMap({ A: 2 }));
    segACallback(2, true);
    expect((el as any).values[0]).toBe(1); // 'A' is index 0
  });

  it('cleanup unsubscribes all 8 segment listeners', () => {
    const unsubMock = vi.fn();
    const logic = PartSimulationRegistry.get('7segment')!;
    const el = makeElement({ values: new Array(8).fill(0) });
    const sim = makeSimulator();
    sim.pinManager.onPinChange.mockReturnValue(unsubMock);

    const helper = pinMap({ A: 2, B: 3, C: 4, D: 5, E: 6, F: 7, G: 8, DP: 9 });
    const cleanup = logic.attachEvents!(el, sim as any, helper);
    cleanup();
    expect(unsubMock).toHaveBeenCalledTimes(8);
  });
});

// ─── RGB LED ──────────────────────────────────────────────────────────────────

describe('RGB LED — attachEvents', () => {
  it('subscribes to 3 digital (onPinChange) and 3 PWM (onPwmChange) listeners', () => {
    const logic = PartSimulationRegistry.get('rgb-led')!;
    const el = makeElement({ ledRed: 0, ledGreen: 0, ledBlue: 0 });
    const sim = makeSimulator();

    logic.attachEvents!(el, sim as any, pinMap({ R: 9, G: 10, B: 11 }));

    expect(sim.pinManager.onPinChange.mock.calls.length).toBe(3);
    expect(sim.pinManager.onPwmChange.mock.calls.length).toBe(3);
  });

  it('sets ledRed to 255 on digital HIGH, 0 on LOW', () => {
    const logic = PartSimulationRegistry.get('rgb-led')!;
    const el = makeElement({ ledRed: 0, ledGreen: 0, ledBlue: 0 });
    const sim = makeSimulator();

    const digitalCbs: Record<number, (pin: number, state: boolean) => void> = {};
    sim.pinManager.onPinChange.mockImplementation(
      (pin: number, cb: (pin: number, state: boolean) => void) => {
        digitalCbs[pin] = cb;
        return () => {};
      },
    );
    sim.pinManager.onPwmChange.mockReturnValue(() => {});

    logic.attachEvents!(el, sim as any, pinMap({ R: 9 }));
    digitalCbs[9](9, true);
    expect((el as any).ledRed).toBe(255);
    digitalCbs[9](9, false);
    expect((el as any).ledRed).toBe(0);
  });

  it('sets ledGreen via PWM duty cycle (0.5 → 128)', () => {
    const logic = PartSimulationRegistry.get('rgb-led')!;
    const el = makeElement({ ledRed: 0, ledGreen: 0, ledBlue: 0 });
    const sim = makeSimulator();

    const pwmCbs: Record<number, (pin: number, dc: number) => void> = {};
    sim.pinManager.onPinChange.mockReturnValue(() => {});
    sim.pinManager.onPwmChange.mockImplementation(
      (pin: number, cb: (pin: number, dc: number) => void) => {
        pwmCbs[pin] = cb;
        return () => {};
      },
    );

    logic.attachEvents!(el, sim as any, pinMap({ G: 10 }));
    pwmCbs[10](10, 0.5);
    expect((el as any).ledGreen).toBe(128); // Math.round(0.5 * 255)
  });

  it('sets ledBlue via PWM full brightness (1.0 → 255)', () => {
    const logic = PartSimulationRegistry.get('rgb-led')!;
    const el = makeElement({ ledBlue: 0 });
    const sim = makeSimulator();

    const pwmCbs: Record<number, (pin: number, dc: number) => void> = {};
    sim.pinManager.onPinChange.mockReturnValue(() => {});
    sim.pinManager.onPwmChange.mockImplementation(
      (pin: number, cb: (pin: number, dc: number) => void) => {
        pwmCbs[pin] = cb;
        return () => {};
      },
    );

    logic.attachEvents!(el, sim as any, pinMap({ B: 11 }));
    pwmCbs[11](11, 1.0);
    expect((el as any).ledBlue).toBe(255);
  });

  it('cleanup unsubscribes all 6 listeners', () => {
    const unsubMock = vi.fn();
    const logic = PartSimulationRegistry.get('rgb-led')!;
    const el = makeElement({ ledRed: 0, ledGreen: 0, ledBlue: 0 });
    const sim = makeSimulator();
    sim.pinManager.onPinChange.mockReturnValue(unsubMock);
    sim.pinManager.onPwmChange.mockReturnValue(unsubMock);

    const cleanup = logic.attachEvents!(el, sim as any, pinMap({ R: 9, G: 10, B: 11 }));
    cleanup();
    expect(unsubMock).toHaveBeenCalledTimes(6);
  });
});

// ─── Potentiometer ───────────────────────────────────────────────────────────

describe('Potentiometer — attachEvents', () => {
  it('injects ADC voltage on input event (512/1023 * 5V ≈ 2.5V)', () => {
    const logic = PartSimulationRegistry.get('potentiometer')!;
    const adc = makeADC();
    const el = makeElement({ value: '512' });
    const sim = makeSimulator(adc);

    let inputHandler!: () => void;
    (el.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: () => void) => {
        if (event === 'input') inputHandler = handler;
      },
    );

    logic.attachEvents!(el, sim as any, pinMap({ SIG: 14 })); // A0 = pin 14
    inputHandler();

    expect(adc.channelValues[0]).toBeCloseTo(2.5, 1); // channel 0 = A0
  });

  it('injects 0V when value is 0', () => {
    const logic = PartSimulationRegistry.get('potentiometer')!;
    const adc = makeADC();
    const el = makeElement({ value: '0' });
    const sim = makeSimulator(adc);

    let inputHandler!: () => void;
    (el.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: () => void) => {
        if (event === 'input') inputHandler = handler;
      },
    );

    logic.attachEvents!(el, sim as any, pinMap({ SIG: 14 }));
    inputHandler();

    expect(adc.channelValues[0]).toBeCloseTo(0, 5);
  });

  it('injects 5V when value is 1023', () => {
    const logic = PartSimulationRegistry.get('potentiometer')!;
    const adc = makeADC();
    const el = makeElement({ value: '1023' });
    const sim = makeSimulator(adc);

    let inputHandler!: () => void;
    (el.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: () => void) => {
        if (event === 'input') inputHandler = handler;
      },
    );

    logic.attachEvents!(el, sim as any, pinMap({ SIG: 14 }));
    inputHandler();

    expect(adc.channelValues[0]).toBeCloseTo(5.0, 2);
  });

  it('returns no-op when SIG pin is not connected', () => {
    const logic = PartSimulationRegistry.get('potentiometer')!;
    const el = makeElement({ value: '100' });
    const sim = makeSimulator(makeADC());
    expect(() => logic.attachEvents!(el, sim as any, noPins)()).not.toThrow();
  });
});

// ─── Slide Potentiometer ─────────────────────────────────────────────────────

describe('Slide-potentiometer — attachEvents', () => {
  it('injects mid-range voltage on input event', () => {
    const logic = PartSimulationRegistry.get('slide-potentiometer')!;
    const adc = makeADC();
    const el = makeElement({ value: 512, min: 0, max: 1023 });
    const sim = makeSimulator(adc);

    let inputHandler!: () => void;
    (el.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: () => void) => {
        if (event === 'input') inputHandler = handler;
      },
    );

    logic.attachEvents!(el, sim as any, pinMap({ SIG: 14 }));
    inputHandler();

    expect(adc.channelValues[0]).toBeCloseTo(2.5, 1);
  });
});

// ─── Photoresistor Sensor ────────────────────────────────────────────────────

describe('Photoresistor-sensor — attachEvents', () => {
  it('injects initial 2.5V (moderate light) on the AO pin immediately', () => {
    const logic = PartSimulationRegistry.get('photoresistor-sensor')!;
    const adc = makeADC();
    const el = makeElement();
    const sim = makeSimulator(adc);

    logic.attachEvents!(el, sim as any, pinMap({ AO: 14 }));
    expect(adc.channelValues[0]).toBeCloseTo(2.5, 1);
  });

  it('updates ADC voltage to 5V on input event (full light)', () => {
    const logic = PartSimulationRegistry.get('photoresistor-sensor')!;
    const adc = makeADC();
    const el = makeElement({ value: 1023 });
    const sim = makeSimulator(adc);

    let inputHandler!: () => void;
    (el.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: () => void) => {
        if (event === 'input') inputHandler = handler;
      },
    );

    logic.attachEvents!(el, sim as any, pinMap({ AO: 14 }));
    inputHandler();
    expect(adc.channelValues[0]).toBeCloseTo(5.0, 1);
  });

  it('registers DO indicator listener when digital output pin is connected', () => {
    const logic = PartSimulationRegistry.get('photoresistor-sensor')!;
    const el = makeElement({ ledDO: false });
    const sim = makeSimulator(makeADC());

    logic.attachEvents!(el, sim as any, pinMap({ AO: 14, DO: 4 }));
    expect(sim.pinManager.onPinChange.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Analog Joystick ─────────────────────────────────────────────────────────

describe('Analog-joystick — attachEvents', () => {
  it('injects 2.5V on both X and Y axes initially (center)', () => {
    const logic = PartSimulationRegistry.get('analog-joystick')!;
    const adc = makeADC();
    const el = makeElement();
    const sim = makeSimulator(adc);

    logic.attachEvents!(el, sim as any, pinMap({ VRX: 14, VRY: 15 }));

    expect(adc.channelValues[0]).toBeCloseTo(2.5, 1); // A0 = X
    expect(adc.channelValues[1]).toBeCloseTo(2.5, 1); // A1 = Y
  });

  it('calls setPinState(pin, false) on button-press (active LOW)', () => {
    const logic = PartSimulationRegistry.get('analog-joystick')!;
    const el = makeElement({ pressed: false });
    const sim = makeSimulator(makeADC());

    let pressHandler!: () => void;
    (el.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: () => void) => {
        if (event === 'button-press') pressHandler = handler;
      },
    );

    logic.attachEvents!(el, sim as any, pinMap({ SW: 2 }));
    pressHandler();
    expect(sim.setPinState).toHaveBeenCalledWith(2, false);
    expect((el as any).pressed).toBe(true);
  });

  it('calls setPinState(pin, true) on button-release', () => {
    const logic = PartSimulationRegistry.get('analog-joystick')!;
    const el = makeElement({ pressed: true });
    const sim = makeSimulator(makeADC());

    let releaseHandler!: () => void;
    (el.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: () => void) => {
        if (event === 'button-release') releaseHandler = handler;
      },
    );

    logic.attachEvents!(el, sim as any, pinMap({ SW: 2 }));
    releaseHandler();
    expect(sim.setPinState).toHaveBeenCalledWith(2, true);
    expect((el as any).pressed).toBe(false);
  });

  it('updates ADC voltages on joystick-move event', () => {
    const logic = PartSimulationRegistry.get('analog-joystick')!;
    const adc = makeADC();
    const el = makeElement({ xValue: 0, yValue: 1023 });
    const sim = makeSimulator(adc);

    let moveHandler!: () => void;
    (el.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: () => void) => {
        if (event === 'joystick-move') moveHandler = handler;
      },
    );

    logic.attachEvents!(el, sim as any, pinMap({ VRX: 14, VRY: 15 }));
    moveHandler();

    expect(adc.channelValues[0]).toBeCloseTo(0.0, 1); // X at min = 0V
    expect(adc.channelValues[1]).toBeCloseTo(5.0, 1); // Y at max = 5V
  });
});

// ─── Servo ───────────────────────────────────────────────────────────────────

describe('Servo — attachEvents', () => {
  it('starts polling via requestAnimationFrame immediately', () => {
    const logic = PartSimulationRegistry.get('servo')!;
    const el = makeElement({ angle: 0 });
    const sim = makeSimulator();
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');

    logic.attachEvents!(el, sim as any, noPins);
    expect(rafSpy).toHaveBeenCalled();
  });

  it('calculates 90° when OCR1A = ICR1/2 (servo midpoint)', () => {
    // Real Arduino Servo.h: prescaler=8, 16 MHz → 0.5 µs/tick
    // ICR1 = 40000 ticks = 20 ms period (50 Hz)
    // 90° midpoint: 1472 µs → OCR1A = 1472 / 0.5 = 2944
    // pulseUs = (2944/40000)*20000 = 1472 µs → angle = (1472-544)/1856*180 = 90°
    const logic = PartSimulationRegistry.get('servo')!;
    const el = makeElement({ angle: -1 });
    const sim = makeSimulator();

    // ICR1L=0x86, ICR1H=0x87; OCR1AL=0x88, OCR1AH=0x89
    sim.cpu.data[0x88] = 2944 & 0xff; // OCR1AL
    sim.cpu.data[0x89] = (2944 >> 8) & 0xff; // OCR1AH
    sim.cpu.data[0x86] = 40000 & 0xff; // ICR1L
    sim.cpu.data[0x87] = (40000 >> 8) & 0xff; // ICR1H

    logic.attachEvents!(el, sim as any, noPins);
    expect((el as any).angle).toBe(90);
  });

  it('calculates 0° when OCR1A = 0 (minimum pulse)', () => {
    // OCR1A=0 → pulseUs=0 → clamped to MIN_PULSE_US=544 µs → 0°
    const logic = PartSimulationRegistry.get('servo')!;
    const el = makeElement({ angle: -1 });
    const sim = makeSimulator();

    sim.cpu.data[0x86] = 40000 & 0xff;
    sim.cpu.data[0x87] = (40000 >> 8) & 0xff;
    // OCR1A = 0 (default)

    logic.attachEvents!(el, sim as any, noPins);
    expect((el as any).angle).toBe(0);
  });

  it('calculates 180° when OCR1A = ICR1 (maximum pulse)', () => {
    // 180° maximum: 2400 µs → OCR1A = 2400 / 0.5 = 4800 (ICR1=40000, 50 Hz)
    // pulseUs = (4800/40000)*20000 = 2400 µs → angle = (2400-544)/1856*180 = 180°
    const logic = PartSimulationRegistry.get('servo')!;
    const el = makeElement({ angle: -1 });
    const sim = makeSimulator();

    sim.cpu.data[0x88] = 4800 & 0xff;
    sim.cpu.data[0x89] = (4800 >> 8) & 0xff;
    sim.cpu.data[0x86] = 40000 & 0xff;
    sim.cpu.data[0x87] = (40000 >> 8) & 0xff;

    logic.attachEvents!(el, sim as any, noPins);
    expect((el as any).angle).toBe(180);
  });

  it('cleanup cancels the RAF loop', () => {
    const logic = PartSimulationRegistry.get('servo')!;
    const el = makeElement({ angle: 0 });
    const sim = makeSimulator();
    const cancelSpy = vi.spyOn(globalThis, 'cancelAnimationFrame');

    const cleanup = logic.attachEvents!(el, sim as any, noPins);
    cleanup();
    expect(cancelSpy).toHaveBeenCalled();
  });
});

// ─── Buzzer ──────────────────────────────────────────────────────────────────

describe('Buzzer — attachEvents', () => {
  // Mock Web Audio API before each test in this suite.
  // Must use a real function/class (not arrow) so `new AudioContext()` works.
  beforeEach(() => {
    const mockOscillator = {
      type: 'square',
      frequency: { value: 440, setTargetAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      disconnect: vi.fn(),
    };
    const mockGain = {
      gain: { value: 0.1 },
      connect: vi.fn(),
    };
    function MockAudioContext(this: any) {
      this.createOscillator = vi.fn().mockReturnValue(mockOscillator);
      this.createGain = vi.fn().mockReturnValue(mockGain);
      this.destination = {};
      this.currentTime = 0;
      this.close = vi.fn().mockResolvedValue(undefined);
    }
    vi.stubGlobal('AudioContext', MockAudioContext);
  });

  it('subscribes to onPwmChange and onPinChange for the buzzer pin', () => {
    const logic = PartSimulationRegistry.get('buzzer')!;
    const el = makeElement({ playing: false });
    const sim = makeSimulator();

    logic.attachEvents!(el, sim as any, pinMap({ '1': 3 }));

    expect(sim.pinManager.onPwmChange.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(sim.pinManager.onPinChange.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('creates AudioContext when PWM duty cycle goes above 0', () => {
    const logic = PartSimulationRegistry.get('buzzer')!;
    const el = makeElement({ playing: false });
    const sim = makeSimulator();

    let pwmCallback!: (pin: number, dc: number) => void;
    sim.pinManager.onPwmChange.mockImplementation(
      (_pin: number, cb: (pin: number, dc: number) => void) => {
        pwmCallback = cb;
        return () => {};
      },
    );
    sim.pinManager.onPinChange.mockReturnValue(() => {});

    // Track instantiation via a flag (AudioContext is a regular function, not a spy)
    let audioCtxCreated = false;
    const PrevMock = (globalThis as any).AudioContext;
    function TrackingCtx(this: any) {
      audioCtxCreated = true;
      PrevMock.call(this);
    }
    TrackingCtx.prototype = Object.create(PrevMock.prototype);
    vi.stubGlobal('AudioContext', TrackingCtx);

    logic.attachEvents!(el, sim as any, pinMap({ '1': 3 }));
    pwmCallback(3, 0.5); // 50% duty cycle → should start tone

    expect(audioCtxCreated).toBe(true);
  });

  it('cleanup calls unsubscribers for both PWM and digital listeners', () => {
    const unsubMock = vi.fn();
    const logic = PartSimulationRegistry.get('buzzer')!;
    const el = makeElement({ playing: false });
    const sim = makeSimulator();
    sim.pinManager.onPwmChange.mockReturnValue(unsubMock);
    sim.pinManager.onPinChange.mockReturnValue(unsubMock);

    const cleanup = logic.attachEvents!(el, sim as any, pinMap({ '1': 3 }));
    cleanup();
    expect(unsubMock).toHaveBeenCalledTimes(2);
  });

  it('returns no-op cleanup when no pin is connected', () => {
    const logic = PartSimulationRegistry.get('buzzer')!;
    const el = makeElement({ playing: false });
    const sim = makeSimulator();
    expect(() => logic.attachEvents!(el, sim as any, noPins)()).not.toThrow();
  });
});

// ─── LCD1602 ─────────────────────────────────────────────────────────────────

describe('LCD1602 — attachEvents', () => {
  const LCD_PINS = pinMap({ RS: 2, E: 3, D4: 4, D5: 5, D6: 6, D7: 7 });

  it('registers onPinChange for RS, E, D4-D7 (6 pins total)', () => {
    const logic = PartSimulationRegistry.get('lcd1602')!;
    const el = makeElement({ characters: null, cursor: false, blink: false });
    const sim = makeSimulator();

    logic.attachEvents!(el, sim as any, LCD_PINS);
    expect(sim.pinManager.onPinChange.mock.calls.length).toBe(6);
  });

  it('cleanup unsubscribes all 6 pin listeners', () => {
    const unsubMock = vi.fn();
    const logic = PartSimulationRegistry.get('lcd1602')!;
    const el = makeElement({ characters: null });
    const sim = makeSimulator();
    sim.pinManager.onPinChange.mockReturnValue(unsubMock);

    const cleanup = logic.attachEvents!(el, sim as any, LCD_PINS);
    cleanup();
    expect(unsubMock).toHaveBeenCalledTimes(6);
  });

  it('returns no-op cleanup when pinManager is unavailable', () => {
    const logic = PartSimulationRegistry.get('lcd1602')!;
    const el = makeElement({ characters: null });
    // Simulator without pinManager
    const sim = { getADC: vi.fn(), setPinState: vi.fn(), cpu: { data: new Uint8Array(512) } };
    expect(() => logic.attachEvents!(el, sim as any, LCD_PINS)()).not.toThrow();
  });
});

// ─── LCD2004 ─────────────────────────────────────────────────────────────────

describe('LCD2004 — attachEvents', () => {
  it('registers 6 pin listeners (same pinout as LCD1602)', () => {
    const logic = PartSimulationRegistry.get('lcd2004')!;
    const el = makeElement({ characters: null });
    const sim = makeSimulator();

    const pins = pinMap({ RS: 2, E: 3, D4: 4, D5: 5, D6: 6, D7: 7 });
    logic.attachEvents!(el, sim as any, pins);
    expect(sim.pinManager.onPinChange.mock.calls.length).toBe(6);
  });
});

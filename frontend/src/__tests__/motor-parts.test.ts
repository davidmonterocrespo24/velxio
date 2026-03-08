/**
 * motor-parts.test.ts
 *
 * Tests simulation logic for interactive motor/encoder components:
 *  - ky-040 rotary encoder (BasicParts.ts)
 *  - biaxial-stepper motor (BasicParts.ts)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';

// Side-effect imports — register all parts
import '../simulation/parts/BasicParts';
import '../simulation/parts/ComplexParts';
import '../simulation/parts/ChipParts';
import '../simulation/parts/SensorParts';

// ─── Mocks ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  let counter = 0;
  vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => ++counter);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  // Allow setTimeout to be called but track it (not immediately invoked)
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

function makeSimulator() {
  const pinManager = {
    onPinChange:  vi.fn().mockReturnValue(() => {}),
    onPwmChange:  vi.fn().mockReturnValue(() => {}),
    triggerPinChange: vi.fn(),
  };
  return {
    pinManager,
    setPinState: vi.fn(),
    cpu: { data: new Uint8Array(512).fill(0), cycles: 0 },
  };
}

const pinMap = (map: Record<string, number>) => (name: string): number | null =>
  name in map ? map[name] : null;

const noPins = (_name: string): number | null => null;

// ─── KY-040 Rotary Encoder ────────────────────────────────────────────────────

describe('ky-040 — registration', () => {
  it('is registered in PartSimulationRegistry', () => {
    expect(PartSimulationRegistry.get('ky-040')).toBeDefined();
  });
});

describe('ky-040 — attachEvents', () => {
  it('initialises CLK, DT HIGH and SW HIGH (not pressed) on attach', () => {
    const logic = PartSimulationRegistry.get('ky-040')!;
    const sim = makeSimulator();
    const element = makeElement();

    logic.attachEvents!(element, sim as any, pinMap({ CLK: 2, DT: 3, SW: 4 }));

    // All three pins should have been set HIGH on init
    expect(sim.setPinState).toHaveBeenCalledWith(4, true);  // SW HIGH
    expect(sim.setPinState).toHaveBeenCalledWith(2, true);  // CLK HIGH (idle)
    expect(sim.setPinState).toHaveBeenCalledWith(3, true);  // DT HIGH (idle)
  });

  it('registers event listeners for rotate-cw, rotate-ccw, button-press, button-release', () => {
    const logic = PartSimulationRegistry.get('ky-040')!;
    const sim = makeSimulator();
    const element = makeElement();

    logic.attachEvents!(element, sim as any, pinMap({ CLK: 2, DT: 3, SW: 4 }));

    const events = (element.addEventListener as ReturnType<typeof vi.fn>).mock.calls.map(
      ([event]: [string]) => event
    );
    expect(events).toContain('rotate-cw');
    expect(events).toContain('rotate-ccw');
    expect(events).toContain('button-press');
    expect(events).toContain('button-release');
  });

  it('pulses CLK with DT LOW on rotate-cw (clockwise)', () => {
    const logic = PartSimulationRegistry.get('ky-040')!;
    const sim = makeSimulator();
    const element = makeElement();

    const listeners: Record<string, (...args: any[]) => void> = {};
    (element.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
      (ev: string, handler: (...args: any[]) => void) => { listeners[ev] = handler; }
    );

    logic.attachEvents!(element, sim as any, pinMap({ CLK: 2, DT: 3, SW: 4 }));
    sim.setPinState.mockClear();

    listeners['rotate-cw']?.();

    // DT should be set LOW for CW direction
    expect(sim.setPinState).toHaveBeenCalledWith(3, false); // DT LOW
    // CLK should be set LOW first then HIGH (via setTimeout)
    expect(sim.setPinState).toHaveBeenCalledWith(2, false); // CLK pulse starts LOW
  });

  it('pulses CLK with DT HIGH on rotate-ccw (counter-clockwise)', () => {
    const logic = PartSimulationRegistry.get('ky-040')!;
    const sim = makeSimulator();
    const element = makeElement();

    const listeners: Record<string, (...args: any[]) => void> = {};
    (element.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
      (ev: string, handler: (...args: any[]) => void) => { listeners[ev] = handler; }
    );

    logic.attachEvents!(element, sim as any, pinMap({ CLK: 2, DT: 3, SW: 4 }));
    sim.setPinState.mockClear();

    listeners['rotate-ccw']?.();

    // DT should be set HIGH for CCW direction
    expect(sim.setPinState).toHaveBeenCalledWith(3, true);  // DT HIGH
    expect(sim.setPinState).toHaveBeenCalledWith(2, false); // CLK LOW
  });

  it('drives SW pin LOW on button-press and HIGH on button-release', () => {
    const logic = PartSimulationRegistry.get('ky-040')!;
    const sim = makeSimulator();
    const element = makeElement();

    const listeners: Record<string, (...args: any[]) => void> = {};
    (element.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
      (ev: string, handler: (...args: any[]) => void) => { listeners[ev] = handler; }
    );

    logic.attachEvents!(element, sim as any, pinMap({ CLK: 2, DT: 3, SW: 4 }));
    sim.setPinState.mockClear();

    listeners['button-press']?.();
    expect(sim.setPinState).toHaveBeenCalledWith(4, false); // SW active LOW

    sim.setPinState.mockClear();
    listeners['button-release']?.();
    expect(sim.setPinState).toHaveBeenCalledWith(4, true);  // SW release HIGH
  });

  it('removes all event listeners on cleanup', () => {
    const logic = PartSimulationRegistry.get('ky-040')!;
    const sim = makeSimulator();
    const element = makeElement();

    const cleanup = logic.attachEvents!(element, sim as any, pinMap({ CLK: 2, DT: 3, SW: 4 }));
    cleanup();

    expect(element.removeEventListener).toHaveBeenCalledWith('rotate-cw',      expect.any(Function));
    expect(element.removeEventListener).toHaveBeenCalledWith('rotate-ccw',     expect.any(Function));
    expect(element.removeEventListener).toHaveBeenCalledWith('button-press',   expect.any(Function));
    expect(element.removeEventListener).toHaveBeenCalledWith('button-release', expect.any(Function));
  });
});

// ─── Biaxial Stepper Motor ────────────────────────────────────────────────────

describe('biaxial-stepper — registration', () => {
  it('is registered in PartSimulationRegistry', () => {
    expect(PartSimulationRegistry.get('biaxial-stepper')).toBeDefined();
  });
});

describe('biaxial-stepper — attachEvents', () => {
  it('registers 8 coil pin-change listeners (4 per motor)', () => {
    const logic = PartSimulationRegistry.get('biaxial-stepper')!;
    const sim = makeSimulator();
    const el = makeElement() as any;
    el.outerHandAngle = 0;
    el.innerHandAngle = 0;

    logic.attachEvents!(el, sim as any, pinMap({
      'A1-': 2, 'A1+': 3, 'B1+': 4, 'B1-': 5,
      'A2-': 6, 'A2+': 7, 'B2+': 8, 'B2-': 9,
    }));

    expect(sim.pinManager.onPinChange).toHaveBeenCalledTimes(8);
  });

  it('advances outerHandAngle by 1.8° per forward step on motor 1', () => {
    const logic = PartSimulationRegistry.get('biaxial-stepper')!;
    const sim = makeSimulator();
    const el = makeElement() as any;
    el.outerHandAngle = 0;
    el.innerHandAngle = 0;

    logic.attachEvents!(el, sim as any, pinMap({
      'A1-': 2, 'A1+': 3, 'B1+': 4, 'B1-': 5,
      'A2-': 6, 'A2+': 7, 'B2+': 8, 'B2-': 9,
    }));

    // Collect handlers indexed by pin number
    const handlers: Record<number, (pin: number, s: boolean) => void> = {};
    for (const [pin, handler] of sim.pinManager.onPinChange.mock.calls) {
      handlers[pin as number] = handler;
    }

    // Full-step sequence motor 1:
    // Step 0: A1+ = HIGH
    handlers[3]?.(3, true);   // A1+ HIGH → step 0

    // Step 1: A1+ = LOW, B1+ = HIGH → forward step
    handlers[3]?.(3, false);  // A1+ LOW
    handlers[4]?.(4, true);   // B1+ HIGH → step 1

    expect(el.outerHandAngle).toBeCloseTo(1.8, 1);
  });

  it('advances innerHandAngle by 1.8° per forward step on motor 2', () => {
    const logic = PartSimulationRegistry.get('biaxial-stepper')!;
    const sim = makeSimulator();
    const el = makeElement() as any;
    el.outerHandAngle = 0;
    el.innerHandAngle = 0;

    logic.attachEvents!(el, sim as any, pinMap({
      'A1-': 2, 'A1+': 3, 'B1+': 4, 'B1-': 5,
      'A2-': 6, 'A2+': 7, 'B2+': 8, 'B2-': 9,
    }));

    const handlers: Record<number, (pin: number, s: boolean) => void> = {};
    for (const [pin, handler] of sim.pinManager.onPinChange.mock.calls) {
      handlers[pin as number] = handler;
    }

    // Step 0 for motor 2: A2+ = HIGH
    handlers[7]?.(7, true);

    // Step 1 for motor 2: A2+ = LOW, B2+ = HIGH
    handlers[7]?.(7, false);
    handlers[8]?.(8, true);

    expect(el.innerHandAngle).toBeCloseTo(1.8, 1);
  });

  it('reverses outerHandAngle when motor 1 steps backwards', () => {
    const logic = PartSimulationRegistry.get('biaxial-stepper')!;
    const sim = makeSimulator();
    const el = makeElement() as any;
    el.outerHandAngle = 0;
    el.innerHandAngle = 0;

    logic.attachEvents!(el, sim as any, pinMap({
      'A1-': 2, 'A1+': 3, 'B1+': 4, 'B1-': 5,
      'A2-': 6, 'A2+': 7, 'B2+': 8, 'B2-': 9,
    }));

    const handlers: Record<number, (pin: number, s: boolean) => void> = {};
    for (const [pin, handler] of sim.pinManager.onPinChange.mock.calls) {
      handlers[pin as number] = handler;
    }

    // Start at step 0: A1+ HIGH
    handlers[3]?.(3, true);

    // Step backwards to step 3: B1- HIGH, A1+ LOW → diff = -1 (= +3 mod 4)
    handlers[3]?.(3, false);
    handlers[5]?.(5, true);   // B1- HIGH → step 3 (backwards from step 0)

    expect(el.outerHandAngle).toBeCloseTo(360 - 1.8, 1);
  });

  it('does nothing when no coil pins are connected', () => {
    const logic = PartSimulationRegistry.get('biaxial-stepper')!;
    const sim = makeSimulator();
    const el = makeElement() as any;
    el.outerHandAngle = 0;
    el.innerHandAngle = 0;

    logic.attachEvents!(el, sim as any, noPins);

    expect(sim.pinManager.onPinChange).not.toHaveBeenCalled();
  });
});

/**
 * interactive-parts.test.ts
 *
 * Tests simulation logic for the six new components:
 *   neopixel, pir-motion-sensor, ks2e-m-dc5, hc-sr04, membrane-keypad, rotary-dialer
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';

// Side-effect imports — register all parts
import '../simulation/parts/BasicParts';
import '../simulation/parts/ComplexParts';
import '../simulation/parts/ChipParts';
import '../simulation/parts/SensorParts';

// ─── Globals ──────────────────────────────────────────────────────────────────
beforeEach(() => {
  let requestAnimationFrameCounter = 0;
  vi.stubGlobal(
    'requestAnimationFrame',
    (_cb: FrameRequestCallback) => ++requestAnimationFrameCounter,
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('setTimeout', vi.fn().mockReturnValue(1));
  vi.stubGlobal('clearTimeout', vi.fn());
  vi.stubGlobal('setInterval', vi.fn().mockReturnValue(42));
  vi.stubGlobal('clearInterval', vi.fn());
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
    onPinChange: vi.fn().mockReturnValue(() => {}),
    onPwmChange: vi.fn().mockReturnValue(() => {}),
    triggerPinChange: vi.fn(),
  };
  return {
    pinManager,
    getADC: vi.fn().mockReturnValue(null),
    setPinState: vi.fn(),
    cpu: { data: new Uint8Array(512).fill(0), cycles: 0 },
  };
}

const pinMap =
  (map: Record<string, number>) =>
  (name: string): number | null =>
    name in map ? map[name] : null;

const noPins = (_name: string): number | null => null;

// ─── Registration ─────────────────────────────────────────────────────────────

describe('Interactive parts — registration', () => {
  const NEW_IDS = [
    'neopixel',
    'pir-motion-sensor',
    'ks2e-m-dc5',
    'hc-sr04',
    'membrane-keypad',
    'rotary-dialer',
  ];

  it('registers all six new component types', () => {
    for (const id of NEW_IDS) {
      expect(PartSimulationRegistry.get(id), `missing: ${id}`).toBeDefined();
    }
  });
});

// ─── neopixel ─────────────────────────────────────────────────────────────────

describe('neopixel — attachEvents', () => {
  it('registers onPinChange listener for DIN pin', () => {
    const logic = PartSimulationRegistry.get('neopixel');
    const el = makeElement();
    const sim = makeSimulator();
    const cleanup = logic!.attachEvents!(el, sim as any, pinMap({ DIN: 4 }));
    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(4, expect.any(Function));
    cleanup();
  });

  it('returns no-op cleanup when DIN pin is not connected', () => {
    const logic = PartSimulationRegistry.get('neopixel');
    const el = makeElement();
    const sim = makeSimulator();
    const cleanup = logic!.attachEvents!(el, sim as any, noPins);
    expect(sim.pinManager.onPinChange).not.toHaveBeenCalled();
    expect(() => cleanup()).not.toThrow();
  });
});

// ─── pir-motion-sensor ────────────────────────────────────────────────────────

describe('pir-motion-sensor — attachEvents', () => {
  it('sets OUT LOW on init and registers click listener', () => {
    const logic = PartSimulationRegistry.get('pir-motion-sensor');
    const el = makeElement();
    const sim = makeSimulator();
    logic!.attachEvents!(el, sim as any, pinMap({ OUT: 7 }));

    expect(sim.setPinState).toHaveBeenCalledWith(7, false); // idle LOW
    expect(el.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
  });

  it('drives OUT HIGH on click and schedules timer for LOW', () => {
    const logic = PartSimulationRegistry.get('pir-motion-sensor');
    const el = makeElement();
    const sim = makeSimulator();
    logic!.attachEvents!(el, sim as any, pinMap({ OUT: 7 }));

    // Extract the click handler
    const clickCb = (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([event]: [string]) => event === 'click',
    )![1] as () => void;
    clickCb();

    expect(sim.setPinState).toHaveBeenCalledWith(7, true); // HIGH on click
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 3000);
  });

  it('cleans up click listener and timer on cleanup', () => {
    const logic = PartSimulationRegistry.get('pir-motion-sensor');
    const el = makeElement();
    const sim = makeSimulator();
    const cleanup = logic!.attachEvents!(el, sim as any, pinMap({ OUT: 7 }));

    // Fire a click so the timer is started
    const clickCb = (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([event]: [string]) => event === 'click',
    )![1] as () => void;
    clickCb(); // starts the 3s timer

    cleanup();
    expect(el.removeEventListener).toHaveBeenCalledWith('click', expect.any(Function));
    expect(clearTimeout).toHaveBeenCalled(); // timer is now non-null → cleared
  });

  it('returns no-op when OUT pin is not connected', () => {
    const logic = PartSimulationRegistry.get('pir-motion-sensor');
    const el = makeElement();
    const sim = makeSimulator();
    const cleanup = logic!.attachEvents!(el, sim as any, noPins);
    expect(sim.setPinState).not.toHaveBeenCalled();
    expect(() => cleanup()).not.toThrow();
  });
});

// ─── ks2e-m-dc5 (relay) ───────────────────────────────────────────────────────

describe('ks2e-m-dc5 — onPinStateChange', () => {
  it('has onPinStateChange handler but no attachEvents', () => {
    const logic = PartSimulationRegistry.get('ks2e-m-dc5');
    expect(logic).toBeDefined();
    expect(logic!.onPinStateChange).toBeTypeOf('function');
    expect(logic!.attachEvents).toBeUndefined();
  });

  it('does not throw when COIL1 goes HIGH', () => {
    const logic = PartSimulationRegistry.get('ks2e-m-dc5');
    const el = makeElement();
    expect(() => logic!.onPinStateChange!('COIL1', true, el)).not.toThrow();
  });

  it('does not throw when COIL2 goes LOW', () => {
    const logic = PartSimulationRegistry.get('ks2e-m-dc5');
    const el = makeElement();
    expect(() => logic!.onPinStateChange!('COIL2', false, el)).not.toThrow();
  });
});

// ─── hc-sr04 ──────────────────────────────────────────────────────────────────

describe('hc-sr04 — attachEvents', () => {
  it('sets ECHO LOW on init and watches TRIG pin', () => {
    const logic = PartSimulationRegistry.get('hc-sr04');
    const el = makeElement();
    const sim = makeSimulator();
    logic!.attachEvents!(el, sim as any, pinMap({ TRIG: 2, ECHO: 3 }));

    expect(sim.setPinState).toHaveBeenCalledWith(3, false); // ECHO initially LOW
    expect(sim.pinManager.onPinChange).toHaveBeenCalledWith(2, expect.any(Function));
  });

  it('fires ECHO HIGH pulse when TRIG goes HIGH', () => {
    const logic = PartSimulationRegistry.get('hc-sr04');
    const el = makeElement();
    const sim = makeSimulator();
    logic!.attachEvents!(el, sim as any, pinMap({ TRIG: 2, ECHO: 3 }));

    // Extract the onPinChange callback for TRIG
    const trigCb = (sim.pinManager.onPinChange as ReturnType<typeof vi.fn>).mock.calls.find(
      ([pin]: [number]) => pin === 2,
    )![1] as (_: number, state: boolean) => void;

    trigCb(2, true); // TRIG HIGH
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 1);
  });

  it('returns no-op when TRIG or ECHO is not connected', () => {
    const logic = PartSimulationRegistry.get('hc-sr04');
    const el = makeElement();
    const sim = makeSimulator();
    const cleanup = logic!.attachEvents!(el, sim as any, noPins);
    expect(sim.pinManager.onPinChange).not.toHaveBeenCalled();
    expect(() => cleanup()).not.toThrow();
  });
});

// ─── membrane-keypad ──────────────────────────────────────────────────────────

describe('membrane-keypad — attachEvents', () => {
  it('registers onPinChange for each connected row and button-press/release', () => {
    const logic = PartSimulationRegistry.get('membrane-keypad');
    const el = makeElement();
    const sim = makeSimulator();
    logic!.attachEvents!(
      el,
      sim as any,
      pinMap({ R1: 2, R2: 3, R3: 4, R4: 5, C1: 6, C2: 7, C3: 8, C4: 9 }),
    );

    // 4 row pin change listeners
    expect(sim.pinManager.onPinChange).toHaveBeenCalledTimes(4);
    // button-press and button-release listeners
    expect(el.addEventListener).toHaveBeenCalledWith('button-press', expect.any(Function));
    expect(el.addEventListener).toHaveBeenCalledWith('button-release', expect.any(Function));
  });

  it('drives COL LOW when ROW is LOW and matching key is pressed', () => {
    const logic = PartSimulationRegistry.get('membrane-keypad');
    const el = makeElement();
    const sim = makeSimulator();
    logic!.attachEvents!(
      el,
      sim as any,
      pinMap({ R1: 2, R2: 3, R3: 4, R4: 5, C1: 6, C2: 7, C3: 8, C4: 9 }),
    );

    // Simulate key '1' press (row=0, col=0) via button-press event
    const pressHandler = (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([ev]: [string]) => ev === 'button-press',
    )![1] as (e: Event) => void;
    pressHandler(new CustomEvent('button-press', { detail: { key: '1', row: 0, column: 0 } }));

    // Simulate row R1 going LOW (scanned by Arduino)
    const rowCb = (sim.pinManager.onPinChange as ReturnType<typeof vi.fn>).mock.calls.find(
      ([pin]: [number]) => pin === 2, // R1
    )![1] as (_: number, state: boolean) => void;
    rowCb(2, false); // R1 LOW

    // C1 (pin 6) should be driven LOW
    expect(sim.setPinState).toHaveBeenCalledWith(6, false);
  });

  it('releases COL HIGH when ROW returns HIGH', () => {
    const logic = PartSimulationRegistry.get('membrane-keypad');
    const el = makeElement();
    const sim = makeSimulator();
    logic!.attachEvents!(
      el,
      sim as any,
      pinMap({ R1: 2, R2: 3, R3: 4, R4: 5, C1: 6, C2: 7, C3: 8, C4: 9 }),
    );

    // Scan R1 low (no keys pressed)
    const rowCb = (sim.pinManager.onPinChange as ReturnType<typeof vi.fn>).mock.calls.find(
      ([pin]: [number]) => pin === 2,
    )![1] as (_: number, state: boolean) => void;
    rowCb(2, false); // R1 LOW
    rowCb(2, true); // R1 HIGH

    // All cols must have been set HIGH at some point
    expect(sim.setPinState).toHaveBeenCalledWith(6, true);
  });

  it('cleans up all listeners on cleanup', () => {
    const logic = PartSimulationRegistry.get('membrane-keypad');
    const el = makeElement();
    const sim = makeSimulator();
    const cleanup = logic!.attachEvents!(
      el,
      sim as any,
      pinMap({ R1: 2, R2: 3, R3: 4, R4: 5, C1: 6, C2: 7, C3: 8, C4: 9 }),
    );
    cleanup();
    expect(el.removeEventListener).toHaveBeenCalledWith('button-press', expect.any(Function));
    expect(el.removeEventListener).toHaveBeenCalledWith('button-release', expect.any(Function));
  });
});

// ─── rotary-dialer ────────────────────────────────────────────────────────────

describe('rotary-dialer — attachEvents', () => {
  it('initialises DIAL and PULSE HIGH (idle)', () => {
    const logic = PartSimulationRegistry.get('rotary-dialer');
    const el = makeElement();
    const sim = makeSimulator();
    logic!.attachEvents!(el, sim as any, pinMap({ DIAL: 10, PULSE: 11 }));

    expect(sim.setPinState).toHaveBeenCalledWith(10, true);
    expect(sim.setPinState).toHaveBeenCalledWith(11, true);
  });

  it('registers dial-start and dial-end event listeners', () => {
    const logic = PartSimulationRegistry.get('rotary-dialer');
    const el = makeElement();
    const sim = makeSimulator();
    logic!.attachEvents!(el, sim as any, pinMap({ DIAL: 10, PULSE: 11 }));

    expect(el.addEventListener).toHaveBeenCalledWith('dial-start', expect.any(Function));
    expect(el.addEventListener).toHaveBeenCalledWith('dial-end', expect.any(Function));
  });

  it('drives DIAL LOW on dial-start', () => {
    const logic = PartSimulationRegistry.get('rotary-dialer');
    const el = makeElement();
    const sim = makeSimulator();
    logic!.attachEvents!(el, sim as any, pinMap({ DIAL: 10, PULSE: 11 }));

    const startCb = (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([ev]: [string]) => ev === 'dial-start',
    )![1] as () => void;
    startCb();

    expect(sim.setPinState).toHaveBeenCalledWith(10, false); // DIAL LOW
  });

  it('schedules pulse train on dial-end', () => {
    const logic = PartSimulationRegistry.get('rotary-dialer');
    const el = makeElement();
    const sim = makeSimulator();
    logic!.attachEvents!(el, sim as any, pinMap({ DIAL: 10, PULSE: 11 }));

    const endCb = (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([ev]: [string]) => ev === 'dial-end',
    )![1] as (e: Event) => void;
    endCb(new CustomEvent('dial-end', { detail: { digit: 3 } }));

    // setTimeout should have been scheduled to start the pulse train
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 100);
  });

  it('returns no-op cleanup when pins are not connected', () => {
    const logic = PartSimulationRegistry.get('rotary-dialer');
    const el = makeElement();
    const sim = makeSimulator();
    const cleanup = logic!.attachEvents!(el, sim as any, noPins);
    expect(sim.setPinState).not.toHaveBeenCalled();
    expect(() => cleanup()).not.toThrow();
  });
});

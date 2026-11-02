/**
 * interactive-parts.test.ts
 *
 * Tests simulation logic for the six new components:
 *   neopixel, pir-motion-sensor, ks2e-m-dc5, hc-sr04, membrane-keypad, rotary-dialer
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { LineSensorHub } from '../simulation/line/LineSensorHub';
import type { LineHostPort } from '../simulation/line/LineHost';
import { INITIAL_PAD, type PadEvent, type PadState } from '../simulation/line/padEvent';
import { clearLineGaps, lineGaps } from '../simulation/line/requestLine';
import { installPartTimeout } from '../simulation/parts/partUtils';

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

  it('times its pulse through partTimeout, so an overlay can count it on the board clock', () => {
    const asked: Array<[unknown, number]> = [];
    let cancelled = 0;
    installPartTimeout((simulator, _cb, ms) => {
      asked.push([simulator, ms]);
      return () => {
        cancelled++;
      };
    });
    try {
      const logic = PartSimulationRegistry.get('pir-motion-sensor');
      const el = makeElement();
      const sim = makeSimulator();
      const cleanup = logic!.attachEvents!(el, sim as any, pinMap({ OUT: 7 }));
      const clickCb = (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
        ([event]: [string]) => event === 'click',
      )![1] as () => void;
      clickCb();
      expect(asked).toEqual([[sim, 3000]]);
      // A second motion during the pulse cancels the first end and starts its 3 s again.
      clickCb();
      expect(cancelled).toBe(1);
      expect(asked).toHaveLength(2);
      cleanup();
      expect(cancelled).toBe(2);
      expect(setTimeout).not.toHaveBeenCalled();
    } finally {
      installPartTimeout(null);
    }
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

describe('hc-sr04 — attachEvents (the line contract)', () => {
  function makeLineSim() {
    const listeners = new Map<number, Set<(e: PadEvent) => void>>();
    const port: LineHostPort & { edges: Array<[number, boolean, number]>; rests: Array<[number, boolean, boolean]> } = {
      edges: [],
      rests: [],
      now: () => 5_000,
      clockHz: () => 16e6,
      scheduleEdge: (pin, level, at) => port.edges.push([pin, level, at]),
      onPad: (pin, cb) => {
        if (!listeners.has(pin)) listeners.set(pin, new Set());
        listeners.get(pin)!.add(cb);
        return () => listeners.get(pin)!.delete(cb);
      },
      restPad: (pin, level, driven) => port.rests.push([pin, level, driven]),
    };
    const hub = new LineSensorHub(port);
    const sim = {
      ...makeSimulator(),
      lineSupport: () => ({ mode: 'local' as const }),
      lineHub: () => hub,
      guest(pin: number, drive: PadState['drive'], prevDrive: PadState['drive'] = 'z') {
        const prev: PadState = { ...INITIAL_PAD, drive: prevDrive };
        const next: PadState = { drive, pull: 0, level: drive !== 'low', cycle: 5_000 };
        listeners.get(pin)?.forEach((cb) => cb({ pin, ...next, prev }));
      },
    };
    return { sim, hub, port };
  }

  it('asks the board to host it, rests ECHO low, and owns ECHO', () => {
    const logic = PartSimulationRegistry.get('hc-sr04');
    const { sim, hub, port } = makeLineSim();
    logic!.attachEvents!(makeElement(), sim as any, pinMap({ TRIG: 2, ECHO: 3 }), 'sr04-1');
    expect(port.rests).toEqual([[3, false, true]]);
    expect(hub.ownsPin(3)).toBe(true);
    expect(hub.ownsPin(2)).toBe(false);
  });

  it('answers a TRIG rise with the two-edge ECHO pulse', () => {
    const logic = PartSimulationRegistry.get('hc-sr04');
    const { sim, port } = makeLineSim();
    logic!.attachEvents!(makeElement(), sim as any, pinMap({ TRIG: 2, ECHO: 3 }), 'sr04-2');
    sim.guest(2, 'high', 'low');
    expect(port.edges).toEqual([
      [3, true, 5_000 + 16 * 600],
      [3, false, 5_000 + 16 * 600 + Math.round((10 / 17150) * 16e6)],
    ]);
  });

  it('returns no-op when TRIG or ECHO is not connected', () => {
    const logic = PartSimulationRegistry.get('hc-sr04');
    const { sim, hub } = makeLineSim();
    const cleanup = logic!.attachEvents!(makeElement(), sim as any, noPins, 'sr04-3');
    expect(hub.size).toBe(0);
    expect(() => cleanup()).not.toThrow();
  });

  it('refuses out loud on a board with no line support', () => {
    clearLineGaps();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logic = PartSimulationRegistry.get('hc-sr04');
    const sim = makeSimulator();
    logic!.attachEvents!(makeElement(), sim as any, pinMap({ TRIG: 2, ECHO: 3 }), 'sr04-4');
    expect(sim.setPinState).not.toHaveBeenCalled();
    expect(lineGaps().map((g) => g.sensorType)).toEqual(['hc-sr04']);
    warn.mockRestore();
  });
});

// ─── membrane-keypad ──────────────────────────────────────────────────────────

// The matrix itself is a line model, tested against the real avr8js and
// rp2040js engines in simulation/line/__tests__/matrixKeypad.test.ts and
// against the real Keypad library in membrane-keypad-real-firmware.test.ts.
// What belongs here is the part: which wires it declares and what it sends.
describe('membrane-keypad — attachEvents', () => {
  const ALL_PINS = { R1: 2, R2: 3, R3: 4, R4: 5, C1: 6, C2: 7, C3: 8, C4: 9 };

  function attach(pins: Record<string, number>) {
    const logic = PartSimulationRegistry.get('membrane-keypad');
    const el = makeElement();
    const sim = {
      ...makeSimulator(),
      lineSupport: () => ({ mode: 'hosted' as const }),
      registerSensor: vi.fn().mockReturnValue(true),
      updateSensor: vi.fn(),
      unregisterSensor: vi.fn(),
    };
    const cleanup = logic!.attachEvents!(el, sim as any, pinMap(pins), 'keypad-1');
    return { el, sim, cleanup };
  }

  const handler = (el: HTMLElement, name: string) =>
    (el.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([ev]: [string]) => ev === name,
    )![1] as (e: Event) => void;

  it('asks the board for the matrix, naming every wire in order', () => {
    const { sim } = attach(ALL_PINS);
    expect(sim.registerSensor).toHaveBeenCalledWith(
      'matrix-keypad',
      2, // the first wired pin is the record's anchor
      expect.objectContaining({ rows: [2, 3, 4, 5], cols: [6, 7, 8, 9] }),
    );
  });

  it('an unwired row or column is declared as such, not skipped out of position', () => {
    // The model indexes rows and columns by position: dropping R2 would make
    // every key below it read one row too high.
    const { sim } = attach({ R1: 2, R3: 4, R4: 5, C1: 6, C2: 7, C3: 8, C4: 9 });
    expect(sim.registerSensor).toHaveBeenCalledWith(
      'matrix-keypad',
      2,
      expect.objectContaining({ rows: [2, -1, 4, 5], cols: [6, 7, 8, 9] }),
    );
  });

  it('sends the held keys, and only those, on press and release', () => {
    const { el, sim } = attach(ALL_PINS);
    handler(el, 'button-press')(
      new CustomEvent('button-press', { detail: { key: '1', row: 0, column: 0 } }),
    );
    expect(sim.updateSensor).toHaveBeenLastCalledWith(2, expect.objectContaining({ pressed: [[0, 0]] }));
    handler(el, 'button-press')(
      new CustomEvent('button-press', { detail: { key: '6', row: 1, column: 2 } }),
    );
    expect(sim.updateSensor).toHaveBeenLastCalledWith(
      2,
      expect.objectContaining({ pressed: [[0, 0], [1, 2]] }),
    );
    handler(el, 'button-release')(
      new CustomEvent('button-release', { detail: { key: '1', row: 0, column: 0 } }),
    );
    expect(sim.updateSensor).toHaveBeenLastCalledWith(2, expect.objectContaining({ pressed: [[1, 2]] }));
  });

  it('asks for nothing when no wire reaches a board', () => {
    const { sim, el } = attach({});
    expect(sim.registerSensor).not.toHaveBeenCalled();
    expect(el.addEventListener).not.toHaveBeenCalledWith('button-press', expect.any(Function));
  });

  it('releases the line and its listeners on cleanup', () => {
    const { el, sim, cleanup } = attach(ALL_PINS);
    cleanup();
    expect(sim.unregisterSensor).toHaveBeenCalledWith(2);
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

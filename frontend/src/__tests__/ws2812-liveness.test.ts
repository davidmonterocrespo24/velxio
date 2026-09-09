// @vitest-environment jsdom
/**
 * The WS2812 liveness report, and the correction that keeps it honest.
 *
 * The warning exists because a NeoPixel driven through a hardware peripheral
 * the engine does not decode stays black in complete silence — the failure
 * that started this whole line of work. But its six-second grace cannot tell
 * that apart from a guest that has simply not booted yet: an ESP32-P4 needs
 * well over a minute to reach its first show(), and the warning is already
 * out by then, telling the user a diagnosis that is wrong for their board.
 *
 * So the contract is two-sided: warn when nothing arrives, and take it back
 * when something does. This file drives the store the part subscribes to,
 * which the other sensor-part tests deliberately leave inert.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StoreState = { hexEpoch?: number; running?: boolean };
const listeners: Array<(s: StoreState) => void> = [];
let state: StoreState = { hexEpoch: 0, running: false };

// Keep every other export of the store module (SensorParts imports helpers
// from it too); only the store object itself is ours.
vi.mock('../store/useSimulatorStore', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const useSimulatorStore = (() => state) as unknown as {
    subscribe: (fn: (s: StoreState) => void) => () => void;
    getState: () => StoreState;
  };
  useSimulatorStore.subscribe = (fn: (s: StoreState) => void) => {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  };
  useSimulatorStore.getState = () => state;
  return { ...actual, useSimulatorStore };
});

/** Press Run: bump the epoch and tell every subscriber. */
function pressRun(epoch: number): void {
  state = { hexEpoch: epoch, running: true };
  for (const fn of [...listeners]) fn(state);
}

/** Press Stop: the run ends, the epoch stays where it was. */
function pressStop(): void {
  state = { ...state, running: false };
  for (const fn of [...listeners]) fn(state);
}

/** A board whose engine hands whole decoded frames to the part (ESP32 RMT). */
function makeRmtSimulator() {
  const sinks = new Map<number, (px: Array<{ r: number; g: number; b: number }>) => void>();
  return {
    pinManager: { onPinChange: vi.fn(), offPinChange: vi.fn() },
    subscribeWs2812: vi.fn((pin: number, fn: (px: never[]) => void) => {
      sinks.set(pin, fn as never);
      return () => sinks.delete(pin);
    }),
    emitFrame: (pin: number, px: Array<{ r: number; g: number; b: number }>) =>
      sinks.get(pin)?.(px),
  };
}

const makeElement = () => ({ r: 0, g: 0, b: 0 }) as Record<string, unknown>;
const pinMap =
  (map: Record<string, number>) =>
  (name: string): number | null =>
    name in map ? map[name] : null;

describe('WS2812 liveness report', () => {
  let faults: Array<{ kind?: string; message?: string; severity?: string }>;
  const onFault = (e: Event) =>
    faults.push((e as CustomEvent).detail as {
      kind?: string;
      message?: string;
      severity?: string;
    });

  beforeEach(() => {
    vi.useFakeTimers();
    faults = [];
    listeners.length = 0;
    state = { hexEpoch: 0, running: false };
    window.addEventListener('velxio-circuit-fault', onFault);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    window.removeEventListener('velxio-circuit-fault', onFault);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function attach() {
    // Side-effect import: parts register themselves on load.
    await import('../simulation/parts/SensorParts');
    const { PartSimulationRegistry } = await import('../simulation/parts/PartSimulationRegistry');
    const logic = PartSimulationRegistry.get('neopixel')!;
    const sim = makeRmtSimulator();
    logic.attachEvents!(makeElement() as never, sim as never, pinMap({ DIN: 6 }) as never, 'npx-1');
    return sim;
  }

  it('says so when a whole run goes by with no pixel frame', async () => {
    await attach();
    pressRun(1);
    vi.advanceTimersByTime(6000);

    const warn = faults.find((f) => f.kind === 'no-pixel-data');
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('DIN 6');
  });

  it('stays quiet when a frame arrives inside the grace', async () => {
    const sim = await attach();
    pressRun(1);
    sim.emitFrame(6, [{ r: 255, g: 0, b: 0 }]);
    vi.advanceTimersByTime(6000);

    expect(faults.find((f) => f.kind === 'no-pixel-data')).toBeUndefined();
  });

  it('takes the warning back when the slow board finally paints', async () => {
    const sim = await attach();
    pressRun(1);
    vi.advanceTimersByTime(6000);
    expect(faults.find((f) => f.kind === 'no-pixel-data')).toBeDefined();

    // An ESP32-P4 gets here a minute into the run, long after the warning.
    vi.advanceTimersByTime(60_000);
    sim.emitFrame(6, [{ r: 255, g: 0, b: 0 }]);

    const late = faults.find((f) => f.kind === 'pixel-data-late');
    expect(late).toBeDefined();
    // Not a fault: the agent panel counts 'error' lines and would announce a
    // failed compile over a build that worked.
    expect(late!.severity).toBe('info');
    expect(faults.find((f) => f.kind === 'no-pixel-data')!.severity).toBe('warning');
    expect(late!.message).toContain('DIN 6');
    expect(late!.message).toMatch(/disregard the warning above/);
  });

  it('corrects once, not on every frame of the animation', async () => {
    const sim = await attach();
    pressRun(1);
    vi.advanceTimersByTime(6000);
    for (let i = 0; i < 5; i++) sim.emitFrame(6, [{ r: i, g: 0, b: 0 }]);

    expect(faults.filter((f) => f.kind === 'pixel-data-late')).toHaveLength(1);
  });
});

/**
 * A WS2812 latches its frame in the pixel itself, and both of the sources the
 * part listens to are edge-triggered — so Stop, which is a power cut, used to
 * leave the strip glowing on the canvas until the next Run overwrote it.
 */
describe('WS2812 on Stop', () => {
  beforeEach(() => {
    listeners.length = 0;
    state = { hexEpoch: 0, running: false };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function attachPart(type: string, el: Record<string, unknown>, pins: Record<string, number>) {
    await import('../simulation/parts/SensorParts');
    const { PartSimulationRegistry } = await import('../simulation/parts/PartSimulationRegistry');
    const logic = PartSimulationRegistry.get(type)!;
    const sim = makeRmtSimulator();
    const detach = logic.attachEvents!(el as never, sim as never, pinMap(pins) as never, `${type}-1`);
    return { sim, detach };
  }

  it('blanks the pixel when the run stops', async () => {
    const el = makeElement();
    const { sim } = await attachPart('neopixel', el, { DIN: 6 });
    pressRun(1);
    sim.emitFrame(6, [{ r: 200, g: 0, b: 120 }]);
    expect(el.r).toBeGreaterThan(0);

    pressStop();

    expect(el).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it('blanks every pixel a strip lit, not just the first', async () => {
    const painted: Array<{ r: number; g: number; b: number }> = [];
    const el = {
      setPixel: (index: number, px: { r: number; g: number; b: number }) => {
        painted[index] = px;
      },
    } as unknown as Record<string, unknown>;
    const { sim } = await attachPart('led-ring', el, { DIN: 6 });
    pressRun(1);
    sim.emitFrame(6, [
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 },
    ]);

    pressStop();

    expect(painted).toHaveLength(3);
    for (const px of painted) expect(px).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('leaves a detached part alone — no writes after unmount', async () => {
    const el = makeElement();
    const { sim, detach } = await attachPart('neopixel', el, { DIN: 6 });
    pressRun(1);
    sim.emitFrame(6, [{ r: 200, g: 0, b: 120 }]);
    detach();
    el.r = 0.5; // whatever the canvas holds after the part is gone

    pressStop();

    expect(el.r).toBe(0.5);
  });
});

/**
 * The KY-040's edges are placed on the guest's clock (velxio/velxio-prod#157).
 *
 * A detent is DT set to the direction, a CLK pulse, and DT back. The part
 * used to time the pulse with two setTimeout(1) calls, while the Uno only
 * runs inside its animation frames: when both timers fired between two
 * frames, which is what a light frame does, the guest saw CLK go LOW and
 * then, a frame later, LOW again, and never the HIGH between. Measured in
 * Chromium on the gallery example, the sketch saw the pulse in 1 to 3 of 40
 * clicks, and an interrupt reader counted every click backwards. On a board
 * whose simulator places edges at guest cycles (schedulePinChange, like the
 * DHT22 and the line models) the edges now go there, a few milliseconds of
 * guest time apart, whatever the frames and the host timers do.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/BasicParts';

/** RJMP .-2 at address 0: the guest idles; the test reads its pins. */
const RJMP_SELF_HEX = ':02000000FFCF30\n:00000001FF\n';
/** PIND: what the guest reads on Uno pins 0-7. */
const PIND = 0x29;
const CLK = 2;
const DT = 3;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Level = { ms: number; clk: boolean; dt: boolean };

function uno() {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const sim = new AVRSimulator(new PinManager());
  sim.loadHex(RJMP_SELF_HEX);
  const listeners: Record<string, () => void> = {};
  const element = {
    addEventListener: (ev: string, fn: () => void) => {
      listeners[ev] = fn;
    },
    removeEventListener: () => {},
  } as unknown as HTMLElement;
  const pins: Record<string, number> = { CLK, DT, SW: 4 };
  PartSimulationRegistry.get('ky-040')!.attachEvents!(element, sim as never, (n: string) => pins[n] ?? null);
  const data = (sim as unknown as { cpu: { data: Uint8Array } }).cpu.data;
  const trace: Level[] = [];
  const sample = () => {
    const v = data[PIND]!;
    const now = { ms: sim.getCurrentCycles() / 16_000, clk: !!(v & (1 << CLK)), dt: !!(v & (1 << DT)) };
    const last = trace.at(-1);
    if (!last || last.clk !== now.clk || last.dt !== now.dt) trace.push(now);
  };
  /** One animation frame: the guest runs `ms` of its own time, instruction by instruction. */
  const frame = (ms: number) => {
    const end = sim.getCurrentCycles() + ms * 16_000;
    while (sim.getCurrentCycles() < end) {
      sim.step();
      sample();
    }
  };
  sample();
  return { listeners, frame, trace };
}

/** Rising edges of CLK the guest saw, with DT at that moment. */
function risesOf(trace: Level[]): Array<{ ms: number; dt: boolean; highMs: number }> {
  const out: Array<{ ms: number; dt: boolean; highMs: number }> = [];
  for (let i = 1; i < trace.length; i++) {
    if (!trace[i - 1]!.clk && trace[i]!.clk) {
      const fall = trace.slice(i + 1).find((l) => !l.clk);
      out.push({ ms: trace[i]!.ms, dt: trace[i]!.dt, highMs: (fall?.ms ?? Infinity) - trace[i]!.ms });
    }
  }
  return out;
}

describe('KY-040 edges on the guest clock (velxio/velxio-prod#157)', () => {
  it('light frames: the guest sees the CLK pulse of every click, DT LOW for clockwise', () => {
    vi.useFakeTimers();
    const { listeners, frame, trace } = uno();
    frame(5);
    for (let click = 0; click < 3; click++) {
      listeners['rotate-cw']!();
      // A light frame: the guest runs 16 ms, then the host's timers all fire
      // in the idle gap before the next one.
      frame(16);
      vi.advanceTimersByTime(16);
      frame(16);
      vi.advanceTimersByTime(16);
    }
    const rises = risesOf(trace);
    expect(rises.map((r) => r.dt)).toEqual([false, false, false]);
    // Long enough for a polling loop that prints between two reads.
    for (const r of rises) expect(r.highMs).toBeGreaterThanOrEqual(4);
  });

  it('counter-clockwise: DT is HIGH at the CLK rise', () => {
    vi.useFakeTimers();
    const { listeners, frame, trace } = uno();
    frame(5);
    listeners['rotate-ccw']!();
    frame(16);
    vi.advanceTimersByTime(16);
    frame(16);
    expect(risesOf(trace).map((r) => r.dt)).toEqual([true]);
  });

  it('clicks that arrive together are queued, not merged into one pulse', () => {
    vi.useFakeTimers();
    const { listeners, frame, trace } = uno();
    frame(5);
    listeners['rotate-cw']!();
    listeners['rotate-cw']!();
    listeners['rotate-ccw']!();
    frame(60);
    const rises = risesOf(trace);
    expect(rises.map((r) => r.dt)).toEqual([false, false, true]);
    for (let i = 1; i < rises.length; i++) expect(rises[i]!.ms - rises[i - 1]!.ms).toBeGreaterThanOrEqual(10);
  });
});

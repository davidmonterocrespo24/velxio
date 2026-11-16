/**
 * The KY-040 puts out quadrature (velxio/velxio-prod#156).
 *
 * An incremental encoder's A and B (CLK and DT) are square waves 90 degrees
 * apart: in normal operation the two never change together, and each detent
 * of a KY-040 is one full cycle of the 2-bit Gray code, both lines back HIGH
 * on their pull-ups at rest. Turning clockwise, CLK goes LOW first and then
 * DT; counter-clockwise, DT first (Wokwi's wokwi-ky-040, the same element).
 * The model set DT to the direction and pulsed CLK: counter-clockwise DT
 * never moved, the first clockwise click moved both lines at once, and CLK
 * rested LOW after the first click. Only "read DT when CLK rises" counted
 * right; Wokwi's own reference reader (DT on CLK falling, HIGH = clockwise)
 * and a 4-state decoder, the book's and the Encoder library's way, counted
 * wrong or not at all.
 *
 * Real AVRSimulator: the edges reach the guest at their guest cycles and the
 * test reads them back from PIND, as a sketch would.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/BasicParts';

/** RJMP .-2 at address 0: the guest idles; the test reads its pins. */
const RJMP_SELF_HEX = ':02000000FFCF30\n:00000001FF\n';
const PIND = 0x29;
const CLK = 2;
const DT = 3;

afterEach(() => vi.unstubAllGlobals());

/** (CLK, DT) as two bits, CLK the high one: 3 = both HIGH. */
type State = number;

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
  PartSimulationRegistry.get('ky-040')!.attachEvents!(element, sim as never, (n: string) => pins[n] ?? null, 'enc1');
  const data = (sim as unknown as { cpu: { data: Uint8Array } }).cpu.data;
  const states: State[] = [];
  const read = (): State => {
    const v = data[PIND]!;
    return ((v >> CLK) & 1) * 2 + ((v >> DT) & 1);
  };
  const run = (ms: number) => {
    const end = sim.getCurrentCycles() + ms * 16_000;
    while (sim.getCurrentCycles() < end) {
      sim.step();
      const s = read();
      if (states.at(-1) !== s) states.push(s);
    }
  };
  run(1);
  return { listeners, run, states };
}

/** A 4-state (x4) decoder: +1 per step one way, -1 the other, counting illegal jumps. */
function x4(states: State[]): { count: number; illegal: number } {
  // Gray order clockwise with CLK leading: 11 -> 01 -> 00 -> 10 -> 11.
  const order = [3, 1, 0, 2];
  let count = 0;
  let illegal = 0;
  for (let i = 1; i < states.length; i++) {
    const d = (order.indexOf(states[i]!) - order.indexOf(states[i - 1]!) + 4) % 4;
    if (d === 1) count++;
    else if (d === 3) count--;
    else if (d === 2) illegal++;
  }
  return { count, illegal };
}

/** Wokwi's reference reader: on a CLK falling edge, DT HIGH is clockwise. */
function wokwiReader(states: State[]): number {
  let pos = 0;
  for (let i = 1; i < states.length; i++) {
    const clkWas = states[i - 1]! >> 1;
    const clkNow = states[i]! >> 1;
    if (clkWas === 1 && clkNow === 0) pos += states[i]! & 1 ? 1 : -1;
  }
  return pos;
}

/** The gallery's reader: on a CLK rising edge, DT LOW is clockwise. */
function risingReader(states: State[]): number {
  let pos = 0;
  for (let i = 1; i < states.length; i++) {
    if ((states[i - 1]! >> 1) === 0 && states[i]! >> 1 === 1) pos += states[i]! & 1 ? -1 : 1;
  }
  return pos;
}

describe('KY-040 quadrature (velxio/velxio-prod#156)', () => {
  it('a clockwise click is one Gray cycle with CLK leading, both lines back HIGH', () => {
    const { listeners, run, states } = uno();
    listeners['rotate-cw']!();
    run(40);
    expect(states).toEqual([3, 1, 0, 2, 3]);
  });

  it('a counter-clockwise click is the same cycle with DT leading', () => {
    const { listeners, run, states } = uno();
    listeners['rotate-ccw']!();
    run(40);
    expect(states).toEqual([3, 2, 0, 1, 3]);
  });

  it('every reader counts 10 clockwise and 6 counter-clockwise clicks as +4 detents', () => {
    const { listeners, run, states } = uno();
    for (let i = 0; i < 10; i++) {
      listeners['rotate-cw']!();
      run(7);
    }
    for (let i = 0; i < 6; i++) {
      listeners['rotate-ccw']!();
      run(7);
    }
    // Sixteen detents queue up at 20 ms each: let the last one finish.
    run(400);
    const decoded = x4(states);
    expect(decoded.illegal).toBe(0);
    expect(decoded.count).toBe(4 * 4);
    expect(wokwiReader(states)).toBe(4);
    expect(risingReader(states)).toBe(4);
    expect(states.at(-1)).toBe(3);
  });
});

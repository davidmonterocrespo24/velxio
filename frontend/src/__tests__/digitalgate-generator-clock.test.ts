/**
 * The digital gate engine runs a signal generator as the waveform it is set to
 * (velxio/velxio-prod#146).
 *
 * The engine claims every board-less circuit made of gates, flip-flops,
 * switches, resistors, LEDs and generators, and ngspice then skips it. It
 * stamped every generator's SIG as a constant STRONG 1, whatever its waveform,
 * frequency, amplitude or offset, and ran no clock: a T flip-flop clocked by a
 * 1 Hz square generator saw no edge in 2.5 s and its LED never toggled, while
 * a 74HC flip-flop changes state on each rising clock edge (TI SN74HC74), and
 * a generator set to 0 V DC was a logic 1.
 *
 * A generator is now its waveform against the gates' 2.5 V threshold (DC: the
 * offset; square: PULSE(offset - amplitude, offset + amplitude), HIGH for the
 * first half period; sine: SIN(offset, amplitude, f)), the network keeps its
 * own time and `advance` applies every generator edge in order, and the
 * canvas controller runs that clock frame by frame while the circuit is not
 * frozen.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetBusNets } from '../simulation/customChips/busNets';
import {
  buildDigitalNetwork,
  generatorWave,
  type DigitalComponent,
  type DigitalWire,
} from '../simulation/digital/digitalGateEngine';

const W = (a: string, ap: string, b: string, bp: string): DigitalWire => ({
  start: { componentId: a, pinName: ap },
  end: { componentId: b, pinName: bp },
});
const rail: DigitalComponent = {
  id: 'pwr',
  metadataId: 'signal-generator',
  properties: { waveform: 'dc', offset: 5, amplitude: 0, frequency: 1 },
};
/** A 0..5 V square at `hz`: amplitude 2.5 on a 2.5 V offset. */
const square = (id: string, hz: number): DigitalComponent => ({
  id,
  metadataId: 'signal-generator',
  properties: { waveform: 'square', frequency: hz, amplitude: 2.5, offset: 2.5 },
});

beforeEach(() => resetBusNets());

/** T flip-flop with T tied HIGH, CLK from generator `clk`, LED on Q. */
function toggler(clk: DigitalComponent) {
  const comps: DigitalComponent[] = [
    rail,
    clk,
    { id: 'ff', metadataId: 'flip-flop-t' },
    { id: 'rq', metadataId: 'resistor', properties: { value: '220' } },
    { id: 'led', metadataId: 'led' },
  ];
  const wires = [
    W('pwr', 'SIG', 'ff', 'T'),
    W(clk.id, 'SIG', 'ff', 'CLK'),
    W(clk.id, 'GND', 'pwr', 'GND'),
    W('ff', 'Q', 'rq', '1'),
    W('rq', '2', 'led', 'A'),
    W('led', 'C', 'pwr', 'GND'),
  ];
  return buildDigitalNetwork(comps, wires);
}

describe('a generator in the digital engine is its waveform', () => {
  it('a T flip-flop clocked by a 1 Hz square toggles on each rising edge', () => {
    const net = toggler(square('clk', 1));
    expect(net.ok).toBe(true);
    const Q = net.netOf('ff', 'Q')!;
    const seen: number[] = [];
    // The square is HIGH for [0, 0.5) s of each period: rising edges at 1, 2, 3 s.
    for (const t of [0.9, 1.1, 1.9, 2.1, 2.9, 3.1]) {
      net.advance(t);
      seen.push(net.readNet(Q));
    }
    expect(seen).toEqual([0, 1, 1, 0, 0, 1]);
    expect(net.readLed('led')).toBe(1);
  });

  it('a 2-bit ripple counter clocked by the generator counts', () => {
    const comps: DigitalComponent[] = [
      rail,
      square('clk', 10),
      { id: 'ff0', metadataId: 'flip-flop-t' },
      { id: 'ff1', metadataId: 'flip-flop-t' },
    ];
    const wires = [
      W('clk', 'SIG', 'ff0', 'CLK'),
      W('clk', 'GND', 'pwr', 'GND'),
      W('pwr', 'SIG', 'ff0', 'T'),
      W('pwr', 'SIG', 'ff1', 'T'),
      W('ff0', 'Qbar', 'ff1', 'CLK'),
    ];
    const net = buildDigitalNetwork(comps, wires);
    const Q0 = net.netOf('ff0', 'Q')!;
    const Q1 = net.netOf('ff1', 'Q')!;
    const counts: number[] = [];
    // 10 Hz: rising edges at 0.1, 0.2, ... s.
    for (let k = 1; k <= 5; k++) {
      net.advance(k * 0.1 + 0.05);
      counts.push(net.readNet(Q0) + 2 * net.readNet(Q1));
    }
    expect(counts).toEqual([1, 2, 3, 0, 1]);
  });

  it('a generator on 0 V DC is a logic 0, not the 5 V rail', () => {
    const comps: DigitalComponent[] = [
      rail,
      { id: 'g0', metadataId: 'signal-generator', properties: { waveform: 'dc', offset: 0, amplitude: 0, frequency: 1 } },
      { id: 'u1', metadataId: 'logic-gate-buffer' },
    ];
    const wires = [W('g0', 'SIG', 'u1', 'A'), W('g0', 'GND', 'pwr', 'GND')];
    const net = buildDigitalNetwork(comps, wires);
    expect(net.readNet(net.netOf('u1', 'Y')!)).toBe(0);
  });

  it('a sine is HIGH where it is above 2.5 V', () => {
    // 5 V peak on 0 V at 1 Hz: above 2.5 V for t in [1/12, 5/12] s of each period.
    const sine: DigitalComponent = {
      id: 'sg',
      metadataId: 'signal-generator',
      properties: { waveform: 'sine', frequency: 1, amplitude: 5, offset: 0 },
    };
    const comps: DigitalComponent[] = [rail, sine, { id: 'u1', metadataId: 'logic-gate-not' }];
    const net = buildDigitalNetwork(comps, [W('sg', 'SIG', 'u1', 'A'), W('sg', 'GND', 'pwr', 'GND')]);
    const Y = net.netOf('u1', 'Y')!;
    const at = (t: number) => {
      net.advance(t);
      return net.readNet(Y);
    };
    expect([at(0.05), at(0.1), at(0.4), at(0.45), at(1.1), at(1.45)]).toEqual([1, 0, 0, 1, 0, 1]);
  });

  it('reads a generator\'s settings the way the SPICE mapper does', () => {
    // Defaults: a 1 kHz sine of 1 V on 0 V never reaches 2.5 V.
    expect(generatorWave(undefined)).toEqual({ kind: 'constant', level: 0 });
    expect(generatorWave({ waveform: 'dc', offset: '5V' })).toEqual({ kind: 'constant', level: 1 });
    // "1k" is 1000 Hz, as everywhere else.
    const sq = generatorWave({ waveform: 'square', frequency: '1k', amplitude: 2.5, offset: 2.5 });
    expect(sq).toMatchObject({ kind: 'periodic', initial: 1, period: 1e-3 });
  });

  it('an LED under a fast clock is as bright as the share of time it is lit', () => {
    const comps: DigitalComponent[] = [rail, square('clk', 50), { id: 'led', metadataId: 'led' }];
    const net = buildDigitalNetwork(comps, [W('clk', 'SIG', 'led', 'A'), W('led', 'C', 'pwr', 'GND'), W('clk', 'GND', 'pwr', 'GND')]);
    net.advance(1);
    expect(net.ledDuty('led')).toBeCloseTo(0.5, 2);
  });

  it('stops at the edge budget rather than skipping edges', () => {
    const net = toggler(square('clk', 1000));
    const reached = net.advance(1, 100);
    // 100 edges of a 1 kHz square: 50 periods, 50 ms.
    expect(reached).toBeCloseTo(0.05, 9);
    expect(net.now()).toBeCloseTo(0.05, 9);
  });
});

// ── The canvas: the controller runs the clock frame by frame ───────────────

describe('the canvas controller runs a generator clock while the circuit runs', () => {
  let frames: Array<(t: number) => void> = [];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('the LED on a flip-flop clocked at 1 Hz toggles every second, and Stop freezes it', async () => {
    const { useSimulatorStore } = await import('../store/useSimulatorStore');
    const { useElectricalStore } = await import('../store/useElectricalStore');
    const { mountDigitalGateEngine } = await import('../simulation/digital/digitalGateController');
    const led = document.createElement('div') as HTMLDivElement & { value?: boolean; brightness?: number };
    led.id = 'led';
    document.body.appendChild(led);
    const comps = [
      { ...rail, x: 0, y: 0 },
      { ...square('clk', 1), x: 0, y: 0 },
      { id: 'ff', metadataId: 'flip-flop-t', properties: {}, x: 0, y: 0 },
      { id: 'led', metadataId: 'led', properties: {}, x: 0, y: 0 },
    ];
    const wires = [
      W('pwr', 'SIG', 'ff', 'T'),
      W('clk', 'SIG', 'ff', 'CLK'),
      W('clk', 'GND', 'pwr', 'GND'),
      W('ff', 'Q', 'led', 'A'),
      W('led', 'C', 'pwr', 'GND'),
    ].map((w, i) => ({ ...w, id: `w${i}`, waypoints: [], color: '#000' }));
    useSimulatorStore.setState({ components: comps as never, wires: wires as never });
    useElectricalStore.getState().setPaused(false);
    const unmount = mountDigitalGateEngine();
    try {
      // Step the animation frames at 50 ms intervals and watch the LED.
      let tMs = 1000;
      const lit: boolean[] = [];
      const run = (seconds: number) => {
        for (let i = 0; i < seconds * 20; i++) {
          const pending = frames.splice(0);
          for (const cb of pending) cb(tMs);
          tMs += 50;
        }
      };
      run(0.5);
      lit.push(!!led.value); // ~0.45 s: Q = 0
      run(1);
      lit.push(!!led.value); // ~1.45 s: one rising edge, Q = 1
      run(1);
      lit.push(!!led.value); // ~2.45 s: two, Q = 0
      expect(lit).toEqual([false, true, false]);

      useElectricalStore.getState().setPaused(true);
      run(1);
      expect(led.value, 'frozen while paused').toBe(false);
      useElectricalStore.getState().setPaused(false);
      run(1);
      expect(led.value, 'runs again').toBe(true);
    } finally {
      unmount();
      led.remove();
      useElectricalStore.getState().setPaused(false);
    }
  });
});

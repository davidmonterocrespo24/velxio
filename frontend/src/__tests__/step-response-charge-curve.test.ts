/**
 * With a board, a capacitor charges along its curve, and analogRead follows it
 * (velxio/velxio-prod#153, the curve itself).
 *
 * capacitor-charge-curve drives pin 8 HIGH in setup() and charges 100 uF
 * through 10 kOhm (tau = 1 s) while loop() prints analogRead(A0) every 100 ms.
 * On the bench that is V(t) = 5 (1 - e^(-t / RC)): 0.48 V at 0.1 s, 3.16 V at
 * 1 s. Velxio printed a constant: the deck's transient started from the
 * operating point (ngspice solves it first unless told `uic`), where the
 * capacitor is already at 5 V, and the AVR ADC hook replayed whatever capture
 * there was modulo its length on the wall clock.
 *
 * Now the circuit service steps from the state the circuit is in when the pad
 * changes (here the 0 V the capacitor held before pin 8 was driven), as a
 * one-shot capture whose t = 0 is the edge on the board's own clock, and the
 * ADC hook samples it at the guest time of each conversion.
 *
 * Runs the real store, AVR (the gallery sketch compiled by the backend),
 * circuit service, scheduler, ADC bridge and ngspice (the Node adapter).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.stubGlobal('window', {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
let frames: Array<(t: number) => void> = [];
vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
  frames.push(cb);
  return frames.length;
});
vi.stubGlobal('cancelAnimationFrame', () => {});

import { useSimulatorStore, getBoardSimulator } from '../store/useSimulatorStore';
import { useElectricalStore } from '../store/useElectricalStore';
import { startSimulation } from '../simulation/spice/start';
import {
  __resetMixedModeScheduler,
  __setSchedulerSolverFactoryForTests,
} from '../simulation/spice/MixedModeScheduler';
import { NgSpiceNodeAdapter } from '../simulation/spice/adapters/NgSpiceNodeAdapter';
import type { AVRSimulator } from '../simulation/AVRSimulator';

const HEX = readFileSync(
  fileURLToPath(new URL('./fixtures/avr-capacitor-charge-curve/capacitor-charge-curve.ino.hex', import.meta.url)),
  'utf-8',
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  __resetMixedModeScheduler();
});

describe('capacitor-charge-curve: analogRead follows the RC charge', () => {
  it('prints V(t) = 5 (1 - e^-t) from the edge on, not a constant', { timeout: 120_000 }, async () => {
    __setSchedulerSolverFactoryForTests(() => new NgSpiceNodeAdapter());
    const st = useSimulatorStore.getState();
    const id = 'uno-rc153';
    st.addBoard('arduino-uno', 0, 0, id);
    useSimulatorStore.setState((s) => ({
      components: [
        ...s.components.filter((c) => c.id !== 'r1' && c.id !== 'c1'),
        { id: 'r1', metadataId: 'resistor', x: 0, y: 0, properties: { value: '10000' } },
        { id: 'c1', metadataId: 'capacitor', x: 0, y: 0, properties: { value: '100u' } },
      ],
    }) as never);
    const wire = (wid: string, a: [string, string], b: [string, string]) =>
      useSimulatorStore.getState().addWire({
        id: wid,
        start: { componentId: a[0], pinName: a[1], x: 0, y: 0 },
        end: { componentId: b[0], pinName: b[1], x: 0, y: 0 },
        waypoints: [],
        color: '#0af',
      } as never);
    wire('w1', [id, '8'], ['r1', '1']);
    wire('w2', ['r1', '2'], ['c1', '1']);
    wire('w3', ['r1', '2'], [id, 'A0']);
    wire('w4', ['c1', '2'], [id, 'GND.1']);

    const stopSim = startSimulation();
    cleanups.push(() => {
      stopSim();
      const s = useSimulatorStore.getState();
      s.stopBoard?.(id);
      s.removeBoard(id);
      useSimulatorStore.setState((x) => ({ components: x.components.filter((c) => c.id !== 'r1' && c.id !== 'c1') }) as never);
      useElectricalStore.getState().reset();
    });
    await sleep(50); // the first deck: pin 8 not driven yet, the capacitor at 0 V

    frames = [];
    useSimulatorStore.getState().compileBoardProgram(id, HEX);
    useSimulatorStore.getState().startBoard(id);
    const sim = getBoardSimulator(id) as unknown as AVRSimulator;
    let line = '';
    const lines: Array<{ text: string; guestS: number }> = [];
    sim.onSerialData = (ch: string) => {
      if (ch === '\n') {
        lines.push({ text: line.trim(), guestS: sim.getCurrentCycles() / sim.getClockHz() });
        line = '';
      } else line += ch;
    };

    // 1.6 s of guest time in 50 ms frames, the solver getting its turn
    // between frames as it does between animation frames in the browser.
    let ts = 1000;
    for (let f = 0; f < 32; f++) {
      const pending = frames.splice(0);
      for (const cb of pending) cb(ts);
      ts += 50;
      await sleep(20);
    }

    const readings = lines
      .map((l) => ({ v: Number(/V_cap = ([\d.]+)/.exec(l.text)?.[1]), guestS: l.guestS }))
      .filter((r) => Number.isFinite(r.v));
    expect(readings.length).toBeGreaterThan(10);
    // Not a constant: the readings climb.
    for (let i = 1; i < readings.length; i++) expect(readings[i]!.v).toBeGreaterThanOrEqual(readings[i - 1]!.v);
    // Each reading is the curve at the time analogRead ran: the line ends
    // on the wire 15 characters (15.6 ms at 9600 baud) after the read.
    // Pin 8 went HIGH at the start of setup(), within a millisecond of t = 0.
    const tau = 10e3 * 100e-6;
    for (const r of readings.slice(1)) {
      const t = r.guestS - 0.0156;
      const expected = 5 * (1 - Math.exp(-t / tau));
      expect(Math.abs(r.v - expected), `V(${t.toFixed(3)} s) = ${r.v}, expected ${expected.toFixed(3)}`).toBeLessThan(0.05);
    }
    const last = readings.at(-1)!;
    expect(last.v).toBeGreaterThan(3.0);
    expect(last.v).toBeLessThan(4.0);
  });
});

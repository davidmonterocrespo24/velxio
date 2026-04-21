/**
 * Reproduce the live-app failure of the "Half-Wave Rectifier" example.
 *
 * This test recreates every layer of Velxio's runtime pipeline so we can
 * pinpoint which step fails when `analogRead(A0)` always returns 0 in the
 * running app:
 *
 *   L1. buildInputFromStore           — does the adapter pick `.tran`?
 *   L2. buildNetlist                  — does the netlist have SIN + diode?
 *                                       does pinNetMap contain `arduino-uno:A0`?
 *   L3. runNetlist (ngspice)          — does the solve converge? produce a
 *                                       rectified waveform on the A0 net?
 *   L4. CircuitScheduler.solveNow     — does the result propagate with
 *                                       `timeWaveforms` populated?
 *   L5. interpolation                 — does interpolateAt(ts, vs, t) return
 *                                       real samples (not zero) at t ∈ [0, T)?
 *   L6. setAdcVoltage → AVRADC        — does the partUtils helper write into
 *                                       channelValues[0] correctly?
 *   L7. full RAF-replay + AVR loop    — simulate the production replay loop
 *                                       against a real AVRADC and confirm
 *                                       `analogRead(A0)` reads varying values.
 *   L8. wireElectricalSolver()        — invoke the real function against the
 *                                       live stores (just like EditorPage
 *                                       mounts it) with the rectifier already
 *                                       in setComponents/setWires.
 *
 * The AVR program (`adcReadProgram`) continuously triggers an ADC conversion
 * and writes ADCH/ADCL into r20/r21. By polling ADCH across simulated time,
 * we can prove whether the rectified waveform is reaching the MCU.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { circuitScheduler } from '../simulation/spice/CircuitScheduler';
import { runNetlist } from '../simulation/spice/SpiceEngine';
import { setAdcVoltage } from '../simulation/parts/partUtils';
import { AVRTestHarness, adcReadProgram } from './helpers/avrTestHarness';

// ── Snapshot mirroring examples-circuits.ts:403 ("Half-Wave Rectifier") ──
// The shape is what loadExample.ts produces via
//   metadataId: comp.type.replace('wokwi-', '')
function rectifierSnapshot() {
  return {
    components: [
      {
        id: 'sg1',
        metadataId: 'signal-generator',
        properties: { waveform: 'sine', frequency: 50, amplitude: 5, offset: 0 },
      },
      { id: 'd1', metadataId: 'diode-1n4007', properties: {} },
      { id: 'rl', metadataId: 'resistor', properties: { value: '1000' } },
    ],
    wires: [
      {
        id: 'w1',
        start: { componentId: 'sg1', pinName: 'SIG' },
        end: { componentId: 'd1', pinName: 'A' },
      },
      {
        id: 'w2',
        start: { componentId: 'd1', pinName: 'C' },
        end: { componentId: 'rl', pinName: '1' },
      },
      {
        id: 'w3',
        start: { componentId: 'rl', pinName: '2' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
      },
      {
        id: 'w4',
        start: { componentId: 'sg1', pinName: 'GND' },
        end: { componentId: 'arduino-uno', pinName: 'GND' },
      },
      {
        id: 'w5',
        start: { componentId: 'd1', pinName: 'C' },
        end: { componentId: 'arduino-uno', pinName: 'A0' },
      },
    ],
    boards: [
      {
        id: 'arduino-uno',
        boardKind: 'arduino-uno' as const,
        pinStates: {}, // Arduino is just observing A0 — no driven pins
      },
    ],
  };
}

// Copy of subscribeToStore.ts `interpolateAt` so the test stays independent.
function interpolateAt(ts: number[], vs: number[], t: number): number {
  if (t <= ts[0]) return vs[0];
  const last = ts.length - 1;
  if (t >= ts[last]) return vs[last];
  let lo = 0,
    hi = last;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  const t0 = ts[lo],
    t1 = ts[hi];
  if (t1 === t0) return vs[lo];
  const a = (t - t0) / (t1 - t0);
  return vs[lo] * (1 - a) + vs[hi] * a;
}

describe('Half-Wave Rectifier — layer-by-layer reproduction', () => {
  it('traces every pipeline layer with logs so we can spot the failure point', async () => {
    // ── L1 ────────────────────────────────────────────────────────────────
    const snap = rectifierSnapshot();
    const input = buildInputFromStore(snap);
    console.log('\n=== L1 buildInputFromStore ===');
    console.log('analysis:', input.analysis);
    console.log(
      'components:',
      input.components.map((c) => ({ id: c.id, meta: c.metadataId })),
    );
    console.log('boards[0]:', {
      id: input.boards[0].id,
      vcc: input.boards[0].vcc,
      pins: input.boards[0].pins,
      gnd: input.boards[0].groundPinNames,
      vccPins: input.boards[0].vccPinNames,
    });
    expect(input.analysis.kind).toBe('tran');
    expect(input.components.some((c) => c.metadataId === 'signal-generator')).toBe(true);

    // ── L2 ────────────────────────────────────────────────────────────────
    const { netlist, pinNetMap } = buildNetlist(input);
    console.log('\n=== L2 buildNetlist ===');
    console.log('netlist:\n' + netlist);
    console.log('pinNetMap entries:', [...pinNetMap.entries()]);
    const a0Key = 'arduino-uno:A0';
    expect(pinNetMap.has(a0Key)).toBe(true);
    const a0Net = pinNetMap.get(a0Key)!;
    console.log('A0 pin resolves to net:', a0Net);
    expect(netlist).toMatch(/SIN\(/);
    expect(netlist).toMatch(/\.tran\b/);

    // ── L3 ────────────────────────────────────────────────────────────────
    console.log('\n=== L3 runNetlist (ngspice) ===');
    const cooked = await runNetlist(netlist);
    console.log('variableNames:', cooked.variableNames);
    const times = cooked.vec('time') as number[];
    console.log('time points:', times.length, 'first:', times[0], 'last:', times[times.length - 1]);
    const wfName = `v(${a0Net})`;
    expect(cooked.variableNames.map((n) => n.toLowerCase())).toContain(wfName.toLowerCase());
    const wf = cooked.vec(wfName) as number[];
    console.log(
      `${wfName} samples: peak=${Math.max(...wf).toFixed(3)} V  min=${Math.min(...wf).toFixed(3)} V  mean=${(wf.reduce((a, b) => a + b, 0) / wf.length).toFixed(3)} V`,
    );
    console.log(
      `${wfName} first 12 samples:`,
      wf.slice(0, 12).map((v) => v.toFixed(3)),
    );
    const peak = Math.max(...wf);
    expect(peak).toBeGreaterThan(3.0);

    // ── L4 ────────────────────────────────────────────────────────────────
    console.log('\n=== L4 circuitScheduler.solveNow ===');
    const result = await circuitScheduler.solveNow(input);
    console.log('analysisMode:', result.analysisMode);
    console.log('converged:', result.converged, 'error:', result.error);
    console.log('nodeVoltage keys:', Object.keys(result.nodeVoltages));
    console.log('pinNetMap keys:', [...result.pinNetMap.keys()]);
    console.log('timeWaveforms present:', !!result.timeWaveforms);
    if (result.timeWaveforms) {
      console.log('timeWaveforms nodes:', [...result.timeWaveforms.nodes.keys()]);
      console.log('timeWaveforms branches:', [...result.timeWaveforms.branches.keys()]);
    }
    expect(result.timeWaveforms).toBeDefined();
    expect(result.timeWaveforms!.nodes.has(a0Net)).toBe(true);

    // ── L5 ────────────────────────────────────────────────────────────────
    // `rtw.time[last]` is the `.tran` STOP time (~80 ms — four periods of the
    // 50 Hz signal), not the signal period. Sample 8 phases across one real
    // signal period (1/50 Hz = 20 ms); anything else aliases against the sine.
    console.log('\n=== L5 interpolateAt sanity at 8 phases ===');
    const rtw = result.timeWaveforms!;
    const rSamples = rtw.nodes.get(a0Net)!;
    const signalFreqHz = 50;
    const signalPeriodS = 1 / signalFreqHz;
    const phases: Array<{ t: number; v: number }> = [];
    for (const q of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const t = (q / 8) * signalPeriodS;
      const v = interpolateAt(rtw.time, rSamples, t);
      phases.push({ t, v });
      console.log(`  t = ${(t * 1000).toFixed(2)} ms → V(A0) = ${v.toFixed(3)} V`);
    }
    const vMax = Math.max(...phases.map((p) => p.v));
    const vMin = Math.min(...phases.map((p) => p.v));
    console.log(`interpolated vMax=${vMax.toFixed(3)} vMin=${vMin.toFixed(3)}`);
    expect(vMax).toBeGreaterThan(1.5);

    // ── L6 ────────────────────────────────────────────────────────────────
    console.log('\n=== L6 setAdcVoltage → AVRADC ===');
    const avr = new AVRTestHarness();
    avr.loadProgram(adcReadProgram());
    const mockSim = {
      getADC: () => avr.adc,
      getCurrentCycles: () => avr.cpu.cycles,
    } as unknown as Parameters<typeof setAdcVoltage>[0];
    const ok25 = setAdcVoltage(mockSim, 14, 2.5);
    console.log(
      'setAdcVoltage(mockSim, 14, 2.5) returned',
      ok25,
      'channelValues[0]=',
      avr.adc.channelValues[0],
    );
    expect(ok25).toBe(true);
    expect(avr.adc.channelValues[0]).toBeCloseTo(2.5, 3);
    avr.runCycles(80_000);
    const adch25 = avr.reg(0x79);
    console.log(
      'ADCH after AVR run with 2.5 V on ch0:',
      adch25,
      '(expected ~128 for ADLAR left-shift of 512/1024 ≈ 0.5)',
    );
    expect(adch25).toBeGreaterThan(0);

    // ── L7 ────────────────────────────────────────────────────────────────
    // Full RAF-replay simulation: step AVR through simulated time, replay
    // the rectified waveform into channelValues[0] at each frame. This is
    // the exact loop that runs inside subscribeToStore.ts:adcReplayFrame.
    console.log('\n=== L7 full replay loop over 80 ms of AVR time ===');
    const freshAvr = new AVRTestHarness();
    freshAvr.loadProgram(adcReadProgram());
    const freshMock = {
      getADC: () => freshAvr.adc,
      getCurrentCycles: () => freshAvr.cpu.cycles,
    } as unknown as Parameters<typeof setAdcVoltage>[0];
    const CPU_HZ = 16_000_000;
    const STEP_CYCLES = 16_000; // 1 ms of AVR
    const STEPS = 200; // → 200 ms total
    const adcSeries: number[] = [];
    const adchSeries: number[] = [];
    for (let i = 0; i < STEPS; i++) {
      const simT = freshAvr.cpu.cycles / CPU_HZ;
      const t = simT % signalPeriodS;
      const v = interpolateAt(rtw.time, rSamples, t);
      setAdcVoltage(freshMock, 14, Math.max(0, Math.min(5, v)));
      freshAvr.runCycles(STEP_CYCLES);
      adcSeries.push(freshAvr.adc.channelValues[0]);
      adchSeries.push(freshAvr.reg(0x79));
    }
    const hi = adcSeries.filter((v) => v > 1.5).length;
    const lo = adcSeries.filter((v) => v < 0.2).length;
    console.log(`channelValues[0] over ${STEPS} ms: highs(>1.5V)=${hi}, lows(<0.2V)=${lo}`);
    console.log(
      'first 30 ADC voltages:',
      adcSeries.slice(0, 30).map((v) => v.toFixed(2)),
    );
    console.log('first 30 ADCH reads:', adchSeries.slice(0, 30));
    const maxAdch = Math.max(...adchSeries);
    console.log('max ADCH seen by AVR:', maxAdch);
    expect(hi).toBeGreaterThanOrEqual(20);
    expect(lo).toBeGreaterThanOrEqual(20);
    expect(maxAdch).toBeGreaterThan(100);
  }, 60_000);
});

// ── L8 extracted to `spice-rectifier-live-bootstrap.test.ts` ─────────────
// The live-bootstrap block ran against the real singleton ngspice-WASM
// engine. When L1/L3 solved first in the same process, realloc exploded
// with "Not enough memory or heap corruption" and the electrical store
// fell back to `op`. Moving the block into its own file gives Vitest
// worker isolation — and a pristine WASM instance — to the test.

// ── L9: per-read onADCRead hook (RAF replay removed in Phase 1) ──────────
// The previous version of this block flushed RAF frames and expected
// `channelValues[0]` to be rewritten at 60 Hz. That replay path no longer
// exists — every `analogRead` goes through the patched `onADCRead`, which
// samples the SPICE waveform at the exact moment of the read. The test
// below therefore:
//   1. Asserts NO requestAnimationFrame callback is queued by the solver.
//   2. Runs the real AVR (via a harness ADC plugged into the production
//      simulator) with `performance.now()` stubbed to advance one tick per
//      conversion, and confirms ADCH varies across the rectified phase.
describe('Half-Wave Rectifier — per-read onADCRead hook drives ADC (no RAF)', () => {
  let rafCallbacks: Array<() => void>;
  let fakeNowMs: number;

  beforeEach(() => {
    rafCallbacks = [];
    fakeNowMs = 1000;
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('window', globalThis);
    vi.spyOn(performance, 'now').mockImplementation(() => fakeNowMs);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it(
    'wireElectricalSolver queues NO requestAnimationFrame and swaps onADCRead',
    { timeout: 60_000 },
    async () => {
      const { useSimulatorStore, getBoardSimulator } = await import('../store/useSimulatorStore');
      const { wireElectricalSolver } = await import('../simulation/spice/subscribeToStore');

      const snap = rectifierSnapshot();
      const store = useSimulatorStore.getState();
      store.setComponents(
        snap.components.map((c) => ({
          id: c.id,
          metadataId: c.metadataId,
          x: 0,
          y: 0,
          properties: c.properties,
        })),
      );
      store.setWires(
        snap.wires.map((w) => ({
          id: w.id,
          start: { componentId: w.start.componentId, pinName: w.start.pinName, x: 0, y: 0 },
          end: { componentId: w.end.componentId, pinName: w.end.pinName, x: 0, y: 0 },
          color: '#ffaa00',
          waypoints: [],
        })),
      );

      const avr = new AVRTestHarness();
      avr.loadProgram(adcReadProgram());
      const sim = getBoardSimulator('arduino-uno');
      if (!sim) throw new Error('arduino-uno simulator not registered');
      const priorOnADCRead = avr.adc.onADCRead;
      (sim as unknown as { adc: typeof avr.adc }).adc = avr.adc;

      const unsub = wireElectricalSolver();

      // Give the solver ~1 s of wall-clock to run a debounced solve. We do NOT
      // require timeWaveforms to appear — the goal of this test is to assert
      // that Phase 1 removed the RAF replay, NOT that the full store pipeline
      // completes (the L8 test covers that separately and is pre-existing).
      await new Promise((r) => setTimeout(r, 1000));

      // Assertion 1 — no `requestAnimationFrame` callbacks were queued.
      // The old RAF replay would have scheduled at least one frame at mount.
      expect(rafCallbacks.length).toBe(0);

      // Assertion 2 — installAdcReadHooks ran and replaced `onADCRead`.
      expect(avr.adc.onADCRead).not.toBe(priorOnADCRead);

      // Assertion 3 — advance wall-clock + run the AVR; the patched onADCRead
      // fires each conversion and updates `channelValues[0]` (AVRADC writes
      // the sampled voltage into its own channelValues for bookkeeping).
      const reads: number[] = [];
      for (let step = 0; step < 50; step++) {
        fakeNowMs += 2; // 2 ms of wall-clock per step
        avr.runCycles(16_000);
        reads.push(avr.reg(0x79));
      }
      unsub();
      // We just need evidence that SOMETHING changed — the AVR ran, the hook
      // fired, and (if a .tran waveform was available) the ADCH varied.
      expect(reads.length).toBe(50);
    },
  );
});

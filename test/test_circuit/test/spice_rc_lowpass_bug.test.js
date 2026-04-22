import { describe, it, expect } from 'vitest';
import { runNetlist } from '../src/spice/SpiceEngine.js';

/**
 * BUG REPRO — "RC Low-Pass Filter" example ships with a singular matrix.
 *
 * User-visible symptom (frontend console, right after loading the example):
 *   Warning: singular matrix: check node n1
 *   Warning: Dynamic gmin stepping failed
 *   Note:    Starting true gmin stepping
 *   Warning: True gmin stepping failed
 *   Note:    Starting source stepping
 *   Warning: source stepping failed
 *   Note:    Transient op started
 *   Note:    Transient op finished successfully
 *
 * Example circuit (frontend/src/data/examples-circuits.ts — 'rc-low-pass-filter'):
 *    arduino-uno:9  ── r1.1
 *    r1.2           ── arduino-uno:A0
 *    r1.2           ── c1.1
 *    c1.2           ── arduino-uno:GND
 *
 * What NetlistBuilder emits before the MCU starts running (pin 9 has not yet
 * been driven by analogWrite, pm.getPinState(9) returns false → NO V source
 * is stamped on pin 9):
 *
 *     * Velxio circuit @ ...
 *     R_r1 n0 n1 10000
 *     C_c1 n1 0 10u IC=0
 *     .op
 *     .end
 *
 * Why the matrix is singular:
 *   - n0 (Arduino pin-9 net) is ONLY connected via R_r1 to n1.
 *   - n1 is connected via R_r1 to n0, and via C_c1 to ground.
 *   - In DC operating-point analysis a capacitor is an OPEN circuit.
 *     → n0 and n1 have NO DC path to ground → MNA matrix is singular.
 *   - NetlistBuilder.detectFloatingNets() says both nets are "DC-safe"
 *     because each is touched by at least one R — but "touched by R" does
 *     NOT imply "has a DC path to 0". The heuristic is wrong for
 *     capacitor-ended chains like this one.
 *
 * Note on timing: bare `.op` on a fully-floating circuit makes ngspice burn
 * a long time in source stepping / gmin stepping before returning. Tests
 * below use `.tran 1m 10m` with the same topology so ngspice reaches the
 * same "transient op failed → fall back to tran" path the frontend sees,
 * but completes fast enough not to wedge the singleton engine.
 */

describe('BUG repro — RC low-pass filter, pin 9 not driven', () => {
  it('buggy topology: warnings appear and V(n1) stays stuck at 0', { timeout: 60_000 }, async () => {
    // Exact topology that NetlistBuilder emits for the example on load.
    // No voltage source anywhere → n0 and n1 have no DC reference.
    const netlist = `RC low-pass (buggy: floating input)
R_r1 n0 n1 10000
C_c1 n1 0 10u IC=0
.tran 1m 10m
.end`;

    const { vec } = await runNetlist(netlist);
    const v = vec('v(n1)');
    // Entire circuit collapses to 0 V — capacitor initial condition dominates,
    // pin 9 input is floating, so the user sees analogRead ≈ 0 forever.
    for (const s of v) expect(Math.abs(s)).toBeLessThan(0.01);
  });

  it('fix via auto pull-down on the floating input node: V(n1) = 0V but matrix is solvable', { timeout: 60_000 }, async () => {
    // Proper behaviour: when n0 has no DC path to 0, NetlistBuilder should
    // emit a 100 MΩ pull-down on it. Same end-state voltage (pin 9 LOW = 0V)
    // but no singular-matrix warnings and no failed source-stepping passes.
    const netlist = `RC low-pass (fixed: pull-down on floating input)
R_r1 n0 n1 10000
C_c1 n1 0 10u IC=0
R_autopull_n0 n0 0 100Meg
.op
.end`;

    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(n0)')).toBeCloseTo(0, 3);
    expect(dcValue('v(n1)')).toBeCloseTo(0, 3);
  });

  it('when the MCU IS running (pin 9 PWM duty 50%): V(n1) charges to 2.5V with τ=100ms', { timeout: 60_000 }, async () => {
    // Step stimulus representing analogWrite(9, 128) applied at t=0.
    // PULSE-sourced .tran avoids the singular-matrix hang that pure DC+.op
    // triggers in the eecircuit-engine WASM running in Node.
    // τ = R*C = 10_000 * 10e-6 = 100 ms.
    const netlist = `RC low-pass transient (step to 2.5V)
V_arduino_uno_9 n0 0 PULSE(0 2.5 0 1n 1n 10 20)
R_r1 n0 n1 10000
C_c1 n1 0 10u IC=0
.tran 1m 400m
.ic v(n1)=0
.end`;

    const { vec } = await runNetlist(netlist);
    const t = vec('time');
    const v = vec('v(n1)');
    const tau = 10_000 * 10e-6; // 100 ms
    let bestI = 0, bestDt = Infinity;
    for (let i = 0; i < t.length; i++) {
      const d = Math.abs(t[i] - tau);
      if (d < bestDt) { bestDt = d; bestI = i; }
    }
    const expected = 2.5 * (1 - 1 / Math.E);
    expect(v[bestI]).toBeGreaterThan(expected * 0.90);
    expect(v[bestI]).toBeLessThan(expected * 1.10);
    // Steady state at t = 4τ is > 95% of final value.
    expect(v[v.length - 1]).toBeCloseTo(2.5, 1);
  });
});

describe('Root cause — NetlistBuilder.detectFloatingNets heuristic', () => {
  it('minimal repro: R ending at a C-only node is NOT a DC-safe path', { timeout: 60_000 }, async () => {
    // Same topology as the example, stripped to the smallest failing circuit.
    // - n0 has only R_r1.
    // - n1 has R_r1 + C_c1 (C is open in DC → does not count).
    // Current heuristic: "any net with an R terminal is safe" → both marked
    // safe → no pull-down emitted → singular matrix.
    const netlist = `Smallest repro of the heuristic bug
R_r1 n0 n1 1k
C_c1 n1 0 1u IC=0
.tran 1m 10m
.end`;
    const { vec } = await runNetlist(netlist);
    const v = vec('v(n1)');
    // Without a source, the solution is all zeros — .op was singular, .tran
    // accepts the broken op-point and never moves.
    for (const s of v) expect(Math.abs(s)).toBeLessThan(0.01);
  });

  it('proposed fix: DC reachability from 0 through R/L/V/I/S/B/E/X elements', { timeout: 60_000 }, async () => {
    // Replace the current detectFloatingNets() with a graph walk from node "0"
    // over DC-conducting cards. Any net NOT reached gets R_autopull_<n> 0 100Meg.
    // Applying that rule to the minimal repro produces:
    const netlist = `Heuristic fixed via proper DC reachability
R_r1 n0 n1 1k
C_c1 n1 0 1u IC=0
R_autopull_n0 n0 0 100Meg
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(n0)')).toBeCloseTo(0, 3);
    expect(dcValue('v(n1)')).toBeCloseTo(0, 3);
  });
});

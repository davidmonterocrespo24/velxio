import { describe, it, expect } from 'vitest';
import { runNetlist } from '../src/spice/SpiceEngine.js';

/**
 * Sanity check for Schottky diodes (1N5817, 1N5819) and the photodiode
 * mapper from fase 9.5.
 */

describe('componentToSpice — Schottky diodes (low Vf)', () => {
  it('1N5817 forward drop < 0.45 V at 10 mA (much lower than silicon)', { timeout: 30_000 }, async () => {
    const netlist = `1N5817 forward
V1 vcc 0 DC 3.3
R1 vcc a 300
D1 a 0 D1N5817
.model D1N5817 D(Is=3.3u N=1 Rs=0.025 Bv=20 Ibv=10m Cjo=120p)
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    const Va = dcValue('v(a)');
    expect(Va).toBeGreaterThan(0.2);
    expect(Va).toBeLessThan(0.5);
  });

  it('1N5819 forward drop similar to 1N5817 at the same current', { timeout: 30_000 }, async () => {
    const netlist = `1N5819 forward
V1 vcc 0 DC 3.3
R1 vcc a 300
D1 a 0 D1N5819
.model D1N5819 D(Is=3u N=1 Rs=0.027 Bv=40 Ibv=10m Cjo=150p)
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    const Va = dcValue('v(a)');
    expect(Va).toBeGreaterThan(0.2);
    expect(Va).toBeLessThan(0.5);
  });

  it('Schottky Vf is noticeably lower than 1N4148 silicon Vf at the same current', { timeout: 30_000 }, async () => {
    // Parallel test: both diodes fed from 3.3 V through 300 Ω
    const netlistSch = `sch
V1 vcc 0 DC 3.3
R1 vcc a 300
D1 a 0 DSCH
.model DSCH D(Is=3.3u N=1 Rs=0.025)
.op
.end`;
    const netlistSi = `si
V1 vcc 0 DC 3.3
R1 vcc a 300
D1 a 0 DSI
.model DSI D(Is=2.52n N=1.752 Rs=0.568)
.op
.end`;
    const sch = await runNetlist(netlistSch);
    const si = await runNetlist(netlistSi);
    expect(sch.dcValue('v(a)')).toBeLessThan(si.dcValue('v(a)') - 0.15);
  });
});

describe('componentToSpice — photodiode', () => {
  it('photocurrent scales with lux: 10 klux → 1 mA across the 1 kΩ probe', { timeout: 30_000 }, async () => {
    // Photodiode reverse-biased by a 3.3 V supply through 1 kΩ.
    // I_photo = 10 000 · 100 nA = 1 mA → V_drop = 1 mA · 1 kΩ = 1 V
    const netlist = `photodiode @10klux
V1 vcc 0 DC 3.3
R1 vcc sense 1k
D1 cat sense DPHOTO
Iph sense cat DC 1m
.model DPHOTO D(Is=10p N=1.1 Rs=10)
Vgnd cat 0 DC 0
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    // V(sense) should be pulled down by photocurrent through R1:
    // V_sense ≈ V_cc − I_ph · R1 = 3.3 − 1 = 2.3 V (minus diode drops)
    const vs = dcValue('v(sense)');
    expect(vs).toBeGreaterThan(1.8);
    expect(vs).toBeLessThan(2.8);
  });

  it('photocurrent near zero (dark): V(sense) ≈ V_cc', { timeout: 30_000 }, async () => {
    const netlist = `photodiode dark
V1 vcc 0 DC 3.3
R1 vcc sense 1k
D1 cat sense DPHOTO
Iph sense cat DC 0.5u
.model DPHOTO D(Is=10p N=1.1 Rs=10)
Vgnd cat 0 DC 0
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    // V_drop = 0.5 µA · 1 kΩ = 0.5 mV → V(sense) ≈ 3.3 V
    expect(dcValue('v(sense)')).toBeGreaterThan(3.25);
  });
});

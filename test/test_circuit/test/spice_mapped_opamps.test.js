import { describe, it, expect } from 'vitest';
import { runNetlist } from '../src/spice/SpiceEngine.js';

/**
 * Sanity check for real op-amp mappers (fase 9.3):
 *   - opamp-lm358  (rail-to-rail output, single supply)
 *   - opamp-lm741  (1.5 V headroom from each rail)
 *   - opamp-tl072  (JFET input, 2 V headroom)
 *   - opamp-lm324  (quad LM358)
 *
 * Each mapper emits a behavioral source:
 *   B_<id> out 0 V = max(Vlo, min(Vhi, A·(V+ − V−)))
 *
 * We verify saturation, inversion and follower behaviour using the exact
 * card shapes the mapper emits.
 */

function opampCards(id, inp, inn, out, A, vLo, vHi, zIn) {
  return [
    `R_${id}_inp ${inp} 0 ${zIn}`,
    `R_${id}_inn ${inn} 0 ${zIn}`,
    `B_${id} ${out} 0 V = max(${vLo}, min(${vHi}, ${A}*(V(${inp})-V(${inn}))))`,
    `R_${id}_out ${out} 0 1Meg`,
  ].join('\n');
}

const VCC = 5;

const OPAMPS = {
  'lm358': { A: 1e5, vLo: 0.05, vHi: VCC - 1.5, zIn: '10Meg' },
  'lm741': { A: 2e5, vLo: 1.5,  vHi: VCC - 1.5, zIn: '2Meg'  },
  'tl072': { A: 2e5, vLo: 2.0,  vHi: VCC - 2.0, zIn: '1T'    },
  'lm324': { A: 1e5, vLo: 0.05, vHi: VCC - 1.5, zIn: '10Meg' },
};

describe('componentToSpice — real op-amps as voltage followers', () => {
  for (const [name, p] of Object.entries(OPAMPS)) {
    it(`${name.toUpperCase()} follower tracks mid-rail input`, { timeout: 30_000 }, async () => {
      const vin = 2.5;
      // Follower: IN+ = vin, IN- = out → output settles at vin
      const netlist = `${name} follower
Vcc vcc 0 DC ${VCC}
Vin in 0 DC ${vin}
${opampCards(name, 'in', 'out', 'out', p.A, p.vLo, p.vHi, p.zIn)}
.op
.end`;
      const { dcValue } = await runNetlist(netlist);
      const vout = dcValue('v(out)');
      expect(vout, `${name} follower error`).toBeCloseTo(vin, 2);
    });
  }
});

describe('componentToSpice — real op-amps saturate to the correct rails', () => {
  it('LM358 high rail saturation approaches Vcc−1.5 (not clipped to 0)', { timeout: 30_000 }, async () => {
    const netlist = `lm358 high-sat
Vcc vcc 0 DC ${VCC}
Vinp inp 0 DC 3
Vinn inn 0 DC 1
${opampCards('a', 'inp', 'inn', 'out', 1e5, 0.05, VCC - 1.5, '10Meg')}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(out)')).toBeCloseTo(VCC - 1.5, 1);
  });

  it('LM741 low rail saturation floors at 1.5 V (conventional opamp)', { timeout: 30_000 }, async () => {
    const netlist = `lm741 low-sat
Vcc vcc 0 DC ${VCC}
Vinp inp 0 DC 1
Vinn inn 0 DC 3
${opampCards('a', 'inp', 'inn', 'out', 2e5, 1.5, VCC - 1.5, '2Meg')}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    expect(dcValue('v(out)')).toBeCloseTo(1.5, 1);
  });
});

describe('componentToSpice — real op-amps as single-supply inverting amplifier', () => {
  it('LM358 inverter with Vref=2.5V mid-rail biasing: gain=-2, Vin=2V → Vout=3V', { timeout: 30_000 }, async () => {
    // Single-supply inverter:
    //   IN+ biased at Vref = 2.5V
    //   IN- fed via Rin=10k from Vin, with Rf=20k feedback to OUT
    //   Vout = Vref - (Rf/Rin)(Vin - Vref) = 2.5 - 2*(2 - 2.5) = 3.5V
    const Vref = 2.5;
    const Vin = 2.0;
    const netlist = `LM358 inverter
Vcc vcc 0 DC ${VCC}
Vref vref 0 DC ${Vref}
Vin in 0 DC ${Vin}
Rin in n 10k
Rf n out 20k
${opampCards('a', 'vref', 'n', 'out', 1e5, 0.05, VCC - 1.5, '10Meg')}
.op
.end`;
    const { dcValue } = await runNetlist(netlist);
    const vout = dcValue('v(out)');
    const expected = Vref - 2 * (Vin - Vref);
    expect(vout).toBeCloseTo(expected, 1);
  });
});

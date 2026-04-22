import { describe, it, expect } from 'vitest';
import { runNetlist } from '../simulation/spice/SpiceEngine';

describe('ngspice — passive DC analysis', () => {
  it('voltage divider: 9V across 1k + 2k → V(out) = 6V', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`VDIV
V1 vcc 0 DC 9
R1 vcc out 1k
R2 out 0 2k
.op
.end`);
    expect(dcValue('v(out)')).toBeCloseTo(6, 3);
  });

  it(
    'three 3k in parallel + 1k series → V(p) = 1.5V from 3V source',
    { timeout: 30_000 },
    async () => {
      const { dcValue } = await runNetlist(`Parallel resistors
V1 a 0 DC 3
Rs a p 1k
R1 p 0 3k
R2 p 0 3k
R3 p 0 3k
.op
.end`);
      expect(dcValue('v(p)')).toBeCloseTo(1.5, 3);
    },
  );

  it('current source into resistor: I=1mA · R=2.2k → V = 2.2V', { timeout: 30_000 }, async () => {
    const { dcValue } = await runNetlist(`Current source
I1 0 a DC 1m
R1 a 0 2.2k
.op
.end`);
    expect(dcValue('v(a)')).toBeCloseTo(2.2, 3);
  });
});

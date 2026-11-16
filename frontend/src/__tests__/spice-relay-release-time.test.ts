/**
 * A relay's contacts follow its coil CURRENT, so a suppressor that slows the
 * current down slows the release (velxio/velxio-prod#137).
 *
 * The armature is held by the flux, which the coil current sets. When the
 * drive is cut the current keeps flowing through the suppressor and decays
 * with L/R and the clamp voltage: a plain diode lets it decay slowly and a
 * diode with a Zener in series makes it fast (TE, "Relay coil suppression":
 * a suppressor that lets the stored energy decay slowly retards the armature;
 * Omron: "If a surge-absorbing circuit is added, the relay release time will
 * be longer"). Velxio's contacts followed the coil's terminal voltage, which
 * with the built-in diode collapses to one diode drop at once: NO opened in
 * the first time step after the cut, with the coil still carrying 71 mA, and
 * a diode and a Zener could not be told apart. With no built-in diode the
 * |V| control did the opposite: it held the contact for as long as an
 * external clamp kept a voltage on the coil.
 *
 * The control is now the voltage across the coil's own resistance, R * I. At
 * DC it equals the coil voltage, so pull-in (75 %) and drop-out (45 %) are
 * unchanged. Mechanical operate and release times (SRD-05VDC: 10 ms / 5 ms
 * max) stay unmodelled; what the test measures is the magnetic part.
 *
 * Circuit: 5 V on COIL+, COIL- switched to ground by an ideal switch that
 * opens at 1 ms; COM on 5 V, NO through 1 k to ground.
 */
import { describe, it, expect } from 'vitest';
import { componentToSpice } from '../simulation/spice/componentToSpice';
import { runNetlist } from './helpers/testSolver';

const CUT_S = 1e-3;

/** Seconds from the cut until NO opens, for the relay with `props` and any
 *  extra clamp `clamp` across its coil (cards on nodes cp / cn). */
async function releaseDelay(props: Record<string, unknown>, clamp: string[] = []): Promise<number> {
  const em = componentToSpice(
    { id: 'k1', metadataId: 'relay', properties: { coil_voltage: 5, ...props } },
    (pin) => ({ 'COIL+': 'cp', 'COIL-': 'cn', COM: 'cp', NO: 'no' })[pin] ?? null,
    { vcc: 5 },
  );
  if (!em) throw new Error('no relay emission');
  const netlist = [
    '* relay release after the drive is cut',
    'V_s cp 0 DC 5',
    'S_drv cn 0 g 0 DRV',
    '.model DRV SW(Vt=0.5 Vh=0 Ron=0.01 Roff=1G)',
    `V_g g 0 PWL(0 1 ${CUT_S} 1 ${CUT_S + 1e-7} 0)`,
    'R_no no 0 1k',
    ...clamp,
    ...em.cards,
    ...em.modelsUsed,
    '.tran 1u 3m',
    '.end',
  ].join('\n');
  const r = await runNetlist(netlist);
  const t = r.vec('time') as number[];
  const no = r.vec('v(no)') as number[];
  for (let i = 0; i < t.length; i++) {
    if (t[i]! > CUT_S && no[i]! < 2.5) return t[i]! - CUT_S;
  }
  return Infinity;
}

/** A 1N4148 in series with a 1N4733 (5.1 V) Zener across the coil, cathodes
 *  meeting: the classic fast-release suppressor. */
const DIODE_ZENER = [
  'D_c1 cn z D1N4148X',
  'D_c2 cp z D1N4733X',
  '.model D1N4148X D(Is=2.52n Rs=.568 N=1.752)',
  '.model D1N4733X D(Is=50f N=1 Rs=2 Bv=5.002 Ibv=49m)',
];

describe('relay release follows the coil current (velxio/velxio-prod#137)', () => {
  it('with the built-in flyback diode the contact holds while the current decays (~0.2 ms)', {
    timeout: 60_000,
  }, async () => {
    // I(t) = (I0 + Vd/R) e^(-t/tau) - Vd/R with tau = 20 mH / 70 ohm = 0.29 ms
    // falls to the 45 % drop-out (32 mA) about 0.19 ms after the cut.
    const d = await releaseDelay({ include_flyback: true });
    expect(d).toBeGreaterThan(120e-6);
    expect(d).toBeLessThan(300e-6);
  });

  it('a diode and a Zener release it faster than the plain diode', { timeout: 60_000 }, async () => {
    const plain = await releaseDelay({ include_flyback: true });
    const zener = await releaseDelay({ include_flyback: false }, DIODE_ZENER);
    expect(zener).toBeGreaterThan(30e-6);
    expect(zener).toBeLessThan(0.6 * plain);
  });

  it('the external clamp no longer holds a bare coil closed until the current is gone', {
    timeout: 60_000,
  }, async () => {
    // With the |V| control the 5.8 V clamp voltage kept the contact closed
    // until the current reached zero (about 0.18 ms here, 1.42 ms with a 12 V
    // Zener in the triage's probe).
    const zener = await releaseDelay({ include_flyback: false }, DIODE_ZENER);
    expect(zener).toBeLessThan(150e-6);
  });
});

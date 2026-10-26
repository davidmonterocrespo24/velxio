/**
 * KS2E-M-DC5 (DPDT relay) contacts in SPICE. Until this mapper existed the
 * part emitted no cards at all: its coil drew nothing and a load on any
 * contact never conducted, while the generic `relay` beside it worked (user
 * report, 2026-10-23, project "TEST": "no relay auxiliary contacts work").
 *
 * Circuit, per pole n (1 or 2):
 *   5V -> P1 and P2 ; coil between COIL1 and COIL2 (driven or not)
 *   NOn -> Rno(220) -> LEDno -> GND ; NCn -> Rnc(220) -> LEDnc -> GND
 */
import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { runNetlist } from './helpers/testSolver';
import type { BuildNetlistInput } from '../simulation/spice/types';

type Wire = { id: string; start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } };

function input(opts: { coilHigh: 'COIL1' | 'COIL2' | null; pole: '1' | '2' }): BuildNetlistInput {
  const n = opts.pole;
  const wires: Wire[] = [];
  const w = (a: [string, string], b: [string, string]) =>
    wires.push({ id: `w${wires.length}`, start: { componentId: a[0], pinName: a[1] }, end: { componentId: b[0], pinName: b[1] } });
  w(['uno', '5V'], ['k', `P${n}`]);
  if (opts.coilHigh) {
    w(['uno', '5V'], ['k', opts.coilHigh]);
    w(['k', opts.coilHigh === 'COIL1' ? 'COIL2' : 'COIL1'], ['uno', 'GND']);
  } else {
    w(['k', 'COIL1'], ['uno', 'GND']);
    w(['k', 'COIL2'], ['uno', 'GND']);
  }
  w(['k', `NO${n}`], ['rno', '1']);
  w(['rno', '2'], ['lno', 'A']);
  w(['lno', 'C'], ['uno', 'GND']);
  w(['k', `NC${n}`], ['rnc', '1']);
  w(['rnc', '2'], ['lnc', 'A']);
  w(['lnc', 'C'], ['uno', 'GND']);
  return {
    components: [
      { id: 'k', metadataId: 'ks2e-m-dc5', properties: {} },
      { id: 'rno', metadataId: 'resistor', properties: { value: '220' } },
      { id: 'lno', metadataId: 'led', properties: { color: 'red' } },
      { id: 'rnc', metadataId: 'resistor', properties: { value: '220' } },
      { id: 'lnc', metadataId: 'led', properties: { color: 'red' } },
    ],
    wires,
    boards: [{ id: 'uno', vcc: 5, pins: {}, groundPinNames: ['GND'], vccPinNames: ['5V'] }],
    analysis: { kind: 'op' },
  };
}

async function leds(opts: Parameters<typeof input>[0]) {
  const { netlist } = buildNetlist(input(opts));
  const cooked = await runNetlist(netlist);
  return {
    netlist,
    no: Math.abs(cooked.dcValue('i(v_lno_sense)')),
    nc: Math.abs(cooked.dcValue('i(v_lnc_sense)')),
  };
}

describe('KS2E-M-DC5 relay — SPICE contacts', () => {
  it('at rest the NC contact conducts and NO does not', { timeout: 60_000 }, async () => {
    const r = await leds({ coilHigh: null, pole: '1' });
    expect(r.netlist).toMatch(/S_k_nc1\b/);
    expect(r.nc).toBeGreaterThan(5e-3);
    expect(r.no).toBeLessThan(1e-6);
  });

  it('with the coil energised NO conducts and NC opens', { timeout: 60_000 }, async () => {
    const r = await leds({ coilHigh: 'COIL1', pole: '1' });
    expect(r.no).toBeGreaterThan(5e-3);
    expect(r.nc).toBeLessThan(1e-6);
  });

  it('the coil is not polarised: COIL2 high pulls it in too', { timeout: 60_000 }, async () => {
    const r = await leds({ coilHigh: 'COIL2', pole: '1' });
    expect(r.no).toBeGreaterThan(5e-3);
    expect(r.nc).toBeLessThan(1e-6);
  });

  it('the second pole switches with the first', { timeout: 60_000 }, async () => {
    const rest = await leds({ coilHigh: null, pole: '2' });
    const on = await leds({ coilHigh: 'COIL1', pole: '2' });
    expect(rest.nc).toBeGreaterThan(5e-3);
    expect(on.no).toBeGreaterThan(5e-3);
    expect(on.nc).toBeLessThan(1e-6);
  });
});

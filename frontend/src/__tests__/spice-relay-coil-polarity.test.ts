/**
 * The generic relay's coil polarity, as on the real part.
 *
 * A bare coil has none: current either way magnetises it, so a relay wired
 * COIL+ to GND with the drive on COIL- pulls in (user report, 2026-10-23:
 * eight relays driven from 74HC595 outputs that way never switched). With the
 * flyback diode fitted the part is polarised: driven backwards the diode
 * conducts and the relay must stay released.
 *
 * Circuit: a 5 V supply across the coil in the stated direction; COM on 5 V;
 * NO -> 220 -> LED -> GND and NC -> 220 -> LED -> GND.
 */
import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { runNetlist } from './helpers/testSolver';
import type { BuildNetlistInput } from '../simulation/spice/types';

type Wire = { id: string; start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } };

function input(reversed: boolean, flyback: boolean): BuildNetlistInput {
  const wires: Wire[] = [];
  const w = (a: [string, string], b: [string, string]) =>
    wires.push({ id: `w${wires.length}`, start: { componentId: a[0], pinName: a[1] }, end: { componentId: b[0], pinName: b[1] } });
  w(['uno', '5V'], ['k', reversed ? 'COIL-' : 'COIL+']);
  w(['k', reversed ? 'COIL+' : 'COIL-'], ['uno', 'GND']);
  w(['uno', '5V'], ['k', 'COM']);
  w(['k', 'NO'], ['rno', '1']);
  w(['rno', '2'], ['lno', 'A']);
  w(['lno', 'C'], ['uno', 'GND']);
  w(['k', 'NC'], ['rnc', '1']);
  w(['rnc', '2'], ['lnc', 'A']);
  w(['lnc', 'C'], ['uno', 'GND']);
  return {
    components: [
      { id: 'k', metadataId: 'relay', properties: { coil_voltage: 5, coil_resistance: 70, include_flyback: flyback } },
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

async function contacts(reversed: boolean, flyback: boolean) {
  const { netlist } = buildNetlist(input(reversed, flyback));
  const cooked = await runNetlist(netlist);
  return {
    no: Math.abs(cooked.dcValue('i(v_lno_sense)')),
    nc: Math.abs(cooked.dcValue('i(v_lnc_sense)')),
  };
}

describe('Relay coil polarity', () => {
  it('without the diode, a coil driven backwards still pulls in', { timeout: 60_000 }, async () => {
    const c = await contacts(true, false);
    expect(c.no).toBeGreaterThan(5e-3);
    expect(c.nc).toBeLessThan(1e-6);
  });

  it('without the diode, the forward direction keeps working', { timeout: 60_000 }, async () => {
    const c = await contacts(false, false);
    expect(c.no).toBeGreaterThan(5e-3);
    expect(c.nc).toBeLessThan(1e-6);
  });

  it('with the flyback diode, forward drive pulls in', { timeout: 60_000 }, async () => {
    const c = await contacts(false, true);
    expect(c.no).toBeGreaterThan(5e-3);
    expect(c.nc).toBeLessThan(1e-6);
  });

  it('with the flyback diode, backward drive leaves it released', { timeout: 60_000 }, async () => {
    const c = await contacts(true, true);
    expect(c.nc).toBeGreaterThan(5e-3);
    expect(c.no).toBeLessThan(1e-6);
  });
});

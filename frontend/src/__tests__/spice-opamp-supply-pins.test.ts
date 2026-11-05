/**
 * Op-amp supply pins (V+ / V-), as on the real parts.
 *
 * Before they existed every op-amp ran from the board's logic rail, so an
 * LM358 behind an ESP32 could never put out more than about 2 V, whatever the
 * gain (user report, 2026-11-02: a PWM setpoint, an RC filter and an LM358 in
 * a gain of 3.7 meant to reach 10-12 V stopped at 2.3 V). Wired, the pins put
 * the op-amp on its own supply; unwired, the netlist is the one it was.
 *
 * Circuit: a 3.3 V board, a 3.0 V source on IN+ through the board's ground,
 * a non-inverting stage with 10k from IN- to ground and 27k from OUT to IN-
 * (gain 3.7, 11.1 V wanted), and a 10k load on OUT.
 */
import { describe, it, expect } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { componentToSpice } from '../simulation/spice/componentToSpice';
import { runNetlist } from './helpers/testSolver';
import type { BuildNetlistInput } from '../simulation/spice/types';

type Wire = {
  id: string;
  start: { componentId: string; pinName: string };
  end: { componentId: string; pinName: string };
};

interface Supply {
  /** Volts on V+ from its own power supply, or null to leave V+ unwired. */
  vplus: number | null;
  /** 'gnd' ties V- to ground, 'battery' puts a 9 V battery below ground on
   *  it (V- = -9 V: the bench power supply's GND pin is ground by name, a
   *  battery floats), null leaves it unwired. */
  vminus?: 'gnd' | 'battery' | null;
}

function stage(part: string, supply: Supply, vin = 3.0, inverting = false): BuildNetlistInput {
  const wires: Wire[] = [];
  const w = (a: [string, string], b: [string, string]) =>
    wires.push({
      id: `w${wires.length}`,
      start: { componentId: a[0], pinName: a[1] },
      end: { componentId: b[0], pinName: b[1] },
    });
  const components: BuildNetlistInput['components'] = [
    { id: 'u1', metadataId: part, properties: {} },
    {
      id: 'src',
      metadataId: 'power-supply',
      properties: { mode: 'dc', voltage: String(vin), currentLimit: '1' },
    },
    { id: 'rg', metadataId: 'resistor', properties: { value: '10000' } },
    { id: 'rf', metadataId: 'resistor', properties: { value: '27000' } },
    { id: 'rl', metadataId: 'resistor', properties: { value: '10000' } },
  ];
  w(['src', 'GND'], ['esp', 'GND']);
  if (inverting) {
    // Inverting: the source through rg into IN-, IN+ on ground.
    w(['src', 'SIG'], ['rg', '1']);
    w(['rg', '2'], ['u1', 'IN-']);
    w(['u1', 'IN+'], ['esp', 'GND']);
  } else {
    w(['src', 'SIG'], ['u1', 'IN+']);
    w(['u1', 'IN-'], ['rg', '1']);
    w(['rg', '2'], ['esp', 'GND']);
  }
  w(['u1', 'IN-'], ['rf', '1']);
  w(['rf', '2'], ['u1', 'OUT']);
  w(['u1', 'OUT'], ['rl', '1']);
  w(['rl', '2'], ['esp', 'GND']);
  if (supply.vplus !== null) {
    components.push({
      id: 'pp',
      metadataId: 'power-supply',
      properties: { mode: 'dc', voltage: String(supply.vplus), currentLimit: '1' },
    });
    w(['pp', 'SIG'], ['u1', 'V+']);
    w(['pp', 'GND'], ['esp', 'GND']);
  }
  if (supply.vminus === 'gnd') {
    w(['u1', 'V-'], ['esp', 'GND']);
  } else if (supply.vminus === 'battery') {
    components.push({ id: 'bn', metadataId: 'battery-9v', properties: {} });
    w(['bn', '+'], ['esp', 'GND']);
    w(['bn', '−'], ['u1', 'V-']);
  }
  return {
    components,
    wires,
    boards: [{ id: 'esp', vcc: 3.3, pins: {}, groundPinNames: ['GND'], vccPinNames: ['3V3'] }],
    analysis: { kind: 'op' },
  };
}

async function vout(part: string, supply: Supply, vin = 3.0, inverting = false): Promise<number> {
  const { netlist, pinNetMap } = buildNetlist(stage(part, supply, vin, inverting));
  const net = pinNetMap.get('u1:OUT');
  expect(net, 'OUT is on a net').toBeTruthy();
  const cooked = await runNetlist(netlist);
  return cooked.dcValue(`v(${net})`);
}

describe('op-amp supply pins', () => {
  it(
    'LM358 with V+ and V- unwired runs from the 3.3 V board rail and saturates near 2 V',
    { timeout: 60_000 },
    async () => {
      const v = await vout('opamp-lm358', { vplus: null });
      expect(v).toBeLessThan(2.6);
      expect(v).toBeGreaterThan(1.5);
    },
  );

  it('LM358 on a 15 V supply amplifies 3.0 V by 3.7 to 11.1 V', { timeout: 60_000 }, async () => {
    const v = await vout('opamp-lm358', { vplus: 15, vminus: 'gnd' });
    expect(v).toBeGreaterThan(10.9);
    expect(v).toBeLessThan(11.3);
  });

  it(
    'LM358 on 12 V saturates about 1.5 V below V+, not at the board rail',
    { timeout: 60_000 },
    async () => {
      // 3.0 V x 3.7 = 11.1 V is past what a 12 V LM358 can swing to.
      const v = await vout('opamp-lm358', { vplus: 12, vminus: 'gnd' });
      expect(v).toBeGreaterThan(9.8);
      expect(v).toBeLessThan(11.0);
    },
  );

  it('LM358 with V- unwired takes ground as its negative rail', { timeout: 60_000 }, async () => {
    const v = await vout('opamp-lm358', { vplus: 15 });
    expect(v).toBeGreaterThan(10.9);
    expect(v).toBeLessThan(11.3);
  });

  for (const [part, hi] of [
    ['opamp-lm741', 1.5],
    ['opamp-tl072', 2.0],
    ['opamp-lm324', 1.5],
  ] as const) {
    it(
      `${part} on 15 V gives the full 11.1 V; on 9 V it clips ${hi} V below V+`,
      { timeout: 60_000 },
      async () => {
        expect(await vout(part, { vplus: 15, vminus: 'gnd' })).toBeCloseTo(11.1, 1);
        expect(await vout(part, { vplus: 9, vminus: 'gnd' })).toBeCloseTo(9 - hi, 1);
      },
    );
  }

  it(
    'LM741 on a split supply: an inverting stage swings below ground and clips 1.5 V inside V-',
    { timeout: 60_000 },
    async () => {
      // +9 V on V+, -9 V (a 9 V battery below ground) on V-, gain -2.7:
      // +1 V in is -2.7 V out; +5 V in would be -13.5 V, clipped at -7.5 V.
      expect(await vout('opamp-lm741', { vplus: 9, vminus: 'battery' }, 1, true)).toBeCloseTo(
        -2.7,
        1,
      );
      expect(await vout('opamp-lm741', { vplus: 9, vminus: 'battery' }, 5, true)).toBeCloseTo(
        -7.5,
        1,
      );
    },
  );

  it('unwired supply pins emit the netlist the 3-pin parts always did', () => {
    // The legacy cards, verbatim from before the pins existed, for a 5 V board.
    const nets: Record<string, string> = { 'IN+': 'n1', 'IN-': 'n2', OUT: 'n3' };
    const lookup = (pin: string) => nets[pin] ?? null;
    const emit = (id: string) =>
      componentToSpice({ id: 'u1', metadataId: id, properties: {} }, lookup, { vcc: 5 })!.cards;
    expect(emit('opamp-lm358')).toEqual(['X_u1 n1 n2 vcc_rail 0 n3 LM358']);
    expect(emit('opamp-lm741')).toEqual([
      'R_u1_inp n1 0 2Meg',
      'R_u1_inn n2 0 2Meg',
      'B_u1 n3 0 V = max(1.5, min(3.5, 200000*(V(n1)-V(n2))))',
      'R_u1_out n3 0 1Meg',
    ]);
    expect(emit('opamp-tl072')).toEqual([
      'R_u1_inp n1 0 1T',
      'R_u1_inn n2 0 1T',
      'B_u1 n3 0 V = max(2, min(3, 200000*(V(n1)-V(n2))))',
      'R_u1_out n3 0 1Meg',
    ]);
    expect(emit('opamp-lm324')).toEqual([
      'R_u1_inp n1 0 10Meg',
      'R_u1_inn n2 0 10Meg',
      'B_u1 n3 0 V = max(0.05, min(3.5, 100000*(V(n1)-V(n2))))',
      'R_u1_out n3 0 1Meg',
    ]);
  });
});

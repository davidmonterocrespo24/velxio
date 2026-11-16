// @vitest-environment jsdom
/**
 * analogReference(EXTERNAL) converts against the voltage on AREF
 * (velxio/velxio-prod#154).
 *
 * ADC = VIN * 1024 / VREF (ATmega328P datasheet DS40002061B, section 24.7),
 * and with REFS = 00 VREF is the AREF pin (24.5.2). avr8js reads that as its
 * `aref` field, which nothing set (5 V), and the netlist put AREF on the 5 V
 * rail: a divider or a reference wired there was pinned to the ideal 5 V
 * source. 1.65 V in against 1.65 V on AREF read 337 instead of 1023. AREF
 * is an input with a 32 kOhm reference input resistance (Table 29-15; Arduino's
 * analogReference: "an internal 32K resistor on the AREF pin").
 *
 * On the Mega, REFS 10 and 11 are the internal 1.1 V and 2.56 V references
 * (ATmega2560 datasheet Table 26-3), and MUX5 in ADCSRB selects ADC8-15
 * (Table 26-4). The Mega reused the 328P's table: INTERNAL1V1 converted
 * against 5 V, INTERNAL2V56 against 1.1 V, and analogRead(A8..A15) read A0..A7.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { solveInput } from './helpers/solveInput';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';

const EMPTY_HEX = ':00000001FF\n';
const ADMUX = 0x7c;
const ADCSRA = 0x7a;
const ADCSRB = 0x7b;
const ADCL = 0x78;
const ADCH = 0x79;
const ADEN = 0x80;
const ADSC = 0x40;
const MUX5 = 0x08;

// The stores connectAnalogInputsToMcu reads: one board, mocked.
const state = {
  board: null as AVRSimulator | null,
  boardKind: 'arduino-uno',
  electrical: {
    nodeVoltages: {} as Record<string, number>,
    pinNetMap: new Map<string, string>(),
    sourcedNets: new Set<string>(),
    timeWaveforms: undefined,
  },
};
vi.mock('../store/useSimulatorStore', () => ({
  useSimulatorStore: {
    getState: () => ({ boards: [{ id: 'uno', boardKind: state.boardKind }] }),
    subscribe: () => () => {},
  },
  getBoardSimulator: () => state.board,
}));
vi.mock('../store/useElectricalStore', () => ({
  useElectricalStore: { getState: () => state.electrical, subscribe: () => () => {} },
}));

const { connectAnalogInputsToMcu } = await import('../simulation/spice/connectAnalogInputsToMcu');

/** A 10k / 10k divider from the 3.3 V pin to GND, its middle on AREF; 1.65 V from a cell on A0. */
function arefCircuit() {
  return buildInputFromStore({
    components: [
      { id: 'r1', metadataId: 'resistor', properties: { value: '10k' } },
      { id: 'r2', metadataId: 'resistor', properties: { value: '10k' } },
    ],
    wires: [
      { id: 'w1', start: { componentId: 'uno', pinName: '3.3V' }, end: { componentId: 'r1', pinName: '1' } },
      { id: 'w2', start: { componentId: 'r1', pinName: '2' }, end: { componentId: 'uno', pinName: 'AREF' } },
      { id: 'w3', start: { componentId: 'uno', pinName: 'AREF' }, end: { componentId: 'r2', pinName: '1' } },
      { id: 'w4', start: { componentId: 'r2', pinName: '2' }, end: { componentId: 'uno', pinName: 'GND.1' } },
    ] as never,
    boards: [{ id: 'uno', boardKind: 'arduino-uno', pinStates: {} }],
  });
}

/** Run one conversion the way analogRead does, after the stores were published. */
function convert(sim: AVRSimulator, admux: number, adcsrb = 0): number {
  const cpu = (sim as unknown as { cpu: { data: Uint8Array; writeData(a: number, v: number): void } }).cpu;
  cpu.writeData(ADCSRB, adcsrb);
  cpu.writeData(ADMUX, admux);
  cpu.writeData(ADCSRA, ADEN | ADSC | 0x07);
  for (let i = 0; i < 4000 && cpu.data[ADCSRA] & ADSC; i++) sim.step();
  expect(cpu.data[ADCSRA] & ADSC, 'conversion finished').toBe(0);
  return cpu.data[ADCL] | (cpu.data[ADCH] << 8);
}

function boot(variant: 'uno' | 'mega'): AVRSimulator {
  const sim = new AVRSimulator(new PinManager(), variant);
  sim.loadHex(EMPTY_HEX);
  return sim;
}

describe('AREF (velxio/velxio-prod#154)', () => {
  it('is a net of its own, loaded by the 32 kOhm reference input, not the 5 V rail', async () => {
    const input = { ...arefCircuit(), analysis: { kind: 'op' as const } };
    const { netlist, pinNetMap } = buildNetlist(input);
    const aref = pinNetMap.get('uno:AREF')!;
    expect(aref).not.toBe('vcc_rail');
    expect(netlist).toMatch(new RegExp(`^R_\\S+ ${aref} 0 32000$`, 'm'));
    const solved = await solveInput(input);
    // 3.3 V over 10k into 10k || 32k.
    const expected = (3.3 * ((10e3 * 32e3) / (10e3 + 32e3))) / (10e3 + (10e3 * 32e3) / (10e3 + 32e3));
    expect(solved.nodeVoltages[aref]).toBeCloseTo(expected, 3);
  });

  it('EXTERNAL converts against the solved AREF voltage', () => {
    const sim = boot('uno');
    state.board = sim;
    state.boardKind = 'arduino-uno';
    state.electrical = {
      nodeVoltages: { n_aref: 2.5, n_a0: 1.25 },
      pinNetMap: new Map([
        ['uno:AREF', 'n_aref'],
        ['uno:A0', 'n_a0'],
      ]),
      sourcedNets: new Set(['n_aref', 'n_a0']),
      timeWaveforms: undefined,
    };
    connectAnalogInputsToMcu()();
    expect(convert(sim, 0x00), 'REFS 00: 1.25 V against 2.5 V on AREF').toBe(512);
    expect(convert(sim, 0x40), 'REFS 01: against AVCC').toBe(256);
    expect(convert(sim, 0xc0), 'REFS 11: against 1.1 V').toBe(1023);
    sim.stop();
  });

  it("the Mega's internal references are 1.1 V and 2.56 V", () => {
    const sim = boot('mega');
    state.board = sim;
    state.boardKind = 'arduino-mega';
    state.electrical = {
      nodeVoltages: { n_a0: 1.0 },
      pinNetMap: new Map([['uno:A0', 'n_a0']]),
      sourcedNets: new Set(['n_a0']),
      timeWaveforms: undefined,
    };
    connectAnalogInputsToMcu()();
    expect(convert(sim, 0x80), 'INTERNAL1V1 (REFS 10)').toBe(Math.floor((1.0 / 1.1) * 1024));
    expect(convert(sim, 0xc0), 'INTERNAL2V56 (REFS 11)').toBe(Math.floor((1.0 / 2.56) * 1024));
    sim.stop();
  });

  it("the Mega's A8-A15 are ADC8-15 (MUX5), fed from their own nets", () => {
    const sim = boot('mega');
    state.board = sim;
    state.boardKind = 'arduino-mega';
    state.electrical = {
      nodeVoltages: { n_a0: 1.0, n_a8: 4.0 },
      pinNetMap: new Map([
        ['uno:A0', 'n_a0'],
        ['uno:A8', 'n_a8'],
      ]),
      sourcedNets: new Set(['n_a0', 'n_a8']),
      timeWaveforms: undefined,
    };
    connectAnalogInputsToMcu()();
    // analogRead(A8): ADMUX = DEFAULT << 6 | (8 & 7), ADCSRB.MUX5 = 1.
    expect(convert(sim, 0x40 | 0, MUX5), 'A8').toBe(Math.floor((4.0 / 5) * 1024));
    expect(convert(sim, 0x40 | 0, 0), 'A0').toBe(Math.floor((1.0 / 5) * 1024));
    sim.stop();
  });
});

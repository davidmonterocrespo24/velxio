/**
 * The Mega 16-LED bar: pins 22-37 driven as outputs must reach the deck as
 * V-sources, the way the Uno's pins 2-6 do. Builds the deck the way the
 * service does (collectPinStates over a real PinManager, then the netlist).
 */
import { describe, it, expect, vi } from 'vitest';

const pms = new Map<string, unknown>();
vi.mock('../store/useSimulatorStore', () => ({
  getBoardPinManager: (id: string) => pms.get(id),
  getBoardSimulator: () => undefined,
  useSimulatorStore: { getState: () => ({ boards: [] }), subscribe: () => () => {} },
}));

import { PinManager } from '../simulation/PinManager';
import { collectPinStates } from '../simulation/spice/collectPinStates';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { circuitExamples } from '../data/examples-circuits';

function deckFor(exampleId: string, boardId: string, mark: (pm: PinManager) => void) {
  const ex = circuitExamples.find((e) => e.id === exampleId)!;
  const pm = new PinManager();
  pms.set(boardId, pm);
  mark(pm);
  const wires = ex.wires as Array<{ start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } }>;
  const kind = (ex.boardType ?? 'arduino-uno') as never;
  const pinStates = collectPinStates(boardId, kind, wires);
  const components = (ex.components as Array<{ id: string; type?: string; metadataId?: string; properties?: Record<string, unknown> }>)
    .filter((c) => c.id !== boardId)
    .map((c) => ({ id: c.id, metadataId: (c.metadataId ?? c.type!).replace(/^wokwi-/, ''), properties: c.properties ?? {} }));
  const input = buildInputFromStore({
    components,
    wires: ex.wires as never,
    boards: [{ id: boardId, boardKind: kind, pinStates: pinStates as never }],
  } as never);
  return { pinStates, netlist: buildNetlist(input).netlist };
}

describe('the Mega deck with its pads solves', () => {
  it('ngspice answers the 16-LED deck with pin 22 high in well under a second', { timeout: 60_000 }, async () => {
    const { runNetlist } = await import('./helpers/testSolver');
    const { netlist } = deckFor('mega-multi-led', 'arduino-mega', (pm) => {
      pm.updatePort('PORTA', 0xff, 0, [22, 23, 24, 25, 26, 27, 28, 29], 0xff, 0);
      pm.updatePort('PORTA', 0x01, 0xff, [22, 23, 24, 25, 26, 27, 28, 29], 0xff, 0);
      pm.updatePort('PORTC', 0xff, 0, [37, 36, 35, 34, 33, 32, 31, 30], 0xff, 0);
      pm.updatePort('PORTC', 0, 0xff, [37, 36, 35, 34, 33, 32, 31, 30], 0xff, 0);
    });
    await runNetlist(netlist);                       // warm the engine
    const t0 = Date.now();
    const r = await runNetlist(netlist);
    const ms = Date.now() - t0;
    const { netlist: unoDeck } = deckFor('multi-led-bar', 'arduino-uno', (pm) => {
      pm.updatePort('PORTD', 0b0111_1100, 0, undefined, 0b0111_1100, 0);
      pm.updatePort('PORTD', 0b0000_0100, 0b0111_1100, undefined, 0b0111_1100, 0);
    });
    const t1 = Date.now();
    await runNetlist(unoDeck);
    const unoMs = Date.now() - t1;
    // eslint-disable-next-line no-console
    console.log(`warm solve: mega deck ${ms} ms (${netlist.split('\n').length} cards), uno deck ${unoMs} ms (${unoDeck.split('\n').length} cards)`);
    // The pad's own branch current is the LED's: ~13 mA through 220 ohm
    // when the pin is high, nothing when it is low.
    const i0 = r.dcValue('i(v_arduino_mega_22)');
    const i1 = r.dcValue('i(v_arduino_mega_23)');
    // eslint-disable-next-line no-console
    console.log(`mega deck: ${ms} ms, i(led0)=${i0}, i(led1)=${i1}`);
    expect(ms).toBeLessThan(5000);
    expect(Math.abs(i0 ?? 0)).toBeGreaterThan(0.005);   // pin 22 high: ~13 mA through 220 ohm
    expect(Math.abs(i1 ?? 0)).toBeLessThan(1e-6);       // pin 23 low: dark
  });
});

describe('board pad sources', () => {
  it('the Uno bar stamps a source per driven pin', () => {
    const { pinStates, netlist } = deckFor('multi-led-bar', 'arduino-uno', (pm) => {
      // digitalWrite on PORTD bits 2..6 with DDR set, as the engine reports it.
      pm.updatePort('PORTD', 0b0111_1100, 0, undefined, 0b0111_1100, 0);
      pm.updatePort('PORTD', 0b0000_0100, 0b0111_1100, undefined, 0b0111_1100, 0);
    });
    expect(pinStates['2']).toEqual({ type: 'digital', v: 5 });
    expect(netlist).toContain('V_arduino_uno_2 ');
    expect(netlist).toContain('V_arduino_uno_6 ');
  });

  it('the Mega bar stamps a source per driven pin on PORTA and PORTC', () => {
    const { pinStates, netlist } = deckFor('mega-multi-led', 'arduino-mega', (pm) => {
      // The sweep writes every pin HIGH once; a pin becomes an output on its
      // first write. Then pin 22 is the one left HIGH.
      pm.updatePort('PORTA', 0xff, 0, [22, 23, 24, 25, 26, 27, 28, 29], 0xff, 0);
      pm.updatePort('PORTA', 0x01, 0xff, [22, 23, 24, 25, 26, 27, 28, 29], 0xff, 0);
      pm.updatePort('PORTC', 0xff, 0, [37, 36, 35, 34, 33, 32, 31, 30], 0xff, 0);
      pm.updatePort('PORTC', 0, 0xff, [37, 36, 35, 34, 33, 32, 31, 30], 0xff, 0);
    });
    expect(pinStates['22']).toEqual({ type: 'digital', v: 5 });
    expect(pinStates['30']).toEqual({ type: 'digital', v: 0 });
    for (let p = 22; p <= 37; p++) expect(netlist).toContain(`V_arduino_mega_${p} `);
  });
});

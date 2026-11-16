/**
 * What the supply-on-rail warning says depends on what the pin is (the
 * book-ab2s review's second note on velxio/velxio-prod#96).
 *
 * Velxio holds every board supply pin on an ideal rail, so a bench supply at
 * another voltage there sits at its current limit, and the check names that
 * as a fight with the rail (a warning). The words assumed every such pin is a
 * regulator's output, which is true of an ESP32's 3V3, and wrong for:
 *  - an ATtiny85's VCC, a bare chip's power input: it runs from 2.7 V to
 *    5.5 V, so a 3.7 V supply (a Li-ion cell) powers it, and "the board's
 *    own supply holds at 5 V ... Set it to 5 V, or remove it" is false;
 *  - an STM32 board's 5V pin, the input its 3.3 V regulator is fed from,
 *    which Velxio puts on the 3.3 V rail: 5 V there is how the board is
 *    powered, not a back-feed to "set to 3.3 V".
 * The pin's role comes from the board's (or chip's) pin data, never from its
 * name: a power input declares the range it runs from.
 */
import { describe, it, expect } from 'vitest';
import { buildPreflightSnapshot, type PreflightState } from '../simulation/verify/verifyFromStore';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { verifyCircuit } from '../simulation/verify/circuitVerifier';
import { boardPinGroupFor } from '../simulation/spice/boardPinGroups';

const wire = (id: string, a: string, b: string) => {
  const [ac, ap] = a.split(':');
  const [bc, bp] = b.split(':');
  return { id, start: { componentId: ac!, pinName: ap! }, end: { componentId: bc!, pinName: bp! } };
};

const supply = (voltage: number) => ({
  id: 'ps',
  metadataId: 'power-supply',
  properties: { mode: 'dc', voltage, frequency: 50, currentLimit: 1 },
});

function onPin(boardKind: string, boardId: string, pin: string, voltage: number, gnd = 'GND'): PreflightState {
  return {
    components: [supply(voltage)],
    wires: [wire('w0', `ps:SIG`, `${boardId}:${pin}`), wire('w1', 'ps:GND', `${boardId}:${gnd}`)],
    boards: [{ id: boardId, boardKind }],
  };
}

async function supplyFindings(state: PreflightState) {
  const { snap, synthesizedPins } = buildPreflightSnapshot(state);
  const result = await verifyCircuit(buildInputFromStore(snap), { synthesizedPins });
  return { result, mine: [...result.errors, ...result.warnings].filter((f) => f.componentId === 'ps') };
}

describe("a supply on an ATtiny85's VCC, the chip's power input", () => {
  it('3.7 V (a Li-ion cell) powers the chip: said so, and never "set it to 5 V"', async () => {
    const { result, mine } = await supplyFindings(onPin('attiny85', 'attiny85', 'VCC', 3.7));
    expect(result.errors).toEqual([]);
    expect(mine.map((f) => f.code)).toEqual(['supply-on-rail']);
    const text = mine[0]!.message;
    expect(text).toContain('VCC');
    expect(text).toMatch(/power input/);
    expect(text).toContain('2.7 V to 5.5 V');
    expect(text).toMatch(/powers attiny85 at 3\.7 V/);
    expect(text).not.toMatch(/Set it to 5 V|remove it|cannot sink|back-feed|own supply/);
  });

  it('9 V is above the range it runs from and its 6 V maximum', async () => {
    const { mine } = await supplyFindings(onPin('attiny85', 'attiny85', 'VCC', 9));
    expect(mine.map((f) => f.code)).toEqual(['supply-on-rail']);
    expect(mine[0]!.message).toMatch(/above/);
    expect(mine[0]!.message).toContain('6 V maximum');
    expect(mine[0]!.message).toMatch(/Set it between 2\.7 V and 5\.5 V/);
    expect(mine[0]!.message).not.toMatch(/back-feed|Set it to 5 V/);
  });

  it('2 V is below it: the chip would not run', async () => {
    const { mine } = await supplyFindings(onPin('attiny85', 'attiny85', 'VCC', 2));
    expect(mine.map((f) => f.code)).toEqual(['supply-on-rail']);
    expect(mine[0]!.message).toMatch(/below/);
    expect(mine[0]!.message).toMatch(/would not run/);
    expect(mine[0]!.message).not.toMatch(/cannot sink|Set it to 5 V/);
  });

  it('5 V, the voltage the simulation runs it at, says nothing', async () => {
    expect((await supplyFindings(onPin('attiny85', 'attiny85', 'VCC', 5))).mine).toEqual([]);
  });
});

describe("a supply on an STM32 board's 5V pin, its regulator's input", () => {
  it('5 V powers the board: said so, and never "set it to 3.3 V"', async () => {
    const { result, mine } = await supplyFindings(onPin('stm32-bluepill', 'bp', '5V', 5));
    expect(result.errors).toEqual([]);
    expect(mine.map((f) => f.code)).toEqual(['supply-on-rail']);
    expect(mine[0]!.message).toContain('5V pin of bp');
    expect(mine[0]!.message).toMatch(/powers bp at 5 V/);
    expect(mine[0]!.message).not.toMatch(/Set it to 3\.3 V|back-feed/);
  });

  it('names the pin the supply is wired to when the 3V3 pin is wired too', async () => {
    const state: PreflightState = {
      components: [supply(5), { id: 'r1', metadataId: 'resistor', properties: { value: '10k' } }],
      wires: [
        wire('w0', 'r1:1', 'bp:3V3'),
        wire('w1', 'r1:2', 'bp:GND'),
        wire('w2', 'ps:SIG', 'bp:5V'),
        wire('w3', 'ps:GND', 'bp:GND'),
      ],
      boards: [{ id: 'bp', boardKind: 'stm32-bluepill' }],
    };
    const { mine } = await supplyFindings(state);
    expect(mine.map((f) => f.code)).toEqual(['supply-on-rail']);
    expect(mine[0]!.message).toContain('5V pin of bp');
    expect(mine[0]!.message).not.toContain('3V3 pin');
  });

  it("the 3V3 pin stays the regulator's output: 5 V there back-feeds it", async () => {
    const { mine } = await supplyFindings(onPin('stm32-bluepill', 'bp', '3V3', 5));
    expect(mine.map((f) => f.code)).toEqual(['supply-on-rail']);
    expect(mine[0]!.message).toMatch(/back-feed/);
  });
});

describe('the role is the pin data, not the board name', () => {
  it('the ATtiny85 and STM32 groups declare their power inputs; an ESP32 declares none on its rail', () => {
    expect(boardPinGroupFor('attiny85').powerInputs?.VCC).toEqual({ min: 2.7, max: 5.5 });
    expect(boardPinGroupFor('stm32-bluepill').powerInputs?.['5V']).toBeDefined();
    expect(boardPinGroupFor('stm32-blackpill-f401').powerInputs?.['5V']).toBeDefined();
    expect(boardPinGroupFor('esp32').powerInputs).toBeUndefined();
  });

  it("an ESP32's 3V3 declared a power input by hand takes the input words", async () => {
    const state = onPin('esp32', 'esp32', '3V3', 3);
    const input = buildInputFromStore(buildPreflightSnapshot(state).snap);
    input.boards[0]!.powerInputs = { '3V3': { min: 3.0, max: 3.6 } };
    const result = await verifyCircuit(input);
    const mine = result.warnings.filter((f) => f.componentId === 'ps');
    expect(mine.map((f) => f.code)).toEqual(['supply-on-rail']);
    expect(mine[0]!.message).toMatch(/power input/);
    expect(mine[0]!.message).not.toMatch(/cannot sink/);
  });

  it("an Uno's 5V pin, which the board drives from USB, keeps the regulator words", async () => {
    const { mine } = await supplyFindings(onPin('arduino-uno', 'uno', '5V', 3.7, 'GND.1'));
    expect(mine.map((f) => f.code)).toEqual(['supply-on-rail']);
    expect(mine[0]!.message).toMatch(/cannot sink/);
  });
});

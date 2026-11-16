/**
 * The pre-run circuit check leaves the pads a chip can only read alone
 * (velxio/velxio-prod#173).
 *
 * The check stamps every wired GPIO as a 3.3 V output, the worst case of a
 * sketch that drives it HIGH. GPIO34 to GPIO39 of the classic ESP32 have no
 * output driver ("GPIO34-39 can only be set as input mode", ESP-IDF GPIO
 * reference), and the pads VP and VN are two of them. Forced HIGH, a cell
 * measured on one is a 3.3 V ideal source against 1.5 V and 0.15 ohm: a
 * blocking "short circuit, 12 A" that no sketch can produce, and a 9 V
 * battery on VP read as a 3.8 A short instead of the over-voltage it is.
 */
import { describe, it, expect } from 'vitest';
import { buildPreflightSnapshot } from '../simulation/verify/verifyFromStore';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { verifyCircuit } from '../simulation/verify/circuitVerifier';
import { isInputOnlyPad } from '../utils/boardPinMapping';

const w = (id: string, a: [string, string], b: [string, string]) => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});

/** A cell straight on a pad of a board, as a first ADC lab wires it. */
async function cellOn(boardKind: string, pad: string, cell = 'battery-aa') {
  const { snap, synthesizedPins } = buildPreflightSnapshot({
    components: [{ id: 'bat', metadataId: cell, properties: {} }],
    wires: [w('w1', ['bat', '+'], ['board', pad]), w('w2', ['bat', '-'], ['board', 'GND'])],
    boards: [{ id: 'board', boardKind }],
  });
  const result = await verifyCircuit(buildInputFromStore(snap), { synthesizedPins });
  return { synthesizedPins, codes: result.errors.map((e) => e.code) };
}

describe('the pre-flight and input-only pads (velxio/velxio-prod#173)', () => {
  for (const [kind, pad] of [
    ['esp32', '34'],
    ['esp32', '35'],
    ['esp32', 'VP'],
    ['esp32', 'VN'],
    ['esp32-devkit-c-v4', 'VP'],
    ['wemos-lolin32-lite', 'GPIO34'],
  ] as const) {
    it(`${kind} ${pad}: a cell measured there is no short circuit`, { timeout: 30_000 }, async () => {
      const { synthesizedPins, codes } = await cellOn(kind, pad);
      expect([...synthesizedPins]).toEqual([]);
      expect(codes).not.toContain('short-circuit');
    });
  }

  it('an output-capable pad is still checked as the output it may become', () => {
    const { synthesizedPins } = buildPreflightSnapshot({
      components: [
        { id: 'r1', metadataId: 'resistor', properties: { value: '220' } },
        { id: 'led1', metadataId: 'led', properties: { color: 'red' } },
      ],
      wires: [w('w1', ['board', '26'], ['r1', '1']), w('w2', ['r1', '2'], ['led1', 'A']), w('w3', ['led1', 'C'], ['board', 'GND'])],
      boards: [{ id: 'board', boardKind: 'esp32' }],
    });
    expect([...synthesizedPins]).toEqual(['board:26']);
  });

  it('knows the input-only pads by chip, under every name a board gives them', () => {
    expect(['34', '35', 'VP', 'VN', '36', '39'].map((p) => isInputOnlyPad('esp32', p))).toEqual([true, true, true, true, true, true]);
    expect(isInputOnlyPad('wemos-lolin32-lite', 'GPIO35')).toBe(true);
    expect(isInputOnlyPad('esp32', '32')).toBe(false);
    // Other chips have no such pads: GPIO34-39 of an S3 are ordinary I/O.
    expect(isInputOnlyPad('esp32-s3', '35')).toBe(false);
    expect(isInputOnlyPad('arduino-uno', 'A0')).toBe(false);
  });
});

/**
 * The Run check says when 5 V reaches an ESP32 pin (velxio/velxio-prod#175).
 *
 * An ESP32 input takes at most VDD + 0.3 V: 3.6 V on a 3.3 V board (ESP32
 * datasheet v5.3, Table 5-3, VIH max; the S3 and C3 datasheets give the same).
 * The check rated only the boards' supply pins, and its solve forces every wired
 * GPIO to 3.3 V (the worst case for an LED), so a 5 V supply through 1 kOhm into
 * GPIO4, or an Uno's 5V pin wired straight to it, passed with nothing said.
 */
import { describe, expect, it } from 'vitest';
import { buildPreflightSnapshot } from '../simulation/verify/verifyFromStore';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { verifyCircuit } from '../simulation/verify/circuitVerifier';

type Comp = { id: string; metadataId: string; properties: Record<string, unknown> };
const w = (id: string, a: [string, string], b: [string, string]) => ({
  id,
  start: { componentId: a[0], pinName: a[1] },
  end: { componentId: b[0], pinName: b[1] },
});

async function overVoltage(
  components: Comp[],
  wires: ReturnType<typeof w>[],
  boards: Array<{ id: string; boardKind: string }>,
) {
  const { snap, synthesizedPins } = buildPreflightSnapshot({ components, wires, boards });
  const result = await verifyCircuit(buildInputFromStore(snap), { synthesizedPins });
  return [...result.errors, ...result.warnings].filter((x) => x.code === 'over-voltage');
}

const SUPPLY_5V: Comp = { id: 'psu', metadataId: 'power-supply', properties: { voltage: '5', currentLimit: '1' } };

describe('5 V on an ESP32 pin (velxio/velxio-prod#175)', () => {
  it('a 5 V supply through 1 kOhm into GPIO4 is named, with the voltage it puts there', { timeout: 30_000 }, async () => {
    const found = await overVoltage(
      [SUPPLY_5V, { id: 'r1', metadataId: 'resistor', properties: { value: '1k' } }],
      [w('w1', ['psu', '+'], ['r1', '1']), w('w2', ['r1', '2'], ['esp', '4']), w('w3', ['psu', '-'], ['esp', 'GND'])],
      [{ id: 'esp', boardKind: 'esp32' }],
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.componentId).toBe('esp');
    expect(found[0]!.message).toContain('GPIO4');
    expect(found[0]!.message).toMatch(/5\.0 V/);
    expect(found[0]!.message).toMatch(/3\.6 V/);
    expect(found[0]!.metric).toBeCloseTo(5, 1);
  });

  it("an Uno's 5V pin wired straight to GPIO4 is named, whichever board was placed first", { timeout: 30_000 }, async () => {
    for (const boards of [
      [{ id: 'uno', boardKind: 'arduino-uno' }, { id: 'esp', boardKind: 'esp32' }],
      [{ id: 'esp', boardKind: 'esp32' }, { id: 'uno', boardKind: 'arduino-uno' }],
    ]) {
      const found = await overVoltage([], [w('w1', ['uno', '5V'], ['esp', '4']), w('w2', ['uno', 'GND.1'], ['esp', 'GND'])], boards);
      expect(found.map((f) => f.componentId)).toEqual(['esp']);
      expect(found[0]!.message).toContain('5V');
      expect(found[0]!.message).toContain('uno');
    }
  });

  it("the ESP32's own 5V pin wired to a GPIO is named", { timeout: 30_000 }, async () => {
    const found = await overVoltage([], [w('w1', ['esp', '5V'], ['esp', '27'])], [{ id: 'esp', boardKind: 'esp32' }]);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('GPIO27');
  });

  it("an Uno's pin wired to a GPIO is named for when it drives HIGH", { timeout: 30_000 }, async () => {
    const found = await overVoltage(
      [],
      [w('w1', ['uno', '1'], ['esp', '16']), w('w2', ['uno', 'GND.1'], ['esp', 'GND'])],
      [{ id: 'uno', boardKind: 'arduino-uno' }, { id: 'esp', boardKind: 'esp32' }],
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('GPIO16');
    expect(found[0]!.message).toMatch(/drives HIGH/);
  });

  it("a Raspberry Pi's pin is 3.3 V logic, though the Pi takes 5 V in: no warning", { timeout: 30_000 }, async () => {
    const quiet = await overVoltage(
      [],
      [w('w1', ['pi', 'GPIO14'], ['esp', '16']), w('w2', ['pi', 'GND'], ['esp', 'GND'])],
      [{ id: 'esp', boardKind: 'esp32' }, { id: 'pi', boardKind: 'raspberry-pi-4' }],
    );
    expect(quiet).toEqual([]);
  });

  it('a pot across VIN reads as over-voltage only where its wiper passes 3.6 V', { timeout: 30_000 }, async () => {
    const pot = (value: number) =>
      overVoltage(
        [{ id: 'pot', metadataId: 'potentiometer', properties: { value } }],
        [w('w1', ['esp', 'VIN'], ['pot', 'VCC']), w('w2', ['pot', 'GND'], ['esp', 'GND']), w('w3', ['pot', 'SIG'], ['esp', '34'])],
        [{ id: 'esp', boardKind: 'esp32' }],
      );
    expect(await pot(512)).toEqual([]); // 2.5 V
    const high = await pot(1000); // 4.89 V
    expect(high).toHaveLength(1);
    expect(high[0]!.message).toContain('GPIO34');
  });

  it('what a correct circuit does stays quiet: a 10k/20k divider from 5 V, a pull-up to 3V3, an LED', { timeout: 30_000 }, async () => {
    const quiet = await overVoltage(
      [
        { id: 'ra', metadataId: 'resistor', properties: { value: '10k' } },
        { id: 'rb', metadataId: 'resistor', properties: { value: '20k' } },
        { id: 'rp', metadataId: 'resistor', properties: { value: '10k' } },
        { id: 'rl', metadataId: 'resistor', properties: { value: '220' } },
        { id: 'led', metadataId: 'led', properties: { color: 'red' } },
      ],
      [
        w('w1', ['esp', '5V'], ['ra', '1']),
        w('w2', ['ra', '2'], ['rb', '1']),
        w('w3', ['rb', '2'], ['esp', 'GND']),
        w('w4', ['ra', '2'], ['esp', '35']),
        w('w5', ['esp', '3V3'], ['rp', '1']),
        w('w6', ['rp', '2'], ['esp', '4']),
        w('w7', ['esp', '2'], ['rl', '1']),
        w('w8', ['rl', '2'], ['led', 'A']),
        w('w9', ['led', 'C'], ['esp', 'GND.1']),
      ],
      [{ id: 'esp', boardKind: 'esp32' }],
    );
    expect(quiet).toEqual([]);
  });

  it("a pull-up to the ESP32's 3V3 next to an Uno placed first is not mistaken for 5 V", { timeout: 30_000 }, async () => {
    // The netlist puts every board's main supply on one rail at the first
    // board's voltage (a known limit), so on a mixed canvas only the wiring is
    // read, not the solve.
    const quiet = await overVoltage(
      [{ id: 'rp', metadataId: 'resistor', properties: { value: '10k' } }],
      [w('w1', ['esp', '3V3'], ['rp', '1']), w('w2', ['rp', '2'], ['esp', '4']), w('w3', ['uno', 'GND.1'], ['esp', 'GND'])],
      [{ id: 'uno', boardKind: 'arduino-uno' }, { id: 'esp', boardKind: 'esp32' }],
    );
    expect(quiet).toEqual([]);
  });

  it('a 5 V board on its own is never checked this way', { timeout: 30_000 }, async () => {
    const quiet = await overVoltage(
      [SUPPLY_5V, { id: 'r1', metadataId: 'resistor', properties: { value: '1k' } }],
      [w('w1', ['psu', '+'], ['r1', '1']), w('w2', ['r1', '2'], ['uno', '4']), w('w3', ['psu', '-'], ['uno', 'GND.1'])],
      [{ id: 'uno', boardKind: 'arduino-uno' }],
    );
    expect(quiet).toEqual([]);
  });
});

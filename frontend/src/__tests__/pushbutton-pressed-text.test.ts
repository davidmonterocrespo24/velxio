/**
 * A pushbutton's `pressed` property written as text (velxio/velxio-prod#151).
 *
 * The metadata declares the field as text, so the part inspector stores what
 * is typed, and an imported project or the agent's set_property can store
 * "false" too. The canvas reads text as on only when it says "true" or "1"
 * (DynamicComponent), while the circuit read the field with Boolean(), and
 * Boolean("false") is true: the button was drawn released while its switch
 * was closed in the solve, so the sketch read it pressed (pin 2 at 0 V, 111 uA
 * through the pull-up, instead of 4.98 V and 5 nA).
 */
import { describe, it, expect } from 'vitest';
import { componentToSpice } from '../simulation/spice/componentToSpice';
import { flagProperty } from '../utils/flagProperty';

const CLOSED = 'R_b1_sw gpio gnd 0.01';
const OPEN = 'R_b1_sw gpio gnd 1000000000';

function switchCard(metadataId: string, pressed: unknown): string | undefined {
  const wired: Record<string, string> = { '1.l': 'gpio', '2.l': 'gnd' };
  const emission = componentToSpice(
    { id: 'b1', metadataId, properties: { pressed } },
    (pin) => wired[pin] ?? null,
    { vcc: 5 },
  );
  return emission?.cards.find((c) => c.startsWith('R_b1_sw'));
}

describe('pushbutton pressed written as text (velxio/velxio-prod#151)', () => {
  for (const metadataId of ['pushbutton', 'pushbutton-6mm']) {
    it(`${metadataId}: "false", "0" and other text leave the switch open`, () => {
      for (const text of ['false', '0', 'off', 'no', 'False', '']) {
        expect(switchCard(metadataId, text), JSON.stringify(text)).toBe(OPEN);
      }
    });

    it(`${metadataId}: "true" and "1" close it, as the canvas draws them`, () => {
      expect(switchCard(metadataId, 'true')).toBe(CLOSED);
      expect(switchCard(metadataId, '1')).toBe(CLOSED);
    });

    it(`${metadataId}: a real boolean (a click at run time) still works`, () => {
      expect(switchCard(metadataId, true)).toBe(CLOSED);
      expect(switchCard(metadataId, false)).toBe(OPEN);
      expect(switchCard(metadataId, undefined)).toBe(OPEN);
    });
  }

  it('the circuit and the canvas read every value the same way', () => {
    // DynamicComponent hands the element flagProperty(text) for a field whose
    // default is a boolean, and any other value as it is (the element reads
    // its truthiness): the switch must be closed exactly when the part is
    // drawn pressed.
    for (const value of ['true', '1', 'false', '0', 'yes', '', true, false, 1, 0, undefined]) {
      const drawnPressed = flagProperty(value);
      expect(switchCard('pushbutton', value), JSON.stringify(value)).toBe(
        drawnPressed ? CLOSED : OPEN,
      );
    }
  });
});

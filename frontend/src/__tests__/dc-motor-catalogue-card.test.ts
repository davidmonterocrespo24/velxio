/**
 * The OSS picker's card for the online editor's DC motor says what the part
 * models (velxio/velxio-prod#164).
 *
 * The card promised "a stall current" when the motor had no electrical model
 * at all: it drew no current and turned at duty(control pin) x 9000 rpm
 * whatever the circuit did. Release 8 made it a load in the circuit solve,
 * the running motor at its operating point (5 V at about 90 mA), with no
 * stall or start-up current, and the card stopped promising one. The motor is
 * now its winding, its back-EMF and its shaft, and the circuit carries their
 * state from one pad state to the next: it draws its start-up current, about
 * 1 A at 5 V, coasts down on its back-EMF, and its winding kicks when it is
 * switched off. The card says so.
 */
import { describe, expect, it } from 'vitest';
import { ONLINE_ONLY_COMPONENT_ADS } from '../lib/onlineOnlyBoards';

describe('the DC motor card (velxio/velxio-prod#164)', () => {
  const card = ONLINE_ONLY_COMPONENT_ADS.find((c) => c.id === 'pro-dc-motor');

  it('says it draws a start-up current and kicks when switched off, which the part models', () => {
    expect(card).toBeDefined();
    expect(card!.description).toMatch(/start-up current/i);
    expect(card!.description).toMatch(/kicks when it is switched off/i);
  });

  it('says the motor is part of the circuit: it draws its current from the supply', () => {
    expect(card!.description).toMatch(/current from the supply/i);
    expect(card!.description).toMatch(/voltage across it/i);
    expect(card!.description).toMatch(/ - available in the online editor$/);
  });
});

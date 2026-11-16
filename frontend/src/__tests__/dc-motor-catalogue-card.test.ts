/**
 * The OSS picker's card for the online editor's DC motor says what the part
 * models (velxio/velxio-prod#164).
 *
 * The card promised "a stall current". The motor had no electrical model at
 * all: it drew no current and turned at duty(control pin) x 9000 rpm whatever
 * the circuit did. It now is a load in the circuit solve, the running motor at
 * its operating point (5 V at about 90 mA), and its speed follows the voltage
 * the circuit puts across it; a stall or start-up current is still not
 * modelled, so the card must not promise one.
 */
import { describe, expect, it } from 'vitest';
import { ONLINE_ONLY_COMPONENT_ADS } from '../lib/onlineOnlyBoards';

describe('the DC motor card (velxio/velxio-prod#164)', () => {
  const card = ONLINE_ONLY_COMPONENT_ADS.find((c) => c.id === 'pro-dc-motor');

  it('promises no stall current, which the part does not model', () => {
    expect(card).toBeDefined();
    expect(card!.description).not.toMatch(/stall/i);
  });

  it('says the motor is part of the circuit: it draws its current from the supply', () => {
    expect(card!.description).toMatch(/current from the supply/i);
    expect(card!.description).toMatch(/voltage across it/i);
    expect(card!.description).toMatch(/ - available in the online editor$/);
  });
});

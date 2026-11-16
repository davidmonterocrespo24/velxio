/**
 * The pushbutton's datasheet says what the simulated part does
 * (velxio/velxio-prod#148).
 *
 * The doc the picker shows on hover (and the agent reads) said "It bounces on
 * press/release — debounce in code or with an RC". A real tactile switch does
 * bounce, but Velxio's does not: the part flips its pin once per press
 * (BasicParts.ts) and the circuit solve switches between 0.01 ohm and 1 Gohm
 * (componentToSpice.ts), so debounce code is never exercised in the
 * simulator. Wokwi does simulate bounce by default
 * (docs.wokwi.com/parts/wokwi-pushbutton), which makes the claim read as a
 * description of the simulation. The doc now says both: a real button
 * bounces, this one switches cleanly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { componentToSpice } from '../simulation/spice/componentToSpice';

const DOC = readFileSync(new URL('../components/component-docs/input/pushbutton.md', import.meta.url), 'utf8');

describe('pushbutton datasheet (velxio/velxio-prod#148)', () => {
  it('the simulated switch has two states and nothing in between: it does not bounce', () => {
    const card = (pressed: boolean) =>
      componentToSpice(
        { id: 'b', metadataId: 'pushbutton', properties: { pressed } },
        (pin) => ({ '1.l': 'a', '2.l': 'b' })[pin] ?? null,
        { vcc: 5 },
      )!.cards.join('\n');
    expect(card(true)).toMatch(/R_b_sw a b 0\.01/);
    expect(card(false)).toMatch(/R_b_sw a b 1000000000/);
  });

  it('does not tell the reader the simulated button bounces', () => {
    expect(DOC).not.toMatch(/It bounces on press/i);
    expect(DOC).toMatch(/real button bounces/i);
    expect(DOC).toMatch(/Velxio's (button|switch)[^.]*\bclean/i);
  });
});

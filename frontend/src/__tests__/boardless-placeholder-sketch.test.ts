/**
 * The placeholder sketch of a board-less gallery circuit says how it runs
 * today (velxio/velxio-prod#98).
 *
 * The 30 analog and 39 digital examples loaded a placeholder that said
 * "Toggle the electrical-simulation (⚡) button to run the SPICE engine". That
 * toggle was removed in April 2026 (dcb8a92b: SPICE is always active), and the
 * toolbar has no such button: a board-less circuit simulates as soon as it is
 * on the canvas (loadExample leaves it unpaused), Stop freezes it and Run
 * resumes it. The digital ones do not even run on ngspice any more: an
 * all-digital circuit runs on the event-driven digital engine.
 */
import { describe, it, expect } from 'vitest';
import { analogExamples } from '../data/examples-analog';
import { digitalExamples } from '../data/examples-digital';
import { analogProjectExamples } from '../data/examples-analog-projects';

const BOARDLESS = [...analogExamples, ...digitalExamples, ...analogProjectExamples];

describe('the board-less placeholder sketch (velxio/velxio-prod#98)', () => {
  it('covers every board-less gallery circuit', () => {
    expect(analogExamples.length).toBe(30);
    expect(digitalExamples.length).toBe(39);
  });

  it('names no button the toolbar does not have', () => {
    const stale = BOARDLESS.filter((e) => /⚡|electrical-simulation|Toggle the/i.test(e.code)).map((e) => e.id);
    expect(stale).toEqual([]);
  });

  it('says the circuit runs on its own, and what Stop and Run do', () => {
    for (const e of [...analogExamples, ...digitalExamples]) {
      expect(e.code, e.id).toMatch(/no microcontroller/i);
      expect(e.code, e.id).toMatch(/simulates as soon as it is on the canvas/i);
      expect(e.code, e.id).toMatch(/Stop freezes it; Run resumes it/);
    }
    for (const e of digitalExamples) expect(e.code, e.id).toMatch(/slide switches/i);
  });
});

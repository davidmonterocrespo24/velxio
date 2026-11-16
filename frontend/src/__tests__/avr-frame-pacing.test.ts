/**
 * The Uno's frame loop is paced by CPU cycles, not by instructions
 * (velxio/velxio-prod#139).
 *
 * Each animation frame emulates the wall time that passed since the last one:
 * 16 000 cycles per millisecond at 16 MHz. The loop used to execute that many
 * INSTRUCTIONS instead, and an AVR instruction takes one to four cycles
 * (ATmega328P datasheet DS40002061B, Instruction Set Summary: RJMP, LD, ST 2,
 * CALL and RET 4). avr8js charges every instruction its datasheet cost on
 * `cpu.cycles`, so a frame advanced the guest clock by the sketch's cycles per
 * instruction times what it meant to: about 1.3x on a Blink (delay(500) lasted
 * 385 ms of wall time), 2x on a tight RJMP loop. Inside the sketch everything
 * stayed consistent (millis(), the scope, the UART); against the wall clock,
 * and against the host-clock RTC models, the Uno ran fast.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';

/** RJMP .-2 at address 0: one 2-cycle instruction, forever. */
const RJMP_SELF_HEX = ':02000000FFCF30\n:00000001FF\n';

const BLINK_HEX = readFileSync(
  fileURLToPath(new URL('./fixtures/avr-blink/avr-blink.ino.hex', import.meta.url)),
  'utf-8',
);

const CYCLES_PER_MS = 16_000;

// The frame loop re-arms itself through requestAnimationFrame; the test is the
// browser and hands it one timestamp at a time.
let pending: FrameRequestCallback | null = null;
beforeEach(() => {
  pending = null;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    pending = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    pending = null;
  });
});
afterEach(() => vi.unstubAllGlobals());

function frameAt(timestampMs: number): void {
  const cb = pending;
  pending = null;
  if (!cb) throw new Error('the frame loop did not ask for another frame');
  cb(timestampMs);
}

describe('AVRSimulator frame pacing (velxio/velxio-prod#139)', () => {
  it('a 16 ms frame advances the CPU by 256 000 cycles, whatever its instructions cost', () => {
    const sim = new AVRSimulator(new PinManager());
    sim.loadHex(RJMP_SELF_HEX);
    sim.start();
    frameAt(1000); // the first frame catches up at most 50 ms
    const before = sim.getCurrentCycles();
    frameAt(1016);
    const advanced = sim.getCurrentCycles() - before;
    sim.stop();
    // At most one instruction past the budget (the longest AVR instruction is
    // four cycles); a 2-cycle RJMP counted as one would make this 512 000.
    expect(advanced).toBeGreaterThanOrEqual(16 * CYCLES_PER_MS);
    expect(advanced).toBeLessThan(16 * CYCLES_PER_MS + 4);
  });

  it('a second of frames is a second of guest time on a real Blink', () => {
    const sim = new AVRSimulator(new PinManager());
    sim.loadHex(BLINK_HEX);
    sim.start();
    const t0 = 1000;
    frameAt(t0);
    const before = sim.getCurrentCycles();
    // Sixty frames of a 60 Hz display: 1000 ms of wall time.
    for (let k = 1; k <= 60; k++) frameAt(t0 + (k * 1000) / 60);
    const guestMs = (sim.getCurrentCycles() - before) / CYCLES_PER_MS;
    sim.stop();
    // The overshoot of each frame is carried into the next, so a second of
    // frames is a second of guest time to within one instruction.
    expect(guestMs).toBeGreaterThan(999.99);
    expect(guestMs).toBeLessThan(1000.01);
  });

  it('the guest time a frame buys does not drift with the instruction mix', () => {
    const sim = new AVRSimulator(new PinManager());
    sim.loadHex(BLINK_HEX);
    sim.start();
    frameAt(1000);
    // Odd frame lengths (a 144 Hz display, a dropped frame) add up exactly.
    const deltas = [6.944, 6.944, 6.945, 33.333, 16.667, 0.5, 49.9];
    let t = 1000;
    const before = sim.getCurrentCycles();
    for (const d of deltas) frameAt((t += d));
    const total = deltas.reduce((a, b) => a + b, 0);
    const advanced = sim.getCurrentCycles() - before;
    sim.stop();
    expect(Math.abs(advanced - total * CYCLES_PER_MS)).toBeLessThan(4);
  });
});

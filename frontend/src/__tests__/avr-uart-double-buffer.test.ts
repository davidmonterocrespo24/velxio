/**
 * The ATmega's transmitter is double-buffered (velxio/velxio-prod#161).
 *
 * UDRn is a buffer in front of the shift register: a byte written there moves
 * to the shift register at once when it is idle, or right after the stop bit
 * of the frame on the wire, and UDREn is set as soon as the buffer is free
 * again (ATmega328P datasheet DS40002061B sections 20.6.1 and 20.6.3). So the
 * next character is queued while the current one shifts out and frames leave
 * back to back, one frame time apart. avr8js sets UDRE only when the whole
 * frame is over, so the UDRE interrupt's latency (about 66 cycles with
 * HardwareSerial) was added to every character: 1.0442 ms instead of 1.0400 ms
 * at 9600 baud (+0.4 %), 89.1 us instead of 85.0 us at 115200 (+4.9 %), the
 * figures the book measured.
 *
 * The fixture prints 46 characters through HardwareSerial at 9600 baud, then
 * at 115200 (avr-uart-back-to-back.ino, compiled by the compile service).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';

const HEX = readFileSync(
  fileURLToPath(new URL('./fixtures/avr-uart-back-to-back/avr-uart-back-to-back.ino.hex', import.meta.url)),
  'utf-8',
);
const TEXT = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij';

/** A 10-bit frame (8N1) in CPU cycles: UBRR 207 with U2X at 9600, UBRR 16 at 115200. */
const FRAME_9600 = (207 + 1) * 8 * 10; // 16 640
const FRAME_115200 = (16 + 1) * 8 * 10; // 1 360

interface Sent {
  ch: string;
  cycle: number;
}

let sent: Sent[] = [];
/** Every level the scope draws on TX (pin 1), in cycles, in the order it was emitted. */
let txEdges: Array<{ cycle: number; level: boolean }> = [];

beforeAll(() => {
  const sim = new AVRSimulator(new PinManager());
  sim.loadHex(HEX);
  const cpu = (sim as unknown as { cpu: { cycles: number } }).cpu;
  sim.onSerialData = (ch) => sent.push({ ch, cycle: cpu.cycles });
  sim.onPinChangeWithTime = (pin, state, timeMs) => {
    if (pin === 1) txEdges.push({ cycle: Math.round(timeMs * 16_000), level: state });
  };
  sent = [];
  txEdges = [];
  while (cpu.cycles < 80 * 16_000) sim.step();
  sim.stop();
});

/**
 * The start bit of each frame the scope drew: the first falling edge after
 * the previous frame's stop bit. ASCII has bit 7 clear, so every frame here
 * ends with the rise to its stop bit, 9 bit times after its start.
 */
function startBits(): number[] {
  const starts: number[] = [];
  let i = 0;
  for (const bitCycles of [FRAME_9600 / 10, FRAME_115200 / 10]) {
    for (let k = 0; k < TEXT.length && i < txEdges.length; k++) {
      while (i < txEdges.length && txEdges[i].level) i++;
      if (i >= txEdges.length) break;
      const t = txEdges[i].cycle;
      starts.push(t);
      i++;
      while (i < txEdges.length && txEdges[i].cycle < t + 9.5 * bitCycles) i++;
    }
  }
  return starts;
}

/** The spacing between consecutive frames of one rate, skipping the first two (the ring filling up). */
function gaps(cycles: number[]): number[] {
  const out: number[] = [];
  for (let i = 3; i < cycles.length; i++) out.push(cycles[i] - cycles[i - 1]);
  return out;
}

describe('AVR USART double buffering (velxio/velxio-prod#161)', () => {
  it('sends the whole text at both rates, in order', () => {
    expect(sent.map((s) => s.ch).join('')).toBe(TEXT + TEXT);
  });

  it('at 9600 baud the characters leave one frame apart (1.040 ms), not 1.044 ms', () => {
    const g = gaps(sent.slice(0, TEXT.length).map((s) => s.cycle));
    const mean = g.reduce((a, b) => a + b, 0) / g.length;
    expect(mean).toBeGreaterThan(FRAME_9600 - 2);
    expect(mean).toBeLessThan(FRAME_9600 + 2);
    for (const d of g) expect(d).toBeLessThan(FRAME_9600 + 5);
  });

  it('at 115200 baud they leave 85.0 us apart, not 89.1 us', () => {
    const g = gaps(sent.slice(TEXT.length).map((s) => s.cycle));
    const mean = g.reduce((a, b) => a + b, 0) / g.length;
    expect(mean).toBeGreaterThan(FRAME_115200 - 2);
    expect(mean).toBeLessThan(FRAME_115200 + 2);
    for (const d of g) expect(d).toBeLessThan(FRAME_115200 + 5);
  });

  it('the scope draws each frame where the shift register starts it, never over the previous one', () => {
    const starts = startBits();
    expect(starts.length).toBe(TEXT.length * 2);
    const slow = gaps(starts.slice(0, TEXT.length));
    const fast = gaps(starts.slice(TEXT.length));
    for (const d of slow) {
      expect(d).toBeGreaterThanOrEqual(FRAME_9600);
      expect(d).toBeLessThan(FRAME_9600 + 5);
    }
    for (const d of fast) {
      expect(d).toBeGreaterThanOrEqual(FRAME_115200);
      expect(d).toBeLessThan(FRAME_115200 + 5);
    }
  });
});

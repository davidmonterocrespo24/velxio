/**
 * How the ATmega enters an interrupt (velxio/velxio-prod#158).
 *
 * ATmega328P datasheet DS40002061B, section 7.7: "The interrupt execution
 * response for all the enabled AVR interrupts is four clock cycles minimum":
 * the return address is pushed and I is cleared, then the vector's jump runs.
 * The ATmega2560 pushes a 3-byte PC and takes five (its datasheet, section
 * 7.8.1). avr8js charges two on both. Section 7.7 also says that the
 * instruction following SEI is executed before any pending interrupt, and that
 * after RETI the AVR always executes one more instruction of the main program
 * before it serves a pending one; avr8js serves it at once in both cases
 * (avr8js issue #38 asked for the RETI rule in 2020), so a level that stays
 * pending starved the main program.
 *
 * The programs are hand-assembled. Words:
 *   0x0000  RJMP main            0x0002  RJMP isr  (INT0's vector, word 2)
 *   0x0020  isr: NOP, NOP, RETI
 *   0x0040  main: SEI, NOP, NOP, NOP, RJMP .-2
 * The interrupt is raised from the test through INT0's flag and mask.
 */
import { describe, it, expect } from 'vitest';
import type { AVRInterruptConfig } from 'avr8js/dist/esm/cpu/cpu';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';

const NOP = 0x0000;
const SEI = 0x9478;
const RETI = 0x9518;
/** RJMP from word `at` to word `to`. */
const rjmp = (at: number, to: number) => 0xc000 | ((to - at - 1) & 0x0fff);

const MAIN = 0x40;
const ISR = 0x20;
const VECTOR = 0x02;

function program(): number[] {
  const words = new Array<number>(0x48).fill(NOP);
  words[0] = rjmp(0, MAIN);
  words[VECTOR] = rjmp(VECTOR, ISR);
  words[ISR] = NOP;
  words[ISR + 1] = NOP;
  words[ISR + 2] = RETI;
  words[MAIN] = SEI;
  words[MAIN + 1] = NOP;
  words[MAIN + 2] = NOP;
  words[MAIN + 3] = NOP;
  words[MAIN + 4] = rjmp(MAIN + 4, MAIN + 4);
  return words;
}

/** Intel HEX, 16 bytes per record, little-endian words. */
function toIntelHex(words: number[]): string {
  const bytes: number[] = [];
  for (const w of words) bytes.push(w & 0xff, (w >> 8) & 0xff);
  const lines: string[] = [];
  for (let addr = 0; addr < bytes.length; addr += 16) {
    const chunk = bytes.slice(addr, addr + 16);
    const rec = [chunk.length, (addr >> 8) & 0xff, addr & 0xff, 0, ...chunk];
    const sum = rec.reduce((a, b) => a + b, 0);
    rec.push((0x100 - (sum & 0xff)) & 0xff);
    lines.push(':' + rec.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase());
  }
  lines.push(':00000001FF');
  return lines.join('\n') + '\n';
}

// INT0's flag (EIFR bit 0) and mask (EIMSK bit 0), on the ATmega328P and 2560 alike.
const INT0: AVRInterruptConfig = {
  address: VECTOR,
  flagRegister: 0x3c,
  flagMask: 0x01,
  enableRegister: 0x3d,
  enableMask: 0x01,
};

interface Cpu {
  pc: number;
  cycles: number;
  data: Uint8Array;
  setInterruptFlag(i: AVRInterruptConfig): void;
}

function boot(variant: 'uno' | 'mega'): { sim: AVRSimulator; cpu: Cpu } {
  const sim = new AVRSimulator(new PinManager(), variant);
  sim.loadHex(toIntelHex(program()));
  const cpu = (sim as unknown as { cpu: Cpu }).cpu;
  cpu.data[INT0.enableRegister] |= INT0.enableMask;
  return { sim, cpu };
}

/** Run until the PC reaches `pc` (at most `limit` instructions). */
function runTo(sim: AVRSimulator, cpu: Cpu, pc: number, limit = 64): void {
  for (let i = 0; i < limit && cpu.pc !== pc; i++) sim.step();
  expect(cpu.pc).toBe(pc);
}

/** The return address the interrupt pushed (16-bit PC: two bytes, high byte at SP+1). */
function pushedReturn(cpu: Cpu): number {
  const sp = cpu.data[0x5d] | (cpu.data[0x5e] << 8);
  return (cpu.data[sp + 1] << 8) | cpu.data[sp + 2];
}

describe('AVR interrupt response (velxio/velxio-prod#158)', () => {
  it('the ATmega328P takes four cycles from the end of an instruction to the vector', () => {
    const { sim, cpu } = boot('uno');
    runTo(sim, cpu, MAIN + 1); // SEI has run: interrupts are on
    sim.step(); // one NOP, with nothing pending
    const c0 = cpu.cycles;
    cpu.setInterruptFlag(INT0);
    sim.step(); // a NOP (1 cycle), then the interrupt
    expect(cpu.pc).toBe(VECTOR);
    expect(cpu.cycles - c0).toBe(1 + 4);
    sim.stop();
  });

  it('the ATmega2560 takes five (its PC is three bytes)', () => {
    const { sim, cpu } = boot('mega');
    runTo(sim, cpu, MAIN + 1);
    sim.step();
    const c0 = cpu.cycles;
    cpu.setInterruptFlag(INT0);
    sim.step();
    expect(cpu.pc).toBe(VECTOR);
    expect(cpu.cycles - c0).toBe(1 + 5);
    sim.stop();
  });

  it('the instruction after SEI runs before a pending interrupt', () => {
    const { sim, cpu } = boot('uno');
    runTo(sim, cpu, MAIN); // about to execute SEI, interrupts off
    cpu.setInterruptFlag(INT0); // pending, but masked by I
    sim.step(); // SEI
    expect(cpu.pc, 'served right after SEI').toBe(MAIN + 1);
    sim.step(); // the NOP after SEI, then the interrupt
    expect(cpu.pc).toBe(VECTOR);
    expect(pushedReturn(cpu)).toBe(MAIN + 2);
    sim.stop();
  });

  it('after RETI one instruction of the main program runs before the next interrupt', () => {
    const { sim, cpu } = boot('uno');
    runTo(sim, cpu, MAIN + 2);
    cpu.setInterruptFlag(INT0);
    runTo(sim, cpu, ISR); // in the handler
    cpu.setInterruptFlag(INT0); // a second event while the handler runs
    runTo(sim, cpu, ISR + 2); // at RETI
    sim.step(); // RETI
    const back = cpu.pc;
    expect(back, 're-entered with no main instruction').not.toBe(VECTOR);
    sim.step(); // one main instruction, then the pending interrupt
    expect(cpu.pc).toBe(VECTOR);
    expect(pushedReturn(cpu)).not.toBe(back);
    sim.stop();
  });
});

/**
 * Zilog Z80 emulator chip — TDD spec.
 *
 * The Z80 is binary-compatible with the 8080 plus extensions, so the
 * 8080 tests' structure carries over. This file focuses on:
 *   1. The Z80-specific bus protocol (M1̅ / MREQ̅ / IORQ̅ / RFSH̅)
 *   2. Z80-only instructions (EX, EXX, DJNZ, IX/IY, block ops, IM 0-2)
 *   3. NMI behaviour (pushes PC, vectors to 0x0066)
 *
 * The 8080-subset instructions are NOT re-tested here — once both chips
 * are implemented, a shared "8080-subset suite" should run against both.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BoardHarness } from '../src/BoardHarness.js';
import { chipWasmExists, hex8, hex16 } from '../src/helpers.js';

const CHIP = 'z80';
const skip = !chipWasmExists(CHIP);

const CLOCK_HZ = 4_000_000;
const CLOCK_NS = Math.round(1e9 / CLOCK_HZ);

function fullPinMap() {
  const m = {
    M1: 'M1', MREQ: 'MREQ', IORQ: 'IORQ', RD: 'RD', WR: 'WR', RFSH: 'RFSH',
    HALT: 'HALT', WAIT: 'WAIT', INT: 'INT', NMI: 'NMI', RESET: 'RESET',
    BUSREQ: 'BUSREQ', BUSACK: 'BUSACK', CLK: 'CLK',
    VCC: 'VCC', GND: 'GND',
  };
  for (let i = 0; i < 16; i++) m[`A${i}`] = `A${i}`;
  for (let i = 0; i < 8;  i++) m[`D${i}`] = `D${i}`;
  return m;
}

async function bootZ80(program) {
  const board = new BoardHarness();
  await board.addChip(CHIP, fullPinMap());

  board.installFakeRom(program, {
    addrPrefix: 'A', addrWidth: 16,
    dataPrefix: 'D', dataWidth: 8,
    rd: 'RD', rdActiveLow: true,
    cs: 'MREQ',                       // only respond when MREQ̅ is asserted
    csActiveLow: true,
    baseAddr: 0,
  });

  const ram = board.installFakeRam(0x8000, {
    addrPrefix: 'A', addrWidth: 16,
    dataPrefix: 'D', dataWidth: 8,
    rd: 'RD', wr: 'WR',
    cs: 'MREQ',
    baseAddr: 0x8000,
  });

  board.setNet('WAIT',   true);   // not waiting
  board.setNet('INT',    true);   // INT̅ deasserted (active-low on Z80)
  board.setNet('NMI',    true);   // NMI̅ deasserted
  board.setNet('BUSREQ', true);
  board.setNet('RESET',  false);
  board.advanceNanos(CLOCK_NS * 4);
  board.setNet('RESET',  true);
  // Do NOT advance after RESET deassert — the caller has its own
  // advanceNanos loop, and may want to poke RAM contents first
  // (same lesson as bootCpu in the 8080 tests).
  return { board, ram };
}

describe('Zilog Z80 chip', () => {

  describe('pin contract', () => {
    it.skipIf(skip)('registers all 40 named pins', async () => {
      const board = new BoardHarness();
      await expect(board.addChip(CHIP, fullPinMap())).resolves.toBeDefined();
      board.dispose();
    });
  });

  describe('reset', () => {
    it.skipIf(skip)('first M1 fetch is from 0x0000', async () => {
      const board = new BoardHarness();
      await board.addChip(CHIP, fullPinMap());

      const m1Fetches = [];
      board.watchNet('M1', (low) => {
        if (low === false) m1Fetches.push(board.readBus('A', 16));
      });
      board.installFakeRom([0x00, 0x00, 0x76], {  // NOP NOP HALT
        rd: 'RD', cs: 'MREQ', csActiveLow: true,
      });
      board.setNet('WAIT', true);
      board.setNet('INT', true);
      board.setNet('NMI', true);
      board.setNet('BUSREQ', true);
      board.setNet('RESET', false);
      board.advanceNanos(CLOCK_NS * 4);
      board.setNet('RESET', true);
      board.advanceNanos(CLOCK_NS * 30);

      expect(m1Fetches[0], 'first M1 fetch').toBe(0x0000);
      board.dispose();
    });
  });

  describe('M1 cycle', () => {
    it.skipIf(skip)('asserts M1̅ + MREQ̅ + RD̅ during opcode fetch', async () => {
      const board = new BoardHarness();
      await board.addChip(CHIP, fullPinMap());

      let sawAllAsserted = false;
      board.watchNet('M1', (state) => {
        if (state === false) {
          // Snap the other signals at the same instant
          if (board.getNet('MREQ') === false && board.getNet('RD') === false) {
            sawAllAsserted = true;
          }
        }
      });
      board.installFakeRom([0x00, 0x76], { rd: 'RD', cs: 'MREQ', csActiveLow: true });
      board.setNet('WAIT', true);
      board.setNet('INT', true); board.setNet('NMI', true); board.setNet('BUSREQ', true);
      board.setNet('RESET', false);
      board.advanceNanos(CLOCK_NS * 4);
      board.setNet('RESET', true);
      board.advanceNanos(CLOCK_NS * 30);

      expect(sawAllAsserted, 'M1̅, MREQ̅, RD̅ asserted simultaneously during fetch').toBe(true);
      board.dispose();
    });

    it.skipIf(skip)('asserts RFSH̅ during the refresh phase of M1', async () => {
      const board = new BoardHarness();
      await board.addChip(CHIP, fullPinMap());

      let rfshSeen = false;
      board.watchNet('RFSH', (state) => { if (state === false) rfshSeen = true; });
      board.installFakeRom([0x00, 0x00, 0x76], { rd: 'RD', cs: 'MREQ', csActiveLow: true });
      board.setNet('WAIT', true); board.setNet('INT', true);
      board.setNet('NMI', true); board.setNet('BUSREQ', true);
      board.setNet('RESET', false);
      board.advanceNanos(CLOCK_NS * 4);
      board.setNet('RESET', true);
      board.advanceNanos(CLOCK_NS * 30);

      expect(rfshSeen, 'RFSH̅ must pulse low after M1 fetch').toBe(true);
      board.dispose();
    });
  });

  describe('Z80-only instructions', () => {
    // Z80 mnemonic constants — only those used in tests below.
    const LD_A_n   = 0x3E;
    const LD_BC_nn = 0x01;
    const LD_DE_nn = 0x11;
    const LD_HL_nn = 0x21;
    const LD_IX_nn = 0xDD; const _IX_LD_nn = 0x21;   // DD 21 nn nn
    const EX_DE_HL = 0xEB;
    const EXX      = 0xD9;
    const DJNZ     = 0x10;
    const LDIR     = 0xED; const _LDIR = 0xB0;       // ED B0
    const LD_aHL_n = 0x36;
    const LD_addr_A = 0x32;
    const HALT     = 0x76;

    it.skipIf(skip)('EX DE, HL swaps register pairs', async () => {
      // LD HL, 0x1234 ; LD DE, 0x5678 ; EX DE, HL ; LD (0x8000), A is awkward
      // because we can't read HL/DE directly. Use this instead:
      // LD HL, 0xAA00 ; LD DE, 0xBB00 ; EX DE, HL ; LD (HL), 0x77 ; HALT
      // After EX, HL = 0xBB00 (in our RAM range) so we write to 0xBB00.
      // Wait, 0xBB00 is in our RAM (0x8000+) — yes.
      const program = new Uint8Array([
        LD_HL_nn, 0x00, 0xAA,
        LD_DE_nn, 0x00, 0xBB,
        EX_DE_HL,
        LD_aHL_n, 0x77,
        HALT,
      ]);
      const { board, ram } = await bootZ80(program);
      for (let i = 0; i < 200; i++) board.advanceNanos(CLOCK_NS);
      expect(ram.peek(0xBB00)).toBe(0x77);
      board.dispose();
    });

    it.skipIf(skip)('DJNZ decrements B and jumps while non-zero', async () => {
      // LD A, 0 ; LD B, 5 ; LOOP: INC A ; DJNZ LOOP ; LD (0x8000), A ; HALT
      // Expected: A = 5 stored at 0x8000.
      const INC_A = 0x3C;
      const program = new Uint8Array([
        LD_A_n, 0x00,
        0x06, 0x05,                        // LD B, 5
        INC_A,                             // LOOP:
        DJNZ, 0xFD,                        // jump back -3 to LOOP
        LD_addr_A, 0x00, 0x80,             // LD (0x8000), A
        HALT,
      ]);
      const { board, ram } = await bootZ80(program);
      for (let i = 0; i < 500; i++) board.advanceNanos(CLOCK_NS);
      expect(ram.peek(0x8000)).toBe(5);
      board.dispose();
    });

    it.skipIf(skip)('LDIR copies a memory block from HL to DE', async () => {
      // Pre-load source: 4 bytes at 0xC000..0xC003. Then LDIR HL=0xC000,
      // DE=0x9000, BC=4. After: 4 bytes copied to 0x9000..0x9003.
      const program = new Uint8Array([
        LD_HL_nn, 0x00, 0xC0,    // LD HL, 0xC000
        LD_DE_nn, 0x00, 0x90,    // LD DE, 0x9000
        LD_BC_nn, 0x04, 0x00,    // LD BC, 0x0004
        LDIR, _LDIR,             // ED B0
        HALT,
      ]);
      const { board, ram } = await bootZ80(program);
      ram.poke(0xC000, 0x11);
      ram.poke(0xC001, 0x22);
      ram.poke(0xC002, 0x33);
      ram.poke(0xC003, 0x44);
      for (let i = 0; i < 500; i++) board.advanceNanos(CLOCK_NS);
      expect(ram.peek(0x9000)).toBe(0x11);
      expect(ram.peek(0x9001)).toBe(0x22);
      expect(ram.peek(0x9002)).toBe(0x33);
      expect(ram.peek(0x9003)).toBe(0x44);
      board.dispose();
    });

    it.skipIf(skip)('LD A, (IX+d) reads via IX with signed displacement', async () => {
      // Pre-load 0xCD at 0xA005. Set IX = 0xA000. LD A, (IX+5) → A=0xCD.
      // Then LD (0x9000), A so we can verify.
      const program = new Uint8Array([
        LD_IX_nn, _IX_LD_nn, 0x00, 0xA0,   // DD 21 00 A0 — LD IX, 0xA000
        0xDD, 0x7E, 0x05,                    // DD 7E 05 — LD A, (IX+5)
        LD_addr_A, 0x00, 0x90,               // LD (0x9000), A
        HALT,
      ]);
      const { board, ram } = await bootZ80(program);
      ram.poke(0xA005, 0xCD);
      for (let i = 0; i < 400; i++) board.advanceNanos(CLOCK_NS);
      expect(ram.peek(0x9000)).toBe(0xCD);
      board.dispose();
    });

    it.skipIf(skip)('EXX swaps the main register set with the shadow set', async () => {
      // LD HL, 0x1111
      // EXX             ; swap → HL = shadow (0x0000 after reset shadow init)
      // LD HL, 0x9000   ; main HL now 0x9000 (was the shadow)
      // EXX             ; swap back → original HL = 0x1111 in main set
      // LD (HL), 0x77   ; writes to 0x1111... wait, main HL is 0x1111
      //                 ; that's not in our RAM range (0x8000+).
      // Restructure: use two HL values both in RAM range.
      // LD HL, 0x9100 ; EXX ; LD HL, 0x9200 ; EXX ; LD (HL), 0x77 ; HALT
      // After: write to 0x9100 (the original main HL).
      const program = new Uint8Array([
        LD_HL_nn, 0x00, 0x91,    // LD HL, 0x9100 (main)
        EXX,                      // → main set goes to shadow
        LD_HL_nn, 0x00, 0x92,    // LD HL, 0x9200 (this is now the new "main")
        EXX,                      // → swap back; main HL = 0x9100
        LD_aHL_n, 0x77,           // LD (HL), 0x77 → write 0x77 to 0x9100
        HALT,
      ]);
      const { board, ram } = await bootZ80(program);
      for (let i = 0; i < 300; i++) board.advanceNanos(CLOCK_NS);
      expect(ram.peek(0x9100)).toBe(0x77);
      // Verify the OTHER write didn't happen (shadow set's HL=0x9200
      // was never written via LD (HL), 0x77 in the shadow context).
      expect(ram.peek(0x9200)).toBe(0x00);
      board.dispose();
    });
  });

  describe('interrupts', () => {
    it.skipIf(skip)('NMI̅ falling edge pushes PC and vectors to 0x0066', async () => {
      // EI ; loop: NOP ; JR -1
      // ISR at 0x0066: LD A, 0xAB ; LD (0x9000), A ; HALT
      const program = new Uint8Array(0x80);
      program.fill(0x00);
      program[0x00] = 0xFB;             // EI
      program[0x01] = 0x00;             // NOP
      program[0x02] = 0x18; program[0x03] = 0xFD;   // JR -3 → loop
      program[0x66] = 0x3E; program[0x67] = 0xAB;   // LD A, 0xAB
      program[0x68] = 0x32; program[0x69] = 0x00; program[0x6A] = 0x90; // LD (0x9000), A
      program[0x6B] = 0x76;             // HALT
      const { board, ram } = await bootZ80(program);
      // Run a few cycles to enter the loop.
      for (let i = 0; i < 50; i++) board.advanceNanos(CLOCK_NS);
      // Pulse NMI̅ low (active low) → falling edge triggers interrupt.
      board.setNet('NMI', false);
      board.advanceNanos(CLOCK_NS * 4);
      board.setNet('NMI', true);
      for (let i = 0; i < 200; i++) board.advanceNanos(CLOCK_NS);
      expect(ram.peek(0x9000)).toBe(0xAB);
      board.dispose();
    });

    it.skipIf(skip)('IM 1 + INT̅ vectors to 0x0038', async () => {
      // EI ; IM 1 ; loop: NOP ; JR -1
      // ISR at 0x0038: LD A, 0x39 ; LD (0x9000), A ; HALT
      const program = new Uint8Array(0x80);
      program.fill(0x00);
      program[0x00] = 0xFB;             // EI
      program[0x01] = 0xED; program[0x02] = 0x56;   // IM 1
      program[0x03] = 0x00;             // NOP loop
      program[0x04] = 0x18; program[0x05] = 0xFD;   // JR -3
      program[0x38] = 0x3E; program[0x39] = 0x39;   // LD A, 0x39
      program[0x3A] = 0x32; program[0x3B] = 0x00; program[0x3C] = 0x90;
      program[0x3D] = 0x76;             // HALT
      const { board, ram } = await bootZ80(program);
      for (let i = 0; i < 50; i++) board.advanceNanos(CLOCK_NS);
      // INT̅ active-low: drive low to request interrupt.
      board.setNet('INT', false);
      for (let i = 0; i < 200; i++) board.advanceNanos(CLOCK_NS);
      board.setNet('INT', true);
      for (let i = 0; i < 200; i++) board.advanceNanos(CLOCK_NS);
      expect(ram.peek(0x9000)).toBe(0x39);
      board.dispose();
    });

    it.todo('IM 2 + INT̅ uses I:byte to vector through a table');
  });

  describe('integration', () => {
    it.todo('runs the public-domain ZEXDOC test ROM (documented flags)');
  });
});

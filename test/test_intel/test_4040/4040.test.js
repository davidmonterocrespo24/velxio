/**
 * Intel 4040 emulator chip — TDD spec.
 *
 * The 4040 is a strict superset of the 4004. It adds:
 *   - Interrupts (INT pin, fixed vector — verify exact addr from datasheet)
 *   - Single-step / STOP / STOP-ACK
 *   - Expanded register file (16 → 24 4-bit registers)
 *   - Deeper PC stack (3 → 7)
 *   - 14 new opcodes (interrupt enable/disable, return-from-interrupt,
 *     stop, additional register-pair ops)
 *   - 24-pin DIP, 2 CM-ROM lines (vs 1 on 4004)
 *
 * Tests focus on the deltas from 4004. The shared 4004-subset behavior
 * should be exercised by a parametrised re-run of test_4004's suite once
 * both chips are implemented (deferred).
 */
import { describe, it, expect } from 'vitest';
import { BoardHarness } from '../src/BoardHarness.js';
import { chipWasmExists } from '../src/helpers.js';

const CHIP = '4040';
const skip = !chipWasmExists(CHIP);

const CLOCK_HZ = 740_000;
const CLOCK_NS = Math.round(1e9 / CLOCK_HZ);

/** Same shape as Bus4004 in test_4004/4004.test.js — 4040 inherits the
 *  4004's 8-phase nibble-multiplexed bus protocol. See those comments. */
class Bus4040 {
  constructor(board, program) {
    this.board = board;
    this.program = program;
    this.phase = -1;
    this.pcLow = 0; this.pcMid = 0; this.pcHigh = 0;
    this.observedPc = 0;
    this.board.watchNet('SYNC', (high) => { if (high) this.phase = 0; });
  }
  _drive(nibble) {
    for (let i = 0; i < 4; i++) {
      this.board.setNet(`D${i}`, ((nibble >> i) & 1) === 1);
    }
  }
  step() {
    if (this.phase === 3) {
      const byte = this.program[this.observedPc & 0xFFF] || 0;
      this._drive((byte >> 4) & 0xF);
    } else if (this.phase === 4) {
      const byte = this.program[this.observedPc & 0xFFF] || 0;
      this._drive(byte & 0xF);
    }
    this.board.advanceNanos(CLOCK_NS);
    if (this.phase === 0)      this.pcLow  = this.board.readBus('D', 4);
    else if (this.phase === 1) this.pcMid  = this.board.readBus('D', 4);
    else if (this.phase === 2) this.pcHigh = this.board.readBus('D', 4);
    if (this.phase === 2) {
      this.observedPc = this.pcLow | (this.pcMid << 4) | (this.pcHigh << 8);
    }
    if (this.phase >= 0) this.phase = (this.phase + 1) & 7;
  }
  runCycle()      { for (let i = 0; i < 8; i++) this.step(); }
  runCycles(n)    { for (let i = 0; i < n; i++) this.runCycle(); }
  pc()            { return this.observedPc; }
}

/**
 * Pin names match the Intel MCS-40 User's Manual (Nov 1974) pin-description
 * table on pages 1-5/1-6. Φ1/Φ2 are renamed CLK1/CLK2 (no Greek letters in
 * C identifiers); the three −15 V supply pins (Vdd, Vdd1, Vdd2) are kept
 * separate even though velxio is digital and treats them all as power.
 */
function fullPinMap() {
  const m = {
    SYNC: 'SYNC', RESET: 'RESET', TEST: 'TEST',
    CMROM0: 'CMROM0', CMROM1: 'CMROM1',
    CMRAM0: 'CMRAM0', CMRAM1: 'CMRAM1', CMRAM2: 'CMRAM2', CMRAM3: 'CMRAM3',
    CLK1: 'CLK1', CLK2: 'CLK2',
    STP: 'STP', STPA: 'STPA',          // Stop input + Stop-acknowledge output
    INT: 'INT', INTA: 'INTA',          // Interrupt input + ack output
    CY: 'CY',                          // Carry output buffer (open drain)
    VDD: 'VDD', VDD1: 'VDD1', VDD2: 'VDD2', VSS: 'VSS',
  };
  for (let i = 0; i < 4; i++) m[`D${i}`] = `D${i}`;
  return m;
}

describe('Intel 4040 chip', () => {

  describe('pin contract', () => {
    it.skipIf(skip)('registers the 24-pin contract (4004 superset)', async () => {
      const board = new BoardHarness();
      await expect(board.addChip(CHIP, fullPinMap())).resolves.toBeDefined();
      board.dispose();
    });
  });

  describe('STP / STPA', () => {
    it.skipIf(skip)('asserting STP causes STPA to assert within one cycle', async () => {
      // Per MCS-40 manual p. 1-10: when STP is latched at M2, the STOP FF
      // sets at X3; the CPU then executes NOPs in a loop (clock and SYNC
      // KEEP RUNNING) and STPA asserts. So the assertion here is that
      // STPA goes high — we deliberately do NOT assert that SYNC stops.
      const board = new BoardHarness();
      await board.addChip(CHIP, fullPinMap());

      // Reset and run a few cycles freely.
      board.setNet('RESET', true);
      board.advanceNanos(CLOCK_NS * 12);   // ≥96 clk per p. 1-5 RESET min
      board.setNet('RESET', false);
      for (let i = 0; i < 16; i++) board.advanceNanos(CLOCK_NS);

      // Now assert STP (active high per pin description, p. 1-5) and watch.
      let acked = false;
      board.watchNet('STPA', (high) => { if (high) acked = true; });
      board.setNet('STP', true);

      // Allow up to 2 instruction cycles for the chip to latch STP at M2
      // and assert STPA at X3.
      for (let i = 0; i < 24; i++) board.advanceNanos(CLOCK_NS);

      expect(acked, 'STPA must rise within ~two instruction cycles').toBe(true);
      board.dispose();
    });
  });

  describe('interrupts', () => {
    it.skipIf(skip)('INT high after EIN vectors PC to 0x003 and asserts INTA', async () => {
      // Program:  EIN ; NOP ; NOP ; BBS (at 0x003)
      const prog = new Uint8Array(0x100);
      prog[0] = 0x0C;       // EIN
      prog[1] = 0x00;       // NOP
      prog[2] = 0x00;       // NOP
      prog[3] = 0x02;       // BBS (executes when interrupt fires)
      const board = new BoardHarness();
      await board.addChip(CHIP, fullPinMap());

      // Boot
      board.setNet('STP', false);
      board.setNet('INT', false);
      board.setNet('RESET', true);
      board.advanceNanos(CLOCK_NS * 12);
      board.setNet('RESET', false);

      const bus = new Bus4040(board, prog);

      let intaSeen = false;
      board.watchNet('INTA', (high) => { if (high) intaSeen = true; });

      // Cycle 0 executes EIN → IFF=1.
      // Cycle 1 fetches NOP at 0x001. Before its M2, the test asserts
      // INT; M2 latches it; X3 vectors to 0x003.
      bus.runCycle();           // EIN
      board.setNet('INT', true);
      bus.runCycle();           // NOP at 0x001 — INT latched at M2, vector at X3.
      // Cycle 2 fetches at 0x003 (the vector address).
      bus.runCycle();
      expect(bus.pc(), 'PC after interrupt vector').toBe(0x003);
      expect(intaSeen, 'INTA must have asserted').toBe(true);
      board.dispose();
    });

    it.skipIf(skip)('BBS pops PC and clears INTA', async () => {
      // Per MCS-40 manual p. 1-12: INT pushes the "pre-interrupt PC (NOT
      // incremented)" — i.e. the address of the instruction the CPU was
      // about to execute (0x001, the NOP we hadn't run yet). BBS pops
      // that PC, so control returns to re-execute that NOP. After it
      // runs, PC advances to 0x002.
      const prog = new Uint8Array(0x100);
      prog[0] = 0x0C;       // EIN
      prog[1] = 0x00;       // NOP — INT latched during this cycle
      prog[3] = 0x02;       // BBS at vector
      const board = new BoardHarness();
      await board.addChip(CHIP, fullPinMap());
      board.setNet('STP', false);
      board.setNet('INT', false);
      board.setNet('RESET', true);
      board.advanceNanos(CLOCK_NS * 12);
      board.setNet('RESET', false);

      const bus = new Bus4040(board, prog);
      let intaWasHigh = false;
      let intaFell = false;
      board.watchNet('INTA', (high) => {
        if (high) intaWasHigh = true;
        else if (intaWasHigh) intaFell = true;
      });

      bus.runCycle();           // EIN @ 0x000 → IFF=1
      board.setNet('INT', true);
      bus.runCycle();           // NOP @ 0x001 → INT latched at M2; vector at X3
      board.setNet('INT', false);
      bus.runCycle();           // BBS @ 0x003 → pop PC → 0x001; INTA cleared
      bus.runCycle();           // re-execute NOP @ 0x001 → PC=0x002
      bus.runCycle();           // observe at PC=0x002

      expect(bus.pc()).toBe(0x002);
      expect(intaFell, 'INTA must de-assert during BBS').toBe(true);
      board.dispose();
    });
  });

  describe('extended register file', () => {
    it.skipIf(skip)('SB1 + FIM writes to bank-1 R0..R7 (R16..R23 region)', async () => {
      // Strategy: distinguish bank-0 from bank-1 by setting up registers
      // such that only bank-1 access produces a non-branch on ISZ.
      //   1. FIM P0, 0xFF      ; bank-0 R0=F, R1=F (the chip starts at SB0)
      //   2. SB1                ; switch to bank 1
      //   3. FIM P0, 0x10       ; bank-1 R0=1, R1=0
      //   4. SB0                ; back to bank 0
      //   5. ISZ R0, target=0x20; bank-0 R0 was F → INC wraps to 0 →
      //                          NO branch (PC falls through to next op)
      // If SB1 didn't work, step 3 would have overwritten bank-0 R0 with 1,
      // and step 5's ISZ would INC 1→2 → branch taken → PC=0x020.
      const prog = new Uint8Array(0x80);
      prog[0] = 0x20; prog[1] = 0xFF;     // FIM P0, 0xFF
      prog[2] = 0x0B;                       // SB1
      prog[3] = 0x20; prog[4] = 0x10;     // FIM P0, 0x10
      prog[5] = 0x0A;                       // SB0
      prog[6] = 0x70; prog[7] = 0x20;     // ISZ R0, target 0x020
      prog[8] = 0x00;                       // NOP (fall-through path)
      const board = new BoardHarness();
      await board.addChip(CHIP, fullPinMap());
      board.setNet('STP', false);
      board.setNet('INT', false);
      board.setNet('RESET', true);
      board.advanceNanos(CLOCK_NS * 12);
      board.setNet('RESET', false);

      const bus = new Bus4040(board, prog);
      // 6 instructions + observation. ISZ is 2-byte (2 cycles). FIMs
      // are 2-byte (2 cycles each). SB0/SB1 are 1-byte. Total cycles
      // through ISZ end: FIM(2) + SB1(1) + FIM(2) + SB0(1) + ISZ(2) = 8.
      // Cycle 9 will fetch the next instruction — at 0x008 if not taken.
      bus.runCycles(9);
      // Bank-1 worked → R0 stayed F → ISZ wraps to 0 → no branch → PC=8.
      expect(bus.pc()).toBe(0x008);
      board.dispose();
    });
  });

  describe('4040 + 4002 RAM integration', () => {
    const RAM = '4002-ram';
    const skipIntegration = skip || !chipWasmExists(RAM);

    it.skipIf(skipIntegration)(
      'SRC + WMP drives the 4002 output port from ACC',
      async () => {
        //   PC=0x00: 0xD3  LDM 3   →  ACC=3
        //   PC=0x01: 0x21  SRC P0  →  drive R0:R1=0:0 → chip-pair=0
        //   PC=0x02: 0xE1  WMP     →  4002.O0..O3 = 3
        const PROG = new Uint8Array(0x40);
        PROG[0] = 0xD3;
        PROG[1] = 0x21;
        PROG[2] = 0xE1;

        const board = new BoardHarness();
        // Register the 4002 BEFORE the 4040 (same ordering trick as
        // 4004/4002 integration). 4040.CMRAM0 → 4002.CM.
        await board.addChip(RAM, {
          SYNC: 'SYNC', CL: 'CLK1', RESET: 'RESET', CM: 'CMRAM0',
          VDD: 'VDD', VSS: 'VSS',
          D0: 'D0', D1: 'D1', D2: 'D2', D3: 'D3',
          O0: 'O0', O1: 'O1', O2: 'O2', O3: 'O3',
        });
        await board.addChip(CHIP, fullPinMap());

        board.setNet('STP', false);
        board.setNet('INT', false);
        board.setNet('TEST', false);
        board.setNet('RESET', true);
        board.advanceNanos(CLOCK_NS * 12);
        board.setNet('RESET', false);

        const bus = new Bus4040(board, PROG);
        for (let cyc = 0; cyc < 8; cyc++) bus.runCycle();

        let out = 0;
        for (let i = 0; i < 4; i++) if (board.getNet(`O${i}`)) out |= (1 << i);
        expect(out, '4002 output port after WMP must equal ACC (= 3)').toBe(3);
        board.dispose();
      }
    );

    it.skipIf(skipIntegration)(
      'WRM stores into RAM and RDM reads it back through the bus',
      async () => {
        //   0xD5 LDM 5  ; 0x21 SRC P0 ; 0xE0 WRM ; 0xF0 CLB
        //   0xE9 RDM    ; 0xE1 WMP    ; 0x00 NOP
        const PROG = new Uint8Array(0x40);
        PROG[0] = 0xD5;
        PROG[1] = 0x21;
        PROG[2] = 0xE0;
        PROG[3] = 0xF0;
        PROG[4] = 0xE9;
        PROG[5] = 0xE1;

        const board = new BoardHarness();
        await board.addChip(RAM, {
          SYNC: 'SYNC', CL: 'CLK1', RESET: 'RESET', CM: 'CMRAM0',
          VDD: 'VDD', VSS: 'VSS',
          D0: 'D0', D1: 'D1', D2: 'D2', D3: 'D3',
          O0: 'O0', O1: 'O1', O2: 'O2', O3: 'O3',
        });
        await board.addChip(CHIP, fullPinMap());

        board.setNet('STP', false);
        board.setNet('INT', false);
        board.setNet('TEST', false);
        board.setNet('RESET', true);
        board.advanceNanos(CLOCK_NS * 12);
        board.setNet('RESET', false);

        const bus = new Bus4040(board, PROG);
        for (let cyc = 0; cyc < 12; cyc++) bus.runCycle();

        let out = 0;
        for (let i = 0; i < 4; i++) if (board.getNet(`O${i}`)) out |= (1 << i);
        expect(out, 'WMP after RDM must surface the mem-stored 5').toBe(5);
        board.dispose();
      }
    );
  });
});

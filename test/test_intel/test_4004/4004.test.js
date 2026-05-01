/**
 * Intel 4004 emulator chip — TDD spec.
 *
 * The 4004 is electrically the most exotic chip on the list:
 *   - 4-bit data bus on D0..D3 multiplexed with addresses across an
 *     8-cycle instruction frame (A1, A2, A3, M1, M2, X1, X2, X3).
 *   - SYNC pulses to mark the start of each instruction frame.
 *   - Two-phase clock (CLK1, CLK2).
 *   - 16 pins total.
 *
 * Because the bus is so different from the 8080/Z80, we don't reuse the
 * fake-ROM helper. Tests here observe the bus phase-by-phase.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BoardHarness } from '../src/BoardHarness.js';
import { chipWasmExists } from '../src/helpers.js';

const CHIP = '4004';
const skip = !chipWasmExists(CHIP);

const CLOCK_HZ = 740_000;
const CLOCK_NS = Math.round(1e9 / CLOCK_HZ);

/**
 * Feed a program into the 4004 via the multiplexed nibble bus, mirroring
 * what a real 4001 ROM would do. The 4004 walks an 8-phase frame
 * (A1, A2, A3, M1, M2, X1, X2, X3) per machine cycle. The test must
 * pre-drive D0..D3 with the appropriate ROM nibble before the chip's
 * M1 and M2 phases fire.
 *
 * Strategy:
 *   - Watch SYNC. When SYNC pulses high, that's the start of a new
 *     cycle (phase A1). We track phasesSinceSync = 0 → 1 → ... → 7.
 *   - phasesSinceSync == 3 means "next tick will be M1": pre-drive
 *     the high nibble of program[pc].
 *   - phasesSinceSync == 4 means "next tick will be M2": pre-drive
 *     the low nibble.
 *   - At end of every cycle (X3 done), advance our shadow pc by 1 IF
 *     the chip didn't jump. We detect jumps by reading the address
 *     bus during the next cycle's A1/A2/A3 phases and re-syncing.
 *
 * We track the chip's PC by reading what it drives on D0..D3 during
 * A1/A2/A3 phases. That keeps pc in lockstep regardless of jumps.
 *
 * The class exposes `step()` (advance one phase) and `runCycles(n)`
 * (advance n full instruction cycles).
 */
class Bus4004 {
  constructor(board, program) {
    this.board = board;
    this.program = program;
    this.phase = -1;     // 0=A1, 1=A2, 2=A3, 3=M1, 4=M2, 5=X1, 6=X2, 7=X3
    this.pcLow = 0;
    this.pcMid = 0;
    this.pcHigh = 0;
    this.observedPc = 0;
    this._setupSyncWatch();
  }

  _setupSyncWatch() {
    this.board.watchNet('SYNC', (high) => {
      if (high) this.phase = 0;
    });
  }

  _drive(nibble) {
    for (let i = 0; i < 4; i++) {
      this.board.setNet(`D${i}`, ((nibble >> i) & 1) === 1);
    }
  }

  step() {
    // Pre-drive D pins for the upcoming phase. The chip processes
    // phases 0..7 = A1, A2, A3, M1, M2, X1, X2, X3. Our `phase` field
    // is the COUNT of phases the chip has already executed in this
    // cycle. So phase=3 means "the chip has done A1+A2+A3, next tick
    // will be M1" — that's when we drive the opcode high nibble.
    // phase=4 means "next tick is M2" — drive low nibble.
    if (this.phase === 3) {
      const byte = this.program[this.observedPc & 0xFFF] || 0;
      this._drive((byte >> 4) & 0xF);
    } else if (this.phase === 4) {
      const byte = this.program[this.observedPc & 0xFFF] || 0;
      this._drive(byte & 0xF);
    }

    this.board.advanceNanos(CLOCK_NS);

    // Sample address nibbles after the chip's drives complete.
    if (this.phase === 0)      this.pcLow  = this.board.readBus('D', 4);
    else if (this.phase === 1) this.pcMid  = this.board.readBus('D', 4);
    else if (this.phase === 2) this.pcHigh = this.board.readBus('D', 4);

    // After A3 we have the full PC the chip is about to fetch from.
    if (this.phase === 2) {
      this.observedPc = this.pcLow | (this.pcMid << 4) | (this.pcHigh << 8);
    }

    if (this.phase >= 0) this.phase = (this.phase + 1) & 7;
  }

  /** Run one full instruction cycle (8 phases). */
  runCycle() { for (let i = 0; i < 8; i++) this.step(); }

  /** Run n full cycles. Useful for multi-cycle programs. */
  runCycles(n) { for (let i = 0; i < n; i++) this.runCycle(); }

  /** The PC the chip drove on the bus during the most recent A1..A3. */
  pc() { return this.observedPc; }
}

function fullPinMap() {
  const m = {
    SYNC: 'SYNC', RESET: 'RESET', TEST: 'TEST',
    CMROM: 'CMROM',
    CMRAM0: 'CMRAM0', CMRAM1: 'CMRAM1', CMRAM2: 'CMRAM2', CMRAM3: 'CMRAM3',
    CLK1: 'CLK1', CLK2: 'CLK2',
    VDD: 'VDD', VSS: 'VSS',
  };
  for (let i = 0; i < 4; i++) m[`D${i}`] = `D${i}`;
  return m;
}

async function bootChip(board) {
  await board.addChip(CHIP, fullPinMap());
  board.setNet('TEST', false);
  // Pulse RESET high then low. Do NOT advance time after RESET goes
  // low — caller does that so the first observed cycle starts at
  // phase A1 with PC = 0. (Same lesson as bootCpu in the 8080 tests.)
  board.setNet('RESET', true);
  board.advanceNanos(CLOCK_NS * 10);
  board.setNet('RESET', false);
}

describe('Intel 4004 chip', () => {

  describe('pin contract', () => {
    it.skipIf(skip)('registers all 16 logical pins', async () => {
      const board = new BoardHarness();
      await expect(board.addChip(CHIP, fullPinMap())).resolves.toBeDefined();
      board.dispose();
    });
  });

  describe('instruction-cycle frame', () => {
    it.skipIf(skip)('asserts SYNC once every 8 clock cycles', async () => {
      const board = new BoardHarness();
      await bootChip(board);

      const syncTimes = [];
      board.watchNet('SYNC', (high) => {
        if (high) syncTimes.push(board.nowNanos);
      });

      // Run 24 clock cycles → expect ≈ 3 SYNC pulses.
      for (let i = 0; i < 24; i++) board.advanceNanos(CLOCK_NS);

      expect(syncTimes.length, 'SYNC pulses in 24 cycles').toBeGreaterThanOrEqual(2);
      // Spacing should be ~8 cycles between pulses.
      if (syncTimes.length >= 2) {
        const gap = Number(syncTimes[1] - syncTimes[0]);
        expect(gap).toBeGreaterThan(CLOCK_NS * 6);
        expect(gap).toBeLessThan(CLOCK_NS * 10);
      }
      board.dispose();
    });

    it.skipIf(skip)('drives D0..D3 with 12-bit address across A1, A2, A3 phases', async () => {
      const board = new BoardHarness();
      await bootChip(board);

      // After RESET the PC is 0. The first three nibbles after SYNC
      // should all be 0 (low addr nibble first, by 4004 convention).
      const samples = [];
      let sinceSync = -1;
      // Latch on the FIRST SYNC only — a second pulse in the window
      // would otherwise re-arm the sampler and over-collect.
      board.watchNet('SYNC', (high) => { if (high && sinceSync === -1) sinceSync = 0; });

      for (let i = 0; i < 10; i++) {
        board.advanceNanos(CLOCK_NS);
        if (sinceSync >= 0 && sinceSync < 3) {
          samples.push(board.readBus('D', 4));
          sinceSync++;
        }
      }
      expect(samples.length).toBe(3);
      // For PC = 0 all three nibbles are 0.
      expect(samples).toEqual([0, 0, 0]);
      board.dispose();
    });

    it.skipIf(skip)('CM-ROM strobes during M1 phase of an instruction cycle', async () => {
      const board = new BoardHarness();
      await bootChip(board);

      let cmRomSeen = false;
      board.watchNet('CMROM', (high) => { if (high) cmRomSeen = true; });
      for (let i = 0; i < 16; i++) board.advanceNanos(CLOCK_NS);
      expect(cmRomSeen, 'CM-ROM must pulse high during M1').toBe(true);
      board.dispose();
    });
  });

  describe('instruction set', () => {
    it.skipIf(skip)('NOP advances PC by 1', async () => {
      // [NOP, NOP, NOP, NOP] — every cycle PC increments by 1.
      const prog = [0x00, 0x00, 0x00, 0x00];
      const board = new BoardHarness();
      await bootChip(board);
      const bus = new Bus4004(board, prog);
      const pcs = [];
      for (let cyc = 0; cyc < 4; cyc++) {
        bus.runCycle();
        pcs.push(bus.pc());
      }
      // Cycle 0 fetched at PC=0; cycle 1 at PC=1; etc.
      expect(pcs).toEqual([0, 1, 2, 3]);
      board.dispose();
    });

    it.skipIf(skip)('JUN jumps to absolute 12-bit address', async () => {
      // Prog: JUN 0x123 (bytes 0x41 0x23) at addr 0; rest zeros.
      const prog = new Uint8Array(0x200);
      prog[0] = 0x41; prog[1] = 0x23;     // JUN target=0x123
      const board = new BoardHarness();
      await bootChip(board);
      const bus = new Bus4004(board, prog);
      // Cycle 0: fetch 0x41 (JUN opcode); 2-byte op.
      // Cycle 1: fetch 0x23 (operand); execute → PC = 0x123.
      // Cycle 2: fetch at PC=0x123 (NOP from the all-zero region).
      bus.runCycles(3);
      expect(bus.pc()).toBe(0x123);
      board.dispose();
    });

    it.skipIf(skip)('JMS pushes return address and BBL pops it', async () => {
      // Prog: JMS 0x010, NOP, ... ; at 0x010: BBL 5
      const prog = new Uint8Array(0x100);
      prog[0] = 0x50; prog[1] = 0x10;     // JMS 0x010
      prog[2] = 0x00;                      // NOP (return target after BBL)
      prog[0x10] = 0xC5;                   // BBL 5
      const board = new BoardHarness();
      await bootChip(board);
      const bus = new Bus4004(board, prog);
      // Cycle 0+1: JMS opcode + operand fetch → PC = 0x010.
      // Cycle 2: chip fetches BBL at 0x010 → end of cycle PC = 0x002.
      // Cycle 3: chip fetches NOP at 0x002 → end of cycle PC = 0x003.
      // Cycle 4: chip starts fetch at 0x003. We need cycle 4's A1/A2/A3
      // to OBSERVE the post-NOP PC (since bus.pc() reports the address
      // the chip is currently driving on the bus).
      bus.runCycles(5);
      expect(bus.pc()).toBe(0x003);
      board.dispose();
    });

    it.skipIf(skip)('JCN with C4 jumps when TEST pin is logic-0', async () => {
      // Prog at 0:
      //   JCN 0x1, 0x10  ; jump-if-test-low to 0x010 (C4=1)
      //   ...
      //   at 0x010: zeros (target)
      const prog = new Uint8Array(0x80);
      prog[0] = 0x11; prog[1] = 0x10;     // JCN C4=1, target page-low=0x10
      const board = new BoardHarness();
      await bootChip(board);
      // TEST pin LOW (false) means "logic 0" per [M4] p. 14 — JUMP IF TEST=logic-0
      board.setNet('TEST', false);
      const bus = new Bus4004(board, prog);
      // Cycle 0+1: JCN opcode + operand → PC = 0x010 if condition met.
      // Cycle 2: chip drives PC = 0x010 in A1..A3 (observed).
      bus.runCycles(3);
      expect(bus.pc()).toBe(0x010);
      board.dispose();
    });

    it.skipIf(skip)('JCN does not jump when condition is false', async () => {
      const prog = new Uint8Array(0x80);
      prog[0] = 0x11; prog[1] = 0x10;     // JCN C4=1, target=0x10
      prog[2] = 0x00;                      // fallthrough = NOP
      const board = new BoardHarness();
      await bootChip(board);
      // TEST pin HIGH means "logic 1" → JCN with C4=1 not taken.
      board.setNet('TEST', true);
      const bus = new Bus4004(board, prog);
      // Cycle 0+1: JCN; not taken → PC = 0x002.
      // Cycle 2: chip drives PC = 0x002 in A1..A3 (observed).
      bus.runCycles(3);
      expect(bus.pc()).toBe(0x002);
      board.dispose();
    });

    it.skipIf(skip)('LDM loads the immediate nibble into the accumulator', async () => {
      // Program: LDM 5 ; SRC P0 ; WMP ; NOP
      // After LDM the ACC = 5. SRC P0 drives the (R0:R1) pair on the
      // bus during X2/X3 — both 0 since the regs are still reset.
      // WMP drives ACC on the bus during X2. We capture D0..D3 on
      // exactly the WMP cycle's X2 frame (phase 6 since SYNC) and
      // assert it equals 5.
      const prog = new Uint8Array(0x40);
      prog[0] = 0xD5;
      prog[1] = 0x21;
      prog[2] = 0xE1;
      const board = new BoardHarness();
      await bootChip(board);
      const bus = new Bus4004(board, prog);

      let cycleIdx = -1;
      let phaseSinceSync = -1;
      let wmpX2Drive = null;
      board.watchNet('SYNC', (high) => {
        if (high) { cycleIdx++; phaseSinceSync = 0; }
      });
      // Run cycles 0, 1, 2 phase by phase, capturing D after each step.
      for (let i = 0; i < 24; i++) {
        bus.step();
        // Cycle 2 is WMP; phase 6 since SYNC = X2 frame.
        if (cycleIdx === 2 && phaseSinceSync === 6) {
          wmpX2Drive = board.readBus('D', 4);
        }
        if (phaseSinceSync >= 0) phaseSinceSync++;
      }
      expect(wmpX2Drive, 'WMP X2 must drive ACC = 5 on D bus').toBe(5);
      board.dispose();
    });

    it.skipIf(skip)('FIM loads an 8-bit immediate into a register pair', async () => {
      // Program: FIM P0, 0x57 ; SRC P0 ; NOP...
      // FIM is 2-byte; cycles 0+1 fetch+execute → P0 = (R0=5, R1=7).
      // Cycle 2 is SRC P0; X2 drives high nibble (5), X3 drives low (7).
      const prog = new Uint8Array(0x40);
      prog[0] = 0x20;          // FIM P0 (even = FIM)
      prog[1] = 0x57;          // operand
      prog[2] = 0x21;          // SRC P0
      const board = new BoardHarness();
      await bootChip(board);
      const bus = new Bus4004(board, prog);

      let cycleIdx = -1;
      let phaseSinceSync = -1;
      let srcX2Drive = null, srcX3Drive = null;
      board.watchNet('SYNC', (high) => {
        if (high) { cycleIdx++; phaseSinceSync = 0; }
      });
      for (let i = 0; i < 24; i++) {
        bus.step();
        if (cycleIdx === 2 && phaseSinceSync === 6) srcX2Drive = board.readBus('D', 4);
        if (cycleIdx === 2 && phaseSinceSync === 7) srcX3Drive = board.readBus('D', 4);
        if (phaseSinceSync >= 0) phaseSinceSync++;
      }
      expect(srcX2Drive, 'SRC X2 must drive R0 (high nibble) = 5').toBe(5);
      expect(srcX3Drive, 'SRC X3 must drive R1 (low nibble) = 7').toBe(7);
      board.dispose();
    });
  });

  describe('integration', () => {
    it.skipIf(skip || !chipWasmExists('4002-ram'))(
      'runs a Busicom-style increment-and-blink program', async () => {
        // The Busicom 141-PF firmware is not in this repo; this test
        // exercises the same kind of inner loop the firmware ran:
        // SRC + WMP + IAC + JUN, with the 4002's output port playing
        // the role of the printer/display latch.
        //
        // Program (under 16 bytes so it fits the 4001 ROM page):
        //   0x00: F0       CLB           ; ACC = 0
        //   0x01: 21       SRC P0        ; ← loop label
        //   0x02: E1       WMP           ; latch ACC into the 4002 output
        //   0x03: F2       IAC           ; ACC++
        //   0x04: 40 01    JUN 0x001     ; jump back to SRC
        //
        // Each iteration of the loop is 4 instructions = 5 machine cycles
        // (JUN is 2-byte). Run until ACC has been incremented several
        // times and assert the 4002 output port reflects the latest
        // value.
        const PROG = new Uint8Array(0x40);
        PROG[0x00] = 0xF0;          // CLB
        PROG[0x01] = 0x21;          // SRC P0
        PROG[0x02] = 0xE1;          // WMP
        PROG[0x03] = 0xF2;          // IAC
        PROG[0x04] = 0x40;          // JUN 0x001 (high nibble = 0)
        PROG[0x05] = 0x01;          //   operand = low byte of target

        const board = new BoardHarness();
        // 4002 first so its on_phase fires before the 4004's per
        // advanceNanos — the one-frame-behind protocol.
        await board.addChip('4002-ram', {
          SYNC: 'SYNC', CL: 'CLK1', RESET: 'RESET', CM: 'CMRAM0',
          VDD: 'VDD', VSS: 'VSS',
          D0: 'D0', D1: 'D1', D2: 'D2', D3: 'D3',
          O0: 'O0', O1: 'O1', O2: 'O2', O3: 'O3',
        });
        await bootChip(board);

        let phaseSinceSync = -1;
        let observedPc = 0;
        let pcLow = 0, pcMid = 0;
        board.watchNet('SYNC', (high) => { if (high) phaseSinceSync = 0; });

        function driveDNibble(n) {
          for (let i = 0; i < 4; i++) {
            board.setNet(`D${i}`, ((n >> i) & 1) === 1);
          }
        }

        // Capture the 4002 output port after each WMP cycle so we can
        // verify the BLINK SEQUENCE — not just the final value.
        const outputs = [];
        let prevOut = -1;       // -1 so the very first sample (= 0) registers

        // Run lots of cycles — enough for ACC to roll past 9 a few times.
        const PHASES = 8 * 80;        // 80 instruction cycles
        for (let p = 0; p < PHASES; p++) {
          if (phaseSinceSync === 3) {
            driveDNibble((PROG[observedPc & 0x3F] >> 4) & 0xF);
          } else if (phaseSinceSync === 4) {
            driveDNibble(PROG[observedPc & 0x3F] & 0xF);
          }
          board.advanceNanos(CLOCK_NS);
          if (phaseSinceSync === 0)      pcLow = board.readBus('D', 4);
          else if (phaseSinceSync === 1) pcMid = board.readBus('D', 4);
          else if (phaseSinceSync === 2) {
            const pcHigh = board.readBus('D', 4);
            observedPc = pcLow | (pcMid << 4) | (pcHigh << 8);
          }
          if (phaseSinceSync >= 0) phaseSinceSync++;

          // Sample output at end of each cycle (phase 7).
          if (phaseSinceSync === 8) {
            let out = 0;
            for (let i = 0; i < 4; i++) if (board.getNet(`O${i}`)) out |= (1 << i);
            if (out !== prevOut) {
              outputs.push(out);
              prevOut = out;
            }
          }
        }

        // Each loop iteration produces a fresh WMP. The output should
        // walk 0, 1, 2, 3, ... 0xF, 0, 1, ... — i.e. an incrementing
        // sequence (modulo 16). Verify the first several distinct
        // outputs follow that pattern.
        expect(outputs.length, 'must blink at least 6 distinct values').toBeGreaterThanOrEqual(6);
        for (let i = 0; i < Math.min(6, outputs.length); i++) {
          expect(outputs[i], `tick ${i} of the increment-and-blink loop`).toBe(i);
        }
        board.dispose();
      });
  });
});

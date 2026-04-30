/**
 * Intel 4002 RAM — unit + integration tests.
 *
 * The basic spec checks the pin contract and reset behaviour.
 *
 * The integration test wires a real 4002 alongside a real 4004 and
 * uses a JS-side nibble-bus driver to feed a tiny program (LDM 3 +
 * SRC P0 + WMP) that exercises the 4004's SRC + I/O bus protocol
 * end-to-end. Success is the 4002's output-port pins reflecting the
 * accumulator value driven during WMP.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BoardHarness } from '../src/BoardHarness.js';
import { chipWasmExists } from '../src/helpers.js';

const RAM = '4002-ram';
const CPU = '4004';
const skip = !chipWasmExists(RAM);
const skipIntegration = !chipWasmExists(RAM) || !chipWasmExists(CPU);

const CLOCK_NS = 1351;

function ramPinMap() {
  const m = {
    SYNC: 'SYNC', CL: 'CLK1', RESET: 'RESET', CM: 'CMRAM0',
    VDD: 'VDD', VSS: 'VSS',
  };
  for (let i = 0; i < 4; i++) m[`D${i}`] = `D${i}`;
  for (let i = 0; i < 4; i++) m[`O${i}`] = `O${i}`;
  return m;
}

function cpuPinMap() {
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

describe(`${RAM} chip`, () => {
  let board;
  beforeEach(() => { board = new BoardHarness(); });
  afterEach(() => { board.dispose(); });

  it.skipIf(skip)('registers all 14 logical pins', async () => {
    await expect(board.addChip(RAM, ramPinMap())).resolves.toBeDefined();
  });

  it.skipIf(skip)('after RESET output port reads zero', async () => {
    await board.addChip(RAM, ramPinMap());
    board.setNet('RESET', true);
    board.advanceNanos(50);
    board.setNet('RESET', false);
    board.advanceNanos(50);
    let out = 0;
    for (let i = 0; i < 4; i++) if (board.getNet(`O${i}`)) out |= (1 << i);
    expect(out).toBe(0);
  });
});

describe('4002 RAM + 4004 integration (SRC + WMP end-to-end)', () => {
  let board;
  beforeEach(() => { board = new BoardHarness(); });
  afterEach(() => { board.dispose(); });

  it.skipIf(skipIntegration)(
    'WMP drives 4002 output port from the 4004 ACC after SRC selects this chip',
    async () => {
      // Tiny program — fed by the JS nibble-bus driver below since we
      // don't want to bake a custom 4001 ROM image just for one test.
      //
      //   PC=0x00: 0xD3  LDM 3   →  ACC = 3
      //   PC=0x01: 0x21  SRC P0  →  drive (R0:R1) on D bus during X2/X3.
      //                              R0=0, R1=0 ⇒ chip-select-pair=0,
      //                              reg=0, char=0. 4002's hard-coded
      //                              CHIP_PAIR is 0 ⇒ this 4002 latches
      //                              `selected=true`.
      //   PC=0x02: 0xE1  WMP     →  drive ACC on D during X2; the 4002
      //                              latches at phase_count=7 (X3 frame)
      //                              and updates O0..O3 = 0011 (= 3).
      //   PC=0x03..: 0x00 NOP
      const PROG = new Uint8Array(0x40);
      PROG[0] = 0xD3;
      PROG[1] = 0x21;
      PROG[2] = 0xE1;
      // rest are NOPs (0x00)

      // Register the 4002 BEFORE the 4004 so its on_phase fires first
      // per advanceNanos. That ordering is what makes the
      // "one-frame-behind" sampling model in 4002-ram.c work.
      await board.addChip(RAM, ramPinMap());
      await board.addChip(CPU, cpuPinMap());

      // Quiet inputs.
      board.setNet('TEST', false);
      board.setNet('RESET', true);
      board.advanceNanos(CLOCK_NS * 12);
      board.setNet('RESET', false);

      // JS-side nibble-bus driver — same idea as test_4004's Bus4004,
      // but here we ALSO have a real 4002 on the bus. The 4002 drives
      // D only during read ops (RDM/SBM/ADM/RD0..RD3); for our SRC+WMP
      // program it never drives, so there's no contention with our
      // pre-drives at M1/M2 (and no contention with the 4004's drives
      // at A1/A2/A3/X2/X3 either).
      let phaseSinceSync = -1;
      let observedPc = 0;
      let pcLow = 0, pcMid = 0;

      board.watchNet('SYNC', (high) => { if (high) phaseSinceSync = 0; });

      function driveDNibble(n) {
        for (let i = 0; i < 4; i++) {
          board.setNet(`D${i}`, ((n >> i) & 1) === 1);
        }
      }

      // Run enough cycles to cover LDM, SRC, WMP, and a few extra so
      // the WMP bus action fully completes (the 4002 latches output
      // at the WMP cycle's phase_count=7 — i.e. inside the WMP cycle).
      const CYCLES = 8;
      for (let cyc = 0; cyc < CYCLES; cyc++) {
        for (let p = 0; p < 8; p++) {
          // Pre-drive D for the phase we're ABOUT to clock into.
          // phaseSinceSync == 3 ⇒ next tick is M1 ⇒ drive opcode_hi.
          // phaseSinceSync == 4 ⇒ next tick is M2 ⇒ drive opcode_lo.
          if (phaseSinceSync === 3) {
            driveDNibble((PROG[observedPc & 0x3F] >> 4) & 0xF);
          } else if (phaseSinceSync === 4) {
            driveDNibble(PROG[observedPc & 0x3F] & 0xF);
          }

          board.advanceNanos(CLOCK_NS);

          // Sample address nibbles after the chip's drive completes.
          if (phaseSinceSync === 0)      pcLow = board.readBus('D', 4);
          else if (phaseSinceSync === 1) pcMid = board.readBus('D', 4);
          else if (phaseSinceSync === 2) {
            const pcHigh = board.readBus('D', 4);
            observedPc = pcLow | (pcMid << 4) | (pcHigh << 8);
          }

          if (phaseSinceSync >= 0) phaseSinceSync++;
        }
      }

      let out = 0;
      for (let i = 0; i < 4; i++) if (board.getNet(`O${i}`)) out |= (1 << i);
      expect(out, '4002 output port after WMP must equal ACC (= 3)').toBe(3);
    }
  );

  it.skipIf(skipIntegration)(
    'WRM stores into RAM and RDM reads it back through the bus',
    async () => {
      //   PC=0x00: 0xD5  LDM 5    →  ACC = 5
      //   PC=0x01: 0x21  SRC P0   →  select chip-pair 0, reg 0, char 0
      //   PC=0x02: 0xE0  WRM      →  mem[0][0] = ACC = 5
      //   PC=0x03: 0xF0  CLB      →  ACC = 0, CY = 0
      //   PC=0x04: 0xE9  RDM      →  ACC ← mem[0][0]; the 4002 drives
      //                              D at X2 (phase_count=6) and the
      //                              4004 samples it at PHASE_X2.
      //   PC=0x05: 0xE1  WMP      →  output_port = ACC = 5  (proves the
      //                              read returned the right value)
      const PROG = new Uint8Array(0x40);
      PROG[0] = 0xD5;
      PROG[1] = 0x21;
      PROG[2] = 0xE0;
      PROG[3] = 0xF0;
      PROG[4] = 0xE9;
      PROG[5] = 0xE1;

      await board.addChip(RAM, ramPinMap());
      await board.addChip(CPU, cpuPinMap());

      board.setNet('TEST', false);
      board.setNet('RESET', true);
      board.advanceNanos(CLOCK_NS * 12);
      board.setNet('RESET', false);

      let phaseSinceSync = -1;
      let observedPc = 0;
      let pcLow = 0, pcMid = 0;

      board.watchNet('SYNC', (high) => { if (high) phaseSinceSync = 0; });

      function driveDNibble(n) {
        for (let i = 0; i < 4; i++) {
          board.setNet(`D${i}`, ((n >> i) & 1) === 1);
        }
      }

      const CYCLES = 12;
      for (let cyc = 0; cyc < CYCLES; cyc++) {
        for (let p = 0; p < 8; p++) {
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
        }
      }

      let out = 0;
      for (let i = 0; i < 4; i++) if (board.getNet(`O${i}`)) out |= (1 << i);
      expect(out, 'WMP after RDM must surface the mem-stored 5').toBe(5);
    }
  );
});

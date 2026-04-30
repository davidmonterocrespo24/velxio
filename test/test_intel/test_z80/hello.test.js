/**
 * Z80 minimal "Hello" via BDOS — verifies the BDOS+OUT capture path
 * works before we tackle the much heavier ZEXDOC ROM.
 */
import { describe, it, expect } from 'vitest';
import { BoardHarness } from '../src/BoardHarness.js';
import { chipWasmExists } from '../src/helpers.js';

const CHIP = 'z80';
const skip = !chipWasmExists(CHIP);
const CLOCK_NS = 250;

function fullPinMapZ80() {
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

describe('Z80 BDOS-style output capture', () => {
  it.skipIf(skip)('Z80 OUT (0x01) emits a byte detectable by the test harness', async () => {
    // Minimal Z80 program: LD A, 0x48 ('H') ; OUT (0x01), A ; HLT.
    // Expected: harness sees byte 0x48 written to port 0x01.
    const program = new Uint8Array(0x10000);
    program[0x0000] = 0x3E; program[0x0001] = 0x48;   // LD A, 0x48
    program[0x0002] = 0xD3; program[0x0003] = 0x01;   // OUT (0x01), A
    program[0x0004] = 0x76;                            // HALT

    const board = new BoardHarness();
    await board.addChip(CHIP, fullPinMapZ80());
    const ram = board.installFakeRam(0x10000, {
      addrPrefix: 'A', addrWidth: 16, dataPrefix: 'D', dataWidth: 8,
      rd: 'RD', rdActiveLow: true, wr: 'WR', cs: 'MREQ', baseAddr: 0,
    });
    for (let i = 0; i < program.length; i++) ram.poke(i, program[i]);

    const out = [];
    board.watchNet('WR', (state) => {
      if (state !== false) return;
      if (board.getNet('IORQ') !== false) return;
      const port = board.readBus('A', 8);
      if (port === 0x01) out.push(board.readBus('D', 8));
    });

    board.setNet('WAIT', true);
    board.setNet('INT', true);
    board.setNet('NMI', true);
    board.setNet('BUSREQ', true);
    board.setNet('RESET', false);
    board.advanceNanos(CLOCK_NS * 4);
    board.setNet('RESET', true);
    for (let i = 0; i < 200; i++) board.advanceNanos(CLOCK_NS);

    expect(out).toEqual([0x48]);
    board.dispose();
  });
});

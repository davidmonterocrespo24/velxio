/**
 * 8080 software-validation integration tests.
 *
 * Runs public-domain CP/M-style test ROMs through the full bus
 * stack (8080 chip + fake bus + minimal CP/M BDOS hooks):
 *
 *   - 8080PRE.COM — 1 KB preliminary instruction test, just verifies
 *     basic ops produce expected results. Halts/returns on success.
 *   - TST8080.COM — Microcosm Associates "8080/8085 CPU Diagnostic
 *     Version 1.0" (1980). Prints "CPU IS OPERATIONAL" on success.
 *
 * Both ROMs are CP/M .COM files:
 *   - Load at 0x0100 (CP/M TPA)
 *   - Use BDOS calls at 0x0005 (function 9 = print string,
 *     function 2 = print char)
 *   - End with JMP 0x0000 (warm boot — we trap with HLT)
 *
 * BDOS implementation in 8080 ASM (placed at 0x0F00):
 *   - MOV A,C ; CPI 9 ; JZ print_string ; CPI 2 ; JZ print_char ; RET
 *   - print_string: LDAX D; CPI '$'; RZ; OUT 1; INX D; JMP print_string
 *   - print_char:   MOV A,E; OUT 1; RET
 *
 * Output port: BDOS uses OUT 0x01 to emit each character. The test
 * harness's captureWrites() snoops the 8080's WR̅ rising edge and
 * records each write — we filter for the OUT cycle (8080 mirrors
 * the port byte on both halves of A0..A15 so addr & 0xFF == port).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { BoardHarness } from '../src/BoardHarness.js';
import { chipWasmExists } from '../src/helpers.js';

const CHIP = '8080';
const skip = !chipWasmExists(CHIP);

const here = dirname(fileURLToPath(import.meta.url));
const romPath = (name) => resolve(here, '..', 'roms', name);

const CLOCK_HZ = 2_000_000;
const CLOCK_NS = Math.round(1e9 / CLOCK_HZ);

/* Boot stub at 0x0000 (CP/M zero-page entry) and BDOS at 0x0F00. */
function buildSystemImage(programBytes) {
  // 64 KB image
  const mem = new Uint8Array(0x10000);

  // 0x0000: JMP 0x0100 (start of TPA)
  mem[0x0000] = 0xC3; mem[0x0001] = 0x00; mem[0x0002] = 0x01;
  // 0x0005: JMP 0x0F00 (BDOS entry)
  mem[0x0005] = 0xC3; mem[0x0006] = 0x00; mem[0x0007] = 0x0F;

  // BDOS handler at 0x0F00
  const bdos = [
    0x79,                   // MOV A, C
    0xFE, 0x09,             // CPI 9
    0xCA, 0x20, 0x0F,       // JZ 0x0F20 (print string)
    0xFE, 0x02,             // CPI 2
    0xCA, 0x40, 0x0F,       // JZ 0x0F40 (print char)
    0xC9,                   // RET
  ];
  for (let i = 0; i < bdos.length; i++) mem[0x0F00 + i] = bdos[i];

  // Print-string at 0x0F20: LDAX D; CPI '$'; RZ; OUT 1; INX D; JMP 0x0F20
  const ps = [
    0x1A,                   // LDAX D
    0xFE, 0x24,             // CPI '$'
    0xC8,                   // RZ
    0xD3, 0x01,             // OUT 1
    0x13,                   // INX D
    0xC3, 0x20, 0x0F,       // JMP 0x0F20
  ];
  for (let i = 0; i < ps.length; i++) mem[0x0F20 + i] = ps[i];

  // Print-char at 0x0F40: MOV A, E; OUT 1; RET
  const pc = [
    0x7B,                   // MOV A, E
    0xD3, 0x01,             // OUT 1
    0xC9,                   // RET
  ];
  for (let i = 0; i < pc.length; i++) mem[0x0F40 + i] = pc[i];

  // Program bytes at 0x0100
  for (let i = 0; i < programBytes.length; i++) {
    mem[0x0100 + i] = programBytes[i];
  }

  // The CP/M warm-boot vector at 0x0000 normally jumps back to BIOS.
  // For our test we want the chip to halt when the program "returns"
  // by jumping to 0x0000. We achieve this by patching the *first* byte
  // of the program area at 0x0100 IF the program does an early test
  // that depends on 0x0000 being a JMP — most don't. Otherwise we
  // catch the warm-boot via timeout.
  return mem;
}

async function run8080Diag(romFilename, opts = {}) {
  const program = readFileSync(romPath(romFilename));
  const board = new BoardHarness();
  await board.addChip(CHIP, fullPinMap8080());

  const sysmem = buildSystemImage(program);

  // We use the built-in fake_rom + fake_ram from BoardHarness. The
  // 8080 sees the entire 64 KB as both readable and writable — split
  // 0x0000..0xFFFF into a "fake ROM" returning sysmem[addr] for reads
  // and a "fake RAM" backing for writes. Actually simpler: install a
  // fake_ram covering the full address space, pre-loaded with sysmem.
  const ram = board.installFakeRam(0x10000, {
    addrPrefix: 'A', addrWidth: 16,
    dataPrefix: 'D', dataWidth: 8,
    rd: 'DBIN', rdActiveLow: false,
    wr: 'WR',
    baseAddr: 0,
  });
  for (let i = 0; i < 0x10000; i++) ram.poke(i, sysmem[i]);

  // Capture OUT cycles (port 0x01 = our BDOS output port).
  const output = [];
  board.watchNet('WR', (state) => {
    if (state !== false) return;   // we want WR̅ falling = OUT cycle start
    // Actually OUT happens via bus_write with status ST_OUT. The chip
    // drives data on D before WR̅ pulse, so on WR̅ falling D pins
    // already have the byte. But mreq+rd state distinguishes mem-write
    // from OUT — we use the address pattern: port byte is mirrored on
    // A0..A7 and A8..A15.
    const addr = board.readBus('A', 16);
    if ((addr & 0xff) === 0x01 && (addr >> 8) === 0x01) {
      output.push(board.readBus('D', 8));
    }
  });

  // Boot
  board.setNet('READY', true);
  board.setNet('HOLD',  false);
  board.setNet('INT',   false);
  board.setNet('RESET', true);
  board.advanceNanos(CLOCK_NS * 4);
  board.setNet('RESET', false);

  // Run for many cycles. CPUDIAG completes in tens of thousands of
  // instructions (~1-2 seconds wall-clock here).
  const cycles = opts.cycles ?? 5_000_000;
  for (let i = 0; i < cycles; i++) board.advanceNanos(CLOCK_NS);

  // Build text in chunks — output can be tens of thousands of chars
  // and `String.fromCharCode(...output)` blows the call stack.
  let text = '';
  for (let i = 0; i < output.length; i += 4096) {
    text += String.fromCharCode(...output.slice(i, i + 4096));
  }
  board.dispose();
  return { output, text };
}

function fullPinMap8080() {
  const m = {
    SYNC: 'SYNC', DBIN: 'DBIN', WR: 'WR', INTE: 'INTE',
    WAIT: 'WAIT', HLDA: 'HLDA',
    READY: 'READY', HOLD: 'HOLD', INT: 'INT', RESET: 'RESET',
    PHI1: 'PHI1', PHI2: 'PHI2',
    VCC: 'VCC', GND: 'GND',
  };
  for (let i = 0; i < 16; i++) m[`A${i}`] = `A${i}`;
  for (let i = 0; i < 8;  i++) m[`D${i}`] = `D${i}`;
  return m;
}

describe('8080 software validation', () => {
  it.skipIf(skip)('runs 8080PRE.COM (preliminary instruction test)', async () => {
    const { text } = await run8080Diag('8080pre.bin', { cycles: 500_000 });
    // 8080PRE doesn't print much; success is "8080PR" + a number,
    // failure prints "8080..." then specific error text.
    // We just verify *some* output appeared and no error sentinel.
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/ERROR/i);
  }, 60_000);

  it.skipIf(skip)('runs TST8080.COM (Microcosm 1980 CPUDIAG)', async () => {
    const { text } = await run8080Diag('tst8080.bin', { cycles: 2_000_000 });
    // The canonical success message printed by TST8080 on completion.
    expect(text).toMatch(/CPU IS OPERATIONAL/);
  }, 120_000);
});

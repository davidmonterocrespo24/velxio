/**
 * 8086 + 8259 PIC integration test.
 *
 * Wires both chips on one board, configures the PIC, fires an
 * IRQ, and verifies the 8086 takes the interrupt and runs an ISR
 * that writes a sentinel byte to memory.
 *
 * This is the first end-to-end test of hardware-interrupt routing
 * from an external chip (the PIC) into the CPU's interrupt
 * pipeline — proving the INTA bus cycle works between two real
 * WASM chips.
 */
import { describe, it, expect } from 'vitest';
import { BoardHarness } from '../src/BoardHarness.js';
import { chipWasmExists } from '../src/helpers.js';

const CPU = '8086';
const PIC = '8259-pic';
const skip = !chipWasmExists(CPU) || !chipWasmExists(PIC);

const CLOCK_NS = 200;

function cpuPinMap() {
  const m = {
    ALE: 'ALE', RD: 'RD', WR: 'WR', MIO: 'MIO', DTR: 'DTR', DEN: 'DEN',
    HOLD: 'HOLD', HLDA: 'HLDA',
    INTR: 'INTR', NMI: 'NMI', INTA: 'INTA',
    RESET: 'RESET', READY: 'READY', TEST: 'TEST', CLK: 'CLK',
    MNMX: 'MNMX', BHE: 'BHE',
    VCC: 'VCC', GND: 'GND',
  };
  for (let i = 0; i < 16; i++) m[`AD${i}`] = `AD${i}`;
  for (let i = 16; i < 20; i++) m[`A${i}`] = `A${i}`;
  return m;
}

function picPinMap() {
  // PIC's D bus is the low byte of the 8086's AD bus. PIC's INT pin
  // wires to CPU's INTR; PIC's INTA pin wires to CPU's INTA̅. PIC has
  // its own A0/CS̅/RD̅/WR̅ — we'd normally wire CS̅ to a chip-select
  // decode line, but for this test we just leave it tied to the test
  // fixture (we toggle it manually).
  const m = {
    A0: 'PIC_A0', CS: 'PIC_CS', RD: 'PIC_RD', WR: 'PIC_WR',
    INT: 'INTR',     // ← shared net with CPU's INTR
    INTA: 'INTA',    // ← shared net with CPU's INTA̅
    CAS0: 'PIC_CAS0', CAS1: 'PIC_CAS1', CAS2: 'PIC_CAS2', SPEN: 'PIC_SPEN',
    VCC: 'VCC', GND: 'GND',
  };
  // PIC's D0..D7 share with CPU's AD0..AD7
  for (let i = 0; i < 8; i++) m[`D${i}`] = `AD${i}`;
  for (let i = 0; i < 8; i++) m[`IRQ${i}`] = `IRQ${i}`;
  return m;
}

describe('8086 + 8259 PIC integration', () => {
  it.skipIf(skip)('IRQ0 fires the ISR which writes a sentinel byte', async () => {
    const board = new BoardHarness();

    // PIC must be added BEFORE the CPU so its INTA-falling watcher
    // fires first per advanceNanos and drives D bus with the vector
    // before the CPU samples AD.
    await board.addChip(PIC, picPinMap());
    await board.addChip(CPU, cpuPinMap());

    // RAM covering the full 1 MB. ISR vector at 0x40 → table entry
    // at physical (0x40 << 2) = 0x100..0x103: { offset_lo, offset_hi,
    // segment_lo, segment_hi }. We make the ISR live at CS=0xF000,
    // IP=0x0200, so vector entry is { 0x00, 0x02, 0x00, 0xF0 }.
    const ram = board.installFake8086Bus({});

    // ISR at physical 0xF0200: write 0xAA to [0x9000], then IRET.
    const isr = [
      0xC6, 0x06, 0x00, 0x90, 0xAA,    // MOV byte [0x9000], 0xAA
      0xCF,                              // IRET
    ];
    for (let i = 0; i < isr.length; i++) ram.poke(0xF0200 + i, isr[i]);

    // IVT entry for vector 0x40
    ram.poke(0x100, 0x00);
    ram.poke(0x101, 0x02);
    ram.poke(0x102, 0x00);
    ram.poke(0x103, 0xF0);

    // Boot stub: JMP FAR 0xF000:0x0100 at the reset vector.
    ram.poke(0xFFFF0, 0xEA);
    ram.poke(0xFFFF1, 0x00);
    ram.poke(0xFFFF2, 0x01);
    ram.poke(0xFFFF3, 0x00);
    ram.poke(0xFFFF4, 0xF0);

    // Main program at 0xF0100: STI ; HLT (we'll get interrupted out
    // of the HLT). Actually 8086 HLT continues on interrupt — perfect.
    const main = [
      0xFB,        // STI
      0xF4,        // HLT
    ];
    for (let i = 0; i < main.length; i++) ram.poke(0xF0100 + i, main[i]);

    // Quiet inputs.
    board.setNet('MNMX',  true);
    board.setNet('READY', true);
    board.setNet('TEST',  true);
    board.setNet('NMI',   false);
    board.setNet('HOLD',  false);
    board.setNet('PIC_CS', true);
    board.setNet('PIC_RD', true);
    board.setNet('PIC_WR', true);
    for (let i = 0; i < 8; i++) board.setNet(`IRQ${i}`, false);

    // Reset CPU
    board.setNet('RESET', true);
    board.advanceNanos(CLOCK_NS * 8);
    board.setNet('RESET', false);

    // Helper to write to PIC. We need to NOT collide with the CPU's
    // bus, but during this test the CPU is still mid-reset / running
    // the boot JMP. We'll wait until the CPU is in HLT state (after
    // ~2000 cycles) before driving the PIC, to avoid contention.
    function picWrite(a0, value) {
      board.setNet('PIC_A0', a0 !== 0);
      // We use the AD bus for PIC data writes too (since PIC's D maps
      // to AD0..AD7). The CPU is halted so AD is idle.
      for (let i = 0; i < 8; i++) {
        board.setNet(`AD${i}`, ((value >> i) & 1) === 1);
      }
      board.advanceNanos(20);
      board.setNet('PIC_CS', false);
      board.setNet('PIC_WR', false);
      board.advanceNanos(20);
      board.setNet('PIC_WR', true);
      board.advanceNanos(20);
      board.setNet('PIC_CS', true);
    }

    // Run a few cycles to get past the JMP-FAR + STI + HLT.
    for (let i = 0; i < 2000; i++) board.advanceNanos(CLOCK_NS);

    // Configure PIC: ICW1 (single, ICW4-needed) + ICW2 (vector base 0x40)
    // + ICW4 (8086 mode) + OCW1 (mask = 0).
    picWrite(0, 0x13);
    picWrite(1, 0x40);
    picWrite(1, 0x01);
    picWrite(1, 0x00);

    // Fire IRQ0 — should produce INT, INTA cycle drives 0x40 on bus,
    // CPU executes do_int(0x40), runs the ISR, RETs back.
    board.setNet('IRQ0', true);
    for (let i = 0; i < 5000; i++) board.advanceNanos(CLOCK_NS);

    expect(ram.peek(0x9000)).toBe(0xAA);
    board.dispose();
  }, 30_000);
});

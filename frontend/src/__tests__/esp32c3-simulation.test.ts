/**
 * ESP32-C3 Browser Emulation Tests
 *
 * Tests the RV32IMC (Integer + Multiply + Compressed) emulator used
 * for browser-side ESP32-C3 simulation without a QEMU backend.
 *
 * Test groups:
 *  1. RV32M — multiply/divide instructions (via RiscVCore directly)
 *  2. RV32C — 16-bit compressed instructions (via RiscVCore directly)
 *  3. Esp32C3Simulator — UART0 serial output
 *  4. Esp32C3Simulator — GPIO pin toggling
 *  5. Lifecycle — start/stop/reset
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RiscVCore } from '../simulation/RiscVCore';
import { Esp32C3Simulator } from '../simulation/Esp32C3Simulator';
import type { PinManager } from '../simulation/PinManager';

// ── Node environment stubs ───────────────────────────────────────────────────

let rafDepth = 0;
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  // Allow a bounded number of recursive RAF calls to test the loop
  if (rafDepth < 2) {
    rafDepth++;
    cb(0);
    rafDepth--;
  }
  return 1;
});
vi.stubGlobal('cancelAnimationFrame', () => {});

// ── Helpers ──────────────────────────────────────────────────────────────────

function writeWord(mem: Uint8Array, offset: number, val: number): void {
  mem[offset] = val & 0xff;
  mem[offset + 1] = (val >> 8) & 0xff;
  mem[offset + 2] = (val >> 16) & 0xff;
  mem[offset + 3] = (val >> 24) & 0xff;
}

function writeHalf(mem: Uint8Array, offset: number, val: number): void {
  mem[offset] = val & 0xff;
  mem[offset + 1] = (val >> 8) & 0xff;
}

/** Run exactly n steps on a core */
function runSteps(core: RiscVCore, n: number): void {
  for (let i = 0; i < n; i++) core.step();
}

/** Create a minimal mock PinManager */
function mockPinManager(): PinManager {
  return {
    setPinState: vi.fn(),
    getPinState: vi.fn(() => false),
    registerPin: vi.fn(),
    unregisterPin: vi.fn(),
  } as unknown as PinManager;
}

/** Access the simulator's internal RiscVCore for direct testing */
function getCore(sim: Esp32C3Simulator): RiscVCore {
  return (sim as unknown as { core: RiscVCore }).core;
}

/** Access the simulator's internal flash buffer for direct programming */
function getFlash(sim: Esp32C3Simulator): Uint8Array {
  return (sim as unknown as { flash: Uint8Array }).flash;
}

// ── Test Group 1: RV32M (multiply/divide) ────────────────────────────────────

describe('RV32M — multiply/divide extension', () => {
  let mem: Uint8Array;
  let core: RiscVCore;

  beforeEach(() => {
    mem = new Uint8Array(64);
    core = new RiscVCore(mem, 0);
    core.reset(0);
  });

  it('MUL: 6 × 7 = 42', () => {
    writeWord(mem, 0, 0x00600093); // ADDI x1, x0, 6
    writeWord(mem, 4, 0x00700113); // ADDI x2, x0, 7
    writeWord(mem, 8, 0x022081b3); // MUL  x3, x1, x2
    runSteps(core, 3);
    expect(core.regs[3]).toBe(42);
  });

  it('MUL: negative × positive = negative', () => {
    writeWord(mem, 0, 0xfff00093); // ADDI x1, x0, -1
    writeWord(mem, 4, 0x00300113); // ADDI x2, x0, 3
    writeWord(mem, 8, 0x022081b3); // MUL  x3, x1, x2
    runSteps(core, 3);
    expect(core.regs[3]).toBe(-3);
  });

  it('MULH: signed upper — (-1) × (-1) upper 32 bits = 0', () => {
    // (-1) * (-1) = 1; upper 32 bits of 64-bit result = 0
    writeWord(mem, 0, 0xfff00093); // ADDI x1, x0, -1
    writeWord(mem, 4, 0xfff00113); // ADDI x2, x0, -1
    writeWord(mem, 8, 0x022091b3); // MULH x3, x1, x2
    runSteps(core, 3);
    expect(core.regs[3]).toBe(0);
  });

  it('MULHU: unsigned upper — 0xFFFFFFFF × 0xFFFFFFFF upper 32 bits', () => {
    // 0xFFFFFFFF * 0xFFFFFFFF = 0xFFFFFFFE_00000001; upper = 0xFFFFFFFE
    writeWord(mem, 0, 0xfff00093); // ADDI x1, x0, -1  (= 0xFFFFFFFF unsigned)
    writeWord(mem, 4, 0xfff00113); // ADDI x2, x0, -1
    writeWord(mem, 8, 0x022081b3 | (3 << 12)); // MULHU x3, x1, x2  (funct3=3)
    runSteps(core, 3);
    expect(core.regs[3] >>> 0).toBe(0xfffffffe);
  });

  it('DIV: 42 / 7 = 6', () => {
    writeWord(mem, 0, 0x02a00093); // ADDI x1, x0, 42
    writeWord(mem, 4, 0x00700113); // ADDI x2, x0, 7
    // DIV x3, x1, x2: opcode=0x33, rd=3, funct3=4, rs1=1, rs2=2, funct7=1
    // = (1<<25)|(2<<20)|(1<<15)|(4<<12)|(3<<7)|0x33 = 0x0220C1B3
    writeWord(mem, 8, 0x0220c1b3); // DIV  x3, x1, x2
    runSteps(core, 3);
    expect(core.regs[3]).toBe(6);
  });

  it('DIV: signed — -7 / 2 = -3 (truncate toward zero)', () => {
    writeWord(mem, 0, 0xff900093); // ADDI x1, x0, -7
    writeWord(mem, 4, 0x00200113); // ADDI x2, x0, 2
    writeWord(mem, 8, 0x0220c1b3); // DIV  x3, x1, x2
    runSteps(core, 3);
    expect(core.regs[3]).toBe(-3);
  });

  it('DIV: divide by zero returns -1 (0xFFFFFFFF)', () => {
    writeWord(mem, 0, 0x00500093); // ADDI x1, x0, 5
    writeWord(mem, 4, 0x00000113); // ADDI x2, x0, 0
    writeWord(mem, 8, 0x0220c1b3); // DIV  x3, x1, x2
    runSteps(core, 3);
    expect(core.regs[3]).toBe(-1);
  });

  it('REM: 10 % 3 = 1', () => {
    writeWord(mem, 0, 0x00a00093); // ADDI x1, x0, 10
    writeWord(mem, 4, 0x00300113); // ADDI x2, x0, 3
    // REM x3, x1, x2: funct3=6 → (1<<25)|(2<<20)|(1<<15)|(6<<12)|(3<<7)|0x33 = 0x0220E1B3
    writeWord(mem, 8, 0x0220e1b3); // REM  x3, x1, x2
    runSteps(core, 3);
    expect(core.regs[3]).toBe(1);
  });

  it('REM: divide by zero returns dividend', () => {
    writeWord(mem, 0, 0x00700093); // ADDI x1, x0, 7
    writeWord(mem, 4, 0x00000113); // ADDI x2, x0, 0
    writeWord(mem, 8, 0x0220e1b3); // REM  x3, x1, x2
    runSteps(core, 3);
    expect(core.regs[3]).toBe(7);
  });
});

// ── Test Group 2: RV32C (compressed instructions) ───────────────────────────

describe('RV32C — 16-bit compressed instruction extension', () => {
  let mem: Uint8Array;
  let core: RiscVCore;

  beforeEach(() => {
    mem = new Uint8Array(64);
    core = new RiscVCore(mem, 0);
    core.reset(0);
  });

  it('C.LI x1, 5: loads immediate 5 into x1 and advances PC by 2', () => {
    // C.LI: funct3=010, imm[5]=0, rd=x1(00001), imm[4:0]=00101, op=01
    // Encoding: bit15..0 = 0_100_0_00001_00101_01 = 0x4095
    writeHalf(mem, 0, 0x4095);
    core.step();
    expect(core.regs[1]).toBe(5);
    expect(core.pc).toBe(2);
  });

  it('C.LI x2, -1: sign-extends negative immediate', () => {
    // C.LI: funct3=010, imm[5]=1, rd=x2(00010), imm[4:0]=11111, op=01
    // Encoding: bit15..0 = 0_100_1_00010_11111_01 = 0x5105
    // Checking: bit12=1, bits[11:7]=00010=2, bits[6:2]=11111=31, bits[1:0]=01
    // Value: 0_1_0_0 | 1_0_0_0 | 1_0_1_1 | 1_1_1_0_1 ... let me compute:
    // op=01: bit1=0,bit0=1; imm[4:0]=11111: bit6=1,bit5=1,bit4=1,bit3=1,bit2=1
    // rd=00010: bit11=0,bit10=0,bit9=0,bit8=1,bit7=0
    // imm[5]=1: bit12=1; funct3=010: bit15=0,bit14=1,bit13=0
    // = 0100 1000 1111 1101 wait...
    // bit15=0,14=1,13=0,12=1,11=0,10=0,9=0,8=1,7=0,6=1,5=1,4=1,3=1,2=1,1=0,0=1
    // = 0101 0001 0111 1101 = 0x517D? Let me just compute the halfword value:
    // Bits (from bit15 to bit0):
    // 0,1,0,1 | 0,0,0,1 | 0,1,1,1 | 1,1,0,1
    // wait: funct3=010 → bits[15:13]=010: bit15=0,bit14=1,bit13=0
    // bit12=1 (imm[5]=1)
    // rd=2=00010: bit11=0,bit10=0,bit9=0,bit8=1,bit7=0
    // imm[4:0]=11111: bit6=1,bit5=1,bit4=1,bit3=1,bit2=1
    // op=01: bit1=0,bit0=1
    // = 0100_1000_1111_1101 = 0x48FD? Wait let me re-group:
    // bits 15..12: 0,1,0,1 = 0x5... no: bit15=0,bit14=1,bit13=0,bit12=1 → 0101 = 5? That's nibble 0101=5
    // bits 11..8:  0,0,0,1 → 0001 = 1
    // bits 7..4:   0,1,1,1 → 0111 = 7
    // bits 3..0:   1,1,0,1 → 1101 = D
    // So 0x517D. Let's verify the C.LI decode:
    // half=0x517D: op=0x1, funct3=(0x517D>>13)&7=(0x28)&7=... 0x517D=20861, 20861>>13=2, 2&7=2 ✓ (funct3=2=C.LI)
    // bit12=(0x517D>>12)&1=5&1=1 ✓
    // rd=(0x517D>>7)&31=(0xA2)&31... 0x517D>>7=163, 163&31=3? Hmm that gives rd=3 not rd=2...
    // 0x517D in binary: 0101 0001 0111 1101
    // bits[11:7]: bit11=0,bit10=0,bit9=0,bit8=1,bit7=0 = 00010 = 2 ✓
    // But (0x517D>>7) = 0101 0001 0 = 162, 162&31=162-160=2 ✓ (I miscalculated before)
    // bits[6:2]: bit6=1,bit5=1,bit4=1,bit3=1,bit2=1 = 11111 = 31 ✓
    // imm6 = sext((1<<5)|(31), 6) = sext(63, 6) = sext(0b111111, 6) = -1 ✓
    writeHalf(mem, 0, 0x517d);
    core.step();
    expect(core.regs[2]).toBe(-1);
    expect(core.pc).toBe(2);
  });

  it('C.ADDI x1, 3: adds immediate to register', () => {
    // Preset x1=10
    writeWord(mem, 0, 0x00a00093); // ADDI x1, x0, 10  (32-bit)
    // C.ADDI x1, 3: funct3=000, imm[5]=0, rd=x1, imm[4:0]=00011, op=01
    // bit12=0, bits[11:7]=00001, bits[6:2]=00011, bits[1:0]=01
    // = 0000 0000 1000 1101 = 0x008D
    writeHalf(mem, 4, 0x008d);
    runSteps(core, 2);
    expect(core.regs[1]).toBe(13);
    expect(core.pc).toBe(6);
  });

  it('C.MV x5, x1: copies register (ADD x5, x0, x1)', () => {
    // Preset x1=42
    writeWord(mem, 0, 0x02a00093); // ADDI x1, x0, 42
    // C.MV x5, x1: funct3=100, bit12=0, rd=x5(00101), rs2=x1(00001), op=10
    // bit15=1,14=0,13=0,12=0,bits[11:7]=00101=5,bits[6:2]=00001=1,bits[1:0]=10
    // = 1000 0010 1000 0110 = 0x8286
    writeHalf(mem, 4, 0x8286);
    runSteps(core, 2);
    expect(core.regs[5]).toBe(42);
  });

  it('C.ADD x1, x2: adds two registers', () => {
    writeWord(mem, 0, 0x00300093); // ADDI x1, x0, 3
    writeWord(mem, 4, 0x00400113); // ADDI x2, x0, 4
    // C.ADD x1, x2: funct3=100, bit12=1, rd=x1(00001), rs2=x2(00010), op=10
    // bit15=1,14=0,13=0,12=1,bits[11:7]=00001,bits[6:2]=00010,bits[1:0]=10
    // = 1001 0000 1000 1010 = 0x908A
    writeHalf(mem, 8, 0x908a);
    runSteps(core, 3);
    expect(core.regs[1]).toBe(7);
  });

  it('C.J +4: jumps forward 4 bytes from compressed instruction', () => {
    // C.J with offset=4, starting at PC=0
    // CJ format: funct3=101, imm[3:1]=010 → bits[5:3]=010 → bit4=1, bits[1:0]=01
    // = 1010_0000_0001_0001 = 0xA011
    writeHalf(mem, 0, 0xa011);
    core.step();
    expect(core.pc).toBe(4); // 0 + 4
  });

  it('C.BEQZ x8, offset: branch taken when register is zero', () => {
    // x8 is 0 (default), so branch should be taken
    // C.BEQZ x8, +4: rs1'=x8(=0 encoded as 0b000), offset=4
    // CB format: funct3=110, imm[8]=0, rs1'=000, imm[7:6]=00, imm[2:1]=10, imm[5]=0, op=01
    // offset=4: imm[2:1]=10 → bits[4:3]=10=2, other imm bits=0
    // bit15=0,14=1,13=1,12=0,bit11=0,bit10=0,bits[9:7]=000,bit6=0,bit5=0,bits[4:3]=10,bit2=0,bit1=0,bit0=1
    // = 0110 0000 0001 0001 ... let me compute more carefully
    // CB: bits[15:13]=110, bit[12]=imm[8]=0, bits[11:10]=imm[4:3]=00, bits[9:7]=rs1'=000
    //     bits[6:5]=imm[7:6]=00, bits[4:3]=imm[2:1]=10, bit[2]=imm[5]=0, bits[1:0]=01
    // For offset=4: imm[2:1]=10 → bits[4:3]=10 → bit4=1, bit3=0
    // = 1100_0000_0001_0001 = 0xC011
    writeHalf(mem, 0, 0xc011);
    core.step();
    expect(core.pc).toBe(4);
  });

  it('C.BEQZ x8, offset: branch NOT taken when register is non-zero', () => {
    core.regs[8] = 5;
    writeHalf(mem, 0, 0xc011); // C.BEQZ x8, +4
    core.step();
    expect(core.pc).toBe(2); // falls through
  });

  it('C.SWSP + C.LWSP: stack round-trip', () => {
    // Set sp (x2) to offset 32 within our buffer (so stack writes stay in bounds)
    core.regs[2] = 32;
    core.regs[1] = 0xdead;

    // C.SWSP rs2=x1, offset=0:
    // CSS: funct3=110, uimm[5:2]=bits[12:9]=0000, uimm[7:6]=bits[8:7]=00, rs2=bits[6:2]=00001, op=10
    // = 1101 0000 0000 0110 = 0xD006? let me compute:
    // bit15=1,14=1,13=0,12=0,bits[11:10]=uimm[5:4]=00,bits[9:7]=uimm[3:1]=000,bits[6:2]=rs2=00001,bits[1:0]=10
    // Wait the spec says: bits[12:9]=uimm[5:2], bits[8:7]=uimm[7:6]
    // For offset=0: all uimm bits=0 → bits[12:9]=0000, bits[8:7]=00
    // = 1101 0000 0000 0110 = 0xD006?
    // bit15=1,bit14=1,bit13=0,bit12=0 → 1100
    // bits[11:10]=00, bits[9:8]=00 → 0000
    // bits[7]=0 → 0
    // bits[6:2]=00001 → bit6=0,bit5=0,bit4=0,bit3=0,bit2=1
    // bits[1:0]=10
    // = 1100 0000 0000 0110 = 0xC006
    writeHalf(mem, 0, 0xc006); // C.SWSP x1, 0(sp)

    // C.LWSP rd=x3, offset=0:
    // CI: funct3=010, bit12=uimm[5]=0, rd=x3=00011, bits[6:4]=uimm[4:2]=000, bits[3:2]=uimm[7:6]=00, op=10
    // = 0100 0001 1000 0010 = 0x4182
    writeHalf(mem, 2, 0x4182); // C.LWSP x3, 0(sp)

    runSteps(core, 2);
    expect(core.regs[3]).toBe(0xdead);
  });
});

// ── Test Group 3: Esp32C3Simulator — UART ───────────────────────────────────

describe('Esp32C3Simulator — UART0 serial output', () => {
  let sim: Esp32C3Simulator;

  beforeEach(() => {
    sim = new Esp32C3Simulator(mockPinManager());
  });

  afterEach(() => {
    sim.stop();
  });

  it('writing to UART0 FIFO (0x60000000) triggers onSerialData', () => {
    const received: string[] = [];
    sim.onSerialData = (ch) => received.push(ch);

    const flash = getFlash(sim);
    const core = getCore(sim);

    // Program at IROM offset 0 (= address 0x42000000):
    // LUI a1, 0x60000   → a1 = 0x60000000  (UART0_BASE)
    // ADDI a0, x0, 72   → a0 = 72 = 'H'
    // SB a0, 0(a1)       → write byte to UART0 FIFO
    writeWord(flash, 0, 0x600005b7); // LUI a1, 0x60000
    writeWord(flash, 4, 0x04800513); // ADDI a0, x0, 72
    writeWord(flash, 8, 0x00a58023); // SB a0, 0(a1)

    core.reset(0x42000000);
    runSteps(core, 3);

    expect(received).toEqual(['H']);
  });

  it('writing multiple bytes emits each character', () => {
    const received: string[] = [];
    sim.onSerialData = (ch) => received.push(ch);

    const flash = getFlash(sim);
    const core = getCore(sim);

    // LUI a1, 0x60000        → a1 = UART0_BASE
    // ADDI a0, x0, 65 ('A')
    // SB a0, 0(a1)
    // ADDI a0, x0, 66 ('B')
    // SB a0, 0(a1)
    writeWord(flash, 0, 0x600005b7); // LUI a1, 0x60000
    writeWord(flash, 4, 0x04100513); // ADDI a0, x0, 65 ('A')
    writeWord(flash, 8, 0x00a58023); // SB a0, 0(a1)
    writeWord(flash, 12, 0x04200513); // ADDI a0, x0, 66 ('B')
    writeWord(flash, 16, 0x00a58023); // SB a0, 0(a1)

    core.reset(0x42000000);
    runSteps(core, 5);

    expect(received).toEqual(['A', 'B']);
  });

  it('serialWrite injects bytes into RX FIFO, firmware can read them', () => {
    const flash = getFlash(sim);
    const core = getCore(sim);

    sim.serialWrite('X');

    // Program: LB a0, 0(a1) — reads from UART0_FIFO
    // LUI a1, 0x60000        → a1 = 0x60000000
    // LBU a0, 0(a1)          → a0 = UART0_FIFO read
    writeWord(flash, 0, 0x600005b7); // LUI a1, 0x60000
    writeWord(flash, 4, 0x00058503); // LBU a0, 0(a1)

    core.reset(0x42000000);
    runSteps(core, 2);

    expect(core.regs[10]).toBe('X'.charCodeAt(0)); // a0 = 88 = 'X'
  });
});

// ── Test Group 4: Esp32C3Simulator — GPIO ────────────────────────────────────

describe('Esp32C3Simulator — GPIO pin toggling', () => {
  let sim: Esp32C3Simulator;

  beforeEach(() => {
    sim = new Esp32C3Simulator(mockPinManager());
  });

  afterEach(() => {
    sim.stop();
  });

  it('SW to GPIO_OUT_W1TS (offset +8) sets GPIO0 high', () => {
    const pinChanges: Array<{ pin: number; state: boolean }> = [];
    sim.onPinChangeWithTime = (pin, state) => pinChanges.push({ pin, state });

    const flash = getFlash(sim);
    const core = getCore(sim);

    // LUI t1, 0x60004        → t1 = 0x60004000 (GPIO_BASE)
    // ADDI t0, x0, 1         → t0 = 1 (bit 0 = GPIO0)
    // SW t0, 8(t1)            → write to GPIO_OUT_W1TS
    writeWord(flash, 0, 0x60004337); // LUI t1, 0x60004
    writeWord(flash, 4, 0x00100293); // ADDI t0, x0, 1
    writeWord(flash, 8, 0x00532423); // SW t0, 8(t1)   [offset 8 = W1TS]

    core.reset(0x42000000);
    runSteps(core, 3);

    expect(pinChanges).toContainEqual({ pin: 0, state: true });
  });

  it('SW to GPIO_OUT_W1TC (offset +12) clears GPIO0', () => {
    const pinChanges: Array<{ pin: number; state: boolean }> = [];
    sim.onPinChangeWithTime = (pin, state) => pinChanges.push({ pin, state });

    const flash = getFlash(sim);
    const core = getCore(sim);

    // First set GPIO0 high via W1TS, then clear via W1TC
    writeWord(flash, 0, 0x60004337); // LUI t1, 0x60004
    writeWord(flash, 4, 0x00100293); // ADDI t0, x0, 1
    writeWord(flash, 8, 0x00532423); // SW t0, 8(t1)   — set bit 0 (W1TS)
    writeWord(flash, 12, 0x00532623); // SW t0, 12(t1)  — clear bit 0 (W1TC)

    core.reset(0x42000000);
    runSteps(core, 4);

    expect(pinChanges).toContainEqual({ pin: 0, state: true });
    expect(pinChanges).toContainEqual({ pin: 0, state: false });
  });

  it('SW to GPIO_OUT sets multiple pins via direct write', () => {
    const setPins: number[] = [];
    sim.onPinChangeWithTime = (pin, state) => {
      if (state) setPins.push(pin);
    };

    const flash = getFlash(sim);
    const core = getCore(sim);

    // Write 0b101 (bits 0 and 2) to GPIO_OUT (offset +4)
    writeWord(flash, 0, 0x60004337); // LUI t1, 0x60004
    writeWord(flash, 4, 0x00500293); // ADDI t0, x0, 5  (0b101)
    writeWord(flash, 8, 0x00532223); // SW t0, 4(t1)    — GPIO_OUT

    core.reset(0x42000000);
    runSteps(core, 3);

    expect(setPins).toContain(0);
    expect(setPins).toContain(2);
    expect(setPins).not.toContain(1);
  });

  it('pinManager.setPinState is called on GPIO change', () => {
    const pm = mockPinManager();
    const s = new Esp32C3Simulator(pm);
    const flash = getFlash(s);
    const core = getCore(s);

    writeWord(flash, 0, 0x60004337); // LUI t1, 0x60004
    writeWord(flash, 4, 0x00100293); // ADDI t0, x0, 1
    writeWord(flash, 8, 0x00532423); // SW t0, 8(t1)

    core.reset(0x42000000);
    runSteps(core, 3);

    expect(pm.setPinState).toHaveBeenCalledWith(0, true);
    s.stop();
  });
});

// ── Test Group 5: Lifecycle ──────────────────────────────────────────────────

describe('Esp32C3Simulator — lifecycle', () => {
  it('starts not running', () => {
    const sim = new Esp32C3Simulator(mockPinManager());
    expect(sim.isRunning()).toBe(false);
    sim.stop();
  });

  it('start() sets running, stop() clears it', () => {
    const sim = new Esp32C3Simulator(mockPinManager());
    sim.start();
    expect(sim.isRunning()).toBe(true);
    sim.stop();
    expect(sim.isRunning()).toBe(false);
  });

  it('reset() stops simulator and clears register state', () => {
    const sim = new Esp32C3Simulator(mockPinManager());
    const core = getCore(sim);
    core.regs[1] = 999;
    sim.start();
    sim.reset();
    expect(sim.isRunning()).toBe(false);
    expect(core.regs[1]).toBe(0);
    expect(core.pc).toBe(0x42000000);
  });

  it('reset() clears GPIO output state', () => {
    const pinChanges: Array<{ pin: number; state: boolean }> = [];
    const sim = new Esp32C3Simulator(mockPinManager());
    sim.onPinChangeWithTime = (pin, state) => pinChanges.push({ pin, state });

    const flash = getFlash(sim);
    const core = getCore(sim);
    writeWord(flash, 0, 0x60004337);
    writeWord(flash, 4, 0x00100293);
    writeWord(flash, 8, 0x00532423);
    core.reset(0x42000000);
    runSteps(core, 3);

    sim.reset();

    const gpioOut = (sim as unknown as { gpioOut: number }).gpioOut;
    expect(gpioOut).toBe(0);
  });

  it('double start() is a no-op (does not create duplicate loops)', () => {
    let rafCalls = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCalls++;
      // Don't recurse
      return rafCalls;
    });

    const sim = new Esp32C3Simulator(mockPinManager());
    sim.start();
    sim.start(); // second call should be ignored
    expect(rafCalls).toBe(1);
    sim.stop();
  });
});

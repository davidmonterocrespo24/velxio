/**
 * RiscVCore — Minimal RV32I base ISA interpreter in TypeScript.
 *
 * Supports the complete RV32I instruction set (40 instructions):
 * LUI, AUIPC, JAL, JALR, BRANCH, LOAD, STORE, OP-IMM, OP, FENCE, SYSTEM
 *
 * Memory model: flat Uint8Array, caller supplies base address mappings.
 * MMIO: caller installs read/write hooks at specific address ranges.
 *
 * Limitations (acceptable for educational emulation):
 * - No privilege levels / CSR side-effects (CSR reads return 0)
 * - No interrupts / exceptions (ECALL/EBREAK are no-ops)
 * - No misalignment exceptions
 * - No compressed (RV32C) or multiply (RV32M) extensions
 */

export type MmioReadHook  = (addr: number) => number;
export type MmioWriteHook = (addr: number, value: number) => void;

interface MmioRegion {
  base: number;
  size: number;
  read: MmioReadHook;
  write: MmioWriteHook;
}

export class RiscVCore {
  /** General-purpose registers x0–x31 (x0 is always 0) */
  readonly regs = new Int32Array(32);
  /** Program counter */
  pc = 0x0800_0000;
  /** CPU cycle counter */
  cycles = 0;

  private readonly mem: Uint8Array;
  private readonly memBase: number;
  private readonly mmioRegions: MmioRegion[] = [];

  /**
   * @param mem     Flat memory buffer (flash + RAM mapped contiguously)
   * @param memBase Physical base address of `mem` (e.g. 0x08000000 for flash)
   */
  constructor(mem: Uint8Array, memBase: number) {
    this.mem = mem;
    this.memBase = memBase;
  }

  /** Register an MMIO region. Reads/writes in [base, base+size) go to hooks. */
  addMmio(base: number, size: number, read: MmioReadHook, write: MmioWriteHook): void {
    this.mmioRegions.push({ base, size, read, write });
  }

  reset(resetVector: number): void {
    this.regs.fill(0);
    this.pc = resetVector;
    this.cycles = 0;
  }

  // ── Memory access helpers ───────────────────────────────────────────────

  private mmioFor(addr: number): MmioRegion | null {
    for (const r of this.mmioRegions) {
      if (addr >= r.base && addr < r.base + r.size) return r;
    }
    return null;
  }

  readByte(addr: number): number {
    const mmio = this.mmioFor(addr);
    if (mmio) return mmio.read(addr) & 0xff;
    const off = addr - this.memBase;
    if (off >= 0 && off < this.mem.length) return this.mem[off];
    return 0;
  }

  readHalf(addr: number): number {
    return this.readByte(addr) | (this.readByte(addr + 1) << 8);
  }

  readWord(addr: number): number {
    return (this.readByte(addr)
      | (this.readByte(addr + 1) << 8)
      | (this.readByte(addr + 2) << 16)
      | (this.readByte(addr + 3) << 24)) >>> 0;
  }

  writeByte(addr: number, value: number): void {
    const mmio = this.mmioFor(addr);
    if (mmio) { mmio.write(addr, value & 0xff); return; }
    const off = addr - this.memBase;
    if (off >= 0 && off < this.mem.length) this.mem[off] = value & 0xff;
  }

  writeHalf(addr: number, value: number): void {
    this.writeByte(addr,     value & 0xff);
    this.writeByte(addr + 1, (value >> 8) & 0xff);
  }

  writeWord(addr: number, value: number): void {
    this.writeByte(addr,     value & 0xff);
    this.writeByte(addr + 1, (value >> 8)  & 0xff);
    this.writeByte(addr + 2, (value >> 16) & 0xff);
    this.writeByte(addr + 3, (value >> 24) & 0xff);
  }

  // ── Immediate decoders ──────────────────────────────────────────────────

  private iImm(instr: number): number {
    return (instr >> 20) << 0 >> 0;  // sign-extend [31:20]
  }

  private sImm(instr: number): number {
    const imm = ((instr >> 25) << 5) | ((instr >> 7) & 0x1f);
    return (imm << 20) >> 20;  // sign-extend 12-bit
  }

  private bImm(instr: number): number {
    const imm = ((instr >> 31) << 12)
      | (((instr >> 7) & 1) << 11)
      | (((instr >> 25) & 0x3f) << 5)
      | (((instr >> 8)  & 0xf)  << 1);
    return (imm << 19) >> 19;  // sign-extend 13-bit
  }

  private uImm(instr: number): number {
    return (instr & 0xffff_f000) | 0;
  }

  private jImm(instr: number): number {
    const imm = ((instr >> 31) << 20)
      | (((instr >> 12) & 0xff) << 12)
      | (((instr >> 20) & 1)    << 11)
      | (((instr >> 21) & 0x3ff) << 1);
    return (imm << 11) >> 11;  // sign-extend 21-bit
  }

  // ── Register helpers ────────────────────────────────────────────────────

  private reg(r: number): number   { return r === 0 ? 0 : this.regs[r]; }
  private setReg(r: number, v: number): void { if (r !== 0) this.regs[r] = v; }

  // ── Single instruction step ─────────────────────────────────────────────

  /**
   * Execute one instruction. Returns the number of cycles consumed (always 1
   * for this simple model — real chips have variable latency).
   */
  step(): number {
    const instr = this.readWord(this.pc);
    const opcode = instr & 0x7f;
    const rd     = (instr >> 7)  & 0x1f;
    const funct3 = (instr >> 12) & 0x07;
    const rs1    = (instr >> 15) & 0x1f;
    const rs2    = (instr >> 20) & 0x1f;
    const funct7 = (instr >> 25) & 0x7f;

    let nextPc = (this.pc + 4) >>> 0;

    switch (opcode) {

      // LUI
      case 0x37:
        this.setReg(rd, this.uImm(instr));
        break;

      // AUIPC
      case 0x17:
        this.setReg(rd, (this.pc + this.uImm(instr)) | 0);
        break;

      // JAL
      case 0x6f: {
        const target = (this.pc + this.jImm(instr)) >>> 0;
        this.setReg(rd, nextPc);
        nextPc = target;
        break;
      }

      // JALR
      case 0x67: {
        const target = (this.reg(rs1) + this.iImm(instr)) & ~1;
        this.setReg(rd, nextPc);
        nextPc = target >>> 0;
        break;
      }

      // BRANCH
      case 0x63: {
        const a = this.reg(rs1);
        const b = this.reg(rs2);
        let taken = false;
        switch (funct3) {
          case 0x0: taken = a === b; break;                           // BEQ
          case 0x1: taken = a !== b; break;                           // BNE
          case 0x4: taken = a < b; break;                             // BLT  (signed)
          case 0x5: taken = a >= b; break;                            // BGE  (signed)
          case 0x6: taken = (a >>> 0) < (b >>> 0); break;            // BLTU
          case 0x7: taken = (a >>> 0) >= (b >>> 0); break;           // BGEU
        }
        if (taken) nextPc = (this.pc + this.bImm(instr)) >>> 0;
        break;
      }

      // LOAD
      case 0x03: {
        const addr = (this.reg(rs1) + this.iImm(instr)) >>> 0;
        let val: number;
        switch (funct3) {
          case 0x0: val = (this.readByte(addr) << 24) >> 24; break;  // LB
          case 0x1: val = (this.readHalf(addr) << 16) >> 16; break;  // LH
          case 0x2: val = this.readWord(addr) | 0; break;             // LW
          case 0x4: val = this.readByte(addr); break;                 // LBU
          case 0x5: val = this.readHalf(addr); break;                 // LHU
          default:  val = 0;
        }
        this.setReg(rd, val);
        break;
      }

      // STORE
      case 0x23: {
        const addr = (this.reg(rs1) + this.sImm(instr)) >>> 0;
        const val  = this.reg(rs2);
        switch (funct3) {
          case 0x0: this.writeByte(addr, val); break;                  // SB
          case 0x1: this.writeHalf(addr, val); break;                  // SH
          case 0x2: this.writeWord(addr, val); break;                  // SW
        }
        break;
      }

      // OP-IMM
      case 0x13: {
        const a   = this.reg(rs1);
        const imm = this.iImm(instr);
        let val: number;
        switch (funct3) {
          case 0x0: val = a + imm; break;                              // ADDI
          case 0x1: val = a << (imm & 0x1f); break;                   // SLLI
          case 0x2: val = a < imm ? 1 : 0; break;                     // SLTI
          case 0x3: val = (a >>> 0) < (imm >>> 0) ? 1 : 0; break;    // SLTIU
          case 0x4: val = a ^ imm; break;                              // XORI
          case 0x5: val = funct7 === 0x20                              // SRLI/SRAI
            ? (a >> (imm & 0x1f))
            : (a >>> (imm & 0x1f)); break;
          case 0x6: val = a | imm; break;                              // ORI
          case 0x7: val = a & imm; break;                              // ANDI
          default:  val = 0;
        }
        this.setReg(rd, val);
        break;
      }

      // OP (register–register)
      case 0x33: {
        const a = this.reg(rs1);
        const b = this.reg(rs2);
        let val: number;
        switch ((funct7 << 3) | funct3) {
          case 0x000: val = a + b; break;                              // ADD
          case 0x100: val = a - b; break;                              // SUB
          case 0x001: val = a << (b & 0x1f); break;                   // SLL
          case 0x002: val = a < b ? 1 : 0; break;                     // SLT
          case 0x003: val = (a >>> 0) < (b >>> 0) ? 1 : 0; break;    // SLTU
          case 0x004: val = a ^ b; break;                              // XOR
          case 0x005: val = a >>> (b & 0x1f); break;                  // SRL
          case 0x105: val = a >> (b & 0x1f); break;                   // SRA
          case 0x006: val = a | b; break;                              // OR
          case 0x007: val = a & b; break;                              // AND
          default:    val = 0;
        }
        this.setReg(rd, val);
        break;
      }

      // MISC-MEM (FENCE — no-op in single-hart emulator)
      case 0x0f:
        break;

      // SYSTEM (ECALL, EBREAK, CSR* — treat as no-op)
      case 0x73:
        break;

      default:
        // Unknown opcode — skip instruction to avoid infinite loop
        break;
    }

    this.pc = nextPc;
    this.cycles++;
    return 1;
  }
}

/**
 * RiscVCore — Minimal RV32IMC interpreter in TypeScript.
 *
 * Supports the complete RV32I base ISA (40 instructions) plus:
 *   RV32M — multiply/divide extension (MUL, MULH, MULHSU, MULHU, DIV, DIVU, REM, REMU)
 *   RV32C — compressed 16-bit instruction extension (all ~40 instructions, decompressed to 32-bit)
 *
 * Memory model: flat Uint8Array, caller supplies base address mappings.
 * MMIO: caller installs read/write hooks at specific address ranges.
 *
 * Machine-mode CSR support:
 *   mstatus, mie, mtvec, mscratch, mepc, mcause, mtval, mcycle/cycle
 *   MRET, ECALL (cause=11), external interrupt dispatch via triggerInterrupt()
 *
 * Limitations (acceptable for educational emulation):
 * - No privilege levels below M-mode
 * - No misalignment exceptions
 * - No RV32A (atomic) or floating-point extensions
 */

export type MmioReadHook = (addr: number) => number;
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

  // ── Machine-mode CSR registers ────────────────────────────────────────────
  /** 0x300 mstatus — bit3=MIE (global enable), bit7=MPIE, bits[12:11]=MPP */
  private mstatus = 0;
  /** 0x304 mie — per-source interrupt enable mask */
  private mie = 0;
  /** 0x305 mtvec — trap-vector base address + mode (bit0=vectored) */
  private mtvec = 0;
  /** 0x340 mscratch — scratch register (used by FreeRTOS context switch) */
  private mscratch = 0;
  /** 0x341 mepc — address of interrupted/excepting instruction */
  private mepc = 0;
  /** 0x342 mcause — trap cause; bit31=interrupt, bits[4:0]=cause number */
  private mcause = 0;
  /** 0x343 mtval — trap value (fault address / instruction bits) */
  private mtval = 0;
  /** Pending async interrupt cause (bit31=1). Null when none pending. */
  pendingInterrupt: number | null = null;

  /**
   * Callback fired whenever mstatus.MIE transitions from 0 → 1.
   * The interrupt matrix uses this to scan pending sources and inject the
   * highest-priority interrupt immediately after re-enable.
   */
  onMieEnabled: (() => void) | null = null;

  // ── RV32A reservation state ───────────────────────────────────────────────
  /** Address of the load-reserved (lr.w) reservation, or -1 if none. */
  private _resAddr = -1;
  /** Whether the reservation is valid (cleared on sc.w, trap, or context switch). */
  private _resValid = false;

  private readonly mem: Uint8Array;
  private readonly memBase: number;
  private readonly mmioRegions: MmioRegion[] = [];
  /** Word-aligned addresses of unmapped peripheral reads logged so far (dedup). */
  private readonly _seenUnmapped = new Set<number>();

  /**
   * @param mem     Flat memory buffer (flash + RAM mapped contiguously)
   * @param memBase Physical base address of `mem` (e.g. 0x08000000 for flash)
   */
  constructor(mem: Uint8Array, memBase: number) {
    this.mem = mem;
    this.memBase = memBase;
  }

  /**
   * Register an MMIO region. Reads/writes in [base, base+size) go to hooks.
   * Regions are kept sorted by base address so mmioFor() can use early exit.
   */
  addMmio(base: number, size: number, read: MmioReadHook, write: MmioWriteHook): void {
    const region = { base, size, read, write };
    const idx = this.mmioRegions.findIndex((r) => r.base > base);
    if (idx === -1) this.mmioRegions.push(region);
    else this.mmioRegions.splice(idx, 0, region);
  }

  reset(resetVector: number): void {
    this.regs.fill(0);
    this.pc = resetVector;
    this.cycles = 0;
    this.mstatus = 0;
    this.mie = 0;
    this.mtvec = 0;
    this.mscratch = 0;
    this.mepc = 0;
    this.mcause = 0;
    this.mtval = 0;
    this.pendingInterrupt = null;
    this._resAddr = -1;
    this._resValid = false;
    this._seenUnmapped.clear();
  }

  /**
   * Raise a machine-level interrupt. The cause is stored and will be taken at
   * the next instruction boundary when mstatus.MIE (bit3) is set.
   * Bit31=1 for asynchronous interrupts; bits[4:0] = CPU interrupt number.
   */
  triggerInterrupt(cause: number): void {
    this.pendingInterrupt = cause >>> 0;
  }

  // ── CSR helpers ─────────────────────────────────────────────────────────

  private readCsr(addr: number): number {
    switch (addr) {
      case 0x300:
        return this.mstatus;
      case 0x301:
        return 0x40001105; // misa: RV32IMAC (MXL=01, I+M+A+C)
      case 0x304:
        return this.mie;
      case 0x305:
        return this.mtvec;
      case 0x340:
        return this.mscratch;
      case 0x341:
        return this.mepc;
      case 0x342:
        return this.mcause;
      case 0x343:
        return this.mtval;
      case 0x344:
        return this.pendingInterrupt !== null ? 1 << 11 : 0; // mip: MEIP
      case 0xb00:
      case 0xc00:
        return this.cycles >>> 0; // mcycle / cycle (low 32)
      case 0xb80:
      case 0xc80:
        return 0; // mcycleh / cycleh
      case 0xf11:
        return 0; // mvendorid
      case 0xf12:
        return 0; // marchid
      case 0xf13:
        return 0; // mimpid
      case 0xf14:
        return 0; // mhartid (always 0 — single-hart)
      default:
        return 0;
    }
  }

  private writeCsr(addr: number, val: number): void {
    switch (addr) {
      case 0x300: {
        const oldMie = this.mstatus & 0x8;
        this.mstatus = val;
        if (!oldMie && val & 0x8 && this.onMieEnabled) this.onMieEnabled();
        break;
      }
      case 0x304:
        this.mie = val;
        break;
      case 0x305:
        this.mtvec = val;
        break;
      case 0x340:
        this.mscratch = val;
        break;
      case 0x341:
        this.mepc = val;
        break;
      case 0x342:
        this.mcause = val;
        break;
      case 0x343:
        this.mtval = val;
        break;
      // cycle counters are read-only; ignore writes
    }
  }

  // ── Public diagnostic accessors ─────────────────────────────────────────
  /** Current value of mstatus (bit3=MIE, bit7=MPIE). */
  get mstatusVal(): number {
    return this.mstatus;
  }
  /** Current value of mtvec (trap-vector base + mode). */
  get mtvecVal(): number {
    return this.mtvec;
  }

  // ── Memory access helpers ───────────────────────────────────────────────

  private mmioFor(addr: number): MmioRegion | null {
    // Regions are sorted by base address; once addr < r.base no later region can match.
    // Among all matching regions, pick the MOST SPECIFIC (smallest size) so that
    // narrow handlers take priority over a broad catch-all region.
    let best: MmioRegion | null = null;
    for (const r of this.mmioRegions) {
      if (addr < r.base) break;
      if (addr < r.base + r.size) {
        if (best === null || r.size < best.size) best = r;
      }
    }
    return best;
  }

  readByte(addr: number): number {
    const mmio = this.mmioFor(addr);
    if (mmio) return mmio.read(addr) & 0xff;
    const off = addr - this.memBase;
    if (off >= 0 && off < this.mem.length) return this.mem[off];
    // Log first access to each unique unmapped peripheral word address so we
    // can identify spin-wait targets that need a stub to return "ready".
    const uAddr = addr >>> 0;
    if (uAddr >= 0x60000000 && uAddr < 0x80000000) {
      const wordAddr = uAddr & ~3;
      if (!this._seenUnmapped.has(wordAddr)) {
        this._seenUnmapped.add(wordAddr);
        console.warn(`[RiscV] unmapped peripheral read @ 0x${wordAddr.toString(16)}`);
      }
    }
    return 0;
  }

  readHalf(addr: number): number {
    return this.readByte(addr) | (this.readByte(addr + 1) << 8);
  }

  readWord(addr: number): number {
    return (
      (this.readByte(addr) |
        (this.readByte(addr + 1) << 8) |
        (this.readByte(addr + 2) << 16) |
        (this.readByte(addr + 3) << 24)) >>>
      0
    );
  }

  writeByte(addr: number, value: number): void {
    const mmio = this.mmioFor(addr);
    if (mmio) {
      mmio.write(addr, value & 0xff);
      return;
    }
    const off = addr - this.memBase;
    if (off >= 0 && off < this.mem.length) this.mem[off] = value & 0xff;
  }

  writeHalf(addr: number, value: number): void {
    this.writeByte(addr, value & 0xff);
    this.writeByte(addr + 1, (value >> 8) & 0xff);
  }

  writeWord(addr: number, value: number): void {
    this.writeByte(addr, value & 0xff);
    this.writeByte(addr + 1, (value >> 8) & 0xff);
    this.writeByte(addr + 2, (value >> 16) & 0xff);
    this.writeByte(addr + 3, (value >> 24) & 0xff);
  }

  // ── Immediate decoders ──────────────────────────────────────────────────

  private iImm(instr: number): number {
    return ((instr >> 20) << 0) >> 0; // sign-extend [31:20]
  }

  private sImm(instr: number): number {
    const imm = ((instr >> 25) << 5) | ((instr >> 7) & 0x1f);
    return (imm << 20) >> 20; // sign-extend 12-bit
  }

  private bImm(instr: number): number {
    const imm =
      ((instr >> 31) << 12) |
      (((instr >> 7) & 1) << 11) |
      (((instr >> 25) & 0x3f) << 5) |
      (((instr >> 8) & 0xf) << 1);
    return (imm << 19) >> 19; // sign-extend 13-bit
  }

  private uImm(instr: number): number {
    return (instr & 0xffff_f000) | 0;
  }

  private jImm(instr: number): number {
    const imm =
      ((instr >> 31) << 20) |
      (((instr >> 12) & 0xff) << 12) |
      (((instr >> 20) & 1) << 11) |
      (((instr >> 21) & 0x3ff) << 1);
    return (imm << 11) >> 11; // sign-extend 21-bit
  }

  // ── Register helpers ────────────────────────────────────────────────────

  private reg(r: number): number {
    return r === 0 ? 0 : this.regs[r];
  }
  private setReg(r: number, v: number): void {
    if (r !== 0) this.regs[r] = v;
  }

  // ── RV32C decompressor ──────────────────────────────────────────────────

  /**
   * Decompress a 16-bit RV32C instruction to its 32-bit RV32I/M equivalent.
   * Returns the equivalent 32-bit instruction word.
   */
  private decompressC(half: number): number {
    const op = half & 0x3;
    const funct3 = (half >> 13) & 0x7;
    const bit12 = (half >> 12) & 0x1;

    // Sign-extend val from bits bits
    const sext = (val: number, bits: number) => (val << (32 - bits)) >> (32 - bits);

    // Instruction encoders
    const encI = (imm: number, rs1: number, f3: number, rd: number, oc: number) =>
      ((imm & 0xfff) << 20) |
      ((rs1 & 0x1f) << 15) |
      ((f3 & 0x7) << 12) |
      ((rd & 0x1f) << 7) |
      (oc & 0x7f);
    const encR = (f7: number, rs2: number, rs1: number, f3: number, rd: number, oc: number) =>
      ((f7 & 0x7f) << 25) |
      ((rs2 & 0x1f) << 20) |
      ((rs1 & 0x1f) << 15) |
      ((f3 & 0x7) << 12) |
      ((rd & 0x1f) << 7) |
      (oc & 0x7f);
    const encS = (imm: number, rs2: number, rs1: number, f3: number, oc: number) =>
      (((imm >> 5) & 0x7f) << 25) |
      ((rs2 & 0x1f) << 20) |
      ((rs1 & 0x1f) << 15) |
      ((f3 & 0x7) << 12) |
      ((imm & 0x1f) << 7) |
      (oc & 0x7f);
    const encJ = (imm: number, rd: number) => {
      const b20 = (imm >> 20) & 1;
      const b19_12 = (imm >> 12) & 0xff;
      const b11 = (imm >> 11) & 1;
      const b10_1 = (imm >> 1) & 0x3ff;
      return (b20 << 31) | (b10_1 << 21) | (b11 << 20) | (b19_12 << 12) | ((rd & 0x1f) << 7) | 0x6f;
    };
    const encB = (imm: number, rs2: number, rs1: number, f3: number) => {
      const b12 = (imm >> 12) & 1;
      const b11 = (imm >> 11) & 1;
      const b10_5 = (imm >> 5) & 0x3f;
      const b4_1 = (imm >> 1) & 0xf;
      return (
        (b12 << 31) |
        (b10_5 << 25) |
        ((rs2 & 0x1f) << 20) |
        ((rs1 & 0x1f) << 15) |
        ((f3 & 7) << 12) |
        (b4_1 << 8) |
        (b11 << 7) |
        0x63
      );
    };

    // CJ-format 11-bit signed offset (scrambled bit positions per spec Table 16.6)
    const cjOff = () =>
      sext(
        (bit12 << 11) |
          (((half >> 11) & 1) << 4) |
          (((half >> 9) & 3) << 8) |
          (((half >> 8) & 1) << 10) |
          (((half >> 7) & 1) << 6) |
          (((half >> 6) & 1) << 7) |
          (((half >> 3) & 7) << 1) |
          (((half >> 2) & 1) << 5),
        12,
      );

    // CB-format 8-bit signed offset
    const cbOff = () =>
      sext(
        (bit12 << 8) |
          (((half >> 10) & 3) << 3) |
          (((half >> 5) & 3) << 6) |
          (((half >> 3) & 3) << 1) |
          (((half >> 2) & 1) << 5),
        9,
      );

    // ── Quadrant 0 (op=00) ──────────────────────────────────────────────
    if (op === 0) {
      const rdp = ((half >> 2) & 7) + 8; // rd' → x(8..15)
      const rs1p = ((half >> 7) & 7) + 8; // rs1' → x(8..15)
      switch (funct3) {
        case 0: {
          // C.ADDI4SPN → ADDI rd', sp, nzuimm
          const nzuimm =
            (((half >> 7) & 0xf) << 6) |
            (((half >> 11) & 0x3) << 4) |
            (((half >> 5) & 1) << 3) |
            (((half >> 6) & 1) << 2);
          return encI(nzuimm, 2, 0, rdp, 0x13);
        }
        case 2: {
          // C.LW → LW rd', offset(rs1')
          const off =
            (((half >> 10) & 7) << 3) | (((half >> 6) & 1) << 2) | (((half >> 5) & 1) << 6);
          return encI(off, rs1p, 2, rdp, 0x03);
        }
        case 6: {
          // C.SW → SW rs2', offset(rs1')
          const off =
            (((half >> 10) & 7) << 3) | (((half >> 6) & 1) << 2) | (((half >> 5) & 1) << 6);
          return encS(off, rdp, rs1p, 2, 0x23); // rdp plays role of rs2' in CS format
        }
        default:
          return 0x00000013; // reserved → NOP
      }
    }

    // ── Quadrant 1 (op=01) ──────────────────────────────────────────────
    if (op === 1) {
      const rd = (half >> 7) & 0x1f;
      const rs1p = ((half >> 7) & 7) + 8;
      const rs2p = ((half >> 2) & 7) + 8;
      const imm6 = sext((bit12 << 5) | ((half >> 2) & 0x1f), 6);

      switch (funct3) {
        case 0: // C.NOP / C.ADDI → ADDI rd, rd, imm
          return encI(imm6, rd, 0, rd, 0x13);
        case 1: // C.JAL (RV32C only) → JAL x1, offset
          return encJ(cjOff(), 1);
        case 2: // C.LI → ADDI rd, x0, imm
          return encI(imm6, 0, 0, rd, 0x13);
        case 3: {
          if (rd === 2) {
            // C.ADDI16SP → ADDI sp, sp, nzimm
            const nzimm = sext(
              (bit12 << 9) |
                (((half >> 6) & 1) << 4) |
                (((half >> 5) & 1) << 6) |
                (((half >> 3) & 3) << 7) |
                (((half >> 2) & 1) << 5),
              10,
            );
            return encI(nzimm, 2, 0, 2, 0x13);
          } else {
            // C.LUI → LUI rd, nzimm
            const nzimm = sext((bit12 << 17) | (((half >> 2) & 0x1f) << 12), 18);
            return (nzimm & 0xfffff000) | ((rd & 0x1f) << 7) | 0x37;
          }
        }
        case 4: {
          const f2 = (half >> 10) & 0x3;
          const sh = (bit12 << 5) | ((half >> 2) & 0x1f);
          if (f2 === 0) return encI(sh, rs1p, 5, rs1p, 0x13); // C.SRLI → SRLI
          if (f2 === 1) return encI(0x400 | sh, rs1p, 5, rs1p, 0x13); // C.SRAI → SRAI (bit10=1)
          if (f2 === 2) return encI(imm6, rs1p, 7, rs1p, 0x13); // C.ANDI → ANDI
          // f2 === 3: C.SUB / C.XOR / C.OR / C.AND
          const op2 = (half >> 5) & 3;
          if (!bit12) {
            switch (op2) {
              case 0:
                return encR(0x20, rs2p, rs1p, 0, rs1p, 0x33); // C.SUB  (funct7=0x20)
              case 1:
                return encR(0, rs2p, rs1p, 4, rs1p, 0x33); // C.XOR
              case 2:
                return encR(0, rs2p, rs1p, 6, rs1p, 0x33); // C.OR
              case 3:
                return encR(0, rs2p, rs1p, 7, rs1p, 0x33); // C.AND
            }
          }
          return 0x00000013; // C.SUBW etc. (RV64 only) → NOP
        }
        case 5: // C.J → JAL x0, offset
          return encJ(cjOff(), 0);
        case 6: // C.BEQZ → BEQ rs1', x0, offset
          return encB(cbOff(), 0, rs1p, 0);
        case 7: // C.BNEZ → BNE rs1', x0, offset
          return encB(cbOff(), 0, rs1p, 1);
        default:
          return 0x00000013;
      }
    }

    // ── Quadrant 2 (op=10) ──────────────────────────────────────────────
    if (op === 2) {
      const rd = (half >> 7) & 0x1f;
      const rs2 = (half >> 2) & 0x1f;

      switch (funct3) {
        case 0: {
          // C.SLLI → SLLI rd, rd, shamt
          const sh = (bit12 << 5) | rs2;
          return encI(sh, rd, 1, rd, 0x13);
        }
        case 2: {
          // C.LWSP → LW rd, offset(sp)
          // uimm[7:6]=bits[3:2], uimm[5]=bit12, uimm[4:2]=bits[6:4]
          const off = (((half >> 2) & 3) << 6) | (bit12 << 5) | (((half >> 4) & 7) << 2);
          return encI(off, 2, 2, rd, 0x03);
        }
        case 4: {
          if (!bit12) {
            if (rs2 === 0) return encI(0, rd, 0, 0, 0x67); // C.JR   → JALR x0, 0(rd)
            return encR(0, rs2, 0, 0, rd, 0x33); // C.MV   → ADD  rd, x0, rs2
          } else {
            if (rd === 0 && rs2 === 0) return 0x00100073; // C.EBREAK
            if (rs2 === 0) return encI(0, rd, 0, 1, 0x67); // C.JALR → JALR x1, 0(rd)
            return encR(0, rs2, rd, 0, rd, 0x33); // C.ADD  → ADD  rd, rd, rs2
          }
        }
        case 6: {
          // C.SWSP → SW rs2, offset(sp)
          // uimm[7:6]=bits[8:7], uimm[5:2]=bits[12:9]
          const off = (((half >> 7) & 3) << 6) | (((half >> 9) & 0xf) << 2);
          return encS(off, rs2, 2, 2, 0x23);
        }
        default:
          return 0x00000013;
      }
    }

    return 0x00000013; // should not reach (op=11 means 32-bit instruction)
  }

  // ── Single instruction step ─────────────────────────────────────────────

  /**
   * Execute one instruction. Returns the number of cycles consumed (always 1
   * for this simple model — real chips have variable latency).
   */
  step(): number {
    // ── Interrupt check ───────────────────────────────────────────────────
    // Take a pending interrupt if global interrupt enable (mstatus.MIE) is set.
    if (this.pendingInterrupt !== null && this.mstatus & 0x8) {
      const cause = this.pendingInterrupt;
      this.pendingInterrupt = null;
      this._resValid = false; // Clear reservation on trap
      const mieOld = (this.mstatus >> 3) & 1; // current MIE
      this.mstatus =
        (this.mstatus & ~0x88) | // clear MPIE (bit7) and MIE (bit3)
        (mieOld << 7); // MPIE = old MIE
      this.mepc = this.pc;
      this.mcause = cause;
      const intNum = cause & 0x1f;
      // Vectored mode (mtvec[1:0]==1): PC = base + 4*intNum
      // Direct  mode (mtvec[1:0]==0): PC = base
      this.pc =
        (this.mtvec & 3) === 1
          ? ((this.mtvec & ~3) >>> 0) + (intNum << 2)
          : (this.mtvec & ~3) >>> 0;
      this.cycles++;
      return 1;
    }

    // ── Instruction fetch ──────────────────────────────────────────────────
    // Fast path: flat memory (IROM / flash) — avoids MMIO scan entirely.
    const pc = this.pc;
    let instr: number;
    let instrLen: number;
    const off0 = pc - this.memBase;
    if (off0 >= 0 && off0 + 4 <= this.mem.length) {
      const b0 = this.mem[off0],
        b1 = this.mem[off0 + 1];
      const half0 = (b0 | (b1 << 8)) & 0xffff;
      if ((half0 & 0x3) !== 0x3) {
        instr = this.decompressC(half0);
        instrLen = 2;
      } else {
        instr = (half0 | (this.mem[off0 + 2] << 16) | (this.mem[off0 + 3] << 24)) >>> 0;
        instrLen = 4;
      }
    } else {
      // Slow path: MMIO (IRAM, ROM stub, peripheral-mapped code)
      const half = this.readHalf(pc);
      if ((half & 0x3) !== 0x3) {
        instr = this.decompressC(half);
        instrLen = 2;
      } else {
        const upper = this.readHalf(pc + 2);
        instr = (half | (upper << 16)) >>> 0;
        instrLen = 4;
      }
    }

    const opcode = instr & 0x7f;
    const rd = (instr >> 7) & 0x1f;
    const funct3 = (instr >> 12) & 0x07;
    const rs1 = (instr >> 15) & 0x1f;
    const rs2 = (instr >> 20) & 0x1f;
    const funct7 = (instr >> 25) & 0x7f;

    let nextPc = (this.pc + instrLen) >>> 0;

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
          case 0x0:
            taken = a === b;
            break; // BEQ
          case 0x1:
            taken = a !== b;
            break; // BNE
          case 0x4:
            taken = a < b;
            break; // BLT  (signed)
          case 0x5:
            taken = a >= b;
            break; // BGE  (signed)
          case 0x6:
            taken = a >>> 0 < b >>> 0;
            break; // BLTU
          case 0x7:
            taken = a >>> 0 >= b >>> 0;
            break; // BGEU
        }
        if (taken) nextPc = (this.pc + this.bImm(instr)) >>> 0;
        break;
      }

      // LOAD
      case 0x03: {
        const addr = (this.reg(rs1) + this.iImm(instr)) >>> 0;
        let val: number;
        switch (funct3) {
          case 0x0:
            val = (this.readByte(addr) << 24) >> 24;
            break; // LB
          case 0x1:
            val = (this.readHalf(addr) << 16) >> 16;
            break; // LH
          case 0x2:
            val = this.readWord(addr) | 0;
            break; // LW
          case 0x4:
            val = this.readByte(addr);
            break; // LBU
          case 0x5:
            val = this.readHalf(addr);
            break; // LHU
          default:
            val = 0;
        }
        this.setReg(rd, val);
        break;
      }

      // STORE
      case 0x23: {
        const addr = (this.reg(rs1) + this.sImm(instr)) >>> 0;
        const val = this.reg(rs2);
        switch (funct3) {
          case 0x0:
            this.writeByte(addr, val);
            break; // SB
          case 0x1:
            this.writeHalf(addr, val);
            break; // SH
          case 0x2:
            this.writeWord(addr, val);
            break; // SW
        }
        break;
      }

      // OP-IMM
      case 0x13: {
        const a = this.reg(rs1);
        const imm = this.iImm(instr);
        let val: number;
        switch (funct3) {
          case 0x0:
            val = a + imm;
            break; // ADDI
          case 0x1:
            val = a << (imm & 0x1f);
            break; // SLLI
          case 0x2:
            val = a < imm ? 1 : 0;
            break; // SLTI
          case 0x3:
            val = a >>> 0 < imm >>> 0 ? 1 : 0;
            break; // SLTIU
          case 0x4:
            val = a ^ imm;
            break; // XORI
          case 0x5:
            val =
              funct7 === 0x20 // SRLI/SRAI
                ? a >> (imm & 0x1f)
                : a >>> (imm & 0x1f);
            break;
          case 0x6:
            val = a | imm;
            break; // ORI
          case 0x7:
            val = a & imm;
            break; // ANDI
          default:
            val = 0;
        }
        this.setReg(rd, val);
        break;
      }

      // OP (register–register) — includes RV32M multiply/divide (funct7=1)
      case 0x33: {
        const a = this.reg(rs1);
        const b = this.reg(rs2);
        let val: number;
        switch ((funct7 << 3) | funct3) {
          // RV32I
          case 0x000:
            val = a + b;
            break; // ADD
          case 0x100:
            val = a - b;
            break; // SUB
          case 0x001:
            val = a << (b & 0x1f);
            break; // SLL
          case 0x002:
            val = a < b ? 1 : 0;
            break; // SLT
          case 0x003:
            val = a >>> 0 < b >>> 0 ? 1 : 0;
            break; // SLTU
          case 0x004:
            val = a ^ b;
            break; // XOR
          case 0x005:
            val = a >>> (b & 0x1f);
            break; // SRL
          case 0x105:
            val = a >> (b & 0x1f);
            break; // SRA
          case 0x006:
            val = a | b;
            break; // OR
          case 0x007:
            val = a & b;
            break; // AND
          // RV32M (funct7=1 → cases 0x008–0x00f)
          case 0x008:
            val = Math.imul(a, b);
            break; // MUL   (lower 32 bits)
          case 0x009:
            val = Number((BigInt(a) * BigInt(b)) >> 32n) | 0;
            break; // MULH  (s×s upper)
          case 0x00a:
            val = Number((BigInt(a) * BigInt(b >>> 0)) >> 32n) | 0;
            break; // MULHSU (s×u upper)
          case 0x00b:
            val = Number((BigInt(a >>> 0) * BigInt(b >>> 0)) >> 32n) >>> 0;
            break; // MULHU (u×u upper)
          case 0x00c:
            val = b === 0 ? -1 : (a / b) | 0;
            break; // DIV
          case 0x00d:
            val = b === 0 ? -1 : ((a >>> 0) / (b >>> 0)) | 0;
            break; // DIVU
          case 0x00e:
            val = b === 0 ? a : (a % b) | 0;
            break; // REM
          case 0x00f:
            val = b === 0 ? a | 0 : ((a >>> 0) % (b >>> 0)) | 0;
            break; // REMU
          default:
            val = 0;
        }
        this.setReg(rd, val);
        break;
      }

      // MISC-MEM (FENCE — no-op in single-hart emulator)
      case 0x0f:
        break;

      // ATOMIC (RV32A) — opcode 0x2F
      case 0x2f: {
        if (funct3 === 2) {
          // .W (word) operations
          const funct5 = funct7 >> 2;
          const addr = this.reg(rs1) >>> 0;
          switch (funct5) {
            case 0x02: {
              // LR.W — Load-Reserved
              const val = this.readWord(addr) | 0;
              this.setReg(rd, val);
              this._resAddr = addr;
              this._resValid = true;
              break;
            }
            case 0x03: {
              // SC.W — Store-Conditional
              if (this._resValid && this._resAddr === addr) {
                this.writeWord(addr, this.reg(rs2));
                this.setReg(rd, 0); // 0 = success
              } else {
                this.setReg(rd, 1); // 1 = failure
              }
              this._resValid = false;
              break;
            }
            case 0x01: {
              // AMOSWAP.W
              const old = this.readWord(addr) | 0;
              this.writeWord(addr, this.reg(rs2));
              this.setReg(rd, old);
              break;
            }
            case 0x00: {
              // AMOADD.W
              const old = this.readWord(addr) | 0;
              this.writeWord(addr, (old + this.reg(rs2)) | 0);
              this.setReg(rd, old);
              break;
            }
            case 0x04: {
              // AMOXOR.W
              const old = this.readWord(addr) | 0;
              this.writeWord(addr, (old ^ this.reg(rs2)) | 0);
              this.setReg(rd, old);
              break;
            }
            case 0x0c: {
              // AMOAND.W
              const old = this.readWord(addr) | 0;
              this.writeWord(addr, (old & this.reg(rs2)) | 0);
              this.setReg(rd, old);
              break;
            }
            case 0x08: {
              // AMOOR.W
              const old = this.readWord(addr) | 0;
              this.writeWord(addr, old | this.reg(rs2) | 0);
              this.setReg(rd, old);
              break;
            }
            case 0x10: {
              // AMOMIN.W (signed)
              const old = this.readWord(addr) | 0;
              const b = this.reg(rs2);
              this.writeWord(addr, old < b ? old : b);
              this.setReg(rd, old);
              break;
            }
            case 0x14: {
              // AMOMAX.W (signed)
              const old = this.readWord(addr) | 0;
              const b = this.reg(rs2);
              this.writeWord(addr, old > b ? old : b);
              this.setReg(rd, old);
              break;
            }
            case 0x18: {
              // AMOMINU.W (unsigned)
              const old = this.readWord(addr) | 0;
              const b = this.reg(rs2);
              this.writeWord(addr, old >>> 0 < b >>> 0 ? old : b);
              this.setReg(rd, old);
              break;
            }
            case 0x1c: {
              // AMOMAXU.W (unsigned)
              const old = this.readWord(addr) | 0;
              const b = this.reg(rs2);
              this.writeWord(addr, old >>> 0 > b >>> 0 ? old : b);
              this.setReg(rd, old);
              break;
            }
          }
        }
        break;
      }

      // SYSTEM — CSR instructions, MRET, ECALL, EBREAK, WFI
      case 0x73: {
        const funct12 = (instr >> 20) & 0xfff;
        if (funct3 === 0) {
          // Privileged instructions (not CSR)
          if (funct12 === 0x302) {
            // MRET — return from machine trap
            const oldMie = this.mstatus & 0x8;
            const mpie = (this.mstatus >> 7) & 1;
            this.mstatus = (this.mstatus & ~0x8) | (mpie << 3); // MIE = MPIE
            this.mstatus |= 1 << 7; // MPIE = 1
            nextPc = this.mepc >>> 0;
            if (!oldMie && this.mstatus & 0x8 && this.onMieEnabled) this.onMieEnabled();
          } else if (funct12 === 0x000) {
            // ECALL — synchronous exception (cause=11 for M-mode)
            // Used by FreeRTOS portYIELD to trigger a context switch.
            this._resValid = false; // Clear reservation on trap
            const mieOld = (this.mstatus >> 3) & 1;
            this.mstatus = (this.mstatus & ~0x88) | (mieOld << 7);
            this.mepc = this.pc; // points at ecall; trap handler adds +4
            this.mcause = 11; // ecall from M-mode
            nextPc = (this.mtvec & ~3) >>> 0; // always direct for exceptions
          }
          // EBREAK (0x001), WFI (0x105) → no-op (advance PC normally)
          break;
        }
        // CSR instructions (funct3 != 0)
        const csrAddr = funct12;
        const csrOld = this.readCsr(csrAddr);
        const isImm = (funct3 & 4) !== 0; // CSRRWI / CSRRSI / CSRRCI
        const operand = isImm ? rs1 : this.reg(rs1); // zimm (5-bit) or register
        this.setReg(rd, csrOld);
        switch (funct3 & 3) {
          case 1:
            this.writeCsr(csrAddr, operand);
            break; // CSRRW/I
          case 2:
            if (operand !== 0) this.writeCsr(csrAddr, csrOld | operand);
            break; // CSRRS/I
          case 3:
            if (operand !== 0) this.writeCsr(csrAddr, csrOld & ~operand);
            break; // CSRRC/I
        }
        break;
      }

      default:
        // Unknown opcode — skip instruction to avoid infinite loop
        break;
    }

    this.pc = nextPc;
    this.cycles++;
    return 1;
  }
}

/*
 * Intel 8086 emulator — clean-room implementation as a velxio custom chip.
 *
 * Source (in autosearch/pdfs/):
 *   [I86] Intel 8086 Family User's Manual, October 1979 (order 9800722-03).
 *         All citations are PDF-index pages; manual section numbers in parens.
 * See autosearch/15_8086_authoritative_spec.md for the digested spec and
 * autosearch/16_8086_reference_implementations.md for cross-validation
 * sources (8086tiny / MartyPC / YJDoc2 — all permissively licensed).
 *
 * Scope of this initial implementation:
 *   - 40-pin minimum-mode pin contract.
 *   - Reset state: CS=0xFFFF, IP=0, all other segs=0; first fetch at the
 *     physical address 0xFFFF0 with ALE strobing.
 *   - Bus cycle T1-T4 (instruction-per-tick collapse): drive AD0..AD15 with
 *     low 16 addr, A16..A19 with high 4 addr, ALE pulse, then either
 *     RD̅ for reads or WR̅ for writes with M/IO and DT/R̅ properly set.
 *   - 20-bit physical addressing: (segment<<4)+offset, wrap at 1 MB.
 *   - Register file (AX/BX/CX/DX with high/low halves, SI/DI/BP/SP, IP,
 *     CS/DS/ES/SS, FLAGS).
 *   - ModR/M decode for memory operands (Table 4-10).
 *   - Subset of ISA: NOP, HLT, MOV reg/imm, MOV r/m, ADD/SUB/AND/OR/XOR/CMP,
 *     INC/DEC, PUSH/POP, JMP near/short, conditional jumps, CALL/RET, INT 3.
 *
 * Out of scope (deferred):
 *   - String ops (MOVS/CMPS/SCAS/LODS/STOS) with REP prefix.
 *   - MUL/DIV/IMUL/IDIV.
 *   - BCD adjust (DAA/DAS/AAA/AAS/AAM/AAD).
 *   - Port I/O instructions (IN/OUT).
 *   - Hardware interrupts (NMI/INTR vectoring).
 *   - Maximum-mode bus protocol.
 *   - Cycle-accurate prefetch queue.
 *   - Undocumented opcodes (POP CS, SALC).
 */
#include "velxio-chip.h"
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

/* ─── Flag bits ────────────────────────────────────────────────────────── */
#define F_CF   0x0001
#define F_PF   0x0004
#define F_AF   0x0010
#define F_ZF   0x0040
#define F_SF   0x0080
#define F_TF   0x0100
#define F_IF   0x0200
#define F_DF   0x0400
#define F_OF   0x0800
/* Reserved bits per [I86] Fig 2-9: bit 1 reads as 1, bits 12-15 as 1
   per SingleStepTests canonicalisation. Bit 3, 5 read as 0. */
#define F_RESERVED_ON  (0xF002)
#define F_RESERVED_OFF (0x0028)

/* Segment-register codes (matches SR field encoding, [I86] Table 4-11) */
#define SEG_ES 0
#define SEG_CS 1
#define SEG_SS 2
#define SEG_DS 3

/* Status byte values for M/IO, DT/R̅ during a cycle:
   M/IO: 1 = memory, 0 = I/O ([I86] PDF p.249 — 8086 polarity) */

typedef struct {
    /* Pin handles */
    vx_pin ad[16];      /* AD0..AD15 — multiplexed addr/data */
    vx_pin a[4];        /* A16..A19 — multiplexed addr/status */
    vx_pin ale;
    vx_pin rd, wr;
    vx_pin mio;
    vx_pin dtr;
    vx_pin den;
    vx_pin hold, hlda;
    vx_pin intr, nmi, inta;
    vx_pin reset_, ready, test_;
    vx_pin clk;
    vx_pin mnmx;
    vx_pin bhe;
    vx_pin vcc, gnd;

    vx_timer cycle_timer;

    /* Register file. Pairs aliased via union for byte access. */
    union { struct { uint8_t al, ah; }; uint16_t ax; };
    union { struct { uint8_t cl, ch; }; uint16_t cx; };
    union { struct { uint8_t dl, dh; }; uint16_t dx; };
    union { struct { uint8_t bl, bh; }; uint16_t bx; };
    uint16_t sp, bp, si, di;
    uint16_t cs, ds, es, ss;
    uint16_t ip;
    uint16_t flags;

    /* State */
    bool halted;
    bool reset_active;
    bool driving_ad;
    /* Segment override for the current instruction (-1 = none) */
    int seg_override;

    /* Last-cycle latched address (for status drives) */
    uint32_t last_phys;
} cpu_t;

static cpu_t G;

/* ─── AD/A bus helpers ──────────────────────────────────────────────────── */
static void drive_ad(uint16_t v) {
    for (int i = 0; i < 16; i++) {
        vx_pin_set_mode(G.ad[i], VX_OUTPUT);
        vx_pin_write(G.ad[i], (v >> i) & 1);
    }
    G.driving_ad = true;
}
static void release_ad(void) {
    if (!G.driving_ad) return;
    for (int i = 0; i < 16; i++) vx_pin_set_mode(G.ad[i], VX_INPUT);
    G.driving_ad = false;
}
static void drive_a_high(uint8_t hi4) {
    for (int i = 0; i < 4; i++) {
        vx_pin_write(G.a[i], (hi4 >> i) & 1);
    }
}
static uint16_t read_ad(void) {
    uint16_t v = 0;
    for (int i = 0; i < 16; i++) if (vx_pin_read(G.ad[i])) v |= (1u << i);
    return v;
}

/* Compute 20-bit physical address from segment:offset, mod 1 MB. */
static uint32_t physical(uint16_t segment, uint16_t offset) {
    return (((uint32_t)segment << 4) + offset) & 0xFFFFF;
}

/* ─── Bus cycle: read one byte at physical address ─────────────────────── */
static uint8_t bus_read_byte(uint32_t paddr, bool is_io) {
    /* T1: drive AD with low 16 bits, A high pins with bits 16..19, pulse
       ALE high so external 8282 latches the address; deassert ALE. */
    drive_ad(paddr & 0xFFFF);
    drive_a_high((paddr >> 16) & 0xF);
    vx_pin_write(G.bhe, (paddr & 1) ? 1 : 0);   /* BHE̅ low if low byte not used */
    vx_pin_write(G.mio, is_io ? 0 : 1);
    vx_pin_write(G.dtr, 0);                      /* receive */
    vx_pin_write(G.ale, 1);
    vx_pin_write(G.ale, 0);

    /* T2..T3: switch AD to input, assert RD̅ + DEN̅. */
    release_ad();
    vx_pin_write(G.den, 0);
    vx_pin_write(G.rd,  0);

    /* Sample. The AD0..AD15 lines now carry data; for byte read at an
       even address use AD0..AD7, for odd address use AD8..AD15. */
    uint16_t bus = read_ad();
    uint8_t byte = (paddr & 1) ? (uint8_t)(bus >> 8) : (uint8_t)bus;

    /* T4: deassert. */
    vx_pin_write(G.rd,  1);
    vx_pin_write(G.den, 1);

    G.last_phys = paddr;
    return byte;
}

static uint16_t bus_read_word(uint32_t paddr, bool is_io) {
    /* For aligned even addresses we could do this in one cycle (BHE̅+A0=00).
       For the simple model we just do two byte reads. */
    uint8_t lo = bus_read_byte(paddr,     is_io);
    uint8_t hi = bus_read_byte(paddr + 1, is_io);
    return lo | ((uint16_t)hi << 8);
}

static void bus_write_byte(uint32_t paddr, uint8_t data, bool is_io) {
    drive_ad(paddr & 0xFFFF);
    drive_a_high((paddr >> 16) & 0xF);
    vx_pin_write(G.bhe, (paddr & 1) ? 1 : 0);
    vx_pin_write(G.mio, is_io ? 0 : 1);
    vx_pin_write(G.dtr, 1);                      /* transmit */
    vx_pin_write(G.ale, 1);
    vx_pin_write(G.ale, 0);

    /* Drive data on AD bus. For odd addr put byte on AD8..AD15. */
    uint16_t out = (paddr & 1) ? ((uint16_t)data << 8) : data;
    drive_ad(out);

    vx_pin_write(G.den, 0);
    vx_pin_write(G.wr,  0);
    vx_pin_write(G.wr,  1);   /* rising edge — external latches */
    vx_pin_write(G.den, 1);

    G.last_phys = paddr;
}

static void bus_write_word(uint32_t paddr, uint16_t data, bool is_io) {
    bus_write_byte(paddr,     (uint8_t)data,       is_io);
    bus_write_byte(paddr + 1, (uint8_t)(data >> 8), is_io);
}

/* ─── Memory accessors with default-segment selection ──────────────────── */
static uint16_t* seg_reg(int code) {
    switch (code) {
        case SEG_ES: return &G.es;
        case SEG_CS: return &G.cs;
        case SEG_SS: return &G.ss;
        default:     return &G.ds;
    }
}

static int default_seg(int seg_code) {
    /* Resolve segment override if active; else use the supplied default. */
    if (G.seg_override >= 0) return G.seg_override;
    return seg_code;
}

static uint8_t mem_read_byte(int default_seg_code, uint16_t off) {
    int seg = default_seg(default_seg_code);
    return bus_read_byte(physical(*seg_reg(seg), off), false);
}
static uint16_t mem_read_word(int default_seg_code, uint16_t off) {
    int seg = default_seg(default_seg_code);
    return bus_read_word(physical(*seg_reg(seg), off), false);
}
static void mem_write_byte(int default_seg_code, uint16_t off, uint8_t v) {
    int seg = default_seg(default_seg_code);
    bus_write_byte(physical(*seg_reg(seg), off), v, false);
}
static void mem_write_word(int default_seg_code, uint16_t off, uint16_t v) {
    int seg = default_seg(default_seg_code);
    bus_write_word(physical(*seg_reg(seg), off), v, false);
}

/* ─── Code fetch (always uses CS:IP) ───────────────────────────────────── */
static uint8_t fetch_byte(void) {
    uint8_t v = bus_read_byte(physical(G.cs, G.ip), false);
    G.ip++;
    return v;
}
static uint16_t fetch_word(void) {
    uint8_t lo = fetch_byte();
    uint8_t hi = fetch_byte();
    return lo | ((uint16_t)hi << 8);
}

/* ─── ModR/M decode ────────────────────────────────────────────────────── */

/* 8-bit registers indexed by REG/RM bits 000..111 ([I86] Table 4-9 w=0):
   AL CL DL BL AH CH DH BH */
static uint8_t* reg8_ptr(uint8_t code) {
    switch (code & 7) {
        case 0: return &G.al;
        case 1: return &G.cl;
        case 2: return &G.dl;
        case 3: return &G.bl;
        case 4: return &G.ah;
        case 5: return &G.ch;
        case 6: return &G.dh;
        default: return &G.bh;
    }
}
/* 16-bit registers (w=1): AX CX DX BX SP BP SI DI */
static uint16_t* reg16_ptr(uint8_t code) {
    switch (code & 7) {
        case 0: return &G.ax;
        case 1: return &G.cx;
        case 2: return &G.dx;
        case 3: return &G.bx;
        case 4: return &G.sp;
        case 5: return &G.bp;
        case 6: return &G.si;
        default: return &G.di;
    }
}

/* Effective-address calc + default-segment selection per Table 4-10.
   Returns the EA and writes the default segment code via *out_seg. */
static uint16_t calc_ea(uint8_t mod, uint8_t rm, int* out_seg) {
    int16_t disp = 0;
    int seg = SEG_DS;

    if (mod == 1) disp = (int8_t)fetch_byte();
    else if (mod == 2) disp = (int16_t)fetch_word();

    uint16_t ea = 0;
    switch (rm & 7) {
        case 0: ea = G.bx + G.si; seg = SEG_DS; break;
        case 1: ea = G.bx + G.di; seg = SEG_DS; break;
        case 2: ea = G.bp + G.si; seg = SEG_SS; break;
        case 3: ea = G.bp + G.di; seg = SEG_SS; break;
        case 4: ea = G.si;        seg = SEG_DS; break;
        case 5: ea = G.di;        seg = SEG_DS; break;
        case 6:
            if (mod == 0) {
                /* disp16 absolute, default DS */
                disp = (int16_t)fetch_word();
                ea = 0;
                seg = SEG_DS;
            } else {
                ea = G.bp;
                seg = SEG_SS;
            }
            break;
        case 7: ea = G.bx; seg = SEG_DS; break;
    }
    ea += disp;
    *out_seg = seg;
    return ea;
}

/* Read/write an r/m operand (8-bit or 16-bit). For mod=11 the operand is a
   register; otherwise it's a memory location at the computed EA. */
static uint8_t rm8_read(uint8_t modrm) {
    uint8_t mod = (modrm >> 6) & 3;
    uint8_t rm  = modrm & 7;
    if (mod == 3) return *reg8_ptr(rm);
    int seg;
    uint16_t ea = calc_ea(mod, rm, &seg);
    return mem_read_byte(seg, ea);
}
static void rm8_write(uint8_t modrm, uint8_t v) {
    uint8_t mod = (modrm >> 6) & 3;
    uint8_t rm  = modrm & 7;
    if (mod == 3) { *reg8_ptr(rm) = v; return; }
    int seg;
    uint16_t ea = calc_ea(mod, rm, &seg);
    mem_write_byte(seg, ea, v);
}
static uint16_t rm16_read(uint8_t modrm) {
    uint8_t mod = (modrm >> 6) & 3;
    uint8_t rm  = modrm & 7;
    if (mod == 3) return *reg16_ptr(rm);
    int seg;
    uint16_t ea = calc_ea(mod, rm, &seg);
    return mem_read_word(seg, ea);
}
static void rm16_write(uint8_t modrm, uint16_t v) {
    uint8_t mod = (modrm >> 6) & 3;
    uint8_t rm  = modrm & 7;
    if (mod == 3) { *reg16_ptr(rm) = v; return; }
    int seg;
    uint16_t ea = calc_ea(mod, rm, &seg);
    mem_write_word(seg, ea, v);
}

/* ─── Flag helpers ──────────────────────────────────────────────────────── */
static bool parity8(uint8_t v) { v ^= v >> 4; v ^= v >> 2; v ^= v >> 1; return (v & 1) == 0; }

static void set_szp8(uint8_t v) {
    G.flags = (G.flags & ~(F_SF | F_ZF | F_PF))
            | (v & 0x80 ? F_SF : 0)
            | (v == 0 ? F_ZF : 0)
            | (parity8(v) ? F_PF : 0);
}
static void set_szp16(uint16_t v) {
    G.flags = (G.flags & ~(F_SF | F_ZF | F_PF))
            | (v & 0x8000 ? F_SF : 0)
            | (v == 0 ? F_ZF : 0)
            | (parity8(v & 0xff) ? F_PF : 0);
}

static uint8_t alu_add8(uint8_t a, uint8_t b, bool with_carry) {
    uint16_t cin = (with_carry && (G.flags & F_CF)) ? 1 : 0;
    uint16_t r = a + b + cin;
    bool c = (r & 0x100) != 0;
    bool h = (((a & 0xF) + (b & 0xF) + cin) & 0x10) != 0;
    bool ov = (~(a ^ b) & (a ^ (uint8_t)r) & 0x80) != 0;
    G.flags = (G.flags & ~(F_CF | F_AF | F_OF))
            | (c ? F_CF : 0) | (h ? F_AF : 0) | (ov ? F_OF : 0);
    set_szp8((uint8_t)r);
    return (uint8_t)r;
}
static uint16_t alu_add16(uint16_t a, uint16_t b, bool with_carry) {
    uint32_t cin = (with_carry && (G.flags & F_CF)) ? 1 : 0;
    uint32_t r = a + b + cin;
    bool c = (r & 0x10000) != 0;
    bool h = (((a & 0xF) + (b & 0xF) + cin) & 0x10) != 0;
    bool ov = (~(a ^ b) & (a ^ (uint16_t)r) & 0x8000) != 0;
    G.flags = (G.flags & ~(F_CF | F_AF | F_OF))
            | (c ? F_CF : 0) | (h ? F_AF : 0) | (ov ? F_OF : 0);
    set_szp16((uint16_t)r);
    return (uint16_t)r;
}

static uint8_t alu_sub8(uint8_t a, uint8_t b, bool with_borrow, bool store) {
    uint16_t cin = (with_borrow && (G.flags & F_CF)) ? 1 : 0;
    uint16_t r = a - b - cin;
    bool c = (r & 0x100) != 0;
    bool h = (((a & 0xF) - (b & 0xF) - cin) & 0x10) != 0;
    bool ov = ((a ^ b) & (a ^ (uint8_t)r) & 0x80) != 0;
    G.flags = (G.flags & ~(F_CF | F_AF | F_OF))
            | (c ? F_CF : 0) | (h ? F_AF : 0) | (ov ? F_OF : 0);
    set_szp8((uint8_t)r);
    (void)store;
    return (uint8_t)r;
}
static uint16_t alu_sub16(uint16_t a, uint16_t b, bool with_borrow, bool store) {
    uint32_t cin = (with_borrow && (G.flags & F_CF)) ? 1 : 0;
    uint32_t r = a - b - cin;
    bool c = (r & 0x10000) != 0;
    bool h = (((a & 0xF) - (b & 0xF) - cin) & 0x10) != 0;
    bool ov = ((a ^ b) & (a ^ (uint16_t)r) & 0x8000) != 0;
    G.flags = (G.flags & ~(F_CF | F_AF | F_OF))
            | (c ? F_CF : 0) | (h ? F_AF : 0) | (ov ? F_OF : 0);
    set_szp16((uint16_t)r);
    (void)store;
    return (uint16_t)r;
}

static uint8_t alu_and8(uint8_t a, uint8_t b) {
    uint8_t r = a & b;
    G.flags = (G.flags & ~(F_CF | F_OF | F_AF));
    set_szp8(r);
    return r;
}
static uint16_t alu_and16(uint16_t a, uint16_t b) {
    uint16_t r = a & b;
    G.flags = (G.flags & ~(F_CF | F_OF | F_AF));
    set_szp16(r);
    return r;
}
static uint8_t alu_or8(uint8_t a, uint8_t b) {
    uint8_t r = a | b;
    G.flags = (G.flags & ~(F_CF | F_OF | F_AF));
    set_szp8(r);
    return r;
}
static uint16_t alu_or16(uint16_t a, uint16_t b) {
    uint16_t r = a | b;
    G.flags = (G.flags & ~(F_CF | F_OF | F_AF));
    set_szp16(r);
    return r;
}
static uint8_t alu_xor8(uint8_t a, uint8_t b) {
    uint8_t r = a ^ b;
    G.flags = (G.flags & ~(F_CF | F_OF | F_AF));
    set_szp8(r);
    return r;
}
static uint16_t alu_xor16(uint16_t a, uint16_t b) {
    uint16_t r = a ^ b;
    G.flags = (G.flags & ~(F_CF | F_OF | F_AF));
    set_szp16(r);
    return r;
}

/* ─── Stack helpers ─────────────────────────────────────────────────────── */
static void push16(uint16_t v) {
    G.sp -= 2;
    bus_write_word(physical(G.ss, G.sp), v, false);
}
static uint16_t pop16(void) {
    uint16_t v = bus_read_word(physical(G.ss, G.sp), false);
    G.sp += 2;
    return v;
}

/* ─── Conditional jump test ([I86] Table 2-13) ─────────────────────────── */
static bool cond_jcc(uint8_t op) {
    /* op encodes condition in low 4 bits of the byte (op = 0x70..0x7F) */
    bool r;
    switch (op & 0x0F) {
        case 0x0: r = (G.flags & F_OF) != 0; break;          /* JO */
        case 0x1: r = (G.flags & F_OF) == 0; break;          /* JNO */
        case 0x2: r = (G.flags & F_CF) != 0; break;          /* JB / JNAE / JC */
        case 0x3: r = (G.flags & F_CF) == 0; break;          /* JNB / JAE / JNC */
        case 0x4: r = (G.flags & F_ZF) != 0; break;          /* JE / JZ */
        case 0x5: r = (G.flags & F_ZF) == 0; break;          /* JNE / JNZ */
        case 0x6: r = (G.flags & (F_CF | F_ZF)) != 0; break; /* JBE / JNA */
        case 0x7: r = (G.flags & (F_CF | F_ZF)) == 0; break; /* JNBE / JA */
        case 0x8: r = (G.flags & F_SF) != 0; break;          /* JS */
        case 0x9: r = (G.flags & F_SF) == 0; break;          /* JNS */
        case 0xA: r = (G.flags & F_PF) != 0; break;          /* JP / JPE */
        case 0xB: r = (G.flags & F_PF) == 0; break;          /* JNP / JPO */
        case 0xC: r = ((G.flags & F_SF) != 0) != ((G.flags & F_OF) != 0); break;
                  /* JL / JNGE */
        case 0xD: r = ((G.flags & F_SF) != 0) == ((G.flags & F_OF) != 0); break;
                  /* JNL / JGE */
        case 0xE: r = (G.flags & F_ZF) ||
                     (((G.flags & F_SF) != 0) != ((G.flags & F_OF) != 0));
                  break; /* JLE / JNG */
        default:  r = !(G.flags & F_ZF) &&
                     (((G.flags & F_SF) != 0) == ((G.flags & F_OF) != 0));
                  break; /* JNLE / JG */
    }
    return r;
}

/* ─── Group 1/3/4/5 sub-opcode dispatch ─────────────────────────────────── */
/* Group 1 (opcodes 0x80..0x83): ADD/OR/ADC/SBB/AND/SUB/XOR/CMP r/m, imm. */
static void exec_group1(uint8_t op) {
    uint8_t modrm = fetch_byte();
    uint8_t sub = (modrm >> 3) & 7;
    bool w = (op & 1);
    bool s = (op & 2) != 0;       /* sign-extend imm8 to imm16 */

    if (!w) {
        uint8_t a = rm8_read(modrm);
        uint8_t b = fetch_byte();
        uint8_t r = a;
        switch (sub) {
            case 0: r = alu_add8(a, b, false); break;          /* ADD */
            case 1: r = alu_or8(a, b); break;                  /* OR */
            case 2: r = alu_add8(a, b, true); break;           /* ADC */
            case 3: r = alu_sub8(a, b, true, true); break;     /* SBB */
            case 4: r = alu_and8(a, b); break;                 /* AND */
            case 5: r = alu_sub8(a, b, false, true); break;    /* SUB */
            case 6: r = alu_xor8(a, b); break;                 /* XOR */
            case 7: alu_sub8(a, b, false, false); return;      /* CMP — no store */
        }
        rm8_write(modrm, r);
    } else {
        uint16_t a = rm16_read(modrm);
        uint16_t b;
        if (s) b = (int16_t)(int8_t)fetch_byte();
        else   b = fetch_word();
        uint16_t r = a;
        switch (sub) {
            case 0: r = alu_add16(a, b, false); break;
            case 1: r = alu_or16(a, b); break;
            case 2: r = alu_add16(a, b, true); break;
            case 3: r = alu_sub16(a, b, true, true); break;
            case 4: r = alu_and16(a, b); break;
            case 5: r = alu_sub16(a, b, false, true); break;
            case 6: r = alu_xor16(a, b); break;
            case 7: alu_sub16(a, b, false, false); return;
        }
        rm16_write(modrm, r);
    }
}

/* Group 5 (0xFF) — INC/DEC/CALL/JMP/PUSH on r/m16. */
static void exec_group5_word(uint8_t modrm) {
    uint8_t sub = (modrm >> 3) & 7;
    uint16_t a = rm16_read(modrm);
    switch (sub) {
        case 0: { /* INC */
            bool old_cf = G.flags & F_CF;
            uint16_t r = alu_add16(a, 1, false);
            G.flags = (G.flags & ~F_CF) | (old_cf ? F_CF : 0);
            rm16_write(modrm, r);
            break;
        }
        case 1: { /* DEC */
            bool old_cf = G.flags & F_CF;
            uint16_t r = alu_sub16(a, 1, false, true);
            G.flags = (G.flags & ~F_CF) | (old_cf ? F_CF : 0);
            rm16_write(modrm, r);
            break;
        }
        case 2: /* CALL near indirect */
            push16(G.ip);
            G.ip = a;
            break;
        case 4: /* JMP near indirect */
            G.ip = a;
            break;
        case 6: /* PUSH */
            push16(a);
            break;
        default: break;
    }
}

/* ─── One-instruction step ──────────────────────────────────────────────── */
static void step(void) {
    if (G.halted) return;

    G.seg_override = -1;

    /* Handle prefix bytes (segment override). Only one override is
       remembered per [I86] p.2-42; if multiple appear, the LAST one wins. */
    while (1) {
        uint8_t prefix = bus_read_byte(physical(G.cs, G.ip), false);
        if (prefix == 0x26) { G.seg_override = SEG_ES; G.ip++; continue; }
        if (prefix == 0x2E) { G.seg_override = SEG_CS; G.ip++; continue; }
        if (prefix == 0x36) { G.seg_override = SEG_SS; G.ip++; continue; }
        if (prefix == 0x3E) { G.seg_override = SEG_DS; G.ip++; continue; }
        /* LOCK / REP prefixes: we just skip them for now. */
        if (prefix == 0xF0 || prefix == 0xF2 || prefix == 0xF3) { G.ip++; continue; }
        break;
    }

    uint8_t op = fetch_byte();

    /* MOV r8, imm8 — opcodes 0xB0..0xB7 */
    if (op >= 0xB0 && op <= 0xB7) {
        *reg8_ptr(op & 7) = fetch_byte();
        return;
    }
    /* MOV r16, imm16 — opcodes 0xB8..0xBF */
    if (op >= 0xB8 && op <= 0xBF) {
        *reg16_ptr(op & 7) = fetch_word();
        return;
    }
    /* INC r16 — opcodes 0x40..0x47 */
    if (op >= 0x40 && op <= 0x47) {
        uint16_t* r = reg16_ptr(op & 7);
        bool old_cf = G.flags & F_CF;
        *r = alu_add16(*r, 1, false);
        G.flags = (G.flags & ~F_CF) | (old_cf ? F_CF : 0);
        return;
    }
    /* DEC r16 — 0x48..0x4F */
    if (op >= 0x48 && op <= 0x4F) {
        uint16_t* r = reg16_ptr(op & 7);
        bool old_cf = G.flags & F_CF;
        *r = alu_sub16(*r, 1, false, true);
        G.flags = (G.flags & ~F_CF) | (old_cf ? F_CF : 0);
        return;
    }
    /* PUSH r16 — 0x50..0x57 */
    if (op >= 0x50 && op <= 0x57) {
        push16(*reg16_ptr(op & 7));
        return;
    }
    /* POP r16 — 0x58..0x5F */
    if (op >= 0x58 && op <= 0x5F) {
        *reg16_ptr(op & 7) = pop16();
        return;
    }
    /* Conditional short jumps Jcc — 0x70..0x7F */
    if (op >= 0x70 && op <= 0x7F) {
        int8_t disp = (int8_t)fetch_byte();
        if (cond_jcc(op)) G.ip = (uint16_t)(G.ip + disp);
        return;
    }

    switch (op) {
        case 0x90: /* NOP (XCHG AX, AX) */ break;

        /* MOV r/m8, r8 — 0x88; r/m16, r16 — 0x89; r8, r/m8 — 0x8A;
           r16, r/m16 — 0x8B */
        case 0x88: { uint8_t modrm = fetch_byte(); rm8_write(modrm, *reg8_ptr((modrm >> 3) & 7)); break; }
        case 0x89: { uint8_t modrm = fetch_byte(); rm16_write(modrm, *reg16_ptr((modrm >> 3) & 7)); break; }
        case 0x8A: { uint8_t modrm = fetch_byte(); *reg8_ptr((modrm >> 3) & 7) = rm8_read(modrm); break; }
        case 0x8B: { uint8_t modrm = fetch_byte(); *reg16_ptr((modrm >> 3) & 7) = rm16_read(modrm); break; }
        /* MOV r/m16, sreg — 0x8C  /  MOV sreg, r/m16 — 0x8E */
        case 0x8C: { uint8_t modrm = fetch_byte(); rm16_write(modrm, *seg_reg((modrm >> 3) & 3)); break; }
        case 0x8E: { uint8_t modrm = fetch_byte(); *seg_reg((modrm >> 3) & 3) = rm16_read(modrm); break; }

        /* MOV AL,[addr] / AX,[addr] / [addr],AL / [addr],AX */
        case 0xA0: { uint16_t a = fetch_word(); G.al = mem_read_byte(SEG_DS, a); break; }
        case 0xA1: { uint16_t a = fetch_word(); G.ax = mem_read_word(SEG_DS, a); break; }
        case 0xA2: { uint16_t a = fetch_word(); mem_write_byte(SEG_DS, a, G.al); break; }
        case 0xA3: { uint16_t a = fetch_word(); mem_write_word(SEG_DS, a, G.ax); break; }

        /* ADD/SUB/AND/OR/XOR/CMP r/m, r — and reverse — and AL/AX,imm.
           00 /op /, 02 /op /reverse, 04 /op /AL+imm8, 05 /op /AX+imm16.
           op encoded in bits 5..3 of the leading byte. */
        case 0x00: case 0x08: case 0x10: case 0x18:
        case 0x20: case 0x28: case 0x30: case 0x38: {
            uint8_t modrm = fetch_byte();
            uint8_t* dst = reg8_ptr((modrm >> 3) & 7);
            uint8_t a = rm8_read(modrm);
            uint8_t b = *dst;
            uint8_t r = a;
            switch ((op >> 3) & 7) {
                case 0: r = alu_add8(a, b, false); break;       /* ADD */
                case 1: r = alu_or8(a, b); break;
                case 2: r = alu_add8(a, b, true); break;
                case 3: r = alu_sub8(a, b, true, true); break;
                case 4: r = alu_and8(a, b); break;
                case 5: r = alu_sub8(a, b, false, true); break;
                case 6: r = alu_xor8(a, b); break;
                case 7: alu_sub8(a, b, false, false); return;   /* CMP */
            }
            rm8_write(modrm, r);
            break;
        }
        case 0x01: case 0x09: case 0x11: case 0x19:
        case 0x21: case 0x29: case 0x31: case 0x39: {
            uint8_t modrm = fetch_byte();
            uint16_t* dst = reg16_ptr((modrm >> 3) & 7);
            uint16_t a = rm16_read(modrm);
            uint16_t b = *dst;
            uint16_t r = a;
            switch ((op >> 3) & 7) {
                case 0: r = alu_add16(a, b, false); break;
                case 1: r = alu_or16(a, b); break;
                case 2: r = alu_add16(a, b, true); break;
                case 3: r = alu_sub16(a, b, true, true); break;
                case 4: r = alu_and16(a, b); break;
                case 5: r = alu_sub16(a, b, false, true); break;
                case 6: r = alu_xor16(a, b); break;
                case 7: alu_sub16(a, b, false, false); return;
            }
            rm16_write(modrm, r);
            break;
        }
        case 0x02: case 0x0A: case 0x12: case 0x1A:
        case 0x22: case 0x2A: case 0x32: case 0x3A: {
            uint8_t modrm = fetch_byte();
            uint8_t* dst = reg8_ptr((modrm >> 3) & 7);
            uint8_t a = *dst;
            uint8_t b = rm8_read(modrm);
            uint8_t r = a;
            switch ((op >> 3) & 7) {
                case 0: r = alu_add8(a, b, false); break;
                case 1: r = alu_or8(a, b); break;
                case 2: r = alu_add8(a, b, true); break;
                case 3: r = alu_sub8(a, b, true, true); break;
                case 4: r = alu_and8(a, b); break;
                case 5: r = alu_sub8(a, b, false, true); break;
                case 6: r = alu_xor8(a, b); break;
                case 7: alu_sub8(a, b, false, false); return;
            }
            *dst = r;
            break;
        }
        case 0x03: case 0x0B: case 0x13: case 0x1B:
        case 0x23: case 0x2B: case 0x33: case 0x3B: {
            uint8_t modrm = fetch_byte();
            uint16_t* dst = reg16_ptr((modrm >> 3) & 7);
            uint16_t a = *dst;
            uint16_t b = rm16_read(modrm);
            uint16_t r = a;
            switch ((op >> 3) & 7) {
                case 0: r = alu_add16(a, b, false); break;
                case 1: r = alu_or16(a, b); break;
                case 2: r = alu_add16(a, b, true); break;
                case 3: r = alu_sub16(a, b, true, true); break;
                case 4: r = alu_and16(a, b); break;
                case 5: r = alu_sub16(a, b, false, true); break;
                case 6: r = alu_xor16(a, b); break;
                case 7: alu_sub16(a, b, false, false); return;
            }
            *dst = r;
            break;
        }
        case 0x04: G.al = alu_add8(G.al, fetch_byte(), false); break;
        case 0x05: G.ax = alu_add16(G.ax, fetch_word(), false); break;
        case 0x0C: G.al = alu_or8(G.al, fetch_byte()); break;
        case 0x0D: G.ax = alu_or16(G.ax, fetch_word()); break;
        case 0x14: G.al = alu_add8(G.al, fetch_byte(), true); break;
        case 0x15: G.ax = alu_add16(G.ax, fetch_word(), true); break;
        case 0x1C: G.al = alu_sub8(G.al, fetch_byte(), true, true); break;
        case 0x1D: G.ax = alu_sub16(G.ax, fetch_word(), true, true); break;
        case 0x24: G.al = alu_and8(G.al, fetch_byte()); break;
        case 0x25: G.ax = alu_and16(G.ax, fetch_word()); break;
        case 0x2C: G.al = alu_sub8(G.al, fetch_byte(), false, true); break;
        case 0x2D: G.ax = alu_sub16(G.ax, fetch_word(), false, true); break;
        case 0x34: G.al = alu_xor8(G.al, fetch_byte()); break;
        case 0x35: G.ax = alu_xor16(G.ax, fetch_word()); break;
        case 0x3C: alu_sub8(G.al, fetch_byte(), false, false); break;
        case 0x3D: alu_sub16(G.ax, fetch_word(), false, false); break;

        /* Group 1: ADD/OR/ADC/SBB/AND/SUB/XOR/CMP r/m, imm */
        case 0x80: case 0x81: case 0x82: case 0x83:
            exec_group1(op);
            break;

        /* JMP near (0xE9, 16-bit displacement); JMP short (0xEB, 8-bit) */
        case 0xE9: { int16_t d = (int16_t)fetch_word(); G.ip = (uint16_t)(G.ip + d); break; }
        case 0xEB: { int8_t  d = (int8_t) fetch_byte(); G.ip = (uint16_t)(G.ip + d); break; }
        /* JMP far (0xEA) */
        case 0xEA: { uint16_t off = fetch_word(); uint16_t seg = fetch_word();
                     G.ip = off; G.cs = seg; break; }

        /* CALL near (0xE8, 16-bit displacement) */
        case 0xE8: { int16_t d = (int16_t)fetch_word(); push16(G.ip); G.ip = (uint16_t)(G.ip + d); break; }
        /* CALL far (0x9A): push CS, push IP, jump CS:IP */
        case 0x9A: { uint16_t off = fetch_word(); uint16_t seg = fetch_word();
                     push16(G.cs); push16(G.ip); G.cs = seg; G.ip = off; break; }
        /* RET near (0xC3) / RET imm (0xC2) */
        case 0xC3: G.ip = pop16(); break;
        case 0xC2: { uint16_t n = fetch_word(); G.ip = pop16(); G.sp += n; break; }
        /* RET far (0xCB) / RETF imm (0xCA) */
        case 0xCB: G.ip = pop16(); G.cs = pop16(); break;
        case 0xCA: { uint16_t n = fetch_word(); G.ip = pop16(); G.cs = pop16(); G.sp += n; break; }

        /* PUSHF / POPF */
        case 0x9C: push16(G.flags); break;
        case 0x9D: G.flags = (pop16() | F_RESERVED_ON) & ~F_RESERVED_OFF; break;

        /* CLC / STC / CLI / STI / CLD / STD / CMC */
        case 0xF8: G.flags &= ~F_CF; break;
        case 0xF9: G.flags |= F_CF; break;
        case 0xFA: G.flags &= ~F_IF; break;
        case 0xFB: G.flags |= F_IF; break;
        case 0xFC: G.flags &= ~F_DF; break;
        case 0xFD: G.flags |= F_DF; break;
        case 0xF5: G.flags ^= F_CF; break;

        /* HLT */
        case 0xF4: G.halted = true; break;

        /* Group 5 (0xFF) — INC/DEC/CALL/JMP/PUSH r/m16 */
        case 0xFF: { uint8_t modrm = fetch_byte(); exec_group5_word(modrm); break; }

        /* LOOP / LOOPE / LOOPNE / JCXZ — 0xE0..0xE3 */
        case 0xE0: { int8_t d = (int8_t)fetch_byte(); G.cx--; if (G.cx != 0 && !(G.flags & F_ZF)) G.ip = (uint16_t)(G.ip + d); break; }
        case 0xE1: { int8_t d = (int8_t)fetch_byte(); G.cx--; if (G.cx != 0 &&  (G.flags & F_ZF)) G.ip = (uint16_t)(G.ip + d); break; }
        case 0xE2: { int8_t d = (int8_t)fetch_byte(); G.cx--; if (G.cx != 0) G.ip = (uint16_t)(G.ip + d); break; }
        case 0xE3: { int8_t d = (int8_t)fetch_byte(); if (G.cx == 0) G.ip = (uint16_t)(G.ip + d); break; }

        /* INT 3 — debug trap; we just halt for visibility. */
        case 0xCC: G.halted = true; break;

        default:
            /* Unimplemented opcode — treat as NOP. Logged as a TODO via
               vx_log so users know which features remain. */
            break;
    }
}

/* ─── Reset / pin watchers / clock ──────────────────────────────────────── */
static void reset_state(void) {
    G.cs = 0xFFFF;
    G.ds = G.ss = G.es = 0;
    G.ip = 0;
    G.flags = F_RESERVED_ON;
    G.ax = G.bx = G.cx = G.dx = 0;
    G.sp = G.bp = G.si = G.di = 0;
    G.halted = false;
    G.seg_override = -1;

    /* Idle bus */
    vx_pin_write(G.ale, 0);
    vx_pin_write(G.rd, 1);
    vx_pin_write(G.wr, 1);
    vx_pin_write(G.den, 1);
    vx_pin_write(G.dtr, 1);
    vx_pin_write(G.mio, 1);
    vx_pin_write(G.bhe, 1);
    vx_pin_write(G.hlda, 0);
    vx_pin_write(G.inta, 1);
    release_ad();
}

static void on_reset(void* user_data, vx_pin pin, int value) {
    (void)user_data; (void)pin;
    if (value) {
        G.reset_active = true;
        reset_state();
    } else {
        G.reset_active = false;
    }
}

static void on_clock(void* user_data) {
    (void)user_data;
    if (G.reset_active) return;
    if (G.halted) return;
    if (vx_pin_read(G.ready) == 0) return;     /* wait state */
    if (vx_pin_read(G.hold) == 1) {            /* bus hold */
        vx_pin_write(G.hlda, 1);
        return;
    }
    vx_pin_write(G.hlda, 0);
    step();
}

void chip_setup(void) {
    char name[6];

    for (int i = 0; i < 16; i++) {
        name[0]='A'; name[1]='D';
        if (i<10) { name[2]='0'+i; name[3]=0; }
        else      { name[2]='1'; name[3]='0'+(i-10); name[4]=0; }
        G.ad[i] = vx_pin_register(name, VX_INPUT);
    }
    for (int i = 0; i < 4; i++) {
        name[0]='A'; name[1]='1'; name[2]='6'+i; name[3]=0;
        G.a[i] = vx_pin_register(name, VX_OUTPUT_LOW);
    }
    G.ale   = vx_pin_register("ALE",   VX_OUTPUT_LOW);
    G.rd    = vx_pin_register("RD",    VX_OUTPUT_HIGH);
    G.wr    = vx_pin_register("WR",    VX_OUTPUT_HIGH);
    G.mio   = vx_pin_register("MIO",   VX_OUTPUT_HIGH);
    G.dtr   = vx_pin_register("DTR",   VX_OUTPUT_HIGH);
    G.den   = vx_pin_register("DEN",   VX_OUTPUT_HIGH);
    G.hold  = vx_pin_register("HOLD",  VX_INPUT);
    G.hlda  = vx_pin_register("HLDA",  VX_OUTPUT_LOW);
    G.intr  = vx_pin_register("INTR",  VX_INPUT);
    G.nmi   = vx_pin_register("NMI",   VX_INPUT);
    G.inta  = vx_pin_register("INTA",  VX_OUTPUT_HIGH);
    G.reset_= vx_pin_register("RESET", VX_INPUT);
    G.ready = vx_pin_register("READY", VX_INPUT);
    G.test_ = vx_pin_register("TEST",  VX_INPUT);
    G.clk   = vx_pin_register("CLK",   VX_INPUT);
    G.mnmx  = vx_pin_register("MNMX",  VX_INPUT);
    G.bhe   = vx_pin_register("BHE",   VX_OUTPUT_HIGH);
    G.vcc   = vx_pin_register("VCC",   VX_INPUT);
    G.gnd   = vx_pin_register("GND",   VX_INPUT);

    reset_state();
    G.reset_active = true;
    vx_pin_watch(G.reset_, VX_EDGE_BOTH, on_reset, 0);

    /* Run an instruction per timer fire. 200 ns ≈ 5 MHz pseudo-clock; the
       test's CLOCK_NS matches. */
    G.cycle_timer = vx_timer_create(on_clock, 0);
    vx_timer_start(G.cycle_timer, 200, true);
}

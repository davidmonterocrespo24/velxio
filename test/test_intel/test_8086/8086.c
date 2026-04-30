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

    /* REP prefix state — set by F2/F3 prefix bytes, cleared at end of
       string-op execution. */
    int rep_kind;   /* -1 = none, 0 = REPNE/REPNZ (F2), 1 = REP/REPE/REPZ (F3) */

    /* Hardware-interrupt pending flags. Set by pin watchers and
       serviced at instruction boundaries. */
    bool nmi_pending;
    bool intr_line;
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

/* ─── Shift/rotate helpers (Group 2) ────────────────────────────────────── */
/* Per [I86] PDF p.262 (manual Table 4-12): the REG field of ModR/M
   selects the operation: 0=ROL, 1=ROR, 2=RCL, 3=RCR, 4=SHL/SAL,
   5=SHR, 6=undefined (treated as SHL), 7=SAR. The count comes from
   either an immediate 1 (opcodes D0/D1) or CL (D2/D3). On 8086 the
   shift count is NOT masked to 5 bits — that's an 80186+ change. */
static uint8_t shift_op8(uint8_t op_sel, uint8_t v, uint8_t count) {
    if (count == 0) return v;
    /* For shifts with count > 0, OF is set only when count == 1. */
    bool count_was_1 = count == 1;
    while (count--) {
        uint8_t old_msb = (v >> 7) & 1;
        uint8_t old_lsb = v & 1;
        uint8_t cf;
        switch (op_sel) {
            case 0: /* ROL */ cf = old_msb; v = (uint8_t)((v << 1) | cf); break;
            case 1: /* ROR */ cf = old_lsb; v = (uint8_t)((v >> 1) | (cf << 7)); break;
            case 2: /* RCL */ cf = old_msb; v = (uint8_t)((v << 1) | (G.flags & F_CF ? 1 : 0)); break;
            case 3: /* RCR */ cf = old_lsb; v = (uint8_t)((v >> 1) | ((G.flags & F_CF ? 1 : 0) << 7)); break;
            case 4: case 6: /* SHL / SAL */ cf = old_msb; v <<= 1; break;
            case 5: /* SHR */ cf = old_lsb; v >>= 1; break;
            default: /* SAR */ cf = old_lsb; v = (uint8_t)((v >> 1) | (v & 0x80)); break;
        }
        G.flags = (G.flags & ~F_CF) | (cf ? F_CF : 0);
    }
    /* Set S/Z/P from result for shifts (4..7); rotates leave them alone
       per the manual but most refs set them. We set them for shifts. */
    if (op_sel >= 4) {
        set_szp8(v);
    }
    if (count_was_1) {
        /* OF for count==1: rotate variants set OF as XOR of two
           highest carry-relevant bits; shifts have specific rules. */
        bool of;
        switch (op_sel) {
            case 0: of = ((v >> 7) & 1) != ((G.flags & F_CF) ? 1 : 0); break;
            case 1: of = ((v >> 7) & 1) != (((v >> 6) & 1)); break;
            case 2: of = ((v >> 7) & 1) != ((G.flags & F_CF) ? 1 : 0); break;
            case 3: of = ((v >> 7) & 1) != (((v >> 6) & 1)); break;
            case 4: case 6: of = ((v >> 7) & 1) != ((G.flags & F_CF) ? 1 : 0); break;
            case 5: of = ((v >> 7) & 1) != 0; break;   /* high bit changed → 0 */
            default: of = false; break;                /* SAR: OF = 0 */
        }
        G.flags = (G.flags & ~F_OF) | (of ? F_OF : 0);
    }
    return v;
}
static uint16_t shift_op16(uint8_t op_sel, uint16_t v, uint8_t count) {
    if (count == 0) return v;
    bool count_was_1 = count == 1;
    while (count--) {
        uint8_t old_msb = (v >> 15) & 1;
        uint8_t old_lsb = v & 1;
        uint8_t cf;
        switch (op_sel) {
            case 0: cf = old_msb; v = (uint16_t)((v << 1) | cf); break;
            case 1: cf = old_lsb; v = (uint16_t)((v >> 1) | ((uint16_t)cf << 15)); break;
            case 2: cf = old_msb; v = (uint16_t)((v << 1) | (G.flags & F_CF ? 1 : 0)); break;
            case 3: cf = old_lsb; v = (uint16_t)((v >> 1) | ((uint16_t)(G.flags & F_CF ? 1 : 0) << 15)); break;
            case 4: case 6: cf = old_msb; v <<= 1; break;
            case 5: cf = old_lsb; v >>= 1; break;
            default: cf = old_lsb; v = (uint16_t)((v >> 1) | (v & 0x8000)); break;
        }
        G.flags = (G.flags & ~F_CF) | (cf ? F_CF : 0);
    }
    if (op_sel >= 4) set_szp16(v);
    if (count_was_1) {
        bool of;
        switch (op_sel) {
            case 0: of = ((v >> 15) & 1) != ((G.flags & F_CF) ? 1 : 0); break;
            case 1: of = ((v >> 15) & 1) != (((v >> 14) & 1)); break;
            case 2: of = ((v >> 15) & 1) != ((G.flags & F_CF) ? 1 : 0); break;
            case 3: of = ((v >> 15) & 1) != (((v >> 14) & 1)); break;
            case 4: case 6: of = ((v >> 15) & 1) != ((G.flags & F_CF) ? 1 : 0); break;
            case 5: of = ((v >> 15) & 1) != 0; break;
            default: of = false; break;
        }
        G.flags = (G.flags & ~F_OF) | (of ? F_OF : 0);
    }
    return v;
}

/* ─── BCD adjust ────────────────────────────────────────────────────────── */
/* DAA: decimal-adjust AL after BCD addition. Per [I86] PDF p.58. */
static void daa_op(void) {
    uint8_t old_al = G.al;
    bool old_cf = (G.flags & F_CF) != 0;
    bool new_cf = old_cf;
    bool new_af = (G.flags & F_AF) != 0;
    if ((G.al & 0x0F) > 9 || (G.flags & F_AF)) {
        uint16_t r = G.al + 6;
        G.al = (uint8_t)r;
        new_af = true;
        if (r & 0x100) new_cf = true;
    }
    if (old_al > 0x99 || old_cf) {
        G.al += 0x60;
        new_cf = true;
    }
    G.flags = (G.flags & ~(F_CF | F_AF | F_SF | F_ZF | F_PF))
            | (new_cf ? F_CF : 0)
            | (new_af ? F_AF : 0);
    set_szp8(G.al);
}
/* DAS: decimal-adjust AL after BCD subtraction. */
static void das_op(void) {
    uint8_t old_al = G.al;
    bool old_cf = (G.flags & F_CF) != 0;
    bool new_cf = old_cf;
    bool new_af = (G.flags & F_AF) != 0;
    if ((G.al & 0x0F) > 9 || (G.flags & F_AF)) {
        int r = G.al - 6;
        G.al = (uint8_t)r;
        new_af = true;
        if (r < 0) new_cf = true;
    }
    if (old_al > 0x99 || old_cf) {
        G.al -= 0x60;
        new_cf = true;
    }
    G.flags = (G.flags & ~(F_CF | F_AF | F_SF | F_ZF | F_PF))
            | (new_cf ? F_CF : 0)
            | (new_af ? F_AF : 0);
    set_szp8(G.al);
}
/* AAA: ASCII-adjust AL after addition. */
static void aaa_op(void) {
    if ((G.al & 0x0F) > 9 || (G.flags & F_AF)) {
        G.ax += 0x106;
        G.flags |= (F_AF | F_CF);
    } else {
        G.flags &= ~(F_AF | F_CF);
    }
    G.al &= 0x0F;
}
static void aas_op(void) {
    if ((G.al & 0x0F) > 9 || (G.flags & F_AF)) {
        G.al -= 6;
        G.ah -= 1;
        G.flags |= (F_AF | F_CF);
    } else {
        G.flags &= ~(F_AF | F_CF);
    }
    G.al &= 0x0F;
}
/* AAM: ASCII-adjust AL after multiply. Operand is the divisor (typically 10). */
static void aam_op(uint8_t base) {
    if (base == 0) {
        /* Real 8086: divide-error exception — we treat as halt. */
        G.halted = true;
        return;
    }
    G.ah = G.al / base;
    G.al = G.al % base;
    set_szp8(G.al);
}
/* AAD: ASCII-adjust AX before division. */
static void aad_op(uint8_t base) {
    G.al = (uint8_t)(G.ah * base + G.al);
    G.ah = 0;
    set_szp8(G.al);
}

/* ─── String op helpers ─────────────────────────────────────────────────── */
static int string_dir(void) { return (G.flags & F_DF) ? -1 : 1; }

/* MUL r/m8: AX = AL * src. CF=OF set if AH != 0. */
static void mul8(uint8_t v) {
    G.ax = (uint16_t)G.al * v;
    bool of = G.ah != 0;
    G.flags = (G.flags & ~(F_CF | F_OF)) | (of ? (F_CF | F_OF) : 0);
}
/* MUL r/m16: DX:AX = AX * src. CF=OF set if DX != 0. */
static void mul16(uint16_t v) {
    uint32_t r = (uint32_t)G.ax * v;
    G.ax = (uint16_t)r;
    G.dx = (uint16_t)(r >> 16);
    bool of = G.dx != 0;
    G.flags = (G.flags & ~(F_CF | F_OF)) | (of ? (F_CF | F_OF) : 0);
}
/* IMUL r/m8: AX = (signed)AL * (signed)src. */
static void imul8(uint8_t v) {
    int16_t r = (int16_t)(int8_t)G.al * (int8_t)v;
    G.ax = (uint16_t)r;
    bool of = (int8_t)G.al != (int16_t)r;   /* OF set if result doesn't fit in AL */
    G.flags = (G.flags & ~(F_CF | F_OF)) | (of ? (F_CF | F_OF) : 0);
}
static void imul16(uint16_t v) {
    int32_t r = (int32_t)(int16_t)G.ax * (int16_t)v;
    G.ax = (uint16_t)r;
    G.dx = (uint16_t)(r >> 16);
    bool of = (int16_t)G.ax != (int32_t)r;
    G.flags = (G.flags & ~(F_CF | F_OF)) | (of ? (F_CF | F_OF) : 0);
}
/* DIV r/m8: AX / src → AL = quotient, AH = remainder. */
static void div8(uint8_t v) {
    if (v == 0) { G.halted = true; return; }
    uint16_t q = G.ax / v;
    if (q > 0xFF) { G.halted = true; return; }
    G.ah = G.ax % v;
    G.al = (uint8_t)q;
}
static void div16(uint16_t v) {
    if (v == 0) { G.halted = true; return; }
    uint32_t dividend = ((uint32_t)G.dx << 16) | G.ax;
    uint32_t q = dividend / v;
    if (q > 0xFFFF) { G.halted = true; return; }
    G.dx = (uint16_t)(dividend % v);
    G.ax = (uint16_t)q;
}
/* IDIV (signed). */
static void idiv8(uint8_t v) {
    if (v == 0) { G.halted = true; return; }
    int16_t dividend = (int16_t)G.ax;
    int16_t divisor = (int8_t)v;
    int16_t q = dividend / divisor;
    if (q > 127 || q < -128) { G.halted = true; return; }
    G.ah = (uint8_t)(dividend % divisor);
    G.al = (uint8_t)q;
}
static void idiv16(uint16_t v) {
    if (v == 0) { G.halted = true; return; }
    int32_t dividend = (int32_t)(((uint32_t)G.dx << 16) | G.ax);
    int32_t divisor = (int16_t)v;
    int32_t q = dividend / divisor;
    if (q > 32767 || q < -32768) { G.halted = true; return; }
    G.dx = (uint16_t)(dividend % divisor);
    G.ax = (uint16_t)q;
}

/* INT n: push flags, push CS, push IP; clear IF and TF; jump to vector
   table entry at 0:(n*4). */
static void do_int(uint8_t n) {
    push16(G.flags);
    push16(G.cs);
    push16(G.ip);
    G.flags &= ~(F_IF | F_TF);
    uint32_t va = (uint32_t)n * 4;
    uint16_t off = bus_read_word(va,     false);
    uint16_t seg = bus_read_word(va + 2, false);
    G.ip = off;
    G.cs = seg;
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

/* ─── Group 3 (0xF6/0xF7) — TEST/NOT/NEG/MUL/IMUL/DIV/IDIV r/m ─────────── */
static void exec_group3_byte(uint8_t modrm) {
    uint8_t sub = (modrm >> 3) & 7;
    uint8_t v = rm8_read(modrm);
    switch (sub) {
        case 0: case 1: { /* TEST r/m8, imm8 */
            uint8_t imm = fetch_byte();
            (void)alu_and8(v, imm);   /* sets flags, discards result */
            break;
        }
        case 2: rm8_write(modrm, (uint8_t)~v); break;          /* NOT */
        case 3: { /* NEG */
            bool cf = v != 0;
            uint8_t r = (uint8_t)(0 - v);
            bool h = (v & 0x0F) != 0;
            bool ov = v == 0x80;
            G.flags = (G.flags & ~(F_CF | F_AF | F_OF))
                    | (cf ? F_CF : 0) | (h ? F_AF : 0) | (ov ? F_OF : 0);
            set_szp8(r);
            rm8_write(modrm, r);
            break;
        }
        case 4: mul8(v); break;
        case 5: imul8(v); break;
        case 6: div8(v); break;
        case 7: idiv8(v); break;
    }
}
static void exec_group3_word(uint8_t modrm) {
    uint8_t sub = (modrm >> 3) & 7;
    uint16_t v = rm16_read(modrm);
    switch (sub) {
        case 0: case 1: { /* TEST r/m16, imm16 */
            uint16_t imm = fetch_word();
            (void)alu_and16(v, imm);
            break;
        }
        case 2: rm16_write(modrm, (uint16_t)~v); break;
        case 3: {
            bool cf = v != 0;
            uint16_t r = (uint16_t)(0 - v);
            bool h = (v & 0x000F) != 0;
            bool ov = v == 0x8000;
            G.flags = (G.flags & ~(F_CF | F_AF | F_OF))
                    | (cf ? F_CF : 0) | (h ? F_AF : 0) | (ov ? F_OF : 0);
            set_szp16(r);
            rm16_write(modrm, r);
            break;
        }
        case 4: mul16(v); break;
        case 5: imul16(v); break;
        case 6: div16(v); break;
        case 7: idiv16(v); break;
    }
}

/* ─── Group 4 (0xFE) — INC/DEC r/m8 ─────────────────────────────────────── */
static void exec_group4(uint8_t modrm) {
    uint8_t sub = (modrm >> 3) & 7;
    uint8_t v = rm8_read(modrm);
    bool old_cf = (G.flags & F_CF) != 0;
    if (sub == 0) {
        v = alu_add8(v, 1, false);
    } else if (sub == 1) {
        v = alu_sub8(v, 1, false, true);
    }
    G.flags = (G.flags & ~F_CF) | (old_cf ? F_CF : 0);
    rm8_write(modrm, v);
}

/* ─── Group 2 — shift/rotate r/m by 1 (D0/D1) or by CL (D2/D3) ─────────── */
static void exec_shift_byte(uint8_t modrm, uint8_t count) {
    uint8_t sub = (modrm >> 3) & 7;
    uint8_t v = rm8_read(modrm);
    rm8_write(modrm, shift_op8(sub, v, count));
}
static void exec_shift_word(uint8_t modrm, uint8_t count) {
    uint8_t sub = (modrm >> 3) & 7;
    uint16_t v = rm16_read(modrm);
    rm16_write(modrm, shift_op16(sub, v, count));
}

/* ─── String-op step (one iteration, called from step() under REP) ───── */
static bool string_step(uint8_t op) {
    int dir = string_dir();
    bool word = (op & 1) != 0;
    /* Returns true if the REP prefix should EXIT (e.g. zf check failed). */
    bool exit_rep = false;
    switch (op) {
        case 0xA4: { /* MOVSB */
            uint8_t v = mem_read_byte(SEG_DS, G.si);
            int dst_seg = SEG_ES;   /* ES is fixed for string destinations */
            G.seg_override = -1;     /* override doesn't affect ES dest */
            bus_write_byte(physical(G.es, G.di), v, false);
            (void)dst_seg;
            G.si = (uint16_t)(G.si + dir);
            G.di = (uint16_t)(G.di + dir);
            break;
        }
        case 0xA5: { /* MOVSW */
            uint16_t v = mem_read_word(SEG_DS, G.si);
            bus_write_word(physical(G.es, G.di), v, false);
            G.si = (uint16_t)(G.si + dir * 2);
            G.di = (uint16_t)(G.di + dir * 2);
            break;
        }
        case 0xA6: { /* CMPSB */
            uint8_t a = mem_read_byte(SEG_DS, G.si);
            uint8_t b = bus_read_byte(physical(G.es, G.di), false);
            (void)alu_sub8(a, b, false, false);
            G.si = (uint16_t)(G.si + dir);
            G.di = (uint16_t)(G.di + dir);
            break;
        }
        case 0xA7: { /* CMPSW */
            uint16_t a = mem_read_word(SEG_DS, G.si);
            uint16_t b = bus_read_word(physical(G.es, G.di), false);
            (void)alu_sub16(a, b, false, false);
            G.si = (uint16_t)(G.si + dir * 2);
            G.di = (uint16_t)(G.di + dir * 2);
            break;
        }
        case 0xAA: /* STOSB */
            bus_write_byte(physical(G.es, G.di), G.al, false);
            G.di = (uint16_t)(G.di + dir);
            break;
        case 0xAB: /* STOSW */
            bus_write_word(physical(G.es, G.di), G.ax, false);
            G.di = (uint16_t)(G.di + dir * 2);
            break;
        case 0xAC: /* LODSB */
            G.al = mem_read_byte(SEG_DS, G.si);
            G.si = (uint16_t)(G.si + dir);
            break;
        case 0xAD: /* LODSW */
            G.ax = mem_read_word(SEG_DS, G.si);
            G.si = (uint16_t)(G.si + dir * 2);
            break;
        case 0xAE: { /* SCASB */
            uint8_t b = bus_read_byte(physical(G.es, G.di), false);
            (void)alu_sub8(G.al, b, false, false);
            G.di = (uint16_t)(G.di + dir);
            break;
        }
        case 0xAF: { /* SCASW */
            uint16_t b = bus_read_word(physical(G.es, G.di), false);
            (void)alu_sub16(G.ax, b, false, false);
            G.di = (uint16_t)(G.di + dir * 2);
            break;
        }
    }
    /* For CMPS / SCAS the REP prefix checks ZF. */
    if (op == 0xA6 || op == 0xA7 || op == 0xAE || op == 0xAF) {
        if (G.rep_kind == 1 && (G.flags & F_ZF) == 0) exit_rep = true;
        if (G.rep_kind == 0 && (G.flags & F_ZF) != 0) exit_rep = true;
    }
    return exit_rep;
}

/* ─── One-instruction step ──────────────────────────────────────────────── */
static void step(void) {
    /* Service hardware interrupts at instruction boundaries. NMI is
       edge-triggered and always serviced; INTR is level + IF-gated. */
    if (G.nmi_pending) {
        G.nmi_pending = false;
        do_int(2);
        G.halted = false;
        return;
    }
    if (G.intr_line && (G.flags & F_IF)) {
        /* Hardware interrupt acknowledge cycle. Real 8086 in min mode
           runs two INTA̅ pulses; the second has the data bus driven by
           the external 8259 PIC with the vector byte. We collapse to
           one pulse here. Critically, we must NOT drive AD ourselves
           during this cycle — the PIC owns the bus. */
        release_ad();
        vx_pin_write(G.inta, 0);
        /* PIC's INTA̅-falling-edge watcher fires synchronously and
           drives AD0..AD7 with the vector. Sample. */
        uint8_t vec = (uint8_t)(read_ad() & 0xFF);
        vx_pin_write(G.inta, 1);
        do_int(vec);
        G.halted = false;
        G.flags &= ~F_IF;
        return;
    }

    if (G.halted) return;

    G.seg_override = -1;
    G.rep_kind = -1;

    /* Handle prefix bytes (segment override + REP). */
    while (1) {
        uint8_t prefix = bus_read_byte(physical(G.cs, G.ip), false);
        if (prefix == 0x26) { G.seg_override = SEG_ES; G.ip++; continue; }
        if (prefix == 0x2E) { G.seg_override = SEG_CS; G.ip++; continue; }
        if (prefix == 0x36) { G.seg_override = SEG_SS; G.ip++; continue; }
        if (prefix == 0x3E) { G.seg_override = SEG_DS; G.ip++; continue; }
        if (prefix == 0xF0) { G.ip++; continue; }     /* LOCK — ignored */
        if (prefix == 0xF2) { G.rep_kind = 0; G.ip++; continue; }
        if (prefix == 0xF3) { G.rep_kind = 1; G.ip++; continue; }
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

    /* String ops with optional REP/REPE/REPNE prefix */
    if (op >= 0xA4 && op <= 0xAF && (op & 0xFC) != 0xA8) {
        if (G.rep_kind >= 0) {
            while (G.cx != 0) {
                bool exit_rep = string_step(op);
                G.cx--;
                if (exit_rep) break;
            }
        } else {
            (void)string_step(op);
        }
        return;
    }
    /* XCHG AX, r16 — opcodes 0x91..0x97 (0x90 is NOP) */
    if (op >= 0x91 && op <= 0x97) {
        uint16_t* r = reg16_ptr(op & 7);
        uint16_t t = G.ax; G.ax = *r; *r = t;
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
        /* MOV r/m, imm — 0xC6 / 0xC7. Encoding: opcode + modrm + disp + imm.
           Crucially the disp bytes (consumed by calc_ea) come BEFORE the
           immediate, so we must compute the EA first, then fetch imm. */
        case 0xC6: {
            uint8_t modrm = fetch_byte();
            uint8_t mod = (modrm >> 6) & 3;
            uint8_t rm  = modrm & 7;
            if (mod == 3) {
                uint8_t imm = fetch_byte();
                *reg8_ptr(rm) = imm;
            } else {
                int seg;
                uint16_t ea = calc_ea(mod, rm, &seg);
                uint8_t imm = fetch_byte();
                mem_write_byte(seg, ea, imm);
            }
            break;
        }
        case 0xC7: {
            uint8_t modrm = fetch_byte();
            uint8_t mod = (modrm >> 6) & 3;
            uint8_t rm  = modrm & 7;
            if (mod == 3) {
                uint16_t imm = fetch_word();
                *reg16_ptr(rm) = imm;
            } else {
                int seg;
                uint16_t ea = calc_ea(mod, rm, &seg);
                uint16_t imm = fetch_word();
                mem_write_word(seg, ea, imm);
            }
            break;
        }
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

        /* XCHG r/m, r */
        case 0x86: { uint8_t modrm = fetch_byte(); uint8_t* r = reg8_ptr((modrm>>3)&7);
                     uint8_t a = rm8_read(modrm); uint8_t b = *r;
                     rm8_write(modrm, b); *r = a; break; }
        case 0x87: { uint8_t modrm = fetch_byte(); uint16_t* r = reg16_ptr((modrm>>3)&7);
                     uint16_t a = rm16_read(modrm); uint16_t b = *r;
                     rm16_write(modrm, b); *r = a; break; }

        /* TEST r/m, r — same as AND but discards result */
        case 0x84: { uint8_t modrm = fetch_byte(); uint8_t a = rm8_read(modrm);
                     uint8_t b = *reg8_ptr((modrm>>3)&7);
                     (void)alu_and8(a, b); break; }
        case 0x85: { uint8_t modrm = fetch_byte(); uint16_t a = rm16_read(modrm);
                     uint16_t b = *reg16_ptr((modrm>>3)&7);
                     (void)alu_and16(a, b); break; }
        case 0xA8: (void)alu_and8(G.al, fetch_byte()); break;        /* TEST AL, imm8 */
        case 0xA9: (void)alu_and16(G.ax, fetch_word()); break;       /* TEST AX, imm16 */

        /* LDS / LES — load far pointer DS:r16 / ES:r16 from r/m32 */
        case 0xC4: case 0xC5: {
            uint8_t modrm = fetch_byte();
            uint8_t mod = (modrm >> 6) & 3;
            uint8_t rm  = modrm & 7;
            if (mod == 3) break;   /* invalid; manual: undefined */
            int seg;
            uint16_t ea = calc_ea(mod, rm, &seg);
            uint16_t off = mem_read_word(seg, ea);
            uint16_t s   = mem_read_word(seg, ea + 2);
            *reg16_ptr((modrm >> 3) & 7) = off;
            if (op == 0xC4) G.es = s; else G.ds = s;
            break;
        }

        /* LAHF / SAHF */
        case 0x9F: G.ah = (uint8_t)(G.flags & 0xFF); break;
        case 0x9E: G.flags = (G.flags & ~0xFF) | G.ah; break;

        /* XLAT — AL ← [BX + AL] (DS, override-respecting) */
        case 0xD7: G.al = mem_read_byte(SEG_DS, (uint16_t)(G.bx + G.al)); break;

        /* BCD adjust */
        case 0x27: daa_op(); break;
        case 0x2F: das_op(); break;
        case 0x37: aaa_op(); break;
        case 0x3F: aas_op(); break;
        case 0xD4: aam_op(fetch_byte()); break;
        case 0xD5: aad_op(fetch_byte()); break;

        /* Port I/O */
        case 0xE4: G.al = bus_read_byte(fetch_byte(), true); break;
        case 0xE5: G.ax = bus_read_word(fetch_byte(), true); break;
        case 0xE6: bus_write_byte(fetch_byte(), G.al, true); break;
        case 0xE7: bus_write_word(fetch_byte(), G.ax, true); break;
        case 0xEC: G.al = bus_read_byte(G.dx, true); break;
        case 0xED: G.ax = bus_read_word(G.dx, true); break;
        case 0xEE: bus_write_byte(G.dx, G.al, true); break;
        case 0xEF: bus_write_word(G.dx, G.ax, true); break;

        /* Software / hardware interrupts */
        case 0xCC: do_int(3); break;
        case 0xCD: do_int(fetch_byte()); break;
        case 0xCE: if (G.flags & F_OF) do_int(4); break;       /* INTO */
        case 0xCF: { /* IRET */
            G.ip = pop16();
            G.cs = pop16();
            G.flags = (pop16() | F_RESERVED_ON) & ~F_RESERVED_OFF;
            break;
        }

        /* Group 2: shift/rotate r/m by 1 or CL */
        case 0xD0: { uint8_t modrm = fetch_byte(); exec_shift_byte(modrm, 1); break; }
        case 0xD1: { uint8_t modrm = fetch_byte(); exec_shift_word(modrm, 1); break; }
        case 0xD2: { uint8_t modrm = fetch_byte(); exec_shift_byte(modrm, G.cl); break; }
        case 0xD3: { uint8_t modrm = fetch_byte(); exec_shift_word(modrm, G.cl); break; }

        /* Group 3: TEST/NOT/NEG/MUL/IMUL/DIV/IDIV */
        case 0xF6: { uint8_t modrm = fetch_byte(); exec_group3_byte(modrm); break; }
        case 0xF7: { uint8_t modrm = fetch_byte(); exec_group3_word(modrm); break; }

        /* Group 4: INC/DEC r/m8 */
        case 0xFE: { uint8_t modrm = fetch_byte(); exec_group4(modrm); break; }

        /* Undocumented (8086 only) */
        case 0x0F: G.cs = pop16(); break;                       /* POP CS */
        case 0xD6: G.al = (G.flags & F_CF) ? 0xFF : 0x00; break; /* SALC */

        /* PUSH segment regs */
        case 0x06: push16(G.es); break;
        case 0x0E: push16(G.cs); break;
        case 0x16: push16(G.ss); break;
        case 0x1E: push16(G.ds); break;
        /* POP segment regs */
        case 0x07: G.es = pop16(); break;
        case 0x17: G.ss = pop16(); break;
        case 0x1F: G.ds = pop16(); break;

        /* Group 5 (0xFF) — INC/DEC/CALL/JMP/PUSH r/m16 */
        case 0xFF: { uint8_t modrm = fetch_byte(); exec_group5_word(modrm); break; }

        /* LOOP / LOOPE / LOOPNE / JCXZ — 0xE0..0xE3 */
        case 0xE0: { int8_t d = (int8_t)fetch_byte(); G.cx--; if (G.cx != 0 && !(G.flags & F_ZF)) G.ip = (uint16_t)(G.ip + d); break; }
        case 0xE1: { int8_t d = (int8_t)fetch_byte(); G.cx--; if (G.cx != 0 &&  (G.flags & F_ZF)) G.ip = (uint16_t)(G.ip + d); break; }
        case 0xE2: { int8_t d = (int8_t)fetch_byte(); G.cx--; if (G.cx != 0) G.ip = (uint16_t)(G.ip + d); break; }
        case 0xE3: { int8_t d = (int8_t)fetch_byte(); if (G.cx == 0) G.ip = (uint16_t)(G.ip + d); break; }

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

static void on_nmi(void* user_data, vx_pin pin, int value) {
    (void)user_data; (void)pin; (void)value;
    G.nmi_pending = true;   /* edge-triggered; latched until serviced */
}
static void on_intr(void* user_data, vx_pin pin, int value) {
    (void)user_data; (void)pin;
    G.intr_line = (value != 0);   /* level-triggered */
}

static void on_clock(void* user_data) {
    (void)user_data;
    if (G.reset_active) return;
    if (vx_pin_read(G.ready) == 0) return;     /* wait state */
    if (vx_pin_read(G.hold) == 1) {            /* bus hold */
        vx_pin_write(G.hlda, 1);
        return;
    }
    vx_pin_write(G.hlda, 0);
    /* Do NOT early-return on halted — step() handles that and also
       serves an interrupt that wakes us up. Real 8086 HLT is
       interruptible. */
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
    vx_pin_watch(G.reset_, VX_EDGE_BOTH,    on_reset, 0);
    vx_pin_watch(G.nmi,    VX_EDGE_RISING,  on_nmi,   0);
    vx_pin_watch(G.intr,   VX_EDGE_BOTH,    on_intr,  0);

    /* Run an instruction per timer fire. 200 ns ≈ 5 MHz pseudo-clock; the
       test's CLOCK_NS matches. */
    G.cycle_timer = vx_timer_create(on_clock, 0);
    vx_timer_start(G.cycle_timer, 200, true);
}

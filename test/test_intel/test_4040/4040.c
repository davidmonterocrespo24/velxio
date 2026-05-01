/*
 * Intel 4040 emulator — clean-room implementation as a velxio custom chip.
 *
 * Source (in autosearch/pdfs/):
 *   [M40] Intel MCS-40 User's Manual (Nov 1974). Page numbers 1-x are
 *         the printed Ch. 1 footers.
 *   [M4]  Intel MCS-4 User's Manual (Feb 1973) — for the 46 base
 *         opcodes inherited from 4004.
 * See autosearch/13_4040_authoritative_spec.md for citations.
 *
 * The 4040 is a binary-compatible superset of the 4004. The 46 4004
 * opcodes execute identically; 14 new opcodes occupy OPR=0000
 * OPA=0x01..0x0E (NOP=0x00 is preserved).
 *
 * New 4040 instructions (all 1-byte, [M40] p. 1-22):
 *   HLT 0x01 — halt
 *   BBS 0x02 — branch-back from interrupt subroutine (pop PC + clear INTA)
 *   LCR 0x03 — ACC ← Command Register
 *   OR4 0x04 — ACC ← ACC OR R4
 *   OR5 0x05 — ACC ← ACC OR R5
 *   AN6 0x06 — ACC ← ACC AND R6
 *   AN7 0x07 — ACC ← ACC AND R7
 *   DB0 0x08 — designate ROM bank 0 (CMROM0); takes effect 3 cycles later
 *   DB1 0x09 — designate ROM bank 1 (CMROM1)
 *   SB0 0x0A — select index-register bank 0 (R0..R7 = reg[0..7])
 *   SB1 0x0B — select index-register bank 1 (R0..R7 = reg[16..23])
 *   EIN 0x0C — enable interrupt (set IFF)
 *   DIN 0x0D — disable interrupt
 *   RPM 0x0E — read program memory (4289 stub)
 *
 * Index register bank model ([M40] p. 1-11):
 *   Physical reg[0..7]   = bank 0's R0..R7
 *   Physical reg[8..15]  = shared upper R8..R15
 *   Physical reg[16..23] = bank 1's R0..R7
 *   Bank flag selects which physical slice R0..R7 maps to.
 */
#include "velxio-chip.h"
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

typedef enum {
    PHASE_A1 = 0, PHASE_A2, PHASE_A3,
    PHASE_M1, PHASE_M2,
    PHASE_X1, PHASE_X2, PHASE_X3,
} phase_t;

typedef enum {
    FETCH_OPCODE = 0,
    FETCH_OPERAND,
} fetch_t;

/* X2/X3 bus action selected at end of M2 from the decoded opcode.
   Same set as the 4004 (the 4040 inherits MCS-4 I/O semantics). */
typedef enum {
    XACT_NONE = 0,
    XACT_SRC,        /* drive pair_hi at X2, pair_lo at X3, CM-RAM strobe */
    XACT_WRM_WMP,    /* drive ACC at X2, CM-RAM (or CM-ROM for WRR/WPM) */
    XACT_RDM,        /* release D at X2, sample → io_data_in (4002 drives) */
    XACT_RDS,        /* RDR — release D at X2, sample (CM-ROM strobed) */
    XACT_ADM_SBM,    /* like RDM but feeds ADD/SUB */
    XACT_WR_STATUS,  /* WR0..WR3 — drive ACC at X2 */
    XACT_RD_STATUS,  /* RD0..RD3 — release at X2, sample */
} xact_t;

typedef struct {
    /* Pin handles — names from [M40] pp. 1-5/1-6 */
    vx_pin dpin[4];
    vx_pin sync;
    vx_pin reset;
    vx_pin test;
    vx_pin cmrom[2];
    vx_pin cmram[4];
    vx_pin clk1, clk2;
    vx_pin stp, stpa;
    vx_pin intn, inta;
    vx_pin cy_pin;
    vx_pin vdd, vdd1, vdd2, vss;

    vx_timer cycle_timer;

    /* CPU state */
    uint16_t pc;
    uint8_t  acc;
    bool     cy;
    uint8_t  reg[24];     /* bank0:[0..7] shared:[8..15] bank1:[16..23] */
    uint8_t  bank;        /* 0 (SB0) or 1 (SB1) */
    uint16_t stack[7];    /* 7-deep PC stack */
    uint8_t  sp;
    uint8_t  cmram_select;
    uint8_t  rom_bank;    /* 0 or 1 — set by DB0/DB1 */
    bool     iff_enable;
    uint8_t  cmd_reg;     /* command register accessible via LCR */

    /* Bus / fetch state */
    int      phase;
    uint8_t  opcode;
    uint8_t  operand;
    fetch_t  fetch_state;
    bool     reset_active;
    bool     driving_d;
    bool     pc_overridden;

    /* Latched control inputs */
    bool     stp_latched;
    bool     int_latched;
    bool     stop_ff;
    bool     halt_ff;
    bool     inta_ff;

    /* X2/X3 staging — populated at M2 from the decoded opcode. */
    xact_t   xact;
    uint8_t  xact_pair;
    uint8_t  xact_status_idx;
    uint8_t  io_data_in;
} cpu_t;

static cpu_t G;

/* ─── Bank-aware register access ────────────────────────────────────────── */
static uint8_t* regp(uint8_t n) {
    n &= 0xF;
    if (n >= 8) return &G.reg[n];                 /* R8..R15 are shared */
    return G.bank ? &G.reg[n + 16] : &G.reg[n];   /* R0..R7 follow SB0/SB1 */
}

/* Register-pair: Pn = (2n, 2n+1), n=0..7 */
static uint8_t pair_read(uint8_t p) {
    uint8_t hi_idx = (p << 1) & 0xE;
    uint8_t lo_idx = hi_idx + 1;
    return (*regp(hi_idx) << 4) | *regp(lo_idx);
}
static void pair_write(uint8_t p, uint8_t v) {
    uint8_t hi_idx = (p << 1) & 0xE;
    uint8_t lo_idx = hi_idx + 1;
    *regp(hi_idx) = (v >> 4) & 0xF;
    *regp(lo_idx) = v & 0xF;
}

/* ─── D-bus helpers ─────────────────────────────────────────────────────── */
static void drive_d(uint8_t nibble) {
    for (int i = 0; i < 4; i++) {
        vx_pin_set_mode(G.dpin[i], VX_OUTPUT);
        vx_pin_write(G.dpin[i], (nibble >> i) & 1);
    }
    G.driving_d = true;
}
static void release_d(void) {
    if (!G.driving_d) return;
    for (int i = 0; i < 4; i++) vx_pin_set_mode(G.dpin[i], VX_INPUT);
    G.driving_d = false;
}
static uint8_t read_d(void) {
    uint8_t v = 0;
    for (int i = 0; i < 4; i++) if (vx_pin_read(G.dpin[i])) v |= (1u << i);
    return v;
}

static vx_pin active_cmrom(void) { return G.cmrom[G.rom_bank & 1]; }

/* ─── Reset ─────────────────────────────────────────────────────────────── */
static void reset_state(void) {
    G.pc = 0;
    G.acc = 0;
    G.cy = false;
    memset(G.reg, 0, sizeof G.reg);
    memset(G.stack, 0, sizeof G.stack);
    G.sp = 0;
    G.cmram_select = 0;
    G.rom_bank = 0;
    G.bank = 0;
    G.iff_enable = false;
    G.cmd_reg = 0;
    G.phase = 0;
    G.opcode = 0;
    G.operand = 0;
    G.fetch_state = FETCH_OPCODE;
    G.pc_overridden = false;
    G.stp_latched = false;
    G.int_latched = false;
    G.stop_ff = false;
    G.halt_ff = false;
    G.inta_ff = false;
    G.xact = XACT_NONE;
    G.io_data_in = 0;

    vx_pin_write(G.sync, 0);
    vx_pin_write(G.cmrom[0], 0);
    vx_pin_write(G.cmrom[1], 0);
    for (int i = 0; i < 4; i++) vx_pin_write(G.cmram[i], 0);
    vx_pin_write(G.stpa, 0);
    vx_pin_write(G.inta, 0);
    vx_pin_write(G.cy_pin, 0);
    release_d();
}

/* ─── ALU helpers ────────────────────────────────────────────────────────── */
static bool is_two_byte(uint8_t op) {
    uint8_t hi = (op >> 4) & 0xF;
    if (hi == 0x1) return true;
    if (hi == 0x2) return (op & 1) == 0;
    if (hi == 0x4) return true;
    if (hi == 0x5) return true;
    if (hi == 0x7) return true;
    return false;
}

static bool jcn_condition(uint8_t opa) {
    uint8_t c1 = (opa >> 3) & 1;
    uint8_t c2 = (opa >> 2) & 1;
    uint8_t c3 = (opa >> 1) & 1;
    uint8_t c4 = (opa >> 0) & 1;
    int test_pin = vx_pin_read(G.test) ? 1 : 0;
    bool any = (c2 && (G.acc == 0))
            || (c3 && G.cy)
            || (c4 && (test_pin == 0));
    return c1 ? !any : any;
}

/* 7-deep stack ([M40] p. 1-12) — overflow drops oldest. */
static void stack_push(uint16_t value) {
    for (int i = 6; i > 0; i--) G.stack[i] = G.stack[i-1];
    G.stack[0] = value;
    if (G.sp < 7) G.sp++;
}
static uint16_t stack_pop(void) {
    uint16_t v = G.stack[0];
    for (int i = 0; i < 6; i++) G.stack[i] = G.stack[i+1];
    G.stack[6] = 0;
    if (G.sp > 0) G.sp--;
    return v;
}

static void daa(void) {
    if (G.acc > 9 || G.cy) {
        uint8_t r = G.acc + 6;
        if (r > 0xF) G.cy = true;
        G.acc = r & 0xF;
    }
}

static void kbp(void) {
    static const uint8_t kbp_lut[16] = {
        0x0, 0x1, 0x2, 0xF,
        0x3, 0xF, 0xF, 0xF,
        0x4, 0xF, 0xF, 0xF,
        0xF, 0xF, 0xF, 0xF,
    };
    G.acc = kbp_lut[G.acc & 0xF];
}

/* ─── Execute 1-byte instruction ────────────────────────────────────────── */
static void exec_1byte(uint8_t op) {
    uint8_t hi = (op >> 4) & 0xF;
    uint8_t lo = op & 0xF;

    if (hi == 0x0) {
        /* The 4040 places its 14 new instructions here, plus NOP at 0x00. */
        switch (lo) {
            case 0x0: /* NOP */ break;
            case 0x1: /* HLT */
                G.halt_ff = true;
                G.stop_ff = true;
                vx_pin_write(G.stpa, 1);
                break;
            case 0x2: /* BBS — branch back from interrupt subroutine */
                G.pc = stack_pop() & 0xFFF;
                G.inta_ff = false;
                vx_pin_write(G.inta, 0);
                G.pc_overridden = true;
                /* SRC + bank FF restoration happens here on real silicon;
                   we don't fully model the SRC re-emit yet. */
                break;
            case 0x3: /* LCR — ACC ← Command Register */
                G.acc = G.cmd_reg & 0xF;
                break;
            case 0x4: /* OR4 — ACC ← ACC OR R4 */
                G.acc = (G.acc | *regp(4)) & 0xF;
                break;
            case 0x5: /* OR5 */
                G.acc = (G.acc | *regp(5)) & 0xF;
                break;
            case 0x6: /* AN6 — ACC ← ACC AND R6 */
                G.acc = (G.acc & *regp(6)) & 0xF;
                break;
            case 0x7: /* AN7 */
                G.acc = (G.acc & *regp(7)) & 0xF;
                break;
            case 0x8: /* DB0 — designate ROM bank 0 */
                G.rom_bank = 0;
                break;
            case 0x9: /* DB1 — designate ROM bank 1 */
                G.rom_bank = 1;
                break;
            case 0xA: /* SB0 — select index-register bank 0 */
                G.bank = 0;
                break;
            case 0xB: /* SB1 — select index-register bank 1 */
                G.bank = 1;
                break;
            case 0xC: /* EIN — enable interrupt */
                G.iff_enable = true;
                break;
            case 0xD: /* DIN — disable interrupt */
                G.iff_enable = false;
                break;
            case 0xE: /* RPM — read program memory (4289 stub) */
                G.acc = 0;
                break;
            /* 0xF unused */
        }
        return;
    }

    /* The remaining 1-byte opcodes are inherited from the 4004. */
    switch (hi) {
        case 0x2: { /* SRC Pn (odd opcodes only) */
            (void)pair_read(lo >> 1);
            break;
        }
        case 0x3: {
            uint8_t pair_idx = lo >> 1;
            if ((lo & 1) == 0) {
                /* FIN Pn — stub */
                (void)pair_idx;
            } else {
                G.pc = (G.pc & 0xF00) | pair_read(pair_idx);
                G.pc_overridden = true;
            }
            break;
        }
        case 0x6: /* INC Rn */
            *regp(lo) = (*regp(lo) + 1) & 0xF;
            break;
        case 0x8: { /* ADD Rn */
            uint8_t r = G.acc + *regp(lo) + (G.cy ? 1 : 0);
            G.cy = (r > 0xF);
            G.acc = r & 0xF;
            break;
        }
        case 0x9: { /* SUB Rn */
            uint8_t r = G.acc + ((~*regp(lo)) & 0xF) + (G.cy ? 0 : 1);
            G.cy = (r > 0xF);
            G.acc = r & 0xF;
            break;
        }
        case 0xA: G.acc = *regp(lo); break;       /* LD Rn */
        case 0xB: { /* XCH Rn */
            uint8_t t = G.acc;
            G.acc = *regp(lo);
            *regp(lo) = t;
            break;
        }
        case 0xC: /* BBL d */
            G.pc = stack_pop() & 0xFFF;
            G.acc = lo;
            G.pc_overridden = true;
            break;
        case 0xD: G.acc = lo; break;              /* LDM d */
        case 0xE:  /* I/O / RAM group — bus heavy lifting happened during
                      X2/X3; here we only update ACC/flags from io_data_in
                      for read ops. Writes have no further effect on CPU
                      state (output side of the 4002/4001 was driven by
                      the X2 bus action). */
            switch (lo) {
                case 0x8: { /* SBM — A ← A + ~RAM + ~CY */
                    uint8_t r = G.acc + ((~G.io_data_in) & 0xF) + (G.cy ? 0 : 1);
                    G.cy = (r > 0xF);
                    G.acc = r & 0xF;
                    break;
                }
                case 0x9: G.acc = G.io_data_in; break;  /* RDM */
                case 0xA: G.acc = G.io_data_in; break;  /* RDR */
                case 0xB: { /* ADM — A ← A + RAM + CY */
                    uint8_t r = G.acc + G.io_data_in + (G.cy ? 1 : 0);
                    G.cy = (r > 0xF);
                    G.acc = r & 0xF;
                    break;
                }
                case 0xC: case 0xD: case 0xE: case 0xF:  /* RD0..RD3 */
                    G.acc = G.io_data_in;
                    break;
                /* 0,1,2,3,4,5,6,7 = WRM/WMP/WRR/WPM/WR0..3 — bus drives
                   ACC at X2; nothing more for the CPU side. */
                default: break;
            }
            break;
        case 0xF: /* ACC group */
            switch (lo) {
                case 0x0: G.acc = 0; G.cy = false; break;
                case 0x1: G.cy = false; break;
                case 0x2: { uint8_t r = G.acc + 1; G.cy = (r > 0xF); G.acc = r & 0xF; break; }
                case 0x3: G.cy = !G.cy; break;
                case 0x4: G.acc = (~G.acc) & 0xF; break;
                case 0x5: { uint8_t b3 = (G.acc >> 3) & 1;
                            G.acc = ((G.acc << 1) | (G.cy ? 1 : 0)) & 0xF;
                            G.cy = b3 != 0; break; }
                case 0x6: { uint8_t b0 = G.acc & 1;
                            G.acc = ((G.acc >> 1) | ((G.cy ? 1 : 0) << 3)) & 0xF;
                            G.cy = b0 != 0; break; }
                case 0x7: G.acc = G.cy ? 1 : 0; G.cy = false; break;
                case 0x8: { uint8_t r = G.acc + 0xF; G.cy = (r > 0xF); G.acc = r & 0xF; break; }
                case 0x9: G.acc = G.cy ? 0xA : 0x9; G.cy = false; break;
                case 0xA: G.cy = true; break;
                case 0xB: daa(); break;
                case 0xC: kbp(); break;
                case 0xD: G.cmram_select = G.acc & 7; G.cmd_reg = G.acc & 7; break;
            }
            break;
        default: break;
    }
}

/* ─── Execute 2-byte instruction ────────────────────────────────────────── */
static void exec_2byte(uint8_t op, uint8_t operand) {
    uint8_t hi = (op >> 4) & 0xF;
    uint8_t lo = op & 0xF;

    switch (hi) {
        case 0x1:
            if (jcn_condition(lo)) {
                G.pc = (G.pc & 0xF00) | operand;
                G.pc_overridden = true;
            }
            break;
        case 0x2:
            pair_write(lo >> 1, operand);
            break;
        case 0x4:
            G.pc = (((uint16_t)lo) << 8) | operand;
            G.pc_overridden = true;
            break;
        case 0x5:
            stack_push(G.pc & 0xFFF);
            G.pc = (((uint16_t)lo) << 8) | operand;
            G.pc_overridden = true;
            break;
        case 0x7: {
            uint8_t v = (*regp(lo) + 1) & 0xF;
            *regp(lo) = v;
            if (v != 0) {
                G.pc = (G.pc & 0xF00) | operand;
                G.pc_overridden = true;
            }
            break;
        }
        default: break;
    }
}

/* ─── Per-phase action ───────────────────────────────────────────────────── */
static void on_phase(void* user_data) {
    (void)user_data;
    if (G.reset_active) return;

    if (G.phase == PHASE_A1) {
        vx_pin_write(G.cmrom[0], 0);
        vx_pin_write(G.cmrom[1], 0);
        for (int i = 0; i < 4; i++) vx_pin_write(G.cmram[i], 0);
    }

    switch (G.phase) {
        case PHASE_A1:
            drive_d(G.pc & 0xF);
            vx_pin_write(G.sync, 1);
            break;
        case PHASE_A2:
            vx_pin_write(G.sync, 0);
            drive_d((G.pc >> 4) & 0xF);
            break;
        case PHASE_A3:
            drive_d((G.pc >> 8) & 0xF);
            break;
        case PHASE_M1:
            release_d();
            vx_pin_write(active_cmrom(), 1);
            if (G.fetch_state == FETCH_OPCODE) {
                G.opcode = (read_d() & 0xF) << 4;
            } else {
                G.operand = (read_d() & 0xF) << 4;
            }
            break;
        case PHASE_M2:
            if (G.fetch_state == FETCH_OPCODE) {
                G.opcode |= read_d() & 0xF;
            } else {
                G.operand |= read_d() & 0xF;
            }
            G.stp_latched = vx_pin_read(G.stp) ? true : false;
            G.int_latched = (G.iff_enable && !G.stp_latched && !G.inta_ff
                             && vx_pin_read(G.intn)) ? true : false;
            /* Decode opcode → set up X2/X3 bus action (mirrors 4004). */
            G.xact = XACT_NONE;
            if (G.fetch_state == FETCH_OPCODE) {
                uint8_t op = G.opcode;
                if ((op & 0xF1) == 0x21) {
                    G.xact = XACT_SRC;
                    G.xact_pair = (op >> 1) & 7;
                } else if ((op & 0xF0) == 0xE0) {
                    uint8_t lo = op & 0xF;
                    switch (lo) {
                        case 0x0: case 0x1:
                        case 0x2: case 0x3:
                            G.xact = XACT_WRM_WMP; break;
                        case 0x4: case 0x5: case 0x6: case 0x7:
                            G.xact = XACT_WR_STATUS;
                            G.xact_status_idx = lo - 4;
                            break;
                        case 0x8: case 0xB: G.xact = XACT_ADM_SBM; break;
                        case 0x9: G.xact = XACT_RDM; break;
                        case 0xA: G.xact = XACT_RDS; break;
                        case 0xC: case 0xD: case 0xE: case 0xF:
                            G.xact = XACT_RD_STATUS;
                            G.xact_status_idx = lo - 0xC;
                            break;
                    }
                }
            }
            break;
        case PHASE_X1:
            vx_pin_write(G.cy_pin, G.cy ? 1 : 0);
            break;
        case PHASE_X2:
            switch (G.xact) {
                case XACT_SRC:
                    drive_d((pair_read(G.xact_pair) >> 4) & 0xF);
                    vx_pin_write(G.cmram[G.cmram_select & 3], 1);
                    break;
                case XACT_WRM_WMP: {
                    drive_d(G.acc & 0xF);
                    uint8_t lo = G.opcode & 0xF;
                    if (lo == 0x2 || lo == 0x3) {
                        vx_pin_write(active_cmrom(), 1);
                    } else {
                        vx_pin_write(G.cmram[G.cmram_select & 3], 1);
                    }
                    break;
                }
                case XACT_WR_STATUS:
                    drive_d(G.acc & 0xF);
                    vx_pin_write(G.cmram[G.cmram_select & 3], 1);
                    break;
                case XACT_RDM:
                case XACT_ADM_SBM:
                case XACT_RD_STATUS:
                    release_d();
                    vx_pin_write(G.cmram[G.cmram_select & 3], 1);
                    G.io_data_in = read_d() & 0xF;
                    break;
                case XACT_RDS:
                    release_d();
                    vx_pin_write(active_cmrom(), 1);
                    G.io_data_in = read_d() & 0xF;
                    break;
                default:
                    break;
            }
            break;
        case PHASE_X3: {
            switch (G.xact) {
                case XACT_SRC:
                    drive_d(pair_read(G.xact_pair) & 0xF);
                    break;
                case XACT_WRM_WMP:
                case XACT_WR_STATUS:
                    /* drive held from X2 */
                    break;
                case XACT_RDM:
                case XACT_ADM_SBM:
                case XACT_RD_STATUS:
                case XACT_RDS:
                    vx_pin_write(G.cmram[G.cmram_select & 3], 0);
                    vx_pin_write(active_cmrom(), 0);
                    release_d();
                    break;
                default:
                    break;
            }
            G.pc_overridden = false;

            if (G.stp_latched) {
                G.stop_ff = true;
                vx_pin_write(G.stpa, 1);
            } else if (!G.halt_ff) {
                G.stop_ff = false;
                vx_pin_write(G.stpa, 0);
            }

            if (G.int_latched && !G.stop_ff) {
                stack_push(G.pc & 0xFFF);
                G.pc = 0x003;
                G.iff_enable = false;
                G.inta_ff = true;
                vx_pin_write(G.inta, 1);
            } else if (!G.stop_ff && !G.halt_ff) {
                if (G.fetch_state == FETCH_OPCODE) {
                    if (is_two_byte(G.opcode)) {
                        G.pc = (G.pc + 1) & 0xFFF;
                        G.fetch_state = FETCH_OPERAND;
                    } else {
                        exec_1byte(G.opcode);
                        if (!G.pc_overridden) G.pc = (G.pc + 1) & 0xFFF;
                    }
                } else {
                    G.pc = (G.pc + 1) & 0xFFF;
                    exec_2byte(G.opcode, G.operand);
                    G.fetch_state = FETCH_OPCODE;
                }
            }

            G.stp_latched = false;
            G.int_latched = false;
            break;
        }
    }

    G.phase = (G.phase + 1) & 7;
}

/* ─── RESET pin watch ────────────────────────────────────────────────────── */
static void on_reset(void* user_data, vx_pin pin, int value) {
    (void)user_data; (void)pin;
    if (value) {
        G.reset_active = true;
        reset_state();
    } else {
        G.reset_active = false;
    }
}

void chip_setup(void) {
    char name[6];

    for (int i = 0; i < 4; i++) {
        name[0]='D'; name[1]='0'+i; name[2]=0;
        G.dpin[i] = vx_pin_register(name, VX_INPUT);
    }
    G.sync     = vx_pin_register("SYNC",   VX_OUTPUT_LOW);
    G.reset    = vx_pin_register("RESET",  VX_INPUT);
    G.test     = vx_pin_register("TEST",   VX_INPUT);
    G.cmrom[0] = vx_pin_register("CMROM0", VX_OUTPUT_LOW);
    G.cmrom[1] = vx_pin_register("CMROM1", VX_OUTPUT_LOW);
    G.cmram[0] = vx_pin_register("CMRAM0", VX_OUTPUT_LOW);
    G.cmram[1] = vx_pin_register("CMRAM1", VX_OUTPUT_LOW);
    G.cmram[2] = vx_pin_register("CMRAM2", VX_OUTPUT_LOW);
    G.cmram[3] = vx_pin_register("CMRAM3", VX_OUTPUT_LOW);
    G.clk1     = vx_pin_register("CLK1",   VX_INPUT);
    G.clk2     = vx_pin_register("CLK2",   VX_INPUT);
    G.stp      = vx_pin_register("STP",    VX_INPUT);
    G.stpa     = vx_pin_register("STPA",   VX_OUTPUT_LOW);
    G.intn     = vx_pin_register("INT",    VX_INPUT);
    G.inta     = vx_pin_register("INTA",   VX_OUTPUT_LOW);
    G.cy_pin   = vx_pin_register("CY",     VX_OUTPUT_LOW);
    G.vdd      = vx_pin_register("VDD",    VX_INPUT);
    G.vdd1     = vx_pin_register("VDD1",   VX_INPUT);
    G.vdd2     = vx_pin_register("VDD2",   VX_INPUT);
    G.vss      = vx_pin_register("VSS",    VX_INPUT);

    reset_state();
    G.reset_active = false;

    vx_pin_watch(G.reset, VX_EDGE_BOTH, on_reset, 0);

    G.cycle_timer = vx_timer_create(on_phase, 0);
    vx_timer_start(G.cycle_timer, 1351, true);
}

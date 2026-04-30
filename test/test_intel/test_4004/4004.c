/*
 * Intel 4004 emulator — clean-room implementation as a velxio custom chip.
 *
 * Sources (in autosearch/pdfs/):
 *   [M4]  Intel MCS-4 User's Manual (Feb 1973)
 *   [M40] Intel MCS-40 User's Manual (Nov 1974) — Ch. 1 cross-checks 4004.
 * See autosearch/12_4004_authoritative_spec.md for citations.
 *
 * Architecture: 4-bit data bus D0..D3 multiplexed across 8 phases per
 * machine cycle (A1, A2, A3, M1, M2, X1, X2, X3 — [M4] Fig. 2 p. 6).
 * Each timer fire = one phase. PC drives D in A1/A2/A3 (low nibble
 * first); ROM drives opcode on D in M1/M2; CPU executes in X1/X2/X3.
 *
 * ISA: 46 instructions implemented per [M4] Table V pp. 15-16. Two-byte
 * instructions (JCN, FIM, JUN, JMS, ISZ) span two consecutive cycles —
 * cycle N fetches the opcode, cycle N+1 fetches the operand byte using
 * the same bus protocol (PC drives address pointing at the operand,
 * ROM drives the byte at M1/M2).
 *
 * The I/O group (WRM/WMP/WRR/WPM/WR0..3/SBM/RDM/RDR/ADM/RD0..3) is
 * decoded but the actual RAM/ROM-port side-effects are stubs — they
 * require a 4001 ROM and 4002 RAM chip on the canvas, which are not
 * yet implemented. WRR / WMP write a value to no-op storage; reads
 * return 0.
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
    FETCH_OPCODE = 0,   /* this cycle is fetching the first/only byte */
    FETCH_OPERAND,      /* this cycle is fetching the second byte of a 2-byte op */
} fetch_t;

/* X2/X3 bus action selected at end of M2 based on the opcode. */
typedef enum {
    XACT_NONE = 0,
    XACT_SRC,        /* drive pair_hi at X2, pair_lo at X3, CMRAM strobe */
    XACT_WRM_WMP,    /* drive ACC at X2, CMRAM strobe */
    XACT_RDM,        /* release D at X2, sample (4002 drives), use as ACC at X3 */
    XACT_RDS,        /* RDR (read ROM port) — release D at X2, sample */
    XACT_ADM_SBM,    /* like RDM but result fed to ADD/SUB */
    XACT_WR_STATUS,  /* WR0..WR3 (write status char) — drive ACC at X2 */
    XACT_RD_STATUS,  /* RD0..RD3 (read status char) — release at X2 */
} xact_t;

typedef struct {
    /* Pin handles */
    vx_pin dpin[4];
    vx_pin sync, reset, test, cmrom;
    vx_pin cmram[4];
    vx_pin clk1, clk2, vdd, vss;

    vx_timer cycle_timer;

    /* CPU state ([M4] §III) */
    uint16_t pc;
    uint8_t  acc;
    bool     cy;
    uint8_t  reg[16];
    uint16_t stack[3];
    uint8_t  sp;
    uint8_t  cmram_select;     /* 0..3, set by DCL */

    /* Bus-level / fetch state */
    int      phase;
    uint8_t  opcode;
    uint8_t  operand;
    fetch_t  fetch_state;
    bool     reset_active;
    bool     driving_d;
    bool     pc_overridden;

    /* X2/X3 staging — populated at M2 from the decoded opcode. */
    xact_t   xact;
    uint8_t  xact_pair;        /* register pair index for SRC */
    uint8_t  xact_status_idx;  /* 0..3 for WR0..3 / RD0..3 */
    uint8_t  io_data_in;       /* sampled by RDM/RDR/ADM/SBM/RD0..3 at X2 */

    /* Stub registers retained for legacy compat (pre-Phase-D-2 tests) */
    uint8_t  iomem_wmp;
    uint8_t  iomem_wrr;
} cpu_t;

static cpu_t G;

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

/* ─── Reg-pair helpers (Pn = Rn,Rn+1; n=0..7; even reg is high nibble) ─── */
static uint8_t pair_read(uint8_t p) {
    return (G.reg[(p << 1) & 0xE] << 4) | G.reg[((p << 1) & 0xE) + 1];
}
static void pair_write(uint8_t p, uint8_t v) {
    G.reg[(p << 1) & 0xE] = (v >> 4) & 0xF;
    G.reg[((p << 1) & 0xE) + 1] = v & 0xF;
}

/* ─── Reset ─────────────────────────────────────────────────────────────── */
static void reset_state(void) {
    G.pc = 0;
    G.acc = 0;
    G.cy = false;
    memset(G.reg, 0, sizeof G.reg);
    memset(G.stack, 0, sizeof G.stack);
    G.sp = 0;
    G.cmram_select = 0;     /* CMRAM0 selected after RESET ([M4] p. 9) */
    G.phase = 0;
    G.opcode = 0;
    G.operand = 0;
    G.fetch_state = FETCH_OPCODE;
    G.pc_overridden = false;
    G.iomem_wmp = 0;
    G.iomem_wrr = 0;
    G.xact = XACT_NONE;
    G.io_data_in = 0;

    vx_pin_write(G.sync, 0);
    vx_pin_write(G.cmrom, 0);
    for (int i = 0; i < 4; i++) vx_pin_write(G.cmram[i], 0);
    release_d();
}

/* ─── ALU helpers ────────────────────────────────────────────────────────── */

/* Determine whether `op` is a 2-byte instruction per [M4] Table V. */
static bool is_two_byte(uint8_t op) {
    uint8_t hi = (op >> 4) & 0xF;
    if (hi == 0x1) return true;            /* JCN */
    if (hi == 0x2) return (op & 1) == 0;   /* FIM (even) — SRC is odd, 1-byte */
    if (hi == 0x4) return true;            /* JUN */
    if (hi == 0x5) return true;            /* JMS */
    if (hi == 0x7) return true;            /* ISZ */
    return false;
}

/* JCN condition test ([M4] p. 27-28).
   OPA bits: C1 C2 C3 C4 (D3 D2 D1 D0).
     C1=1 → invert sense
     C2=1 → ACC == 0
     C3=1 → CY == 1
     C4=1 → TEST pin == 0 (logic-0 = high voltage)
   "JUMP = C1·((ACC=0)·C2 + (CY=1)·C3 + TEST·C4) + ~C1·~(...)" */
static bool jcn_condition(uint8_t opa) {
    uint8_t c1 = (opa >> 3) & 1;
    uint8_t c2 = (opa >> 2) & 1;
    uint8_t c3 = (opa >> 1) & 1;
    uint8_t c4 = (opa >> 0) & 1;
    int test_pin = vx_pin_read(G.test) ? 1 : 0;
    bool any = (c2 && (G.acc == 0))
            || (c3 && G.cy)
            || (c4 && (test_pin == 0));
    /* C1 inverts: default (C1=0) is "jump if any condition met";
       with C1=1 the sense flips to "jump if NO condition met". */
    return c1 ? !any : any;
}

/* Stack push (3-deep — overflow drops oldest, [M4] p. 13). */
static void stack_push(uint16_t value) {
    G.stack[2] = G.stack[1];
    G.stack[1] = G.stack[0];
    G.stack[0] = value;
    if (G.sp < 3) G.sp++;
}
static uint16_t stack_pop(void) {
    uint16_t v = G.stack[0];
    G.stack[0] = G.stack[1];
    G.stack[1] = G.stack[2];
    G.stack[2] = 0;
    if (G.sp > 0) G.sp--;
    return v;
}

/* DAA ([M4] p. 29; per [M4] Table V row F)
   "If ACC > 9 OR CY = 1, ACC ← ACC + 6. CY is set if a carry out of bit 4
    occurred during the addition; otherwise unchanged." */
static void daa(void) {
    if (G.acc > 9 || G.cy) {
        uint8_t r = G.acc + 6;
        if (r > 0xF) G.cy = true;
        G.acc = r & 0xF;
    }
}

/* KBP — keyboard process: encodes ACC bits to a position number.
   [M4] Table V row F (KBP=FC). Mapping per p. 30:
     0000→0, 0001→1, 0010→2, 0100→3, 1000→4, others→15 (error).      */
static void kbp(void) {
    static const uint8_t kbp_lut[16] = {
        0x0, 0x1, 0x2, 0xF,  /* 0,1,2,err */
        0x3, 0xF, 0xF, 0xF,  /* 3,err,err,err */
        0x4, 0xF, 0xF, 0xF,  /* 4,err,err,err */
        0xF, 0xF, 0xF, 0xF,  /* err×4 */
    };
    G.acc = kbp_lut[G.acc & 0xF];
}

/* ─── Execute 1-byte instruction (opcode is in G.opcode) ────────────────── */
static void exec_1byte(uint8_t op) {
    uint8_t hi = (op >> 4) & 0xF;
    uint8_t lo = op & 0xF;

    switch (hi) {
        case 0x0:  /* NOP */
            break;
        case 0x2: {  /* SRC Pn — odd opcodes only (FIM is even, handled as 2-byte) */
            /* Send register pair to RAM/ROM as address. We're a CPU only;
               the ROM/RAM chips on the bus act on this — for now no
               connected RAM, so this is a no-op beyond setting an
               internal "pending SRC" indicator (not modelled). */
            (void)pair_read(lo >> 1);
            break;
        }
        case 0x3: {
            uint8_t pair_idx = lo >> 1;
            if ((lo & 1) == 0) {
                /* FIN Pn — A ← ROM[(PC[11:8] : P0)]. Without a real
                   ROM chip on the bus we can't fetch the indirect byte;
                   stub as no-op for now. */
                (void)pair_idx;
            } else {
                /* JIN Pn — PC ← (PC[11:8] : Pn) */
                G.pc = (G.pc & 0xF00) | pair_read(pair_idx);
                G.pc_overridden = true;
            }
            break;
        }
        case 0x6:  /* INC Rn */
            G.reg[lo] = (G.reg[lo] + 1) & 0xF;
            break;
        case 0x8: {  /* ADD Rn — A ← A + Rn + CY */
            uint8_t r = G.acc + G.reg[lo] + (G.cy ? 1 : 0);
            G.cy = (r > 0xF);
            G.acc = r & 0xF;
            break;
        }
        case 0x9: {  /* SUB Rn — A ← A + ~Rn + ~CY (i.e. A − Rn − CY-borrow) */
            uint8_t r = G.acc + ((~G.reg[lo]) & 0xF) + (G.cy ? 0 : 1);
            G.cy = (r > 0xF);
            G.acc = r & 0xF;
            break;
        }
        case 0xA:  /* LD Rn — A ← Rn */
            G.acc = G.reg[lo];
            break;
        case 0xB: {  /* XCH Rn — swap A and Rn */
            uint8_t t = G.acc;
            G.acc = G.reg[lo];
            G.reg[lo] = t;
            break;
        }
        case 0xC:  /* BBL d — pop stack into PC; A ← d */
            G.pc = stack_pop() & 0xFFF;
            G.acc = lo;
            G.pc_overridden = true;
            break;
        case 0xD:  /* LDM d — A ← d */
            G.acc = lo;
            break;
        case 0xE:  /* I/O / RAM group ([M4] p. 30 +). The bus heavy lifting
                      already happened in X2/X3; we just consume io_data_in
                      and update ACC/flags here. */
            switch (lo) {
                case 0x0: /* WRM — RAM latched value at X2; nothing more here */
                    G.iomem_wmp = G.acc;   /* legacy stub for old tests */
                    break;
                case 0x1: G.iomem_wmp = G.acc; break;   /* WMP */
                case 0x2: G.iomem_wrr = G.acc; break;   /* WRR */
                case 0x3: break;                         /* WPM — 4289 stub */
                case 0x4: case 0x5: case 0x6: case 0x7:  /* WR0..3 */
                    break;
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
                case 0xC: case 0xD: case 0xE: case 0xF:  /* RD0..3 */
                    G.acc = G.io_data_in;
                    break;
            }
            break;
        case 0xF:  /* ACC group ([M4] p. 29-30) */
            switch (lo) {
                case 0x0: G.acc = 0; G.cy = false; break;       /* CLB */
                case 0x1: G.cy = false; break;                  /* CLC */
                case 0x2: { /* IAC — A++, CY = carry */
                    uint8_t r = G.acc + 1;
                    G.cy = (r > 0xF);
                    G.acc = r & 0xF;
                    break;
                }
                case 0x3: G.cy = !G.cy; break;                  /* CMC */
                case 0x4: G.acc = (~G.acc) & 0xF; break;         /* CMA */
                case 0x5: { /* RAL — rotate A left through CY */
                    uint8_t b3 = (G.acc >> 3) & 1;
                    G.acc = ((G.acc << 1) | (G.cy ? 1 : 0)) & 0xF;
                    G.cy = b3 != 0;
                    break;
                }
                case 0x6: { /* RAR — rotate A right through CY */
                    uint8_t b0 = G.acc & 1;
                    G.acc = ((G.acc >> 1) | ((G.cy ? 1 : 0) << 3)) & 0xF;
                    G.cy = b0 != 0;
                    break;
                }
                case 0x7: G.acc = G.cy ? 1 : 0; G.cy = false; break;  /* TCC */
                case 0x8: { /* DAC — A--, CY = !borrow */
                    /* A + 0xF + 0 (no incoming carry bit involved) */
                    uint8_t r = G.acc + 0xF;
                    G.cy = (r > 0xF);
                    G.acc = r & 0xF;
                    break;
                }
                case 0x9: G.acc = G.cy ? 0xA : 0x9; G.cy = false; break;  /* TCS */
                case 0xA: G.cy = true; break;                             /* STC */
                case 0xB: daa(); break;                                   /* DAA */
                case 0xC: kbp(); break;                                   /* KBP */
                case 0xD: G.cmram_select = G.acc & 7; break;              /* DCL */
                /* 0xE, 0xF unused */
            }
            break;
        default:
            /* All remaining 1-byte slots in the high-nibble range are
               unused on the 4004; treat as NOP. */
            break;
    }
}

/* ─── Execute 2-byte instruction (opcode + operand) ─────────────────────── */
static void exec_2byte(uint8_t op, uint8_t operand) {
    uint8_t hi = (op >> 4) & 0xF;
    uint8_t lo = op & 0xF;

    switch (hi) {
        case 0x1:   /* JCN cccc */
            if (jcn_condition(lo)) {
                /* In-page jump; PC high nibble at the moment of the jump
                   is post-operand-fetch (PC currently at the instr after
                   JCN). [M4] p. 28 page-wrap: jumps from words 254/255
                   land in the next page — modelled correctly because we
                   use the post-increment PC. */
                G.pc = (G.pc & 0xF00) | operand;
                G.pc_overridden = true;
            }
            break;
        case 0x2: {  /* FIM Pn data */
            /* Even opcode: load reg pair Pn (n = (op >> 1) & 7) with
               immediate 8-bit operand. */
            pair_write(lo >> 1, operand);
            break;
        }
        case 0x4: {  /* JUN — 12-bit jump */
            G.pc = (((uint16_t)lo) << 8) | operand;
            G.pc_overridden = true;
            break;
        }
        case 0x5: {  /* JMS — push PC; 12-bit jump */
            stack_push(G.pc & 0xFFF);   /* PC is post-operand (= return addr) */
            G.pc = (((uint16_t)lo) << 8) | operand;
            G.pc_overridden = true;
            break;
        }
        case 0x7: {  /* ISZ Rn — Rn++; if Rn != 0, jump in-page */
            uint8_t v = (G.reg[lo] + 1) & 0xF;
            G.reg[lo] = v;
            if (v != 0) {
                G.pc = (G.pc & 0xF00) | operand;
                G.pc_overridden = true;
            }
            break;
        }
        default:
            /* Unknown 2-byte op; should not happen if is_two_byte() agrees. */
            break;
    }
}

/* ─── Per-phase action ───────────────────────────────────────────────────── */
static void on_phase(void* user_data) {
    (void)user_data;
    if (G.reset_active) return;

    if (G.phase == PHASE_A1) {
        vx_pin_write(G.cmrom, 0);
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
            vx_pin_write(G.cmrom, 1);
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
            /* Decode the now-complete opcode and set up the X2/X3 bus
               action. Only matters during opcode-fetch cycles; the
               2nd byte of a 2-byte instruction never has an I/O xact. */
            G.xact = XACT_NONE;
            if (G.fetch_state == FETCH_OPCODE) {
                uint8_t op = G.opcode;
                /* SRC Pn — opcode 0010_PPP1 (pair index in bits 3..1). */
                if ((op & 0xF1) == 0x21) {
                    G.xact = XACT_SRC;
                    G.xact_pair = (op >> 1) & 7;
                } else if ((op & 0xF0) == 0xE0) {
                    /* I/O group 0xE0..0xEF */
                    uint8_t lo = op & 0xF;
                    switch (lo) {
                        case 0x0:  /* WRM */
                        case 0x1:  /* WMP */
                            G.xact = XACT_WRM_WMP; break;
                        case 0x2:  /* WRR — ROM port write */
                        case 0x3:  /* WPM — 4289 program-memory write */
                            G.xact = XACT_WRM_WMP; break;
                        case 0x4: case 0x5: case 0x6: case 0x7:  /* WR0..WR3 */
                            G.xact = XACT_WR_STATUS;
                            G.xact_status_idx = lo - 4;
                            break;
                        case 0x8:  /* SBM */
                        case 0xB:  /* ADM */
                            G.xact = XACT_ADM_SBM; break;
                        case 0x9:  /* RDM */
                            G.xact = XACT_RDM; break;
                        case 0xA:  /* RDR — ROM port read */
                            G.xact = XACT_RDS; break;
                        case 0xC: case 0xD: case 0xE: case 0xF:  /* RD0..RD3 */
                            G.xact = XACT_RD_STATUS;
                            G.xact_status_idx = lo - 0xC;
                            break;
                    }
                }
            }
            break;
        case PHASE_X1:
            /* idle */
            break;
        case PHASE_X2:
            switch (G.xact) {
                case XACT_SRC:
                    /* Drive HIGH nibble of pair (chip-select | reg).
                       CM-RAM strobe asserted on the line picked by DCL. */
                    drive_d((pair_read(G.xact_pair) >> 4) & 0xF);
                    vx_pin_write(G.cmram[G.cmram_select & 3], 1);
                    break;
                case XACT_WRM_WMP: {
                    /* WRM/WMP/WRR/WPM — drive ACC. Strobe depends on op:
                       WRR (0xE2) and WPM (0xE3) → CM-ROM; rest → CM-RAM. */
                    drive_d(G.acc & 0xF);
                    uint8_t lo = G.opcode & 0xF;
                    if (lo == 0x2 || lo == 0x3) {
                        vx_pin_write(G.cmrom, 1);
                    } else {
                        vx_pin_write(G.cmram[G.cmram_select & 3], 1);
                    }
                    break;
                }
                case XACT_WR_STATUS:
                    /* WR0..3 — drive ACC, CM-RAM strobe. */
                    drive_d(G.acc & 0xF);
                    vx_pin_write(G.cmram[G.cmram_select & 3], 1);
                    break;
                case XACT_RDM:
                case XACT_ADM_SBM:
                case XACT_RD_STATUS:
                    /* Read ops: release D so the 4002 can drive,
                       assert CM-RAM, sample bus into io_data_in. */
                    release_d();
                    vx_pin_write(G.cmram[G.cmram_select & 3], 1);
                    G.io_data_in = read_d() & 0xF;
                    break;
                case XACT_RDS:
                    /* RDR — ROM port read; CM-ROM strobe. */
                    release_d();
                    vx_pin_write(G.cmrom, 1);
                    G.io_data_in = read_d() & 0xF;
                    break;
                default:
                    break;
            }
            break;
        case PHASE_X3:
            /* Finish the X2/X3 bus action. */
            switch (G.xact) {
                case XACT_SRC:
                    /* Low nibble of pair = char address. */
                    drive_d(pair_read(G.xact_pair) & 0xF);
                    /* CMRAM stays asserted through X3, then drops at A1 next. */
                    break;
                case XACT_WRM_WMP:
                case XACT_WR_STATUS:
                    /* Data already driven at X2; just keep CMRAM asserted. */
                    break;
                case XACT_RDM:
                case XACT_ADM_SBM:
                case XACT_RD_STATUS:
                case XACT_RDS:
                    /* Sample already done at X2; deassert CMRAM. */
                    vx_pin_write(G.cmram[G.cmram_select], 0);
                    vx_pin_write(G.cmrom, 0);
                    release_d();
                    break;
                default:
                    break;
            }
            /* End of cycle bookkeeping. */
            G.pc_overridden = false;
            if (G.fetch_state == FETCH_OPCODE) {
                if (is_two_byte(G.opcode)) {
                    /* Cycle 1 of a 2-byte instruction — defer execution.
                       Advance PC to point at operand. */
                    G.pc = (G.pc + 1) & 0xFFF;
                    G.fetch_state = FETCH_OPERAND;
                } else {
                    exec_1byte(G.opcode);
                    if (!G.pc_overridden) G.pc = (G.pc + 1) & 0xFFF;
                }
            } else {
                /* Cycle 2 of a 2-byte instruction. PC currently points
                   at the operand byte; advance past it (to next instr)
                   BEFORE executing — JCN/JUN/JMS/ISZ semantics expect
                   "PC of next instruction" when computing relative or
                   absolute targets ([M4] p. 12 footnote (3)). */
                G.pc = (G.pc + 1) & 0xFFF;
                exec_2byte(G.opcode, G.operand);
                G.fetch_state = FETCH_OPCODE;
            }
            break;
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
    G.cmrom    = vx_pin_register("CMROM",  VX_OUTPUT_LOW);
    G.cmram[0] = vx_pin_register("CMRAM0", VX_OUTPUT_LOW);
    G.cmram[1] = vx_pin_register("CMRAM1", VX_OUTPUT_LOW);
    G.cmram[2] = vx_pin_register("CMRAM2", VX_OUTPUT_LOW);
    G.cmram[3] = vx_pin_register("CMRAM3", VX_OUTPUT_LOW);
    G.clk1     = vx_pin_register("CLK1",   VX_INPUT);
    G.clk2     = vx_pin_register("CLK2",   VX_INPUT);
    G.vdd      = vx_pin_register("VDD",    VX_INPUT);
    G.vss      = vx_pin_register("VSS",    VX_INPUT);

    reset_state();
    G.reset_active = false;

    vx_pin_watch(G.reset, VX_EDGE_BOTH, on_reset, 0);

    G.cycle_timer = vx_timer_create(on_phase, 0);
    vx_timer_start(G.cycle_timer, 1351, true);
}

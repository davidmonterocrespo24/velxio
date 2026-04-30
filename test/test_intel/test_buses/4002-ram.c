/*
 * Intel 4002 RAM — companion data/IO chip for the 4004/4040.
 *
 * 16-pin DIP, 80 nibbles of static RAM (4 registers × 20 chars: 16
 * main + 4 status), plus 4 dedicated output port lines driven by WMP.
 * Like the 4001 ROM, the 4002 uses the multiplexed nibble bus and
 * tracks the 4004's 8-phase frame via SYNC + an internal timer.
 *
 * Source: Intel MCS-4 User's Manual (Feb 1973), §V "4002 Random
 * Access Memory" + Fig. 5-15 pin diagram.
 *
 * Pin contract (we register 14 named pins):
 *   D0..D3    I/O   shared multiplexed bus with the 4004
 *   O0..O3    out   dedicated output port (driven by WMP)
 *   SYNC      in    cycle marker driven by the 4004
 *   CL        in    Φ2 clock — informational
 *   RESET     in    asynchronous reset — clears storage
 *   CM        in    chip-match strobe (one of CM-RAM0..3)
 *   VDD, VSS  power
 *
 * Timing model — like the 4001, this chip is registered BEFORE the
 * 4004 so its on_phase fires first per advanceNanos. Within a cycle
 * the relationship is:
 *
 *   absolute frame  | 4002 phase_count | bus contents when 4002 fires
 *   ----------------|------------------|-----------------------------
 *   A1              | (post-sync 0)    | (4002 fires before sync rise)
 *   A2              | 1                | A1's drive (PC[3:0])
 *   A3              | 2                | A2's drive (PC[7:4])
 *   M1              | 3                | A3's drive WAS PC[11:8]; the
 *                   |                  | 4001 (registered before 4002)
 *                   |                  | has just driven opcode_hi
 *   M2              | 4                | 4001 just drove opcode_lo
 *                   |                  | → full opcode known here
 *   X1              | 5                | (idle)
 *   X2              | 6                | bus is stale; for read ops
 *                   |                  | the 4002 drives D HERE so the
 *                   |                  | 4004 (firing next) samples it
 *   X3              | 7                | bus = 4004's X2 drive — for
 *                   |                  | SRC this is chip-select+reg;
 *                   |                  | for WRM/WMP/WR0..3 it's ACC
 *   A1-of-next      | 8                | bus = 4004's X3 drive — for
 *                   |                  | SRC this is char-addr nibble
 *
 * On the next SYNC edge, phase_count resets to 0 and the cycle repeats.
 * The 4001 ROM uses an analogous one-frame-behind state machine.
 */
#include "velxio-chip.h"
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#ifndef RAM4002_CHIP_PAIR
#define RAM4002_CHIP_PAIR 0   /* bits 3..2 of chip-select address */
#endif

#define MAIN_CHARS_PER_REG 16
#define STATUS_PER_REG     4
#define NUM_REGS           4

typedef struct {
    vx_pin d[4];
    vx_pin o[4];
    vx_pin sync;
    vx_pin cl;
    vx_pin reset_;
    vx_pin cm;
    vx_pin vdd, vss;

    vx_timer phase_timer;

    /* 4 registers × 16 main chars + 4 status chars each */
    uint8_t main[NUM_REGS][MAIN_CHARS_PER_REG];
    uint8_t status[NUM_REGS][STATUS_PER_REG];
    uint8_t output_port;        /* driven on O0..O3 by WMP */

    /* Latched SRC address. Updated when CM strobe + SRC X2/X3 align. */
    uint8_t latched_reg;        /* 0..3 */
    uint8_t latched_char;       /* 0..15 */
    bool    selected;           /* this chip's pair matches the latched reg's high bits */

    /* Cycle-tracking state. */
    bool     after_sync;
    int      phase_count;
    uint8_t  cur_opcode;        /* assembled at phase_count 3+4 */
    bool     driving_d;
} chip_t;

static chip_t G;

/* ─── D-bus helpers ─────────────────────────────────────────────────────── */
static uint8_t read_d_nibble(void) {
    uint8_t v = 0;
    for (int i = 0; i < 4; i++) if (vx_pin_read(G.d[i])) v |= (1u << i);
    return v;
}
static void drive_d_nibble(uint8_t n) {
    for (int i = 0; i < 4; i++) {
        vx_pin_set_mode(G.d[i], VX_OUTPUT);
        vx_pin_write(G.d[i], (n >> i) & 1);
    }
    G.driving_d = true;
}
static void release_d(void) {
    if (!G.driving_d) return;
    for (int i = 0; i < 4; i++) vx_pin_set_mode(G.d[i], VX_INPUT);
    G.driving_d = false;
}

static void drive_output(uint8_t v) {
    G.output_port = v & 0x0F;
    for (int i = 0; i < 4; i++) vx_pin_write(G.o[i], (v >> i) & 1);
}

/* ─── Phase tracking ────────────────────────────────────────────────────── */
static bool is_src_op(uint8_t op) { return (op & 0xF1) == 0x21; }

static void on_phase(void* user_data) {
    (void)user_data;
    if (!G.after_sync) return;
    G.phase_count++;

    switch (G.phase_count) {
        case 3:
            /* M1 frame — 4001 drove opcode_hi just before us. */
            G.cur_opcode = (read_d_nibble() & 0xF) << 4;
            break;
        case 4:
            /* M2 frame — opcode_lo. Full opcode known. */
            G.cur_opcode |= read_d_nibble() & 0xF;
            break;
        case 6: {
            /* X2 frame — drive D for read ops BEFORE the 4004 samples.
               Only act if a prior SRC selected us. */
            if (!G.selected) break;
            uint8_t op = G.cur_opcode;
            if (op == 0xE9 /* RDM */ || op == 0xE8 /* SBM */ || op == 0xEB /* ADM */) {
                drive_d_nibble(G.main[G.latched_reg & 3][G.latched_char & 0xF]);
            } else if (op >= 0xEC && op <= 0xEF /* RD0..RD3 */) {
                drive_d_nibble(G.status[G.latched_reg & 3][op & 3]);
            }
            break;
        }
        case 7: {
            /* X3 frame — bus has 4004's X2 drive. */
            uint8_t op = G.cur_opcode;
            if (is_src_op(op)) {
                /* High nibble of pair — chip-select-pair bits are 3..2,
                   register-within-chip is bits 1..0. CM gating: the CM
                   line is wired to the 4004's CMRAM[cmram_select], and
                   the 4004 asserted it during X2 (the prior frame).
                   It's still high here. */
                if (vx_pin_read(G.cm)) {
                    uint8_t hi = read_d_nibble();
                    G.selected = ((hi >> 2) & 3) == RAM4002_CHIP_PAIR;
                    if (G.selected) G.latched_reg = hi & 3;
                }
            } else if (G.selected && vx_pin_read(G.cm)) {
                /* Write group — 4004 drove ACC at X2; latch from bus. */
                uint8_t v = read_d_nibble();
                if (op == 0xE0 /* WRM */) {
                    G.main[G.latched_reg & 3][G.latched_char & 0xF] = v;
                } else if (op == 0xE1 /* WMP */) {
                    drive_output(v);
                } else if (op >= 0xE4 && op <= 0xE7 /* WR0..WR3 */) {
                    G.status[G.latched_reg & 3][op & 3] = v;
                }
                /* WRR (0xE2) addresses 4001 ROM ports, not us. */
            }
            /* Whatever we drove at X2 (for reads) is no longer needed —
               release so we don't fight 4004's A1 PC drive next cycle. */
            release_d();
            break;
        }
        case 8: {
            /* A1-of-next-cycle frame — bus has 4004's X3 drive. The
               only op that drives X3 distinct from X2 is SRC (low
               nibble = char addr). */
            if (G.selected && is_src_op(G.cur_opcode)) {
                G.latched_char = read_d_nibble() & 0xF;
            }
            break;
        }
        default:
            break;
    }
}

static void on_sync(void* user_data, vx_pin pin, int value) {
    (void)user_data; (void)pin;
    if (value) {
        G.after_sync = true;
        G.phase_count = 0;
        G.cur_opcode = 0;
    }
}

static void on_reset(void* user_data, vx_pin pin, int value) {
    (void)user_data; (void)pin;
    if (value) {
        memset(G.main, 0, sizeof G.main);
        memset(G.status, 0, sizeof G.status);
        drive_output(0);
        G.selected = false;
        G.latched_reg = 0;
        G.latched_char = 0;
        G.after_sync = false;
        G.phase_count = 0;
        G.cur_opcode = 0;
        release_d();
    }
}

void chip_setup(void) {
    char name[5];
    for (int i = 0; i < 4; i++) {
        name[0]='D'; name[1]='0'+i; name[2]=0;
        G.d[i] = vx_pin_register(name, VX_INPUT);
    }
    for (int i = 0; i < 4; i++) {
        name[0]='O'; name[1]='0'+i; name[2]=0;
        G.o[i] = vx_pin_register(name, VX_OUTPUT_LOW);
    }
    G.sync   = vx_pin_register("SYNC",  VX_INPUT);
    G.cl     = vx_pin_register("CL",    VX_INPUT);
    G.reset_ = vx_pin_register("RESET", VX_INPUT);
    G.cm     = vx_pin_register("CM",    VX_INPUT);
    G.vdd    = vx_pin_register("VDD",   VX_INPUT);
    G.vss    = vx_pin_register("VSS",   VX_INPUT);

    memset(G.main, 0, sizeof G.main);
    memset(G.status, 0, sizeof G.status);
    G.output_port = 0;
    G.after_sync = false;
    G.phase_count = 0;
    G.cur_opcode = 0;
    G.selected = false;
    G.driving_d = false;

    vx_pin_watch(G.sync,   VX_EDGE_RISING, on_sync,  0);
    vx_pin_watch(G.reset_, VX_EDGE_RISING, on_reset, 0);

    G.phase_timer = vx_timer_create(on_phase, 0);
    vx_timer_start(G.phase_timer, 1351, true);
}

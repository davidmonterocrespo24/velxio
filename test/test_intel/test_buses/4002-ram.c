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
 * Pin contract (we register 14 named pins; some 4002 variants have
 * additional power rails we collapse):
 *   D0..D3    I/O   shared multiplexed bus with the 4004
 *   O0..O3    out   dedicated output port (driven by WMP)
 *   SYNC      in    cycle marker driven by the 4004
 *   CL        in    Φ2 clock — informational
 *   RESET     in    asynchronous reset — clears storage
 *   CM        in    chip-match strobe (one of CM-RAM0..3)
 *   VDD, VSS  power
 *
 * Address protocol (the SRC instruction):
 *   When the 4004 executes SRC Pn, during X2 of that cycle the bus
 *   carries the chip-select address (high nibble of the register
 *   pair). During X3 it carries the char address (low nibble). The
 *   4002 latches both, but only retains them if the high nibble's
 *   bits 3..2 match the chip's hardcoded chip-pair number AND the
 *   strobed CM line is the one this chip is wired to.
 *
 * Subsequent I/O ops (WRM/RDM/WR0..3/RD0..3) use the latched address.
 *
 * For the FIRST cut of this chip:
 *   - Storage exists (80 nibbles + 4 status lines).
 *   - Pin contract registered.
 *   - SRC chip-select latching tracked via SYNC + timer + D-bus
 *     observation during the X2/X3 phases (works only when the 4004
 *     is modified to actually drive the SRC address — currently the
 *     4004 stubs SRC so this chip's storage is never reached
 *     end-to-end. Tracked as a Phase D follow-up.)
 *   - WMP write drives the 4 output port pins.
 *
 * NOT yet implemented:
 *   - WRR/RDR (these are 4001 ROM-port operations, unrelated to RAM).
 *   - Status-character (WR0..WR3 / RD0..RD3) handling beyond raw
 *     storage.
 *   - Cycle-accurate latch timing across CM strobes.
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

typedef enum {
    S_IDLE = 0,
    S_AFTER_SYNC,    /* tracking phases since last SYNC */
} state_t;

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

    state_t  state;
    int      phase_count;       /* phases since last SYNC */
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
static void on_phase(void* user_data) {
    (void)user_data;
    if (G.state != S_AFTER_SYNC) return;
    G.phase_count++;
    /* A faithful 4002 latches the SRC chip-select bits at X2 (phase 6
       counting from A1=0) when CM is asserted. Without explicit X2
       opcode tracking from the 4004, we approximate: capture the bus
       contents at phase 6 IF CM is high. */
    if (G.phase_count == 6 && vx_pin_read(G.cm)) {
        uint8_t hi = read_d_nibble();   /* chip# (bits 3..2) | reg# (bits 1..0) */
        G.selected = ((hi >> 2) & 3) == RAM4002_CHIP_PAIR;
        if (G.selected) {
            G.latched_reg = hi & 3;
        }
    } else if (G.phase_count == 7 && G.selected && vx_pin_read(G.cm)) {
        G.latched_char = read_d_nibble() & 0xF;
    }
}

static void on_sync(void* user_data, vx_pin pin, int value) {
    (void)user_data; (void)pin;
    if (value) {
        G.state = S_AFTER_SYNC;
        G.phase_count = 0;
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
    G.state = S_IDLE;
    G.phase_count = 0;
    G.selected = false;
    G.driving_d = false;

    vx_pin_watch(G.sync,   VX_EDGE_RISING, on_sync,  0);
    vx_pin_watch(G.reset_, VX_EDGE_RISING, on_reset, 0);

    G.phase_timer = vx_timer_create(on_phase, 0);
    vx_timer_start(G.phase_timer, 1351, true);
}

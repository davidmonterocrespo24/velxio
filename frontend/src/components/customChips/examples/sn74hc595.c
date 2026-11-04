/*
 * sn74hc595.c — 8-bit serial-in, parallel-out shift register with output
 * latches (TI SN74HC595).
 *
 * Pins: SER (serial data in), SRCLK (shift clock), RCLK (storage clock),
 *       SRCLR (shift register clear, active low), OE (output enable, active
 *       low), QH (QH', serial out to the next chip's SER), Q0..Q7 (QA..QH,
 *       the parallel outputs).
 *
 * Two registers, as on the die:
 *   - The shift register. On every SRCLK rising edge each stage takes the
 *     one before it and stage A takes SER, so after eight clocks the first
 *     bit sent sits in stage H. QH' is stage H. SRCLR low clears it at once
 *     and holds it clear: clocks are ignored while SRCLR stays low.
 *   - The storage register. RCLK's rising edge copies the shift register into
 *     it, and Q0..Q7 show it. SRCLR does not touch it: the outputs keep their
 *     level until the next RCLK. OE high puts Q0..Q7 in high impedance (the
 *     pins are released) without changing the storage register; QH' is not
 *     affected by OE.
 *
 * QH' moves on the FALLING edge of SRCLK. On the part it follows the rising
 * edge after a propagation delay, which is what lets a chain work: the next
 * chip samples its SER on that same rising edge, before QH' has changed.
 * Moving it on the falling edge gives every chip in the chain the old bit,
 * whatever order the simulator delivers the edge to them in.
 *
 * Two ways bits arrive:
 *   - SRCLK edges (shiftOut, a bit-banged SPI, digitalWrite by hand): bit by
 *     bit, exactly as above. A daisy chain (QH' to the next SER), a clock
 *     count that is not a multiple of 8 and an RCLK in the middle of a byte
 *     all behave as on the bench.
 *   - Whole bytes from a hardware SPI controller (SPI.transfer on SER = MOSI,
 *     SRCLK = SCK): the engines move SCK inside the peripheral, so the pins
 *     carry no edges and the bus hands the chip the byte instead. A byte is 8
 *     clocks at once: stage H ends up holding its MSB, as shiftOut(MSBFIRST)
 *     would leave it. The bus delivers the controller's MOSI to every chip
 *     on the clock, so under a hardware controller one chip, or several in
 *     parallel on the same SER, are exact; a daisy chain needs the edges.
 *   The bus also decodes SRCLK edges into bytes; those frames are the same
 *     bits counted twice and are dropped (see on_spi_done).
 *
 * Unwired control pins read as the usual board wiring: SRCLR to VCC (no
 * clear) and OE to GND (outputs on). A floating CMOS input has no defined
 * level on the bench; leaving them unwired here does not stop the chip.
 * SRCLR acts on its edges: falling clears and holds, rising releases. A
 * SRCLR that sits low from power-up without ever moving does not clear.
 */

#include "velxio-chip.h"
#include <stdlib.h>
#include <string.h>

/* No pin. vx_spi_config fields left at 0 would name pad 0, so a chip with no
 * select has to say so explicitly. */
#define NO_PIN ((vx_pin)-1)

static const char* Q_NAMES[8] = {"Q0","Q1","Q2","Q3","Q4","Q5","Q6","Q7"};

typedef struct {
  vx_pin SER, SRCLK, RCLK, SRCLR, OE, QH;
  vx_pin Q[8];
  vx_spi spi;
  uint8_t spi_buf[1];
  uint8_t shift_reg;   /* stages A..H, stage H in bit 7 */
  uint8_t latch_reg;   /* storage register */
  int qh;              /* level driven on QH' */
  int clearing;        /* SRCLR held low */
  int outputs_on;      /* OE low: Q0..Q7 driven */
  int released;        /* Q0..Q7 currently let go (set back to outputs on OE low) */
  uint32_t edges;      /* SRCLK rising edges since the last SPI frame */
} chip_state_t;

static void drive_qh(chip_state_t* s) {
  int level = (s->shift_reg >> 7) & 1;
  if (level == s->qh) return;
  s->qh = level;
  vx_pin_write(s->QH, level ? VX_HIGH : VX_LOW);
}

/* Q0..Q7 from the storage register, or released while OE is high. */
static void update_outputs(chip_state_t* s) {
  for (int i = 0; i < 8; i++) {
    int bit = (s->latch_reg >> i) & 1;
    if (!s->outputs_on) {
      vx_pin_set_mode(s->Q[i], VX_INPUT);
    } else if (s->released) {
      vx_pin_set_mode(s->Q[i], bit ? VX_OUTPUT_HIGH : VX_OUTPUT_LOW);
    } else {
      vx_pin_write(s->Q[i], bit ? VX_HIGH : VX_LOW);
    }
  }
  s->released = !s->outputs_on;
}

static void on_srclk(void* ud, vx_pin pin, int value) {
  chip_state_t* s = (chip_state_t*)ud;
  if (value == VX_HIGH) {
    s->edges++;
    if (s->clearing) return;
    s->shift_reg = (uint8_t)((s->shift_reg << 1) | (vx_pin_read(s->SER) & 1));
  } else {
    drive_qh(s);
  }
}

static void on_spi_done(void* ud, uint8_t* buffer, uint32_t count) {
  chip_state_t* s = (chip_state_t*)ud;
  /* A frame the bus decoded from SRCLK edges: on_srclk already shifted those
   * bits in. The bus reports it on the 8th rising edge, before or after this
   * chip's own watch sees that edge, so at least 7 of its edges are counted
   * by now; a hardware frame comes with none (the engine moves no pin). */
  if (s->edges >= 7) {
    s->edges = s->edges >= 8 ? s->edges - 8 : 0;
  } else {
    s->edges = 0;
    if (count > 0 && !s->clearing) {
      s->shift_reg = buffer[0];
      drive_qh(s);
    }
  }
  /* Re-arm: a 74HC595 has no select and shifts on every SRCLK edge. */
  vx_spi_start(s->spi, s->spi_buf, 1);
}

static void on_rclk(void* ud, vx_pin pin, int value) {
  chip_state_t* s = (chip_state_t*)ud;
  s->latch_reg = s->shift_reg;
  if (s->outputs_on) update_outputs(s);
}

static void set_clear(chip_state_t* s, int low) {
  s->clearing = low;
  if (low) {
    s->shift_reg = 0;
    drive_qh(s);
  }
}

static void on_srclr(void* ud, vx_pin pin, int value) {
  set_clear((chip_state_t*)ud, value == VX_LOW);
}

static void on_oe(void* ud, vx_pin pin, int value) {
  chip_state_t* s = (chip_state_t*)ud;
  int on = value == VX_LOW;
  if (on == s->outputs_on) return;
  s->outputs_on = on;
  update_outputs(s);
}

void chip_setup(void) {
  chip_state_t* s = (chip_state_t*)calloc(1, sizeof(chip_state_t));
  if (!s) {
    vx_log("74HC595: out of memory");
    return;
  }
  s->SER   = vx_pin_register("SER",   VX_INPUT);
  s->SRCLK = vx_pin_register("SRCLK", VX_INPUT);
  s->RCLK  = vx_pin_register("RCLK",  VX_INPUT);
  s->SRCLR = vx_pin_register("SRCLR", VX_INPUT_PULLUP);
  s->OE    = vx_pin_register("OE",    VX_INPUT);
  s->QH    = vx_pin_register("QH",    VX_OUTPUT_LOW);
  for (int i = 0; i < 8; i++) {
    s->Q[i] = vx_pin_register(Q_NAMES[i], VX_OUTPUT_LOW);
  }
  s->outputs_on = 1;

  /* QH' is driven by the chip itself, edge by edge, so it is not the bus's
   * MISO: a bus answer would be a whole byte, not stage H at each clock. */
  vx_spi_config cfg = {
    .sck       = s->SRCLK,
    .mosi      = s->SER,
    .miso      = NO_PIN,
    .cs        = NO_PIN,    /* no select line: RCLK below is the output latch */
    .mode      = 0,
    .on_done   = on_spi_done,
    .user_data = s,
  };
  s->spi = vx_spi_attach(&cfg);
  vx_spi_start(s->spi, s->spi_buf, 1);

  vx_pin_watch(s->SRCLK, VX_EDGE_BOTH,   on_srclk, s);
  vx_pin_watch(s->RCLK,  VX_EDGE_RISING, on_rclk,  s);
  vx_pin_watch(s->SRCLR, VX_EDGE_BOTH,   on_srclr, s);
  vx_pin_watch(s->OE,    VX_EDGE_BOTH,   on_oe,    s);

  /* OE's level at power-up, not only its edges: an OE already high starts
   * with the outputs off. SRCLR is not read here: wired to VCC (the usual
   * board) its pin reads low until the circuit solve publishes the rail, and
   * a clear on that reading would hold the register clear for a solve that may
   * never come. Its edges arrive either way, the solve's rising one included. */
  if (vx_pin_wired(s->OE) && vx_pin_read(s->OE) == VX_HIGH) {
    s->outputs_on = 0;
    update_outputs(s);
  }

  vx_log("74HC595 shift register ready");
}

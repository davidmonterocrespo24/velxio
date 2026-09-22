/*
 * open-drain: an open-drain IRQ line, the wired-AND idiom every IRQ, 1-Wire
 * and DHT-style data line uses.
 *
 * A rising edge on TRIG pulls IRQ low; a falling edge releases it by going
 * back to VX_INPUT (tri-state). Attribute `idiom` picks how the pull is made:
 *   0: vx_pin_set_mode(VX_OUTPUT) then vx_pin_write(0)
 *   1: vx_pin_set_mode(VX_OUTPUT_LOW)
 * The release is always vx_pin_set_mode(VX_INPUT).
 */
#include "velxio-chip.h"

static vx_pin irq, trig;
static int idiom;

static void on_trig(void* ud, vx_pin p, int v) {
  (void)ud;
  (void)p;
  if (v) {
    if (idiom == 0) {
      vx_pin_set_mode(irq, VX_OUTPUT);
      vx_pin_write(irq, 0);
    } else {
      vx_pin_set_mode(irq, VX_OUTPUT_LOW);
    }
  } else {
    vx_pin_set_mode(irq, VX_INPUT);
  }
}

void chip_setup(void) {
  irq = vx_pin_register("IRQ", VX_INPUT);
  trig = vx_pin_register("TRIG", VX_INPUT);
  idiom = (int)vx_attr_read(vx_attr_register("idiom", 0));
  vx_pin_watch(trig, VX_EDGE_BOTH, on_trig, 0);
  vx_log("open-drain ready");
}

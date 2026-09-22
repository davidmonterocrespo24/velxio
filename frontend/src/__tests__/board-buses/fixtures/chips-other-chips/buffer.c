/*
 * buffer: a non-inverting buffer (74HC125 with OE tied active). OUT follows
 * IN on every edge. Used to build chip-to-chip bus nets on each board.
 */
#include "velxio-chip.h"

static vx_pin in_pin, out_pin;

static void on_in(void* ud, vx_pin p, int v) {
  (void)ud;
  (void)p;
  vx_pin_write(out_pin, v);
}

void chip_setup(void) {
  in_pin = vx_pin_register("IN", VX_INPUT);
  out_pin = vx_pin_register("OUT", VX_OUTPUT_LOW);
  vx_pin_watch(in_pin, VX_EDGE_BOTH, on_in, 0);
}

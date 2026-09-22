/*
 * pulse-counter.c: counts rising edges on PULSE input. Every N pulses,
 * toggles the OVF output. Demonstrates pin_watch + pin_watch_stop + timer.
 *
 * Pins: PULSE (input, counted), OVF (output, toggled on overflow),
 *       RST (active-low reset, async; clears the counter).
 * Attribute "threshold": number of pulses per OVF toggle (default 4).
 */

#include "velxio-chip.h"
#include <stdlib.h>

typedef struct {
  vx_pin PULSE, OVF, RST_PIN;
  vx_attr threshold;
  uint32_t count;
  int ovf_state;
} chip_state_t;

static void on_pulse(void* ud, vx_pin pin, int value) {
  chip_state_t* s = (chip_state_t*)ud;
  s->count++;
  uint32_t threshold = (uint32_t)vx_attr_read(s->threshold);
  if (threshold == 0) threshold = 1;
  if (s->count >= threshold) {
    s->count = 0;
    s->ovf_state = !s->ovf_state;
    vx_pin_write(s->OVF, s->ovf_state ? VX_HIGH : VX_LOW);
  }
}

static void on_reset(void* ud, vx_pin pin, int value) {
  chip_state_t* s = (chip_state_t*)ud;
  s->count = 0;
  s->ovf_state = 0;
  vx_pin_write(s->OVF, VX_LOW);
}

void chip_setup(void) {
  chip_state_t* s = (chip_state_t*)calloc(1, sizeof(chip_state_t));
  s->PULSE   = vx_pin_register("PULSE", VX_INPUT);
  s->OVF     = vx_pin_register("OVF",   VX_OUTPUT_LOW);
  s->RST_PIN = vx_pin_register("RST",   VX_INPUT_PULLUP);
  s->threshold = vx_attr_register("threshold", 4.0);

  vx_pin_watch(s->PULSE,   VX_EDGE_RISING,  on_pulse, s);
  vx_pin_watch(s->RST_PIN, VX_EDGE_FALLING, on_reset, s);

  vx_log("pulse-counter ready");
}

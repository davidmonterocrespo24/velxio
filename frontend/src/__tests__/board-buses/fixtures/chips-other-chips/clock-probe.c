/*
 * clock-probe: reads the simulation clock two ways.
 *
 *  - IN: on every rising edge the chip logs "dt <us>", the time since the
 *    previous rising edge as vx_sim_now_nanos() measures it.
 *  - OUT: a repeating timer of `period_us` (default 1000) toggles OUT, so a
 *    sketch can measure the timer's period in guest time. The first fire
 *    logs "tick".
 */
#include "velxio-chip.h"

static vx_pin in_pin, out_pin;
static uint64_t last_rise;
static int seen;
static int out_level;
static int ticks;

static void log_dt(uint64_t ns) {
  uint64_t us = ns / 1000u;
  char digits[24];
  int n = 0;
  do {
    digits[n++] = (char)('0' + (int)(us % 10u));
    us /= 10u;
  } while (us && n < 20);
  char msg[32] = {'d', 't', ' '};
  int k = 3;
  while (n) msg[k++] = digits[--n];
  msg[k] = 0;
  vx_log(msg);
}

static void on_in(void* ud, vx_pin p, int v) {
  (void)ud;
  (void)p;
  if (!v) return;
  uint64_t now = vx_sim_now_nanos();
  if (seen) log_dt(now - last_rise);
  last_rise = now;
  seen = 1;
}

static void on_tick(void* ud) {
  (void)ud;
  out_level = !out_level;
  vx_pin_write(out_pin, out_level);
  if (++ticks == 1) vx_log("tick");
}

void chip_setup(void) {
  in_pin = vx_pin_register("IN", VX_INPUT);
  out_pin = vx_pin_register("OUT", VX_OUTPUT_LOW);
  vx_attr period = vx_attr_register("period_us", 1000);
  vx_pin_watch(in_pin, VX_EDGE_RISING, on_in, 0);
  vx_timer t = vx_timer_create(on_tick, 0);
  vx_timer_start(t, (uint64_t)vx_attr_read(period) * 1000u, true);
  vx_log("clock-probe ready");
}

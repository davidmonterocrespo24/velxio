/*
 * i2c-probe.c: a minimal I2C slave for the QEMU worker repro tests
 * (test_board_buses_repro_worker.py).
 *
 *   address  attribute, default 0x50
 *   id       attribute, default 0x11: every byte the master reads is `id`
 *
 * Two instances at the same address with different `id` values tell the test
 * which device answered a read.
 */
#include "velxio-chip.h"
#include <stdlib.h>

typedef struct {
  vx_attr address, id;
  vx_i2c i2c;
} probe_t;

static bool on_connect(void* ud, uint8_t addr, bool is_read) {
  (void)ud; (void)addr; (void)is_read;
  return true;
}

static uint8_t on_read(void* ud) {
  probe_t* s = (probe_t*)ud;
  return (uint8_t)((int)vx_attr_read(s->id) & 0xff);
}

static bool on_write(void* ud, uint8_t byte) {
  (void)ud; (void)byte;
  return true;
}

static void on_stop(void* ud) { (void)ud; }

void chip_setup(void) {
  probe_t* s = (probe_t*)calloc(1, sizeof(probe_t));
  s->address = vx_attr_register("address", 80);
  s->id = vx_attr_register("id", 17);

  vx_i2c_config cfg = {0};
  cfg.address = (uint8_t)((int)vx_attr_read(s->address) & 0x7f);
  cfg.scl = vx_pin_register("SCL", VX_INPUT);
  cfg.sda = vx_pin_register("SDA", VX_INPUT);
  cfg.on_connect = on_connect;
  cfg.on_read = on_read;
  cfg.on_write = on_write;
  cfg.on_stop = on_stop;
  cfg.user_data = s;
  s->i2c = vx_i2c_attach(&cfg);
}

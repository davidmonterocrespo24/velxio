/*
 * i2c-probe: an I2C target at one or two addresses.
 *
 * Attributes: addr1 (default 0x44), addr2 (default 0 = none), id (default
 * 0x11). Every read returns `id`, so a sketch can tell two instances at the
 * same address apart. Two addresses model modules like the Grove LCD RGB
 * (0x3E + 0x62) or the BMI088 (0x19 + 0x69).
 */
#include "velxio-chip.h"

static uint8_t id;

static bool on_connect(void* ud, uint8_t addr, bool is_read) {
  (void)ud;
  (void)addr;
  (void)is_read;
  return true;
}
static uint8_t on_read(void* ud) {
  (void)ud;
  return id;
}
static bool on_write(void* ud, uint8_t b) {
  (void)ud;
  (void)b;
  return true;
}
static void on_stop(void* ud) { (void)ud; }

static void attach(uint8_t addr, vx_pin scl, vx_pin sda) {
  vx_i2c_config cfg = {0};
  cfg.address = addr;
  cfg.scl = scl;
  cfg.sda = sda;
  cfg.on_connect = on_connect;
  cfg.on_read = on_read;
  cfg.on_write = on_write;
  cfg.on_stop = on_stop;
  vx_i2c_attach(&cfg);
}

void chip_setup(void) {
  vx_pin scl = vx_pin_register("SCL", VX_INPUT);
  vx_pin sda = vx_pin_register("SDA", VX_INPUT);
  uint8_t a1 = (uint8_t)vx_attr_read(vx_attr_register("addr1", 0x44));
  uint8_t a2 = (uint8_t)vx_attr_read(vx_attr_register("addr2", 0));
  id = (uint8_t)vx_attr_read(vx_attr_register("id", 0x11));
  attach(a1, scl, sda);
  if (a2) attach(a2, scl, sda);
  vx_log("i2c-probe ready");
}

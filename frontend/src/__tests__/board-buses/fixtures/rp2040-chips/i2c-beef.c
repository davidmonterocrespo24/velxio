/*
 * i2c-beef.c - I2C target at 0x44 that ACKs and reads back 0xBE 0xEF.
 *
 * Nothing but I2C: no SPI, no UART. Build: ./build.sh.
 */
#include "velxio-chip.h"
#include <stdlib.h>
#include <string.h>

static uint8_t idx;

static bool on_connect(void* ud, uint8_t addr, bool is_read) {
  (void)ud; (void)addr; (void)is_read;
  idx = 0;
  return true;
}

static uint8_t on_read(void* ud) {
  (void)ud;
  return (idx++ & 1) ? 0xef : 0xbe;
}

static bool on_write(void* ud, uint8_t byte) {
  (void)ud; (void)byte;
  return true;
}

static void on_stop(void* ud) { (void)ud; }

void chip_setup(void) {
  vx_i2c_config cfg;
  memset(&cfg, 0, sizeof(cfg));
  cfg.address = 0x44;
  cfg.scl = vx_pin_register("SCL", VX_INPUT);
  cfg.sda = vx_pin_register("SDA", VX_INPUT);
  cfg.on_connect = on_connect;
  cfg.on_read = on_read;
  cfg.on_write = on_write;
  cfg.on_stop = on_stop;
  vx_i2c_attach(&cfg);
}

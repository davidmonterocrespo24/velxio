/*
 * spi-echo: an SPI target that answers 0xA5 to every byte while its CS is low.
 *
 * The canonical CS-gated chip: vx_spi_start on CS falling, re-armed from
 * on_done while CS stays low, vx_spi_stop on CS rising.
 */
#include "velxio-chip.h"

static vx_spi spi;
static vx_pin cs;
static uint8_t buf[1];

static void arm(void) {
  buf[0] = 0xA5;
  vx_spi_start(spi, buf, 1);
}

static void on_done(void* ud, uint8_t* b, uint32_t n) {
  (void)ud;
  (void)b;
  (void)n;
  if (vx_pin_read(cs) == 0) arm();
}

static void on_cs(void* ud, vx_pin p, int v) {
  (void)ud;
  (void)p;
  if (v == 0) arm();
  else vx_spi_stop(spi);
}

void chip_setup(void) {
  cs = vx_pin_register("CS", VX_INPUT_PULLUP);
  vx_spi_config cfg = {0};
  cfg.sck = vx_pin_register("SCK", VX_INPUT);
  cfg.mosi = vx_pin_register("MOSI", VX_INPUT);
  cfg.miso = vx_pin_register("MISO", VX_INPUT);
  cfg.cs = cs;
  cfg.mode = 0;
  cfg.on_done = on_done;
  spi = vx_spi_attach(&cfg);
  vx_pin_watch(cs, VX_EDGE_BOTH, on_cs, 0);
  vx_log("spi-echo ready");
}

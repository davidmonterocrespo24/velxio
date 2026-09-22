/*
 * spi-probe.c: a well-behaved CS-gated SPI slave for the QEMU worker repro
 * tests (test_board_buses_repro_worker.py).
 *
 * It follows the pattern the custom-chip API reference documents: arm on CS
 * falling, stop on CS rising, one byte at a time.
 *
 *   MISO  byte n of a transaction is `sig` + n (the attribute, default 0xA0)
 *   MOSI  every byte received is logged when CS rises: "probe a0 rx=11 22"
 *
 * Two instances with different `sig` values on different CS pins tell the
 * test which device answered a byte.
 */
#include "velxio-chip.h"
#include <stdio.h>
#include <stdlib.h>

typedef struct {
  vx_pin cs, sck, mosi, miso;
  vx_spi spi;
  vx_attr sig;
  uint8_t buf[1];
  uint8_t seq;
  uint8_t rx[32];
  uint32_t n;
} probe_t;

static uint8_t sig_of(probe_t* s) {
  return (uint8_t)((int)vx_attr_read(s->sig) & 0xff);
}

static void arm(probe_t* s) {
  s->buf[0] = (uint8_t)(sig_of(s) + s->seq);
  vx_spi_start(s->spi, s->buf, 1);
}

static void on_done(void* ud, uint8_t* buffer, uint32_t count) {
  probe_t* s = (probe_t*)ud;
  if (count == 0) return;
  if (s->n < sizeof(s->rx)) s->rx[s->n++] = buffer[0];
  s->seq++;
  if (vx_pin_read(s->cs) == VX_LOW) arm(s);
}

static void on_cs(void* ud, vx_pin pin, int value) {
  probe_t* s = (probe_t*)ud;
  (void)pin;
  if (value == VX_LOW) {
    s->seq = 0;
    s->n = 0;
    arm(s);
    return;
  }
  vx_spi_stop(s->spi);
  char line[160];
  int k = snprintf(line, sizeof(line), "probe %02x rx=", sig_of(s));
  for (uint32_t i = 0; i < s->n && k < (int)sizeof(line) - 4; i++) {
    k += snprintf(line + k, sizeof(line) - k, i ? " %02x" : "%02x", s->rx[i]);
  }
  vx_log(line);
}

void chip_setup(void) {
  probe_t* s = (probe_t*)calloc(1, sizeof(probe_t));
  s->cs = vx_pin_register("CS", VX_INPUT_PULLUP);
  s->sck = vx_pin_register("SCK", VX_INPUT);
  s->mosi = vx_pin_register("MOSI", VX_INPUT);
  s->miso = vx_pin_register("MISO", VX_INPUT);
  s->sig = vx_attr_register("sig", 160);

  vx_spi_config cfg = {0};
  cfg.sck = s->sck;
  cfg.mosi = s->mosi;
  cfg.miso = s->miso;
  cfg.cs = s->cs;
  cfg.mode = 0;
  cfg.on_done = on_done;
  cfg.user_data = s;
  s->spi = vx_spi_attach(&cfg);

  vx_pin_watch(s->cs, VX_EDGE_BOTH, on_cs, s);
  vx_log("spi probe ready");
}

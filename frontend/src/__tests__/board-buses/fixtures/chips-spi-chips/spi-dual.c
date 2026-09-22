/*
 * spi-dual.c: one chip with two SPI handles, for the chips-spi tests.
 *
 *   handle 0 ("reg")    CS-gated on CS: armed on CS falling, re-armed while
 *                       CS stays low, stopped on CS rising
 *   handle 1 ("stream") no CS: armed at setup and re-armed on every byte,
 *                       like a write-only LED or display interface
 *
 * Each handle has its own one-byte buffer. Every completion logs whether
 * on_done was handed that handle's own buffer: "dual h1 own=1 rx=22".
 */
#include "velxio-chip.h"
#include <stdio.h>
#include <stdlib.h>

/* velxio-chip.h has no name for an unconnected pin; the Wokwi-compat layer uses -1. */
#define NO_PIN ((vx_pin)-1)

typedef struct chip chip_t;

typedef struct {
  chip_t* chip;
  int id;
  vx_spi spi;
  uint8_t buf[1];
} side_t;

struct chip {
  vx_pin cs;
  side_t side[2];
};

static void arm(side_t* d) {
  d->buf[0] = (uint8_t)(d->id ? 0xB0 : 0xA0);
  vx_spi_start(d->spi, d->buf, 1);
}

static void on_done(void* ud, uint8_t* buffer, uint32_t count) {
  side_t* d = (side_t*)ud;
  if (count == 0) return;
  char line[64];
  snprintf(line, sizeof(line), "dual h%d own=%d rx=%02x", d->id,
           buffer == d->buf ? 1 : 0, buffer[0]);
  vx_log(line);
  if (d->id == 1 || vx_pin_read(d->chip->cs) == VX_LOW) arm(d);
}

static void on_cs(void* ud, vx_pin pin, int value) {
  chip_t* c = (chip_t*)ud;
  if (value == VX_LOW) arm(&c->side[0]);
  else vx_spi_stop(c->side[0].spi);
}

void chip_setup(void) {
  chip_t* c = (chip_t*)calloc(1, sizeof(chip_t));
  c->cs = vx_pin_register("CS", VX_INPUT_PULLUP);
  vx_pin sck = vx_pin_register("SCK", VX_INPUT);
  vx_pin mosi = vx_pin_register("MOSI", VX_INPUT);
  for (int i = 0; i < 2; i++) {
    c->side[i].chip = c;
    c->side[i].id = i;
    vx_spi_config cfg = {
      .sck = sck,
      .mosi = mosi,
      .miso = NO_PIN,
      .cs = i == 0 ? c->cs : NO_PIN,
      .mode = 0,
      .on_done = on_done,
      .user_data = &c->side[i],
    };
    c->side[i].spi = vx_spi_attach(&cfg);
  }
  arm(&c->side[1]);
  vx_pin_watch(c->cs, VX_EDGE_BOTH, on_cs, c);
  vx_log("dual ready");
}

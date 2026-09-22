/*
 * spi-id.c - SPI chip that answers 0xA5 to an id read.
 *
 * On CS low it arms a 2-byte exchange: the master's first byte (0x9F) is
 * answered with 0xFF, its second byte with 0xA5. CS high ends it.
 * Build: ./build.sh (the backend's chip compile flags, wasi-sdk).
 */
#include "velxio-chip.h"
#include <stdlib.h>

typedef struct {
  vx_pin cs;
  vx_spi spi;
  uint8_t buf[2];
} chip_state_t;

static void arm(chip_state_t* s) {
  s->buf[0] = 0xff;
  s->buf[1] = 0xa5;
  vx_spi_start(s->spi, s->buf, 2);
}

static void on_cs(void* ud, vx_pin pin, int value) {
  chip_state_t* s = (chip_state_t*)ud;
  if (value == VX_LOW) arm(s);
  else vx_spi_stop(s->spi);
}

static void on_done(void* ud, uint8_t* buffer, uint32_t count) {
  (void)ud; (void)buffer; (void)count;
}

void chip_setup(void) {
  chip_state_t* s = (chip_state_t*)calloc(1, sizeof(chip_state_t));
  s->cs = vx_pin_register("CS", VX_INPUT_PULLUP);
  vx_spi_config cfg = {
    .sck = vx_pin_register("SCK", VX_INPUT),
    .mosi = vx_pin_register("MOSI", VX_INPUT),
    .miso = vx_pin_register("MISO", VX_OUTPUT_HIGH),
    .cs = s->cs,
    .mode = 0,
    .on_done = on_done,
    .user_data = s,
  };
  s->spi = vx_spi_attach(&cfg);
  vx_pin_watch(s->cs, VX_EDGE_BOTH, on_cs, s);
}

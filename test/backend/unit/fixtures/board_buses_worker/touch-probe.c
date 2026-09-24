/*
 * touch-probe.c: the shape of an XPT2046 answer, as a portable responder for
 * the QEMU worker tests (test_board_buses_repro_worker.py).
 *
 * It is not the real touch controller (that model lives in the overlay); it is
 * the one property the `touch-qemu-async-miso` finding is about: the byte the
 * chip drives depends on the COMMAND it was given in this same transaction.
 *
 *   MOSI 0xD0 (start bit, channel X)  ->  the next two bytes carry `x`,
 *                                          12 bits left-aligned in 16
 *   anything else                     ->  0x00
 *
 * A responder that runs in the tab cannot do this on a QEMU board: it is told
 * about 0xD0 only after the guest has already clocked the two bytes that were
 * supposed to answer it. A responder that runs in the worker can.
 */
#include "velxio-chip.h"
#include <stdlib.h>

typedef struct {
  vx_pin cs, sck, mosi, miso;
  vx_spi spi;
  vx_attr x;
  uint8_t buf[1];
  uint8_t pending[2];
  uint8_t n_pending;
} touch_t;

static void arm(touch_t* s) {
  s->buf[0] = s->n_pending ? s->pending[0] : 0x00;
  vx_spi_start(s->spi, s->buf, 1);
}

static void on_done(void* ud, uint8_t* buffer, uint32_t count) {
  touch_t* s = (touch_t*)ud;
  if (count == 0) return;
  if (s->n_pending) {
    s->pending[0] = s->pending[1];
    s->n_pending--;
  }
  /* A start bit with channel 101 is "measure X", the command the driver
     sends before it clocks the two result bytes. */
  if ((buffer[0] & 0x80) && ((buffer[0] >> 4) & 0x7) == 0x5) {
    int x = (int)vx_attr_read(s->x) & 0xfff;
    s->pending[0] = (uint8_t)((x >> 5) & 0x7f);
    s->pending[1] = (uint8_t)((x << 3) & 0xf8);
    s->n_pending = 2;
  }
  if (vx_pin_read(s->cs) == VX_LOW) arm(s);
}

static void on_cs(void* ud, vx_pin pin, int value) {
  touch_t* s = (touch_t*)ud;
  (void)pin;
  if (value == VX_LOW) {
    s->n_pending = 0;
    arm(s);
  } else {
    vx_spi_stop(s->spi);
  }
}

void chip_setup(void) {
  touch_t* s = (touch_t*)calloc(1, sizeof(touch_t));
  s->cs = vx_pin_register("CS", VX_INPUT_PULLUP);
  s->sck = vx_pin_register("SCK", VX_INPUT);
  s->mosi = vx_pin_register("MOSI", VX_INPUT);
  s->miso = vx_pin_register("MISO", VX_INPUT);
  s->x = vx_attr_register("x", 0);

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
  vx_log("touch probe ready");
}

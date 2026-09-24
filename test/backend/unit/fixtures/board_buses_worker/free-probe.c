/*
 * free-probe.c: a responder with NO select line of its own, for the QEMU
 * worker tests (test_board_buses_f4_worker.py).
 *
 * velxio-chip.h: a chip whose select is ((vx_pin)-1) is always on the bus (a
 * 74HC595, whose RCLK is a latch and not a select). It is the right instrument
 * for the bus map's `none` and `const` selects, where nothing in the circuit
 * ever moves a pin and the only thing deciding whether the chip is clocked is
 * the bus table itself.
 *
 *   MISO  byte n of the run is `sig` + n (the attribute, default 0x5A)
 */
#include "velxio-chip.h"
#include <stdlib.h>

typedef struct {
  vx_pin sck, mosi, miso;
  vx_spi spi;
  vx_attr sig;
  uint8_t buf[1];
  uint8_t seq;
} free_t;

static void arm(free_t* s) {
  s->buf[0] = (uint8_t)(((int)vx_attr_read(s->sig) & 0xff) + s->seq);
  vx_spi_start(s->spi, s->buf, 1);
}

static void on_done(void* ud, uint8_t* buffer, uint32_t count) {
  free_t* s = (free_t*)ud;
  (void)buffer;
  if (count == 0) return;
  s->seq++;
  arm(s);
}

void chip_setup(void) {
  free_t* s = (free_t*)calloc(1, sizeof(free_t));
  s->sck = vx_pin_register("SCK", VX_INPUT);
  s->mosi = vx_pin_register("MOSI", VX_INPUT);
  s->miso = vx_pin_register("MISO", VX_INPUT);
  s->sig = vx_attr_register("sig", 90);

  vx_spi_config cfg = {0};
  cfg.sck = s->sck;
  cfg.mosi = s->mosi;
  cfg.miso = s->miso;
  cfg.cs = (vx_pin)-1;
  cfg.mode = 0;
  cfg.on_done = on_done;
  cfg.user_data = s;
  s->spi = vx_spi_attach(&cfg);
  arm(s);
  vx_log("free probe ready");
}

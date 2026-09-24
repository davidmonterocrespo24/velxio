/*
 * block-probe.c: an SPI slave that arms a LONG buffer, for the runtime's
 * per-byte path (test_wasm_chip_spi_long_buffer.py).
 *
 * A card streaming a sector, a display controller reading a line: a chip that
 * hands the host many bytes at once is served by wasm_chip_runtime.py from a
 * Python copy of the buffer, and the copy has to be invisible to the chip.
 *
 *   MISO  byte n of the armed buffer is `sig` + n (the attribute, default 0xA0)
 *   MOSI  on_done logs how many bytes arrived and every one of them:
 *         "block a0 n=3 rx=11 22 33". CS rising stops the transfer early
 *         (vx_spi_stop), which is the case where the chip runs part-way
 *         through a buffer the host was serving from its copy.
 */
#include "velxio-chip.h"
#include <stdio.h>
#include <stdlib.h>

#define LEN 40

typedef struct {
  vx_pin cs, sck, mosi, miso;
  vx_spi spi;
  vx_attr sig;
  uint8_t buf[LEN];
} probe_t;

static void arm(probe_t* s) {
  uint8_t sig = (uint8_t)((int)vx_attr_read(s->sig) & 0xff);
  for (int i = 0; i < LEN; i++) s->buf[i] = (uint8_t)(sig + i);
  vx_spi_start(s->spi, s->buf, LEN);
}

static void on_done(void* ud, uint8_t* buffer, uint32_t count) {
  probe_t* s = (probe_t*)ud;
  char line[200];
  int k = snprintf(line, sizeof(line), "block %02x n=%u rx=",
                   (unsigned)((int)vx_attr_read(s->sig) & 0xff), (unsigned)count);
  for (uint32_t i = 0; i < count && k < (int)sizeof(line) - 4; i++) {
    k += snprintf(line + k, sizeof(line) - k, i ? " %02x" : "%02x", buffer[i]);
  }
  vx_log(line);
  if (vx_pin_read(s->cs) == VX_LOW) arm(s);
}

static void on_cs(void* ud, vx_pin pin, int value) {
  probe_t* s = (probe_t*)ud;
  (void)pin;
  if (value == VX_LOW) {
    arm(s);
    return;
  }
  vx_spi_stop(s->spi);
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
}

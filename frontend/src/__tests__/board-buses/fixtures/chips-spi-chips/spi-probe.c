/*
 * spi-probe.c: a well-behaved CS-gated SPI slave for the chips-spi tests.
 *
 * It follows the pattern the custom-chip API reference documents: arm on CS
 * falling, stop on CS rising, one byte at a time.
 *
 *   MISO  byte n of a transaction is 0xC0 + n (0xC0, 0xC1, ...)
 *   MOSI  every byte received is logged when CS rises: "probe rx=11 22"
 *   GROW  a rising edge allocates 320 KB, which grows the WASM memory while
 *         a transfer is armed (a radio or flash model growing a packet buffer)
 *   mode  attribute copied into vx_spi_config.mode (default 0)
 *
 * MISO is registered as an output driven low, the way a slave that only
 * drives its data pin during a transfer would start.
 */
#include "velxio-chip.h"
#include <stdio.h>
#include <stdlib.h>

typedef struct {
  vx_pin cs, sck, mosi, miso, grow;
  vx_spi spi;
  uint8_t buf[1];
  uint8_t seq;
  uint8_t rx[32];
  uint32_t n;
} probe_t;

static void arm(probe_t* s) {
  s->buf[0] = (uint8_t)(0xC0 + s->seq);
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
  if (value == VX_LOW) {
    s->seq = 0;
    s->n = 0;
    arm(s);
    return;
  }
  vx_spi_stop(s->spi);
  char line[160];
  int k = snprintf(line, sizeof(line), "probe rx=");
  for (uint32_t i = 0; i < s->n && k < (int)sizeof(line) - 4; i++) {
    k += snprintf(line + k, sizeof(line) - k, i ? " %02x" : "%02x", s->rx[i]);
  }
  vx_log(line);
}

static void on_grow(void* ud, vx_pin pin, int value) {
  (void)ud;
  (void)pin;
  (void)value;
  volatile uint8_t* block = (volatile uint8_t*)malloc(320 * 1024);
  if (block) block[0] = 1;
  vx_log(block ? "probe grew" : "probe grow failed");
}

void chip_setup(void) {
  probe_t* s = (probe_t*)calloc(1, sizeof(probe_t));
  s->cs = vx_pin_register("CS", VX_INPUT_PULLUP);
  s->sck = vx_pin_register("SCK", VX_INPUT);
  s->mosi = vx_pin_register("MOSI", VX_INPUT);
  s->miso = vx_pin_register("MISO", VX_OUTPUT_LOW);
  s->grow = vx_pin_register("GROW", VX_INPUT);
  vx_attr mode_attr = vx_attr_register("mode", 0);
  uint32_t mode = (uint32_t)vx_attr_read(mode_attr);

  vx_spi_config cfg = {
    .sck = s->sck,
    .mosi = s->mosi,
    .miso = s->miso,
    .cs = s->cs,
    .mode = mode,
    .on_done = on_done,
    .user_data = s,
  };
  s->spi = vx_spi_attach(&cfg);
  vx_pin_watch(s->cs, VX_EDGE_BOTH, on_cs, s);
  vx_pin_watch(s->grow, VX_EDGE_RISING, on_grow, s);
  char line[32];
  snprintf(line, sizeof(line), "probe mode=%u ready", (unsigned)mode);
  vx_log(line);
}

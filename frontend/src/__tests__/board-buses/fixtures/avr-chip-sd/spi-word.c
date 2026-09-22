/*
 * spi-word: a chip-select gated SPI device that answers one 16-bit word per
 * transaction, MSB first, the way a MAX6675 does. The word is latched on the
 * falling edge of CS from the `word` attribute (default 0x0320: 25 C in the
 * MAX6675 format, bit 2 low = thermocouple attached); CS high ends the
 * transaction.
 *
 * Build (the backend's chip compiler flags, OSS header):
 *   ~/wasi-sdk/bin/clang --target=wasm32-unknown-wasip1 -O2 -nostartfiles \
 *     -Wl,--import-memory -Wl,--export-table -Wl,--no-entry \
 *     -Wl,--export=chip_setup -Wl,--allow-undefined \
 *     -I velxio/backend/sdk spi-word.c -o spi-word.wasm
 */
#include "velxio-chip.h"

static vx_attr word_attr;
static vx_spi spi;
static uint8_t buf[2];

static void on_cs(void *ud, vx_pin pin, int value) {
  (void)ud;
  (void)pin;
  if (value == VX_LOW) {
    const uint16_t w = (uint16_t)vx_attr_read(word_attr);
    buf[0] = (uint8_t)(w >> 8);
    buf[1] = (uint8_t)(w & 0xff);
    vx_spi_start(spi, buf, 2);
  } else {
    vx_spi_stop(spi);
  }
}

static void on_done(void *ud, uint8_t *buffer, uint32_t count) {
  (void)ud;
  (void)buffer;
  (void)count;
}

void chip_setup(void) {
  const vx_pin sck = vx_pin_register("SCK", VX_INPUT);
  const vx_pin mosi = vx_pin_register("MOSI", VX_INPUT);
  const vx_pin miso = vx_pin_register("MISO", VX_OUTPUT_LOW);
  const vx_pin cs = vx_pin_register("CS", VX_INPUT_PULLUP);
  word_attr = vx_attr_register("word", 0x0320);
  vx_spi_config cfg = {
    .sck = sck,
    .mosi = mosi,
    .miso = miso,
    .cs = cs,
    .mode = 0,
    .on_done = on_done,
    .user_data = 0,
  };
  spi = vx_spi_attach(&cfg);
  vx_pin_watch(cs, VX_EDGE_BOTH, on_cs, 0);
  vx_log("spi-word ready");
}

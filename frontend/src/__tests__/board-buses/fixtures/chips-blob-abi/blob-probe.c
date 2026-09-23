/*
 * blob-probe.c: the conformance fixture for the vx_blob_* ABI (board-buses F4).
 *
 * ONE artifact, three hosts. The same blob-probe.wasm is run by ChipRuntime.ts
 * in the browser, by WasmChipRuntime in the ESP32/STM32 worker and by the
 * Linux-board adapter, and each host is asserted against the same table of
 * expected answers (expectations.json). That is the claim F4 rests on: a
 * responder that moves next to the CPU has to behave identically wherever it
 * lands, and a call that answers differently by host is the per-engine
 * divergence the whole project exists to remove.
 *
 * The chip does two things:
 *
 *   - It exports a small probe surface the tests drive directly: pick a name,
 *     ask for a size, read or write a span, and look at the scratch buffer.
 *     A read fills scratch with 0xEE first, so a test can see that a truncated
 *     read leaves the rest of the destination untouched.
 *   - It attaches a plain I2C slave whose register reads serve the card image.
 *     The Linux boards speak whole transactions and never touch the probe
 *     exports in production, so this is the same blob reached the way that
 *     host actually reaches a chip.
 */
#include "velxio-chip.h"

#define SCRATCH_LEN 64u
#define FILL        0xEEu

static uint8_t  scratch[SCRATCH_LEN];
static uint32_t g_setup_size;
static uint8_t  i2c_pointer;

/* Three names, chosen by index so the host side does not have to place a C
 * string in the chip's memory: 0 is the blob the host declares, 1 is a name it
 * never declared, 2 is the empty name. */
static const char* pick(uint32_t which) {
  switch (which) {
    case 0:  return "card";
    case 1:  return "missing";
    default: return "";
  }
}

static bool i2c_connect(void* ud, uint8_t addr, bool is_read) {
  (void)ud; (void)addr; (void)is_read;
  return true;
}

static bool i2c_write(void* ud, uint8_t byte) {
  (void)ud;
  i2c_pointer = byte;
  return true;
}

static uint8_t i2c_read(void* ud) {
  (void)ud;
  uint8_t b = 0;
  /* Past the end of the card the bus reads all ones, the way an unread line
   * does; the point here is that the host told the chip there was nothing. */
  if (vx_blob_read("card", i2c_pointer, &b, 1) == 0) return 0xFF;
  i2c_pointer++;
  return b;
}

static void i2c_stop(void* ud) { (void)ud; }

void chip_setup(void) {
  /* A card model sizes its storage during setup, so the fixture does too: a
   * host that only wires the blob up after chip_setup would answer 0 here. */
  g_setup_size = vx_blob_size("card");

  vx_i2c_config cfg = {
    .address    = 0x42,
    .scl        = vx_pin_register("SCL", VX_INPUT),
    .sda        = vx_pin_register("SDA", VX_INPUT),
    .on_connect = i2c_connect,
    .on_read    = i2c_read,
    .on_write   = i2c_write,
    .on_stop    = i2c_stop,
  };
  vx_i2c_attach(&cfg);
}

/* ── Probe surface ──────────────────────────────────────────────────────── */

__attribute__((export_name("scratch_ptr")))
uint32_t probe_scratch_ptr(void) { return (uint32_t)(uintptr_t)scratch; }

__attribute__((export_name("scratch_len")))
uint32_t probe_scratch_len(void) { return SCRATCH_LEN; }

__attribute__((export_name("setup_size")))
uint32_t probe_setup_size(void) { return g_setup_size; }

__attribute__((export_name("blob_size")))
uint32_t probe_blob_size(uint32_t which) { return vx_blob_size(pick(which)); }

__attribute__((export_name("blob_read")))
uint32_t probe_blob_read(uint32_t which, uint32_t offset, uint32_t len) {
  for (uint32_t i = 0; i < SCRATCH_LEN; i++) scratch[i] = FILL;
  return vx_blob_read(pick(which), offset, scratch, len);
}

__attribute__((export_name("blob_write")))
uint32_t probe_blob_write(uint32_t which, uint32_t offset, uint32_t len) {
  return vx_blob_write(pick(which), offset, scratch, len);
}

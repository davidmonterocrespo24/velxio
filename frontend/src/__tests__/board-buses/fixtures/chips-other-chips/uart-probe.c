/*
 * uart-probe: a UART peripheral for the chips-other lifecycle tests.
 *
 * Every byte that reaches RX is logged as "rx HH" (the chip's own voice, so a
 * test can tell "the chip heard it" from "the monitor printed it"). A 'G'
 * makes the chip answer with a 96-byte burst on TX, "0123456789" repeated,
 * which is 100 ms of line time at 9600 baud.
 */
#include "velxio-chip.h"

static vx_uart uart;
static const char HEXD[] = "0123456789abcdef";

static void on_rx(void* ud, uint8_t b) {
  (void)ud;
  char msg[6] = {'r', 'x', ' ', HEXD[b >> 4], HEXD[b & 15], 0};
  vx_log(msg);
  if (b == 'G') {
    uint8_t burst[96];
    for (int i = 0; i < 96; i++) burst[i] = (uint8_t)('0' + (i % 10));
    vx_uart_write(uart, burst, 96);
  }
}

static void on_tx_done(void* ud) { (void)ud; }

void chip_setup(void) {
  vx_uart_config cfg = {0};
  cfg.rx = vx_pin_register("RX", VX_INPUT);
  cfg.tx = vx_pin_register("TX", VX_INPUT_PULLUP);
  cfg.baud_rate = 9600;
  cfg.on_rx_byte = on_rx;
  cfg.on_tx_done = on_tx_done;
  uart = vx_uart_attach(&cfg);
  vx_log("uart-probe ready");
}

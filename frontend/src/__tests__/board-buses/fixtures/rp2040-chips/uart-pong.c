/*
 * uart-pong.c - UART chip that answers "PONG<n>\n" to a "PING" line.
 *
 * n is the number of lines it has heard in total, so a chip that is fed
 * traffic from another UART says so in its reply. Build: ./build.sh.
 */
#include "velxio-chip.h"
#include <stdlib.h>
#include <string.h>

typedef struct {
  vx_uart uart;
  char line[64];
  uint32_t len;
  uint32_t lines;
} chip_state_t;

static void on_rx(void* ud, uint8_t byte) {
  chip_state_t* s = (chip_state_t*)ud;
  if (byte == '\r') return;
  if (byte != '\n') {
    if (s->len < sizeof(s->line) - 1) s->line[s->len++] = (char)byte;
    return;
  }
  s->line[s->len] = 0;
  s->lines++;
  if (strcmp(s->line, "PING") == 0) {
    char out[16];
    uint32_t n = s->lines, k = 0;
    char digits[10];
    uint32_t d = 0;
    do { digits[d++] = (char)('0' + n % 10); n /= 10; } while (n && d < sizeof(digits));
    out[k++] = 'P'; out[k++] = 'O'; out[k++] = 'N'; out[k++] = 'G';
    while (d) out[k++] = digits[--d];
    out[k++] = '\n';
    vx_uart_write(s->uart, (const uint8_t*)out, k);
  }
  s->len = 0;
}

static void on_tx_done(void* ud) { (void)ud; }

void chip_setup(void) {
  chip_state_t* s = (chip_state_t*)calloc(1, sizeof(chip_state_t));
  vx_uart_config cfg;
  memset(&cfg, 0, sizeof(cfg));
  cfg.rx = vx_pin_register("RX", VX_INPUT);
  cfg.tx = vx_pin_register("TX", VX_INPUT_PULLUP);
  cfg.baud_rate = 115200;
  cfg.on_rx_byte = on_rx;
  cfg.on_tx_done = on_tx_done;
  cfg.user_data = s;
  s->uart = vx_uart_attach(&cfg);
}

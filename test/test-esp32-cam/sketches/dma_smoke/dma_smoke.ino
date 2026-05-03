// dma_smoke.ino — Phase-2 smoke test: drive I²S0 in slave-RX mode,
// arm a single DMA descriptor, wait for in_suc_eof IRQ, dump the
// first 32 bytes the QEMU model wrote.
//
// This sketch deliberately does NOT use esp32-camera. It pokes I²S0
// and the linked-list DMA registers directly so that any failure can
// be traced to (a) our QEMU device emulation, and (b) the
// registration of i2s0 in esp32_picsimlab.c — without the camera
// driver's helper layer obscuring which register hit.
//
// Expected on a working Phase-2 build:
//   "i2s_rx armed, eof_num=512"
//   "EOF after Nms"
//   "buf[0..31] = AA BB CC DD ..."   ← whatever the host pushed
//
// Today (Phase 1 only): the sketch hangs at the EOF-wait line because
// the i2s registers are still unimp.

#include <Arduino.h>
#include "esp_attr.h"
#include "soc/i2s_reg.h"
#include "soc/i2s_struct.h"
#include "soc/dport_reg.h"
#include "rom/lldesc.h"
#include "esp_intr_alloc.h"

#define BUF_LEN  1024
DMA_ATTR static uint8_t  s_buf[BUF_LEN];
DMA_ATTR static lldesc_t s_descr;

static volatile bool eof_seen = false;

static void IRAM_ATTR isr(void *) {
  if (I2S0.int_st.in_suc_eof) {
    I2S0.int_clr.in_suc_eof = 1;
    eof_seen = true;
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("velxio-dma-smoke boot");

  // Enable the I²S0 peripheral clock (DPORT.PERIP_CLK_EN.I2S0).
  // The exact register macros vary across IDF versions; using the raw
  // names so anyone reading this in 2027 can still grep for them.
  DPORT_SET_PERI_REG_MASK(DPORT_PERIP_CLK_EN_REG, DPORT_I2S0_CLK_EN);
  DPORT_CLEAR_PERI_REG_MASK(DPORT_PERIP_RST_EN_REG, DPORT_I2S0_RST);

  memset(s_buf, 0, sizeof(s_buf));
  s_descr.size   = BUF_LEN;
  s_descr.length = 0;
  s_descr.eof    = 0;
  s_descr.owner  = 1;
  s_descr.buf    = s_buf;
  s_descr.empty  = 0;          // next-link = NULL → single-descr ring

  // Reset RX path
  I2S0.conf.rx_start      = 0;
  I2S0.conf.rx_reset      = 1; I2S0.conf.rx_reset      = 0;
  I2S0.conf.rx_fifo_reset = 1; I2S0.conf.rx_fifo_reset = 0;
  I2S0.lc_conf.in_rst     = 1; I2S0.lc_conf.in_rst     = 0;
  I2S0.lc_conf.ahbm_fifo_rst = 1; I2S0.lc_conf.ahbm_fifo_rst = 0;
  I2S0.lc_conf.ahbm_rst   = 1; I2S0.lc_conf.ahbm_rst   = 0;

  // EOF threshold: 512 dma_elem_t's = 1024 bytes total
  I2S0.rx_eof_num    = 512;
  I2S0.in_link.addr  = ((uint32_t)&s_descr) & 0xFFFFF;
  I2S0.int_clr.val   = 0xFFFFFFFF;
  I2S0.int_ena.val   = 0;
  I2S0.int_ena.in_suc_eof = 1;

  esp_intr_alloc(ETS_I2S0_INTR_SOURCE, ESP_INTR_FLAG_IRAM,
                 &isr, NULL, NULL);

  I2S0.in_link.start = 1;
  I2S0.conf.rx_start = 1;

  Serial.printf("i2s_rx armed, eof_num=%u\n",
                (unsigned)I2S0.rx_eof_num);

  uint32_t t0 = millis();
  while (!eof_seen && millis() - t0 < 5000) { delay(5); }

  if (!eof_seen) {
    Serial.println("ERR: no EOF within 5s (Phase 2 not implemented?)");
    return;
  }

  Serial.printf("EOF after %ums\n", (unsigned)(millis() - t0));
  Serial.print("buf[0..31] = ");
  for (size_t i = 0; i < 32; ++i) {
    Serial.printf("%02X ", s_buf[i]);
  }
  Serial.println();
}

void loop() {
  delay(5000);
}

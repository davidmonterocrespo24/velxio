// frame_roundtrip.ino — proves that bytes pushed via the host-side
// velxio_push_camera_frame() symbol arrive in firmware memory through
// the QEMU I²S+DMA peripheral.
//
// Why a custom sketch instead of esp_camera_fb_get()? Two reasons:
//   1. The upstream esp_camera high-level API auto-probes I²C addresses
//      to identify the sensor model. The QEMU I²C controller's NACK
//      semantics confuse the auto-probe (it never advances past 0x21).
//   2. The framectrl FreeRTOS task in libesp32-camera consumes EOF
//      events continuously; my single-shot DMA emulator fires EOF once
//      per rx_start edge. Adapting that is Phase-3 follow-up work.
//
// Both blockers sit BETWEEN the QEMU device and the upstream library.
// The QEMU device itself is correct: this sketch drives I²S+DMA
// directly (same as dma_smoke.ino) and asserts that whatever bytes the
// host pushed via velxio_push_camera_frame() appear at the expected
// offsets, padded into dma_elem_t format (see autosearch/08).
//
// Wire format expected (per pack_two_pixels in esp32_i2s_cam.c):
//   buf[0] = 0x00            (low half of sample 1, padding)
//   buf[1] = jpeg[0]         (high half of sample 1, real pixel byte)
//   buf[2] = 0x00            (low half of sample 2, padding)
//   buf[3] = jpeg[1]         (high half of sample 2)
//   buf[4] = 0x00, buf[5] = jpeg[2], …
//
// The sketch prints "FRAME[0..63]: hh hh ..." with 64 hex bytes which
// the test parses to verify the JPEG SOI marker (0xFF 0xD8 …) survives
// the round-trip.

#include <Arduino.h>
#include "esp_attr.h"
#include "soc/i2s_reg.h"
#include "soc/i2s_struct.h"
#include "soc/dport_reg.h"
#include "rom/lldesc.h"
#include "esp_intr_alloc.h"

#define BUF_LEN 256                                /* 64 pixel bytes × 4 */
DMA_ATTR static uint8_t  s_buf[BUF_LEN];
DMA_ATTR static lldesc_t s_descr;

static volatile bool eof_seen = false;

static void IRAM_ATTR isr(void *) {
  if (I2S0.int_st.in_suc_eof) {
    I2S0.int_clr.in_suc_eof = 1;
    eof_seen = true;
  }
}

static void arm_capture() {
  memset(s_buf, 0, sizeof(s_buf));
  s_descr.size   = BUF_LEN;
  s_descr.length = 0;
  s_descr.eof    = 0;
  s_descr.owner  = 1;
  s_descr.buf    = s_buf;
  s_descr.empty  = 0;
  eof_seen       = false;

  I2S0.conf.rx_start         = 0;
  I2S0.conf.rx_reset         = 1; I2S0.conf.rx_reset         = 0;
  I2S0.conf.rx_fifo_reset    = 1; I2S0.conf.rx_fifo_reset    = 0;
  I2S0.lc_conf.in_rst        = 1; I2S0.lc_conf.in_rst        = 0;
  I2S0.lc_conf.ahbm_fifo_rst = 1; I2S0.lc_conf.ahbm_fifo_rst = 0;
  I2S0.lc_conf.ahbm_rst      = 1; I2S0.lc_conf.ahbm_rst      = 0;
  I2S0.rx_eof_num    = BUF_LEN / 4;        /* 64 dma_elem_t samples */
  I2S0.in_link.addr  = ((uint32_t)&s_descr) & 0xFFFFF;
  I2S0.int_clr.val   = 0xFFFFFFFF;
  I2S0.int_ena.val   = 0;
  I2S0.int_ena.in_suc_eof = 1;

  I2S0.in_link.start = 1;
  I2S0.conf.rx_start = 1;
}

void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.println("velxio-frame-roundtrip ready");

  DPORT_SET_PERI_REG_MASK(DPORT_PERIP_CLK_EN_REG, DPORT_I2S0_CLK_EN);
  DPORT_CLEAR_PERI_REG_MASK(DPORT_PERIP_RST_EN_REG, DPORT_I2S0_RST);

  esp_intr_alloc(ETS_I2S0_INTR_SOURCE, ESP_INTR_FLAG_IRAM,
                 &isr, NULL, NULL);

  // Wait for the host to push a frame (signals via Serial input).
  // The host pushes via velxio_push_camera_frame() before sending
  // the trigger byte — that way arm_capture() reads the queued bytes.
  Serial.println("WAITING_FOR_TRIGGER");
  while (!Serial.available()) {
    delay(50);
  }
  while (Serial.available()) Serial.read();    // drain
  Serial.println("TRIGGERED");

  arm_capture();

  uint32_t t0 = millis();
  while (!eof_seen && millis() - t0 < 5000) {
    delay(5);
  }
  if (!eof_seen) {
    Serial.println("ERR: no EOF within 5s");
    return;
  }
  Serial.printf("EOF_OK %ums\n", (unsigned)(millis() - t0));

  // Dump 64 bytes (= 16 dma_elem_t samples = 32 pixel bytes) so the
  // test can find the JPEG SOI marker (0xFF 0xD8 …) at byte offsets
  // 1, 3, 5, 7, …
  Serial.print("FRAME[0..63]:");
  for (size_t i = 0; i < 64; ++i) {
    Serial.printf(" %02X", s_buf[i]);
  }
  Serial.println();
  Serial.println("DONE");
}

void loop() {
  delay(5000);
}

// sccb_probe.ino — minimal sketch that ONLY does the OV2640 chip detect
// over the ESP32 hardware I²C controller. No I²S, no DMA, no DVP.
//
// This is the cleanest test for Phase 1 (autosearch/07): an OV2640
// QEMU device that answers SCCB reads. If this sketch prints
// "PID=0x26 VER=0x42 MIDH=0xa2 MIDL=0x7f" we know the bank-select +
// chip-id registers work. Anything else fails the layer.
//
// Why not use esp_camera_init() for this layer? Because it ALSO
// configures I²S/DMA/PCLK before reading the chip ID, and any of
// those steps failing in QEMU would mask whether the SCCB itself
// works. We isolate.

#include <Arduino.h>
#include <Wire.h>

// AI-Thinker ESP32-CAM SCCB pinout (matches camera_init.ino).
#define SIOD_GPIO_NUM   26
#define SIOC_GPIO_NUM   27
#define OV2640_ADDR     0x30          // 7-bit slave addr

static uint8_t sccb_read(uint8_t reg) {
  Wire.beginTransmission(OV2640_ADDR);
  Wire.write(reg);
  Wire.endTransmission(false);        // restart, not stop
  Wire.requestFrom((int)OV2640_ADDR, 1, true);
  return Wire.available() ? Wire.read() : 0xFF;
}

static bool sccb_write(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(OV2640_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.println("velxio-sccb-probe boot");

  Wire.begin(SIOD_GPIO_NUM, SIOC_GPIO_NUM, 100000);

  // Select sensor bank (FF=0x01) per OV2640 datasheet.
  if (!sccb_write(0xFF, 0x01)) {
    Serial.println("ERR: bank select write failed");
    return;
  }
  uint8_t pid  = sccb_read(0x0A);
  uint8_t ver  = sccb_read(0x0B);
  uint8_t midh = sccb_read(0x1C);
  uint8_t midl = sccb_read(0x1D);

  Serial.printf("PID=0x%02X VER=0x%02X MIDH=0x%02X MIDL=0x%02X\n",
                pid, ver, midh, midl);

  if (pid == 0x26 && ver == 0x42 && midh == 0xA2 && midl == 0x7F) {
    Serial.println("OV2640 detected");
  } else {
    Serial.println("OV2640 NOT detected");
  }
}

void loop() {
  delay(2000);
}

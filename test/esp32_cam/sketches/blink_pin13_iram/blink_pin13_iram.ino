/**
 * blink_pin13_iram.ino — IRAM-safe blink on GPIO13 for lcgamboa esp32-picsimlab QEMU.
 *
 * Control firmware for the ESP32-CAM regression test (issue #129). Same
 * scenario as blink_pin13.ino but written so it survives the periodic flash
 * cache disable (WiFi/BT init on core 1) that crashes the Arduino-API
 * version. If THIS sketch toggles GPIO13 and the user sketch does not, the
 * regression is confirmed to be the cache-unsafe Arduino runtime, not the
 * GPIO13 routing through the bridge.
 *
 * Conventions follow blink_lcgamboa.ino:
 *   - All code lives in IRAM (IRAM_ATTR)
 *   - String literals live in DRAM (DRAM_ATTR)
 *   - Direct GPIO register writes (no Arduino helpers)
 *   - ets_delay_us() ROM busy-wait (no FreeRTOS scheduler)
 *   - esp_rom_printf() instead of Serial
 *
 * Compile (esp32cam variant, FlashMode dio):
 *   arduino-cli compile \
 *     --fqbn esp32:esp32:esp32cam:FlashMode=dio \
 *     --output-dir test/esp32_cam/out_blink_pin13_iram \
 *     test/esp32_cam/sketches/blink_pin13_iram
 *
 * Merge to 4 MB image lcgamboa expects:
 *   esptool.py --chip esp32 merge_bin --fill-flash-size 4MB \
 *     -o test/esp32_cam/binaries/blink_pin13_iram.merged.bin \
 *     --flash_mode dio --flash_size 4MB \
 *     0x1000  test/esp32_cam/out_blink_pin13_iram/blink_pin13_iram.ino.bootloader.bin \
 *     0x8000  test/esp32_cam/out_blink_pin13_iram/blink_pin13_iram.ino.partitions.bin \
 *     0x10000 test/esp32_cam/out_blink_pin13_iram/blink_pin13_iram.ino.bin
 */

#define GPIO_OUT_W1TS    (*((volatile uint32_t*)0x3FF44008))  // set bits HIGH
#define GPIO_OUT_W1TC    (*((volatile uint32_t*)0x3FF4400C))  // set bits LOW
#define GPIO_ENABLE_W1TS (*((volatile uint32_t*)0x3FF44020))  // enable output

#define LED_BIT (1u << 13)  // GPIO13 — same pin issue #129 reports broken

extern "C" {
    void ets_delay_us(uint32_t us);
    int  esp_rom_printf(const char* fmt, ...);
}

static const char DRAM_ATTR s_start[] = "BLINK_PIN13_IRAM_STARTED\n";
static const char DRAM_ATTR s_on[]    = "PIN13_HIGH\n";
static const char DRAM_ATTR s_off[]   = "PIN13_LOW\n";
static const char DRAM_ATTR s_done[]  = "BLINK_PIN13_IRAM_DONE\n";

void IRAM_ATTR setup() {
    GPIO_ENABLE_W1TS = LED_BIT;
    esp_rom_printf(s_start);

    for (int i = 0; i < 5; i++) {
        GPIO_OUT_W1TS = LED_BIT;
        esp_rom_printf(s_on);
        ets_delay_us(300000);

        GPIO_OUT_W1TC = LED_BIT;
        esp_rom_printf(s_off);
        ets_delay_us(300000);
    }

    esp_rom_printf(s_done);
}

void IRAM_ATTR loop() {
    ets_delay_us(1000000);
}

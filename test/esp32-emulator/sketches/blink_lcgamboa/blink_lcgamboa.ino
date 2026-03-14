/**
 * blink_lcgamboa.ino — IRAM-safe blink for lcgamboa esp32-picsimlab QEMU machine.
 *
 * The lcgamboa machine runs WiFi/BT init on core 1 which periodically disables
 * the SPI flash cache. Any code or data in IROM/DROM (flash cache) will crash
 * with "Cache disabled but cached memory region accessed" when that happens.
 *
 * Solution:
 *   - ALL functions tagged IRAM_ATTR (placed in SRAM, not flash)
 *   - ALL string constants tagged DRAM_ATTR (placed in SRAM, not flash)
 *   - Use esp_rom_printf() (ROM function, no cache needed) instead of Serial
 *   - Use direct GPIO register writes instead of Arduino/IDF cached helpers
 *   - Use ets_delay_us() (ROM function) instead of delay()
 */

// Direct GPIO register access (ESP32 TRM chapter 4)
#define GPIO_OUT_W1TS     (*((volatile uint32_t*)0x3FF44008))  // set bits HIGH
#define GPIO_OUT_W1TC     (*((volatile uint32_t*)0x3FF4400C))  // set bits LOW
#define GPIO_ENABLE_W1TS  (*((volatile uint32_t*)0x3FF44020))  // enable output

#define LED_BIT  (1u << 2)   // GPIO2

extern "C" {
    void ets_delay_us(uint32_t us);
    int  esp_rom_printf(const char* fmt, ...);
}

// String constants in DRAM (not DROM flash cache)
static const char DRAM_ATTR s_start[] = "LCGAMBOA_STARTED\n";
static const char DRAM_ATTR s_on[]    = "LED_ON\n";
static const char DRAM_ATTR s_off[]   = "LED_OFF\n";
static const char DRAM_ATTR s_done[]  = "BLINK_DONE\n";

void IRAM_ATTR setup() {
    GPIO_ENABLE_W1TS = LED_BIT;          // GPIO2 → output

    esp_rom_printf(s_start);

    for (int i = 0; i < 5; i++) {
        GPIO_OUT_W1TS = LED_BIT;         // HIGH
        esp_rom_printf(s_on);
        ets_delay_us(300000);            // 300 ms (ROM busy-wait, cache-safe)

        GPIO_OUT_W1TC = LED_BIT;         // LOW
        esp_rom_printf(s_off);
        ets_delay_us(300000);
    }

    esp_rom_printf(s_done);
}

void IRAM_ATTR loop() {
    ets_delay_us(1000000);               // idle 1 s, no flash access
}

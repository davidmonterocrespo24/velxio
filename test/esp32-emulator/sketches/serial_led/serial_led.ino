/**
 * serial_led.ino — ESP32 firmware for Arduino+ESP32 serial integration test.
 *
 * Listens on UART0 (Serial / GPIO1=TX, GPIO3=RX) for commands from an Arduino Uno:
 *   "LED_ON\n"  → turn GPIO2 LED on,  reply "OK:ON\n"
 *   "LED_OFF\n" → turn GPIO2 LED off, reply "OK:OFF\n"
 *   "PING\n"    → reply "PONG\n"  (connection check)
 *
 * Unknown commands are silently ignored (no crash).
 *
 * ── Compile (arduino-esp32 2.0.17) ────────────────────────────────────────
 *   arduino-cli compile \
 *     --fqbn esp32:esp32:esp32:FlashMode=dio \
 *     --output-dir test/esp32-emulator/out_serial_led \
 *     test/esp32-emulator/sketches/serial_led
 *
 * ── Merge to 4 MB flash image required by QEMU ────────────────────────────
 *   esptool.py --chip esp32 merge_bin --fill-flash-size 4MB \
 *     -o test/esp32-emulator/binaries_lcgamboa/serial_led.ino.merged.bin \
 *     --flash_mode dio --flash_size 4MB \
 *     0x1000  test/esp32-emulator/out_serial_led/serial_led.ino.bootloader.bin \
 *     0x8000  test/esp32-emulator/out_serial_led/serial_led.ino.partitions.bin \
 *     0x10000 test/esp32-emulator/out_serial_led/serial_led.ino.bin
 *
 * ── GPIO pinmap in lcgamboa ────────────────────────────────────────────────
 *   Identity mapping: pinmap position i → GPIO (i-1).
 *   GPIO2 → position 3 in the pinmap → picsimlab_write_pin(pin=3, value).
 *   In the Python test / Esp32LibBridge: gpio_change events arrive as pin=2.
 */

#define LED_PIN 2

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  // Small delay so QEMU UART listener is ready before we write
  delay(100);
  Serial.println("READY");
}

void loop() {
  if (Serial.available() > 0) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();

    if (cmd == "LED_ON") {
      digitalWrite(LED_PIN, HIGH);
      Serial.println("OK:ON");
    } else if (cmd == "LED_OFF") {
      digitalWrite(LED_PIN, LOW);
      Serial.println("OK:OFF");
    } else if (cmd == "PING") {
      Serial.println("PONG");
    }
    // Unknown commands silently ignored
  }
}

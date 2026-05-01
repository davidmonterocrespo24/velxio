// Verbatim repro of the failing sketch reported in
// https://github.com/davidmonterocrespo24/velxio/issues/129
//
// Symptom: on the ESP32-CAM board the LED wired to pin 13 never lights or
// blinks. The user notes voltage is measurable at the pin but no toggling.
//
// This sketch uses the Arduino runtime (pinMode/digitalWrite/delay). On the
// lcgamboa esp32-picsimlab QEMU machine those helpers live in cached flash
// regions which are temporarily disabled while WiFi/BT init runs on core 1
// — accessing them then crashes the firmware before the first toggle.
//
// Compile (FQBN must match esp32-cam, FlashMode dio):
//   arduino-cli compile \
//     --fqbn esp32:esp32:esp32cam:FlashMode=dio \
//     --output-dir test/esp32_cam/out_blink_pin13 \
//     test/esp32_cam/sketches/blink_pin13
//
// Merge to the 4 MB image lcgamboa expects:
//   esptool.py --chip esp32 merge_bin --fill-flash-size 4MB \
//     -o test/esp32_cam/binaries/blink_pin13.merged.bin \
//     --flash_mode dio --flash_size 4MB \
//     0x1000  test/esp32_cam/out_blink_pin13/blink_pin13.ino.bootloader.bin \
//     0x8000  test/esp32_cam/out_blink_pin13/blink_pin13.ino.partitions.bin \
//     0x10000 test/esp32_cam/out_blink_pin13/blink_pin13.ino.bin

#define LED_PIN 13

void setup() {
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_PIN, HIGH);
  delay(1000);
  digitalWrite(LED_PIN, LOW);
  delay(1000);
}

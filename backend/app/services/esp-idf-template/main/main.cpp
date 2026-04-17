/**
 * Arduino-as-ESP-IDF-component wrapper.
 *
 * The build system copies the user's .ino sketch as "sketch.ino.cpp" into
 * this directory.  initArduino() initializes the Arduino runtime (GPIO,
 * Serial, WiFi, etc.) and then we call the user's setup()/loop().
 */
#include "Arduino.h"
#include "sketch.ino.cpp"

extern "C" void app_main(void) {
    initArduino();
    setup();
    while (true) {
        loop();
        vTaskDelay(1);
    }
}

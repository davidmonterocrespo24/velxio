/**
 * Arduino-as-ESP-IDF-component wrapper.
 *
 * The espidf_compiler writes the user's entry .ino as "sketch.ino.cpp"
 * into this directory and drops every helper .h/.cpp alongside it.
 * The CMakeLists.txt globs *.cpp/*.c into SRCS, so each TU compiles
 * standalone — setup() and loop() are defined exactly once across the
 * link (in sketch.ino.cpp) and we just call them from the loop task with
 * a forward declaration.
 *
 * Note: do NOT switch this back to `#include "sketch.ino.cpp"` — the
 * textual include would re-define setup()/loop() inside this TU as
 * well, fighting the standalone sketch.ino.cpp.obj for the symbol
 * and tripping the linker with "multiple definition of `setup'".
 *
 * setup() and loop() run in a task of their own, as the Arduino core's
 * main.cpp does (that one is compiled out here: CONFIG_AUTOSTART_ARDUINO is
 * off): on ARDUINO_RUNNING_CORE, which is "Arduino runs on core" in Board
 * Options (core 1 by default, as in the Arduino IDE), with the core's loop
 * stack (CONFIG_ARDUINO_LOOP_STACK_SIZE, 8 KB, or what the sketch asks for
 * with SET_LOOP_TASK_STACK_SIZE). Until 2026-11 they ran in app_main itself,
 * on core 0 whatever the option said, so a sketch that pinned its own task to
 * core 0 (the Arduino IDE leaves that core to the sketch) shared it with
 * loop() and ran at half speed on the board.
 *
 * VELXIO_LOOP_YIELD: in the simulator every pass of loop() ends with a
 * one-tick sleep, so a sketch polling in a tight loop lets the emulator idle.
 * A build for a real board (for_hardware) has the compiler write 0 below:
 * loop() then runs back to back as in the Arduino IDE, which on a single core
 * still lets the idle task in every 2 s, as the Arduino core does.
 */
#include "Arduino.h"

#define VELXIO_LOOP_YIELD 1

void setup();
void loop();

// Defined by the Arduino core (cores/esp32/main.cpp), outside the block that
// AUTOSTART compiles out; enableLoopWDT() and friends read it.
extern TaskHandle_t loopTaskHandle;

#ifndef ARDUINO_LOOP_STACK_SIZE
#ifdef CONFIG_ARDUINO_LOOP_STACK_SIZE
#define ARDUINO_LOOP_STACK_SIZE CONFIG_ARDUINO_LOOP_STACK_SIZE
#else
#define ARDUINO_LOOP_STACK_SIZE 8192
#endif
#endif

// The core's own default sits in the block AUTOSTART compiles out. A sketch's
// SET_LOOP_TASK_STACK_SIZE(n) defines this one strongly and wins.
__attribute__((weak)) size_t getArduinoLoopTaskStackSize(void) {
    return ARDUINO_LOOP_STACK_SIZE;
}

#if !CONFIG_FREERTOS_UNICORE && defined(CONFIG_ARDUINO_RUNNING_CORE)
#define VELXIO_LOOP_CORE ARDUINO_RUNNING_CORE
#else
#define VELXIO_LOOP_CORE 0  // one core: xTaskCreateUniversal ignores it
#endif

static void velxioLoopTask(void *) {
    setup();
    for (;;) {
        loop();
#if VELXIO_LOOP_YIELD
        vTaskDelay(1);
#elif CONFIG_FREERTOS_UNICORE
        static uint32_t lastYield = 0;
        if (millis() - lastYield > 2000) {
            lastYield = millis();
            vTaskDelay(5);
        }
#endif
    }
}

extern "C" void app_main(void) {
    initArduino();
    xTaskCreateUniversal(velxioLoopTask, "loopTask", getArduinoLoopTaskStackSize(), NULL, 1,
                         &loopTaskHandle, VELXIO_LOOP_CORE);
}

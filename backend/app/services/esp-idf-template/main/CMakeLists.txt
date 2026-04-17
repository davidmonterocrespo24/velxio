# If Arduino component is available, use C++ main and link Arduino.
# The component name matches the directory basename of ARDUINO_ESP32_PATH
# (e.g. "arduino-esp32" when cloned from GitHub).
if(DEFINED ENV{ARDUINO_ESP32_PATH})
    get_filename_component(_arduino_comp_name $ENV{ARDUINO_ESP32_PATH} NAME)
    idf_component_register(
        SRCS "main.cpp"
        INCLUDE_DIRS "."
        REQUIRES ${_arduino_comp_name}
    )
else()
    # Pure ESP-IDF mode: main.c #includes sketch_translated.c
    idf_component_register(
        SRCS "main.c"
        INCLUDE_DIRS "."
    )
endif()

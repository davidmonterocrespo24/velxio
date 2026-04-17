cmake_minimum_required(VERSION 3.16)

# Arduino as ESP-IDF component (optional — only if ARDUINO_ESP32_PATH is set)
if(DEFINED ENV{ARDUINO_ESP32_PATH})
    set(EXTRA_COMPONENT_DIRS $ENV{ARDUINO_ESP32_PATH})
endif()

# User libraries — each subdirectory is a proper IDF component generated at build time
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/user_libs")
    list(APPEND EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_SOURCE_DIR}/user_libs")
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(velxio-sketch)

# If Arduino component is available, use C++ main and link Arduino.
# The component name matches the directory basename of ARDUINO_ESP32_PATH
# (e.g. "arduino-esp32" when cloned from GitHub).
if(DEFINED ENV{ARDUINO_ESP32_PATH})
    get_filename_component(_arduino_comp_name $ENV{ARDUINO_ESP32_PATH} NAME)

    # arduino-esp32 ships esp32-camera as a precompiled static lib but does
    # NOT export its headers from its main CMakeLists. Sketches that
    # #include "esp_camera.h" therefore fail to compile under the IDF
    # build path. We add the bundled headers to the main component's
    # INCLUDE_DIRS unconditionally — harmless for non-camera sketches and
    # the only reliable path for camera sketches under our QEMU pipeline.
    # Normalize Windows backslashes → forward slashes; otherwise CMake
    # parses the resulting paths as escape sequences (\E, \U etc).
    file(TO_CMAKE_PATH "$ENV{ARDUINO_ESP32_PATH}" _arduino_path_norm)
    set(_cam_root "${_arduino_path_norm}/tools/sdk/${IDF_TARGET}/include/esp32-camera")
    set(_cam_includes "")
    if(EXISTS "${_cam_root}/driver/include")
        list(APPEND _cam_includes "${_cam_root}/driver/include")
    endif()
    if(EXISTS "${_cam_root}/conversions/include")
        list(APPEND _cam_includes "${_cam_root}/conversions/include")
    endif()

    idf_component_register(
        SRCS "main.cpp"
        INCLUDE_DIRS "." ${_cam_includes}
        # `driver` brings in the i2c_master_* + i2c_cmd_link_* symbols
        # libesp32-camera.a's sccb.c references at link time. arduino-esp32
        # doesn't transitively expose it, so we name it here.
        REQUIRES ${_arduino_comp_name} driver
    )

    # Link the precompiled libesp32-camera.a so esp_camera_init / fb_get
    # symbols resolve at link time. The .a ships under the same arduino-esp32
    # tree; if it is missing (older bundle) we silently skip.
    # Use ESP-IDF's add_prebuilt_library so cmake creates a proper imported
    # target with REQUIRES for driver (the .a depends on i2c_master_* +
    # i2c_cmd_link_*) — that way the linker resolves the cross-lib refs.
    # target_link_libraries with INTERFACE doesn't propagate REQUIRES, which
    # is why a bare .a link fails with "undefined reference to i2c_master_…".
    set(_cam_lib "${_arduino_path_norm}/tools/sdk/${IDF_TARGET}/lib/libesp32-camera.a")
    if(EXISTS "${_cam_lib}")
        add_prebuilt_library(esp32_camera_prebuilt "${_cam_lib}"
            REQUIRES driver ${_arduino_comp_name})
        target_link_libraries(${COMPONENT_LIB} PUBLIC esp32_camera_prebuilt)
    endif()

    # arduino-esp32 v2.x's generic `esp32` variant pins_arduino.h does NOT
    # define LED_BUILTIN, so the default Arduino Blink sketch (which Velxio
    # ships in every new project) fails to compile with
    #   error: 'LED_BUILTIN' was not declared in this scope
    # Provide a fallback so sketches "just compile". GPIO 2 is the
    # convention on most ESP32 dev boards (DOIT, NodeMCU, Wemos D1 R32);
    # for ESP32-CAM where GPIO 2 isn't broken out, the user should use an
    # explicit pin number — but this default keeps the new-project flow
    # smooth.
    target_compile_definitions(${COMPONENT_LIB} PRIVATE
        "LED_BUILTIN=2")
else()
    # Pure ESP-IDF mode: main.c #includes sketch_translated.c
    idf_component_register(
        SRCS "main.c"
        INCLUDE_DIRS "."
    )
endif()

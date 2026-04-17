# ESP32 External Arduino Library Compilation — IDF Component Approach

> **Scope**: This document covers the full investigation and implementation of automatic
> external Arduino library inclusion when compiling ESP32 sketches via ESP-IDF.
> Target audience: future maintainers who need to understand *why* the library resolution
> works the way it does and what bugs were discovered during real compilation testing.

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Root Cause](#root-cause)
3. [Solution Architecture](#solution-architecture)
4. [Implementation Details](#implementation-details)
5. [Bugs Found During Real Compilation](#bugs-found-during-real-compilation)
6. [Error Visibility Improvements](#error-visibility-improvements)
7. [Test Coverage](#test-coverage)
8. [Files Changed](#files-changed)

---

## Problem Statement

When compiling an ESP32 sketch that uses an external library (e.g. the DHT22 temperature
sensor example with `#include <DHT.h>`), the build failed with:

```
fatal error: DHT.h: No such file or directory
```

For **Arduino UNO**, `arduino-cli` automatically scans `~/Arduino/libraries/` and adds
the correct `-I` flags. For **ESP32 via ESP-IDF**, that path is never scanned — ESP-IDF
only knows about components explicitly listed in `EXTRA_COMPONENT_DIRS`.

Additionally, even when an error did occur, it was **invisible in the UI**: ninja build
errors go to **stdout** (not stderr), so the frontend was classifying them as grey `info`
lines instead of red `error` lines.

---

## Root Cause

ESP-IDF uses a CMake-based component system. Every unit of code must be a registered
**IDF component** with its own `CMakeLists.txt` calling `idf_component_register()`.
The `arduino-esp32` library itself is included this way. External Arduino libraries
(installed via `arduino-cli` Library Manager into `~/Arduino/libraries/`) have no
`idf_component_register()` and are therefore invisible to the build system.

The naive fix of copying `.h`/`.cpp` files flat into `main/` breaks libraries that use
subdirectory structures for internal includes (e.g. `#include "utility/xyz.h"`).

---

## Solution Architecture

Each external Arduino library is wrapped as a proper ESP-IDF component:

```
project/
  CMakeLists.txt              ← adds user_libs/ to EXTRA_COMPONENT_DIRS
  user_libs/
    DHT_sensor_library/
      CMakeLists.txt          ← idf_component_register(SRCS ... REQUIRES arduino-esp32)
      DHT.h
      DHT.cpp
      DHT_U.h
      DHT_U.cpp
    Adafruit_Unified_Sensor/  ← transitive dependency, auto-discovered
      CMakeLists.txt
      Adafruit_Sensor.h
      Adafruit_Sensor.cpp
  main/
    CMakeLists.txt            ← REQUIRES arduino-esp32 DHT_sensor_library Adafruit_Unified_Sensor
    main.cpp
    sketch.ino.cpp
```

ESP-IDF automatically compiles every subdirectory of `EXTRA_COMPONENT_DIRS` that contains
an `idf_component_register()` call. The `INCLUDE_DIRS "."` inside each component makes its
headers available to anything that `REQUIRES` it.

### Library Search Order

1. `$ARDUINO_ESP32_PATH/libraries/` — ESP32-native libs bundled with arduino-esp32 (WiFi,
   BLE, EEPROM…) — already compiled as part of arduino-esp32 component, so usually skipped
2. `~/Documents/Arduino/libraries/` — user-installed libraries (Windows primary path)
3. `~/Arduino/libraries/` — alternate user path
4. `/root/Arduino/libraries/` — Docker / CI root user path

---

## Implementation Details

### `_detect_external_includes(code)`

Scans source code for `#include <Header.h>` directives and returns those that are NOT:
- Arduino/ESP32 built-ins (e.g. `Arduino.h`, `Wire.h`, `WiFi.h`, `esp_wifi.h`)
- Headers with `/` (ESP-IDF internal paths like `freertos/FreeRTOS.h`)
- ESP-IDF pattern prefixes (`esp_`, `driver/`, `soc/`, `hal/`, `nvs`, `rom/`)

### `_find_library_for_header(header, libs_dir)`

Iterates subdirectories of `libs_dir`, checking both the root and `src/` subdirectory
for the requested header. Returns the **source root** (either `lib_dir/` or `lib_dir/src/`).

### `_create_idf_component(header, src_root, user_libs_dir, arduino_comp_name)`

Creates `user_libs/<safe_name>/` with:
- All `.h`, `.cpp`, `.c` files copied flat from `src_root`
- A generated `CMakeLists.txt`:
  ```cmake
  idf_component_register(
      SRCS "DHT.cpp" "DHT_U.cpp"
      INCLUDE_DIRS "."
      REQUIRES arduino-esp32
  )
  ```
- Returns the component directory name (e.g. `DHT_sensor_library`)

### Transitive Dependency Resolution (BFS)

The library resolution loop uses **breadth-first search**:

1. **Phase 1 — BFS discovery**: Start with headers found in the user sketch. After creating
   each component, scan its copied `.h` files for further external includes. Enqueue any
   new headers not yet resolved. Repeat until the queue is empty.
   A `header_to_comp` dict tracks which component provides each header.

2. **Phase 2 — inter-component REQUIRES**: After all components are created, scan each
   component's headers again. For any dependency that maps to another component in
   `header_to_comp`, patch that component's `CMakeLists.txt` to add the dep to `REQUIRES`.

This ensures `DHT_sensor_library/CMakeLists.txt` ends up with:
```cmake
REQUIRES arduino-esp32 Adafruit_Unified_Sensor
```

### Main `CMakeLists.txt` Patching

The template `main/CMakeLists.txt` uses a CMake variable:
```cmake
REQUIRES ${_arduino_comp_name}
```

The Python patch looks for this exact string (not the resolved literal `arduino-esp32`)
and appends the user library component names:
```cmake
REQUIRES ${_arduino_comp_name} DHT_sensor_library Adafruit_Unified_Sensor
```

---

## Bugs Found During Real Compilation

Three bugs were discovered when running an actual ESP32 compile (vs. unit tests with mocks):

### Bug 1 — Wrong Component Name (`libraries` instead of `DHT_sensor_library`)

**Symptom**: Build step showed `esp-idf/libraries/CMakeFiles/...` instead of
`esp-idf/DHT_sensor_library/CMakeFiles/...`.

**Cause**: `_create_idf_component` used `src_root.parent.name` to get the library name.
When `_find_library_for_header` returns the library root (no `src/` subdir), `src_root`
*is* the library directory, so `.parent.name` gives `libraries` (the parent search dir).

**Fix**:
```python
# Before
lib_dir_name = src_root.parent.name

# After
lib_dir_name = src_root.parent.name if src_root.name == 'src' else src_root.name
```

### Bug 2 — Missing Transitive Dependency (`Adafruit_Sensor.h`)

**Symptom**: After fixing Bug 1, the build failed with:
```
DHT_U.h:36:10: fatal error: Adafruit_Sensor.h: No such file or directory
```

**Cause**: `DHT_U.h` (part of DHT library) `#include`s `Adafruit_Sensor.h` from the
`Adafruit_Unified_Sensor` library. The original code only scanned the user sketch for
external includes, not the library headers themselves.

**Fix**: Added BFS transitive dependency resolution (Phase 1 + Phase 2 described above).

### Bug 3 — CMake Template Variable Mismatch

**Symptom**: After fixing Bugs 1 and 2, the `main` component still couldn't find `DHT.h`:
```
sketch.ino.cpp:3:10: fatal error: DHT.h: No such file or directory
```

**Cause**: The Python patch looked for `REQUIRES arduino-esp32` (literal) in
`main/CMakeLists.txt`, but the template uses `REQUIRES ${_arduino_comp_name}` (CMake
variable). The replacement was silently a no-op.

**Fix**: Updated the patch to match the CMake variable syntax:
```python
for old_req in [r'REQUIRES ${_arduino_comp_name}', f'REQUIRES {arduino_comp_name}']:
    if old_req in cmake_text:
        cmake_text = cmake_text.replace(old_req, f'{old_req} {main_reqs}')
        break
```

---

## Error Visibility Improvements

Two frontend/backend changes were made to ensure compilation errors are clearly visible:

### Backend — Ninja Error Extraction

When ESP-IDF/ninja fails, compiler errors go to **stdout** (not stderr). The backend now
detects `FAILED:` blocks in stdout and moves them to the `stderr` field of the response,
so the frontend classifies them as errors:

```python
if stripped.startswith('FAILED:') or stripped == 'ninja: build stopped: subcommand failed.':
    in_failed_block = True
    # ... extract and move to stderr
```

### Frontend — Compilation Console Auto-Filter

`CompilationConsole.tsx` now:
- Tracks previous log count with `prevLogsLenRef`
- Detects newly arrived error logs via `useEffect`
- Automatically switches the filter to **"Errors"** view when new errors arrive

`compilationLogger.ts` classifies stdout lines in ninja `FAILED:` blocks as `'error'`
type (not `'info'`), using a state machine (`inFailedBlock` flag).

---

## Test Coverage

`backend/test_espidf_compiler.py` — 25 unit tests, no ESP-IDF toolchain required:

| Class | Tests | What it covers |
|---|---|---|
| `TestDetectExternalIncludes` | 8 | DHT.h detected; Arduino.h, Wire.h, esp_* skipped; path headers skipped |
| `TestFindLibraryForHeader` | 4 | Root layout, `src/` layout, missing library, empty dir |
| `TestCreateIdfComponent` | 11 | Dir created, CMakeLists.txt content, files copied, name sanitization, correct library name |
| `TestTemplateCMakeLists` | 2 | Template files contain `user_libs` block and `REQUIRES` placeholder |

Run from `backend/`:
```bash
python test_espidf_compiler.py
```

---

## Files Changed

| File | Change |
|---|---|
| `backend/app/services/espidf_compiler.py` | Added `_detect_external_includes`, `_find_library_for_header`, `_create_idf_component`; BFS transitive dep resolution; CMake patching fixes |
| `backend/app/services/esp-idf-template/CMakeLists.txt` | Added `user_libs/` to `EXTRA_COMPONENT_DIRS` via `EXISTS` guard |
| `frontend/src/utils/compilationLogger.ts` | Ninja `FAILED:` block state machine; classifies lines as `'error'` |
| `frontend/src/components/editor/CompilationConsole.tsx` | Auto-switches to Errors filter when new errors arrive |
| `backend/test_espidf_compiler.py` | 25-test suite covering all library resolution logic |

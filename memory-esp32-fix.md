# ESP32 Compilation Fix - Session Memory

## Problem
When adding an ESP32 board and compiling, Velxio was compiling the default Blink sketch (with LED_BUILTIN) instead of the user's actual code. The error showed:
```
/tmp/espidf_*/project/main/sketch.ino.cpp:4:11: error: 'LED_BUILTIN' was not declared in this scope
  pinMode(LED_BUILTIN, OUTPUT);
```

## Root Cause
Velxio uses isolated file groups per board. When adding a new ESP32 board:
1. A new file group `group-esp32-xxx` was created with default Blink sketch content
2. The editor stayed on the previous board's file group (e.g., `group-arduino-uno`)
3. User pasted code into the wrong file group
4. Compilation used the ESP32's file group which still had the Blink sketch

## Fix Applied
Modified `frontend/src/store/useSimulatorStore.ts` in the `addBoard()` function (line 612-614):

```typescript
// Switch to the new board (this also switches the editor to the board's file group)
console.log(`[addBoard] Switching to new board ${id} and its file group group-${id}`);
get().setActiveBoardId(id);
```

This ensures the editor switches to the new board's file group immediately after creation.

## Commits on dev branch
1. `85c5eb0` - Debug: Add logging to trace file group sync issues
2. `aa57234` - fix: Auto-switch to new board's file group when adding a board

## Also Important
- Cherry-picked PR #114 (commit `7fc15e8`) for ESP-IDF library structure preservation
- Created `build-dev.sh` script for easier development workflow

## Testing After Rebuild
1. Open http://localhost:3080
2. Add ESP32 board
3. Check console for: `[addBoard] Switching to new board...`
4. Verify CodeEditor shows `group-esp32-xxx` not `group-arduino-uno`
5. Paste code and compile - should use user's code, not Blink sketch

## Key Files
- `frontend/src/store/useSimulatorStore.ts` - Main fix location
- `frontend/src/store/useEditorStore.ts` - File group management
- `build-dev.sh` - Development script (rebuild, logs, shell, etc.)

# 12 — Descriptor walker fix + frontend Run integration

Follow-up to `11_blockers_resolved.md`. Documents the root cause of
`esp_camera_fb_get()` returning NULL and the multi-descriptor walker
fix that should unblock it.

## Bug found in `walk_dma_chain` — single-descriptor fill

### Diagnosis

The driver configures the I²S DMA at `ll_cam.c:287`:

```c
I2S0.rx_eof_num = cam->dma_half_buffer_size / sizeof(dma_elem_t);
```

With cam_hal's typical defaults for QVGA-JPEG:
- `dma_node_buffer_size = 2048` bytes per descriptor
- `dma_half_buffer_size = 4096` bytes per EOF
- `sizeof(dma_elem_t) = 4`
- → `rx_eof_num = 1024` samples per EOF

So one EOF spans **two** descriptors (each holding 512 samples = 2048
bytes). My original `walk_dma_chain` only filled ONE descriptor before
firing EOF — the firmware then saw an EOF with half the expected data,
half-buffer pointer indexing went off, and the SOI check on the first
chunk silently failed (cam_hal exits READ_BUF state without logging).

This explains why every other piece of the stack tested fine in
isolation but `fb_get` still returned NULL — the gating constraint was
the per-EOF sample count, not bit-packing or VSYNC timing.

### Fix

`hw/misc/esp32_i2s_cam.c::walk_dma_chain` rewritten to walk forward
through the descriptor ring filling owner=1 descriptors until
`samples_written >= target_samples`. Only the LAST filled descriptor
gets `eof=1`; the others get `eof=0` but are still released to CPU
(owner=0). The `in_suc_eof` IRQ fires only after the threshold is
crossed.

If the walker hits an owner=0 descriptor before reaching the target,
it returns without firing EOF — the next tick continues from where
this one left off. This matches real I²S semantics where DMA stalls
when no descriptor is available and resumes when CPU releases one.

Reference: [esp32-camera/target/esp32/ll_cam.c:287](https://github.com/espressif/esp32-camera/blob/master/target/esp32/ll_cam.c#L287)

### Verification (pending)

The fix needs the QEMU DLL to be rebuilt and the
`webcam_demo.ino` test re-run. Expected outcome:
- `cam_task` advances IDLE → READ_BUF on first VSYNC
- First EOF arrives with 4096 bytes (1024 samples) of JPEG data
- SOI check on cnt==0 succeeds (frame starts with `0xFF 0xD8`)
- Subsequent EOFs accumulate
- Second VSYNC closes the frame and pushes to `frame_buffer_queue`
- `esp_camera_fb_get()` returns a valid `camera_fb_t*`

## Frontend Run-button fix (orthogonal)

`EditorToolbar.tsx::handleRun` had `isQemuBoard` checking only the
exact strings `'esp32'` and `'esp32-s3'`. ESP32-CAM (`'esp32-cam'`)
fell through to the AVR-style auto-compile path and never called
`startBoard()`. List extended to cover all ESP32 family kinds:

```ts
const isQemuBoard =
  board?.boardKind === 'raspberry-pi-3' ||
  board?.boardKind === 'esp32' ||
  board?.boardKind === 'esp32-s3' ||
  board?.boardKind === 'esp32-cam' ||
  board?.boardKind === 'esp32-c3' ||
  board?.boardKind === 'esp32-devkit-c-v4' ||
  board?.boardKind === 'wemos-lolin32-lite' ||
  board?.boardKind === 'xiao-esp32-s3' ||
  board?.boardKind === 'arduino-nano-esp32' ||
  board?.boardKind === 'xiao-esp32-c3' ||
  board?.boardKind === 'aitewinrobot-esp32c3-supermini';
```

Verified by user: ESP32-CAM now boots in QEMU, runs the
`webcam_demo`, prints SCCB chip-id check, and configures GPIO 25
VSYNC interrupt (Intr:2 = NEGEDGE) — the exact signature `cam_hal.c`
expects.

## Build instructions for the DLL

The DLL is built in MSYS2 MINGW64 against the qemu-lcgamboa fork.
Path with spaces breaks meson, so we copy to `/c/v_qemu/` first:

```bash
cp -r "/e/Hardware/velxio release/wokwi-libs/qemu-lcgamboa" /c/v_qemu
cd /c/v_qemu
./configure --target-list=xtensa-softmmu --enable-shared
make -j8 lib/libqemu-xtensa.dll
cp build/qemu-system-xtensa /e/Hardware/velxio\ release/backend/app/services/libqemu-xtensa.dll
```

The build needs the new device sources (`esp32_i2s_cam.c`,
`esp32_ov2640.c`, `velxio_camera_export.c`) registered in
`hw/misc/meson.build` and `hw/i2c/meson.build` — already done.

## DLL backup convention

During camera development I kept progressive backups of the working
DLL:
- `libqemu-xtensa.dll.pre-camera` — last known good before
  introducing OV2640/I²S devices
- `libqemu-xtensa.dll.new` — intermediate test build
- `libqemu-xtensa.dll` — current (gitignored, regenerated locally)

The `.pre-camera` and `.new` variants are gitignored too — they're
local rollback points that shouldn't bloat the repo. If you need a
known-good binary, rebuild from the corresponding qemu-lcgamboa
commit.

## Sources

- [esp32-camera/target/esp32/ll_cam.c::ll_cam_start](https://github.com/espressif/esp32-camera/blob/master/target/esp32/ll_cam.c#L270) — rx_eof_num setup
- [esp32-camera/driver/cam_hal.c::cam_task](https://github.com/espressif/esp32-camera/blob/master/driver/cam_hal.c#L266) — state machine
- [esp32-camera/driver/cam_hal.c::allocate_dma_descriptors](https://github.com/espressif/esp32-camera/blob/master/driver/cam_hal.c#L437) — descriptor sizing

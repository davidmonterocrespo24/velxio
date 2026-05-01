# ESP32 — Arduino runtime crashes on `delay()` / `pinMode()` (issue #129)

> **Symptom seen by users**: an LED wired to a normal output GPIO never lights
> or blinks; voltage is measurable at the pin but no toggling. The user sees
> nothing in the serial monitor and assumes the board model (e.g. ESP32-CAM)
> is broken.
>
> **Real root cause**: the firmware crashes silently inside the lcgamboa QEMU
> machine before reaching the first `digitalWrite()`, because Arduino's
> runtime functions live in cached flash regions and the machine raises an
> illegal-cache-access trap during the cache-disable windows that the
> Espressif IDF opens at boot.
>
> **Reproduces on every ESP32 board model in Velxio** (ESP32 DevKit, ESP32-CAM,
> Wemos LOLIN32, etc.) — the issue is not board-specific.

---

## Table of Contents

1. [Background — what cache-disable means on real ESP32](#1-background)
2. [Symptom and how it surfaces in Velxio](#2-symptom)
3. [Why the user thinks ESP32-CAM is broken](#3-why-it-looks-board-specific)
4. [Reproduction in the test suite](#4-reproduction-in-the-test-suite)
5. [Root cause inside lcgamboa QEMU](#5-root-cause-inside-lcgamboa-qemu)
6. [Workaround for end users — cache-safe sketch pattern](#6-workaround-for-end-users)
7. [Fix design — soft-cache mode in `esp32_dport.c`](#7-fix-design)
8. [Building the patched DLL](#8-building-the-patched-dll)
9. [Regression test](#9-regression-test)
10. [Future work](#10-future-work)

---

## 1. Background

On real ESP32 silicon the Xtensa cores fetch instructions from a small cached
window into the SPI flash chip. The cache is *transparently* invalidated
whenever the chip needs to:

- write or erase flash sectors,
- run WiFi/BT calibration code that re-times the flash bus,
- enter critical sections that may corrupt cached lines.

During those windows the cache reads return undefined data, and the IDF
arms a fault trap (`cache_ill_trap_en`) that raises a panic if any code or
data in IROM/DROM is accessed. On hardware those windows are
sub-millisecond and the IDF carefully places the relevant code paths in
IRAM/DRAM so nothing trips the trap.

The lcgamboa QEMU fork models this faithfully:
`hw/misc/esp32_dport.c` exposes the cache control registers and raises
`cache_ill_irq` whenever the firmware reads from a cache-disabled region
while the trap is armed.

## 2. Symptom

A user writes the canonical Arduino blink sketch and runs it on **any** ESP32
variant in Velxio:

```cpp
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
```

What happens at runtime:

1. The IDF bootloader runs (cache-safe, lives in IRAM/ROM).
2. The user's `setup()` is called.
3. `pinMode(13, OUTPUT)` jumps into Arduino-core code that lives in the
   `_TEXT` section of cached flash (IROM).
4. WiFi/BT init schedules a calibration tick on core 1 that opens a
   cache-disable window.
5. While the window is open, the timer ISR for the FreeRTOS scheduler fires
   and tries to fetch instructions from IROM. Cache disabled → illegal
   access → `cache_ill_irq` → IDF panic handler → CPU halts.
6. The GPIO direction was never written. The pin sits in default
   high-impedance INPUT mode — which is why the user can read voltage at
   it (the LED's pull-up or external supply leaks through) but nothing
   ever toggles.

Crucially, **the panic message does not reach the user**. The serial
output handler is also in IROM, so the panic dies before it can print.
The user sees a frozen-but-otherwise-intact board.

## 3. Why it looks board-specific

The user reports it on the ESP32-CAM because that's the board they were
trying. The same crash happens on:

- `esp32` (DevKit-C v4)
- `esp32-cam`
- `wemos-lolin32-lite`
- `esp32-s3`
- — anywhere the lcgamboa Xtensa machine runs Arduino-runtime sketches.

The frontend collapses every Xtensa variant to `board: 'esp32'` before
sending `start_esp32` to the backend (`Esp32Bridge.toQemuBoardType()`),
so the actual QEMU machine that runs is `esp32-picsimlab` regardless of
which board the user picked. There is no ESP32-CAM-specific code path
that could be at fault.

## 4. Reproduction in the test suite

`test/esp32_cam/test_esp32_cam_blink.py` carries six layers, each
designed to fail at a different layer of the stack so a future
contributor knows where the regression lives:

| Layer | What it checks | Fails when |
|------:|----------------|------------|
| 1 | The user-faithful sketch source matches issue #129 verbatim | someone "fixes" the sketch instead of the runtime |
| 2 | `esp32-cam` is registered in `BoardKind`, has FQBN, exposes pin '13' | board metadata regresses |
| 3 | `boardPinToNumber('esp32-cam', '13') === 13` (Python mirror) | frontend pin mapping regresses |
| 4 | The simulation WS route forwards `board='esp32-cam'` to the manager unchanged | backend silently drops the variant |
| 5 | An IRAM-safe blink on **GPIO13** toggles at least 3 times in real QEMU | GPIO routing through the bridge breaks |
| 6 | A live uvicorn backend emits `gpio_change pin=13` over the WebSocket | the WS layer drops events |

Layer 5 passing is the smoking gun: GPIO13 routing is healthy. The user's
sketch fails not because of pin tracking but because the Arduino runtime
crashes the firmware before it ever reaches the toggle.

## 5. Root cause inside lcgamboa QEMU

`hw/misc/esp32_dport.c:281` decides whether the cached IROM/DROM regions
are mapped:

```c
static void esp32_cache_state_update(Esp32CacheState* cs)
{
    bool cache_enabled = FIELD_EX32(cs->cache_ctrl_reg,
                                    DPORT_PRO_CACHE_CTRL, CACHE_ENA) != 0;

    bool drom0_enabled = cache_enabled &&
        FIELD_EX32(cs->cache_ctrl1_reg, DPORT_PRO_CACHE_CTRL1, MASK_DROM0) == 0;
    /* ... */
    memory_region_set_enabled(&cs->drom0.mem, drom0_enabled);
    /* same for iram0 / dram1 */
}
```

When the firmware writes 0 to `CACHE_ENA`, the memory regions are
disabled and any subsequent fetch from them is routed to
`esp32_cache_ill_read` (line 320), which raises the trap IRQ when armed:

```c
if (crs->illegal_access_trap_en) {
    crs->illegal_access_status = true;
    qemu_irq_raise(crs->cache->dport->cache_ill_irq);
}
```

In the educational simulator we never have a real flash chip whose state
needs protecting during a programming cycle, so the cache-disable window
serves no practical purpose — but it kills every Arduino sketch that uses
`delay()`, `Serial.print()`, `pinMode()` or `digitalWrite()`.

## 6. Workaround for end users

Until the patched DLL is rolled out, ship sketches that stay in
IRAM/ROM/DRAM during the WiFi/BT init window:

```cpp
// IRAM-safe blink for ESP32 in Velxio (lcgamboa QEMU)
#define GPIO_OUT_W1TS    (*((volatile uint32_t*)0x3FF44008))  // set HIGH
#define GPIO_OUT_W1TC    (*((volatile uint32_t*)0x3FF4400C))  // set LOW
#define GPIO_ENABLE_W1TS (*((volatile uint32_t*)0x3FF44020))  // enable output

#define LED_BIT (1u << 13)  // GPIO13

extern "C" {
    void ets_delay_us(uint32_t us);
    int  esp_rom_printf(const char* fmt, ...);
}

void IRAM_ATTR setup() {
    GPIO_ENABLE_W1TS = LED_BIT;
    for (int i = 0; i < 1000; i++) {
        GPIO_OUT_W1TS = LED_BIT;     ets_delay_us(500000);
        GPIO_OUT_W1TC = LED_BIT;     ets_delay_us(500000);
    }
}

void IRAM_ATTR loop() { ets_delay_us(1000000); }
```

Rules:

- Tag every function with `IRAM_ATTR`.
- Tag every string literal with `DRAM_ATTR`.
- Use `esp_rom_printf` instead of `Serial`.
- Use `ets_delay_us` instead of `delay`/`vTaskDelay`.
- Touch GPIOs via the `0x3FF44xxx` register window, not Arduino helpers.

A reference implementation lives at
`test/esp32_cam/sketches/blink_pin13_iram/blink_pin13_iram.ino`.

## 7. Fix design

The patch lives behind a compile-time flag so upstream lcgamboa stays
strictly faithful to silicon and only the Velxio build relaxes the rule.

**File**: `wokwi-libs/qemu-lcgamboa/hw/misc/esp32_dport.c`

**Change A** — keep the cache regions mapped even when firmware writes
0 to `CACHE_ENA`. Existing `esp32_cache_data_sync` keeps them coherent
with the underlying flash block on every transition, so this does not
introduce stale-cache reads:

```c
static void esp32_cache_state_update(Esp32CacheState* cs)
{
#ifdef ESP32_PICSIMLAB_SOFT_CACHE
    /* velxio: there is no real SPI flash chip whose state needs
     * protecting during a cache-disable window, so we keep the
     * cached regions mapped and let esp32_cache_data_sync (called on
     * every CACHE_ENA transition by esp32_dport_write) keep them
     * coherent. This eliminates the panic users see when Arduino
     * runtime functions (delay/pinMode/digitalWrite/Serial) get
     * touched while CACHE_ENA briefly drops to 0 during WiFi/BT init.
     * See docs/wiki/esp32-cache-disable-runtime-crash.md.            */
    bool cache_enabled = true;
#else
    bool cache_enabled = FIELD_EX32(cs->cache_ctrl_reg,
                                    DPORT_PRO_CACHE_CTRL, CACHE_ENA) != 0;
#endif
    /* ...rest unchanged */
}
```

**Change B** — suppress the illegal-access IRQ. With Change A in place
the firmware should never legitimately hit a cache-disabled region, but
some IDF builds arm the trap aggressively and we want to be robust:

```c
static uint64_t esp32_cache_ill_read(void *opaque, hwaddr addr, unsigned int size)
{
    Esp32CacheRegionState *crs = (Esp32CacheRegionState*) opaque;
    uint32_t ill_data[] = { crs->illegal_access_retval, crs->illegal_access_retval };
    uint32_t result;
    memcpy(&result, ((uint8_t*) ill_data) + (addr % 4), size);
#ifndef ESP32_PICSIMLAB_SOFT_CACHE
    if (crs->illegal_access_trap_en) {
        crs->illegal_access_status = true;
        qemu_irq_raise(crs->cache->dport->cache_ill_irq);
    }
#endif
    return result;
}
```

**Build flag**: add `-DESP32_PICSIMLAB_SOFT_CACHE=1` to the cflags in
`build_libqemu-esp32-win.sh` / `build_libqemu-esp32.sh`.

**Why not patch the cache writes themselves**: the IDF reads back the
register to confirm the toggle. Faking the bit would diverge from
`cache_ctrl_reg` and could confuse `esp32_cache_data_sync`'s
"transition" detection on the next write.

**Why not just suppress the trap IRQ alone**: when the memory region is
disabled, instruction fetches from IROM return the fill value
(`0xCECECECE`) which decodes as an illegal Xtensa instruction → exception
→ panic via a different path. We have to keep the regions mapped.

## 8. Building the patched libraries

The patch is already in the source tree
(`wokwi-libs/qemu-lcgamboa/hw/misc/esp32_dport.c`) and the
`-DESP32_PICSIMLAB_SOFT_CACHE=1` flag is wired into both
`build_libqemu-esp32.sh` (Linux/macOS) and `build_libqemu-esp32-win.sh`
(Windows MSYS2 MINGW64).

### 8.1 Recommended — let the CI publish the release

`wokwi-libs/qemu-lcgamboa/.github/workflows/build-libqemu.yml` builds
the patched libraries for **every host Velxio supports natively** and
uploads them to the `qemu-prebuilt` release of the velxio repo:

| Asset name in release | Host |
|---|---|
| `libqemu-xtensa-amd64.so` / `libqemu-riscv32-amd64.so`           | Linux x86_64 |
| `libqemu-xtensa-arm64.so` / `libqemu-riscv32-arm64.so`           | Linux ARM64 |
| `libqemu-xtensa-windows-amd64.dll` / `libqemu-riscv32-windows-amd64.dll` | Windows x86_64 |
| `libqemu-xtensa-macos-arm64.dylib` / `libqemu-riscv32-macos-arm64.dylib` | macOS Apple Silicon (Intel Macs not supported) |
| `esp32-v3-rom.bin`, `esp32-v3-rom-app.bin`, `esp32c3-rom.bin`     | All hosts (arch-independent) |

Trigger by pushing to the `picsimlab-esp32` branch of
`davidmonterocrespo24/qemu-lcgamboa`, or run the workflow manually
from the GitHub UI (`workflow_dispatch`). Total CI time ≈30 min.

Once the release is updated, `Dockerfile.standalone` picks the
arch-specific `.so` automatically (it already uses `${TARGETARCH}`),
and the native installers below pull the right binary.

### 8.2 Native install — pick the right asset per host

Drop the renamed file into `backend/app/services/`:

| Host | Asset to download | Rename to |
|---|---|---|
| Linux x86_64       | `libqemu-xtensa-amd64.so`         | `libqemu-xtensa.so` |
| Linux ARM64        | `libqemu-xtensa-arm64.so`         | `libqemu-xtensa.so` |
| Windows x86_64     | `libqemu-xtensa-windows-amd64.dll`| `libqemu-xtensa.dll` |
| macOS Apple Silicon| `libqemu-xtensa-macos-arm64.dylib`| `libqemu-xtensa.dylib` |

Repeat for the matching `libqemu-riscv32-*` file. The backend's loader
(`backend/app/services/esp32_lib_manager.py`) picks the right file
extension automatically based on `sys.platform`.

### 8.3 Building locally (when you can't wait for CI)

**Linux / macOS:**
```bash
cd wokwi-libs/qemu-lcgamboa
mkdir build-out && cd build-out
bash ../build_libqemu-esp32.sh xtensa-softmmu,riscv32-softmmu ..

# Linux:
cp libqemu-xtensa.so  ../../../backend/app/services/
# macOS:
cp libqemu-xtensa.so  ../../../backend/app/services/libqemu-xtensa.dylib
```

Required Debian/Ubuntu packages:
```
build-essential ninja-build pkg-config python3 python3-venv git
libglib2.0-dev libpixman-1-dev libslirp-dev libgcrypt20-dev libfdt-dev
```

Required macOS Homebrew packages:
```
gnu-sed coreutils ninja pkg-config meson glib pixman libgcrypt libslirp
```
(Make sure `gnu-sed`'s `gnubin` is on `PATH` before `/usr/bin` so the
script's `sed -i …` calls resolve to GNU sed, not BSD sed.)

**Windows (MSYS2 MINGW64):**
```bash
cd /e/Hardware/velxio\ release/wokwi-libs/qemu-lcgamboa
bash build_libqemu-esp32-win.sh

cp build/libqemu-xtensa.dll  ../../backend/app/services/
cp build/libqemu-riscv32.dll ../../backend/app/services/
```
Required `pacman` packages are listed in the build script's header.

## 9. Regression test

After deploying the new DLL, the user-faithful firmware should toggle
GPIO13. Drive the verification through the pytest harness:

```bash
# Compile the user sketch verbatim (already tracked in the repo)
arduino-cli compile \
  --fqbn esp32:esp32:esp32cam:FlashMode=dio \
  --output-dir test/esp32_cam/out_blink_pin13 \
  test/esp32_cam/sketches/blink_pin13

python -m esptool --chip esp32 merge-bin --pad-to-size 4MB \
  -o test/esp32_cam/binaries/blink_pin13.merged.bin \
  --flash-mode dio --flash-size 4MB \
  0x1000  test/esp32_cam/out_blink_pin13/blink_pin13.ino.bootloader.bin \
  0x8000  test/esp32_cam/out_blink_pin13/blink_pin13.ino.partitions.bin \
  0x10000 test/esp32_cam/out_blink_pin13/blink_pin13.ino.bin
```

Then add a once-per-process test that boots the user firmware and
asserts ≥3 GPIO13 transitions; the existing IRAM control class needs to
remain the only QEMU instance per pytest run because lcgamboa keeps
singleton aio_context state.

## 10. Future work

- Apply the same `ESP32_PICSIMLAB_SOFT_CACHE` flag to `hw/misc/esp32c3_cache.c`
  for the RISC-V build.
- Detect at runtime whether the firmware ever writes `esp_wifi_init` and
  only relax the cache when WiFi is not initialised (partial fix that
  preserves WiFi-flow fidelity).
- Upstream the patch as a `--enable-soft-cache` configure option to
  lcgamboa so the Velxio fork can rebase cleanly.

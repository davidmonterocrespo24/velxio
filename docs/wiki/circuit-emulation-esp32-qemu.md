# ESP32 family — QEMU Waveform Injection for the SAR ADC

> How Velxio achieves per-read ADC fidelity on ESP32 / ESP32-S3 / ESP32-C3,
> the QEMU-side data contract, the WebSocket protocol that delivers
> waveforms to the subprocess, and how to rebuild `qemu-lcgamboa` when you
> change the C code.

## Why a separate doc?

The AVR and RP2040 paths live entirely in JS — we monkey-patch
`AVRADC.onADCRead` / `RPADC.onADCRead`. ESP32, ESP32-S3, and ESP32-C3 all
run inside a forked QEMU (`wokwi-libs/qemu-lcgamboa`), so JS can't reach
the ADC peripheral. Instead, the **full periodic waveform** is pushed down
to the QEMU SAR ADC, which interpolates it against `QEMU_CLOCK_VIRTUAL`
on every MMIO read.

The `circuit-emulation-adc-aliasing.md` page covers *why* per-read sampling
is needed. This page covers *how* it's implemented for the ESP32 family.

---

## 1. End-to-end pipeline

```
┌─────────────────────────────┐
│ frontend SPICE solve (.tran)│
└──────────────┬──────────────┘
               │ useElectricalStore.timeWaveforms
               ▼
┌─────────────────────────────┐
│ subscribeToStore.ts         │
│   pushEsp32Waveforms()      │
│   - iterate boards          │
│   - map ADC pin → SPICE net │
│   - quantise to 12-bit u16  │
└──────────────┬──────────────┘
               │ bridge.setAdcWaveform(gpio, u12, periodNs)
               ▼
┌─────────────────────────────┐
│ Esp32Bridge.ts              │
│   base64(u12 LE) + period   │
└──────────────┬──────────────┘
               │ WebSocket "esp32_adc_waveform"
               ▼
┌─────────────────────────────┐
│ FastAPI /ws/simulation      │
│   esp_lib_manager.          │
│     set_adc_waveform(...)   │
└──────────────┬──────────────┘
               │ JSON line on subprocess stdin
               ▼
┌─────────────────────────────┐
│ esp32_worker.py             │
│   cmd == 'set_adc_waveform' │
│   ctypes → libqemu symbol   │
└──────────────┬──────────────┘
               │ qemu_picsimlab_set_apin_waveform(ch, u16*, n, period_ns)
               ▼
┌─────────────────────────────┐
│ esp32_sens.c / esp32c3_saradc.c │
│   - g_malloc LUT            │
│   - latch epoch = virt_ns   │
│   - interpolate on read     │
└─────────────────────────────┘
```

**DC fallback.** When no `.tran` result is available the subsystem falls
back to the existing `qemu_picsimlab_set_apin(channel, mv)` code path so
DC examples behave exactly as before. Passing `samples=NULL` or `n=0` to
`qemu_picsimlab_set_apin_waveform` clears the LUT and re-arms the DC path.

---

## 2. QEMU API contract

### New symbol

```c
void qemu_picsimlab_set_apin_waveform(int chn,
                                      const uint16_t *samples,
                                      int n,
                                      uint64_t period_ns);
```

- `chn` — SAR ADC channel (0-based; 8 channels on ESP32, 10 on ESP32-C3,
  varies by board).
- `samples` — array of 12-bit raw ADC counts (`0..4095`). When the frontend
  quantises a SPICE voltage it uses `round(v / 3.3 · 4095)`, clamped.
- `n` — number of samples. Pass `0` (or `samples=NULL`) to clear.
- `period_ns` — full period of the waveform in nanoseconds. Usually the
  last entry of `timeWaveforms.time` × 1e9.

### Device-state additions

Per SAR-ADC peripheral (`Esp32SensState`, `Esp32c3SarAdcState`):

```c
uint16_t *waveform_samples[NUM_CHANNELS];
int       waveform_len[NUM_CHANNELS];
uint64_t  waveform_period_ns[NUM_CHANNELS];
uint64_t  waveform_epoch_ns[NUM_CHANNELS];
```

### Read-path interpolation

Pseudo-code (the real helpers live in
`esp32c3_saradc_sample_waveform` and the ESP32 equivalent):

```c
uint64_t now  = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);
uint64_t dt   = (now - epoch) % period_ns;
double t_frac = (double) dt / period_ns * (n - 1);
int    lo     = (int) t_frac;
int    hi     = lo + 1;
double a      = t_frac - lo;
uint16_t raw  = round(samples[lo] * (1 - a) + samples[hi] * a);
```

Clamp `raw` to `[0, 0xFFFF]`. The SAR ADC handler writes it into the 17-bit
data register as usual — so as far as the guest knows, the ADC just
happened to return a slightly different value on every conversion.

### Reset / cleanup

The peripheral's `reset` handler frees every `waveform_samples[i]` and zeros
the metadata arrays. That keeps `esp_restart()` clean and avoids leaking
LUTs across reboots.

---

## 3. WebSocket protocol

### Frontend → backend

```json
{
  "type": "esp32_adc_waveform",
  "data": {
    "channel": 0,
    "samples_u12_le": "<base64>",
    "period_ns": 20000000
  }
}
```

- `channel` — GPIO number to map (the backend resolves GPIO → SAR channel).
- `samples_u12_le` — base64 of a `Uint16Array` in little-endian order.
  Each entry is a 12-bit sample occupying the low 12 bits; upper 4 bits
  are always zero.
- `period_ns` — same as the QEMU API.

Pass an empty `samples_u12_le` (base64 `""`) or `period_ns: 0` to clear.

### Backend → QEMU

`esp32_worker.py` decodes the base64 into a ctypes `(c_uint16 * n)` buffer
and calls `lib.qemu_picsimlab_set_apin_waveform(ch, arr, n, period_ns)`.
If the symbol is missing (you haven't rebuilt QEMU yet), the worker logs
a warning and silently falls through to the existing DC path.

---

## 4. Rebuilding `qemu-lcgamboa`

### Windows

Requires MSYS2 + mingw64 (the user's env already has `C:\msys64\mingw64\bin`):

```bash
cd wokwi-libs/qemu-lcgamboa
./configure --target-list=xtensa-softmmu,riscv32-softmmu --enable-picsimlab
make -j$(nproc)
```

Copy the resulting `qemu-system-xtensa.exe` and `qemu-system-riscv32.exe`
plus the generated `libqemu*.dll` into `backend/qemu-bin/` (or wherever
`esp32_worker.py` picks them up — see `ESP32_QEMU_DIR` env var).

First-time build is ~15-20 minutes. Incremental `make` after touching one
`.c` file is seconds.

### Linux / macOS

```bash
cd wokwi-libs/qemu-lcgamboa
./configure --target-list=xtensa-softmmu,riscv32-softmmu --enable-picsimlab
make -j$(nproc)
sudo make install   # or copy binaries manually into backend/qemu-bin
```

### Verifying the new symbol

```bash
nm -D $(which qemu-system-xtensa) | grep qemu_picsimlab_set_apin_waveform
```

Should emit one match per target binary. If it doesn't, the build picked
up stale object files — run `make clean` and rebuild.

---

## 5. Mapping ADC pins to GPIO

ESP32 has 18 SAR-capable GPIOs split across ADC1 (8 channels) and ADC2
(10 channels); ESP32-C3 has 5 ADC channels on ADC1 only; ESP32-S3 has 10
on ADC1 + 10 on ADC2. The frontend stores the mapping in `ADC_PIN_TO_GPIO`
(see `subscribeToStore.ts`). To add a new board or pin alias:

1. Add it to `ADC_PIN_MAP[boardKind]` (list of `{ pinName, channel }`).
2. Add a resolver function to `ADC_PIN_TO_GPIO[boardKind]` that converts
   the `pinName` + channel into the GPIO number expected by QEMU.
3. `pushEsp32Waveforms()` will pick it up automatically.

---

## 6. Data-rate sanity check

At peak we push 400 samples × 2 bytes × 8 channels = 6.4 KB per solve per
board. `CircuitScheduler` rate-limits to ~5 solves / sec under heavy
activity, so worst-case traffic is ~32 KB/s — comfortable on the local
WebSocket and well below the `ws_max_message_size` default.

If you add a board with 20+ ADC channels, increase `MAX_PUSH_BYTES` in
`Esp32Bridge.ts` before running large `.tran` windows.

---

## 7. Testing

Unit tests for the waveform-stats helpers live at
`frontend/src/__tests__/waveform-stats.test.ts`. The per-read hook itself
is exercised in `frontend/src/__tests__/spice-rectifier-live-repro.test.ts`
(AVR path) — the ESP32 E2E counterpart is
`frontend/src/__tests__/esp32-rectifier-integration.test.ts` and is
**gated behind `VELXIO_ESP32_E2E=1`** because it requires a running QEMU
toolchain plus a live backend:

```bash
VELXIO_ESP32_E2E=1 npm test -- esp32-rectifier-integration
```

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `analogRead` returns stale DC on ESP32 despite `.tran` | QEMU binary predates this patch | `make clean && make` in `qemu-lcgamboa`, redeploy to `backend/qemu-bin/` |
| `esp32_worker` logs `symbol 'qemu_picsimlab_set_apin_waveform' not found` | Same — rebuild not yet deployed | As above; the worker falls back to DC so the app still runs |
| Guest sees 0 V after a few frames | Waveform cleared on reset but not re-pushed | Confirm `pushEsp32Waveforms()` is called on every solve (see `installAdcReadHooks`) |
| WebSocket frame ~2 MB pause | You pushed a huge `.tran` (tens of thousands of samples) | Tighten `pickDynamicAnalysis` step / stop so the solve returns fewer samples |

---

## 9. Key files

| File | Role |
| --- | --- |
| `wokwi-libs/qemu-lcgamboa/hw/misc/esp32_sens.c` | ESP32 SAR ADC1/2 — waveform LUT + sample_waveform helper |
| `wokwi-libs/qemu-lcgamboa/hw/misc/esp32c3_saradc.c` | ESP32-C3 SAR ADC — same pattern |
| `wokwi-libs/qemu-lcgamboa/include/hw/misc/esp32_sens.h` | State struct + `esp32_sens_set_waveform` prototype |
| `wokwi-libs/qemu-lcgamboa/include/hw/misc/esp32c3_saradc.h` | Same for C3 |
| `wokwi-libs/qemu-lcgamboa/hw/xtensa/esp32_picsimlab.c` | Defines `qemu_picsimlab_set_apin_waveform` for ESP32 |
| `wokwi-libs/qemu-lcgamboa/hw/riscv/esp32c3_picsimlab.c` | Defines it for ESP32-C3 |
| `backend/app/services/esp32_worker.py` | ctypes bridge from stdin JSON → libqemu |
| `backend/app/services/esp32_lib_manager.py::set_adc_waveform` | Queues the command on the subprocess |
| `backend/app/api/routes/simulation.py` | Handles `esp32_adc_waveform` WebSocket message |
| `frontend/src/simulation/Esp32Bridge.ts::setAdcWaveform` | Base64-encodes + sends the WebSocket frame |
| `frontend/src/simulation/spice/subscribeToStore.ts::pushEsp32Waveforms` | Iterates boards, quantises samples, calls the bridge |

# Backend E2E Tests (JavaScript / Node.js)

These tests compile real firmware via the backend API and run the full
simulation through a WebSocket, verifying sensor readings in the serial output.

## CI status

These tests **run in GitHub Actions** via `.github/workflows/backend-e2e-tests.yml`.

The CI workflow:

1. Downloads `libqemu-xtensa-amd64.so` and `libqemu-riscv32-amd64.so` from the
   [qemu-prebuilt](https://github.com/davidmonterocrespo24/velxio/releases/tag/qemu-prebuilt) release.
2. Downloads ROM files: `esp32-v3-rom.bin`, `esp32-v3-rom-app.bin`, `esp32c3-rom.bin`.
3. Installs arduino-cli + `esp32:esp32` core.
4. Starts `uvicorn app.main:app --port 8001` with `QEMU_ESP32_LIB` and `QEMU_RISCV32_LIB` set.
5. Runs all three JS tests.

## Local prerequisites

1. Backend running with QEMU libs in PATH:
   ```bash
   cd backend
   QEMU_ESP32_LIB=/path/to/libqemu-xtensa.so \
   QEMU_RISCV32_LIB=/path/to/libqemu-riscv32.so \
   uvicorn app.main:app --reload --port 8001
   ```
   On Windows the `.dll` files live in `backend/app/services/`.

2. Node.js 18+ installed.

## Run all e2e tests

Use the convenience script from the repo root:

```bash
# Windows
scripts\run-e2e-tests.bat

# Or individually (from repo root):
node test/backend/e2e/test_dht22_simulation.mjs   --timeout=60
node test/backend/e2e/test_hcsr04_simulation.mjs  --timeout=75
node test/backend/e2e/test_mpu6050_simulation.mjs --timeout=60
```

## Tests

| File | Sensor | What it verifies | Typical runtime |
|------|--------|-----------------|-----------------|
| `test_dht22_simulation.mjs` | DHT22 (GPIO4) | Temperature & humidity readings, `sensor_update` changes values | ~50 s |
| `test_hcsr04_simulation.mjs` | HC-SR04 (GPIO18/19) | Distance at 10/40/100/200 cm, `sensor_update` changes distance | ~60 s |
| `test_mpu6050_simulation.mjs` | MPU-6050 (I2C) | Accelerometer/gyroscope I2C readings | ~40 s |

## Pass criteria

| Test | Passes when |
|------|-------------|
| DHT22 | First reading received + values change after `sensor_update` |
| HC-SR04 | ≥3 correct readings, ≥2 distances, miss rate ≤30% |
| MPU-6050 | I2C communication established, sensor data in serial output |

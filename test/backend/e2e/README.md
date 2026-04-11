# Backend E2E Tests (JavaScript / Node.js)

These tests compile real firmware via the backend API and run the full
simulation through a WebSocket, verifying sensor readings in the serial output.

## Prerequisites

- Backend running on `http://localhost:8001`
- Node.js 18+

## Run

```bash
# From repo root
node test/backend/e2e/test_dht22_simulation.mjs   [--timeout=45]
node test/backend/e2e/test_hcsr04_simulation.mjs  [--timeout=60]
node test/backend/e2e/test_mpu6050_simulation.mjs [--timeout=40]

# Custom backend URL
node test/backend/e2e/test_dht22_simulation.mjs --backend=http://localhost:8001
```

## Tests

| File | Sensor | What it verifies |
|------|--------|-----------------|
| `test_dht22_simulation.mjs` | DHT22 | Temperature & humidity, sensor_update changes values |
| `test_hcsr04_simulation.mjs` | HC-SR04 | Distance at 10/40/100/200 cm, sensor_update changes distance |
| `test_mpu6050_simulation.mjs` | MPU-6050 | I2C accelerometer/gyroscope readings |

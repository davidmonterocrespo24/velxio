# 06 — existing ESP32 test patterns we copy

The DHT22 and HC-SR04 simulations have been proving the same
WebSocket+QEMU pipeline that the camera will reuse. This note
extracts the **exact** patterns so the camera tests don't reinvent
anything.

## File layout

| Layer purpose                             | Where to put it                            |
|-------------------------------------------|--------------------------------------------|
| Pure unit (Python, mocks the route)       | `test/test-esp32-cam/tests/*.py`           |
| Frontend integration (Vitest, mocks WS)   | `frontend/src/__tests__/esp32-*.test.ts`   |
| **Live e2e (Node, real backend, real QEMU)** | `test/backend/e2e/test_*.mjs`              |

The live e2e tests in `test/backend/e2e/` use plain Node with
`fetch()` + `WebSocket` (Node 20+). Both the DHT22 and HC-SR04 scripts
are ~250 lines and follow the same skeleton:

1. POST `/api/compile/` with the `.ino` source → get `firmware_b64`.
2. Open `ws://localhost:8001/api/simulation/ws/<session_id>`.
3. On `open`, send `start_esp32` with `{board, firmware_b64, sensors[]}`.
4. Stream `serial_output` messages, buffer until `\n`, scan for
   expected lines.
5. Send `esp32_sensor_update` to mutate state mid-run.
6. Exit 0 (pass) / 1 (fail) with a clear diagnostic block at the end.

This is the contract our **live camera test** has to satisfy. We won't
fight the pattern — we'll add `camera_frame` as a sibling of the
existing sensor messages.

## The simulation WebSocket message types we'll touch

From `backend/app/api/routes/simulation.py:90-260`:

| Message type                   | Direction       | What it does                       |
|--------------------------------|-----------------|------------------------------------|
| `start_esp32`                  | client → server | Boots QEMU with firmware           |
| `stop_esp32`                   | client → server | Tears QEMU down                    |
| `esp32_sensor_attach`          | client → server | Generic sensor protocol register   |
| `esp32_sensor_update`          | client → server | Mutate sensor state                |
| `esp32_sensor_detach`          | client → server | Drop sensor                        |
| `esp32_uart{1,2}_input`        | client → server | UART byte stream                   |
| `esp32_i2c_response`           | client → server | I²C slave transaction reply        |
| `serial_output`                | server → client | Buffered UART out                  |
| `gpio_change`                  | server → client | Pin state transition               |
| `system` / `error`             | server → client | Lifecycle / faults                 |

For camera we'll add **two** new types — no need to overload the
generic sensor channel:

```
esp32_camera_attach   client → server   {board, jpeg_quality, frame_size}
esp32_camera_frame    client → server   binary JPEG payload (or base64 in JSON)
esp32_camera_detach   client → server   ()
```

This keeps the camera as a first-class peripheral instead of pretending
it's a "sensor", which would imply `pin` semantics that don't apply.

## Patterns to **copy verbatim** from `test_dht22_simulation.mjs`

- Session ID with timestamp: `test-camera-${Date.now()}` so parallel
  runs don't collide on the backend's connection map.
- Line buffer for `serial_output` — chunks arrive partial:
  ```js
  let _buf = '';
  // … on serial_output:
  _buf += data?.data ?? '';
  while ((nl = _buf.indexOf('\n')) !== -1) {
      const line = _buf.slice(0, nl).replace(/\r$/, '');
      _buf = _buf.slice(nl + 1);
      // …match expected lines…
  }
  ```
- ANSI-coloured logging helpers (`info`, `ok`, `err`, `serial`,
  `gpio`) — copy the helpers, don't re-invent them.
- Pass/fail decision at the end with concrete diagnostic guidance
  ("→ Check that `camera_frame` propagates to backend ring buffer").
- `--timeout=N` and `--backend=URL` CLI flags so the same script runs
  in CI and locally.

## Patterns to **NOT copy**

- The DHT22 script hard-codes the sensor on GPIO4 in two places. For
  the camera test we keep the pin map in **one** const block at the
  top so a wiring change is one edit.
- The DHT22 script exits 1 on partial pass with a "PARTIAL" label.
  The camera test doesn't have a "partial" state — either the firmware
  reports back the JPEG size correctly or it doesn't. Binary pass/fail.

## Where each phase of the camera plan plugs in

```
Phase 1 (SCCB stub)       → Python pytest layer (test_camera_websocket.py exists)
Phase 2 (I²S + DMA)       → Python pytest layer + new C unit-tests inside QEMU
Phase 3 (frame injection) → New live e2e: test/backend/e2e/test_camera_simulation.mjs
Phase 4 (build)           → Update wokwi-libs/qemu-lcgamboa/build_libqemu-esp32.sh
Phase 5 (frontend)        → frontend/src/__tests__/esp32-camera-frame.test.ts
Phase 6 (backfill tests)  → flip @expectedFailure off in tests we already wrote
```

The Phase-3 e2e is the one that proves end-to-end that the camera
works. Pseudo-code of what it'll do:

```js
// 1. compile camera_init.ino
// 2. ws.send(start_esp32 with board='esp32-cam')
// 3. ws.send(esp32_camera_attach)
// 4. ws.send(esp32_camera_frame with a 4x4 red square JPEG)
// 5. wait for serial line "got frame: <N> bytes 320x240 fmt=4"
// 6. ws.send another frame with different bytes
// 7. wait for the next serial line — bytes must differ
// 8. exit 0
```

That's the regression contract. If we ever break the frame transport,
Phase-3 e2e fails with a precise message.

# Docker Production Error Report — 2026-04-19

Errors extracted from `docker logs velxio-app` (last 24h).
Compilation errors from user code (syntax, missing libraries) are excluded — those are expected.

---

## 1. Raspberry Pi 3 — Missing QEMU boot files

**Occurrences:** 46 (raspberry-pi-3) + 5 (raspberry-pi-3-2) = **51 total**
**Severity:** HIGH — feature completely broken, users see error
**User impact:** Anyone selecting Raspberry Pi 3 board gets immediate failure

### Log sample
```
INFO:     ('172.20.0.1', 0) - "WebSocket /api/simulation/ws/raspberry-pi-3" [accepted]
INFO:     connection open
ERROR app.services.qemu_manager: Missing QEMU images in /app/app/services/../../../img
ERROR app.api.routes.simulation: [raspberry-pi-3] error: Missing QEMU boot files (kernel8.img / SD image)
```

### Root cause
The QEMU manager expects boot files (`kernel8.img`, SD image) in `/app/app/services/../../../img`
(resolves to `/img` in the container). These files are not included in the Docker image and no
download mechanism exists for them.

### Affected files
- `backend/app/services/qemu_manager.py` — checks for image directory
- `backend/app/api/routes/simulation.py` — reports the error to the WebSocket client

### Suggested fix
Option A: Add `kernel8.img` and SD image to the Docker build (similar to ESP32 ROM files).
Option B: Hide/disable Raspberry Pi 3 from the board selector until images are available.
Option C: Return a clear user-facing error message ("Raspberry Pi 3 simulation is not yet available")
instead of a generic failure.

---

## 2. ESP32-S3 — Unsupported QEMU machine type

**Occurrences:** 5 worker crashes (2 unique sessions)
**Severity:** HIGH — feature completely broken, will never work with current QEMU lib
**User impact:** Anyone selecting ESP32-S3 board gets simulation failure

### Log sample
```
INFO app.api.routes.simulation: [b923990f-...::esp32-s3] start_esp32 board=esp32-s3 firmware=4096KB lib_available=True
INFO app.services.esp32_lib_manager: Launching esp32_worker (machine=esp32s3-picsimlab, ...)
INFO app.services.esp32_lib_manager: [worker:...] [esp32_worker] Loading library: /app/lib/libqemu-xtensa.so
INFO app.services.esp32_lib_manager: [worker:...] qemu: unsupported machine type
INFO app.services.esp32_lib_manager: [worker:...] Use -machine help to list supported machines
WARNING app.services.esp32_lib_manager: [...::esp32-s3] worker exited unexpectedly (code 1)
```

### Root cause
The pre-built `libqemu-xtensa.so` (lcgamboa/picsimlab fork) only supports `esp32-picsimlab` machine
type. The code tries to launch `esp32s3-picsimlab` which does not exist in this QEMU build.
ESP32-S3 uses Xtensa LX7 (vs LX6 for vanilla ESP32) — the current QEMU binary does not emulate LX7.

### Affected files
- `backend/app/services/esp32_lib_manager.py` — maps board to QEMU machine name
- `prebuilt/qemu/` — pre-built QEMU binaries

### Suggested fix
Option A: Compile a QEMU build that includes ESP32-S3 support (if available in lcgamboa fork).
Option B: Hide ESP32-S3 from the board selector or show "simulation not supported" message.
Option C: Fall back gracefully instead of crashing the worker — return an error to the WebSocket.

---

## 3. WebSocket — "accept" race condition after connection close

**Occurrences:** 7 errors across 5 unique sessions
**Severity:** MEDIUM — does not crash uvicorn currently, but same class of bug that caused
the 31-hour outage on 2026-04-16 (AssertionError in websockets keepalive_ping)
**User impact:** None visible (connection already closed), but risks process crash

### Log sample
```
INFO:     connection closed
INFO app.services.esp32_lib_manager: WorkerInstance 9df41c8f-...::esp32 shut down
ERROR app.api.routes.simulation: WebSocket error for 9df41c8f-...::esp32: WebSocket is not connected. Need to call "accept" first.
```

### Root cause
After the WebSocket connection is closed (client navigates away or network drop), the simulation
route code still attempts to send data or perform operations on the WebSocket object. The error
message "Need to call accept first" indicates the WebSocket was never fully accepted or was already
disconnected when a send was attempted.

### Affected files
- `backend/app/api/routes/simulation.py` — WebSocket handler, cleanup logic

### Suggested fix
Wrap WebSocket send operations in try/except to catch `WebSocketDisconnect` and connection errors.
Check `websocket.client_state` before attempting sends. Ensure the cleanup path does not attempt
to write to an already-closed connection.

Example:
```python
try:
    await websocket.send_json(data)
except (WebSocketDisconnect, RuntimeError):
    # Client already gone — clean up silently
    break
```

---

## 4. Google OAuth — Unhandled 400 from token exchange

**Occurrences:** 1
**Severity:** MEDIUM — returns 500 Internal Server Error to the user instead of a friendly redirect
**User impact:** User sees a blank error page instead of being redirected to login

### Log sample
```
INFO httpx: HTTP Request: POST https://oauth2.googleapis.com/token "HTTP/1.1 400 Bad Request"
INFO:     172.20.0.1:0 - "GET /api/auth/google/callback?code=4/0Aci98E8...&scope=...&authuser=0 HTTP/1.0" 500 Internal Server Error
ERROR:    Exception in ASGI application
Traceback (most recent call last):
  ...
  File "/app/app/api/routes/auth.py", line 119, in google_callback
    token_resp.raise_for_status()
  ...
httpx.HTTPStatusError: Client error '400 Bad Request' for url 'https://oauth2.googleapis.com/token'
```

### Root cause
The `google_callback` endpoint in `auth.py:119` calls `token_resp.raise_for_status()` without
try/except. When Google rejects the authorization code (expired, already used, or user reloaded
the callback page), the unhandled exception propagates to a 500 error.

### Affected file
- `backend/app/api/routes/auth.py` — line 119

### Suggested fix
```python
# In google_callback():
token_resp = await client.post(GOOGLE_TOKEN_URL, data={...})
if token_resp.status_code != 200:
    return RedirectResponse(url=f"{settings.FRONTEND_URL}/login?error=google_auth_failed")
access_token = token_resp.json()["access_token"]
```

---

## 5. Uvicorn crash from websockets keepalive (RESOLVED)

**Occurrences:** 1 (caused ~31h outage on 2026-04-16)
**Severity:** CRITICAL — killed the entire backend process
**Status:** MITIGATED — `deploy/entrypoint.sh` now uses `wait -n` so Docker restarts the container
automatically. Root cause (old `websockets` library) still present.

### Log sample
```
ERROR:    keepalive ping failed
Traceback (most recent call last):
  File ".../websockets/legacy/protocol.py", line 1233, in keepalive_ping
    pong_waiter = await self.ping()
  File ".../websockets/legacy/protocol.py", line 308, in _drain_helper
    assert waiter is None or waiter.cancelled()
AssertionError
```

### Root cause
Race condition in `websockets` (legacy branch) when a connection closes while a keepalive ping
is in flight. The assertion in `_drain_helper` fails and the unhandled exception kills uvicorn.

### Fix applied
- `deploy/entrypoint.sh` — changed to monitor both uvicorn and nginx with `wait -n`; if either
  dies, the container exits and Docker's `restart: unless-stopped` policy recovers it.
  Commit: `8e3c00e` (2026-04-16).

### Remaining work
- Update `websockets` to >= 12.x in `backend/requirements.txt` (fixes the race condition).
- Update `uvicorn[standard]` to latest (moves off `websockets/legacy` handler).

---

## Summary table

| # | Problem | Occurrences (24h) | Severity | Status |
|---|---------|-------------------|----------|--------|
| 1 | RPi3 missing QEMU boot files | 51 | HIGH | Open |
| 2 | ESP32-S3 unsupported QEMU machine | 5 | HIGH | Open |
| 3 | WebSocket send after close | 7 | MEDIUM | Open |
| 4 | Google OAuth unhandled 400 | 1 | MEDIUM | Open |
| 5 | Uvicorn crash from websockets keepalive | 1 | CRITICAL | Mitigated |

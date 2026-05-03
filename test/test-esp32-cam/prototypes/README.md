# prototypes

Standalone validation prototypes that run **outside** the pytest suite.
Use these to prove individual layers work before committing to the full
shim.

## webcam_capture.html + echo_server.py

Validates the browser-side path described in
`autosearch/03_browser_webcam_capture.md`:

- `getUserMedia` permission grant
- `<video>` → canvas → JPEG encode
- WebSocket binary frame transport
- bandwidth at the chosen fps/quality

```bash
# Terminal 1: tiny echo server
pip install websockets
python test/test-esp32-cam/prototypes/echo_server.py

# Browser: open the HTML file directly (file:// is fine)
open test/test-esp32-cam/prototypes/webcam_capture.html
# (or right-click → "open with browser" on Windows)
```

Click **Start camera**, grant permission. Two video panes should
appear: the live feed on the left, the echoed JPEG on the right. The
frame counter at the right should climb at the configured fps. If you
see the echoed image update, the transport is good and the only thing
left is the firmware shim.

## What's still to come

When the firmware-side shim from `autosearch/04` ships, the natural
next prototype is:

- `webcam_to_velxio_backend.html` — point the same capture loop at the
  real Velxio simulation WebSocket using the new `camera_frame`
  message type, with a sketch like `sketches/camera_init/camera_init.ino`
  running underneath.

That's intentionally not built yet — until the backend route knows
`camera_frame`, the prototype would just sit there with frames being
dropped. See `tests/test_camera_websocket.py` for the
expected-failure tests that gate this transition.

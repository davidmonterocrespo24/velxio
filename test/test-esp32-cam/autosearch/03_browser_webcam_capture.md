# 03 — browser webcam capture

How to get JPEG frames out of `getUserMedia()` and onto the WebSocket
the backend already serves. This part has zero unknowns; it's just
plumbing. Documenting the exact code so future-you doesn't have to
re-research it.

## End-to-end flow

```
                 ┌────────────────────────────────────┐
 user webcam  ─► │ MediaStream (getUserMedia)         │
                 │  ▼                                  │
                 │ <video autoplay muted>             │
                 │  ▼ (every N ms)                    │
                 │ <canvas> drawImage(video)          │
                 │  ▼                                  │
                 │ canvas.toBlob('image/jpeg', 0.6)   │
                 │  ▼                                  │
                 │ ArrayBuffer  ────► ws.send(binary) │
                 └────────────────────────────────────┘
                                  │
                                  ▼
                          backend Esp32Bridge
                                  │
                                  ▼
                     queued JPEG (ring of 1–2 frames)
                                  │
                                  ▼
                    firmware esp_camera_fb_get()
```

## Browser-side reference (essence; goes into a Velxio React hook)

```ts
// useWebcamFrames.ts — simplified, the production hook lives in
// frontend/src/hooks/useWebcamFrames.ts (not yet written)

const stream = await navigator.mediaDevices.getUserMedia({
  video: { width: 320, height: 240, frameRate: { ideal: 10, max: 15 } },
  audio: false,
});

const video = document.createElement('video');
video.srcObject = stream;
video.muted = true;
await video.play();

const canvas = new OffscreenCanvas(320, 240);
const ctx = canvas.getContext('2d')!;

setInterval(async () => {
  ctx.drawImage(video, 0, 0, 320, 240);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
  const buf = await blob.arrayBuffer();
  ws.send(buf);                        // binary frame
}, 1000 / 10);                          // 10 fps target
```

`OffscreenCanvas.convertToBlob` is supported in Chrome 69+, Firefox 105+,
Safari 16.4+ — fine for our audience (the same browsers that run our
WebGL/Web Components stack).

## Sizing

A 320×240 JPEG at quality 0.6 averages **8–14 KB**. At 10 fps that's
~120 KB/s up — trivial over a local WebSocket, and well within the
current 16 MB max_size already configured in `esp_qemu_manager` for
binary frames.

VGA (640×480) doubles the bandwidth and the latency; **start at
QVGA (320×240)** and only enlarge if a sketch needs it.

## Backend framing

We don't introduce a new WebSocket channel. We re-use the existing
`Esp32Bridge` WebSocket and add one new message type:

```jsonc
// Browser → backend (binary or {type, b64}):
{ "type": "camera_frame",
  "data": { "fmt": "jpeg", "w": 320, "h": 240, "b64": "<…>" } }
```

The backend keeps a small ring buffer (size 2: current + next) per
client. When the firmware-side shim asks for a frame, it gets the
"current"; the next browser-pushed frame replaces "next" and atomically
becomes "current".

Existing analogue: the DHT22 / HC-SR04 sensor-attach traffic on the
same WS — see `backend/app/services/esp32_lib_bridge.py`.

## Permissions caveat

`getUserMedia` requires:

1. HTTPS (or `localhost`) — production already has TLS via the nginx
   layer in `deploy/nginx.prod.conf`, dev is `localhost`.
2. A user gesture — a "Start camera" button. Not auto-prompt on page
   load.
3. Per-origin permission grant — Chrome/Firefox remember it, Safari
   prompts every session.

A small UI toggle in the canvas header is enough. **Don't auto-start;
the user has to opt in.**

## Failure modes worth catching

| Symptom                              | Likely cause                               |
|--------------------------------------|--------------------------------------------|
| `NotAllowedError`                    | User denied permission                     |
| `NotFoundError`                      | No camera on device                        |
| `NotReadableError`                   | Camera busy in another app                 |
| `OverconstrainedError`               | `width:320` not supported by sensor        |
| Black frames                         | Permission granted but no `<video>.play()` |
| Frame drops on backend               | Bandwidth or backend ring overflow         |

The hook should expose a `status: 'idle' | 'requesting' | 'streaming' |
'error'` so the UI can show a clear state next to the board.

## Sources

- [MDN — Taking still photos with getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/Media_Capture_and_Streams_API/Taking_still_photos)
- [WebRTC samples — getUserMedia to canvas](https://webrtc.github.io/samples/src/content/getusermedia/canvas/)
- [websocket-webcam reference impl](https://github.com/wgroeneveld/websocket-webcam)
- [shimabox/v2c — `<video>` to canvas helper](https://github.com/shimabox/v2c)

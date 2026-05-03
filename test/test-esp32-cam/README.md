# test-esp32-cam — emulating the OV2640 over QEMU, faithful

Phase plan for emulating the ESP32-CAM camera (OV2640 + DVP + I²S +
DMA) as **real QEMU peripherals** — no library shim, no fakery. The
upstream `espressif/esp32-camera` driver runs unmodified.

## Reading order

1. `autosearch/00_overview.md` — problem statement and the three
   candidate paths (we picked Path B: real peripherals).
2. `autosearch/01_state_of_the_art.md` — what other projects do.
3. `autosearch/02_qemu_lcgamboa_audit.md` — confirms our QEMU fork
   has *no* camera/DVP/I²S today; lists every ESP32 device it does
   ship.
4. `autosearch/03_browser_webcam_capture.md` — `getUserMedia` →
   canvas → JPEG → WebSocket plumbing.
5. `autosearch/04_proposed_architecture.md` — end-to-end pipeline.
6. `autosearch/05_open_questions.md` — design decisions still open.
7. `autosearch/06_existing_test_patterns.md` — how the DHT22 / HC-SR04
   live tests work; we mirror them.
8. `autosearch/07_ov2640_sccb_spec.md` — minimum register set the
   QEMU OV2640 device must implement.
9. `autosearch/08_dvp_i2s_spec.md` — exact I²S0 register sequence the
   esp32-camera driver issues, and the `lldesc_t` DMA descriptor
   format.
10. `autosearch/09_qemu_build_blueprint.md` — how a Phase-2 patch in
    `wokwi-libs/qemu-lcgamboa/` reaches a running container.

## Reference sources cloned into the tree

`wokwi-libs/esp32-camera/` (Apache 2.0, cloned for offline
reference). Used by autosearch and the C-side QEMU device once we
ship Phase 2. Treat as read-only — never modify.

## Phase plan

| Phase | What lands                                                     | Status   | Validating sketch / test |
|-------|----------------------------------------------------------------|----------|--------------------------|
| 0     | Research + tests skeleton                                      | done     | static metadata + WS-mock |
| 1     | `hw/i2c/esp32_ov2640.c` — SCCB chip-id                         | **PASS** | `test_sccb_probe_live.py` |
| 2     | `hw/misc/esp32_i2s_cam.c` — DMA + EOF                          | **PASS** | `test_dma_smoke_live.py`  |
| 3a    | Host frame injection (webcam → backend → ctypes → QEMU → buf)  | **PASS** | `test_frame_roundtrip_live.py` |
| 3b    | Upstream `esp_camera_init` + `fb_get` round-trip               | xfail    | `test_camera_live.py` (see autosearch/10) |
| 4     | CI build matrix + GH release upload                            | TODO     | (build only)              |
| 5     | Frontend: webcam hook + Camera button + missing pins           | TODO     | manual smoke              |

## Layout

```
test-esp32-cam/
├── README.md                ← you are here
├── autosearch/              ← public-internet research
├── prototypes/              ← standalone validation runners
│   ├── echo_server.py       ← tiny WS echo for the HTML below
│   └── webcam_capture.html  ← getUserMedia → JPEG → WS prototype
├── sketches/
│   ├── camera_init/         ← Phase-3 reproducer (full upstream API)
│   ├── sccb_probe/          ← Phase-1 reproducer (I²C only, no I²S)
│   └── dma_smoke/           ← Phase-2 reproducer (raw I²S+DMA poke)
└── tests/
    ├── test_camera_metadata.py        ← static + frontend
    ├── test_camera_websocket.py       ← in-process WS mock
    ├── test_camera_live.py            ← upstream esp_camera API (xfail, see autosearch/10)
    ├── test_sccb_probe_live.py        ← Phase 1 PASS
    ├── test_dma_smoke_live.py         ← Phase 2 PASS
    ├── test_frame_roundtrip_live.py   ← Phase 3 e2e webcam → fb buffer PASS
    └── webcam_helper.py               ← OpenCV / PIL / synthetic JPEG source
```

## Running

```bash
# Static + WS-mock layers (always green, no backend needed)
python -m pytest test/test-esp32-cam/tests -v

# Full live suite — needs a running backend with the QEMU library
# rebuilt to include the new peripherals.
cd backend && uvicorn app.main:app --port 8001 &
VELXIO_BACKEND_URL=http://localhost:8001 \
    python -m pytest test/test-esp32-cam/tests -v
```

The three `*_live.py` files all start as `@expectedFailure`. As each
phase lands, the matching live test gets its decorator flipped off in
the same diff that lands the QEMU change. That's how the test suite
tracks emulation progress phase-by-phase.

## Webcam → backend prototype (no QEMU)

```bash
pip install websockets
python test/test-esp32-cam/prototypes/echo_server.py &
# then open test/test-esp32-cam/prototypes/webcam_capture.html in a browser
```

Validates the browser-side path described in `autosearch/03` without
needing the backend or QEMU. If frame counter climbs and the preview
panel updates, the transport is good.

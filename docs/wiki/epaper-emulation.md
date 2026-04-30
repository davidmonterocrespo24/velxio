# ePaper / e-Ink emulation in Velxio

Velxio emulates the SSD168x family of mono ePaper panels (Solomon Systech
SSD1681 / SSD1675A / SSD1680 / SSD1683 + UltraChip UC817x clones). One
component, one decoder, one Web Component — parameterised by `panelKind`.

> Phase 1 = mono only. Tri-colour (B/W/R), 7-colour ACeP, and the user-cited
> 13.3" Spectra 6 are roadmap items — see "Phase 2 / out of scope" below.

## Supported panels

| `panelKind` (metadata id) | Size | Resolution | Palette | Controller IC | AVR Uno? | RP2040? | ESP32? |
|---|---|---|---|---|:---:|:---:|:---:|
| `epaper-1in54-bw`  | 1.54" | 200×200 | B/W   | SSD1681           | ✅ paged | ✅ | ✅ |
| `epaper-2in13-bw`  | 2.13" | 250×122 | B/W   | SSD1675A / IL3897 | ✅ paged | ✅ | ✅ |
| `epaper-2in13-bwr` | 2.13" | 250×122 | B/W/R | SSD1680 (3-colour)| ⚠️ tight | ✅ | ✅ |
| `epaper-2in9-bw`   | 2.9"  | 296×128 | B/W   | SSD1680           | ⚠️ tight | ✅ | ✅ |
| `epaper-2in9-bwr`  | 2.9"  | 296×128 | B/W/R | SSD1680 (3-colour)| ❌ flash | ✅ | ✅ |
| `epaper-4in2-bw`   | 4.2"  | 400×300 | B/W   | SSD1683 / UC8176  | ❌ flash | ✅ | ✅ |
| `epaper-7in5-bw`   | 7.5"  | 800×480 | B/W   | UC8179 / GD7965   | ❌       | ⚠️ tight | ✅ |
| `epaper-5in65-7c`  | 5.65" | 600×448 | **ACeP 7-colour** | **UC8159c** | ❌ flash | ⚠️ tight | ✅ |

The 7-colour `epaper-5in65-7c` panel uses a **different controller family**
(UltraChip UC8159c). The decoder lives at
`frontend/src/simulation/displays/UC8159cDecoder.ts` and the matching
backend slave is `Uc8159cEpaperSlave` in `esp32_spi_slaves.py`. The hook
(`EPaperPart.ts`) picks the decoder via `cfg.controllerFamily` so the same
component code drives all panels.

"AVR ⚠️ tight" means the GxEPD2 paged build fits but Adafruit_GFX font
selection matters; "❌" means the binary blows past 32 KB at any sane
config.

## Wiring (every panel — same pinout)

```
                ┌──────────────┐
                │   ePaper     │
                │              │
                │  GND  VCC   │  GND  → board GND
                │              │  VCC  → board 3V3
                │  SCK  SDI   │  SCK  → SPI clock (SCK)
                │              │  SDI  → SPI MOSI
                │   CS   DC   │  CS   → any digital
                │              │  DC   → any digital (LOW = command)
                │  RST BUSY   │  RST  → any digital (active LOW)
                │              │  BUSY → any digital (input — HIGH while refreshing)
                └──────────────┘
```

**Pin order in GxEPD2 constructors**: `(CS, DC, RST, BUSY)`. Use those
exact pin numbers in the sketch.

## How the emulator works

There are three rendering paths, picked automatically at runtime by
`EPaperPart.attachEvents()` based on which simulator owns the board:

| Board family | Decoder location | Plumbing |
|---|---|---|
| **AVR** (Uno / Nano / Mega) | Browser, `frontend/src/simulation/displays/SSD168xDecoder.ts` | Hooks `simulator.spi.onByte`. CS / DC / RST tracked via `pinManager.onPinChange`. |
| **RP2040** (Pico / Pico W) | Browser, same decoder | Hooks `rp2040.spi[bus].onTransmit`. Same pin tracking. |
| **ESP32** family | Backend, `backend/app/services/esp32_spi_slaves.py::Ssd168xEpaperSlave` | Worker subprocess decodes SPI synchronously inside the QEMU thread; emits `epaper_update` WS event with the latched framebuffer (base64 palette buffer). |

For all three paths:

- **Latched RAM**: pixels written via `0x24 WRITE_BLACK_VRAM` and `0x26
  WRITE_RED_VRAM` only become visible after `0x20 MASTER_ACTIVATION`.
- **BUSY pin**: driven HIGH for `refreshMs` (default 50 ms) after every
  activation, then back LOW. Real hardware is 1–5 s; the default is
  shrunk for snappy testing. Bump it via the `refreshMs` property.
- **Auto-RAM-window** auto-increment honours
  `0x11 DATA_ENTRY_MODE` (default 0x03 = X+, Y+, X-first).

## Library compatibility matrix

| Library | AVR | RP2040 | ESP32 | Notes |
|---|:---:|:---:|:---:|---|
| **GxEPD2** (Jean-Marc Zingg) | ✅ ≤ 2.13" only | ✅ | ✅ | The de-facto Arduino library; tested against. |
| **Adafruit_EPD** | ❌ RAM | ✅ | ✅ | Should work — the SSD168x command set is identical. |
| **ESPHome `waveshare_epaper`** | n/a | n/a | ✅ | Generates the same SPI traffic as Adafruit_EPD; tested on real hardware. |

The example sketches use GxEPD2. Both `GxEPD2` and `Adafruit GFX
Library` are auto-installed by the editor when you load any example
that lists them in `libraries: [...]`.

## Try it

1. Open `/examples` and pick **ePaper 1.54" Hello — Arduino Uno**.
2. Hit **Run**. After ~1 s the panel "refreshes" (you'll see the BUSY
   shimmer overlay) and the 1.54" canvas shows "Velxio / ePaper / OK!"
   in black on the off-white paper background.
3. Try the **2.9" ESP32 Weather** example next — that path goes through
   the backend SSD168x slave (`epaper_update` events arriving over the
   WebSocket), not the in-browser decoder. Same UX from the user's POV.

## Phase 2 / out of scope (deliberately deferred)

| Feature | Why not yet |
|---|---|
| ~~Tri-colour SSD168x (B/W/R)~~ | **✅ shipped** — `epaper-2in13-bwr`, `epaper-2in9-bwr` panel kinds. The decoder's red RAM plane (`0x26 WRITE_RED_VRAM`) was always there; we just enabled it for the SSD1680 3-colour panels. |
| ~~UC8159c 5.65" 7-colour ACeP~~ | **✅ shipped** — `epaper-5in65-7c` panel kind. New decoder family, same hook + Web Component. |
| Other UC81xx panels (UC8176 4.2" alt, UC8179 7.5" full driver) | The SSD168x driver covers these panels' GxEPD2 path today (those Arduino driver classes emit SSD168x-compatible traffic for B/W). Only matters if someone uses a panel whose GxEPD2 class strictly emits UC81xx commands. |
| **E Ink Spectra 6 13.3" 1200×1600** (Seeed [6569](https://www.seeedstudio.com/13-3inch-Six-Color-eInk-ePaper-Display-with-1200x1600-Pixels-p-6569.html)) | Reverse-engineered command set; ship after Phase 1 proves the scaffold and we can capture real SPI traces from a Seeed EE02. |
| IT8951 Carta panels | Different protocol entirely (SPI packet stream). |
| LUT (`0x32`) waveform validation | Accept silently; never validate. Real panels sometimes send vendor-specific LUTs that aren't worth fingerprinting. |
| Real-time partial-window refresh | Phase 1 always does a full-frame refresh. |
| MicroPython on Pi Pico W | Phase 2.5 — no current `epaper` MicroPython driver tested in Velxio. |

## Code map

| File | Purpose |
|---|---|
| `frontend/src/simulation/displays/SSD168xDecoder.ts` | TS port of the reference Python decoder |
| `frontend/src/simulation/displays/EPaperPanels.ts`   | Per-panel geometry + controller assignments |
| `frontend/src/components/velxio-components/EPaperElement.ts` | `<velxio-epaper>` Web Component |
| `frontend/src/components/velxio-components/EPaper.tsx` | Thin React wrapper |
| `frontend/src/simulation/parts/EPaperPart.ts` | `attachEvents` factory — branches AVR / RP2040 / ESP32 |
| `frontend/src/data/examples-displays-epaper.ts` | 5 gallery examples |
| `frontend/public/components-metadata.json` | 5 picker entries (category: `displays`) |
| `backend/app/services/esp32_spi_slaves.py` | `Ssd168xEpaperSlave` for the ESP32 path |
| `test/test_epaper/ssd168x_decoder.py` | Reference Python decoder (the spec) |
| `test/test_epaper/test_ssd168x_protocol.py` | 11 pure-Python protocol tests |
| `frontend/src/__tests__/ssd168x-decoder.test.ts` | Vitest port of the same tests |
| `test/test_epaper/sketches/` | 5 canonical "hello world" sketches |

## See also

- [Research dossier](../../test/test_epaper/autosearch/) — the
  pre-implementation research notes covering Seeed catalog,
  controllers, SPI protocol, library compatibility, SVG layouts, and
  the phased plan.
- [Custom chips (ESP32 backend runtime)](./custom-chips-esp32-backend-runtime.md)
  — the same backend-runs-the-peripheral pattern that the ePaper SSD168x
  slave mirrors.

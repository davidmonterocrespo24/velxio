# Component Datasheets (Hover Panel)

How to author the Markdown "datasheet" files that show up in the floating
panel when you hover a component in the **Add Component** picker.

This is a **manual, content-only** task: you drop a `.md` file in the right
folder and it appears on hover. No build step, no code changes, no
regeneration.

---

## Table of Contents

1. [What this is](#what-this-is)
2. [TL;DR](#tldr)
3. [Where the files live & how they are named](#where-the-files-live--how-they-are-named)
4. [Finding a component's `id`](#finding-a-components-id)
5. [Front-matter: brand & buy link](#front-matter-brand--buy-link)
6. [The Markdown body](#the-markdown-body)
7. [What the panel shows (doc vs metadata)](#what-the-panel-shows-doc-vs-metadata)
8. [Full annotated example](#full-annotated-example)
9. [Step-by-step: add a datasheet](#step-by-step-add-a-datasheet)
10. [Writing tips](#writing-tips)
11. [File reference](#file-reference)
12. [Appendix: component checklist](#appendix-component-checklist)

---

## What this is

When you hover a card in the component picker, a floating "datasheet" panel
appears next to it. It has two data sources:

- **Auto-generated metadata** (name, category, pin count, default properties,
  tags) — always present, comes from `components-metadata.json`.
- **A hand-authored Markdown datasheet** (optional) — the richer prose,
  pinout table, wiring tips, plus the component **brand** and a **Buy** link.

This page is about that second part. If a component has no datasheet file, the
panel still works — it just falls back to the thin auto-generated description.

---

## TL;DR

Create one file:

```
frontend/src/components/component-docs/<category>/<id>.md
```

```markdown
---
brand: Aosong (AM2302)
buy: https://www.example.com/product/dht22
---
Short overview of what the part is and how it works.

| Pin | Role |
| --- | --- |
| VCC | 3.3–5 V supply |
| DATA | single-wire data (needs pull-up) |
| GND | ground |

- A couple of **spec** bullets.

**Tip:** one practical wiring hint.
```

Save, refresh the editor, hover the card. Done.

---

## Where the files live & how they are named

```
frontend/src/components/
└── component-docs/
    ├── README.md            ← short in-repo reminder of this format
    ├── sensors/
    │   ├── hc-sr04.md
    │   └── dht22.md
    ├── output/
    │   └── led.md
    ├── input/
    │   ├── potentiometer.md
    │   └── pushbutton.md
    └── displays/
        └── ssd1306.md
```

Two rules:

1. **The file name must be `<id>.md`** where `<id>` is the component's id
   from the metadata (see [below](#finding-a-components-id)). This is the only
   thing that links a doc to a component. `hc-sr04.md` → the `hc-sr04`
   component.

2. **The `<category>` folder is just for tidiness.** The loader matches docs
   by file name and *ignores the folder*, so moving `led.md` from `output/` to
   `misc/` would not break the link. Still, please file each doc under the
   component's own category so the tree stays navigable:

   | Folder | Category |
   | --- | --- |
   | `analog/` | Analog (diodes, transistors, op-amps, regulators, batteries…) |
   | `boards/` | Boards |
   | `displays/` | Displays (LCD, OLED, ePaper, TFT) |
   | `electromech/` | Electromechanical (relays, motor drivers) |
   | `input/` | Input (buttons, pots, switches, keypads, encoders) |
   | `logic/` | Logic (gates, flip-flops, 74HC ICs, custom chips) |
   | `motors/` | Motors (servo, stepper, drivers) |
   | `other/` | Other (7-seg, joystick, RTC, NeoPixel matrix…) |
   | `output/` | Output (LED, RGB LED, buzzer, bar graph) |
   | `passive/` | Passive (resistors, capacitors, inductors, IR) |
   | `sensors/` | Sensors |

> There is no `communication/` folder in use yet; if you document an I²C/SPI
> part that is categorised as `communication`, create the folder to match.

---

## Finding a component's `id`

The `id` is **not** the display name — it is the stable slug in the metadata.
Two easy ways to find it:

**A. Search the metadata file.** Open
`frontend/public/components-metadata.json` and search for the display name; the
`"id"` field next to it is what you want:

```json
{
  "id": "hc-sr04",
  "tagName": "wokwi-hc-sr04",
  "name": "HC-SR04",
  "category": "sensors"
}
```

**B. Use the checklist** at the [bottom of this page](#appendix-component-checklist),
which lists every component's id grouped by category (and marks the ones that
already have a datasheet).

Ids are lowercase-kebab. A few examples:

| Display name | `id` | File |
| --- | --- | --- |
| LED | `led` | `output/led.md` |
| HC-SR04 | `hc-sr04` | `sensors/hc-sr04.md` |
| 2N2222 (NPN BJT) | `bjt-2n2222` | `analog/bjt-2n2222.md` |
| Resistor 10 kΩ | `resistor-10k` | `passive/resistor-10k.md` |
| SSD1306 OLED (I2C) | `ssd1306-i2c` | `displays/ssd1306-i2c.md` |

---

## Front-matter: brand & buy link

A doc may start with a small `---`-delimited block giving the manufacturer and
a purchase URL. **Both fields are optional.** When present, the panel shows a
`by <brand>` line under the title and a **Buy** button in the footer.

```markdown
---
brand: Aosong (AM2302)
buy: https://www.example.com/product/dht22
---
Body starts on the line after the closing ---.
```

Rules:

- `brand` — plain text (manufacturer / brand / part family).
- `buy` — **must be `http://` or `https://`**. Any other scheme (e.g.
  `javascript:`) is ignored for safety and the button won't render.
- The closing `---` must be on its own line.
- If you omit the whole block, the file is treated as pure Markdown body.

> The seeded docs use vendor **search** URLs (e.g. an Amazon search) as
> placeholders. Replace them with the real product page or your affiliate link.

---

## The Markdown body

Everything after the front-matter is rendered with **GitHub-Flavoured
Markdown** (via `react-markdown` + `remark-gfm`). Supported:

- **Bold**, `inline code`, and links.
- Bullet and numbered lists.
- **Tables** (great for pinouts).
- Headings (`##`), blockquotes.

**Not** supported (by design):

- **Raw HTML** is not rendered (it's escaped). Use Markdown only.
- Images. Keep datasheets textual — the panel is a small popover.

A good datasheet is short and scannable — a one-line overview, a pinout table,
a few spec bullets, and one wiring tip. The panel scrolls, so longer docs are
fine, but front-load the essentials.

---

## What the panel shows (doc vs metadata)

The panel is assembled like this, top to bottom:

```
┌─────────────────────────────────────┐
│ [thumb]  Name                        │  ← from metadata
│          CATEGORY · N pins           │  ← from metadata
│          by <brand>                  │  ← from doc front-matter
├─────────────────────────────────────┤
│ <your Markdown datasheet body>       │  ← from doc  (replaces the thin
│                                      │     auto-generated description)
├─────────────────────────────────────┤
│ PROPERTIES                           │  ← from metadata (always)
│ color        red                     │
│ brightness   1                       │
├─────────────────────────────────────┤
│ tag  tag  tag                        │  ← from metadata
├─────────────────────────────────────┤
│                        [  Buy  ]     │  ← from doc front-matter `buy`
└─────────────────────────────────────┘
```

**Takeaway:** the **Properties** list (with default values) is rendered
automatically from metadata *below* your text. **Don't repeat property
defaults in the body** — spend the words on what the JSON can't express: how
the part works, its pinout, and wiring gotchas.

---

## Full annotated example

`frontend/src/components/component-docs/sensors/hc-sr04.md`:

```markdown
---
brand: Generic (HC-SR04)
buy: https://www.amazon.com/s?k=HC-SR04+ultrasonic+sensor
---
HC-SR04 ultrasonic distance sensor. Fire a 10 µs pulse on **TRIG**, then
measure the HIGH width on **ECHO** — distance = time × 0.0343 / 2 (cm).

| Pin | Role |
| --- | --- |
| VCC | 5 V supply |
| TRIG | trigger input (10 µs pulse) |
| ECHO | echo output (width ∝ distance) |
| GND | ground |

- Range **2 cm – 400 cm**, beam ~15°.
- ECHO is a **5 V** signal — level-shift before a 3.3 V board (ESP32/Pico).

**Tip:** `pulseIn(ECHO, HIGH)` returns microseconds; divide by 58 for cm.
```

Which renders as: title + `SENSORS` + pin count badge, a `by Generic
(HC-SR04)` line, the overview paragraph, the pinout table, the two spec
bullets, the tip with inline code, the auto Properties list, tags, and a blue
**Buy** button.

---

## Step-by-step: add a datasheet

1. **Find the id** of the component (see
   [Finding a component's id](#finding-a-components-id)). Say it's `relay`.
2. **Pick the category folder** — Relay is `electromech`, so the path is
   `frontend/src/components/component-docs/electromech/relay.md`.
3. **Create the file.** Add the optional front-matter, then the body
   (overview → pinout table → specs → tip).
4. **Save.** In dev (`npm run dev`) the change hot-reloads. If the editor was
   already open, just **refresh** — the doc is loaded lazily on first hover and
   cached.
5. **Verify.** Open **Add Component**, hover the Relay card, confirm the
   datasheet, brand line, and Buy button look right.

That's it — no registration, no generator run, no code edit. The loader
(`componentDocs.ts`) discovers every `component-docs/**/*.md` automatically via
`import.meta.glob`.

---

## Writing tips

- **Lead with one sentence** that says what the part is and its core behaviour.
- **Always include a pinout table** — it's the single most useful thing the
  metadata lacks.
- **Bold the numbers** that matter (voltages, currents, ranges).
- **One `**Tip:**`** at the end with the most common wiring gotcha
  (pull-ups, series resistors, level shifting, decoupling…).
- **Don't restate the Properties defaults** — they render automatically.
- **Keep it under ~15 lines** of body where you can. Scannable beats complete.
- Use real units and symbols (`Ω`, `µF`, `≈`) — UTF-8 is fine.

---

## File reference

| File | Role |
| --- | --- |
| `frontend/src/components/component-docs/<category>/<id>.md` | The datasheets you author |
| `frontend/src/components/component-docs/README.md` | Short in-repo reminder of this format |
| `frontend/src/components/componentDocs.ts` | Loader — globs the docs, parses front-matter, caches |
| `frontend/src/components/ComponentInfoPanel.tsx` | The hover panel that renders it |
| `frontend/public/components-metadata.json` | Source of the `id`, name, category, properties (generated — do not hand-edit; see [Component Metadata Generator](component-metadata-generator.md)) |

---

## Appendix: component checklist

Every component id, grouped by category. `[x]` = already has a datasheet,
`[ ]` = still needs one. Snapshot of **153 components, 6 documented**.

> To regenerate this list, list the ids in `components-metadata.json` and check
> which have a matching file under `component-docs/`.

#### analog (31)
- [ ] `battery-9v` — 9V Battery
- [ ] `battery-aa` — AA Battery (1.5V)
- [ ] `battery-coin-cell` — Coin Cell (CR2032, 3V)
- [ ] `bjt-2n2222` — 2N2222 (NPN BJT)
- [ ] `bjt-2n3055` — 2N3055 (NPN Power BJT)
- [ ] `bjt-2n3906` — 2N3906 (PNP BJT)
- [ ] `bjt-bc547` — BC547 (NPN BJT)
- [ ] `bjt-bc557` — BC557 (PNP BJT)
- [ ] `diode` — Diode (generic)
- [ ] `diode-1n4007` — 1N4007 (1 kV Rectifier)
- [ ] `diode-1n4148` — 1N4148 (Small-Signal Diode)
- [ ] `diode-1n5817` — 1N5817 (Schottky 20V)
- [ ] `diode-1n5819` — 1N5819 (Schottky 40V)
- [ ] `mosfet-2n7000` — 2N7000 (N-MOSFET)
- [ ] `mosfet-fqp27p06` — FQP27P06 (P-MOSFET)
- [ ] `mosfet-irf540` — IRF540 (N-MOSFET Power)
- [ ] `mosfet-irf9540` — IRF9540 (P-MOSFET)
- [ ] `opamp-ideal` — Ideal Op-Amp
- [ ] `opamp-lm324` — LM324 (Quad Op-Amp)
- [ ] `opamp-lm358` — LM358 (Dual Op-Amp)
- [ ] `opamp-lm741` — LM741 (Op-Amp)
- [ ] `opamp-tl072` — TL072 (JFET Op-Amp)
- [ ] `opto-4n25` — 4N25 (Optocoupler)
- [ ] `opto-pc817` — PC817 (Optocoupler)
- [ ] `power-supply` — Regulated Power Supply
- [ ] `reg-7805` — 7805 (+5V Linear Regulator)
- [ ] `reg-7812` — 7812 (+12V Linear Regulator)
- [ ] `reg-7905` — 7905 (−5V Linear Regulator)
- [ ] `reg-lm317` — LM317 (Adjustable Linear Regulator)
- [ ] `signal-generator` — Signal Generator
- [ ] `zener-1n4733` — 1N4733 (5.1 V Zener)

#### boards (4)
- [ ] `arduino-mega` — Arduino Mega
- [ ] `arduino-nano` — Arduino Nano
- [ ] `arduino-uno` — Arduino Uno
- [ ] `esp32-devkit-v1` — ESP32 Devkit V1

#### displays (16)
- [ ] `epaper-1in54-bw` — ePaper 1.54" (200×200, B/W)
- [ ] `epaper-2in13-bw` — ePaper 2.13" (250×122, B/W)
- [ ] `epaper-2in13-bwr` — ePaper 2.13" (250×122, B/W/Red)
- [ ] `epaper-2in9-bw` — ePaper 2.9" (296×128, B/W)
- [ ] `epaper-2in9-bwr` — ePaper 2.9" (296×128, B/W/Red)
- [ ] `epaper-4in2-bw` — ePaper 4.2" (400×300, B/W)
- [ ] `epaper-5in65-7c` — ePaper 5.65" (600×448, ACeP 7-colour)
- [ ] `epaper-7in5-bw` — ePaper 7.5" (800×480, B/W)
- [ ] `ili9341` — ILI9341
- [ ] `lcd1602` — LCD1602
- [ ] `lcd1602-i2c` — LCD 16x2 (I2C)
- [ ] `lcd2004` — LCD2004
- [ ] `lcd2004-i2c` — LCD 20x4 (I2C)
- [x] `ssd1306` — SSD1306
- [ ] `ssd1306-i2c` — SSD1306 OLED (I2C)
- [ ] `ssd1306-spi` — SSD1306 OLED (SPI)

#### electromech (2)
- [ ] `motor-driver-l293d` — L293D (Dual H-Bridge Motor Driver)
- [x] `relay` — Relay (SPDT)

#### input (6)
- [ ] `dip-switch-8` — DIP Switch 8
- [ ] `ky-040` — KY-040 Rotary Encoder
- [ ] `membrane-keypad` — Membrane Keypad
- [x] `potentiometer` — Potentiometer
- [x] `pushbutton` — Pushbutton
- [ ] `slide-switch` — Slide Switch

#### logic (25)
- [ ] `flip-flop-d` — D Flip-Flop
- [ ] `flip-flop-jk` — JK Flip-Flop
- [ ] `flip-flop-t` — T Flip-Flop
- [ ] `ic-74hc00` — 74HC00 (Quad 2-input NAND)
- [ ] `ic-74hc02` — 74HC02 (Quad 2-input NOR)
- [ ] `ic-74hc04` — 74HC04 (Hex Inverter)
- [ ] `ic-74hc08` — 74HC08 (Quad 2-input AND)
- [ ] `ic-74hc14` — 74HC14 (Hex Schmitt Inverter)
- [ ] `ic-74hc32` — 74HC32 (Quad 2-input OR)
- [ ] `ic-74hc86` — 74HC86 (Quad 2-input XOR)
- [ ] `logic-gate-and` — AND Gate
- [ ] `logic-gate-and-3` — AND Gate (3-input)
- [ ] `logic-gate-and-4` — AND Gate (4-input)
- [ ] `logic-gate-nand` — NAND Gate
- [ ] `logic-gate-nand-3` — NAND Gate (3-input)
- [ ] `logic-gate-nand-4` — NAND Gate (4-input)
- [ ] `logic-gate-nor` — NOR Gate
- [ ] `logic-gate-nor-3` — NOR Gate (3-input)
- [ ] `logic-gate-nor-4` — NOR Gate (4-input)
- [ ] `logic-gate-not` — NOT Gate (Inverter)
- [ ] `logic-gate-or` — OR Gate
- [ ] `logic-gate-or-3` — OR Gate (3-input)
- [ ] `logic-gate-or-4` — OR Gate (4-input)
- [ ] `logic-gate-xnor` — XNOR Gate
- [ ] `logic-gate-xor` — XOR Gate

#### motors (4)
- [ ] `a4988` — A4988 Stepper Driver
- [ ] `biaxial-stepper` — Biaxial Stepper
- [ ] `servo` — Servo
- [ ] `stepper-motor` — Stepper Motor

#### other (18)
- [ ] `7segment` — 7 Segment
- [ ] `analog-joystick` — Analog Joystick
- [ ] `big-sound-sensor` — Big Sound Sensor
- [ ] `ds1307` — DS1307
- [ ] `flame-sensor` — Flame Sensor
- [ ] `gas-sensor` — Gas Sensor
- [ ] `heart-beat-sensor` — Heart Beat Sensor
- [ ] `hx711` — HX711
- [ ] `ks2e-m-dc5` — KS2E-M-DC5
- [ ] `led-ring` — LED Ring
- [ ] `microsd-card` — microSD Card
- [ ] `nano-rp2040-connect` — Nano RP2040 Connect
- [ ] `neopixel-matrix` — NeoPixel Matrix
- [ ] `pushbutton-6mm` — Pushbutton 6mm
- [ ] `rotary-dialer` — Rotary Dialer
- [ ] `slide-potentiometer` — Slide Potentiometer
- [ ] `small-sound-sensor` — Small Sound Sensor
- [ ] `tilt-switch` — Tilt Switch

#### output (5)
- [ ] `buzzer` — Buzzer
- [x] `led` — LED
- [ ] `led-bar-graph` — Led Bar Graph
- [ ] `neopixel` — Neopixel
- [ ] `rgb-led` — RGB Led

#### passive (34)
- [ ] `cap-100n` — Cap. 100 nF
- [ ] `cap-100p` — Cap. 100 pF
- [ ] `cap-10n` — Cap. 10 nF
- [ ] `cap-10p` — Cap. 10 pF
- [ ] `cap-1n` — Cap. 1 nF
- [ ] `cap-1u` — Cap. 1 µF
- [ ] `cap-22p` — Cap. 22 pF
- [ ] `cap-elec-1000u` — Electrolytic 1000 µF
- [ ] `cap-elec-100u` — Electrolytic 100 µF
- [ ] `cap-elec-10u` — Electrolytic 10 µF
- [ ] `cap-elec-1u` — Electrolytic 1 µF
- [ ] `cap-elec-470u` — Electrolytic 470 µF
- [ ] `cap-elec-47u` — Electrolytic 47 µF
- [ ] `capacitor` — Cap. ceramic (custom)
- [ ] `capacitor-electrolytic` — Electrolytic Cap. (custom)
- [ ] `franzininho` — Franzininho
- [ ] `ind-100u` — Inductor 100 µH
- [ ] `ind-10m` — Inductor 10 mH
- [ ] `ind-1m` — Inductor 1 mH
- [ ] `inductor` — Inductor (custom)
- [ ] `ir-receiver` — IR Receiver
- [ ] `ir-remote` — IR Remote
- [ ] `resistor` — Resistor (custom)
- [ ] `resistor-100k` — Resistor 100 kΩ
- [ ] `resistor-10k` — Resistor 10 kΩ
- [ ] `resistor-1k` — Resistor 1 kΩ
- [ ] `resistor-1m` — Resistor 1 MΩ
- [ ] `resistor-220` — Resistor 220 Ω
- [ ] `resistor-22k` — Resistor 22 kΩ
- [ ] `resistor-2k2` — Resistor 2.2 kΩ
- [ ] `resistor-330` — Resistor 330 Ω
- [ ] `resistor-470` — Resistor 470 Ω
- [ ] `resistor-47k` — Resistor 47 kΩ
- [ ] `resistor-4k7` — Resistor 4.7 kΩ

#### sensors (8)
- [ ] `bmp280` — BMP280 (Pressure + Temp)
- [x] `dht22` — DHT22
- [x] `hc-sr04` — HC-SR04
- [ ] `mpu6050` — MPU6050
- [ ] `ntc-temperature-sensor` — NTC Temperature Sensor
- [ ] `photodiode` — Photodiode
- [ ] `photoresistor-sensor` — Photoresistor Sensor
- [ ] `pir-motion-sensor` — PIR Motion Sensor

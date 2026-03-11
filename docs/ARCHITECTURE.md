# Project Architecture - Velxio Arduino Emulator

## Overview

This project is a fully local Arduino emulator using official Wokwi repositories for maximum compatibility. It features real AVR8 CPU emulation, 48+ interactive electronic components, a comprehensive wire system, and a build-time component discovery pipeline.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        USER (Browser)                               │
│                      http://localhost:5173                          │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    FRONTEND (React 19 + Vite 7)                     │
│                                                                     │
│  ┌────────────────┐  ┌──────────────────┐  ┌───────────────────┐   │
│  │ Monaco Editor  │  │  Zustand Stores  │  │  SimulatorCanvas  │   │
│  │  (Code Edit)   │  │ (Editor+Sim)     │  │  (Components+     │   │
│  │  C++ / Arduino │  │                  │  │   Wires+Pins)     │   │
│  └────────┬───────┘  └────────┬─────────┘  └────────┬──────────┘   │
│           │                   │                      │              │
│           ▼                   ▼                      ▼              │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              AVRSimulator (avr8js)                           │   │
│  │  CPU 16MHz · Timer0/1/2 · USART · ADC · PORTB/C/D          │   │
│  │  ~60fps · 267k cycles/frame · Speed 0.1x-10x               │   │
│  └──────────────────────────────┬───────────────────────────────┘   │
│                                 │                                   │
│                                 ▼                                   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │           PinManager + PartSimulationRegistry               │   │
│  │  Digital/PWM/Analog listeners · 16 registered parts         │   │
│  │  LED · RGB · Button · Pot · LCD · Servo · Buzzer · etc.     │   │
│  └──────────────────────────────┬───────────────────────────────┘   │
│                                 │                                   │
│                                 ▼                                   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │        48+ wokwi-elements (Lit Web Components)              │   │
│  │  DynamicComponent renderer · ComponentRegistry (metadata)   │   │
│  │  ComponentPickerModal · Property dialog · Pin selector      │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │               Wire System                                    │   │
│  │  Orthogonal routing · Segment editing · 8 signal colors     │   │
│  │  Overlap offset · Pin overlay · Grid snapping (20px)        │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ HTTP (Axios)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                BACKEND (FastAPI + Python)                            │
│                  http://localhost:8001                               │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  POST /api/compile/     → Compile Arduino code to .hex     │    │
│  │  GET  /api/compile/boards → List available boards          │    │
│  │  GET  /                 → API info                          │    │
│  │  GET  /health           → Health check                      │    │
│  └──────────────────────────────┬──────────────────────────────┘    │
│                                 ▼                                   │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │         ArduinoCLIService                                   │    │
│  │  Auto-installs arduino:avr core                             │    │
│  │  Temp directory + subprocess.run via asyncio.to_thread      │    │
│  └──────────────────────────────┬──────────────────────────────┘    │
└─────────────────────────────────┼──────────────────────────────────┘
                                  │
                                  ▼
                       ┌──────────────────────┐
                       │    arduino-cli       │
                       │   (Local system)     │
                       └──────────────────────┘
```

## Data Flow

### 1. Code Editing
```
User writes Arduino code
    ↓
Monaco Editor (C++, dark theme, autocomplete)
    ↓
Zustand useEditorStore
    ↓
State: { code, theme, fontSize }
```

### 2. Compilation
```
Click "Compile"
    ↓
EditorToolbar.tsx → compileCode()
    ↓
Axios POST → http://localhost:8001/api/compile/
    ↓
Backend: ArduinoCLIService.compile()
    ↓
arduino-cli compile --fqbn arduino:avr:uno --output-dir build/
    ↓
Reads build/sketch.ino.hex → returns hex_content
    ↓
Frontend: useSimulatorStore.setCompiledHex(hex)
    ↓
Auto-calls loadHex() → CPU + peripherals created
```

### 3. Simulation (Real AVR8 Emulation)
```
Click "Run"
    ↓
useSimulatorStore.startSimulation()
    ↓
AVRSimulator.start()
    ↓
requestAnimationFrame loop @ ~60fps
    ↓
Each frame: Math.floor(267000 × speed) cycles
    ↓
For each cycle:
  ├── avrInstruction(cpu)   ← Execute AVR instruction
  └── cpu.tick()            ← Update peripherals/timers
    ↓
Port writes → AVRIOPort listeners
    ↓
PinManager.updatePort(portName, newValue, oldValue)
    ↓
Per-pin callbacks fire for changed pins
    ↓
PartSimulationRegistry.onPinStateChange()
    ↓
wokwi web components update visually

Additionally per frame:
  pollPwmRegisters() → reads OCR0A/B, OCR1AL/BL, OCR2A/B
    ↓
  PinManager.updatePwm(pin, dutyCycle)
```

### 4. Input Components Flow
```
User presses a pushbutton on canvas
    ↓
Web component fires 'button-press' event
    ↓
DynamicComponent catches event
    ↓
PartSimulationRegistry.attachEvents() handler
    ↓
AVRSimulator.setPinState(arduinoPin, LOW)
    ↓
AVRIOPort.setPin(bitIndex) injects external pin state
    ↓
CPU reads pin value in next instruction
```

### 5. Wire Creation Flow
```
Click pin on component A → startWireCreation(endpoint)
    ↓
Mouse move → updateWireInProgress(x, y)
    ↓
WireInProgressRenderer shows dashed green L-shape preview
    ↓
Click pin on component B → finishWireCreation(endpoint)
    ↓
Wire created with midpoint control point
    ↓
WireLayer renders orthogonal SVG path
    ↓
Components subscribe to Arduino pins via wire lookup
```

## Key Components

### Frontend

#### 1. Stores (Zustand)

**useEditorStore** — Code editor state
| Property | Type | Default |
|----------|------|---------|
| `code` | `string` | Blink example sketch |
| `theme` | `'vs-dark' \| 'light'` | `'vs-dark'` |
| `fontSize` | `number` | `14` |

Methods: `setCode()`, `setTheme()`, `setFontSize()`

**useSimulatorStore** — Simulation + components + wires state
| Property | Type | Description |
|----------|------|-------------|
| `simulator` | `AVRSimulator \| null` | CPU emulator instance |
| `pinManager` | `PinManager` | Pin-to-component mapping |
| `running` | `boolean` | Simulation active |
| `compiledHex` | `string \| null` | Compiled hex content |
| `components` | `Component[]` | All electronic components |
| `wires` | `Wire[]` | All wire connections |
| `selectedWireId` | `string \| null` | Currently selected wire |
| `wireInProgress` | `WireInProgress \| null` | Wire being created |

Methods (20+):
- **Simulation**: `initSimulator()`, `loadHex()`, `startSimulation()`, `stopSimulation()`, `resetSimulation()`, `setCompiledHex()`, `setRunning()`
- **Components**: `addComponent()`, `removeComponent()`, `updateComponent()`, `updateComponentState()`, `handleComponentEvent()`, `setComponents()`
- **Wires**: `addWire()`, `removeWire()`, `updateWire()`, `setSelectedWire()`, `setWires()`
- **Wire creation**: `startWireCreation()`, `updateWireInProgress()`, `finishWireCreation()`, `cancelWireCreation()`
- **Wire positions**: `updateWirePositions(componentId)`, `recalculateAllWirePositions()`

Notable behaviors:
- `removeComponent()` cascades: removes all connected wires
- `updateComponent()` auto-recalculates wire positions when x/y changes
- `setCompiledHex()` auto-calls `loadHex()`

#### 2. Simulation Engine

**AVRSimulator** — Real ATmega328p emulation
- **CPU**: 16MHz clock, 32KB program memory (16K words)
- **Timers**: Timer0 (`timer0Config`), Timer1 (`timer1Config`), Timer2 (`timer2Config`)
- **Serial**: USART (`usart0Config`) at 16MHz
- **ADC**: Analog-to-digital converter (`adcConfig`)
- **GPIO**: PORTB (pins 8-13), PORTC (A0-A5), PORTD (pins 0-7)
- **Simulation loop**: ~60fps via `requestAnimationFrame`, `267000 × speed` cycles/frame
- **Speed control**: 0.1x – 10x multiplier
- **PWM polling**: Reads OCR0A/B, OCR1AL/BL, OCR2A/B each frame
- **API**: `loadHex()`, `start()`, `stop()`, `reset()`, `step()`, `setSpeed()`, `setPinState()`, `getADC()`

**PinManager** — Pin state tracking and listener dispatch
- **Digital**: `onPinChange(pin, callback)`, `updatePort(portName, newValue, oldValue)`, `getPinState(pin)`
- **PWM**: `onPwmChange(pin, callback)`, `updatePwm(pin, dutyCycle)`, `getPwmValue(pin)`
- **Analog**: `onAnalogChange(pin, callback)`, `setAnalogVoltage(pin, voltage)`
- **Utility**: `getListenersCount()`, `clearAllListeners()`

**PartSimulationRegistry** — Plugin system for component behaviors
- Interface: `onPinStateChange(pinName, state, element)` for outputs, `attachEvents(element, simulator, pinHelper) → cleanup` for inputs
- **16 registered parts**:

| Part | Type | Key Behavior |
|------|------|--------------|
| `led` | Output | Pin A state → `element.value` |
| `rgb-led` | Output | Digital + PWM on R/G/B → `ledRed/Green/Blue` |
| `led-bar-graph` | Output | 10 LEDs (A1-A10) → `.values` array |
| `7segment` | Output | 8 segments (A-G + DP) → `.values` array |
| `pushbutton` | Input | Press/release → `setPinState(pin, LOW/HIGH)` |
| `pushbutton-6mm` | Input | Same as pushbutton |
| `slide-switch` | Input | Change event → pin state |
| `dip-switch-8` | Input | 8 independent switches |
| `potentiometer` | Input | Value (0-1023) → ADC voltage injection |
| `slide-potentiometer` | Input | Same via SIG/OUT pins |
| `photoresistor-sensor` | Input/Output | Default 2.5V on AO, monitors DO for LED |
| `analog-joystick` | Input | VRX/VRY (ADC) + SW (digital) |
| `servo` | Output | Polls OCR1A/ICR1 → angle 0-180° |
| `buzzer` | Output | Web Audio API, reads Timer2 registers |
| `lcd1602` | Output | Full HD44780 4-bit protocol (16×2) |
| `lcd2004` | Output | Full HD44780 4-bit protocol (20×4) |

#### 3. Component System

**ComponentRegistry** — Singleton from `/components-metadata.json`
- **48 components** across 8 categories
- Auto-generated at build time by `scripts/generate-component-metadata.ts` (TypeScript AST parser)
- Methods: `getAllComponents()`, `getByCategory()`, `getById()`, `search()`, `getCategories()`

| Category | Count | Components |
|----------|-------|------------|
| Boards | 4 | Arduino Uno, Mega, Nano, etc. |
| Sensors | 6 | DHT22, HC-SR04, PIR, photoresistor, etc. |
| Displays | 3 | LCD 1602, LCD 2004, 7-segment |
| Input | 5 | Buttons, switches, potentiometers, joystick |
| Output | 5 | LEDs, RGB LED, LED bar graph, buzzer |
| Motors | 2 | Servo, stepper |
| Passive | 4 | Resistor, capacitor, etc. |
| Other | 19 | Various components |

**DynamicComponent** — Generic web component renderer
- Creates DOM elements with `document.createElement(metadata.tagName)`
- Syncs React properties to web component properties
- Extracts `pinInfo` from web component DOM (100ms polling, 2s timeout)
- Integrates with PartSimulationRegistry for simulation events
- Resolves Arduino pin from wire connections
- Handles visual state: selection border, rotation, cursor, labels

**ComponentPickerModal** — Component search and selection UI
- Search bar with real-time filtering
- Category tabs from registry
- Live wokwi-element thumbnails (actual web components at reduced scale)
- Component count, pin count, description badges

#### 4. UI Components

**SimulatorCanvas** (~472 lines) — Main simulation canvas
- Arduino Uno board at fixed position
- Dynamic component rendering via DynamicComponent
- Component drag-and-drop with viewport→canvas coordinate conversion
- Click vs. drag detection (time <300ms, distance <5px threshold)
- Single-click: opens ComponentPropertyDialog
- Double-click: opens PinSelector
- Wire creation via pin clicks (crosshair cursor during creation)
- Wire auto-recalculation on component move (retries at 100/300/500ms)
- PinOverlay on all components (hidden during simulation)
- Keyboard shortcuts: Delete/Backspace (remove), Escape (cancel wire)
- PinManager subscriptions for output component state updates
- Status indicator: Running/Stopped + component count
- "+ Add Component" button → opens ComponentPickerModal

**WireRenderer** (~400 lines) — Interactive wire display and editing
- Orthogonal SVG path rendering
- 10px invisible hitbox for easy clicking
- Segment-based editing: hover highlights, drag perpendicular to orientation
- `requestAnimationFrame` smooth drag with local preview state
- Grid snapping (20px) applied on mouseUp
- Invalid wire styling (red dashed)
- Endpoint markers at start/end

**WireLayer** — SVG overlay with automatic offset calculation for overlapping wires

**WireInProgressRenderer** — Dashed green preview during wire creation (L-shaped routing)

**PinOverlay** — 12px cyan circles at each pin position; green on hover with scale animation

**ComponentPropertyDialog** — Shows pin roles, Arduino pin assignment, Rotate and Delete buttons

**PinSelector** — Modal for assigning D0-D13 and A0-A5 to component pins

**CodeEditor** — Monaco Editor wrapper (C++, dark theme, minimap, word wrap)

**EditorToolbar** — Compile/Run/Stop/Reset buttons with status messages

**ExamplesGallery** — Filterable card grid (category + difficulty filters)

#### 5. Wire Utilities

| Utility | Purpose |
|---------|---------|
| `wirePathGenerator.ts` | L-shape and multi-segment orthogonal SVG path generation |
| `wireSegments.ts` | Segment computation, hit testing (8px tolerance), drag updates |
| `wireColors.ts` | 8 signal-type colors + `determineSignalType()` |
| `wireOffsetCalculator.ts` | Parallel overlap detection (5px tolerance), symmetric offset (6px spacing) |
| `pinPositionCalculator.ts` | Pin coordinate conversion (element → canvas space), closest pin snap (20px) |
| `hexParser.ts` | Intel HEX parser with checksum verification |
| `captureCanvasPreview.ts` | SVG foreignObject preview image generation |

### Backend

**FastAPI** app (port 8001) with CORS for ports 5173-5175

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | API info |
| `/health` | GET | Health check |
| `/api/compile/` | POST | Compile Arduino code → hex content |
| `/api/compile/boards` | GET | List available boards |

**ArduinoCLIService**:
- Auto-installs `arduino:avr` core if missing
- Creates temp sketch directory, runs `arduino-cli compile` via `asyncio.to_thread(subprocess.run)`
- Reads `build/sketch.ino.hex` output
- Board listing via `arduino-cli board listall`

### Pages & Routing

| Route | Page | Layout |
|-------|------|--------|
| `/` | EditorPage | Header + split panels: Editor (left) + Simulator (right) |
| `/examples` | ExamplesPage | Examples gallery with "Back to Editor" link |

### Example Projects (8)

| ID | Title | Category | Difficulty |
|----|-------|----------|------------|
| `blink-led` | Blink LED | basics | beginner |
| `traffic-light` | Traffic Light | basics | beginner |
| `button-led` | Button Control | basics | beginner |
| `fade-led` | Fade LED | basics | beginner |
| `serial-hello` | Serial Hello World | communication | beginner |
| `rgb-led` | RGB LED Colors | basics | intermediate |
| `simon-says` | Simon Says Game | games | advanced |
| `lcd-hello` | LCD 20x4 Display | displays | intermediate |

Each example includes full Arduino sketch, component definitions, and wire connections.

### Wokwi Libraries (Local Clones)

| Library | Location | Purpose |
|---------|----------|---------|
| wokwi-elements | `wokwi-libs/wokwi-elements/` | 48+ Lit Web Components |
| avr8js | `wokwi-libs/avr8js/` | AVR8 ATmega328p emulator |
| rp2040js | `wokwi-libs/rp2040js/` | RP2040 emulator (future) |
| wokwi-features | `wokwi-libs/wokwi-features/` | Features documentation |

## Vite Integration

### Alias Configuration
```typescript
// vite.config.ts
resolve: {
  alias: {
    'avr8js': path.resolve(__dirname, '../wokwi-libs/avr8js/dist/esm'),
    '@wokwi/elements': path.resolve(__dirname, '../wokwi-libs/wokwi-elements/dist/esm'),
  },
},
optimizeDeps: {
  include: ['avr8js', '@wokwi/elements'],
}
```

This allows:
- Import from local repos as if they were npm packages
- Easy updates with `git pull`
- Modify source code if needed for debugging

## Technology Stack

### Frontend
| Technology | Version | Purpose |
|------------|---------|---------|
| React | 19.2 | UI framework |
| Vite | 7.3 | Build tool & dev server |
| TypeScript | 5.9 | Static typing |
| Monaco Editor | 4.7 | Code editor (VS Code engine) |
| Zustand | 5.0 | State management |
| React Router | 7.13 | Client-side routing |
| Axios | 1.13 | HTTP client |
| wokwi-elements | local | 48+ electronic web components |
| avr8js | local | AVR8 CPU emulator |

### Backend
| Technology | Version | Purpose |
|------------|---------|---------|
| Python | 3.12+ | Runtime |
| FastAPI | 0.115 | Web framework |
| Uvicorn | 0.32 | ASGI server |

### External Tools
| Tool | Purpose |
|------|---------|
| arduino-cli | Arduino compiler (subprocess) |
| Git | Version control for Wokwi libs |

## Architecture Advantages

### Real Emulation
- True AVR8 CPU execution, not simulation mockups
- Same avr8js engine used by Wokwi.com
- Accurate timing with configurable speed

### Plugin-Based Component Behaviors
- PartSimulationRegistry decouples simulation logic from rendering
- Easy to add new component behaviors
- Supports both input (event-driven) and output (pin-state-driven) components

### Automatic Component Discovery
- Build-time TypeScript AST parser extracts metadata from wokwi-elements source
- No manual component registration needed
- New wokwi-elements components appear automatically after rebuild

### Separation of Concerns
- **Frontend**: UI, visualization, simulation engine
- **Backend**: Compilation via arduino-cli
- **Wokwi Libs**: Emulation and components (maintained by Wokwi community)

### Wokwi Compatibility
- Official repositories = same functionality as Wokwi.com
- Automatic updates with `git pull`
- New components available immediately after rebuild

### Local Development
- No internet required after initial setup
- Local compilation with arduino-cli
- All simulation runs in the browser

## Planned Improvements

- **Serial Monitor** — UI for USART output display
- **Project Persistence** — SQLite database for save/load
- **Undo/Redo** — Edit history for code and circuit changes
- **Multi-board Support** — Runtime board switching (Mega, Nano, ESP32)
- **Wire Validation** — Electrical validation and error highlighting
- **Export/Import** — Share projects as files

## References

- [Wokwi Elements Repo](https://github.com/wokwi/wokwi-elements)
- [AVR8js Repo](https://github.com/wokwi/avr8js)
- [Wokwi Simulator](https://wokwi.com)
- [Arduino CLI](https://arduino.github.io/arduino-cli/)
- [FastAPI Docs](https://fastapi.tiangolo.com/)
- [Vite Docs](https://vitejs.dev/)

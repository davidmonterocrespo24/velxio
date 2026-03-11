# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Velxio** — a fully local, open-source Arduino emulator 
- GitHub: https://github.com/davidmonterocrespo24/velxio
- Frontend: React + Vite + TypeScript with Monaco Editor and visual simulation canvas
- Backend: FastAPI + Python for Arduino code compilation via arduino-cli
- Simulation: Real AVR8 emulation using avr8js with full GPIO/timer/USART support
- Components: Visual electronic components from wokwi-elements (LEDs, resistors, buttons, etc.)
- Auth: Email/password + Google OAuth, JWT in httpOnly cookies
- Project persistence: SQLite via SQLAlchemy 2.0 async + aiosqlite

The project uses **local clones of official Wokwi repositories** in `wokwi-libs/` instead of npm packages.

## Development Commands

### Backend (FastAPI + Python)

**Setup:**
```bash
cd backend
python -m venv venv
venv\Scripts\activate  # Windows
pip install -r requirements.txt
```

**Run development server:**
```bash
cd backend
venv\Scripts\activate
uvicorn app.main:app --reload --port 8001
```

**Access:**
- API: http://localhost:8001
- Docs: http://localhost:8001/docs

### Frontend (React + Vite)

**Setup:**
```bash
cd frontend
npm install
```

**Run development server:**
```bash
cd frontend
npm run dev
```

**Build for production:**
```bash
cd frontend
npm run build
```

**Docker build (skips tsc type-check, uses esbuild only):**
```bash
npm run build:docker
```

**Lint:**
```bash
cd frontend
npm run lint
```

**Access:**
- App: http://localhost:5173

### Wokwi Libraries (Local Repositories)

The project uses local clones of Wokwi repositories in `wokwi-libs/`:
- `wokwi-elements/` - Web Components for electronic parts
- `avr8js/` - AVR8 CPU emulator
- `rp2040js/` - RP2040 emulator

**Update libraries:**
```bash
update-wokwi-libs.bat
```

Or manually:
```bash
cd wokwi-libs/wokwi-elements
git pull origin main
npm install
npm run build
```

### External Dependencies

**arduino-cli** must be installed on your system:
```bash
# Verify installation
arduino-cli version

# Initialize (first time)
arduino-cli core update-index
arduino-cli core install arduino:avr
```

## Architecture

### High-Level Data Flow

1. **Code Editing**: User writes Arduino code → Monaco Editor → Zustand store (`useEditorStore`)
2. **Compilation**: Files → Frontend API call → Backend FastAPI → arduino-cli subprocess → Returns .hex file
3. **Simulation**: .hex file → AVRSimulator.loadHex() → Parsed into Uint16Array → CPU execution loop
4. **Pin Updates**: CPU writes to PORTB/C/D → Port listeners → PinManager → Component state updates
5. **Visual Updates**: Component state changes → React re-renders → wokwi-elements update visually

### Critical Architecture Patterns

**1. Vite Aliases for Local Wokwi Libs**

The `frontend/vite.config.ts` uses path aliases to import from local repositories:
```typescript
resolve: {
  alias: {
    'avr8js': path.resolve(__dirname, '../wokwi-libs/avr8js/dist/esm'),
    '@wokwi/elements': path.resolve(__dirname, '../wokwi-libs/wokwi-elements/dist/esm'),
  },
}
```

**2. Multi-File Workspace (useEditorStore)**

The editor supports multiple files. `useEditorStore` holds:
```typescript
interface WorkspaceFile { id: string; name: string; content: string; modified: boolean; }
// State:
files: WorkspaceFile[]
activeFileId: string
openFileIds: string[]
// Key operations:
createFile, deleteFile, renameFile, setFileContent, markFileSaved,
openFile, closeFile, setActiveFile, loadFiles, setCode (legacy)
```
`setCode` is a legacy setter that writes to the active file's content — used by old call sites.
`loadFiles` replaces all files when loading a saved project.

**3. Multi-File Compilation**

The backend accepts an array of files, not a single code string:
```typescript
// Frontend (compilation.ts)
interface SketchFile { name: string; content: string; }
compileCode(files: SketchFile[], board: string)
// sends: { files, board_fqbn: board }

// Backend (compile.py)
class SketchFile(BaseModel): name: str; content: str
class CompileRequest:
    files: list[SketchFile] | None = None
    code: str | None = None  # legacy fallback
```
The backend promotes the first `.ino` to `sketch.ino` and applies RP2040 Serial redirect only to `sketch.ino`.

**4. AVR Simulation Loop**

The simulation runs at ~60 FPS using `requestAnimationFrame`:
- Each frame executes ~267,000 CPU cycles (16MHz / 60fps)
- Port listeners fire when PORTB/C/D registers change
- PinManager maps Arduino pins to components (e.g., pin 13 → LED_BUILTIN)

**5. State Management with Zustand**

Main stores:
- `useEditorStore`: Multi-file workspace (files[], activeFileId, openFileIds)
- `useSimulatorStore`: Simulation state, components, wires, compiled hex, serialMonitorOpen
- `useAuthStore`: Auth state (persisted in localStorage)
- `useProjectStore`: Current project tracking

**6. Component-Pin Mapping**

Components are connected to Arduino pins via the PinManager:
- PORTB maps to digital pins 8-13 (pin 13 = built-in LED)
- PORTC maps to analog pins A0-A5
- PORTD maps to digital pins 0-7

**7. Wire System**

Wires are stored as objects with start/end endpoints:
```typescript
{
  id: string
  start: { componentId, pinName, x, y }
  end: { componentId, pinName, x, y }
  color: string
  signalType: 'digital' | 'analog' | 'power-vcc' | 'power-gnd'
}
```
Wire positions auto-update when components move via `updateWirePositions()`.

## Key File Locations

### Backend
- [backend/app/main.py](backend/app/main.py) - FastAPI app entry point, CORS config, model imports
- [backend/app/api/routes/compile.py](backend/app/api/routes/compile.py) - Compilation endpoints (multi-file)
- [backend/app/api/routes/auth.py](backend/app/api/routes/auth.py) - /api/auth/* endpoints
- [backend/app/api/routes/projects.py](backend/app/api/routes/projects.py) - /api/projects/* + /api/user/*
- [backend/app/services/arduino_cli.py](backend/app/services/arduino_cli.py) - arduino-cli wrapper
- [backend/app/core/config.py](backend/app/core/config.py) - Settings (SECRET_KEY, DATABASE_URL `velxio.db`, GOOGLE_*)
- [backend/app/core/security.py](backend/app/core/security.py) - JWT, password hashing
- [backend/app/core/dependencies.py](backend/app/core/dependencies.py) - get_current_user, require_auth
- [backend/app/database/session.py](backend/app/database/session.py) - async SQLAlchemy engine
- [backend/app/models/user.py](backend/app/models/user.py) - User model
- [backend/app/models/project.py](backend/app/models/project.py) - Project model (UniqueConstraint user_id+slug)

### Frontend - Core
- [frontend/src/App.tsx](frontend/src/App.tsx) - Main app component, routing
- [frontend/src/store/useEditorStore.ts](frontend/src/store/useEditorStore.ts) - Multi-file workspace state
- [frontend/src/store/useSimulatorStore.ts](frontend/src/store/useSimulatorStore.ts) - Simulation state, components, wires
- [frontend/src/store/useAuthStore.ts](frontend/src/store/useAuthStore.ts) - Auth state (localStorage)
- [frontend/src/store/useProjectStore.ts](frontend/src/store/useProjectStore.ts) - Current project

### Frontend - Editor UI
- [frontend/src/components/editor/CodeEditor.tsx](frontend/src/components/editor/CodeEditor.tsx) - Monaco editor (key={activeFileId} for per-file undo history)
- [frontend/src/components/editor/EditorToolbar.tsx](frontend/src/components/editor/EditorToolbar.tsx) - Compile/Run/Stop buttons (reads files[], not code)
- [frontend/src/components/editor/FileExplorer.tsx](frontend/src/components/editor/FileExplorer.tsx) - Sidebar file list with SVG icons, rename, delete, save button
- [frontend/src/components/editor/FileTabs.tsx](frontend/src/components/editor/FileTabs.tsx) - Open file tabs with unsaved-changes indicator and close dialog

### Frontend - Layout
- [frontend/src/components/layout/AppHeader.tsx](frontend/src/components/layout/AppHeader.tsx) - Top header (no Save button — moved to FileExplorer)
- [frontend/src/components/layout/SaveProjectModal.tsx](frontend/src/components/layout/SaveProjectModal.tsx) - Save/update project (reads files[], uses sketch.ino content)
- [frontend/src/components/layout/LoginPromptModal.tsx](frontend/src/components/layout/LoginPromptModal.tsx) - Prompt anon users

### Frontend - Simulation
- [frontend/src/simulation/AVRSimulator.ts](frontend/src/simulation/AVRSimulator.ts) - AVR8 CPU emulator wrapper
- [frontend/src/simulation/PinManager.ts](frontend/src/simulation/PinManager.ts) - Maps Arduino pins to components
- [frontend/src/utils/hexParser.ts](frontend/src/utils/hexParser.ts) - Intel HEX format parser
- [frontend/src/components/simulator/SimulatorCanvas.tsx](frontend/src/components/simulator/SimulatorCanvas.tsx) - Canvas + Serial button next to board selector

### Frontend - Pages
- [frontend/src/pages/EditorPage.tsx](frontend/src/pages/EditorPage.tsx) - Main editor layout (resizable file explorer + panels)
- [frontend/src/pages/LoginPage.tsx](frontend/src/pages/LoginPage.tsx)
- [frontend/src/pages/RegisterPage.tsx](frontend/src/pages/RegisterPage.tsx)
- [frontend/src/pages/UserProfilePage.tsx](frontend/src/pages/UserProfilePage.tsx) - Profile with project grid
- [frontend/src/pages/ProjectPage.tsx](frontend/src/pages/ProjectPage.tsx) - Loads project into editor

### Frontend - SEO & Public Files
- `frontend/index.html` — Full SEO meta tags, OG, Twitter Card, JSON-LD. **Domain is `https://velxio.dev`** — update if domain changes.
- `frontend/public/favicon.svg` — SVG chip favicon (scales to all sizes)
- `frontend/public/og-image.svg` — 1200×630 social preview image (OG/Twitter). Export as PNG for max compatibility.
- `frontend/public/robots.txt` — Allow all crawlers, points to sitemap
- `frontend/public/sitemap.xml` — All public routes with priorities
- `frontend/public/manifest.webmanifest` — PWA manifest, theme color `#007acc`

### Docker & CI
- [Dockerfile.standalone](Dockerfile.standalone) - Multi-stage Docker build
- [.github/workflows/docker-publish.yml](.github/workflows/docker-publish.yml) - Publishes to GHCR + Docker Hub on push to master

## Important Implementation Notes

### 1. AVR Instruction Execution

The simulation **must call both** `avrInstruction()` and `cpu.tick()` in the execution loop:
```typescript
avrInstruction(this.cpu);  // Execute the AVR instruction
this.cpu.tick();           // Update peripheral timers and cycles
```

### 2. Port Listeners

Port listeners in AVRSimulator.ts are attached to AVRIOPort instances, NOT directly to CPU registers:
```typescript
this.portB!.addListener((value, oldValue) => {
  // value is the PORTB register value (0-255)
  // Check individual pins: this.portB!.pinState(5) for pin 13
});
```

### 3. HEX File Format

Arduino compilation produces Intel HEX format. The parser in `hexParser.ts`:
- Parses lines starting with `:`
- Extracts address, record type, and data bytes
- Returns a `Uint8Array` of program bytes
- AVRSimulator converts this to `Uint16Array` (16-bit words, little-endian)

### 4. Component Registration

To add a component to the simulation:
1. Add it to the canvas in SimulatorCanvas.tsx
2. Register a pin change callback in PinManager
3. Update component state when pin changes

### 5. CORS Configuration

Backend allows specific Vite dev ports (5173-5175). Update `backend/app/main.py` if using different ports.

### 6. Wokwi Elements Integration

Wokwi elements are Web Components. React wrappers declare custom elements:
```typescript
declare global {
  namespace JSX {
    interface IntrinsicElements {
      'wokwi-led': any;
    }
  }
}
```

### 7. Pre-existing TypeScript Errors

There are known pre-existing TS errors that do NOT block the app from running:
- `wokwi-elements` JSX custom element types (`wokwi-led`, `wokwi-arduino-uno`, etc.)
- `@monaco-editor/react` type compatibility with React 19
- Test mock type mismatches in `AVRSimulator.test.ts`

**Do not fix these unless explicitly asked.** They are suppressed in Docker builds by using `build:docker` which runs `vite build` only (no `tsc -b`). Local `npm run build` runs `tsc -b` and will show these errors.

### 8. Docker Build — wokwi-libs

The git submodule pointers for `rp2040js` and `wokwi-elements` in this repo are stale (point to very old commits that predate `package.json`). The `Dockerfile.standalone` works around this by **cloning the libs fresh from GitHub** at build time instead of COPYing from the build context:

```dockerfile
RUN git clone --depth=1 https://github.com/wokwi/avr8js.git wokwi-libs/avr8js \
 && git clone --depth=1 https://github.com/wokwi/rp2040js.git wokwi-libs/rp2040js \
 && git clone --depth=1 https://github.com/wokwi/wokwi-elements.git wokwi-libs/wokwi-elements
```

The GitHub Actions workflow does NOT use `submodules: recursive` for this reason.

### 9. Backend Gotchas

- **bcrypt**: Pin `bcrypt==4.0.1` — bcrypt 5.x breaks passlib 1.7.4
- **email-validator**: Must be installed separately (`pip install email-validator`)
- **Model imports**: Both `app.models.user` and `app.models.project` must be imported before DB init (done in `main.py`)
- **RP2040 board manager**: arduino-cli needs the earlephilhower URL before `rp2040:rp2040` install:
  ```
  arduino-cli config add board_manager.additional_urls \
    https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json
  ```

## Testing

### Backend Testing
Test compilation directly:
```bash
cd backend
python test_compilation.py
```

### Frontend Testing
Vitest is configured. Run tests:
```bash
cd frontend
npm test
```

## Common Development Scenarios

### Adding a New Electronic Component

1. Check if wokwi-elements has the component (see `wokwi-libs/wokwi-elements/src/`)
2. Create React wrapper in `frontend/src/components/components-wokwi/`
3. Add component type to `useSimulatorStore` interface
4. Update SimulatorCanvas to render the component
5. Register pin callbacks in PinManager if interactive

### Adding a New API Endpoint

1. Create route in `backend/app/api/routes/`
2. Include router in `backend/app/main.py`
3. Add corresponding service in `backend/app/services/` if needed
4. Create API client function in `frontend/src/services/`

### Debugging Simulation Issues

Common issues:
- **LED doesn't blink**: Check port listeners are firing (console logs), verify pin mapping
- **Compilation fails**: Check arduino-cli is in PATH, verify `arduino:avr` core is installed
- **CPU stuck at PC=0**: Ensure `avrInstruction()` is being called in execution loop
- **Wire positions wrong**: Check `calculatePinPosition()` uses correct component coordinates

Enable verbose logging:
- AVRSimulator logs port changes and CPU state every 60 frames
- Backend logs all compilation steps and arduino-cli output

## Project Status

**Implemented:**
- Full Arduino code editing with Monaco Editor
- **Multi-file workspace** — create, rename, delete, open/close tabs, unsaved-changes indicator
- Compilation via arduino-cli to .hex files (multi-file sketch support)
- Real AVR8 emulation with avr8js
- RP2040 emulation with rp2040js
- Pin state tracking and component updates
- Dynamic component system with 48+ wokwi-elements components
- Component picker modal with search and categories
- Component property dialog (single-click interaction)
- Component rotation (90° increments)
- Wire creation and rendering (orthogonal routing)
- Segment-based wire editing (drag segments perpendicular to orientation)
- Real-time wire preview with grid snapping (20px)
- Pin overlay system for wire connections
- Serial Monitor with baud rate detection and send
- ILI9341 TFT display simulation
- Library Manager (install/search arduino libraries)
- Example projects gallery
- **Auth**: email/password + Google OAuth, JWT httpOnly cookies
- **Project persistence**: create/read/update/delete with URL slugs (`/:username/:slug`)
- **User profile page** at `/:username`
- **Resizable file explorer** panel (drag handle, collapse toggle)
- Docker standalone image published to GHCR + Docker Hub

**In Progress:**
- Functional wire connections (electrical signal routing)
- Wire validation and error handling

**Planned:**
- Undo/redo functionality
- More boards (ESP32, Arduino Mega, Arduino Nano)
- Export/Import projects as files

## Additional Resources

- Main README: [README.md](README.md)
- Architecture Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Wokwi Elements Repo: https://github.com/wokwi/wokwi-elements
- AVR8js Repo: https://github.com/wokwi/avr8js
- Arduino CLI Docs: https://arduino.github.io/arduino-cli/

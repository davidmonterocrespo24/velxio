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

**Plugin SDK foundation (`@velxio/sdk` — Phase 0 of Velxio Pro marketplace):**
- Package: `packages/sdk/` — extracted, builds tsup ESM+CJS+dts, 114 tests, lint+typecheck clean. Frontend imports it via `vite.config.ts` aliases pointing at `packages/sdk/src/*.ts` for hot reload.
- Subpath exports: `@velxio/sdk` (barrel), `@velxio/sdk/manifest` (Zod PluginManifestSchema + JSON Schema emitter), `@velxio/sdk/events` (typed `SimulatorEvents` map + `EventBusReader`).
- **Event bus** (`frontend/src/simulation/EventBus.ts`): zero-listener fast-path emit (~13 M ops/s), `Set<Function>` storage, error-isolated dispatch, snapshot-on-dispatch, leak warn at 50 listeners, `shouldEmitThrottled()` helper. Wired into AVRSimulator (`pin:change`, `serial:tx`, `simulator:start/stop/reset/tick`), CircuitScheduler (`spice:step`), and `compilation.ts` (`compile:start/done`). Hot-path emits MUST be guarded by `if (bus.hasListeners(...))`. **CORE-003b** added `i2c:transfer` + `spi:transfer`: AVR via `I2CBusManager`'s optional `onTransfer` callback (sub-transaction buffering, flushed on STOP/repeated-START, fault-isolated) + `installSpiTransferObserver` (wraps `cpu.writeHooks[SPDR]` so MOSI capture survives `registerSpiSlave` replacing `spi.onByte`, MISO captured on `completeTransfer`); RP2040 via `wireI2C` per-bus sub-transaction buffering (`flushI2cTransfer(stop)`) + `wireSpiObserver(idx)` per bus with `cs: 'spi0' | 'spi1'` (MOSI re-snapshotted inline in `setSPIHandler` since rp2040js has no writeHook layer; completion-side wrap survives because nobody reassigns `completeTransmit`). AVR uses `cs: 'default'`. See [docs/EVENT_BUS.md](docs/EVENT_BUS.md).
- **Compile middleware** (`frontend/src/simulation/CompileMiddleware.ts` + `backend/app/services/compile_middleware.py`): two independent registries (client + server). Pre = FIFO, transform-then-throw-aborts. Post = LIFO, observe-only, swallows errors. Each middleware wrapped in 5 s timeout. Built-in `Rp2040SerialRedirectMiddleware` (server) replaces the old hard-coded `#define Serial Serial1` in `arduino_cli.py`. See [docs/COMPILE_MIDDLEWARE.md](docs/COMPILE_MIDDLEWARE.md).
- **Registry contracts (CORE-002)**: `ComponentRegistry.register(ComponentDefinition)`, `PartSimulationRegistry.registerSdkPart()`, `SpiceMapperRegistry` (`frontend/src/simulation/spice/SpiceMapperRegistry.ts`) all implement the SDK shape — last-writer-wins dispose, O(1) Map lookup, SDK `enum`→host `select` property mapping. Built-ins seed each registry on module load; plugin code calls the same entry points. Identity helpers: `defineComponent`, `definePartSimulation`, `defineSpiceMapper`. **Rule**: `registry.lookup()` runs at setup/netlist-build, never inside a frame tick — callers cache the resolved reference.
- **Plugin host (SDK-002)** — `frontend/src/plugin-host/` is the host-side implementation behind `PluginContext`: `PermissionGate.requirePermission()` (synchronous fail-fast throwing `PermissionDeniedError`), 7 `MapBackedRegistry<T>` UI registries with `subscribe()`, `InMemoryPluginStorage` with 1 MB quota (`PLUGIN_STORAGE_QUOTA_BYTES`) using TextEncoder byte counting + `StorageBackend` seam for future IndexedDB swap, `createScopedFetch` (HTTPS-only allowlist prefix matching, `X-Velxio-Plugin` header tag, `credentials: 'omit'`, 4 MB Content-Length cap), `PluginLogger` with `[plugin:<id>]` prefix, `SpiceModelRegistry`. Factory `createPluginContext(manifest, services)` wires per-plugin gated adapters around the host singletons; LIFO `dispose()` is idempotent and a throwing disposable doesn't block others. Storage method wrappers are `async` so synchronous gate throws land as rejected promises (matches SDK contract). New SDK errors: `StorageQuotaError`, `HttpAllowlistDeniedError`. Plugins **never** import from this folder — they only see `@velxio/sdk`.
- **Plugin extension flow (SDK-003)** — three independent calls a plugin makes through `ctx`: `components.register(def)` (picker + pin layout, requires `components.register`), `partSimulations.register(id, sim)` (MCU-side, requires `simulator.pins.read`), `spice.registerMapper(id, mapper)` + `spice.registerModel(name, card)` (electrical mode, requires `simulator.spice.read`). The `components` adapter throws `DuplicateComponentError` when an id is already taken (same plugin, cross-plugin, or built-in) — last-writer-wins is reserved for built-in seeding. The `partSimulations` adapter wraps plugin `onPinStateChange`/`attachEvents` in try/catch — throws are logged via `ctx.logger.error` and swallowed so a buggy plugin never crashes the simulator loop; a throwing `attachEvents` returns a no-op cleanup. Author-facing surface: `defineComponent`, `definePartSimulation`, `defineSpiceMapper` identity helpers. See [docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md).
- **Disposable + lifecycle (SDK-007)** — SDK exposes `DisposableStore { add(d), dispose(), readonly isDisposed, readonly size }` and `PluginContext.subscriptions: DisposableStore` as the canonical place to track teardown. Host implementation `frontend/src/plugin-host/DisposableStore.ts` (`HostDisposableStore`) guarantees: **LIFO unwind**, **idempotent dispose**, **fault-isolated** (a throwing disposable is logged via `ctx.logger.error` and the rest still run), and **late-arrival safe** — `add(d)` after `dispose()` disposes `d` immediately and emits a warn through the plugin logger (catches the async-task-after-deactivation bug). `createPluginContext` was refactored so all 7 UI registries + components + partSimulations + spice handles + plugin-managed disposables share **one** store — there is no second list to forget about. `ctx.addDisposable(d)` is a thin alias of `ctx.subscriptions.add(d)`. Hard timeout per-dispose belongs to CORE-006 (worker runtime).
- **Pure-data contributions (SDK-004)** — `ctx.templates.register(TemplateDefinition)` and `ctx.libraries.register(LibraryDefinition)` are the two plugin shapes that are **data, not code**: project templates (board + files + components + wires snapshot) and Arduino libraries (vendored `.h`/`.cpp` bundles). Validated synchronously at register time via Zod (`packages/sdk/src/templates.ts` / `libraries.ts`) so a malformed bundle fails in dev rather than at use time. Caps: templates ≤1 MB total, ≤64 files × ≤500 KB; libraries ≤2 MB total, ≤512 KB per file, path depth ≤8, allow-listed extensions, allow-listed `#pragma` names, no `..` in `#include`. Cross-plugin id collisions throw `DuplicateTemplateError` / `DuplicateLibraryError` — last-writer-wins is reserved for built-in seeding because arduino-cli identifies libraries by folder name (silent overwrite would be unsafe). Host registries `frontend/src/plugin-host/TemplateRegistry.ts` + `LibraryRegistry.ts` are singletons with `subscribe()` for UI reactivity; `LibraryRegistry.resolve(ids)` does a DFS topological sort with cycle detection (throws `LibraryDependencyCycleError` with an actionable cycle path). The actual mounting of libraries into `sketch_dir/libraries/<id>/...` and the "New from template" picker are deferred to **SDK-004b** because end-to-end testing requires CORE-007 (plugin loader). See [docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md).
- **Templates + libraries wired to the editor (SDK-004b)** — Two separate pipelines pick up the SDK-004 registries at the seam where users actually feel them. **Compile path**: `frontend/src/services/compilation.ts` adds `platformForFqbn(fqbn)` (`avr`/`esp32`/`rp2040`/`null`, with both `arduino:mbed_rp2040:*` and `rp2040:rp2040:*` mapped) + `collectLibrariesForBoard(fqbn)` which filters `getLibraryRegistry().list()` by `LibraryDefinition.platforms`, calls `LibraryRegistry.resolve(ids)` for the topological closure (deps before dependents), and reduces to `{id, version, files: [{path, content}]}`. The `libraries` field is **only set when non-empty** so a stock install's request body is unchanged (additive non-breaking). Backend `backend/app/api/routes/compile.py` carries `CompileRequest.libraries: list[CompileLibrary] | None`; every entry runs through `backend/app/services/library_validation.py` which **mirrors the SDK's Zod rules byte-for-byte** (path-safety regex, depth ≤8, extension allowlist, `#pragma` allowlist, ≤512 KB/file, ≤2 MB total) — duplication is intentional because the Vite client is untrusted. Status mapping is precise: 400 (semantic/path/duplicate-id), 413 (size), 422 (Pydantic structural). `arduino_cli._materialize_libraries()` writes each library to `<sketch_dir>/libraries/<id>/<file.path>` inside the existing `tempfile.TemporaryDirectory()` (auto-cleanup) and inserts `--libraries <root>` via `cmd[-1:-1] = [...]` so the sketch positional stays last on both AVR and ESP32 branches. **Template picker**: `frontend/src/components/layout/TemplatePickerModal.tsx` uses `useSyncExternalStore` against `getTemplateRegistry()` — both `HostTemplateRegistry` and `HostLibraryRegistry` got a `snapshotCache` invalidated on every register/dispose/reset (without it `useSyncExternalStore` raises *"The result of getSnapshot should be cached to avoid an infinite loop"*; `LibraryRegistry` got the same treatment for parity even though no UI consumes it via SES today). Wires in `TemplateDefinition.snapshot.wires` only carry `{componentId, pinName}` — `(x, y)` are DOM-derived, so the modal awaits **two `requestAnimationFrame` ticks** after mounting components to let wokwi-elements populate `pinInfo`; endpoints that still don't resolve fall back to `(0, 0)` and snap into place on the next `updateWirePositions()`. AppHeader gates the Templates button on `pathname === '/editor'`. Tests: 28 in `backend/tests/test_library_validation.py`, 6 in `backend/tests/test_compile_route_libraries.py` (49/49 backend total), 8 in `frontend/src/__tests__/compilation-libraries.test.ts`, 6 in `frontend/src/__tests__/TemplatePickerModal.test.tsx`. End-to-end with a real plugin bundle (worker + license gate + loader cache) waits on a CORE-007 plugin fixture; today the registries are exercised through `registerFromPlugin()` directly. See [docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md) → "SDK-004b — wiring templates and libraries to the host".
- **Translatable strings (SDK-005)** — `ctx.i18n: I18nAPI` is the per-plugin i18n surface: `t(key, vars?)`, `format(template, vars?)`, `locale`, `availableLocales`, `onLocaleChange(fn)`, `registerBundle(PluginI18nBundle)`. Bundle validated at register time (Zod + caps: ≤1024 keys/locale, ≤4 KB per value, ≤256 KB total) — throws `InvalidI18nBundleError` with `pluginId` baked in. **No permission gate** — translations are local read-only data, not a sensitive surface. Locale resolution: exact → language-only (`es-MX` → `es`) → region-collapse (`es` → first `es-XX`) → default `en` → key itself (missing strings show as visible debug output). `interpolate()` supports `{name}` placeholders with `{{`/`}}` escape; missing vars stay literal. Host: `frontend/src/plugin-host/I18nRegistry.ts` — `LocaleStore` singleton (snapshot-on-dispatch, `navigator.language` initial detection, malformed-tag rejection with warn) + `createPluginI18n(manifest, logger)` factory. Plugin callbacks fault-isolated through `logger.error` — same EventBus rule. Editor locale picker UI + core-shell string refactor + marketplace badge are deferred to **SDK-005b**. See [docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md).
- **User-tunable settings (SDK-006)** — `ctx.settings: SettingsAPI` is the per-plugin schema-driven configuration surface: `declare(SettingsDeclaration)`, `get()`, `set(partial)`, `reset()`, `onChange(fn)`. Schema is a small JSON-Schema subset (string/number/integer/boolean/array-of-strings/object-one-level; modifiers: `enum`, `minLength`/`maxLength`, `minimum`/`maximum`, `multipleOf`, `pattern`, `format` for strings) — bounded so the form renderer stays simple. `validateSettingsSchema(schema, pluginId)` runs at `declare()` time, throws `InvalidSettingsSchemaError`. `applyAndValidate(schema, partial, current)` fills defaults, coerces string↔number for numeric fields, and returns `{ ok, errors?, values? }` — **`values` is populated even on failure** to enable schema migrations. Permission gate: `'settings.declare'` only; reads/writes/resets/subscriptions free once declared. Caps: ≤64 top-level properties, ≤32 KB JSON values, ≤4 KB strings. Host: `frontend/src/plugin-host/SettingsRegistry.ts` — `HostSettingsRegistry` singleton (re-declare creates a NEW entry so the OLD handle's `dispose()` is a no-op + two-pass migration: keep valid + re-default dropped + `fillDefaultsRaw` rescues self-invalid defaults like `default: ''` on `minLength: 4`) + `SettingsBackend` interface (default `InMemorySettingsBackend`; production wires IndexedDB / `plugin_installs.settings_json`) + `createPluginSettings(manifest, logger)` factory with snapshot-on-dispatch and fault-isolated `onChange`. React form renderer + IndexedDB backend deferred to **SDK-006b**. See [docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md).
- **Permissions catalog + threat model (SDK-008)** — [docs/PLUGIN_PERMISSIONS.md](docs/PLUGIN_PERMISSIONS.md) is the canonical reference for the 22 entries in `PLUGIN_PERMISSIONS` (`packages/sdk/src/permissions.ts`). Each row documents Risk class (Low/Medium/High), what it allows, what it explicitly does NOT allow, and which gate currently enforces it (3 entries — `simulator.events.read`, `simulator.pins.write`, `compile.transform.client` — are declared but ungated; gates land in CORE-006 and SDK-003b respectively, called out in the table). Threat model: 5 attacker assumptions (malicious author, supply-chain compromise, stale plugin, social engineering, side-channel via storage), runtime guarantees (current vs pending CORE-006 worker sandbox), capability denylist (DOM, cookies, editor LocalStorage, network without allowlist, cross-plugin reads). Includes the spec for the pre-install consent dialog (triggered by any Medium/High permission, scroll-to-bottom anti-clickjacking gate) and the update permission-diff dialog (auto-approve only when `v_new.permissions ⊆ v_old.permissions`); both deferred to SDK-008b which depends on CORE-007 (loader) + CORE-008 (Installed Plugins panel). Process for adding a new permission: PR must touch both `PLUGIN_PERMISSIONS` array and the catalog table — CI lint enforces parity. See [docs/PLUGIN_PERMISSIONS.md](docs/PLUGIN_PERMISSIONS.md).
- **Plugin runtime worker sandbox (CORE-006)** — `frontend/src/plugins/runtime/` is the host↔worker boundary. `RpcChannel` (`rpc.ts`) is transport-agnostic over `postMessage`: typed messages (`request`/`response`/`event`/`invoke-callback`/`dispose`/`log`/`ping`/`pong`), bounded queue (1024 default) with **drop-oldest backpressure** and `coalesced`/`dropped` counters, microtask-batched flush, `pin:change` coalescing by `(componentId, pinName)`, `RpcTimeoutError`/`RpcDisposedError`, and `serializeError`/`deserializeError` that preserve `.name` across the structured-clone boundary. `proxy.ts` carries `HandleTable<T>` for callback (`{__cb:id}`) and disposable (`{__disp:id}`) marshalling. `ContextStub.ts` (worker side) builds a full `PluginContext` whose calls forward via RPC; `WorkerDisposableStore` mirrors `HostDisposableStore` semantics (LIFO, late-arrival silent, fault-isolated). `PluginHost.ts` (main thread) owns one Worker + `RpcChannel` + an in-process `PluginContext` built by the existing `createPluginContext()` — `dispatch(method, args)` is a dotted-path switch that delegates every call to the existing host registries, so **the runtime is pure transport and adds zero new permission/quota logic**. Liveness ping/pong (10 s default, 2 missed → terminate). `pluginWorker.ts` boot does SHA-256 integrity verification via `crypto.subtle.digest` against the manifest's declared digest, then `import(blob:URL)` of verified bytes. `PluginManager.ts` is the singleton lifecycle entry (`load`/`unload`/`list`/`subscribe` + `WorkerFactory` for test injection); `load()` is hot-reload-aware. **Rule for runtime tests**: match `PermissionDeniedError` and friends by `.name`, never by `instanceof` — the SDK class identity does not survive `structuredClone`. APIs that need DOM (`partSimulations.attachEvents`, `panels.render`, `canvasOverlays.render`) accept calls with a one-time warn and return a no-op `Disposable`; real implementation deferred to **CORE-006b** (declarative SVG schema + opt-in Web Components, plus production CSP rollout, BENCH-AVR-04 with N plugins, pentest suite, Installed Plugins stats UI, fetch egress accounting). 23/23 runtime tests green (`plugin-runtime-rpc.test.ts` + `plugin-runtime-host.test.ts`). See [docs/PLUGIN_RUNTIME.md](docs/PLUGIN_RUNTIME.md).
- **Plugin loader + cache (CORE-007)** — `frontend/src/plugins/loader/` turns *"these plugins are installed"* into *"these workers are running"*. Four pieces: `BundleVerifier` (`computeBundleHash`/`verifyBundleHash` SHA-256 with `BundleIntegrityError`), `PluginCache` (idb-keyval, key `plugin:<id>:<version>`, GC by oldest-`cachedAt` with `keep` set so a just-loaded plugin is never evicted, `pruneVersions` for upgrades, `MemoryCacheBackend` test seam), `BundleFetcher` (`fetchBundle(id, version)` with 3-attempt full-jitter exponential backoff, retries on 5xx/408/429 only, aborts on permanent 4xx, dev-server shortcut to `localhost:5180/plugins/<id>/` when on localhost, `AbortController` per-attempt timeout, `BundleFetchError` typed), `PluginLoader` (orchestrator: `loadInstalled` runs all plugins via `Promise.allSettled` so one slow CDN doesn't block the others; per-plugin flow is cache → fetch-on-miss → verify → `cache.put` → `URL.createObjectURL(bytes)` → `manager.load` → revoke; `LoadOutcome` carries `status` ∈ {`active`/`failed`/`offline`/`disabled`}, `source` ∈ {`cache`/`cdn`/`dev`}, `cacheHit`, `fetchAttempts`, `elapsedMs`; **integrity mismatch never poisons the cache** — verify runs before put). Defense-in-depth: SHA-256 fires twice (loader + worker before `import()`). 32/32 loader tests green (`plugin-loader-{verifier,cache,fetcher}.test.ts` + `plugin-loader.test.ts`). Wiring at editor startup, license verification (CORE-009), backend installed-list endpoint (PRO-003), CDN hosting (PRO-005), and the Installed Plugins UI (CORE-008) are deferred. See [docs/PLUGIN_LOADER.md](docs/PLUGIN_LOADER.md).
- **npm publishing pipeline (CORE-005)** — root `package.json` hosts npm workspaces (`packages/*`) + `@changesets/cli`; `.changeset/config.json` is the source of truth for bump policy (changelog provider `@changesets/changelog-github`, `access:public`, `baseBranch:master`). `packages/sdk/package.json` carries the publish metadata: `publishConfig.access:public`, formal `repository`/`bugs`/`homepage`, `prepublishOnly` running lint+typecheck+test+build as a last-resort gate. `packages/sdk/scripts/smoke-test.mjs` (run via `npm run smoke:sdk` from root) packs the SDK into a tarball, installs it into a throwaway tmpdir consumer, and exercises ESM + CJS + both subpaths + TypeScript types — catches packaging bugs (missing `dist/` files, broken `exports` map) that in-repo tests miss. `.github/workflows/release.yml` triggers on push-to-master with `id-token: write` for npm provenance: lint/typecheck/test/build SDK + run smoke as gates, then `changesets/action@v1` opens (or merges) the "Version Packages" PR and on the second run does `changeset publish`. Changeset workflow: any PR touching `packages/sdk/src/**` must include `.changeset/*.md` (`npx changeset` from root). Human-gated steps (claim `@velxio` org on npm + `NPM_TOKEN` secret OR OIDC trusted publisher) tracked in **CORE-005b**.
- **Author CLI — `@velxio/cli` `init` / `validate` / `build` (SDK-009-step1)** — `packages/cli/` is the second npm workspace, sibling to `@velxio/sdk`, exposing the `velxio-plugin` bin that plugin authors run locally. **Three commands, deliberately scoped to the unblocked half of SDK-009** (publish/login/dev defer to step2/step3 once PRO-001+ ships the registry). `runValidate({manifestPath?})` reads `manifest.json`, `JSON.parse`s, then routes through `validateManifest()` from `@velxio/sdk/manifest` — Zod issues render as `  ${path}: ${message}` with two-space indent so authors can grep them. `runBuild({cwd?, entry?, outdir?, manifestPath?, minify?})` is a 4-step pipeline: validate → esbuild bundle → SHA-256 hash → emit `dist/integrity.json`. esbuild config is hardcoded `format:'esm'` + `target:'es2022'` + `platform:'browser'` + `external:['@velxio/sdk']` (the host injects the SDK into the worker scope at runtime — bundling it would duplicate the runtime + break `instanceof` checks across the boundary). **`bundleHash` lives ONLY in `dist/integrity.json`, never in the manifest** — the manifest schema doesn't carry it; the CORE-007 BundleVerifier reads `InstalledPlugin.bundleHash` which the registry stitches on from the integrity sidecar at install time. `runInit({name, template, force?})` validates `name` against `/^[a-z][a-z0-9-]{2,63}$/` (kebab-case, min 3 chars), refuses non-empty target dirs without `--force`, and writes 6 files from a programmatic template (no on-disk template files — avoids `__dirname` headaches under bundlers): `package.json` + `manifest.json` + `src/index.ts` + `tsconfig.json` + `.gitignore` + `README.md`. Only `component` template ships in step1; `defineCompoundComponent` / device / extension templates land later. `cli.ts` uses commander with subcommands; `tsup.config.ts` emits two entries: lib (esm+cjs+dts at `dist/index.{js,cjs,d.ts}`) and bin (cjs only at `dist/cli.cjs` with `banner: { js: '#!/usr/bin/env node' }`) so `npx velxio-plugin` works on Node 20+ regardless of consumer package type. `external: ['esbuild', '@velxio/sdk']` in tsup keeps the bin tiny (~13 KB). 18/18 tests across `validate.test.ts` (6: success, missing file, malformed JSON, Zod issues, custom path, semantic check `http.fetch`), `build.test.ts` (5: artefact emission incl. `manifestJson.bundleHash === undefined` assertion, `@velxio/sdk` external + `return p;` body NOT inlined, refuses invalid manifest, deterministic hash across rebuilds, esbuild syntax error), `init.test.ts` (7: validate roundtrip, kebab-case rejection, refuse non-empty, `--force` overwrite, accept empty dir, name embedding, package.json scripts). **CI workflow** `.github/workflows/cli-tests.yml` triggers on `packages/cli/**` OR `packages/sdk/**` (the CLI's typecheck reads SDK types directly via the workspace symlink — an SDK breaking change would only surface in CLI typecheck), installs via `npm ci --workspace=@velxio/cli --include-workspace-root` (root lockfile, no per-package lock because `@velxio/sdk@0.1.0` isn't on npm yet so a standalone lock can't be generated), runs lint/typecheck/test/build, then **end-to-end smoke**: `init smoke-plugin --template component` + `validate` roundtrip in a tmpdir to catch template/schema drift before consumers see a broken `velxio-plugin init`. Step 2 (dev mode with HMR / `velxio-plugin dev`) and step 3 (`velxio-plugin login` + `publish`) blocked on **PRO-001** (registry endpoints) + **PRO-002** (auth tokens).
- **Installed Plugins UI (CORE-008)** — `frontend/src/store/useInstalledPluginsStore.ts` (Zustand join layer) + `frontend/src/components/layout/InstalledPluginsModal.tsx` (pure render) + AppHeader button. The store **never owns plugin state itself** — it stitches `getPluginManager().list()` (running entries with manifest + status + error) and `useMarketplaceStore.installs/licenses` (what Pro says the user owns) into a `PluginPanelRow` set via `getRows()`. Precedence: manager entry wins on status/displayName/error (reflects runtime), marketplace wins on `enabled`, both merge their data. Six statuses (`active` / `loading` / `failed` / `unloaded` / `installed-not-loaded` / `no-license`). Three optimistic local sets (`localDisabled`, `localUninstalled`, `busyIds`) — flag-and-forget today because there's no backend op to roll back; PRO-003 wires real PATCH/DELETE later. `toggleEnabled` flips the local set + calls `manager.unload(id)` when disabling; **re-enable does NOT synchronously reload** because the store has no `bundleUrl` (the loader does — wire-up in CORE-008b). `uninstall` hides the row + unloads the worker; backend DELETE deferred. Modal sub-components in the same file (no external call sites): `<PluginRow>` with status badge + error detail + `<ReportIssueLink>` (probes `author.email` → mailto, `repository.url` → external link), `<UninstallConfirm>` gate, `<PluginSettingsDialog>` placeholder (real schema-driven form deferred to **SDK-006b** — shows `manifest` JSON in `<details>` for debugging until then), `<MarketplaceBanner>` (auth/network state hint, hidden when marketplace is `available && !authRequired`), `<EmptyState>`. AppHeader integration is a single button between Share and Auth UI; existing UI untouched. 15 store tests in `installed-plugins-store.test.ts` cover the join precedence, optimistic mutation, busy flag, and sort order. The modal is intentionally not DOM-tested (repo doesn't pull `@testing-library/react`); the store covers all logic. See [docs/INSTALLED_PLUGINS_UI.md](docs/INSTALLED_PLUGINS_UI.md).
- **License verification (CORE-009)** — `frontend/src/plugins/license/` is the offline Ed25519 verifier paid plugins must pass before the loader instantiates them. `verifyLicense(signed, opts)` is the single async entry; **it never throws on bad input** — every reject is a typed `{ ok: false; reason; detail? }` discriminated union (`malformed` / `wrong-plugin` / `wrong-user` / `wrong-version` / `expired` / `revoked` / `unknown-kid` / `bad-signature`). The chain runs cheapest-first (structural pass rejects ~99% of fuzzed inputs before any `crypto.subtle.verify` spend), with denylist before signature so a revoked token dies even when its sig is valid. Default `jtiOf(signed) = signed.sig` exploits the fact that Ed25519 sigs are unique per issuance, so no separate JTI field is needed. Default `graceMs = 24h` absorbs mildly-skewed clocks for offline-first usage. Three sub-modules carry the contract: `canonicalize.ts` (`canonicalJsonStringify` — sorted keys at every level, drops `undefined`, throws on non-finite; subset of RFC 8785 — Pro must produce the *same bytes* when signing), `semver.ts` (in-house exact/caret/tilde/wildcard with npm 0.x special-cases — `^0.2.x` lock minor, `^0.0.3` lock patch — to avoid the ~50 KB `semver` dep), `base64url.ts` (URL-safe `btoa/atob`). Key rotation: `publicKeys: ReadonlyArray<{ kid; key: CryptoKey; activeUntil? }>` — with `kid` the verifier picks the matching entry in O(1); without `kid` it tries each active key in order. `publicKey.ts` ships `ACTIVE_PUBLIC_KEYS = []` until **PRO-007** publishes the first key — fail-closed by default (verify without keys → `unknown-kid`). Loader integration shipped in **CORE-007b** (see next bullet); the verifier is intentionally pure/decoupled so the hot-path call site lives with the loader. 41/41 tests across `license-{semver,canonicalize,verify}.test.ts` (verify suite generates real Ed25519 keypairs via `crypto.subtle.generateKey`, no mocks in the crypto path). See [docs/PLUGIN_LICENSING.md](docs/PLUGIN_LICENSING.md).
- **License gate in PluginLoader (CORE-007b)** — `frontend/src/plugins/loader/LicenseResolver.ts` + a new step 0 inside `PluginLoader.loadOne` runs `verifyLicense()` *before* the cache lookup so a paid plugin without a valid license never burns CDN bandwidth, never spawns a worker, never touches IndexedDB. Decoupling is via a `LicenseResolver` interface (`getLicense` / `getUserId` / `getPublicKeys` / `getDenylist`) — the loader does not import Zustand stores directly. Two factories ship: `defaultLicenseResolver()` (production: reads `useMarketplaceStore` + `useAuthStore` + `ACTIVE_PUBLIC_KEYS`, parses `LicenseRecord.token` as JSON-encoded `SignedLicense` with defensive `try/catch` → `null`), `inMemoryLicenseResolver({ licenses, userId, publicKeys, denylist })` (tests + dev-mode mocking of paid plugins). New outcome status `'license-failed'` carries a typed `licenseReason: LoadLicenseReason = LicenseVerifyReason | 'no-license' | 'not-authenticated'` so the UI maps reason→copy without parsing prose; **`not-authenticated` is distinct from `wrong-user`** (different CTA: "sign in" vs "this license belongs to another account"). Resolution order is fail-closed at every step: (1) `pricing.model === 'free'` → bypass, (2) no resolver injected → `no-license`, (3) no token → `no-license`, (4) `userId === null` → `not-authenticated`, (5) verifier reject → forward reason. 12 new tests in `plugin-loader-license-gate.test.ts` (real Ed25519 sign/verify end-to-end, asserts `manager.load` and `fetch` were never called on reject paths). 32+12=44 loader tests green. Wiring at editor startup uses `new PluginLoader({ licenseResolver: defaultLicenseResolver() })`. Pause-on-expiry timer + per-reason copy + the `manager.pause()` primitive deferred to **CORE-008b** (subtask 4). See [docs/PLUGIN_LOADER.md](docs/PLUGIN_LOADER.md) → "License gate" section.
- **Installed Plugins UI — reload-on-enable + license CTAs + update badge + denylist refresh (CORE-008b)** — `useInstalledPluginsStore` gains `configureInstalledPlugins({ loader, latestVersionResolver })` (a one-time startup hook the editor calls right after constructing the production `PluginLoader`). Re-enabling a plugin now routes through `loader.loadOne(installed)` instead of just clearing a flag — the license gate, the SHA-256 integrity check, and the IndexedDB cache all run again, no shortcut. The store snapshots manifests off `getPluginManager().list()` on every notify tick into a module-local `manifestCache` so the reload path has the full `PluginManifest` to feed the loader (the `InstalledRecord` only carries id+version+enabled+bundleHash). Reload requires `bundleHash !== undefined` on the install record — without it the path no-ops cleanly. New row fields: `licenseReason?: LoadLicenseReason` (stamped on `license-failed`, cleared on next successful load) and `latestVersion?: string` (populated lazily by an injectable `LatestVersionResolver`). New action `refreshDenylist()` which delegates to `useMarketplaceStore.refresh()` and **swallows transport errors silently** (the modal's 24 h `setInterval` fires unattended; a flaky network must not surface as a banner). Modal: `<LicenseStatus reason={…} />` per row maps every `LoadLicenseReason` to a one-line headline + CTA via the `LICENSE_COPY` map (Buy / Sign in / Renew / Update plugin / Contact support). `<PluginUpdateBadge />` is a pill that shows when `latestVersion !== version`; `LatestVersionResolver` is a no-op factory until PRO-003 ships the marketplace catalog endpoint. 12 new store tests in `installed-plugins-store.test.ts` (27 total) — assert reload calls the loader with the right shape, license reasons stamp+clear, throwing resolvers don't break sibling rows, refreshDenylist swallows errors. Pause-on-expiry timer + `PluginManager.pause()` primitive deferred to **CORE-008c**; backend PATCH/DELETE persistence deferred to **PRO-003**. See [docs/INSTALLED_PLUGINS_UI.md](docs/INSTALLED_PLUGINS_UI.md) → "CORE-008b additions" section.
- **Pause-on-expiry timer + soft pause primitives (CORE-008c)** — `PluginManager` gains `'paused'` as a fifth `PluginStatus`, `PluginPauseReason = 'license-expired' | 'license-revoked' | 'manual'`, and `pause(id, reason)` / `resume(id)` primitives. Pause is **soft**: the worker stays alive, only the entry's status flips so subscribers (the Installed Plugins panel, command-palette gates) see it as paused. `resume(id)` is O(1) and avoids re-`import()` — used by tests + manual ops; the production renew flow always re-routes through `unload + loadOne` so the license gate runs again. `PluginLoader` arms a `setTimeout` per paid plugin whose license carries a future `expiresAt`. Browsers clamp `setTimeout > 2^31-1ms` to immediate firing, so the loader chunks at `MAX_TIMER_DELAY_MS = 24h` and re-arms in the callback until real expiry — naturally aligning with CORE-008b's denylist refresh cadence. Already-expired licenses (clock skew within the verifier's 24 h grace window) trigger a synchronous pause inside `armExpiryTimer`. The loader subscribes to the manager **lazily** on first arm, then sweeps its timer map on every notify and cancels any id whose entry is `unloaded`/`failed`/missing — explicit `manager.unload(id)` from the modal never results in a late `pause()` against a dead worker. `loader.dispose()` clears every pending timer and unsubscribes. `useInstalledPluginsStore` exposes `pauseReason` on the row and **derives `licenseReason`** (`expired` / `revoked`) from license-driven pauses, so the modal reuses the existing `<LicenseStatus />` from CORE-008b without any new branch (the `STATUS_PALETTE['paused']` palette entry is the only modal change). `manual` pauses skip the license CTA, reserving the slot for future "snooze" affordances. 12 new tests in `plugin-loader-pause-on-expiry.test.ts` (real Ed25519 sign/verify with `vi.useFakeTimers()` validates pause/resume primitives, timer arming/firing, 24h chunking, unload-cancels, free-and-perpetual no-op, dispose cleanup) + 4 new store tests covering the row contract (31 store tests total). Hard pause (RPC freeze of `pin:change` and other hot-path callbacks) deferred to **CORE-006b**. See [docs/PLUGIN_LOADER.md](docs/PLUGIN_LOADER.md) → "Pause-on-expiry timer (CORE-008c)" + [docs/INSTALLED_PLUGINS_UI.md](docs/INSTALLED_PLUGINS_UI.md) `paused` row.
- **Editor locale picker + shell strings (SDK-005b)** — `frontend/src/i18n/` is the host-side i18n module that wires the SDK's `LocaleStore` to the **editor shell** so a single picker change re-translates plugin UI and editor UI in the same dispatch loop. Six files: `locales/en.ts` (English shell strings as `as const`, exports `ShellTranslationKey = keyof typeof en`), `locales/es.ts` (`Partial<Record<ShellTranslationKey,string>>` so missing keys fall back to en, then to the key itself), `locales/index.ts` (`SHELL_LOCALES` map + `SUPPORTED_LOCALES` descriptors with `nativeName` always in the locale's own language), `translator.ts` (pure `translate(locale, key, vars?)` running the SDK's `resolveLocale` chain plus a final **key-as-debug fallback** so missing strings render as visible output instead of empty space), `LocaleProvider.ts` (host wiring: `bootEditorLocale()` / `setEditorLocale(code)` / `getEditorLocale()` / `subscribeEditorLocale(fn)`, persists to `localStorage` under `velxio.locale`, try/catch around `setItem` for Safari private mode), `useLocale.ts` (React hooks via `useSyncExternalStore` — `useTranslate()` returns a `useCallback`-memoised `t()` whose **identity is stable until the locale changes** so a downstream `React.memo` keeps its identity, mirroring the `<SlotOutlet />` render-fn discipline). Boot order: `App.tsx` calls `bootEditorLocale()` **before** the IndexedDB settings backend wiring and far before any plugin context — plugins read the active locale at `registerBundle` time, so a late boot would silently lock plugins to `en` until the user manually flipped the picker. Resolution chain on boot: `localStorage[velxio.locale]` (validated against `SUPPORTED_LOCALE_CODES`) → `navigator.language` (resolved via SDK's `resolveLocale`, so `es-MX` collapses to `es`) → `I18N_DEFAULT_LOCALE` (`en`); the resolved value is **persisted back** so subsequent loads are deterministic. Picker UI lives in the Installed Plugins modal header (the only "editor preferences" surface today); writes via `setEditorLocale` which fans out through the same dispatch every plugin's `onLocaleChange` listener uses. Translated shell components today (7/7 — SDK-005c part D closed 2026-04-24): `<AppHeader />` + `<InstalledPluginsModal />` (from SDK-005b) plus `<LoginPromptModal />` + `<SaveProjectModal />` (interpolated `{status}`) + `<FileExplorer />` (interpolated `{board}`) + `<TemplatePickerModal />` (interpolated `{id}` + `{level}`, sub-components each call `useTranslate()` themselves) + `<EditorToolbar />` (44 keys covering all 7 toolbar buttons, the overflow menu, the library hint banner, every status banner message, and the output-console log lines with their interpolated vars; backend-supplied `result.error || result.stderr` stays verbatim). **Translator shadowing rule**: never let `t` get shadowed by a callback parameter — TemplatePickerModal renamed `templates.find((t) => …)` → `templates.find((tpl) => …)` for this. Remaining items in SDK-005c: marketplace badge in velxio-pro (depends on PRO-005), Playwright e2e harness. **Sub-track C (extended locales) closed 2026-04-24** — `pt` (Brazilian Portuguese), `fr` (Metropolitan French), `de` (Hochdeutsch), `ja` (polite です・ます Japanese), `zh` (Simplified Chinese / mainland) all shipped as `Partial<Record<ShellTranslationKey, string>>` mirrors of `es.ts` (~140 keys each, all 11 namespace areas), wired into `SHELL_LOCALES`/`SUPPORTED_LOCALES`, with 3-5 smoke tests per locale in `i18n.test.ts` covering exact-match + region-tag collapse + interpolation. Total active locales: 7 (`en`/`es`/`fr`/`de`/`pt`/`ja`/`zh`). Region tags collapse via the SDK's `resolveLocale` chain: `pt-BR`/`pt-PT` → `pt`, `fr-CA` → `fr`, `de-AT`/`de-CH` → `de`, `ja-JP` → `ja`, `zh-CN`/`zh-Hans`/`zh-TW`/`zh-Hant` → `zh` (Traditional ships as a separate `zh-Hant` file when added). **Test convention for jsdom locale tests**: import `resetLocaleStoreForTests()` from `plugin-host/I18nRegistry` in `beforeEach`; pin starting locale via `setEditorLocale('en')` before each test that asserts a `set('es')` dispatch fires (the store deduplicates same-value writes by design). 24 new tests across `i18n.test.ts` (11 pure), `i18n-boot.test.ts` (9 jsdom), `useLocale.test.tsx` (4 jsdom + `createRoot` + `act`). See [docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md) → "SDK-005b — editor locale picker + shell strings" section.
- **Settings form renderer + IndexedDB backend (SDK-006b)** — `frontend/src/components/plugin-host/SettingsForm.tsx` + `frontend/src/plugin-host/IndexedDBSettingsBackend.ts` close the loop on SDK-006: the host now renders a live form for every declared schema and persists values across reloads. `<SettingsForm pluginId, onSaved? />` subscribes to `getSettingsRegistry().subscribe(...)` via `useSyncExternalStore` and re-renders on every re-declare; the body is keyed by `schemaFingerprint(schema)` so a shape migration unmounts the old controls and mounts a fresh tree (stale per-field state can't survive). Two-layer validation: every keystroke runs `applyAndValidate(schema, values, current)` to surface inline errors (Save disabled while any leaf is invalid); on Save, the form additionally awaits the plugin's own async `validate(values)` if supplied — identical contract to `createPluginSettings.set()` — and routes path-prefixed errors back to the right field. Backend errors win over live errors so the most recent rejection is visible. Type dispatch covers all six leaf types: `string` → `<input>` / `<select enum>` / `<textarea multiline>` / `<input type="password|email|url">`, `number`/`integer` → `<input type="number">` with `min`/`max`/`step`, `boolean` → checkbox, `array` of strings → tag/chip list with Enter-to-add, `object` (one nesting level) → fieldset routing inner errors via dotted-path. Save updates `entry.cachedValues` so subsequent `ctx.settings.get()` returns new values without a backend round-trip; Reset goes through `applyAndValidate({})` + confirm gate; Export downloads `${pluginId}-settings.json` shaped as `{ pluginId, values }`; Import accepts that shape OR a bare values object and routes through the same validator so malformed imports surface inline rather than corrupting state. `IndexedDBSettingsBackend` (DB `velxio.plugin-settings`, store `settings`, key=pluginId, value=`{values, updatedAt}`) implements the `SettingsBackend` interface and is wired in `App.tsx` at module load behind a `typeof indexedDB !== 'undefined'` guard so SSR/test contexts keep the in-memory default. The SDK contract didn't change — `set()`/`get()` were already async — so swapping backends is invisible to plugins. `<PluginSettingsDialog>` in `InstalledPluginsModal` now mounts the form when a schema is registered (falls back to the existing "no settings declared" message otherwise). What's deferred: panel-level "Export all plugin settings" button + Pro `plugin_installs.settings_json` wiring (lives with **PRO-003**). 14 tests in `SettingsForm.test.tsx` (jsdom env, manual `react-dom/client` + native value-tracker setter to bypass React's input-tracker) cover empty state, every leaf control type, inline validation, Save/Reset/backend round-trip. 144/144 plugin-host suite green. See [docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md) → "Settings form renderer + IndexedDB backend (SDK-006b)" section.
- **Slot UI infrastructure (CORE-002b)** — `frontend/src/plugin-host/SlotIds.ts` + `HostSlotRegistry.ts` + `frontend/src/components/plugin-host/SlotOutlet.tsx` is how plugin UI contributions reach the editor. `SlotIds.ts` declares 17 stable slot ids (`command-palette`, `editor.toolbar.{left,right}`, `editor.panel.{left,right}.dock`, `simulator.canvas.overlay`, `simulator.toolbar`, `file-explorer.context-menu`, etc.) plus a `SLOT_ROUTING` table mapping each slot to `{ source: registry, accepts?: predicate }` — toolbar items declare `position: 'left' | 'right'` and the table routes each item to exactly one slot. `HostSlotRegistry` is a singleton aggregator with a two-level `Map<SlotId, Map<pluginId, Map<itemId, SlotEntry>>>`; `getEntries(slotId)` returns the **same frozen array reference** until a mutation in that slot invalidates it (load-bearing for `useSyncExternalStore` identity-based render skipping), and `subscribe(slotId, fn)` only notifies on mutations touching that slot (toolbar adds don't wake the command palette). `mountPlugin(pluginId, ui)` subscribes to all 7 SDK-002 per-plugin UI registries and reconciles by diff (add/update/remove) on every notify; `createPluginContext` calls it once per plugin and the slotBridge's dispose is kept **outside** `subscriptions` so SDK-007's `subscriptions.size` invariant stays intact (dispose wrapper calls `slotBridge.dispose()` first, then `subscriptions.dispose()`). `<SlotOutlet />` is `React.memo` + `useSyncExternalStore` — `slot` prop + `children: (entry) => ReactNode` render-fn (MUST be stable: module-scope or `useCallback` — fresh closure defeats the memo) + optional `fallback`. The outlet enumerates only — surface layer resolves `commandId → plugin → execute`. **La regla de oro** documented in `docs/PLUGIN_SDK.md`: *lookup at setup, not on the hot path* — every registry lookup is `O(1)` but scales with plugin count, so resolve once at activate/setup and capture the reference; the frame loop calls the captured ref directly. 18 tests in `SlotOutlet.test.tsx` (jsdom env, `IS_REACT_ACT_ENVIRONMENT=true`): SlotIds wholeness × 2, HostSlotRegistry aggregation × 8 (snapshot identity, fault isolation, slot subscriber isolation, multi-plugin), `<SlotOutlet />` rendering × 5 (incl. 1000-iter no-rerender test), churn × 2. 130/130 plugin-host suite green. Mass migration of 7 parts files to `definePartSimulation()` (requires extending `SimulatorHandle.onPinChange()` first) deferred to **CORE-002c**. See [docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md) → "Slot UI infrastructure" + "La regla de oro".
- **Compact authoring — `defineCompoundComponent` + `registerCompound` (SDK-003b-step1)** — `packages/sdk/src/components.ts` adds `CompoundComponentDefinition extends ComponentDefinition` (`simulation?: PartSimulation`, `spice?: SpiceMapper`, `spiceModels?: ReadonlyArray<{name, card}>`) + `defineCompoundComponent<T>(d): T` identity helper + `ComponentRegistry.registerCompound(def): Disposable` as a **required** method on the SDK contract. Host side `frontend/src/plugin-host/createPluginContext.ts` adds the matching method on the `components` adapter — fans out to `components.register` → `partSimulations.register` (if `simulation`) → `spice.registerMapper` (if `spice`) → `spice.registerModel(...)` for each model card. Permission union is **emergent** from the fan-out (no new gate): `components.register` always, plus `simulator.pins.read` if `simulation` set, plus `simulator.spice.read` if `spice`/`spiceModels` set. **Rollback contract**: if any sub-call throws, every already-acquired handle is disposed in LIFO order before the original error is re-raised — the picker never shows a half-registered component. **Idempotent compound dispose**: a `disposed` flag short-circuits the second call; sub-handles also live in `ctx.subscriptions` (every `register*()` pushed one), so the eventual plugin-teardown also unwinds them — safe because every host disposable is idempotent. Trade-off accepted: dead handles linger in `subscriptions` after `compound.dispose()` until plugin unload (~16 bytes each). Forward-reference closure design: `registerCompound` is inline in the `components` literal but references `partSimulations`/`spice` declared later — works because closures resolve at call-time and plugins only call from `activate()` after the context is fully built. 9 SDK tests in `packages/sdk/test/compound-component.test.ts` (identity, 4 shape combinations, generic narrowing, `ComponentDefinition` assignability, type propagation via `expectTypeOf`, `defineComponent` round-trip) + 9 host tests in `frontend/src/__tests__/plugin-host-sdk003b.test.ts` (4 shape combinations, idempotent dispose, rollback on missing `simulator.spice.read`, fail-fast on missing `components.register`, plugin teardown via `dispose()` releases sub-handles, LIFO unwind verified across 4 sub-handles). 237/237 SDK tests + 124/124 plugin-host tests green. Steps 2 (high-level `PartSimulationAPI` with `pin()`/`serial`/`i2c`) and 3 (`NetlistMapContext.internalNode()`) stay in Backlog as the rescoped SDK-003b. See [docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md) → "Compact authoring — `defineCompoundComponent` + `registerCompound`" section.
- **`SpiceMapperContext.internalNode(suffix)` — per-component internal SPICE nets (SDK-003b-step3)** — `packages/sdk/src/spice.ts` `SpiceMapperContext` gains `internalNode(suffix: string): string` so a SPICE mapper that needs an extra node (BJT base tap, op-amp virtual ground, integrator feedback midpoint) can mint a name that is unique per component instance. Two instances of the same component now get distinct nets — before this, plugin authors had to invent `comp.id + '_n_internal'` and risked silently shorting internal state across instances. Host wiring lives in `frontend/src/simulation/spice/NetlistBuilder.ts`: `makeInternalNodeMinter(componentId)` builds the per-component closure (sanitizes both id and suffix to `[A-Za-z0-9_]`, throws on empty/non-string suffix to fail loudly instead of minting debug-hostile names like `n_<id>_undefined`); `makeTrackingInternalNodeMinter(componentId, set)` wraps it and pushes every minted name into a tracking `Set<string>` that is then handed to `detectFloatingNets`. **The tracking set is load-bearing**: `detectFloatingNets` parses each card token-by-token until it hits an unknown token (one not in the `nets` set); without the tracking, any card mentioning an internal node would interrupt the parser there and the detector would silently lose visibility on the rest of the pins on that card → false negatives in floating-net detection. With the tracking, internal nodes get the same auto pull-down treatment (100 MΩ to ground) as any other floating net. **Namespace `n_<id>_<suffix>` is disjoint from auto-named nets** (`n0`/`n1`/...) because auto-named are pure `n` + digits with no underscore, so plugin internal nodes can never collide with the auto-named namespace. **No `NetlistMapContext` introduction**: the original SDK-003b draft proposed a richer interface — decision was to extend `SpiceMapperContext` directly, fully backwards-compatible (mappers that don't call `internalNode` notice nothing). 5 SDK contract tests in `packages/sdk/test/internal-node.test.ts` (type shape via `expectTypeOf`, `defineSpiceMapper` accepts a mapper that uses `internalNode`, identity preservation at the SDK boundary, BJT example compiles, `SpiceEmission` shape unchanged) + 8 host integration tests in `frontend/src/__tests__/netlist-builder-internal-node.test.ts` (per-component scoping with two instances of same metadataId not colliding, idempotency within one invocation, stability across rebuilds, floating internal node via capacitor topology gets auto pull-down, throws on empty/non-string suffix, sanitization of hyphenated component IDs and dotted suffixes, distinct suffixes produce distinct nets). 242/242 SDK tests + 180/180 across the SPICE+plugin-host suite green. Step 2 (`PartSimulationAPI` high-level with `pin()`/`serial`/`i2c`) stays in Backlog as the rescoped SDK-003b — pre-req: add `i2c:transfer`/`spi:transfer` events to EventBus. See [docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md) → "Internal nets — `ctx.internalNode(suffix)`" section.
- **SimulatorHandle.onPinChange (CORE-002c-step1)** — Surgical SDK contract addition that unblocks the CORE-002c mass-migration. `packages/sdk/src/simulation.ts` `SimulatorHandle` gains `onPinChange(pinName: string, callback: (state: PinState) => void): Disposable`. Per-component shape on purpose: the handle already carries `componentId` and `getArduinoPin(pinName)` is keyed off it, so adding a second `componentId` parameter would duplicate that and open a cross-component observation capability with no permission gate (cross-plugin pin observation belongs to `simulator.events.read` via the EventBus, a different API). Single-pin callback signature `(state)` not `(pin, state)`: the plugin already knows which pin it subscribed to, and passing the arduino board pin number leaks host detail (plugins should never see board pin numbers). Host wiring lives in `frontend/src/simulation/parts/PartSimulationRegistry.ts` `registerSdkPart()` next to the existing `setPinState`/`getArduinoPin` adapters: resolve `getArduinoPin(pinName)` once at subscribe time, return `{ dispose: () => {} }` on `null` (no-op Disposable so plugin teardown code is uniform regardless of wire state — no null checks at the call site), otherwise wrap `simulator.pinManager.onPinChange(arduinoPin, ...)` and return `{ dispose: unsubscribe }`. The `(pin, state)` PinManager callback collapses to `(state)` for the plugin. **Trade-off**: late-arriving wires don't auto-wire — plugins that need that re-subscribe on `events.on('wire:connect', …)`. 6 new tests in `part-simulation-registry-sdk.test.ts` (real `PinManager` instance, no mocks in the wire) — file total 19/19; 92/92 across the 5 plugin-related test files green; 228/228 SDK suite green. The mass migration of 7 parts files to `definePartSimulation()` + centralized seeding via `registerCoreParts.ts`/`registerCoreComponents.ts` + BENCH-AVR-04 verification stays in Backlog as the original CORE-002c (now scoped down to "steps 2-4 only"). See [docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md) → "Subscribing to pin transitions — `onPinChange`" subsection.
- **`'plugin:update:applied'` EventBus event for telemetry plugins (SDK-008f)** — Closes the cross-plugin observability gap left by SDK-008d: telemetry plugins (e.g. a Pro audit plugin the user installs to track their environment) can now subscribe to sibling auto-updates instead of having to peek at `useToastFeedStore` (which lives in the editor's Zustand store and is not exposed to plugins). New entry on the `SimulatorEvents` map in `packages/sdk/src/events.ts`: `'plugin:update:applied': { pluginId; fromVersion; toVersion; decision: 'auto-approve' | 'auto-approve-with-toast'; addedPermissions: readonly string[] }`. Emitted from `PluginLoader.checkOne` in `frontend/src/plugins/loader/PluginLoader.ts` AFTER `loadOne(next)` resolves, gated by **two** conditions: `reload.status === 'active'` (a failed reload — license-failed, integrity-mismatch, offline — would surface a false positive to telemetry plugins, so the emit only fires when the swap actually produced a live worker) AND `bus.hasListeners('plugin:update:applied')` (canonical PERF-001 hot-path guard, even though `checkForUpdates` runs from a 24h tick). NOT emitted on `requires-consent` — those updates are still pending a user click via the badge UI; a separate `'plugin:update:available'` event for that path was explicitly out of scope because it would expose pending permission asks cross-plugin (privacy-questionable). The `permDiff` is captured once before `classifyUpdateDiff(permDiff)` to avoid recomputing it when building the event payload — minor cleanup, no API change. `PluginLoader` gained an injectable `eventBus?: HostEventBus` constructor option (defaults to `getEventBus()`) for test isolation; production code wires the singleton automatically. Permission gate: `simulator.events.read` (Low-risk, existing — same gate as the rest of the EventBus), no new permissions introduced. `addedPermissions` is the post-hoc delta vs. the prior manifest — not a new privacy surface beyond what the user already saw in the toast for `auto-approve-with-toast`. 6 new tests in `plugin-loader-update-detection.test.ts` (16/16 file total): emit on auto-approve with empty `addedPermissions`, emit on auto-approve-with-toast with `['simulator.events.read']` delta, no-emit when no listeners registered (verified via `bus.listenerCount(...) === 0`), no-emit on `requires-consent` path, no-emit when reload fails (custom `StubManager` rejects on second `load()` call producing `reload.status === 'failed'`), smoke test of the production singleton fallback. See [docs/EVENT_BUS.md](docs/EVENT_BUS.md) → "Plugin update telemetry — `plugin:update:applied`" section.
- **Loader-driven update auto-detection + in-modal toast feed (SDK-008d)** — Closes the loop on the SDK-008b/SDK-008c stack: the editor now detects available updates on its own and surfaces auto-applied ones to the user without ever stealing focus. Three pieces. **(1) `PluginLoader.checkForUpdates(installed, opts)`** in `frontend/src/plugins/loader/PluginLoader.ts` runs `Promise.allSettled` over each `InstalledPlugin`, classifies the diff **locally** via `classifyUpdateDiff()`, then routes each result: `no-drift`/`no-manifest`/`skipped` return immediately; `requires-consent` returns immediately too — **the rule is: never auto-mount a permission dialog from a background tick** because two plugins both qualifying for consent within the same tick would queue/steal focus across each other (the badge UI handles the user click instead); `auto-approve` calls `controller.requestUpdate()` (which silently resolves), then `manager.unload(id)` + `manager.load(latestManifest, ...)`; `auto-approve-with-toast` does the same plus the controller fires `sinks.emitToast()` along the way. Each row returns a typed `UpdateCheckOutcome` with `decision` + optional `latestVersion` + optional `reload: PluginEntry` + optional `error`. Headless mode (no controller wired) takes the auto-reload default — dev/test setups don't need the full UI stack. Controller mid-flow throws `InstallFlowBusyError` → `decision: 'busy'`; resolver throws → `decision: 'error'` with the original error attached. **(2) `useToastFeedStore`** in `frontend/src/store/useToastFeedStore.ts` is the Zustand store backing the in-modal banner: `push({pluginId, fromVersion, toVersion, added})` (de-dupes by `(pluginId, toVersion)`), `getRecent(now?)` (newest-first, **TTL filter on read** with `TOAST_FEED_TTL_MS = 24h`, no sweeper), `dismiss(id)` / `dismissAll()`, `MAX_ENTRIES = 50` cap, sessionStorage persistence under `velxio.pluginUpdateToasts` with **silent quota failure** + corrupt-blob → empty fallback. Wired in `App.tsx` inside `configureInstallFlow({ emitToast: (event) => useToastFeedStore.getState().push(event) })`. **(3) `<UpdateFeedBanner />`** in `frontend/src/components/plugin-host/UpdateFeedBanner.tsx` — pure presentational, owns no install state. Subscribes to `useToastFeedStore` via Zustand `(s) => s.tick` then reads fresh `getRecent()` off `getState()` every render so the TTL filter runs on read. Renders nothing when feed is empty. Collapsed pill by default (↑ icon + count summary, singular/plural i18n via `plugins.toast.summary{,plural}`); expanding mounts the entry list with per-entry Dismiss `×` and global "Dismiss all". Visual tone: positive update green (`#1f3a2a` / `#a8e6b8`), distinct from `<MarketplaceBanner>` (warning amber) and `<ErrorBanner>` (red). Mounts inside `<InstalledPluginsModal>` header above `<MarketplaceBanner>`. **Store adapter `useInstalledPluginsStore.checkForUpdates()`** is the single entry point any caller (24h tick, future "Check now" button) goes through: fail-closed when no loader / no resolver / resolver lacks the optional `getLatestManifest?(id)` extension (returns `[]` silently), else builds `InstalledPlugin[]` from marketplace installs + module-local `manifestCache` (skips `localUninstalled`, missing `bundleHash`, missing cached manifest), forwards `isVersionSkipped` predicate, wraps loader in try/catch returning `[]` on rejection — timer fires unattended, no banner allowed. The `manifestCache` is populated on every PluginManager notify tick because the loader needs the *currently installed* manifest to diff (the marketplace `InstalledRecord` only carries id+version+enabled+bundleHash). **`LatestVersionResolver` extension**: existing interface gains optional `getLatestManifest?(pluginId): Promise<PluginManifest | null> | PluginManifest | null` so one resolver covers both the version-only badge path *and* the auto-update path; production stub omits it (PRO-003 will provide the catalog-backed implementation), so today auto-update is a no-op until the catalog ships. **Modal 24h tick** now fires both `refreshDenylist()` and `checkForUpdates()` from a single `setInterval` (immediately on mount + every 24h). Real catalog manifest fetch deferred to **PRO-003** (tracked as **SDK-008e**); optional `'plugin:update:applied'` EventBus event for telemetry plugins shipped as **SDK-008f**. 10 loader tests in `plugin-loader-update-detection.test.ts` (6 classifications + 4 failure paths incl. `Promise.allSettled` fan-out and headless-mode default), 9 store tests in `toast-feed-store.test.ts` (push/getRecent/dismiss/TTL/sessionStorage + corrupt blob), 8 store tests added to `installed-plugins-store.test.ts` for `checkForUpdates()` (47 total). See [docs/PLUGIN_LOADER.md](docs/PLUGIN_LOADER.md) → "Update detection (SDK-008d)" + [docs/INSTALLED_PLUGINS_UI.md](docs/INSTALLED_PLUGINS_UI.md) → "SDK-008d additions".
- **Install/update flow controller (SDK-008c)** — `frontend/src/plugin-host/InstallFlowController.ts` is the host-side singleton that owns the consent / update-diff dialog lifecycle and is the single entry point any caller (marketplace install button, Installed Plugins modal update badge, future loader-driven detector) goes through to surface a permission prompt. Two-layer split kept on purpose so the consent logic stays unit-testable in plain Vitest: pure-logic controller + thin React overlay. Controller exposes `requestInstall(manifest, options?)` and `requestUpdate(installed, latest)` returning typed `InstallDecision` / `UpdateDecision` discriminated unions; both methods are **NOT** declared `async` — the busy guard `if (this.active !== null) throw new InstallFlowBusyError();` runs synchronously so a misbehaving caller sees the throw on its own stack instead of an unhandled rejection on a microtask. Only one dialog can be open at a time. The consent decision is delegated to the SDK helpers (`requiresConsent` for install, `classifyUpdateDiff` for update); auto-approve paths resolve immediately via `Promise.resolve(...)` with no modal mount, `auto-approve-with-toast` invokes `sinks.emitToast?.(InstallToastEvent)` and resolves immediately (App.tsx leaves the toast hook unset until SDK-008d/PRO-005 ships a notification surface — events drop silently, install still proceeds), `requires-consent` builds a `new Promise((resolve) => …)` and mounts the matching dialog. **Skipped versions** flow through `useInstalledPluginsStore.skippedVersions: ReadonlyMap<id, version>` persisted in localStorage under `velxio.skippedVersions`; `buildRows` suppresses the `latestVersion` badge when `latest === skipped` (a strictly newer release replaces the cursor — the user is never permanently silenced, only per-version). The store survives corrupt JSON in storage with a try/catch fallback to empty Map. The React overlay `frontend/src/components/plugin-host/InstallFlowOverlay.tsx` subscribes via `useSyncExternalStore` and renders the dialog matching `ActiveDialog.kind`; `App.tsx` mounts a single `<InstallFlowOverlay controller={getInstallFlowController()} />` inside the router. `InstalledPluginsModal.tsx`'s `<PluginUpdateBadge />` was converted from `<span>` to `<button>` that calls `controller.requestUpdate(installed, latest)`; today it uses a `synthesizeLatestManifest` placeholder (clones installed manifest + bumps version → diff resolves auto-approve → no dialog) until PRO-003 wires a real catalog endpoint. Module exports `configureInstallFlow(sinks)` (idempotent, HMR-friendly), `getInstallFlowController()` (throws "not configured"), `setInstallFlowControllerForTests(null)`, `createInstallFlowControllerForTests(sinks)`. 22 controller tests in `InstallFlowController.test.ts` (silent install, consent confirmed/cancelled, busy guard sync throw, all 4 update decisions, skip persists via sinks, subscribe fan-out, throwing listener fault isolation, cancelActive sync close, configure/get/setForTests singleton helpers) + 4 jsdom overlay tests in `InstallFlowOverlay.test.tsx` (createRoot + act, render-nothing / consent dialog mount / update dialog mount / no dialog on auto-approve) + 8 store tests added to `installed-plugins-store.test.ts` for the skipped-versions surface (39 total). Loader-driven update auto-detection + toast surface + real catalog manifest fetch deferred to **SDK-008d**; marketplace install button caller deferred to **PRO-005**. See [docs/PLUGIN_PERMISSIONS.md](docs/PLUGIN_PERMISSIONS.md) → "Install/update flow controller (SDK-008c)" section.
- **Permission consent + update-diff dialogs (SDK-008b)** — `frontend/src/components/plugin-host/PluginConsentDialog.tsx` + `PluginUpdateDiffDialog.tsx` are the two security-critical modals that gate every Medium/High permission grant. Both are pure presentational components — owns no install state — so the same component can be reused by the marketplace install flow (PRO-005), the loader's update detector (deferred to **SDK-008c**), and any future "preview install" surface. Driven by `@velxio/sdk/permissions-catalog` (new SDK subpath export) which carries `PERMISSION_CATALOG` (one entry per `PluginPermission` with `risk` + `allows` + `denies` copy), `partitionPermissionsByRisk()`, `requiresConsent()`, `diffPermissions()`, and `classifyUpdateDiff()` returning a discriminated `UpdateDiffDecision = auto-approve | auto-approve-with-toast | requires-consent`. The TS catalog is the runtime source of truth; sync test `packages/sdk/test/permissions-catalog-sync.test.ts` parses the markdown table in `docs/PLUGIN_PERMISSIONS.md` and fails CI if the two drift in either direction (catalog row missing from doc or doc row missing from catalog or risk class mismatch). Anti-clickjacking: `<PluginConsentDialog>`'s Install button + `<PluginUpdateDiffDialog>`'s Update button (in `requires-consent` mode only) stay disabled until the user has scrolled the permissions list to the bottom — the Mozilla-recommended consent-flow mitigation against transparent overlay attacks. Tolerance is exposed via `isScrolledToBottom(el, toleranceMs)` so tests drive the math without jsdom layout. Helpers `shouldShowUpdateDiffDialog(decision)` and `decisionNeedsScrollGate(decision)` let callers decide between "install silently" vs "open dialog" vs "open dialog without gate" without inspecting the discriminated union themselves. Update dialog has four actions: `Update` (gated), `Skip this version` (per-version reject — vNew+1 re-prompts), `Uninstall plugin`, `Cancel` (Esc). Default focus on Cancel for both dialogs (safer destructive default). `http.fetch` rows expand to show the manifest's `http.allowlist` verbatim — the user must see exactly what origins the plugin will reach. Unknown permissions trigger a defensive fail-closed banner (the SDK and host disagree on catalog version). 23 new SDK tests (`permissions-catalog.test.ts` + `permissions-catalog-sync.test.ts`) bring SDK total to 228; 37 new component tests (`PluginConsentDialog.test.tsx` 17 + `PluginUpdateDiffDialog.test.tsx` 20, both jsdom + `react-dom/client` manual mount with prototype-level `scrollHeight`/`clientHeight` mocks installed in `beforeEach` so the gate actually engages in tests). Wiring of these dialogs into the install/update path is naturally deferred — there is no install flow until **PRO-005** (marketplace listing → click Install) and no update detector until **SDK-008c** wires the loader to surface new versions. See [docs/PLUGIN_PERMISSIONS.md](docs/PLUGIN_PERMISSIONS.md) → "SDK-008b implementation reference" section.
- **Plugin host integration follow-ups (SDK-002b)** — Three independent gap-fillers for the SDK-002 host. **(A) Streaming response cap in `ScopedFetch`**: the `Content-Length` upfront check is now backed by a counting `ReadableStream` wrap of `response.body` so a server that omits the header (or sends chunked-transfer) still aborts at `SCOPED_FETCH_MAX_BYTES` (4 MB) with the new SDK-level `HttpResponseTooLargeError(url, observed, max)` exported from the barrel. **(B) IndexedDB plugin storage backend** (`frontend/src/plugin-host/IndexedDBPluginStorageBackend.ts`): one DB (`velxio.plugin-storage`), one object store (`entries`), keys prefixed `${pluginId}:${bucket}:${key}` — single-store-with-prefixed-keys avoids the `onupgradeneeded` version bump that dynamic per-plugin stores would force on every install. Async `create(pluginId, bucket)` does a cursor scan with `IDBKeyRange.bound(prefix, prefix + '￿')` to populate an in-memory `Map` mirror, so the sync `StorageBackend` interface still holds (O(1) reads after construction). Writes are write-through: mirror updated synchronously, IDB put enqueued on a single-track `writeQueue` Promise chain; new optional `flushed?(): Promise<void>` hook on `StorageBackend` lets `InMemoryPluginStorage.set/delete` await persistence so `await ctx.userStorage.set(k, v)` doesn't return before bytes are durable. Errors during persistence go through injected `onError` (default `console.error`); the mirror keeps the new value so the next op retries. Wiring lives in `PluginManager.configure({ storageBackendFactory })` — optional `(pluginId, bucket) => Promise<StorageBackend>` factory awaited PER PLUGIN PER BUCKET inside `load()` BEFORE worker construction (factory throw → entry marked `failed`, worker never built); per-plugin backends are injected via the new `services.userStorageBackend` / `services.workspaceStorageBackend` slots that `createPluginContext` consumes. Backwards-compatible: omitted factory falls back to `MapStorageBackend`. **App.tsx wiring of the production factory deferred** — the backend is exposed as a building block; the editor still constructs `PluginManager` lazily and the one-line `configure({ ..., storageBackendFactory: createPluginStorageBackends })` lands with the eventual "production loader boot" task. **(C) TypeDoc API reference**: `packages/sdk/typedoc.json` (4 entry points matching the four `exports` subpaths: index, manifest, events, permissions-catalog), `npm run docs:api` emits HTML to `docs-api/` (gitignored), `excludeInternal` + `excludePrivate` keep the surface plugin-author-facing, `validation.invalidLink: true` fails the build on dangling links. CI workflow `.github/workflows/sdk-docs.yml` runs typecheck + docs:api on `packages/sdk/**` changes and uploads `sdk-api-docs` artifact (14-day retention); GitHub Pages publish step is **deliberately deferred** to `task_plan/human_review/SDK-002b-followup-pages-deploy.md` because it requires a repo-settings change (Pages source + custom domain config). Tests: `frontend/src/__tests__/IndexedDBPluginStorageBackend.test.ts` (11, fake-indexeddb auto, fresh-DB-name-per-test isolation: missing key undefined, round-trip via mirror, persistence across instances, bucket isolation `user`↔`workspace`, plugin isolation `plugin.a`↔`plugin.b`, delete propagation, write-order LWW, error reporting via onError without dropping mirror, `createPluginStorageBackends` parallel pair, quota check via mirror, restart survival), `frontend/src/__tests__/plugin-manager-storage-factory.test.ts` (5, jsdom: load without factory works, factory awaited for both buckets, factory called once per plugin (4 calls for 2 plugins), failed factory marks entry failed and worker NOT constructed, per-load services override skips factory). 16 new tests; full plugin-host related suite 163/163 green. See [docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md) → "SDK-002b — host integration follow-ups" section.
- **Marketplace discovery (CORE-010)** — `frontend/src/marketplace/` + `frontend/src/store/useMarketplaceStore.ts` is how the OSS Core detects the Pro marketplace **without coupling**. `MarketplaceClient.probe(discoveryUrl)` GETs `/.well-known/velxio-marketplace.json` (must match `schemaVersion: 1`, `apiBaseUrl` regex `^https?://`, ≤64 KB body) and **never throws** — every transport/parse failure returns a typed `MarketplaceStatus = idle | probing | available | unavailable` where `unavailable.reason ∈ { disabled | not-found | network | http-error | malformed-metadata }`. After `available`, the client knows three URLs: `/api/marketplace/me/installs` (cookie-auth, owned by PRO-003), `/api/marketplace/me/licenses` (cookie-auth, PRO-007), `/api/marketplace/license-denylist.json` (public, PRO-007). 401/403 → `MarketplaceAuthRequiredError` (UI shows "Sign in to Pro" without disabling the rest). `useMarketplaceStore.initialize()` runs probe + `Promise.allSettled` over the three data fetches and coalesces concurrent calls via `pendingInit`. Env: `VITE_VELXIO_MARKETPLACE_BASE_URL` defaults to `https://api.velxio.dev`; setting it to **literal empty string** opts the self-host out cleanly (status pinned to `unavailable/disabled`, no HTTP at all). Caps: 64 KB discovery, 4 MB data. `features.{installs|licenses|denylist}: false` in the discovery doc → caller-side throw `MarketplaceUnavailableError(disabled)` without hitting the network. 35 tests across `marketplace-{config,client,store}.test.ts`. See [docs/MARKETPLACE_DISCOVERY.md](docs/MARKETPLACE_DISCOVERY.md).
- Tests: `packages/sdk/test/*.test.ts` (242), `frontend/src/__tests__/EventBus.test.ts` (17), `frontend/src/__tests__/CompileMiddleware.test.ts` (15), `frontend/src/__tests__/spice-mapper-registry.test.ts` (18), `frontend/src/__tests__/netlist-builder-internal-node.test.ts` (8), `frontend/src/__tests__/component-registry-sdk.test.ts` (12), `frontend/src/__tests__/part-simulation-registry-sdk.test.ts` (19), `frontend/src/__tests__/plugin-host.test.ts` (26), `frontend/src/__tests__/plugin-host-sdk003.test.ts` (14), `frontend/src/__tests__/plugin-host-sdk003b.test.ts` (9, jsdom), `frontend/src/__tests__/plugin-host-sdk004.test.ts` (19), `frontend/src/__tests__/plugin-host-sdk005.test.ts` (22), `frontend/src/__tests__/plugin-host-sdk006.test.ts` (20), `frontend/src/__tests__/plugin-host-sdk007.test.ts` (11), `frontend/src/__tests__/SlotOutlet.test.tsx` (18, jsdom), `frontend/src/__tests__/SettingsForm.test.tsx` (14, jsdom), `frontend/src/__tests__/PluginConsentDialog.test.tsx` (17, jsdom), `frontend/src/__tests__/PluginUpdateDiffDialog.test.tsx` (20, jsdom), `frontend/src/__tests__/compilation-libraries.test.ts` (8), `frontend/src/__tests__/TemplatePickerModal.test.tsx` (6, jsdom), `frontend/src/__tests__/i18n.test.ts` (11), `frontend/src/__tests__/i18n-boot.test.ts` (9, jsdom), `frontend/src/__tests__/useLocale.test.tsx` (4, jsdom), `frontend/src/__tests__/InstallFlowController.test.ts` (22), `frontend/src/__tests__/InstallFlowOverlay.test.tsx` (4, jsdom), `frontend/src/__tests__/installed-plugins-store.test.ts` (47), `frontend/src/__tests__/plugin-loader-update-detection.test.ts` (16, jsdom), `frontend/src/__tests__/toast-feed-store.test.ts` (9, jsdom), `frontend/src/__tests__/IndexedDBPluginStorageBackend.test.ts` (11), `frontend/src/__tests__/plugin-manager-storage-factory.test.ts` (5, jsdom), `backend/tests/test_compile_middleware.py` (15), `backend/tests/test_library_validation.py` (28), `backend/tests/test_compile_route_libraries.py` (6). Frontend full suite: ~1270 (4 pre-existing flaky long-running tests: EventBus 1M-emit perf budget + ILI9341 boot + Mega blink + Pong setup-wait + spice-rectifier-live RAF — all timeout-sensitive under contention). All wired into CI (`.github/workflows/sdk-tests.yml`, `frontend-tests.yml`, `backend-unit-tests.yml`).
- Bench gates: `frontend/bench/eventbus.bench.ts` (BENCH-EVENT-01/02 + BENCH-PIN-01) — emit overhead must stay negligible (PERF-001 budgets). See [docs/PERFORMANCE.md](docs/PERFORMANCE.md).
- Task plan: `wokwi-libs/velxio-pro/task_plan/` — Kanban folders (`Backlog/`, `Ready/`, `InProgress/`, `Done/`). Index: `Backlog/INDEX.md`. Mark tasks done by moving the `.md` file to `Done/` and adding `completed_at` + `deliverables` frontmatter.

**Electrical Simulation (Phase 8 — behind ⚡ toggle):**
- ngspice-WASM engine via `eecircuit-engine` (lazy-loaded, ~39 MB chunk).
- Entry: `frontend/src/simulation/spice/SpiceEngine.lazy.ts`
- NetlistBuilder: `frontend/src/simulation/spice/NetlistBuilder.ts` — Union-Find on `wires[]` → SPICE cards via `componentToSpice.ts`.
- Store: `useElectricalStore` (separate from `useSimulatorStore`; feature-flagged).
- UI: `<ElectricalModeToggle />` in toolbar, `<ElectricalOverlay />` on canvas.
- Probes: `instr-voltmeter`, `instr-ammeter` metadata IDs.
- Build-time flag: `VITE_ELECTRICAL_SIM=false` to disable completely.
- Tests: `frontend/src/__tests__/spice-*.test.ts`, `netlist-builder.test.ts`, `component-to-spice.test.ts`, `instruments.test.ts` (39+ tests).
- Reference sandbox: `test/test_circuit/` (47 tests proving the approach).
- Docs: `docs/wiki/circuit-emulation.md` (implementation details), `docs/wiki/electrical-simulation-user-guide.md` (user-facing).

**Planned:**
- Undo/redo functionality
- More boards (ESP32, Arduino Mega, Arduino Nano)
- Export/Import projects as files

## Additional Resources

- Main README: [README.md](README.md)
- Architecture Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Event Bus contract: [docs/EVENT_BUS.md](docs/EVENT_BUS.md)
- Compile Middleware contract: [docs/COMPILE_MIDDLEWARE.md](docs/COMPILE_MIDDLEWARE.md)
- Plugin SDK author guide: [docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md)
- Plugin permissions catalog: [docs/PLUGIN_PERMISSIONS.md](docs/PLUGIN_PERMISSIONS.md)
- Plugin runtime architecture: [docs/PLUGIN_RUNTIME.md](docs/PLUGIN_RUNTIME.md)
- Plugin loader + cache: [docs/PLUGIN_LOADER.md](docs/PLUGIN_LOADER.md)
- Performance budgets: [docs/PERFORMANCE.md](docs/PERFORMANCE.md)
- Wokwi Elements Repo: https://github.com/wokwi/wokwi-elements
- AVR8js Repo: https://github.com/wokwi/avr8js
- Arduino CLI Docs: https://arduino.github.io/arduino-cli/

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
- **Event bus** (`frontend/src/simulation/EventBus.ts`): zero-listener fast-path emit (~13 M ops/s), `Set<Function>` storage, error-isolated dispatch, snapshot-on-dispatch, leak warn at 50 listeners, `shouldEmitThrottled()` helper. Wired into AVRSimulator (`pin:change`, `serial:tx`, `simulator:start/stop/reset/tick`), CircuitScheduler (`spice:step`), and `compilation.ts` (`compile:start/done`). Hot-path emits MUST be guarded by `if (bus.hasListeners(...))`. See [docs/EVENT_BUS.md](docs/EVENT_BUS.md).
- **Compile middleware** (`frontend/src/simulation/CompileMiddleware.ts` + `backend/app/services/compile_middleware.py`): two independent registries (client + server). Pre = FIFO, transform-then-throw-aborts. Post = LIFO, observe-only, swallows errors. Each middleware wrapped in 5 s timeout. Built-in `Rp2040SerialRedirectMiddleware` (server) replaces the old hard-coded `#define Serial Serial1` in `arduino_cli.py`. See [docs/COMPILE_MIDDLEWARE.md](docs/COMPILE_MIDDLEWARE.md).
- **Registry contracts (CORE-002)**: `ComponentRegistry.register(ComponentDefinition)`, `PartSimulationRegistry.registerSdkPart()`, `SpiceMapperRegistry` (`frontend/src/simulation/spice/SpiceMapperRegistry.ts`) all implement the SDK shape — last-writer-wins dispose, O(1) Map lookup, SDK `enum`→host `select` property mapping. Built-ins seed each registry on module load; plugin code calls the same entry points. Identity helpers: `defineComponent`, `definePartSimulation`, `defineSpiceMapper`. **Rule**: `registry.lookup()` runs at setup/netlist-build, never inside a frame tick — callers cache the resolved reference.
- **Plugin host (SDK-002)** — `frontend/src/plugin-host/` is the host-side implementation behind `PluginContext`: `PermissionGate.requirePermission()` (synchronous fail-fast throwing `PermissionDeniedError`), 7 `MapBackedRegistry<T>` UI registries with `subscribe()`, `InMemoryPluginStorage` with 1 MB quota (`PLUGIN_STORAGE_QUOTA_BYTES`) using TextEncoder byte counting + `StorageBackend` seam for future IndexedDB swap, `createScopedFetch` (HTTPS-only allowlist prefix matching, `X-Velxio-Plugin` header tag, `credentials: 'omit'`, 4 MB Content-Length cap), `PluginLogger` with `[plugin:<id>]` prefix, `SpiceModelRegistry`. Factory `createPluginContext(manifest, services)` wires per-plugin gated adapters around the host singletons; LIFO `dispose()` is idempotent and a throwing disposable doesn't block others. Storage method wrappers are `async` so synchronous gate throws land as rejected promises (matches SDK contract). New SDK errors: `StorageQuotaError`, `HttpAllowlistDeniedError`. Plugins **never** import from this folder — they only see `@velxio/sdk`.
- **Plugin extension flow (SDK-003)** — three independent calls a plugin makes through `ctx`: `components.register(def)` (picker + pin layout, requires `components.register`), `partSimulations.register(id, sim)` (MCU-side, requires `simulator.pins.read`), `spice.registerMapper(id, mapper)` + `spice.registerModel(name, card)` (electrical mode, requires `simulator.spice.read`). The `components` adapter throws `DuplicateComponentError` when an id is already taken (same plugin, cross-plugin, or built-in) — last-writer-wins is reserved for built-in seeding. The `partSimulations` adapter wraps plugin `onPinStateChange`/`attachEvents` in try/catch — throws are logged via `ctx.logger.error` and swallowed so a buggy plugin never crashes the simulator loop; a throwing `attachEvents` returns a no-op cleanup. Author-facing surface: `defineComponent`, `definePartSimulation`, `defineSpiceMapper` identity helpers. See [docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md).
- **Disposable + lifecycle (SDK-007)** — SDK exposes `DisposableStore { add(d), dispose(), readonly isDisposed, readonly size }` and `PluginContext.subscriptions: DisposableStore` as the canonical place to track teardown. Host implementation `frontend/src/plugin-host/DisposableStore.ts` (`HostDisposableStore`) guarantees: **LIFO unwind**, **idempotent dispose**, **fault-isolated** (a throwing disposable is logged via `ctx.logger.error` and the rest still run), and **late-arrival safe** — `add(d)` after `dispose()` disposes `d` immediately and emits a warn through the plugin logger (catches the async-task-after-deactivation bug). `createPluginContext` was refactored so all 7 UI registries + components + partSimulations + spice handles + plugin-managed disposables share **one** store — there is no second list to forget about. `ctx.addDisposable(d)` is a thin alias of `ctx.subscriptions.add(d)`. Hard timeout per-dispose belongs to CORE-006 (worker runtime).
- **Pure-data contributions (SDK-004)** — `ctx.templates.register(TemplateDefinition)` and `ctx.libraries.register(LibraryDefinition)` are the two plugin shapes that are **data, not code**: project templates (board + files + components + wires snapshot) and Arduino libraries (vendored `.h`/`.cpp` bundles). Validated synchronously at register time via Zod (`packages/sdk/src/templates.ts` / `libraries.ts`) so a malformed bundle fails in dev rather than at use time. Caps: templates ≤1 MB total, ≤64 files × ≤500 KB; libraries ≤2 MB total, ≤512 KB per file, path depth ≤8, allow-listed extensions, allow-listed `#pragma` names, no `..` in `#include`. Cross-plugin id collisions throw `DuplicateTemplateError` / `DuplicateLibraryError` — last-writer-wins is reserved for built-in seeding because arduino-cli identifies libraries by folder name (silent overwrite would be unsafe). Host registries `frontend/src/plugin-host/TemplateRegistry.ts` + `LibraryRegistry.ts` are singletons with `subscribe()` for UI reactivity; `LibraryRegistry.resolve(ids)` does a DFS topological sort with cycle detection (throws `LibraryDependencyCycleError` with an actionable cycle path). The actual mounting of libraries into `sketch_dir/libraries/<id>/...` and the "New from template" picker are deferred to **SDK-004b** because end-to-end testing requires CORE-007 (plugin loader). See [docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md).
- **Translatable strings (SDK-005)** — `ctx.i18n: I18nAPI` is the per-plugin i18n surface: `t(key, vars?)`, `format(template, vars?)`, `locale`, `availableLocales`, `onLocaleChange(fn)`, `registerBundle(PluginI18nBundle)`. Bundle validated at register time (Zod + caps: ≤1024 keys/locale, ≤4 KB per value, ≤256 KB total) — throws `InvalidI18nBundleError` with `pluginId` baked in. **No permission gate** — translations are local read-only data, not a sensitive surface. Locale resolution: exact → language-only (`es-MX` → `es`) → region-collapse (`es` → first `es-XX`) → default `en` → key itself (missing strings show as visible debug output). `interpolate()` supports `{name}` placeholders with `{{`/`}}` escape; missing vars stay literal. Host: `frontend/src/plugin-host/I18nRegistry.ts` — `LocaleStore` singleton (snapshot-on-dispatch, `navigator.language` initial detection, malformed-tag rejection with warn) + `createPluginI18n(manifest, logger)` factory. Plugin callbacks fault-isolated through `logger.error` — same EventBus rule. Editor locale picker UI + core-shell string refactor + marketplace badge are deferred to **SDK-005b**. See [docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md).
- **User-tunable settings (SDK-006)** — `ctx.settings: SettingsAPI` is the per-plugin schema-driven configuration surface: `declare(SettingsDeclaration)`, `get()`, `set(partial)`, `reset()`, `onChange(fn)`. Schema is a small JSON-Schema subset (string/number/integer/boolean/array-of-strings/object-one-level; modifiers: `enum`, `minLength`/`maxLength`, `minimum`/`maximum`, `multipleOf`, `pattern`, `format` for strings) — bounded so the form renderer stays simple. `validateSettingsSchema(schema, pluginId)` runs at `declare()` time, throws `InvalidSettingsSchemaError`. `applyAndValidate(schema, partial, current)` fills defaults, coerces string↔number for numeric fields, and returns `{ ok, errors?, values? }` — **`values` is populated even on failure** to enable schema migrations. Permission gate: `'settings.declare'` only; reads/writes/resets/subscriptions free once declared. Caps: ≤64 top-level properties, ≤32 KB JSON values, ≤4 KB strings. Host: `frontend/src/plugin-host/SettingsRegistry.ts` — `HostSettingsRegistry` singleton (re-declare creates a NEW entry so the OLD handle's `dispose()` is a no-op + two-pass migration: keep valid + re-default dropped + `fillDefaultsRaw` rescues self-invalid defaults like `default: ''` on `minLength: 4`) + `SettingsBackend` interface (default `InMemorySettingsBackend`; production wires IndexedDB / `plugin_installs.settings_json`) + `createPluginSettings(manifest, logger)` factory with snapshot-on-dispatch and fault-isolated `onChange`. React form renderer + IndexedDB backend deferred to **SDK-006b**. See [docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md).
- **Permissions catalog + threat model (SDK-008)** — [docs/PLUGIN_PERMISSIONS.md](docs/PLUGIN_PERMISSIONS.md) is the canonical reference for the 22 entries in `PLUGIN_PERMISSIONS` (`packages/sdk/src/permissions.ts`). Each row documents Risk class (Low/Medium/High), what it allows, what it explicitly does NOT allow, and which gate currently enforces it (3 entries — `simulator.events.read`, `simulator.pins.write`, `compile.transform.client` — are declared but ungated; gates land in CORE-006 and SDK-003b respectively, called out in the table). Threat model: 5 attacker assumptions (malicious author, supply-chain compromise, stale plugin, social engineering, side-channel via storage), runtime guarantees (current vs pending CORE-006 worker sandbox), capability denylist (DOM, cookies, editor LocalStorage, network without allowlist, cross-plugin reads). Includes the spec for the pre-install consent dialog (triggered by any Medium/High permission, scroll-to-bottom anti-clickjacking gate) and the update permission-diff dialog (auto-approve only when `v_new.permissions ⊆ v_old.permissions`); both deferred to SDK-008b which depends on CORE-007 (loader) + CORE-008 (Installed Plugins panel). Process for adding a new permission: PR must touch both `PLUGIN_PERMISSIONS` array and the catalog table — CI lint enforces parity. See [docs/PLUGIN_PERMISSIONS.md](docs/PLUGIN_PERMISSIONS.md).
- **Plugin runtime worker sandbox (CORE-006)** — `frontend/src/plugins/runtime/` is the host↔worker boundary. `RpcChannel` (`rpc.ts`) is transport-agnostic over `postMessage`: typed messages (`request`/`response`/`event`/`invoke-callback`/`dispose`/`log`/`ping`/`pong`), bounded queue (1024 default) with **drop-oldest backpressure** and `coalesced`/`dropped` counters, microtask-batched flush, `pin:change` coalescing by `(componentId, pinName)`, `RpcTimeoutError`/`RpcDisposedError`, and `serializeError`/`deserializeError` that preserve `.name` across the structured-clone boundary. `proxy.ts` carries `HandleTable<T>` for callback (`{__cb:id}`) and disposable (`{__disp:id}`) marshalling. `ContextStub.ts` (worker side) builds a full `PluginContext` whose calls forward via RPC; `WorkerDisposableStore` mirrors `HostDisposableStore` semantics (LIFO, late-arrival silent, fault-isolated). `PluginHost.ts` (main thread) owns one Worker + `RpcChannel` + an in-process `PluginContext` built by the existing `createPluginContext()` — `dispatch(method, args)` is a dotted-path switch that delegates every call to the existing host registries, so **the runtime is pure transport and adds zero new permission/quota logic**. Liveness ping/pong (10 s default, 2 missed → terminate). `pluginWorker.ts` boot does SHA-256 integrity verification via `crypto.subtle.digest` against the manifest's declared digest, then `import(blob:URL)` of verified bytes. `PluginManager.ts` is the singleton lifecycle entry (`load`/`unload`/`list`/`subscribe` + `WorkerFactory` for test injection); `load()` is hot-reload-aware. **Rule for runtime tests**: match `PermissionDeniedError` and friends by `.name`, never by `instanceof` — the SDK class identity does not survive `structuredClone`. APIs that need DOM (`partSimulations.attachEvents`, `panels.render`, `canvasOverlays.render`) accept calls with a one-time warn and return a no-op `Disposable`; real implementation deferred to **CORE-006b** (declarative SVG schema + opt-in Web Components, plus production CSP rollout, BENCH-AVR-04 with N plugins, pentest suite, Installed Plugins stats UI, fetch egress accounting). 23/23 runtime tests green (`plugin-runtime-rpc.test.ts` + `plugin-runtime-host.test.ts`). See [docs/PLUGIN_RUNTIME.md](docs/PLUGIN_RUNTIME.md).
- **Plugin loader + cache (CORE-007)** — `frontend/src/plugins/loader/` turns *"these plugins are installed"* into *"these workers are running"*. Four pieces: `BundleVerifier` (`computeBundleHash`/`verifyBundleHash` SHA-256 with `BundleIntegrityError`), `PluginCache` (idb-keyval, key `plugin:<id>:<version>`, GC by oldest-`cachedAt` with `keep` set so a just-loaded plugin is never evicted, `pruneVersions` for upgrades, `MemoryCacheBackend` test seam), `BundleFetcher` (`fetchBundle(id, version)` with 3-attempt full-jitter exponential backoff, retries on 5xx/408/429 only, aborts on permanent 4xx, dev-server shortcut to `localhost:5180/plugins/<id>/` when on localhost, `AbortController` per-attempt timeout, `BundleFetchError` typed), `PluginLoader` (orchestrator: `loadInstalled` runs all plugins via `Promise.allSettled` so one slow CDN doesn't block the others; per-plugin flow is cache → fetch-on-miss → verify → `cache.put` → `URL.createObjectURL(bytes)` → `manager.load` → revoke; `LoadOutcome` carries `status` ∈ {`active`/`failed`/`offline`/`disabled`}, `source` ∈ {`cache`/`cdn`/`dev`}, `cacheHit`, `fetchAttempts`, `elapsedMs`; **integrity mismatch never poisons the cache** — verify runs before put). Defense-in-depth: SHA-256 fires twice (loader + worker before `import()`). 32/32 loader tests green (`plugin-loader-{verifier,cache,fetcher}.test.ts` + `plugin-loader.test.ts`). Wiring at editor startup, license verification (CORE-009), backend installed-list endpoint (PRO-003), CDN hosting (PRO-005), and the Installed Plugins UI (CORE-008) are deferred. See [docs/PLUGIN_LOADER.md](docs/PLUGIN_LOADER.md).
- **npm publishing pipeline (CORE-005)** — root `package.json` hosts npm workspaces (`packages/*`) + `@changesets/cli`; `.changeset/config.json` is the source of truth for bump policy (changelog provider `@changesets/changelog-github`, `access:public`, `baseBranch:master`). `packages/sdk/package.json` carries the publish metadata: `publishConfig.access:public`, formal `repository`/`bugs`/`homepage`, `prepublishOnly` running lint+typecheck+test+build as a last-resort gate. `packages/sdk/scripts/smoke-test.mjs` (run via `npm run smoke:sdk` from root) packs the SDK into a tarball, installs it into a throwaway tmpdir consumer, and exercises ESM + CJS + both subpaths + TypeScript types — catches packaging bugs (missing `dist/` files, broken `exports` map) that in-repo tests miss. `.github/workflows/release.yml` triggers on push-to-master with `id-token: write` for npm provenance: lint/typecheck/test/build SDK + run smoke as gates, then `changesets/action@v1` opens (or merges) the "Version Packages" PR and on the second run does `changeset publish`. Changeset workflow: any PR touching `packages/sdk/src/**` must include `.changeset/*.md` (`npx changeset` from root). Human-gated steps (claim `@velxio` org on npm + `NPM_TOKEN` secret OR OIDC trusted publisher) tracked in **CORE-005b**.
- **Installed Plugins UI (CORE-008)** — `frontend/src/store/useInstalledPluginsStore.ts` (Zustand join layer) + `frontend/src/components/layout/InstalledPluginsModal.tsx` (pure render) + AppHeader button. The store **never owns plugin state itself** — it stitches `getPluginManager().list()` (running entries with manifest + status + error) and `useMarketplaceStore.installs/licenses` (what Pro says the user owns) into a `PluginPanelRow` set via `getRows()`. Precedence: manager entry wins on status/displayName/error (reflects runtime), marketplace wins on `enabled`, both merge their data. Six statuses (`active` / `loading` / `failed` / `unloaded` / `installed-not-loaded` / `no-license`). Three optimistic local sets (`localDisabled`, `localUninstalled`, `busyIds`) — flag-and-forget today because there's no backend op to roll back; PRO-003 wires real PATCH/DELETE later. `toggleEnabled` flips the local set + calls `manager.unload(id)` when disabling; **re-enable does NOT synchronously reload** because the store has no `bundleUrl` (the loader does — wire-up in CORE-008b). `uninstall` hides the row + unloads the worker; backend DELETE deferred. Modal sub-components in the same file (no external call sites): `<PluginRow>` with status badge + error detail + `<ReportIssueLink>` (probes `author.email` → mailto, `repository.url` → external link), `<UninstallConfirm>` gate, `<PluginSettingsDialog>` placeholder (real schema-driven form deferred to **SDK-006b** — shows `manifest` JSON in `<details>` for debugging until then), `<MarketplaceBanner>` (auth/network state hint, hidden when marketplace is `available && !authRequired`), `<EmptyState>`. AppHeader integration is a single button between Share and Auth UI; existing UI untouched. 15 store tests in `installed-plugins-store.test.ts` cover the join precedence, optimistic mutation, busy flag, and sort order. The modal is intentionally not DOM-tested (repo doesn't pull `@testing-library/react`); the store covers all logic. See [docs/INSTALLED_PLUGINS_UI.md](docs/INSTALLED_PLUGINS_UI.md).
- **License verification (CORE-009)** — `frontend/src/plugins/license/` is the offline Ed25519 verifier paid plugins must pass before the loader instantiates them. `verifyLicense(signed, opts)` is the single async entry; **it never throws on bad input** — every reject is a typed `{ ok: false; reason; detail? }` discriminated union (`malformed` / `wrong-plugin` / `wrong-user` / `wrong-version` / `expired` / `revoked` / `unknown-kid` / `bad-signature`). The chain runs cheapest-first (structural pass rejects ~99% of fuzzed inputs before any `crypto.subtle.verify` spend), with denylist before signature so a revoked token dies even when its sig is valid. Default `jtiOf(signed) = signed.sig` exploits the fact that Ed25519 sigs are unique per issuance, so no separate JTI field is needed. Default `graceMs = 24h` absorbs mildly-skewed clocks for offline-first usage. Three sub-modules carry the contract: `canonicalize.ts` (`canonicalJsonStringify` — sorted keys at every level, drops `undefined`, throws on non-finite; subset of RFC 8785 — Pro must produce the *same bytes* when signing), `semver.ts` (in-house exact/caret/tilde/wildcard with npm 0.x special-cases — `^0.2.x` lock minor, `^0.0.3` lock patch — to avoid the ~50 KB `semver` dep), `base64url.ts` (URL-safe `btoa/atob`). Key rotation: `publicKeys: ReadonlyArray<{ kid; key: CryptoKey; activeUntil? }>` — with `kid` the verifier picks the matching entry in O(1); without `kid` it tries each active key in order. `publicKey.ts` ships `ACTIVE_PUBLIC_KEYS = []` until **PRO-007** publishes the first key — fail-closed by default (verify without keys → `unknown-kid`). Loader integration shipped in **CORE-007b** (see next bullet); the verifier is intentionally pure/decoupled so the hot-path call site lives with the loader. 41/41 tests across `license-{semver,canonicalize,verify}.test.ts` (verify suite generates real Ed25519 keypairs via `crypto.subtle.generateKey`, no mocks in the crypto path). See [docs/PLUGIN_LICENSING.md](docs/PLUGIN_LICENSING.md).
- **License gate in PluginLoader (CORE-007b)** — `frontend/src/plugins/loader/LicenseResolver.ts` + a new step 0 inside `PluginLoader.loadOne` runs `verifyLicense()` *before* the cache lookup so a paid plugin without a valid license never burns CDN bandwidth, never spawns a worker, never touches IndexedDB. Decoupling is via a `LicenseResolver` interface (`getLicense` / `getUserId` / `getPublicKeys` / `getDenylist`) — the loader does not import Zustand stores directly. Two factories ship: `defaultLicenseResolver()` (production: reads `useMarketplaceStore` + `useAuthStore` + `ACTIVE_PUBLIC_KEYS`, parses `LicenseRecord.token` as JSON-encoded `SignedLicense` with defensive `try/catch` → `null`), `inMemoryLicenseResolver({ licenses, userId, publicKeys, denylist })` (tests + dev-mode mocking of paid plugins). New outcome status `'license-failed'` carries a typed `licenseReason: LoadLicenseReason = LicenseVerifyReason | 'no-license' | 'not-authenticated'` so the UI maps reason→copy without parsing prose; **`not-authenticated` is distinct from `wrong-user`** (different CTA: "sign in" vs "this license belongs to another account"). Resolution order is fail-closed at every step: (1) `pricing.model === 'free'` → bypass, (2) no resolver injected → `no-license`, (3) no token → `no-license`, (4) `userId === null` → `not-authenticated`, (5) verifier reject → forward reason. 12 new tests in `plugin-loader-license-gate.test.ts` (real Ed25519 sign/verify end-to-end, asserts `manager.load` and `fetch` were never called on reject paths). 32+12=44 loader tests green. Wiring at editor startup uses `new PluginLoader({ licenseResolver: defaultLicenseResolver() })`. Pause-on-expiry timer + per-reason copy + the `manager.pause()` primitive deferred to **CORE-008b** (subtask 4). See [docs/PLUGIN_LOADER.md](docs/PLUGIN_LOADER.md) → "License gate" section.
- **Installed Plugins UI — reload-on-enable + license CTAs + update badge + denylist refresh (CORE-008b)** — `useInstalledPluginsStore` gains `configureInstalledPlugins({ loader, latestVersionResolver })` (a one-time startup hook the editor calls right after constructing the production `PluginLoader`). Re-enabling a plugin now routes through `loader.loadOne(installed)` instead of just clearing a flag — the license gate, the SHA-256 integrity check, and the IndexedDB cache all run again, no shortcut. The store snapshots manifests off `getPluginManager().list()` on every notify tick into a module-local `manifestCache` so the reload path has the full `PluginManifest` to feed the loader (the `InstalledRecord` only carries id+version+enabled+bundleHash). Reload requires `bundleHash !== undefined` on the install record — without it the path no-ops cleanly. New row fields: `licenseReason?: LoadLicenseReason` (stamped on `license-failed`, cleared on next successful load) and `latestVersion?: string` (populated lazily by an injectable `LatestVersionResolver`). New action `refreshDenylist()` which delegates to `useMarketplaceStore.refresh()` and **swallows transport errors silently** (the modal's 24 h `setInterval` fires unattended; a flaky network must not surface as a banner). Modal: `<LicenseStatus reason={…} />` per row maps every `LoadLicenseReason` to a one-line headline + CTA via the `LICENSE_COPY` map (Buy / Sign in / Renew / Update plugin / Contact support). `<PluginUpdateBadge />` is a pill that shows when `latestVersion !== version`; `LatestVersionResolver` is a no-op factory until PRO-003 ships the marketplace catalog endpoint. 12 new store tests in `installed-plugins-store.test.ts` (27 total) — assert reload calls the loader with the right shape, license reasons stamp+clear, throwing resolvers don't break sibling rows, refreshDenylist swallows errors. Pause-on-expiry timer + `PluginManager.pause()` primitive deferred to **CORE-008c**; backend PATCH/DELETE persistence deferred to **PRO-003**. See [docs/INSTALLED_PLUGINS_UI.md](docs/INSTALLED_PLUGINS_UI.md) → "CORE-008b additions" section.
- **Marketplace discovery (CORE-010)** — `frontend/src/marketplace/` + `frontend/src/store/useMarketplaceStore.ts` is how the OSS Core detects the Pro marketplace **without coupling**. `MarketplaceClient.probe(discoveryUrl)` GETs `/.well-known/velxio-marketplace.json` (must match `schemaVersion: 1`, `apiBaseUrl` regex `^https?://`, ≤64 KB body) and **never throws** — every transport/parse failure returns a typed `MarketplaceStatus = idle | probing | available | unavailable` where `unavailable.reason ∈ { disabled | not-found | network | http-error | malformed-metadata }`. After `available`, the client knows three URLs: `/api/marketplace/me/installs` (cookie-auth, owned by PRO-003), `/api/marketplace/me/licenses` (cookie-auth, PRO-007), `/api/marketplace/license-denylist.json` (public, PRO-007). 401/403 → `MarketplaceAuthRequiredError` (UI shows "Sign in to Pro" without disabling the rest). `useMarketplaceStore.initialize()` runs probe + `Promise.allSettled` over the three data fetches and coalesces concurrent calls via `pendingInit`. Env: `VITE_VELXIO_MARKETPLACE_BASE_URL` defaults to `https://api.velxio.dev`; setting it to **literal empty string** opts the self-host out cleanly (status pinned to `unavailable/disabled`, no HTTP at all). Caps: 64 KB discovery, 4 MB data. `features.{installs|licenses|denylist}: false` in the discovery doc → caller-side throw `MarketplaceUnavailableError(disabled)` without hitting the network. 35 tests across `marketplace-{config,client,store}.test.ts`. See [docs/MARKETPLACE_DISCOVERY.md](docs/MARKETPLACE_DISCOVERY.md).
- Tests: `packages/sdk/test/*.test.ts` (205), `frontend/src/__tests__/EventBus.test.ts` (17), `frontend/src/__tests__/CompileMiddleware.test.ts` (15), `frontend/src/__tests__/spice-mapper-registry.test.ts` (18), `frontend/src/__tests__/component-registry-sdk.test.ts` (12), `frontend/src/__tests__/part-simulation-registry-sdk.test.ts` (13), `frontend/src/__tests__/plugin-host.test.ts` (26), `frontend/src/__tests__/plugin-host-sdk003.test.ts` (14), `frontend/src/__tests__/plugin-host-sdk004.test.ts` (19), `frontend/src/__tests__/plugin-host-sdk005.test.ts` (22), `frontend/src/__tests__/plugin-host-sdk006.test.ts` (20), `frontend/src/__tests__/plugin-host-sdk007.test.ts` (11), `backend/tests/test_compile_middleware.py` (15). Frontend full suite: ~1198 (4 pre-existing flaky long-running tests: EventBus 1M-emit perf budget + ILI9341 boot + Mega blink + Pong setup-wait + spice-rectifier-live RAF — all timeout-sensitive under contention). All wired into CI (`.github/workflows/sdk-tests.yml`, `frontend-tests.yml`, `backend-unit-tests.yml`).
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

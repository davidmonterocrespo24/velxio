# Integrating Circuit Emulation into Velxio

Concrete steps to take what was proven in `test/test_circuit/` and wire it into the main app.

## Recommendation

Ship **both pipelines**, controlled by a user-visible toggle:

1. **Default mode** (current behaviour): wires are visual, LEDs are boolean, `analogRead` returns whatever the last UI interaction set. No solver runs.
2. **Pure-JS electrical mode**: uses the hand-rolled MNA solver. Zero new bundle cost. Covers passive + basic non-linear. Always available.
3. **SPICE-accurate mode**: lazy-loads `eecircuit-engine` (39 MB). Full SPICE feature set. Activated by a toolbar toggle.

This gives new users zero friction, lets basic tutorials opt into passive simulation without a 39 MB download, and unlocks the full analog feature set for users who care.

## Proposed file structure

```
frontend/src/simulation/
├── AVRSimulator.ts                  (existing — no changes needed)
├── PinManager.ts                    (existing — minor hook addition)
├── CircuitSolver.ts                 ★ NEW — MNA solver (port of hand-rolled)
├── CircuitComponents.ts             ★ NEW — R, V, D, LED, etc.
├── SpiceEngine.ts                   ★ NEW — wraps eecircuit-engine (lazy)
├── SpiceEngine.lazy.ts              ★ NEW — code-split, dynamic import
├── NetlistBuilder.ts                ★ NEW — wires[] + components[] → netlist
├── CircuitStore.ts                  ★ NEW — voltages/currents overlay state
└── bridges/
    ├── AVRCircuitBridge.ts          ★ NEW — AVR ↔ hand-rolled solver
    └── AVRSpiceBridge.ts            ★ NEW — AVR ↔ ngspice
```

Almost everything is additive. The only existing files touched:

- `frontend/package.json` — add `"eecircuit-engine": "^1.7.0"` as an optional / dynamic-import dependency.
- `frontend/src/simulation/PinManager.ts` — add a `onAnyPinChange(cb)` method that fires the solver.
- `frontend/src/store/useSimulatorStore.ts` — add `electricalMode: 'off' | 'mna' | 'spice'` and `nodeVoltages: Record<string, number>`.

## Data flow

```
User edits wires/components in canvas
       │
       ▼
┌──────────────────────────────┐
│  useSimulatorStore           │
│   - components[]             │
│   - wires[]                  │
│   - electricalMode           │
└──────────────┬───────────────┘
               │   (every 50 ms if dirty, or on pin change)
               ▼
┌──────────────────────────────┐
│  NetlistBuilder.ts           │
│  (or CircuitSolver graph)    │
│   1. Union-Find on wires     │
│   2. Map metadataId → card   │
│   3. Collect AVR pin states  │
└──────────────┬───────────────┘
               ▼
        if mode === 'mna'              if mode === 'spice'
               │                              │
               ▼                              ▼
   ┌──────────────────────┐      ┌──────────────────────┐
   │ CircuitSolver.solve()│      │ SpiceEngine.run()    │
   │ (always available)   │      │ (lazy-loaded module) │
   └──────────────┬───────┘      └──────────────┬───────┘
                  │                              │
                  └──────────────┬───────────────┘
                                 ▼
                  ┌──────────────────────────────┐
                  │  nodeVoltages / currents     │
                  │  → useSimulatorStore         │
                  └──────────────┬───────────────┘
                                 ▼
                  ┌──────────────────────────────┐
                  │  Canvas voltage overlay      │
                  │  LED brightness update       │
                  │  AVR ADC channel injection   │
                  │  Warning badges              │
                  └──────────────────────────────┘
```

## Mapping `metadataId` → SPICE primitive

Exhaustive table derived from the Velxio component catalog:

| `metadataId` | SPICE card | Notes |
|---|---|---|
| `resistor` / `resistor-us` | `Rid na nb value` | value = `parseFloat(props.resistance)` |
| `capacitor` / `electrolytic-capacitor` | `Cid na nb value IC=0` | value = `parseFloat(props.capacitance)` |
| `inductor` | `Lid na nb value` | value = `parseFloat(props.inductance)` |
| `led` | `Did anode cathode LED_<color>` + `.model LED_<color> D(Is=… N=…)` | use tuned parameters from `src/components/active.js` |
| `led-5mm` / `led-3mm` | idem | |
| `diode` | `Did a c DMOD` + `.model DMOD D(Is=1e-14 N=1)` | generic Shockley |
| `zener-diode` | `.model DMOD D(Is=… BV=<zener voltage>)` | |
| `pushbutton` | `Rid na nb R` where `R = pressed ? 0.01 : 1G` | update on button press event |
| `slide-potentiometer` | Two R's with `wiperPos` | values recomputed on drag |
| `trimmer-potentiometer` | idem | |
| `ntc-temperature-sensor` | `Rid na nb R(T)` | user sets temperature in UI |
| `photoresistor` | `Rid na nb R(lux)` | user sets lux in UI |
| `dht22` | behavioral: outputs a fixed digital pulse train matching the protocol | outside solver scope, keep current code |
| `ds18b20` | behavioral: 1-Wire protocol | outside solver scope |
| `buzzer-active` | `Rid na nb 100` (to simulate current draw) | audio is outside solver |
| `buzzer-passive` | `Rid + L` model | optional |
| `servo-horn` / `servo-motor` | `R_coil na nb 50` | current draw only |
| `dc-motor` | `R_coil + L_coil` | simulated back-EMF optional |
| `relay` | Switch controlled by coil voltage | `.model SW(Vt=3 Vh=0.1 …)` |
| `7-segment` | 8 LEDs + digit pins | each segment = separate LED |
| `lcd1602` | behavioral display, NOT in solver | keep current code |
| `ssd1306` | idem | |
| `neopixel` | idem | |
| `mpu6050`, `bmp280`, etc. (I²C/SPI sensors) | NOT in solver | keep current code |
| `arduino-uno` GPIO (digital) | `Vid pin 0 DC {pinState?5:0}` | one V source per used pin |
| `arduino-uno` GPIO (PWM) | `Vid pin 0 DC {duty*5}` | quasi-static (avg DC) |
| `arduino-uno` GPIO (AC/fast PWM needed) | `PULSE(0 5 0 1u 1u {dutyTime} {period})` | use only when user asks for waveform |

### Components with NO electrical model

Keep their existing simulation path: they have state, protocols, or cyclic behaviour outside the analog solver. The netlist builder simply **omits** them and carries on. Their wires still exist visually but don't participate in the solve.

## Netlist Builder algorithm

```typescript
import { UnionFind } from './unionFind';

function buildNetlist(components, wires, avrState): string {
  // 1. Union-Find to identify nets
  const uf = new UnionFind();
  for (const w of wires) {
    const a = `${w.start.componentId}:${w.start.pinName}`;
    const b = `${w.end.componentId}:${w.end.pinName}`;
    uf.add(a); uf.add(b); uf.union(a, b);
  }

  // 2. Canonical node names — map specific pins to ground/vcc if connected
  for (const pin of collectPins(components)) {
    if (isGndPin(pin)) uf.setCanonical(pin, 'gnd');
    else if (isVccPin(pin)) uf.setCanonical(pin, 'vcc');
  }
  // All other nets get auto-named: n1, n2, ... based on a stable hash

  // 3. Emit cards
  const lines = [`Velxio circuit @${Date.now()}`];
  for (const comp of components) {
    const pins = comp.pins.map(p => uf.find(`${comp.id}:${p.name}`));
    const card = cardFor(comp, pins);
    if (card) lines.push(card);
  }

  // 4. Emit AVR pin sources
  for (const pin of avrState.outputPins) {
    const net = uf.find(`${avrState.mcuId}:${pin.name}`);
    if (!net) continue;
    if (pin.type === 'pwm') lines.push(`V_${pin.name} ${net} 0 DC ${pin.duty * 5}`);
    else lines.push(`V_${pin.name} ${net} 0 DC ${pin.high ? 5 : 0}`);
  }

  // 5. Always add a vcc/gnd source if those nets are referenced
  if (uf.has('vcc') && !hasVcc(lines)) lines.push('V_VCC vcc 0 DC 5');

  // 6. Add analysis card
  lines.push('.op');       // or .tran / .ac based on mode
  lines.push('.end');
  return lines.join('\n');
}
```

## Hooking into Velxio's existing architecture

### `useSimulatorStore` additions

```typescript
export type ElectricalMode = 'off' | 'mna' | 'spice';

export interface ElectricalState {
  mode: ElectricalMode;
  nodeVoltages: Record<string, number>;     // net name → volts
  componentCurrents: Record<string, number>; // component id → A
  converged: boolean;
  lastError: string | null;
  lastSolveMs: number;                      // performance telemetry
}

interface SimulatorStore {
  // ...existing fields...
  electrical: ElectricalState;
  setElectricalMode: (m: ElectricalMode) => void;
  runElectricalSolve: () => Promise<void>;  // triggered by the scheduler
}
```

### Solver scheduler

Use a debounced scheduler to avoid re-solving on every frame:

```typescript
const scheduleElectricalSolve = debounce(async () => {
  const { mode, components, wires } = useSimulatorStore.getState();
  if (mode === 'off') return;

  const avrState = readAvrState();
  const netlist = buildNetlist(components, wires, avrState);

  const start = performance.now();
  let result;
  try {
    if (mode === 'spice') {
      const { runNetlist } = await import('./SpiceEngine.lazy');
      result = await runNetlist(netlist);
    } else {
      result = CircuitSolver.solveFromNetlist(netlist);  // in-tree solver
    }
  } catch (e) {
    useSimulatorStore.setState((s) => ({
      electrical: { ...s.electrical, lastError: String(e), converged: false },
    }));
    return;
  }

  const voltages = extractVoltages(result);
  injectADC(avrState, voltages);
  useSimulatorStore.setState((s) => ({
    electrical: {
      ...s.electrical,
      nodeVoltages: voltages,
      converged: result.converged ?? true,
      lastError: null,
      lastSolveMs: performance.now() - start,
    },
  }));
}, 50);

// Triggers
pinManager.onAnyPinChange(scheduleElectricalSolve);
// When wires/components change:
useSimulatorStore.subscribe((s) => s.wires, scheduleElectricalSolve);
useSimulatorStore.subscribe((s) => s.components, scheduleElectricalSolve);
```

### ADC injection

After every solve, if an analog pin's net is resolved, inject it into `AVRADC.channelValues`:

```typescript
function injectADC(avr, voltages) {
  for (const pin of ['a0', 'a1', 'a2', 'a3', 'a4', 'a5']) {
    const net = findPinNet(avr, pin);
    if (!net) continue;
    const v = voltages[net];
    if (v != null) {
      const channel = parseInt(pin.slice(1), 10);
      avr.getADC().channelValues[channel] = v;
    }
  }
}
```

### UI — voltage overlay

A new React component `<CircuitVoltageOverlay />` consumes `electrical.nodeVoltages` and renders SVG text at each wire's midpoint showing the node voltage. Add a toggle in `EditorToolbar.tsx`:

```tsx
<button onClick={() => toggleElectricalOverlay()}>
  ⚡ {mode === 'off' ? 'Show voltages' : 'Hide voltages'}
</button>
```

Warning badges:

```tsx
{mode !== 'off' && !converged && <Banner>Circuit did not converge — check for floating nodes</Banner>}
{currentThroughLED > 0.025 && <LEDWarning id={led.id}>⚠ Overcurrent</LEDWarning>}
```

### LED brightness

Replace the current boolean on/off with current-based brightness:

```tsx
function LEDComponent({ id }) {
  const current = useSimulatorStore(s => s.electrical.componentCurrents[id] ?? 0);
  const brightness = Math.min(1, Math.max(0, current / 0.020));
  return <wokwi-led brightness={brightness} ... />;
}
```

Requires extending `<wokwi-led>` (or a React wrapper) to accept a float brightness. Velxio already passes booleans; the wokwi-elements SVG supports CSS-driven brightness.

## Lazy-loading `eecircuit-engine`

Create a dedicated ESM module that imports it, and reference it only via `await import()`:

```typescript
// SpiceEngine.lazy.ts
import { Simulation } from 'eecircuit-engine';

let singleton: Simulation | null = null;
export async function runNetlist(netlist: string) {
  if (!singleton) {
    singleton = new Simulation();
    await singleton.start();
  }
  singleton.setNetList(netlist);
  return singleton.runSim();
}
```

```typescript
// Elsewhere:
const { runNetlist } = await import('./SpiceEngine.lazy');
```

Vite will code-split this into a separate chunk that is only fetched when first used. The initial page load stays fast.

## Feature gating

Add a config flag:

```typescript
// src/config/features.ts
export const FEATURES = {
  electricalSimulation: import.meta.env.VITE_ELECTRICAL_SIM !== 'false',
};
```

Default enabled in production; can be turned off for minimal builds.

## Rollout plan

### Phase 1 (1–2 days)

- Port hand-rolled MNA solver into `frontend/src/simulation/CircuitSolver.ts`.
- Implement `NetlistBuilder.ts` with Union-Find on wires.
- Add `electricalMode` state and the overlay toggle.
- Ship **MNA-only** mode: passives, LED, potentiometer, NTC. Most tutorials benefit immediately.

### Phase 2 (3–5 days)

- Add `SpiceEngine.lazy.ts` behind the "SPICE-accurate" toggle.
- Implement `AVRSpiceBridge.ts`.
- Expand component mapping to MOSFETs, BJTs, diodes with real vendor models.
- Telemetry: measure `lastSolveMs` to identify slow circuits.

### Phase 3 (1–2 weeks)

- Vendor model library: LM358, 555, TL072, common MOSFETs — shipped as `.subckt` strings.
- Warning surface (overcurrent, floating nodes, no series R with LED).
- Noise analysis (`.noise`) and frequency sweep UI (Bode plotter).
- Oscilloscope "SPICE probe mode" — show real waveforms, not just digital lines.

## Testing strategy for the port

Port the 47 tests from `test/test_circuit/` into Velxio's vitest suite, adapting only the imports. The numerical expectations stay the same. This gives immediate validation that the integration didn't regress the solver.

## Risks

1. **39 MB bundle impact** — mitigated by lazy-loading behind feature flag.
2. **ngspice hangs on bad netlists** (singular matrix) — netlist builder must validate floating nodes before emitting.
3. **Stale MNA solver** — limited device support; not a replacement for ngspice, only a fallback.
4. **Performance regressions on huge circuits** — schedule debounced, offload to Web Worker if > 100 ms.
5. **Component metadata drift** — when new components are added to Velxio, the solver mapping must be updated. Consider auto-validating via a unit test: every `metadataId` must have either a mapper entry or an explicit "skip" annotation.

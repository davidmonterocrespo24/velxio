# Fase 8 — Plan de Implementación en Velxio

> **Destino**: el código Velxio (`frontend/`). El sandbox `test/test_circuit/` queda como referencia y banco de pruebas congelado.
> **Motor**: `eecircuit-engine` (ngspice-WASM real). **No** se inventa solver.
> **Meta**: Velxio emula **circuitos digitales + analógicos conviviendo**, con sketches reales de Arduino/ESP32 interactuando con componentes discretos (resistencias, capacitores, transistores, op-amps, sensores, MOSFETs) y con instrumentos de medición (voltímetro, amperímetro, multímetro, osciloscopio analógico).

---

## 0. Resumen ejecutivo

| | |
|---|---|
| **Motor de simulación eléctrica** | `eecircuit-engine@^1.7.0` (ngspice compilado a WASM, 39 MB) |
| **Estrategia de carga** | Lazy-load tras toggle "⚡ Electrical" en la toolbar |
| **Integración con MCU** | Co-simulación cuasi-estática: AVR/RP2040/ESP32 corre `N` ciclos, luego ngspice resuelve el netlist en `.op` o `.tran`; voltajes de nodos se inyectan en ADC; duty de PWM se traduce a fuente DC |
| **Componentes nuevos (primera oleada)** | ≈ 30: pasivos genéricos, transistores reales (2N2222, 2N3055, BC547, TIP120), MOSFETs (2N7000, IRF540), op-amps (LM358, LM741, TL072, LM324), reguladores (78xx, LM317), Zener (1N4733), referencias (TL431), 555, puente rectificador, etc. |
| **Instrumentos** | Voltímetro, amperímetro, multímetro DMM, probe de osciloscopio analógico (extiende el osciloscopio actual) |
| **Modo "Electrical"** | Tres niveles: `off` (comportamiento actual), `spice` (ngspice-WASM — predeterminado del modo), `mna-fallback` (solver hand-rolled del sandbox) — reservado para entornos sin WASM |
| **Plazo estimado** | 5 fases de 1–2 semanas cada una (ver §6). No bloquea el resto del roadmap: el feature flag permite merge seguro incremental |
| **Validación** | Portar los **47 tests** del sandbox al `frontend/src/__tests__/` |

---

## 1. Fuentes de verdad (leer antes de empezar)

Este plan **depende** de que el implementador haya leído:

- [`test/test_circuit/src/spice/SpiceEngine.js`](../src/spice/SpiceEngine.js) — wrapper de `eecircuit-engine`. A portar tal cual a `frontend/src/simulation/spice/`.
- [`test/test_circuit/src/spice/AVRSpiceBridge.js`](../src/spice/AVRSpiceBridge.js) — puente cuasi-estático. Es el patrón exacto.
- [`test/test_circuit/autosearch/04_ngspice_findings.md`](../autosearch/04_ngspice_findings.md) — trampas de ngspice ya identificadas (`&` vs `u()`, matriz singular, histéresis para memoria, etc.).
- [`docs/wiki/circuit-emulation-gotchas.md`](../../../docs/wiki/circuit-emulation-gotchas.md) — debugging log completo.
- [`docs/wiki/circuit-emulation-avr-bridge.md`](../../../docs/wiki/circuit-emulation-avr-bridge.md) — mapeo pin → puerto → ngspice.
- El informe de survey de Velxio (ver el mensaje previo del agente Explore): **componentes son metadata-driven** con `components-metadata.json` generado en build; los **cables son visuales** (sin nodos); la **API de pines** está en `PinManager.onPinChange / onPwmChange / onAnalogChange`.

Si alguno de estos ha cambiado sustancialmente cuando se empiece la fase 1, parar y replantear.

---

## 2. Arquitectura objetivo

### 2.1 Diagrama de alto nivel

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                               Velxio UI                                     │
│                                                                             │
│  ComponentPicker  Canvas  Toolbar       PropertyDialog  Oscilloscope        │
│       │             │        │               │              │               │
│       └─────────────┴────────┴───────────────┴──────────────┘               │
│                              │                                              │
│                              ▼                                              │
│                  ┌──────────────────────┐                                   │
│                  │  useSimulatorStore   │                                   │
│                  │   components[]       │                                   │
│                  │   wires[]            │                                   │
│                  │   electrical: {      │                                   │
│                  │     mode,            │                                   │
│                  │     nodeVoltages,    │                                   │
│                  │     componentI,      │                                   │
│                  │     probes[]         │                                   │
│                  │   }                  │                                   │
│                  └──────┬───────────────┘                                   │
│                         │ subscribe                                         │
│                         ▼                                                   │
│                  ┌──────────────────────┐                                   │
│                  │ ElectricalScheduler  │  debounce 50 ms                   │
│                  │  (singleton)         │  runs on wire / pin / prop change │
│                  └──────┬───────────────┘                                   │
│                         │                                                   │
│      ┌──────────────────┼──────────────────┐                                │
│      ▼                  ▼                  ▼                                │
│ ┌──────────┐   ┌──────────────┐   ┌──────────────┐                          │
│ │ Netlist  │   │  AVR/ESP     │   │ Instrument   │                          │
│ │ Builder  │   │  pin snapshot│   │ reader       │                          │
│ └────┬─────┘   └──────┬───────┘   └──────┬───────┘                          │
│      │                │                  │                                  │
│      └────────┬───────┴──────────────────┘                                  │
│               ▼                                                             │
│       ┌─────────────────────────┐                                           │
│       │  SpiceEngine (lazy)     │   if mode === 'spice'                     │
│       │  eecircuit-engine (WASM)│                                           │
│       │                         │   if mode === 'mna-fallback'              │
│       │  CircuitSolverJS        │   (hand-rolled, from sandbox)             │
│       └──────────┬──────────────┘                                           │
│                  │                                                          │
│                  ▼                                                          │
│     { nodeVoltages, branchCurrents, converged, errors }                     │
│                  │                                                          │
│                  └─► update store.electrical                                │
│                  └─► inject ADC voltages via PinManager.setAnalogVoltage    │
│                  └─► update LED brightness on each LED DynamicComponent     │
│                  └─► feed probes (voltmeter, ammeter, scope)                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Decisiones clave (no negociables)

| # | Decisión | Razón |
|---|---|---|
| D-1 | Usar `eecircuit-engine` SIEMPRE que `mode === 'spice'` | El sandbox validó que funciona; no inventar |
| D-2 | Lazy-load del paquete (~39 MB) detrás del toggle | No penalizar tiempo de carga inicial |
| D-3 | Scheduler con debounce 50 ms | Evitar re-solver por cada frame; user-perception: instantáneo |
| D-4 | Co-simulación cuasi-estática (slice 1–10 ms) | Cycle-accurate es imposible; el sandbox probó que 1 ms alcanza para ADC + PWM |
| D-5 | Cables siguen siendo visuales; un **NetlistBuilder** hace Union-Find al vuelo | Reutiliza el modelo de datos actual de Velxio; zero-risk |
| D-6 | PWM se representa como fuente DC de `duty·Vcc` en modo `.op` | El sandbox mostró < 100 mV de error en filtros RC con esta simplificación |
| D-7 | Componentes sin modelo eléctrico (LCD, NeoPixel, sensores I²C) se **omiten** del netlist | Siguen funcionando con su lógica actual |
| D-8 | Instrumentos (voltímetro, amperímetro) son componentes Velxio normales con flag `isProbe=true` | NO se estampan en el netlist — son lectores de resultados |
| D-9 | Modo por defecto: `off`. Activar con toggle explícito | Usuarios que no necesitan analógico no ven diferencia |
| D-10 | Cada board Velxio (Uno, Mega, ESP32, RP2040) expone sus pines como nets nombrados `boardid_pin<N>` | Evita colisiones entre múltiples boards |

---

## 3. Estructura de archivos nuevos / modificados en `frontend/`

### 3.1 Archivos nuevos

```
frontend/src/simulation/spice/
├── SpiceEngine.ts                  ★ wrapper de eecircuit-engine (port del sandbox)
├── SpiceEngine.lazy.ts             ★ dynamic-import wrapper, singleton
├── NetlistBuilder.ts               ★ wires[] + components[] → netlist string
├── NetlistBuilder.unionFind.ts     ★ auxiliar
├── componentToSpice.ts             ★ tabla metadataId → spice card
├── subcircuits.ts                  ★ .subckt de op-amps, 555, etc.
├── CircuitScheduler.ts             ★ debouncer, orchestrator
├── AVRSpiceBridge.ts               ★ co-sim AVR ↔ ngspice (port del sandbox)
├── RP2040SpiceBridge.ts            ★ análogo para RP2040
├── ESP32SpiceBridge.ts             ★ análogo para ESP32 (según disponibilidad de ADC)
└── CircuitSolverJS.ts              ★ port del solver hand-rolled como fallback

frontend/src/simulation/spice/__tests__/
├── netlistBuilder.test.ts
├── componentToSpice.test.ts
├── avr-ntc-readback.test.ts        ← port directo del sandbox
├── avr-pwm-rc.test.ts              ← port
├── avr-pot-cosim.test.ts           ← port
└── (… el resto de los 47 del sandbox …)

frontend/src/components/components-analog/
├── GenericResistor.tsx             ★ cualquier valor en Ω
├── GenericCapacitor.tsx            ★ cualquier valor en F, con polaridad opcional
├── GenericInductor.tsx             ★
├── GenericDiode.tsx                ★ modelo genérico, dropdown de partes 1N4148/1N4007/1N5819
├── ZenerDiode.tsx                  ★ dropdown 1N4733/1N4742/etc. o voltaje custom
├── BJTTransistor.tsx               ★ NPN/PNP + part number (2N2222/2N3055/BC547/BC557/TIP120)
├── MOSFETTransistor.tsx            ★ N/P + parte (IRF540/IRF9540/2N7000/BS170)
├── OpAmp.tsx                       ★ LM358/LM741/TL072/LM324 (package-pin-aware)
├── VoltageRegulator.tsx            ★ 7805/7812/LM317 + externals
├── Timer555.tsx                    ★ chip NE555 en DIP-8
├── BridgeRectifier.tsx             ★ puente de 4 diodos
└── GenericSwitch.tsx               ★ SPST / SPDT / DPDT

frontend/src/components/components-instruments/
├── Voltmeter.tsx                   ★ DC: lee V(node+) − V(node−); probe de 2 terminales
├── Ammeter.tsx                     ★ DC: inserta 0.001 Ω en serie y lee i(Vsense)
├── Multimeter.tsx                  ★ DMM: V/I/R/diode/continuity
├── OscilloscopeAnalogProbe.tsx     ★ señala un nodo ngspice como canal del scope
└── SignalGenerator.tsx             ★ fuente V controlada desde UI (sin, pulse, pwl)

frontend/src/components/analog-ui/
├── ComponentValueEditor.tsx        ★ input con unidades (k, M, u, n, p)
├── ElectricalOverlay.tsx           ★ SVG overlay: V de cada nodo, I de cada cable
├── ElectricalModeToggle.tsx        ★ toolbar button ⚡
├── SpiceErrorBanner.tsx            ★ banner de no-convergencia
└── MeasurementPanel.tsx            ★ lateral con todas las lecturas de probes

frontend/scripts/
└── generate-analog-metadata.ts     ★ genera components-metadata.json para analog/instruments
```

### 3.2 Archivos modificados

| Archivo | Cambio |
|---|---|
| `frontend/package.json` | + `"eecircuit-engine": "^1.7.0"` (como `dependencies`, marca de side-effect false para tree-shaking) |
| `frontend/src/store/useSimulatorStore.ts` | + estado `electrical`, + acciones `runElectricalSolve`, `setElectricalMode`, `addProbe` |
| `frontend/src/simulation/PinManager.ts` | + método `onAnyPinChange(cb)` — fires cuando cualquier pin (cualquier board) cambia; fires también en PWM update |
| `frontend/src/simulation/AVRSimulator.ts` | + invocar `PinManager.notifyAnyPinChange()` dentro del callback existente |
| `frontend/src/components/editor/EditorToolbar.tsx` | + botón `<ElectricalModeToggle />` |
| `frontend/src/components/simulator/SimulatorCanvas.tsx` | + `<ElectricalOverlay />` encima del WireLayer; + render de instrumentos |
| `frontend/src/components/DynamicComponent.tsx` | + leer `brightness` real de electrical.componentCurrents para LEDs |
| `frontend/src/components/ComponentPickerModal.tsx` | + nuevas categorías `analog-passive`, `analog-active`, `instruments` |
| `frontend/vite.config.ts` | si hace falta, marcar `eecircuit-engine` como `optimizeDeps.exclude` para que no bloquee dev server |
| `frontend/components-metadata.json` | regenerado — ahora incluye los ~30 nuevos analog components + 5 instrumentos |

---

## 4. Catálogo de componentes (primera oleada)

### 4.1 Pasivos genéricos

| Velxio `metadataId` | Tag web component | Propiedades | Netlist ngspice |
|---|---|---|---|
| `analog-resistor` | `<wokwi-resistor>` (existente) | `value` (Ω), `tolerance` (%) | `R{id} {net1} {net2} {value}` |
| `analog-capacitor` | `<wokwi-capacitor>` o propio | `value` (F), `polarized` (bool), `voltage` (max V) | `C{id} {net+} {net-} {value} IC=0` |
| `analog-electrolytic` | nuevo SVG | igual, siempre polarized=true | idem |
| `analog-inductor` | nuevo SVG | `value` (H), `dcr` (Ω) | `L{id} {n1} {n2} {value}` + `R_{id}_dcr` en serie si `dcr > 0` |
| `analog-potentiometer-generic` | extiende `Potentiometer.tsx` existente | `value` (Ω total), `curve` ("linear"\|"log"), `wiperPos` | dos resistores en serie |
| `analog-trimmer` | SVG nuevo | igual; UI distinta (tornillo chico) | idem |

**Input de valor con prefijos SI** — `ComponentValueEditor.tsx`:

```
"4.7k"   → 4700
"220"    → 220
"1Meg"   → 1_000_000
"10u"    → 0.00001  (capacitor)
"100n"   → 1e-7
"0.1u"   → 1e-7     (alias)
"22p"    → 2.2e-11
"10mH"   → 0.01     (inductor)
"1.5H"   → 1.5
```

Usar la misma sintaxis SPICE (`k`, `Meg`, `u`, `n`, `p`, `m`, `f`, `G`, `T`) para que el usuario aprenda de una vez.

### 4.2 Semiconductores discretos (reales, con part number)

| `metadataId` | Parte | SPICE model card |
|---|---|---|
| `diode-1n4148` | 1N4148 small-signal | `.model D1N4148 D(Is=2.52n N=1.752 Rs=0.568 Ibv=0.1u Bv=100 Cjo=4p M=0.333 Vj=0.5)` |
| `diode-1n4007` | 1N4007 rectifier | `.model D1N4007 D(Is=76.9n N=1.45 Rs=0.0342 Ikf=2.34 Bv=1000 Ibv=5u)` |
| `diode-1n5819` | Schottky | `.model D1N5819 D(Is=31u N=1 Rs=0.043 Bv=40 Ibv=10m Cjo=110p)` |
| `zener-1n4733` | 5.1 V zener | `.model D1N4733 D(Is=1n N=1 Rs=5 Bv=5.1 Ibv=50m)` |
| `zener-1n4742` | 12 V zener | `.model D1N4742 D(Is=1n N=1 Rs=6 Bv=12 Ibv=20m)` |
| `bjt-2n2222` | NPN general purpose | `.model Q2N2222 NPN(Is=14.34f Xti=3 Eg=1.11 Vaf=74.03 Bf=200 Ne=1.307 Ise=14.34f Ikf=0.2847 Xtb=1.5 Br=6.092 Nc=2 Isc=0 Ikr=0 Rc=1 Cjc=7.306p Mjc=0.3416 Vjc=0.75 Fc=0.5 Cje=22.01p Mje=0.377 Vje=0.75 Tr=46.91n Tf=411.1p Itf=0.6 Vtf=1.7 Xtf=3 Rb=10)` (estándar Motorola) |
| `bjt-2n3055` | NPN power | modelo Motorola estándar (`Bf=70`, `Icmax=15 A`) |
| `bjt-bc547` | NPN small-signal Europa | `.model QBC547B NPN(Is=7.049f Bf=378.6 Ikf=0.1393 Vaf=85 Br=7.202 Ne=1.25 Ise=92.22p Ikr=0.3 Rc=1.32 Cjc=6.033p Cje=8.063p Tf=575.8p Tr=1.0u Mje=0.3 Mjc=0.3 Vje=0.69 Vjc=0.69 Rb=10)` |
| `bjt-bc557` | PNP | `.model QBC557B PNP(…)` |
| `bjt-tip120` | NPN Darlington power | `.model QTIP120 NPN(Bf=1000 …)` |
| `mosfet-2n7000` | N-ch small-signal | `.model M2N7000 NMOS(Level=3 Vto=1.6 Kp=0.1 L=2u W=0.1 Rd=1 Rs=0.5)` |
| `mosfet-bs170` | N-ch TO-92 | similar |
| `mosfet-irf540` | N-ch power | `.model MIRF540 NMOS(Level=3 Vto=3.0 Kp=20 L=2u W=1 Rd=0.044 Rs=0)` |
| `mosfet-irf9540` | P-ch power | `.model MIRF9540 PMOS(Level=3 Vto=-3 Kp=15 …)` |

> **Fuente de los parámetros**: se copiarán de las librerías SPICE estándar distribuidas con LTspice/Orcad (dominio público por práctica de la industria, los fabricantes los publican). Los modelos viven en `subcircuits.ts` como strings constantes. Un test (`modelCompiles.test.ts`) verifica que cada `.model` line se parsee sin errores.

### 4.3 Integrados analógicos (subcircuitos)

| `metadataId` | Parte | Implementación |
|---|---|---|
| `opamp-lm358` | LM358 (dual, single-supply) | `.subckt LM358 inv non_inv VEE OUT VCC` — macromodelo con slew-rate, GBW=1MHz, CMRR, etc. |
| `opamp-lm741` | LM741 single | `.subckt LM741 …` |
| `opamp-tl072` | TL072 JFET-input | `.subckt TL072 …` |
| `opamp-lm324` | LM324 quad | `.subckt LM324 …` |
| `reg-7805` | LM7805 +5V regulator | `.subckt LM7805 Vin Vout GND` |
| `reg-7812` | LM7812 +12V | `.subckt LM7812 Vin Vout GND` |
| `reg-lm317` | Adjustable | `.subckt LM317 Vin Vout ADJ` |
| `ref-tl431` | 2.5V shunt reference | `.subckt TL431 cathode anode ref` |
| `timer-555` | NE555 bipolar | `.subckt NE555 GND TRIG OUT RESET CTRL THR DIS VCC` |
| `bridge-rect` | DF04 bridge rectifier | 4× `D1N4007` estampados juntos |

**Fuente de los `.subckt`**: igualmente dominio público; los que existen en manuales de fabricante (TI, ON Semi, Fairchild) y se distribuyen con spice libraries. Commitear en `frontend/src/simulation/spice/subcircuits/*.cir` y cargar con `import.meta.glob` o similar al primer uso.

### 4.4 Sensores y entradas

Ya existen como componentes Velxio (`Potentiometer`, `NTCThermistor`, `Photoresistor`, `Pushbutton`). Se añade una **capa de emisión SPICE** sin cambiar el wokwi-element:

| Existente | Emisión SPICE |
|---|---|
| `ntc-temperature-sensor` | `R{id} {net1} {net2} {R(T)}` calculado desde `temperature` slider |
| `photoresistor` | `R{id} {net1} {net2} {R(lux)}` |
| `pushbutton` | `R{id} {net1} {net2} {pressed ? 0.01 : 1G}` |
| `slide-switch` | `R` con valor según posición |
| `rotary-encoder` | pines digitales, sin estampa (fuera del solver) |

### 4.5 Instrumentos (componentes "probe", no se estampan)

| `metadataId` | Función | Cómo lee |
|---|---|---|
| `instr-voltmeter-dc` | Mide V entre dos terminales | `result.nodeVoltage(net+) − result.nodeVoltage(net−)` |
| `instr-ammeter-dc` | Mide I en serie con un cable | Inserta `V{id}_sense 0V` en serie; lee `i(V{id}_sense)` |
| `instr-multimeter` | V / I / R / Diode / Continuity | V y I igual que arriba. Para R: inyecta 1 mA de prueba y lee ΔV |
| `instr-scope-probe` | Agrega el nodo como canal del osciloscopio (modo analógico) | Durante `.tran`, samplea `v(node)` y lo publica al `useOscilloscopeStore` |
| `instr-signal-generator` | Fuente de señal editable (sin, pulse, pwl) | Estampa una `V{id}` con la forma de onda configurada |

**Amperímetro — detalle de implementación crítica**: ngspice no puede medir corriente en un cable arbitrario directamente. Hay que **intercalar una fuente de voltaje 0 V** en el cable:

```
; en vez de: R1 a b 1k
;              cable a → ammeter → R1 → cable b

V_amm_X pre_r1 a 0       ; inserta V 0V para medir i
R1 pre_r1 b 1k

; y leemos: i(V_amm_X)
```

El NetlistBuilder detecta cuando un cable pasa por un amperímetro y corta la net para insertar la fuente.

---

## 5. Algoritmo del NetlistBuilder

Toma `{ components, wires, boards, pinStates }` y produce un netlist string para ngspice.

```typescript
function buildNetlist(ctx: {
  components: Component[];
  wires: Wire[];
  boards: BoardInstance[];
  pinStates: Record<string, { v: 0 | 5 } | { duty: number }>;
  probes: Probe[];
  analysis: 'op' | 'tran' | 'ac';
  tranStep?: number;
  tranStop?: number;
}): string {
  // 1. Build Union-Find of (componentId, pinName) pairs from wires.
  const uf = new UnionFind<string>();
  for (const w of ctx.wires) {
    const a = `${w.start.componentId}:${w.start.pinName}`;
    const b = `${w.end.componentId}:${w.end.pinName}`;
    uf.add(a); uf.add(b);
    uf.union(a, b);
  }

  // 2. Canonicalize known special nets: any pin labeled GND / VSS / VEE → 'gnd' (= '0' in spice)
  //    VCC / VDD / 5V / 3V3 → 'vcc_<voltage>'
  for (const comp of ctx.components) {
    for (const pin of pinsOf(comp)) {
      const key = `${comp.id}:${pin.name}`;
      if (isGroundPin(pin)) uf.setCanonical(key, '0');
      else if (isVccPin(pin)) uf.setCanonical(key, 'vcc_rail');
    }
  }
  for (const board of ctx.boards) {
    for (const pin of boardGndPins(board)) uf.setCanonical(`${board.id}:${pin}`, '0');
    for (const pin of boardVccPins(board)) uf.setCanonical(`${board.id}:${pin}`, 'vcc_rail');
  }

  // 3. Allocate auto-names for every other net. Use stable hashing so netlists are diffable.
  const netNames = assignNetNames(uf);  // net0, net1, ... deterministic

  // 4. Detect floating nodes: nets with only reactive connections (C, L).
  //    Add an auto-pull to 0 with 100 MΩ to prevent ngspice singular-matrix hang.
  const floatingNets = detectFloatingNets(ctx.components, netNames);

  // 5. Emit cards
  const lines = [`Velxio circuit @ ${new Date().toISOString()}`];
  const uses: Set<string> = new Set();  // which .model / .subckt we need

  for (const comp of ctx.components) {
    if (isInstrument(comp)) continue;                  // probes don't stamp
    const card = componentToSpice(comp, netNames, uses);
    if (card) lines.push(card);
  }

  // 6. Ammeters: rewrite — for every ammeter, insert V<id>_sense 0 V between its terminals
  //    and re-point connected components accordingly. (Handled inside componentToSpice.)

  // 7. Add board GPIO sources
  for (const board of ctx.boards) {
    for (const [pinName, state] of Object.entries(ctx.pinStates[board.id] ?? {})) {
      const net = netNames.get(`${board.id}:${pinName}`);
      if (!net) continue;
      const v = 'duty' in state ? state.duty * board.vcc : state.v;
      lines.push(`V_${board.id}_${pinName} ${net} 0 DC ${v}`);
    }
  }

  // 8. Vcc rail source
  if (uf.has('vcc_rail')) lines.push(`V_VCC vcc_rail 0 DC ${dominantBoardVcc(ctx.boards)}`);

  // 9. Auto-pull-downs on floating nets
  for (const net of floatingNets) lines.push(`R_autopull_${net} ${net} 0 100Meg`);

  // 10. Models and subcircuits
  for (const m of uses) lines.push(...modelOrSubcktText(m));

  // 11. Analysis
  if (ctx.analysis === 'op') lines.push('.op');
  else if (ctx.analysis === 'tran') lines.push(`.tran ${ctx.tranStep} ${ctx.tranStop}`);
  else if (ctx.analysis === 'ac') lines.push('.ac dec 20 1 1Meg');

  lines.push('.end');
  return lines.join('\n');
}
```

### 5.1 Detección de nodos flotantes

**Regla práctica del sandbox** (gotcha G-8): cualquier nodo que sólo se conecte a capacitores/inductores y/o diodos/transistores sin camino DC a 0 hará que ngspice se cuelgue 60 s en recovery. La solución barata es añadir `R 100 MΩ` a ground en cada uno.

Algoritmo: para cada net, itera sus conexiones; si hay al menos una `R` finita en el mismo camino UF hacia `0`, es seguro. Si no, etiquétalo como flotante y añade el pull-down. Implementación O(V+E) con BFS.

### 5.2 Cache del netlist

Si `components` y `wires` no han cambiado desde la última invocación, reutiliza el string anterior y sólo sustituye los valores de las fuentes (pin states). Evita 10–30 ms de re-construcción de string en cada solve.

---

## 6. Fases de entrega

### Fase 8.1 — Fundamentos (1 semana)

**Goal**: `eecircuit-engine` funcionando en el proyecto de Velxio, sin UI. Tests pasan en `frontend/src/__tests__/`.

**Entregables**:
- `npm install eecircuit-engine` + marca de lazy-load en Vite.
- Port de `SpiceEngine.ts` y `SpiceEngine.lazy.ts` (copia fiel del sandbox con tipos TS).
- Smoke test: `frontend/src/__tests__/spice-smoke.test.ts` ejecuta un divisor de voltaje y verifica `v(out) = 6`.
- Port de los 22 tests `spice_*.test.js` del sandbox.
- Telemetría: logs `[SpiceEngine] boot in Xms` y `[SpiceEngine] solve in Xms`.

**DoD (Definition of Done)**:
- `npm test` en `frontend/` pasa los 22 tests.
- Bundle de dev (`npm run dev`) funciona sin errores de ESM/WASM.
- Bundle de prod (`npm run build:docker`) no crece (el lazy chunk es separado).

### Fase 8.2 — Netlist Builder + mapeo de componentes existentes (1 semana)

**Goal**: NetlistBuilder puede tomar un escenario de Velxio (con R, LED, pot, NTC) y emitir un netlist válido. No hay UI todavía.

**Entregables**:
- `NetlistBuilder.ts` con algoritmo de §5, UnionFind.
- `componentToSpice.ts` — soporta los 4 pasivos de Velxio hoy: `resistor`, `led`, `capacitor`, `potentiometer`, + NTC, photoresistor, pushbutton.
- Tests: `netlistBuilder.test.ts` con 10+ escenarios (divisor, RC charging, LED+R, pot+ADC).
- Integración con `useSimulatorStore`: acción `runElectricalSolve` (no-op si `mode === 'off'`).

**DoD**:
- Creamos un escenario programáticamente (no por UI), llamamos `runElectricalSolve`, verificamos que `store.electrical.nodeVoltages` tiene los valores correctos.
- Port de los tests end-to-end del sandbox: `e2e_pot_pwm_led` y `e2e_thermistor` funcionan dentro de Velxio.

### Fase 8.3 — UI: toggle y overlay de voltajes (1 semana)

**Goal**: usuario puede activar modo eléctrico y ver voltajes en el canvas.

**Entregables**:
- `ElectricalModeToggle.tsx` en toolbar (icono ⚡).
- `ElectricalOverlay.tsx` — SVG overlay que etiqueta cada nodo con `V(n) ≈ 2.50 V`.
- `SpiceErrorBanner.tsx` — si `!converged`, muestra banner con mensaje de ngspice (`getError()`).
- `LED.tsx` — usar `brightness = electrical.componentCurrents[id] / 0.020` en lugar del bool actual.
- Scheduler con debounce 50 ms.
- Hook en `PinManager.onAnyPinChange` → solve.

**DoD**:
- Activar toggle con un sketch "Blink" cargado → pin 13 alterna → LED se enciende con brillo calculado real.
- Activar toggle con circuito NTC → `analogRead(A0)` refleja el voltaje real del divisor.
- Probar con 5+ circuitos típicos del tutorial Velxio; todos convergen.

### Fase 8.4 — Nuevos componentes analógicos (2 semanas)

**Goal**: las 30 piezas nuevas del §4 aparecen en el ComponentPicker, se pueden arrastrar al canvas, tienen editor de valores.

**Entregables**:
- Todos los React wrappers en `components-analog/` (15+ componentes con SVG, properties, pinInfo).
- Metadata regenerada (`generate-analog-metadata.ts`) y agregada a `components-metadata.json`.
- `ComponentValueEditor.tsx` con parser SI (`k`, `Meg`, `u`, `n`, `p`).
- `componentToSpice.ts` expandido con todos los part numbers + `.subckt` para IC.
- Biblioteca `subcircuits/` con los macromodelos (LM358, LM741, 555, 7805, LM317, TL431).
- Tests: un test por parte (`bjt-2n3055`, `opamp-lm358` Schmitt trigger, `timer-555` astable real, etc.).

**DoD**:
- Usuario puede construir un amplificador con LM358, medir la ganancia y coincide con cálculo manual.
- Usuario puede construir un 555 astable, verificar la frecuencia con osciloscopio.
- Usuario puede construir un regulador 7805 con capacitores y ver la salida estabilizada.
- Todos los nuevos componentes aparecen en el picker bajo `analog-passive` / `analog-active`.

### Fase 8.5 — Instrumentos de medición (1 semana)

**Goal**: voltímetro, amperímetro, multímetro, signal generator, osciloscopio analógico.

**Entregables**:
- `Voltmeter.tsx` — 2 terminales; display con unidades (mV/V/kV según magnitud).
- `Ammeter.tsx` — inserta V sense en el cable; display con unidades (nA/µA/mA/A).
- `Multimeter.tsx` — dial con modos V/I/R/Continuity/Diode.
- `OscilloscopeAnalogProbe.tsx` — clip que se conecta a un nodo; extiende `useOscilloscopeStore` con canales analógicos.
- Modificación de `Oscilloscope.tsx`: renderiza waveforms analógicos además de digitales. Usa `.tran` de ngspice para samplear.
- `SignalGenerator.tsx` — UI con selector de forma de onda (DC/sine/square/triangle/PWL), amplitud, frecuencia, offset.
- `MeasurementPanel.tsx` — panel lateral con tabla de todas las lecturas.

**DoD**:
- Usuario pone voltímetro en un divisor → lee `3.33 V`, refresca al mover slider.
- Usuario pone amperímetro en serie con un LED → lee `~13 mA`.
- Usuario conecta signal generator (1 kHz sine, 1 Vpp) a filtro RC, probe del osciloscopio en la salida → ve Bode manual (atenuación visible al 10 kHz).

### Fase 8.6 — Validación + rollout (1–2 semanas)

**Goal**: release behind feature flag, telemetría, docs de usuario.

**Entregables**:
- Feature flag: `VITE_ELECTRICAL_SIM=true` (prod), `false` (si bugs).
- Docs de usuario: `docs/wiki/electrical-simulation-user-guide.md`.
- Telemetría: opt-in, envía `solve_ms`, `component_count`, `converged` a un endpoint interno.
- Tests de regresión: ningún sketch del examples gallery debe romperse.
- Checklist de QA (en el PR final):
  - [ ] LED blink con nueva simulación eléctrica → brillo correcto
  - [ ] Pot + ADC → monotónico
  - [ ] NTC + ADC → temperatura recuperable
  - [ ] 555 astable → frecuencia correcta ±10 %
  - [ ] Op-amp inverter → ganancia −10
  - [ ] MOSFET switch → V_drain conmuta
  - [ ] Voltímetro / amperímetro → lecturas coinciden con cálculo manual
  - [ ] Toggle on/off → performance acceptable (< 100 ms solve)
  - [ ] Bundle size production → lazy chunk no bloquea initial load
  - [ ] 0 regresiones en examples gallery

**DoD**:
- PR merged a `master`.
- Blog post / release notes.
- Roadmap actualizado.

---

## 7. Mapeo de boards (múltiples MCUs conviviendo)

El survey reveló que Velxio tiene `boards[]`: múltiples Arduinos, RP2040, ESP32 en el mismo canvas. El NetlistBuilder debe manejar esto:

- Cada board **declara sus propios nets** con prefijo `{boardId}_{pinName}`. Ej: `uno1_d13`, `esp32a_gpio5`.
- El **VCC rail no se comparte automáticamente** entre boards (pueden alimentarse a 5 V y 3.3 V).
- Un cable entre `uno1:5V` y `esp32a:5V` los une en la misma net vía Union-Find.
- Un cable entre `uno1:D2` y `esp32a:GPIO5` es legal (y común para buses UART/I²C). Ambos lados se modelan como `V<source>` pero sólo uno puede ser "driver" en un instante dado. En caso de conflicto (ambos OUTPUT diferente valor) → banner rojo "bus conflict" y ngspice resolverá con el promedio via GMIN.

### 7.1 RP2040 — ADC y PWM

- RP2040 tiene 3 canales ADC (GP26, GP27, GP28) + sensor de temperatura interno (GP4 hidden).
- `RP2040SpiceBridge.ts` es prácticamente igual al de AVR, con:
  - Tensión de referencia 3.3 V
  - 12-bit ADC en lugar de 10
  - PWM: hasta 16 canales, cualquier pin; leer duty via `rp2040.getPWMDuty(pin)` (ya existe en `RP2040Simulator.ts`).

### 7.2 ESP32 — limitaciones

- ESP32 ADC es notoriamente no-lineal; el modelo SPICE de su ADC necesita una curva de corrección. MVP: lineal 0–3.3 V, 12-bit.
- PWM ("LEDC") con 16 canales, resolución configurable hasta 20 bits. Leer duty via `esp32.getPWMDuty(channel)` (disponible en el emulador QEMU).

---

## 8. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| **Bundle +39 MB** | Usuarios en red lenta se frustran | Lazy-load detrás de toggle. Chunk separado. Cache agresivo. Primer click del toggle: splash "Downloading simulator (39 MB)…" |
| **ngspice cuelga 60 s por matriz singular** | Freeze de UI | Validación pre-solve: detectar nodos flotantes con BFS; añadir pull-down 100 MΩ automáticamente. Logs claros si ocurre. Timeout 3 s con abort. |
| **Co-sim > 100 ms por slice con circuitos grandes** | Lag visible | 1) debounce 50 ms en scheduler, 2) mover a Web Worker si > 20 componentes, 3) modo "DC only" por defecto, 4) UI indicador "computing…" si > 200 ms |
| **Conflicto entre Velxio pin simulado y SPICE** | Resultados incorrectos | SPICE es la fuente de verdad para tensiones analógicas. Las mutaciones manuales vía UI (click en LED) se convierten en modo "sim off". |
| **Modelos SPICE de terceros con licencia unclear** | Bloqueo legal | Usar sólo modelos **publicados por fabricantes** (TI, ON, Microchip) y distribuir como strings en el source bajo cláusula de fair use educativa. Documentar origen por cada `.subckt` en un comentario. |
| **PWM cuasi-estático incorrecto para circuitos sensibles a ripple** | Mala UX en audio / switching power | Detectar: si hay capacitor < 1 µF en el camino del PWM → escalar automáticamente a modo `.tran` con edges reales y aviso "switching detail enabled, may be slower" |
| **Regresión del emulador digital** | Tests existentes fallan | Toggle off es zero-risk (nada cambia en el solver). Tests de regresión de `frontend/src/__tests__/` deben seguir pasando con `VITE_ELECTRICAL_SIM=false`. |
| **Modelos BJT/MOSFET no convergen en esquemas exotic** | Usuario frustrado | Modo "Beginner": modelos ideales (VCVS para op-amp, switch para transistor). Modo "Expert": modelos reales con `.model`. Toggle en opciones. |

---

## 9. Criterios de éxito / métricas

**Cuantitativos**:

| Métrica | Objetivo |
|---|---|
| Tests de portabilidad desde sandbox | **47/47 pasando** en `frontend/` |
| Tiempo de boot de ngspice (primera vez) | < 800 ms en laptop estándar |
| Tiempo de solve para circuito típico (20 componentes) | < 50 ms |
| Tamaño del chunk lazy | ≤ 45 MB comprimido |
| Precisión en tests E2E vs analítico | < 2 % error |
| Zero regresiones en modo off | 100 % de tests previos pasan |

**Cualitativos**:

- Un usuario con conocimiento de electrónica básica puede armar un amplificador BJT y ver la ganancia correcta en el osciloscopio.
- Un usuario puede armar un 555 astable y medir la frecuencia con un probe.
- Un usuario puede conectar un termistor a un Arduino y leer la temperatura real convertida desde ADC.
- Un tutorial de "control de brillo de LED con potenciómetro" funciona end-to-end sin intervención manual.

---

## 10. Fuera de alcance (futuras fases)

Se documentan aquí para que no se cuelen en esta fase por scope creep.

- **Análisis `.noise`** — ruido Johnson/shot/flicker. ngspice lo soporta; lo dejamos para cuando haya UI de audio.
- **Análisis Monte Carlo de tolerancias** — simular 100 copias con ±5 % en resistencias.
- **Temperatura ambiente global** — afecta parámetros de todos los componentes.
- **Análisis `.pz`** (pole-zero) — diseño de filtros avanzados.
- **Análisis S-parameter** — RF.
- **Emulación de ICs digitales discretos** (74HC00, 74HC595, 4017) con timing real. Actualmente se podrían hacer con B-sources, pero se dejará para fase 9.
- **Transformadores acoplados** (ngspice `K`) — para SMPS.
- **Modelos térmicos** — acoplar disipación de potencia con perfil térmico.
- **Biblioteca de "circuitos ejemplo"** — pre-cargados en el picker (Darlington, diff-amp, current mirror, etc.).

---

## 11. Apéndices

### 11.1 Ejemplo concreto de netlist generado

Escenario: Arduino Uno con sketch que hace `analogWrite(9, 127)`, conectado a una red RC (10 kΩ + 1 µF) y un voltímetro en la salida.

```
Velxio circuit @ 2026-04-15T12:00:00Z
* Board pin sources
V_uno1_d9 uno1_d9 0 DC 2.5        ; duty=0.5 × 5V
* Components
R_r1 uno1_d9 net0 10k              ; R1 from D9 to intermediate net
C_c1 net0 0 1u IC=0                ; C1 from intermediate to ground
* Auto-pull (net0 has cap-to-ground, so it has a DC path via V_uno1_d9 → R_r1)
* Vcc rail
V_VCC vcc_rail 0 DC 5
* Analysis
.op
.end
```

Tras `runSim`: `v(net0) ≈ 2.5 V`. El voltímetro (que conoce sus 2 terminales = `net0` y `0`) muestra `2.50 V`.

### 11.2 Ejemplo con transistor

Escenario: 2N2222 en common-emitter, señal de entrada 10 mV AC a 1 kHz desde un signal generator, R_C=4.7k, R_E=1k bypasseado con 100 µF, osciloscopio en colector.

```
Velxio amplifier
V_VCC vcc_rail 0 DC 12
V_sg1 sg1_out 0 SIN(0 0.01 1k)
C_cin sg1_out net_base 1u
R_rb1 vcc_rail net_base 47k
R_rb2 net_base 0 10k
R_rc vcc_rail net_coll 4.7k
R_re net_em 0 1k
C_ce net_em 0 100u
Q_q1 net_coll net_base net_em Q2N2222
.model Q2N2222 NPN(Is=14.34f Bf=200 Vaf=74.03 …)
C_cout net_coll scope_probe1 1u
R_scope_input scope_probe1 0 1Meg       ; high-Z scope input (1 MΩ)
.tran 10u 6m
.end
```

El osciloscopio samplea `v(scope_probe1)`; muestra la onda invertida y amplificada.

### 11.3 Tabla de conversión wokwi-elements existentes → SPICE

Extensión del mapeo del §4; fuente: survey de Velxio.

| wokwi tagName | `metadataId` actual | Emite SPICE | Notas |
|---|---|---|---|
| `<wokwi-resistor>` | `resistor` | **sí** | R lineal |
| `<wokwi-resistor-us>` | `resistor-us` | **sí** | idem |
| `<wokwi-led>` | `led` | **sí** | D con Is/n por color |
| `<wokwi-rgb-led>` | `rgb-led` | parcialmente | 3 LEDs independientes |
| `<wokwi-pushbutton>` | `pushbutton` | **sí** | R conmutable |
| `<wokwi-slide-switch>` | `slide-switch` | **sí** | |
| `<wokwi-potentiometer>` | `slide-potentiometer` | **sí** | dos R |
| `<wokwi-photoresistor>` | `photoresistor` | **sí** | R(lux) |
| `<wokwi-ntc-temperature-sensor>` | `ntc-temperature-sensor` | **sí** | R(T) |
| `<wokwi-7segment>` | `7-segment` | **sí** | 8 LEDs |
| `<wokwi-buzzer>` | `buzzer` | como R de 100 Ω | sonido fuera del solver |
| `<wokwi-servo>` | `servo-horn` | R=50 Ω consumo | ángulo fuera del solver |
| `<wokwi-dc-motor>` | `dc-motor` | R + L serie | back-EMF opcional |
| `<wokwi-dht22>` | `dht22` | **no** | protocolo 1-wire, fuera |
| `<wokwi-lcd1602>` | `lcd1602` | **no** | display, fuera |
| `<wokwi-ssd1306>` | `ssd1306` | **no** | I²C, fuera |
| `<wokwi-neopixel-matrix>` | `neopixel-matrix` | **no** | protocolo WS2812, fuera |
| `<wokwi-mpu6050>` | `mpu6050` | **no** | I²C, fuera |

### 11.4 Mapeo de pines de part numbers reales

Ejemplo: **LM358** (DIP-8 dual op-amp).

```
       +──┐  ┐──+
   OUT1─1  \_/ 8─VCC
   IN−1─2      7─OUT2
   IN+1─3      6─IN−2
    GND─4      5─IN+2
       +───────+
```

En Velxio, el `<wokwi-lm358>` (nuevo) expondrá 8 pines con esos nombres. El `componentToSpice` para el metadataId `opamp-lm358` emite:

```
X_{id} {inp1} {inn1} {vcc} {out1} {gnd} {inp2} {inn2} {out2} LM358
```

Y el `.subckt LM358` (importado de la biblioteca) hace el macromodelo completo.

---

## 12. Checklist final antes de mergear cada PR

- [ ] Todos los tests del sandbox siguen pasando en su ubicación actual (baseline preservado)
- [ ] Nuevos tests en `frontend/src/__tests__/` pasan
- [ ] `npm run build:docker` exitoso
- [ ] `npm run lint` clean
- [ ] Feature flag `VITE_ELECTRICAL_SIM` respeta default off en prod hasta Fase 8.6
- [ ] Bundle analyzer: el chunk de `eecircuit-engine` es `import()` separado
- [ ] QA manual: al menos 3 circuitos representativos validados
- [ ] Docs actualizados: entrada en `docs/wiki/` para cada nuevo componente
- [ ] CLAUDE.md actualizado: sección "Electrical simulation"
- [ ] Changelog: release notes preparadas

---

## 13. Referencias cruzadas

- Sandbox madre: [`test/test_circuit/`](../..)
- Plan inicial (baseline): [`plan1.md`](./plan1.md)
- Findings del sandbox: [`../autosearch/`](../autosearch/)
- Wiki docs: [`docs/wiki/circuit-emulation.md`](../../../docs/wiki/circuit-emulation.md)
- Plan anterior de integración (superseded): [`docs/wiki/circuit-emulation-velxio-integration.md`](../../../docs/wiki/circuit-emulation-velxio-integration.md) → este documento lo reemplaza con más detalle de componentes e instrumentos.

# Plan: Simulación Eléctrica Completa con ngspice en Velxio

## Contexto

Actualmente los cables de Velxio son puramente visuales, los valores de resistores/capacitores nunca se usan en ningún cálculo, y los LEDs se encienden si `anode=HIGH && cathode=LOW` sin importar la resistencia en serie. La meta es añadir simulación eléctrica real mediante ngspice corriendo en WASM en el browser.

---

## Stack de librerías a instalar

```bash
# En frontend/
npm install eecircuit-engine           # ngspice compilado a WASM (MIT, 40MB, incluye tipos TS)
npm install circuit-json               # Formato JSON para circuitos (MIT, 24.5K descargas/sem)
npm install circuit-json-to-spice      # CircuitJSON → netlist ngspice (MIT, 10K descargas/sem)
npm install circuit-json-to-connectivity-map  # Grafo de conectividad (MIT, 27.8K descargas/sem)
npm install graphology                 # Grafo tipado para nodos eléctricos (MIT, 161K descargas/sem)
```

### Por qué cada una

| Librería | Rol | Alternativa descartada |
|---|---|---|
| `eecircuit-engine` | Motor ngspice WASM, ya compilado, API TypeScript | wokwi/ngspice-wasm (solo build system) |
| `circuit-json` | Tipos TypeScript para componentes eléctricos | Inventar tipos propios |
| `circuit-json-to-spice` | Genera netlist SPICE desde grafo | Escribir el generador a mano |
| `circuit-json-to-connectivity-map` | Construye las nets (nodos eléctricos) desde conexiones | Union-Find propio |
| `graphology` | Representación y query del grafo de nodos | dagre (solo layout, no análisis) |

---

## Arquitectura de la integración

```
useSimulatorStore (wires[], components[])
        ↓
 NetlistBuilder.ts
        ↓  [Union-Find sobre wires]
 circuit-json (nets + componentes)
        ↓
 circuit-json-to-connectivity-map (grafo de nodos)
        ↓
 circuit-json-to-spice (netlist SPICE string)
        ↓
 SpiceEngine.ts  →  eecircuit-engine (.runSim())
        ↓
 ResultType { variableNames[], data[].values[] }
        ↓
 Inyección en simulación:
   - ADC (potenciómetro, NTC, etc.) via AVRSimulator.setAnalogVoltage()
   - Brillo real de LEDs (corriente calculada)
   - Voltajes visibles en canvas (overlay)
```

---

## Fase 1 — Grafo eléctrico y análisis DC estático (semana 1-2)

### 1.1 Construir las nets (nodos eléctricos) desde `wires[]`

**Archivo nuevo:** `frontend/src/simulation/NetlistBuilder.ts`

Algoritmo Union-Find sobre los wires de Velxio:

```typescript
// Para wires como:
// { start: { componentId: 'arduino-uno', pinName: '13' }, end: { componentId: 'r1', pinName: '1' } }
// { start: { componentId: 'r1', pinName: '2' }, end: { componentId: 'led1', pinName: 'A' } }
// { start: { componentId: 'led1', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' } }

// Genera nets:
// net_0: ['arduino-uno:13', 'r1:1']
// net_1: ['r1:2', 'led1:A']
// net_gnd: ['led1:C', 'arduino-uno:GND']
```

Reglas especiales:
- Pin `GND` / `GND.1` / etc. → siempre net `0` (ground)
- Pin `VCC` / `5V` / `3.3V` → net de alimentación fija
- Componentes pasivos (`resistor`, `resistor-us`) → dos terminales, la resistencia se aplica en SPICE

### 1.2 Generar CircuitJSON desde el estado de Velxio

Mapeo de `metadataId` → tipo circuit-json:

| metadataId Velxio | Tipo circuit-json | Propiedades |
|---|---|---|
| `resistor` | `source_simple_resistor` | `resistance: parseFloat(props.resistance)` |
| `led` | `source_simple_led` | `color: props.color` |
| `capacitor` | `source_simple_capacitor` | `capacitance: parseFloat(props.capacitance)` |
| `pushbutton` | `source_simple_push_button` | — |
| `potentiometer` | `source_simple_potentiometer` | — |
| Arduino GPIO pin | `source_simple_voltage_source` | `voltage: pinState ? 5 : 0` |

### 1.3 Generar netlist SPICE y correr análisis DC

```typescript
import { circuitJsonToSpice } from 'circuit-json-to-spice'
import { Simulation } from 'eecircuit-engine'

const netlist = circuitJsonToSpice(circuitJson).toSpiceString() + '\n.op\n.end'
const sim = new Simulation()
await sim.start()
sim.setNetList(netlist)
const result = await sim.runSim()
// result.variableNames = ['v(net_0)', 'v(net_1)', 'v(net_gnd)', ...]
// result.data[i].values[0] = DC voltage at that node
```

### 1.4 Mostrar voltajes en canvas

Overlay SVG semitransparente sobre cada wire/nodo mostrando la tensión calculada. Activado con un botón de toggle "⚡ Voltages" en la toolbar.

---

## Fase 2 — ADC real y brillo real de LEDs (semana 3)

### 2.1 Inyectar voltajes SPICE en el ADC del AVR

Cuando SPICE termina el análisis DC, los nodos conectados a pines analógicos del Arduino se inyectan:

```typescript
// En AVRSimulator.ts ya existe:
pinManager.setAnalogVoltage(pin, voltage)

// Nuevo: al final de cada análisis SPICE
for (const analogPin of ['A0','A1','A2','A3','A4','A5']) {
  const netVoltage = spiceResult.getNodeVoltage(`net_${analogPin}`)
  if (netVoltage !== null) {
    pinManager.setAnalogVoltage(boardPinToNumber(analogPin), netVoltage)
  }
}
```

### 2.2 Brillo real de LEDs

Calcular corriente a través del LED desde SPICE y mapear a brillo:

```typescript
// ngspice devuelve i(v_gpio13) — corriente por la fuente
// Corriente típica LED rojo: 10-20mA @ 2V forward
const current = spiceResult.getCurrentThrough('v_gpio13') // mA
const brightness = Math.min(1.0, current / 20)
ledElement.brightness = brightness
```

### 2.3 Recalcular SPICE en cada cambio de pin GPIO

Hook en `PinManager.onPinChange()` → debounce 50ms → recorrer análisis DC:

```typescript
pinManager.onAnyPinChange(() => {
  clearTimeout(spiceDebounce)
  spiceDebounce = setTimeout(() => runSpiceAnalysis(), 50)
})
```

---

## Fase 3 — Análisis transitorio para señales dinámicas (semana 4+)

Para señales PWM, filtros RC, circuitos osciladores:

```typescript
// Reemplazar .op con .tran
const netlist = `...
.tran 1u 10m   // 1µs steps, 10ms total
.end`

// El resultado es una serie de tiempo
result.data[nodeIndex].values  // array de voltajes en t=0, 1µs, 2µs...
```

Usar un Web Worker para correr `.tran` sin bloquear la UI. Mostrar formas de onda en el Oscilloscope (ya existe en Velxio).

---

## Archivos a crear / modificar

| Archivo | Acción | Descripción |
|---|---|---|
| `frontend/src/simulation/SpiceEngine.ts` | **CREAR** | Wrapper sobre `eecircuit-engine`. Singleton. Métodos: `init()`, `runDC(netlist)`, `runTran(netlist)` |
| `frontend/src/simulation/NetlistBuilder.ts` | **CREAR** | Convierte `wires[]` + `components[]` → CircuitJSON → netlist SPICE |
| `frontend/src/simulation/ElectricalGraph.ts` | **CREAR** | Grafo `graphology` de nodos. Métodos: `buildFromWires()`, `getNodeVoltage()`, `getNet()` |
| `frontend/src/store/useSimulatorStore.ts` | **MODIFICAR** | Añadir `spiceVoltages: Record<string, number>` al estado; trigger SPICE tras pin changes |
| `frontend/src/simulation/AVRSimulator.ts` | **MODIFICAR** | En pin change callbacks, llamar `spiceEngine.runDC()` con estado actual de pines |
| `frontend/src/components/simulator/SimulatorCanvas.tsx` | **MODIFICAR** | Overlay de voltajes en canvas; botón "⚡ Voltages" |
| `frontend/src/simulation/parts/BasicParts.ts` | **MODIFICAR** | LED usa corriente SPICE para `brightness` en vez de solo boolean |
| `frontend/package.json` | **MODIFICAR** | Añadir 5 dependencias |

---

## Modelo SPICE para los componentes más importantes

### LED (modelo diodo SPICE)
```spice
.model LED_RED D(Is=1e-20 N=1.7 Rs=3 Cjo=50p)
D1 net_anode net_cathode LED_RED
```

### Resistor
```spice
R1 net_1 net_2 220
```

### Potenciómetro (divisor)
```spice
R_POT_A net_vcc wiper {value * pot_max}
R_POT_B wiper net_gnd {(1-value) * pot_max}
```

### Pin GPIO (fuente controlada)
```spice
V_GPIO13 net_gpio13 0 DC {pinState ? 5.0 : 0.0}
```

---

## Limitaciones conocidas

1. **eecircuit-engine pesa ~40 MB** — cargar lazy (solo cuando se activa simulación eléctrica)
2. **circuit-json-to-spice** no soporta LEDs aún (solo R, C, BJT) → hay que extender con modelos de diodo manuales
3. **Co-simulación AVR ↔ SPICE** al mismo tiempo es compleja: se implementa como análisis quasi-estático (no simultáneo ciclo a ciclo)
4. **Componentes sin modelo** (servomotor, NeoPixel, LCD) → se ignoran en el análisis SPICE, solo participan los passivos + diodos

---

## Verificación end-to-end

1. Cargar ejemplo "Blink LED" (Arduino → Resistor 220Ω → LED → GND)
2. Activar toggle "⚡ Voltages"
3. Cuando pin 13 = HIGH: el canvas debe mostrar ~3.3V en el nodo entre resistor y LED, ~0V en cátodo
4. Serial monitor debe seguir funcionando (la simulación eléctrica es adicional, no reemplaza el AVR)
5. Cargar ejemplo "Potenciómetro" → girar el control → `analogRead(A0)` debe reflejar la tensión del divisor real

---

## Orden de implementación recomendado

1. `SpiceEngine.ts` — wrapper básico, test con un netlist hardcodeado
2. `NetlistBuilder.ts` — construir nets desde wires, generar CircuitJSON simple
3. Overlay visual de voltajes en canvas
4. Integrar en `useSimulatorStore` con debounce
5. Inyección ADC
6. Brillo real de LEDs
7. Análisis transitorio en Web Worker

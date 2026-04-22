# Inventario de componentes lógicos y analógicos en Velxio

> Auditoría realizada el 2026-04-15 sobre la rama `feature/electrical-simulation-ngspice` (commit `ed9911d`).
> Objetivo: saber qué compuertas lógicas y componentes analógicos genéricos ya existen, en qué capa, y qué falta.

## Metodología

Velxio tiene **tres capas independientes** que deben estar alineadas para que un componente sea "completo":

| Capa | Archivo de referencia | Rol |
|---|---|---|
| **Visual** | `frontend/src/components/components-wokwi/*.ts[x]` + `frontend/public/component-svgs/*.svg` | Web Component / SVG que el usuario ve en el canvas |
| **Metadata** | `frontend/public/components-metadata.json` (generado por `scripts/generate-component-metadata.ts`) | Registro que alimenta el `ComponentPickerModal` — si un componente no está aquí, el usuario no puede añadirlo desde la UI |
| **Digital-sim** | `frontend/src/simulation/parts/*.ts` (registro `PartSimulationRegistry`) | Lógica reactiva a cambios de pines del MCU (AVR/RP2040/ESP32) |
| **SPICE-sim** | `frontend/src/simulation/spice/componentToSpice.ts` (tabla `MAPPERS`) | Emite tarjetas de netlist para ngspice-WASM en modo eléctrico |

Un componente puede existir en una capa sin existir en otra. Ejemplo: las compuertas lógicas tienen visual + digital-sim pero **no** tienen metadata ni mapper SPICE.

## Compuertas lógicas

Registradas como Web Components en [`LogicGateElements.ts`](../../../frontend/src/components/components-wokwi/LogicGateElements.ts) e implementadas como simulación digital reactiva en [`LogicGateParts.ts`](../../../frontend/src/simulation/parts/LogicGateParts.ts):

| Metadata ID | Visual | Digital-sim | Metadata JSON | SPICE mapper |
|---|---|---|---|---|
| `logic-gate-and`  | ✅ `wokwi-logic-and`  | ✅ | ❌ | ❌ |
| `logic-gate-nand` | ✅ `wokwi-logic-nand` | ✅ | ❌ | ❌ |
| `logic-gate-or`   | ✅ `wokwi-logic-or`   | ✅ | ❌ | ❌ |
| `logic-gate-nor`  | ✅ `wokwi-logic-nor`  | ✅ | ❌ | ❌ |
| `logic-gate-xor`  | ✅ `wokwi-logic-xor`  | ✅ | ❌ | ❌ |
| `logic-gate-not`  | ✅ `wokwi-logic-not`  | ✅ | ❌ | ❌ |
| **XNOR** | ❌ | ❌ | ❌ | ❌ |

**Hallazgos clave:**
- Las 6 compuertas existentes son **inaccesibles desde la UI** porque no están en `components-metadata.json`. Hay que añadirlas manualmente en `scripts/generate-component-metadata.ts` (o vía `component-overrides.json`) y regenerar el JSON.
- **XNOR falta en las 3 capas**. Es la única compuerta básica de 2 entradas ausente.
- Solo hay variantes de **2 entradas** (y NOT con 1). Faltan 3-input y 4-input AND/OR/NAND/NOR — útiles en circuitos reales y muy fáciles de añadir porque la lógica es la misma generalizada.
- Los tests de `spice_logic_gates.test.js` y `spice_digital.test.js` demuestran que **la implementación SPICE es trivial** con B-sources (`V = 20*u(V(a)-2.5)*u(V(b)-2.5) - ...`) — ya están los netlists probados.

## Analógicos genéricos

### Componentes con mapper SPICE (`componentToSpice.ts`)

| Metadata ID | Tipo | Metadata JSON | Visual dedicado |
|---|---|---|---|
| `resistor` | Pasivo | ✅ | ✅ |
| `resistor-us` | Pasivo (símbolo US) | ❌ | ❌ |
| `capacitor` | Pasivo | ❌ | ❌ |
| `inductor` | Pasivo | ❌ | ❌ |
| `analog-resistor` | Pasivo genérico A/B | ❌ | ❌ |
| `analog-capacitor` | Pasivo genérico A/B | ❌ | ❌ |
| `analog-inductor` | Pasivo genérico A/B | ❌ | ❌ |
| `led` | LED con color→modelo Shockley | ✅ | ✅ |
| `diode` | Diodo genérico | ❌ | ❌ |
| `diode-1n4148` | Diodo small-signal | ❌ | ❌ |
| `diode-1n4007` | Diodo rectificador 1 kV | ❌ | ❌ |
| `zener-1n4733` | Zener 5.1 V | ❌ | ❌ |
| `bjt-2n2222` | NPN general-purpose | ❌ | ❌ |
| `bjt-bc547` | NPN small-signal | ❌ | ❌ |
| `bjt-2n3055` | NPN potencia | ❌ | ❌ |
| `mosfet-2n7000` | NMOS logic-level | ❌ | ❌ |
| `mosfet-irf540` | NMOS potencia | ❌ | ❌ |
| `opamp-ideal` | Op-amp VCVS gain=1e6 | ❌ | ❌ |
| `pushbutton` | Switch | ✅ | ✅ |
| `slide-switch` | Switch | ✅ | ✅ |
| `slide-potentiometer` | Divisor 3 terminales | ✅ | ✅ |
| `ntc-temperature-sensor` | Sensor β-model | ✅ | ✅ |
| `photoresistor` | Sensor R(lux) | ✅ | ✅ |
| `instr-ammeter` | Amperímetro (V-source 0V + shunt 1 mΩ) | ❌ | ❌ |
| `instr-voltmeter` | Voltímetro (10 MΩ + probe) | ❌ | ❌ |

**Hallazgo clave:** de 25 mappers SPICE, **solo 6** (`resistor`, `led`, `pushbutton`, `slide-switch`, `slide-potentiometer`, `ntc-temperature-sensor`, `photoresistor`) tienen entrada en `components-metadata.json`. Los 19 restantes funcionan en el solver pero **son invisibles para el usuario** — se pueden instanciar solo programáticamente.

### Familias incompletas

| Familia | Lo que hay | Lo que falta |
|---|---|---|
| **BJT** | NPN: 2N2222, BC547, 2N3055 | PNP: 2N3906, BC557 |
| **MOSFET** | NMOS: 2N7000, IRF540 | PMOS: IRF9540, FQP27P06; JFETs |
| **Diodos** | Rectificador, small-signal, Zener 5.1 V | Schottky (1N5817/1N5819), TVS, photodiode, Zener en otros valores |
| **Op-amps** | Solo ideal | LM358, LM741, TL072, LM324 (modelos reales con Vsat/slew/offset) |
| **Fuentes** | Solo `opamp-ideal` VCVS | Battery (9V, AA, coin-cell), DC genérico, AC signal generator |
| **Reguladores** | Ninguno | LM7805, LM7812, LM317, TL431 |

### Completamente ausentes

- **Relay** con coil + contactos NC/NO (hay Web Component visual suelto, pero sin mapper)
- **Transformer** (acoplamiento inductivo con `K` mutual coupling)
- **Crystal** / cristal de cuarzo
- **Altavoz / piezo** como impedancia RC-L
- **Hall sensor** (A3144 tipo switch magnético)
- **Thermocouple** K-type
- **RTD** PT100/PT1000 (más preciso que NTC)
- **Strain gauge** para puente Wheatstone
- **Generador de señales** (sine/square/PWL inyectable al netlist)

## Instrumentos

Lo que existe:
- `instr-voltmeter` (mapper SPICE)
- `instr-ammeter` (mapper SPICE)
- [`Voltmeter.tsx`](../../../frontend/src/components/components-instruments/Voltmeter.tsx) y [`Ammeter.tsx`](../../../frontend/src/components/components-instruments/Ammeter.tsx) (Web Components)
- [`ElectricalOverlay.tsx`](../../../frontend/src/components/analog-ui/ElectricalOverlay.tsx) — muestra voltajes de todos los nodos como overlay SVG

Faltan:
- Multímetro DMM con selector (V/Ω/A/continuidad)
- Osciloscopio analógico que capture transitorios (el actual es digital)
- Ohmmiter dedicado
- Signal generator

## Implicaciones para testing

1. Los **62 tests** de `frontend/src/__tests__/spice-*.test.ts` + los **88 tests** del sandbox ejercitan los mappers SPICE vía netlists hand-crafted, así que la ausencia de metadata JSON no impide probar **la corriente**. Sí impide probar el flujo **UI-picker → canvas → netlist** end-to-end.
2. Cualquier test nuevo para una compuerta XNOR o un transistor PNP debe emitir netlist directamente con `runNetlist(...)` hasta que exista el mapper.
3. El `docs/wiki/circuit-emulation-gotchas.md` advierte sobre caracteres no-ASCII en netlists de ngspice — reconfirmado en la sesión de hoy: **`→` en títulos rompe el parser silenciosamente** (30 s timeout sin error). Añadir a la lista de gotchas.

## Riesgos / bloqueadores para ampliar el catálogo

1. **Generador de metadata (limitación importante):** `scripts/generate-component-metadata.ts` escanea **exclusivamente** `wokwi-libs/wokwi-elements/src/*-element.ts` (ver función `findElementFiles()`). El mecanismo de `scripts/component-overrides.json` **NO permite añadir componentes nuevos** — solo parcha propiedades de los componentes que el escaneo ya encontró (ver función `applyOverrides()`: itera sobre `components` y busca `overrides[comp.id]`; si el componente no fue detectado, el override queda inutilizado).

   Consecuencia: todo lo que viva solo en `frontend/src/components/components-wokwi/` (compuertas lógicas, Bmp280Element, IC74HC595, RaspberryPi3Element, etc.) queda fuera del metadata. Cualquier componente nuevo que no exista también en wokwi-elements está en el mismo caso.

   **Regeneración destruye cualquier edición manual** de `components-metadata.json`: el generador sobrescribe el archivo entero con `fs.writeFileSync(outputPath, JSON.stringify(output, null, 2))`. Editar `components-metadata.json` a mano es inútil; el próximo `npm run generate-metadata` (o el build que lo ejecute) lo reemplazará.

   **Opciones para arreglar esto** (cualquiera en fase 9):
   - **A.** Extender `component-overrides.json` con una sección nueva `"_customComponents": [ {...metadata...} ]` y modificar `applyOverrides()` para hacer `components.push(...)` al inicio con esas entradas. Así sobrevive a la regeneración.
   - **B.** Nuevo archivo `scripts/custom-components.json` cargado por el generador en un paso adicional (separa claramente "patches a wokwi-elements" de "componentes propios de Velxio").
   - **C.** El generador también escanea `frontend/src/components/components-wokwi/*.ts` y reconoce un patrón (p.ej. export const VELXIO_METADATA = {...}). Más invasivo, pero elimina la duplicación.

   **Recomendación:** opción A — mínimo cambio en el generador (~15 líneas), un solo archivo de override, y permite regenerar todo sin miedo a perder entradas custom.
2. **Convergencia de ngspice:** la sesión de hoy mostró que `NMOS Level=3` con `W=0.1` (¡interpretado como 0.1 metros!) hace que ngspice cuelgue en `.op`. Los mappers actuales de `mosfet-2n7000` y `mosfet-irf540` usan esos valores. **Funciona por accidente** en los tests porque Vgs alto fuerza la saturación; con Vgs marginal colgará. Migrar a `Level=1` con `W=200u L=2u` es más robusto.
3. **Polaridad de pins:** los mappers asumen nombres de pin (`'A'`, `'B'`, `'C'/'B'/'E'`, `'D'/'G'/'S'`). Los componentes visuales todavía-no-existentes tendrán que usar exactamente esos nombres o el `netLookup` devolverá `null` y el componente se salteará silenciosamente.

## Próximos pasos concretos

Ver [`plan/phase_9_component_catalog_expansion.md`](../plan/phase_9_component_catalog_expansion.md).

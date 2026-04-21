# Fase 9 — Expansión del catálogo de componentes

> **Destino:** `frontend/src/simulation/spice/componentToSpice.ts`, `frontend/src/simulation/parts/`, `scripts/generate-component-metadata.ts` + `scripts/component-overrides.json`, `frontend/src/components/components-wokwi/`.
> **Pre-requisito leído:** [`autosearch/05_velxio_component_inventory.md`](../autosearch/05_velxio_component_inventory.md) — auditoría completa de lo que existe por capa.
> **Meta:** cerrar los huecos de compuertas lógicas (XNOR, 3/4-input, SPICE mappers) y completar las familias analógicas básicas (PNP, P-MOSFET, op-amps reales, reguladores, fuentes).

---

## 0. Resumen ejecutivo

| | |
|---|---|
| **Motivación** | Hoy `componentToSpice.ts` tiene 25 mappers pero solo 6 son accesibles desde la UI. Las compuertas lógicas (6 gates) existen como simulación digital pero sin mapper SPICE — incompatibles con el modo eléctrico |
| **Alcance** | Añadir ~20 mappers SPICE nuevos, ~15 entradas en metadata JSON, 1 compuerta nueva (XNOR), SPICE mappers de las 6 gates existentes, familia PNP/P-MOSFET, op-amps reales, reguladores 78xx/LM317, fuentes (battery, signal-gen) |
| **No hacer ahora** | Relay con modelo magnético completo, transformer con mutual coupling, cristal de cuarzo, osciloscopio analógico nuevo. Son otra fase |
| **Riesgo principal** | Modelos SPICE que no convergen (sesión 2026-04-15 mostró que `NMOS Level=3` con `W=0.1` cuelga ngspice). **Cada mapper nuevo debe venir con un test que valide convergencia `.op` en < 1 s** |
| **Validación** | Tests en `test/test_circuit/test/spice_*.test.js` (actualmente 88 pasando) + nuevos tests en `frontend/src/__tests__/` para verificar el flujo picker → netlist |

---

## 1. Prioridad

### A) Quick wins — alto impacto, bajo esfuerzo

1. **XNOR gate** — completar la familia de 7 básicas. Requiere:
   - `LogicGateElements.ts`: `XnorGateElement` (copiar XOR + burbuja de inversión)
   - `LogicGateParts.ts`: `register('logic-gate-xnor', twoInputGate((a,b) => a===b))`
   - `vite-env.d.ts`: añadir `'wokwi-logic-xnor': any`
   - `main.tsx`: ya importa `LogicGateElements` — nada que hacer

2. **SPICE mappers para las 6 gates existentes** — habilita el modo eléctrico con circuitos digitales. Usar B-sources behaviorales (ya probados en `test/spice_logic_gates.test.js`):
   ```typescript
   'logic-gate-and':  (comp, netLookup, ctx) => {
     const a = netLookup('A'), b = netLookup('B'), y = netLookup('Y');
     if (!a || !b || !y) return null;
     const Vthr = ctx.vcc / 2;
     return {
       cards: [
         `B_${comp.id} ${y} 0 V = ${ctx.vcc} * u(V(${a})-${Vthr}) * u(V(${b})-${Vthr})`,
         `R_${comp.id}_load ${y} 0 1Meg`,
       ],
       modelsUsed: new Set(),
     };
   },
   ```
   Variantes para OR, NAND, NOR, XOR, NOT, XNOR (expresiones en [`autosearch/04_ngspice_findings.md`](../autosearch/04_ngspice_findings.md#b-source-boolean-expressions)).

3. **PNP y P-MOSFET** — cierran familias de transistores:
   - `bjt-2n3906` (PNP), `bjt-bc557` (PNP small-signal)
   - `mosfet-irf9540` (PMOS potencia), `mosfet-fqp27p06` (PMOS logic-level)
   - Modelos SPICE ya usados en los tests de la sesión 2026-04-15 (ver `spice_transistors.test.js::H-bridge`).

4. **Metadata JSON para las 6+1 gates y los 4 transistores nuevos** — el mecanismo actual de `scripts/component-overrides.json` **solo parcha componentes ya descubiertos** en `wokwi-libs/wokwi-elements/src/`. No permite añadir componentes nuevos, y cualquier edición manual de `components-metadata.json` se pierde al regenerar (el generador hace `writeFileSync` sobrescribiendo el archivo entero). **Antes** de añadir entradas hay que resolver este bloqueador — ver fase 9.0 abajo.

### B) Media prioridad — completan familias

5. **3/4-input gates** (`logic-gate-and-3`, `logic-gate-or-4`, etc.): trivial en digital-sim (`inputs.every(x=>x)`), trivial en SPICE (B-source con más factores `u()`).

6. **Schottky y photodiode:**
   - `diode-1n5817` — Schottky 1A/20V (`Is=1u N=1 Rs=0.05`)
   - `diode-1n5819` — Schottky 1A/40V
   - `photodiode-generic` — diodo + fuente de corriente controlada por flux (propiedad `lux`)

7. **Op-amps reales** — reemplazar el comportamiento ideal actual con modelos que capturen Vsat, slew rate y offset:
   - `opamp-lm358` — dual rail-to-rail, single supply
   - `opamp-lm741` — single, didáctico
   - `opamp-tl072` — JFET input, audio
   - `opamp-lm324` — quad

   Arquitectura sugerida: un **subcircuit behavioral** con tres etapas (entrada diferencial limitada + gain + saturation clamp). Ver [`autosearch/04_ngspice_findings.md`](../autosearch/04_ngspice_findings.md) para los casos que ya hemos probado con éxito.

8. **Reguladores lineales:**
   - `reg-7805`, `reg-7812`, `reg-7905` — fijos
   - `reg-lm317` — ajustable (R1, R2 como propiedades)

   Topología: VCVS con referencia de 1.25 V (LM317) o Zener interno + feedback.

9. **Fuentes discretas:**
   - `battery-9v`, `battery-aa-cell`, `battery-coin-cell` — DC con Voc y Rint realistas
   - `voltage-source-dc` — DC genérico ajustable
   - `signal-generator` — PWL inyectado (sine/square/triangle) con propiedades de frecuencia y amplitud

### C) Baja prioridad — queda para fase 10

10. Relay electromecánico completo (coil + contactos + diodo flyback)
11. Transformer con `K` mutual coupling
12. Cristal de cuarzo (modelo RLC + capacitor paralelo)
13. Altavoz / piezo (modelo audio)
14. Hall sensor A3144, RTD PT100/PT1000, thermocouple K, strain gauge
15. Multímetro DMM con selector (requiere ampliar instr-* existentes)
16. Osciloscopio analógico transitorio (diferente del digital actual)

---

## 2. Plan de ejecución

### Fase 9.0 — Habilitar componentes custom en el generador de metadata (1 día — **bloqueador**)

**Problema:** `scripts/generate-component-metadata.ts` escanea solo `wokwi-libs/wokwi-elements/src/*-element.ts`, y `applyOverrides()` no crea componentes nuevos — solo parcha los ya descubiertos. Cualquier mapper SPICE o gate lógica que no exista en wokwi-elements es invisible en la UI, y editar a mano `components-metadata.json` se pierde al regenerar.

**Solución recomendada (opción A de la auditoría):** extender `component-overrides.json` con una sección nueva `"_customComponents"` y patchear el generador ~15 líneas.

Paso 1 — extender `scripts/component-overrides.json`:

```json
{
  "$comment": "...",
  "_customComponents": [
    {
      "id": "logic-gate-xnor",
      "tagName": "wokwi-logic-xnor",
      "name": "XNOR Gate",
      "category": "logic",
      "properties": [],
      "defaultValues": {},
      "pinCount": 3,
      "pins": [
        {"name": "A", "x": 0, "y": 14, "number": 1},
        {"name": "B", "x": 0, "y": 34, "number": 2},
        {"name": "Y", "x": 72, "y": 24, "number": 3}
      ]
    },
    { "id": "capacitor", "tagName": "wokwi-analog-capacitor", ... },
    ...
  ],
  "led": { "properties": { "color": {...} } }
}
```

Paso 2 — patchear `generate-component-metadata.ts` en `applyOverrides()`:

```typescript
// Antes del for loop existente, añadir:
const customComps = (overrides._customComponents ?? []) as ComponentMetadata[];
for (const custom of customComps) {
  // Evitar duplicados: si ya existe por id, saltar (el escaneo wokwi-elements gana)
  if (components.find(c => c.id === custom.id)) continue;
  components.push(custom);
  console.log(`  ➕ Added custom component ${custom.id}`);
}
```

Paso 3 — añadir `"logic"` a `CATEGORY_MAP` en el mismo archivo para que los gates se agrupen correctamente en el picker, y a `ComponentCategory` en `frontend/src/types/component-metadata.ts` + su `displayNames` en `ComponentRegistry.ts`.

Paso 4 — regenerar:
```bash
npm run generate-metadata     # o el comando equivalente — verificar package.json
git diff frontend/public/components-metadata.json  # validar que las entradas custom persisten
```

Paso 5 — **test de no-regresión**: un test unitario en `scripts/` (o vitest) que corre el generador con un fixture de overrides y verifica que los `_customComponents` sobreviven.

Criterio de aceptación de 9.0: poder añadir un componente en `_customComponents`, regenerar, y verlo en `components-metadata.json` + en el picker UI. **Sin esto, las fases 9.1–9.5 no pueden completarse.**

### Fase 9.1 — XNOR + SPICE mappers de las gates (1–2 días)

Orden exacto:

1. Añadir `XnorGateElement` en `LogicGateElements.ts` siguiendo el patrón de XOR con burbuja de inversión.
2. Registrar en `customElements.define` y en `vite-env.d.ts`.
3. Registrar la lógica digital en `LogicGateParts.ts`: `register('logic-gate-xnor', twoInputGate((a, b) => a === b))`.
4. Añadir los 7 mappers SPICE en `componentToSpice.ts` bloque `// ── Digital logic gates ──`. Todos siguen el mismo shape:
   - resolver `netLookup` de pines de entrada + `Y`
   - emitir **una** tarjeta `B_${id} ${y} 0 V = ...` con la expresión behavioral
   - emitir **una** resistencia `R_${id}_load ${y} 0 1Meg` para que el nodo `y` tenga camino DC (evita matrix singular en `.op`)
5. Añadir los 7 componentes a la sección `_customComponents` de `component-overrides.json` (disponible tras fase 9.0) con pinout y propiedades.
6. Regenerar `components-metadata.json` vía `npm run generate-metadata` (o el script que corresponda) y verificar que las entradas custom persisten.
7. **Tests:**
   - `frontend/src/__tests__/spice-logic-gates-mapped.test.ts` — un test por gate que construye un `ComponentForSpice` mock, invoca `componentToSpice()`, verifica las cartas emitidas y corre el netlist.
   - Reusar los 12 tests de `test/test_circuit/test/spice_logic_gates.test.js` como referencia de expectativas numéricas.

### Fase 9.2 — PNP + P-MOSFET (1 día)

1. Añadir a `componentToSpice.ts`:
   - `bjt-2n3906`: `PNP(Is=1.41f Bf=180 Vaf=18.7 Rb=10)`
   - `bjt-bc557`: `PNP(Is=6.73f Bf=250 Vaf=80)`
   - `mosfet-irf9540`: `PMOS(Level=1 Vto=-3 Kp=20u Lambda=0.01 W=1 L=2u)`
   - `mosfet-fqp27p06`: `PMOS(Level=1 Vto=-2.5 Kp=50u Lambda=0.01 W=500u L=2u)`
2. **Importante:** no copiar el patrón actual de `mosfet-2n7000` que usa `W=0.1` y `Level=3` — esos valores causan cuelgues (confirmado sesión 2026-04-15). Migrar de paso los dos NMOS existentes a `Level=1` con W/L sanos — *refactor de oportunidad*.
3. Añadir 4 entradas a la sección `_customComponents` de `component-overrides.json`.
4. **Tests:** reutilizar los tests PNP del sandbox (`spice_transistors.test.js::'PNP (2N3906) high-side switch'`) — portar a `frontend/src/__tests__/`.

### Fase 9.3 — Op-amps reales (2–3 días)

1. Implementar un helper `emitOpampSubckt(id, inPlus, inMinus, out, Vsat)` que emita una única subrutina behavioral con clamp y gain ≈ 1e5.
2. 4 mappers (`opamp-lm358`, `opamp-lm741`, `opamp-tl072`, `opamp-lm324`), cada uno variando `Vsat` según rango de alimentación realista.
3. **Tests:** inverting amp, non-inverting amp, buffer, comparador. Ver ejemplos en `spice_analog_advanced.test.js`.

### Fase 9.4 — Reguladores y fuentes (2 días)

1. `reg-7805`, `reg-7812`, `reg-7905`: Zener interno + VCVS seguidor con limitación de corriente.
2. `reg-lm317`: VCVS con referencia ajustable por el divisor R1/R2 expuesto como propiedad.
3. `battery-*`: V-source DC con resistencia serie interna.
4. `voltage-source-dc`, `signal-generator`: fuentes genéricas (la generator emite PWL parametrizado).
5. **Tests:** regulación bajo carga variable (step de Rload 1k→100Ω debe mantener Vout dentro de especificación).

### Fase 9.5 — 3/4-input gates + Schottky + photodiode (1 día)

Último sprint de la fase, componentes "largo-tail" pero muy usados en circuitos didácticos.

---

## 3. Criterios de aceptación

Cada mapper nuevo debe:

1. ✅ Pasar un test de **convergencia DC** en ngspice con `.op` en < 1 s (evita el síndrome `W=0.1`).
2. ✅ Pasar un test de **behavior** — truth table para gates, saturación/cutoff para transistores, ganancia para op-amps, regulación para reguladores.
3. ✅ Tener entrada en `components-metadata.json` con `pinCount`, `properties[]`, `category`.
4. ✅ Aparecer en el `ComponentPickerModal` categorizado.
5. ✅ No romper los 88 tests del sandbox ni los 62 tests de `frontend/src/__tests__/spice-*`.

## 4. Out-of-scope explícito

- **No** reimplementar las compuertas lógicas con modelos CMOS real (Q_pullup + Q_pulldown). La representación behavioral con B-sources es suficiente y ~100× más rápida.
- **No** soportar tiempos de propagación realistas en las gates. El modo eléctrico es cuasi-estático; los delays se modelan en la capa digital-sim cuando hacen falta.
- **No** añadir ICs completos (74HC00, CD4000) en esta fase — requieren subcircuits y packaging que vienen en una fase de "integrated circuits" aparte.

## 5. Métricas de éxito

- Número de mappers SPICE: 25 → **45+** tras fase 9.
- Número de componentes accesibles desde el picker (en `components-metadata.json`): 49 → **65+**.
- Cobertura de tests SPICE: 88 + 62 = 150 → **180+** tras añadir tests para nuevos mappers.
- Tiempo total de ejecución del sandbox (`npm test`): **< 15 s** en CI (actualmente ~7.5 s local).

## 6. Referencias

- [`autosearch/05_velxio_component_inventory.md`](../autosearch/05_velxio_component_inventory.md) — auditoría que motiva este plan
- [`test/test_circuit/test/spice_logic_gates.test.js`](../test/spice_logic_gates.test.js) — 12 tests con las expresiones B-source ya validadas
- [`test/test_circuit/test/spice_transistors.test.js`](../test/spice_transistors.test.js) — 12 tests incluyendo PNP 2N3906 que aún no tiene mapper
- [`test/test_circuit/test/spice_analog_advanced.test.js`](../test/spice_analog_advanced.test.js) — 8 tests de circuitos que usan op-amps ideales; referencia para validar los op-amps reales
- [`docs/wiki/circuit-emulation-components.md`](../../../docs/wiki/circuit-emulation-components.md) — contrato de mappers
- [`docs/wiki/circuit-emulation-gotchas.md`](../../../docs/wiki/circuit-emulation-gotchas.md) — debugging ngspice (**añadir** la nota sobre caracteres no-ASCII en títulos)

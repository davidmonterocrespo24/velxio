# Gaps identificados y posibles mejoras

## Modelado físico

- **Inductor**: trapezoidal companion model (`G = 2L/dt, Ieq = -V_prev/G - I_prev`). Requiere tracking de corriente por inductor entre pasos. Útil para motor back-EMF, filtros LC.
- **MOSFET**: modelo Shichman-Hodges nivel-1 (`Id = k·(Vgs-Vth)²·(1+λ·Vds)` en saturación). ~50 líneas. Útil para H-bridges, drivers de motor.
- **Op-amp ideal**: fuente controlada con `A_vol ≈ 1e6`; se estampa como fuente de voltaje dependiente de la diferencia de entrada.
- **Zener**: Shockley con breakdown en `-Vz`. Útil para protección / regulación.
- **Modelo térmico** del LED: brillo saturado a `I_rated` puede extenderse con curva de eficiencia luminosa.

## Del solver

- **AC / análisis de frecuencia**: reemplazar conductancias reales por complejas. `jωC`, `jωL`. Útil para filtros y osciladores.
- **Newton con continuación de fuente** (source stepping): para circuitos donde Newton no converge, rampear `V_supply` de 0 al valor final en 10 pasos.
- **GMIN stepping**: empezar con `GMIN` grande (1e-3) y reducirlo iterativamente. Truco clásico de SPICE para mejorar convergencia.
- **Matriz dispersa**: para > 50 nodos, cambiar a sparse CSR (librería `mathjs` o nativa). No urgente; nuestros circuitos son pequeños.

## Integración Velxio

### 1. Parseo automático de `useSimulatorStore.wires[]` → `Circuit`

```typescript
function buildCircuit(components: Component[], wires: Wire[]): Circuit {
  const unionFind = new UnionFind();
  wires.forEach(w => {
    const from = `${w.start.componentId}:${w.start.pinName}`;
    const to   = `${w.end.componentId}:${w.end.pinName}`;
    unionFind.union(from, to);
  });
  // pin canónico GND / VCC → colapsar a 'gnd' / 'vcc'
  // Emitir Circuit correspondiente con los stamps apropiados por componente
}
```

### 2. `metadataId` → clase del solver

```typescript
const componentFactory: Record<string, (id, pins, props) => SolverComponent> = {
  'resistor':      (id, pins, props) => new Resistor(id, pins[0], pins[1], parseFloat(props.resistance)),
  'led':           (id, pins, props) => new LED(id, pins[0], pins[1], props.color),
  'capacitor':     (id, pins, props) => new Capacitor(id, pins[0], pins[1], parseFloat(props.capacitance)),
  'ntc-temperature-sensor': (id, pins, props) => new NTCThermistor(id, pins[0], pins[1], { R0: ..., beta: ... }),
  // ...
};
```

### 3. UI

- Toggle **"⚡ Voltajes"** en toolbar → overlay SVG con V de cada nodo.
- Panel lateral con tabla `nodo | V | I`.
- Warning: si el solver no converge (`state.converged === false`) mostrar banner naranja.

## Tests que faltaría añadir

- `transient_rlc.test.js` — oscilador LC amortiguado
- `opamp.test.js` — inverting, non-inverting, buffer
- `voltage_regulator.test.js` — zener + R de balasto
- `pwm_rc_filter.test.js` — PWM → RC → salida DC filtrada (ripple real)
- `debounce.test.js` — botón con RC de debounce → AVR detecta pulsación única

## Riesgos conocidos

1. **MNA no maneja bien bucles de fuentes de voltaje sin impedancia**: p.ej. dos V-source en paralelo → matriz singular. Mitigable añadiendo `GMIN` en diagonal (ya hecho) o detección/advertencia al usuario.
2. **Precisión del modelo BJT**: el simplified Ebers-Moll no captura bien la saturación profunda. Para tests didácticos basta; para diseño real se necesitaría Gummel-Poon.
3. **PWM cuasi-estático**: el brillo del LED es el promedio, no modela ripple ni la frecuencia de PWM audible.

# test_circuit — plan

Carpeta de planificación para la campaña de pruebas de emulación de circuitos.

## Estructura

- `plan1.md` — plan maestro original (SPICE + ngspice WASM, propuesta grande)
- `phase_0_scope.md` — alcance inicial
- `phase_1_libraries.md` — librerías evaluadas
- `phase_2_solver.md` — solver hand-rolled (**legacy**, baseline de comparación)
- `phase_3_passives.md` — pasivos (R, C, L)
- `phase_4_actives.md` — activos (diodo, LED, BJT, MOSFET)
- `phase_5_avr_integration.md` — integración con avr8js (estilo Velxio)
- `phase_6_end_to_end.md` — E2E pot→PWM-LED y termistor
- **`phase_7_ngspice.md`** — ngspice-WASM vía `eecircuit-engine` + co-simulación avr8js
- **`phase_8_velxio_implementation.md`** — **plan de implementación en Velxio** (definitivo): componentes nuevos (genéricos + reales), instrumentos, fases 8.1–8.6

## Cómo correr

```bash
cd test/test_circuit
npm install
npm test
```

Resultados se documentan progresivamente en `../autosearch/`.

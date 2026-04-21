# Fase 1 — Librerías

## Evaluadas

| Librería | Decisión | Razón |
|---|---|---|
| `eecircuit-engine` (ngspice WASM) | **DESCARTADA** para esta sandbox | 40 MB bundle, lazy-load complejo, overkill para validar el concepto. Reconsiderar en integración final. |
| `circuit-json` | **DESCARTADA** para esta sandbox | Tipos buenos pero innecesarios; el modelo propio es más pequeño y suficiente. |
| `circuit-json-to-spice` | **DESCARTADA** | Sin SPICE backend no aplica. |
| `mathjs` | **ADOPTADA** | Inversión LU, resolución `Ax=b`, manejo de matrices densas. MIT, ~650 kB, sin build step. |
| `avr8js` | **ADOPTADA** | Misma usada por Velxio — los tests deben ejercitar la misma API. |
| `vitest` | **ADOPTADA** | Runner de pruebas rápido, compatible con ESM, mismo que el frontend. |

## Descartadas sin probar

- `spicejs`, `ecsim`, `zsim` — o sin mantenimiento o sin API programática.
- `ngspice` nativo — el binario requiere compilación y no corre en browser.

## Decisión final

Implementar el **solver MNA (Modified Nodal Analysis) propio** en JS. Es pequeño (< 500 líneas), transparente, y fácil de integrar después en Velxio si el experimento funciona.

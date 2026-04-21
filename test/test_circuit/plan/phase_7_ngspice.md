# Fase 7 — Re-orientación a ngspice-WASM

## Cambio de estrategia

Tras la primera iteración con el solver MNA hand-rolled, el usuario pidió **no inventar** y usar un motor existente. Se evaluaron:

| Opción | Veredicto |
|---|---|
| `eecircuit-engine` (ngspice WASM, npm) | **ELEGIDA** — API simple, tipos TS, funciona en Node |
| `tscircuit/ngspice` (no publicado en npm) | descartada (hay que hacer fork) |
| `ngspice.js` (sitio separado) | descartada, no en npm |
| `spicejs` | descartada, sin API programable |
| `vollgas` | descartada, solo compuertas lógicas |

## Por qué eecircuit-engine

- Publicada en npm: `npm install eecircuit-engine`
- 39 MB descomprimida (una sola vez, lazy-load en producción)
- Boot en Node: ~400 ms
- Cada simulación posterior: 5–500 ms según complejidad
- Soporte nativo para `.op`, `.tran`, `.ac`, `.dc`, `.noise`, fuentes behavioral (B-sources), diodos, BJT, MOSFET, inductores, `.model`, `.subckt`…

## Qué queda vigente y qué cambia

### Vigente

- `src/avr/` — AVRHarness, parser Intel HEX, mini-assembler. Sin cambios.
- `fixtures/blink.hex` — sigue siendo la misma .hex que Velxio usa.
- Plan phases 0–6 como referencia histórica.

### Nuevo

- `src/spice/SpiceEngine.js` — wrapper de `eecircuit-engine` con helper `runNetlist(text)` que devuelve `{ raw, vec(name), dcValue(name) }`.
- `src/spice/AVRSpiceBridge.js` — co-simulación cuasi-estática entre `avr8js` y ngspice.
- Tests `test/spice_*.test.js`: passive, transient, AC, activos, digital, 555, mixed-signal.

### Legacy

- `src/solver/` — solver MNA hand-rolled. Los tests `passive.test.js`, `transient_rc.test.js`, `diodes.test.js` y los E2E del AVR **siguen pasando** y sirven como baseline de comparación contra ngspice. No se usan en la ruta principal.

## Estructura del pipeline final

```
┌──────────────────┐      ┌──────────────────┐
│   avr8js         │◄────►│  AVRSpiceBridge  │
│  (CPU, ADC, PWM) │      └─────────┬────────┘
└──────────────────┘                │
         ▲                           ▼
         │                  ┌──────────────────┐
         │                  │  SpiceEngine     │
         │                  │  (ngspice WASM)  │
         │                  └─────────┬────────┘
         │ (voltage inject)          │
         └────── v(node) sampling ────┘
```

En cada slice (por defecto 1 ms):
1. AVR corre N ciclos
2. Se snapshotean pines (digitales y PWM duty)
3. Se construye un netlist ngspice con los pines como fuentes
4. Se corre `.tran` en ngspice
5. Se samplean las nets que mapean a canales ADC del AVR
6. Se inyectan esos voltajes en `avr.setAnalogVoltage(ch, v)`

## Cobertura de primitivas ngspice validadas

| Primitiva | Archivo de test | Caso |
|---|---|---|
| R, V, I | `spice_passive.test.js` | divisor, paralelo, current source |
| L, C | `spice_transient.test.js` | RC charging, RLC ringing |
| AC sweep | `spice_ac.test.js` | RC low-pass Bode, LC bandpass |
| Diode | `spice_active.test.js` | forward drop, bridge rectifier |
| BJT | `spice_active.test.js` | common-emitter amplifier |
| MOSFET (L1) | `spice_active.test.js` | switch ON/OFF |
| E-source (op-amp) | `spice_active.test.js` | inverting amplifier |
| B-source (behavioral) | `spice_digital.test.js` | AND / NAND / XOR |
| Switch (S-element) con histéresis | `spice_555_astable.test.js` | oscilador relajación |
| `.op`, `.tran`, `.ac` | todos | |
| Mixed-signal AVR ↔ ngspice | `spice_avr_mixed.test.js` | NTC, PWM→RC, pot cosim |

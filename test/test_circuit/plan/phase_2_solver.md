# Fase 2 — Diseño del solver

## Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│  Circuit (nodos + componentes)                              │
│                                                             │
│  addNode('vcc'), addNode('out'), addNode('gnd')             │
│  addComponent(new Resistor('R1','vcc','mid',1000))          │
│  addComponent(new VoltageSource('V1','vcc','gnd',5))        │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  MNA Solver                                                 │
│                                                             │
│  Construye matriz G (conductancias) de tamaño (N+M)         │
│    N = nodos no-tierra                                      │
│    M = fuentes de voltaje                                   │
│  Vector b (corrientes + voltajes fijos)                     │
│  Resuelve Gx = b  (x = [V_nodos, I_fuentes])                │
│                                                             │
│  Para diodos / LEDs: Newton-Raphson iterativo sobre stamp   │
│                      lineal con conductancia gd y corriente │
│                      equivalente Ieq                         │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  Transient Solver (backward Euler)                          │
│                                                             │
│  Capacitor stamp: G_c = C/Δt, I_eq = C/Δt · V(t-Δt)         │
│  Inductor  stamp: G_l = Δt/L (pseudo), usamos trapezoidal   │
│  En cada paso: solver DC con stamps dependientes del último │
│  estado.                                                    │
└─────────────────────────────────────────────────────────────┘
```

## Componentes soportados (fase 2–4)

| Componente | Stamp | Modelo |
|---|---|---|
| `Resistor` | G = 1/R en (a,a), (b,b), -G en (a,b), (b,a) | lineal |
| `VoltageSource` | fila+col extra, 1 en nodo+ 1 en nodo−, V en b | lineal |
| `CurrentSource` | I en b[nodo+], -I en b[nodo−] | lineal |
| `Capacitor` | backward Euler: G=C/Δt, Ieq=C/Δt·V_prev | transient |
| `Inductor` | trapezoidal opcional; por ahora tratado como fuente I | transient |
| `Diode` | Shockley: I = Is(e^(V/nVt)−1), linealiza como (gd, Ieq) iterando | no-lineal |
| `LED` | diodo con Is, n y color (info visual); misma iteración | no-lineal |
| `NTCThermistor` | R(T) = R0 · e^(β(1/T−1/T0)) | lineal param. |
| `Potentiometer` | 2 resistores en serie controlados por `wiperPos` | lineal param. |
| `Switch` | R muy grande (abierto) / muy pequeña (cerrado) | lineal |
| `BJT` (opcional) | Ebers-Moll simplificado; iteración Newton | no-lineal |

## Convergencia Newton-Raphson

- Máx. 100 iteraciones
- Tolerancia: `max(|V_i − V_i-1|) < 1e-6 V` y `max(|I_i − I_i-1|) < 1e-9 A`
- Damping adaptativo si oscila

## Fichero principal

`src/solver/MNASolver.js` — clase `Circuit` con métodos `addNode`, `addComponent`, `solveDC()`, `solveTransient(tEnd, dt)`.

# Fase 10 — Electromecánica + ICs integrados

> **Destino:** `frontend/src/simulation/spice/componentToSpice.ts`, `frontend/src/simulation/parts/`, `scripts/component-overrides.json`, `frontend/src/components/components-wokwi/`.
> **Pre-requisito leído:** [`phase_9_component_catalog_expansion.md`](phase_9_component_catalog_expansion.md) (completada).
> **Meta:** cubrir los componentes que quedaban fuera del catálogo analógico puro — electromecánicos (relé), aislamiento óptico (optoacopladores), packaging de lógica combinacional (74HC series) y electromecánica compleja (driver de motores).

---

## 0. Resumen ejecutivo

| | |
|---|---|
| **Alcance** | 5 familias nuevas: relé electromecánico, optoacopladores, 74HC logic ICs, flip-flops, driver de motor L293D |
| **Componentes nuevos** | ≈ 10 (1 relé + 2 optos + 5 ICs 74HC + 3 flip-flops + L293D) |
| **Patrón arquitectónico nuevo** | Mappers SPICE que emiten **varias** B-sources / `.subckt` por componente (primera vez en el proyecto — hasta fase 9 cada mapper emitía una device card) |
| **Limitación conocida** | Flip-flops solo en digital-sim: SPICE no puede hacer edge detection sin `ddt()` en `.op` — se documenta y se añade en digital-sim layer únicamente |
| **Validación** | Tests de electrical-mode en `test/test_circuit/test/` + tests de digital-sim en `frontend/src/__tests__/` |

---

## 1. Componentes

### 1.1 Relé electromecánico (5-pin SPDT)

**Pins:** `COIL+`, `COIL-`, `COM` (común), `NO` (normalmente abierto), `NC` (normalmente cerrado).

**Modelo SPICE:**
```
* Coil: resistencia + inductancia con diodo flyback integrado
R_coil COIL+ COIL- 70
L_coil COIL+ COIL- 20m
D_fly COIL- COIL+ D1N4148            ; flyback integrado (opcional por propiedad)
* Contactos: conmutados por el voltaje de la bobina
.model RELAY_SW SW(Vt=3 Vh=0.5 Ron=0.05 Roff=1G)
S_no  COM NO COIL+ COIL- RELAY_SW off
S_nc  COM NC COIL+ COIL- RELAY_SW
```

El switch `S` de ngspice tiene histéresis nativa vía `Vt` / `Vh` — esto evita oscilación cuando V(COIL) cruza el umbral.

**Propiedades expuestas:**
- `coil_voltage` (V) — voltaje nominal de activación (5V, 12V, 24V)
- `coil_resistance` (Ω) — afecta corriente requerida
- `include_flyback` (bool) — si se incluye el diodo integrado

### 1.2 Optoacopladores (4N25, PC817)

**Pins:** `AN` (anodo LED), `CAT` (cátodo LED), `COL` (colector phototransistor), `EMIT` (emisor).

**Modelo SPICE:**
```
* LED del optoacoplador (IR, Vf ≈ 1.2V)
D_led AN _led_mid DLED_OPTO
V_sense _led_mid CAT DC 0       ; 0V para medir I_LED
* Phototransistor: CCCS con CTR (Current Transfer Ratio)
F_pt COL EMIT V_sense ${CTR}
* Saturación del phototransistor: limita I_C a ~50 mA
R_pt_leak COL EMIT 100Meg
.model DLED_OPTO D(Is=1e-14 N=2 Rs=5)
```

- **4N25:** CTR = 0.5 (50%)
- **PC817:** CTR = 1.0 (100%, rangos 80–600% típicos)

### 1.3 74HC logic ICs

Primer caso de "un componente = múltiples gates en un package de 14 pines".

| IC | Contenido | Pins (1..14) |
|---|---|---|
| `ic-74hc00` | 4× NAND 2-input | 1A,1B,1Y,2A,2B,2Y,GND,3Y,3A,3B,4Y,4A,4B,VCC |
| `ic-74hc04` | 6× NOT            | 1A,1Y,2A,2Y,3A,3Y,GND,4Y,4A,5Y,5A,6Y,6A,VCC |
| `ic-74hc08` | 4× AND 2-input    | 1A,1B,1Y,2A,2B,2Y,GND,3Y,3A,3B,4Y,4A,4B,VCC |
| `ic-74hc32` | 4× OR  2-input    | 1A,1B,1Y,2A,2B,2Y,GND,3Y,3A,3B,4Y,4A,4B,VCC |
| `ic-74hc14` | 6× Schmitt NOT    | 1A,1Y,2A,2Y,3A,3Y,GND,4Y,4A,5Y,5A,6Y,6A,VCC |

**Mapper emite 4 o 6 tarjetas B-source** (una por gate) reutilizando las expresiones de fase 9.1:
```
B_${id}_1 1Y 0 V = Vcc * (1 - u(V(1A)-T)*u(V(1B)-T))
R_${id}_1_load 1Y 0 1Meg
B_${id}_2 2Y 0 V = ...
... (3 más)
```

El Schmitt (74HC14) añade histéresis: umbral rising = 0.6·Vcc, falling = 0.4·Vcc. Implementado con una resistencia de realimentación al input:
```
B_${id}_1 1Y 0 V = Vcc * (1 - u(V(1A) - (V(1Y) > Vcc/2 ? 0.4*Vcc : 0.6*Vcc)))
```

### 1.4 Flip-flops (digital-sim only)

**Pins (D-FF):** `D`, `CLK`, `Q`, `Qbar`
**Pins (JK-FF):** `J`, `K`, `CLK`, `Q`, `Qbar`
**Pins (T-FF):** `T`, `CLK`, `Q`, `Qbar`

Edge detection requiere comparar el estado previo del CLK contra el actual. En `PartSimulationRegistry`:

```typescript
register('flip-flop-d', {
  attachEvents: (element, simulator, getPin) => {
    let prevClk = false;
    let q = false;
    const pinCLK = getPin('CLK');
    const pinD = getPin('D');
    const pinQ = getPin('Q');
    const pinQbar = getPin('Qbar');
    // ... listeners detect rising edge of CLK → sample D into Q
  },
});
```

**SPICE:** NO se implementa mapper para FFs — edge detection en `.op` no es posible y `.tran` con sample-and-hold requeriría `ddt()` / sistemas más complejos. Los usuarios que necesiten FFs reales usan ICs como 74HC74 (más adelante, fase 11).

### 1.5 L293D motor driver dual H-bridge

**Pins (16, pero funcional: 8 por canal):** `EN1`, `IN1`, `IN2`, `OUT1`, `OUT2`, `EN2`, `IN3`, `IN4`, `OUT3`, `OUT4`, `VCC1` (lógica), `VCC2` (motor), `GND.1`..`GND.4`.

**Modelo SPICE (por canal):**
```
* Canal 1: si EN1 HIGH, OUT1 sigue a IN1 (HIGH/LOW) con V = Vcc2
B_${id}_ch1a OUT1 0 V = u(V(EN1)-Vcc/2) * (u(V(IN1)-Vcc/2) * Vcc2 + (1-u(V(IN1)-Vcc/2))*0)
B_${id}_ch1b OUT2 0 V = u(V(EN1)-Vcc/2) * (u(V(IN2)-Vcc/2) * Vcc2 + (1-u(V(IN2)-Vcc/2))*0)
R_ch1a_load OUT1 0 1Meg
R_ch1b_load OUT2 0 1Meg
```

Cuando EN = LOW, los outputs flotan (alta impedancia) — representado con una resistencia débil a tierra.

---

## 2. Plan de ejecución

### Fase 10.1 — Relé (1 día)

1. Mapper SPICE emite 5 cartas (R_coil, L_coil, D_fly opcional, 2× S switch).
2. Web Component: dibujo schematic con bobina + contactos NC/NO.
3. Metadata: pinCount=5, categoría `electromech` (categoría nueva).
4. Añadir `'electromech'` a `ComponentCategory` y `displayNames`.
5. Tests sandbox: (a) relé en reposo (contactos NC cerrados), (b) relé energizado (contactos NO cerrados), (c) histéresis (V_COIL justo debajo del threshold no activa).

### Fase 10.2 — Optoacopladores (1 día)

1. Mapper SPICE: diodo LED + V-sense + F-source con CTR.
2. Web Component: DIP-4 con divisor visual entre LED y phototransistor.
3. Metadata: 4N25 y PC817, categoría `analog`.
4. Tests: (a) LED off → I_C ≈ 0, (b) LED forward biased → I_C ≈ CTR · I_LED.

### Fase 10.3 — 74HC ICs (2 días)

1. Mapper emite 4 (o 6 para 74HC04/14) B-sources.
2. Web Component: rectángulo DIP-14 con label del part number.
3. Metadata: 5 ICs nuevos, categoría `logic`.
4. Tests: truth table completa para cada gate del package.

### Fase 10.4 — Flip-flops (1 día)

1. Helper genérico `edgeTriggeredFF(inputsLogic)` en `LogicGateParts.ts`.
2. Registrar `flip-flop-d`, `flip-flop-jk`, `flip-flop-t`.
3. Web Component: rectángulo con inputs en la izquierda, Q/Qbar a la derecha, triángulo de clock inverter en CLK.
4. Metadata: pinCount según tipo.
5. Tests digital-sim: secuencia de CLK pulses + verificar transiciones de Q.

### Fase 10.5 — L293D (1–2 días)

1. Mapper emite 4 B-sources + 4 pull-downs (1 por output).
2. Web Component: DIP-16 con labels.
3. Metadata: pinCount=16.
4. Tests: (a) EN=LOW → outputs en alta-Z, (b) EN=HIGH, IN=HIGH → OUT a V_motor, (c) combinaciones forward/reverse/brake.

---

## 3. Criterios de aceptación

- [ ] Cada mapper nuevo pasa un test `.op` en < 1 s (el test de componentToSpice "minimal fixtures" incluye todos).
- [ ] Cada componente tiene entrada en `_customComponents` con `category` válida.
- [ ] 74HC00 (4-NAND) produce la truth table correcta para LOS CUATRO gates en el mismo test.
- [ ] Relay S-switch histéresis verificada: V_COIL en banda muerta no cambia estado.
- [ ] Flip-flop D dispara solo en rising edge — test inyecta un level-HIGH sostenido de D y verifica que Q cambia sólo al próximo CLK edge.
- [ ] 0 errores `tsc --noEmit` en los nuevos archivos.
- [ ] `npm test` sandbox y frontend pasan con los nuevos tests.

## 4. Out-of-scope

- **74HC74** (D-FF real en IC): se hará como subcircuit de 2× FF en fase 11.
- **Audio-capable opamps** (NE5532, OPA1612): fase 11 o fase 12.
- **Motor con back-EMF / modelado mecánico**: se queda como `RL` estático — modelo mecánico completo (`J · dω/dt = k·I − τ_load`) excede el alcance del simulador eléctrico.
- **Contactores / SSR** (solid-state relays): variantes del relé básico; se añadirán si hay demanda.

## 5. Referencias

- [`phase_9_component_catalog_expansion.md`](phase_9_component_catalog_expansion.md) — fase previa
- [`autosearch/05_velxio_component_inventory.md`](../autosearch/05_velxio_component_inventory.md) — gap analysis
- [`autosearch/06_ngspice_convergence.md`](../autosearch/06_ngspice_convergence.md) — gotchas conocidos
- ngspice manual §B.4 "S-switch" (histéresis Vt/Vh)
- ngspice manual §B.2 "F-source" (CCCS para optoacopladores)

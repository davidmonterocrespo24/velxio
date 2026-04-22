# Hallazgos — sesión 2026-04-15

## Resumen ejecutivo

Se construyó un sandbox bajo `test/test_circuit/` que valida end-to-end la emulación de circuitos analógicos + digitales + Arduino real vía `avr8js`. **25 tests pasan** en ~2.9 s. La propuesta del `plan1.md` (ngspice WASM, 40 MB) puede **reemplazarse por un solver MNA en JS puro** de ~500 líneas con resultados correctos en los casos probados.

## Lo que funciona

### Solver DC/transitorio (src/solver/)

- **MNA (Modified Nodal Analysis)** con eliminación gaussiana de pivote parcial.
- Ground implícito (no aparece en la matriz).
- Ruido numérico controlado con `G_min = 1e-12 S` en diagonal.
- **Newton-Raphson** iterativo para no-lineales (diodo / LED / BJT), con:
  - límite SPICE-style `pnjlim` para evitar `exp()` overflow en la primera iteración.
  - damping adaptativo (max 0.5 V por paso por nodo).
  - convergencia < 1 µV en 3–8 iteraciones típicas.
- **Transitorio** con backward Euler (método de companion para el capacitor). La clave: **no ejecutar `solveDC()` inicial antes del primer paso**, porque con capacitores abiertos en DC se calcula un estado falso que luego queda como `V_prev`. En su lugar, sembrar `prev` desde `Vinit`.

### Componentes implementados

| Categoría | Componentes |
|---|---|
| Pasivos lineales | Resistor, VoltageSource, CurrentSource, Potentiometer, Switch |
| Pasivos dinámicos | Capacitor (backward Euler) |
| No-lineales | Diode (Shockley), LED (5 colores), BJT_NPN (Ebers-Moll simplificado) |
| Paramétricos | NTCThermistor (modelo β) |

### Integración avr8js ≡ Velxio

Se copió fielmente el patrón de Velxio:
- `new CPU(program, 8192)`, `new AVRIOPort(cpu, portXConfig)`, `new AVRADC(cpu, adcConfig)`, `new AVRTimer(cpu, timerXConfig)`.
- Listeners por puerto → mapeo `(portName, bit) → Arduino pin`.
- `adc.channelValues[ch] = volts` para inyectar voltajes en tiempo real.
- `cpu.data[ocrAddr]` para leer duty de PWM.

El test `avr_blink.test.js` carga la **misma `.hex` que usa Velxio** y dispara el mismo LED simulado con corriente real calculada por el solver. Funciona.

### E2E: potenciómetro → PWM → LED

| Wiper | V_A0 | PWM duty | I_LED | Brillo |
|---|---|---|---|---|
| 0 % | 0.00 V | 0.0 % | 0.00 mA | 0.000 |
| 25 % | 1.25 V | 24.7 % | 0.00 mA | 0.000 |
| 50 % | 2.50 V | 49.8 % | 3.26 mA | 0.163 |
| 75 % | 3.75 V | 74.9 % | 8.77 mA | 0.439 |
| 100 % | 5.00 V | 100.0 % | 14.38 mA | 0.719 |

El PWM duty cycle rastrea el wiper con < 1 % de error. La no-linealidad I–V del LED emerge naturalmente (por debajo de su knee no conduce).

### E2E: termistor NTC

Error máximo de recuperación de temperatura: **0.05 °C** en el rango 0-50 °C (β=3950). Prácticamente el error de redondeo del ADC de 10 bits.

## Lo que no se probó / gaps

- **Inductores** no se implementaron (no había casos de uso en el scope).
- **MOSFET** queda para una futura iteración (BJT alcanzó).
- **Análisis AC/frecuencia** (Bode, resonancia) — fuera del scope.
- **Co-simulación ciclo-a-ciclo** entre AVR y solver. Los tests resuelven el circuito una vez después de cada cambio de pin, no en cada ciclo. Para PWM se usa `duty · V_supply` como fuente equivalente, no la conmutación real → precisión aceptable para brillo medio, pero no modela ripple.

## Problemas encontrados (y solución)

### 1. Diodo explotaba en la primera iteración de Newton
- **Síntoma**: `Vd` saltaba a 5 V (apertura circuital cuando `gd ≈ 0` en iter 0). Siguiente iter: `exp(5/0.026) ≈ 1e84` → NaN.
- **Fix**: `pnjlim` dentro del stamp del diodo. Primera iteración: `Vd = min(Vd, Vcrit)` donde `Vcrit = nVt · ln(nVt / (√2 · Is))`. Iteraciones siguientes: paso logarítmico si `|ΔVd| > 2nVt`.

### 2. Capacitor no cargaba
- **Síntoma**: `V(τ)` era 5 V en vez de 3.16 V. El `solveDC()` inicial veía el cap abierto → `Vout=5V` → este estado se usaba como `V_prev`.
- **Fix**: `runTransient()` ahora siembra `state.prev` desde `capacitor.Vinit` directamente, sin llamar a `solveDC()` inicial.

### 3. ADC daba valores 0-3 en vez de 0-255
- **Síntoma**: leer `ADCH` con `ADMUX = 0x40` retornaba solo los top-2 bits del resultado 10-bit (derecha-ajustado por defecto).
- **Fix**: activar `ADLAR=1` → `ADMUX = 0x60`. Ahora `ADCH` contiene los 8 MSB.

### 4. Offsets RJMP incorrectos en programa hand-assembled
- **Síntoma**: loop saltaba a dirección equivocada tras añadir más instrucciones.
- **Fix**: cálculo manual cuidadoso. Cada `STS`/`LDS` ocupa 2 words. `RJMP k` salta a `PC+1+k`.

## Mejoras sugeridas para Velxio (main app)

1. **Adoptar este solver** para la simulación eléctrica en lugar de `ngspice-wasm`. Ventajas:
   - 0 KB de dependencia WASM (vs 40 MB)
   - Inicialización instantánea
   - Fácil extender con componentes custom de wokwi-elements

2. **LED brightness realista**. Actualmente Velxio muestra LEDs como on/off booleanos. Con el solver:
   - `led.brightness(state)` ∈ [0, 1] basado en corriente directa
   - El ajuste del brillo del componente wokwi-led puede hacerse con `--wokwi-led-brightness` CSS var o similar.

3. **Potenciómetro funcional**. El componente ya existe visualmente pero el wiper no afecta a nada. Con este solver:
   - `pot.setWiper(x)` → recalcular → inyectar V en `adc.channelValues[ch]`
   - Habilitar drag interactivo del wiper.

4. **Warnings al usuario**:
   - Si la corriente por un LED > 25 mA → overlay rojo "quemaría el LED".
   - Si un diodo queda en reverse breakdown → overlay amarillo.
   - Si no hay resistencia en serie con un LED → advertencia pre-simulación.

5. **Corridas en Web Worker** si el circuito supera ~50 componentes, para no bloquear la UI. El solver como está es ~3 ms por `solveDC()` con 10 componentes en Node → debería ser < 30 ms con 100 en browser.

## Performance (measurements en WSL2, Node 22)

| Suite | Tests | Duración |
|---|---|---|
| passive.test.js | 11 | 8 ms |
| transient_rc.test.js | 3 | 22 ms |
| diodes.test.js | 7 | 13 ms |
| avr_blink.test.js | 2 | 2.4 s (loop CPU real) |
| e2e_pot_pwm_led.test.js | 1 | 90 ms |
| e2e_thermistor.test.js | 1 | 121 ms |
| **Total** | **25** | **~2.9 s** |

Prácticamente todo el tiempo se va en avr8js ejecutando los 32 M de ciclos del blink. El solver de circuitos es irrelevante en el presupuesto.

## Próximos pasos recomendados

1. **Integrar** un wrapper del solver en `frontend/src/simulation/` (nuevo archivo `CircuitSolver.ts`).
2. **Conectar** con `useSimulatorStore.wires` y `components` para auto-construir el `Circuit` objeto.
3. **Hook** en `PinManager.onPinChange()` con debounce de 50 ms → `circuit.solveDC()`.
4. **Reutilizar** las fixtures de HEX que ya tiene `frontend/src/__tests__/fixtures/`.
5. **Añadir** MOSFET, Zener, op-amp ideal (GMIN stamping) cuando haya demanda.

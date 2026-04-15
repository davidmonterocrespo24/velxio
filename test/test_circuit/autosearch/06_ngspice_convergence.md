# ngspice — hallazgos de convergencia y gotchas (sesión 2026-04-15)

Documenta problemas numéricos observados al poblar el catálogo de componentes en fase 9. Complementa [`04_ngspice_findings.md`](04_ngspice_findings.md).

## 1. Caracteres no-ASCII en el título del netlist cuelgan ngspice

**Síntoma:** `runNetlist()` no resuelve ni falla — la promesa queda pendiente hasta que vitest la mata por timeout (30 s).

**Reproducción:**
```spice
3.3V GPIO → 2N7000 → 5V load
V_sys vsys 0 DC 5
Vgpio gate 0 DC 3.3
RL vsys drain 1k
M1 drain gate 0 0 M2N7000 L=2u W=200u
.model M2N7000 NMOS(Level=1 Vto=1.6 Kp=50u Lambda=0.01)
.op
.end
```

El `→` (U+2192) en la primera línea (título) es lo único que rompe el parser. Reemplazarlo por `to` o `->` hace que converja instantáneamente.

**Impacto:** silencioso — ngspice no emite error, no loggea nada, solo queda colgado. Un test que use unicode "decorativo" en el título parece un test roto a nivel numérico cuando en realidad es un problema de encoding.

**Mitigación:** regla de estilo — **solo ASCII en los títulos** `<header>` de los netlists. Los comentarios (`* ...`) y strings en B-sources (`V = ...`) sí aceptan unicode.

Añadir a `docs/wiki/circuit-emulation-gotchas.md`.

## 2. MOSFET Level=3 con W desmesurado causa hangs en `.op`

**Síntoma:** mismo que arriba — timeout sin error — pero por razones numéricas.

**Modelo problemático:**
```spice
.model M2N7000 NMOS(Level=3 Vto=1.6 Kp=0.1 Rd=1 Rs=0.5)
M1 drain gate 0 0 M2N7000 L=2u W=0.1
```

**Análisis:** `W=0.1` sin unidad en ngspice se interpreta como **0.1 metros** (100 mm de ancho de canal). Combinado con `L=2u` (= 2 µm) da un W/L absurdamente grande (50 000). Con `Kp=0.1 A/V²` y `V_ov=1.7 V`, la corriente teórica en saturación es de kiloamperios. Newton no converge; en algunas combinaciones de Vds bajo la resolución directa devuelve un resultado "por suerte" (los tests antiguos pasaban porque el drain estaba shunteado a 0 V y la corriente se limitaba por el resistor externo).

**Mitigación adoptada en fase 9.2:** migrar a `Level=1` (Shichman-Hodges) con W/L físicamente razonable:

```spice
.model M2N7000  NMOS(Level=1 Vto=1.6 Kp=50u Lambda=0.01)   ; W=200u L=2u
.model MIRF540  NMOS(Level=1 Vto=3   Kp=20u Lambda=0.01)   ; W=2m  L=2u (power)
.model MIRF9540 PMOS(Level=1 Vto=-3  Kp=20u Lambda=0.01)   ; W=2m  L=2u
.model MFQP27P06 PMOS(Level=1 Vto=-2.5 Kp=50u Lambda=0.01) ; W=500u L=2u
```

Level-1 es menos preciso (sin short-channel effects, sin body-effect moderno) pero es **numéricamente robusto** y basta para circuitos didácticos: switches, drivers, inversores lógicos.

## 3. Salidas flotantes del B-source hacen matrix singular

**Síntoma:** ngspice logga "matrix is singular" (no cuelga — falla rápido).

**Reproducción:** una compuerta lógica cuya salida Y no esté conectada a ningún otro elemento:
```spice
Va a 0 DC 5
Vb b 0 DC 5
Bg1 y 0 V = 5 * u(V(a)-2.5) * u(V(b)-2.5)
.op
```

**Causa:** la B-source define `V(y) = f(...)` pero ngspice aún necesita ver al menos un elemento conectado a Y (caso contrario la ecuación KCL en Y es `0 = 0` → rango deficiente).

**Mitigación adoptada:** cada mapper de gate emite también una resistencia de pull-down de 1 MΩ:
```
R_${id}_load y 0 1Meg
```

1 MΩ es suficientemente alto como para no afectar la tensión en Y (la B-source la impone con impedancia cero) y suficientemente bajo como para que ngspice tenga camino DC.

## 4. Función `tanh()` puede o no estar disponible según build de ngspice-wasm

**Síntoma:** el test del Schmitt trigger con `V = 10 * tanh(1e5*V(p))` converge pero el output queda estático en cualquier rail — no refleja la entrada.

**Mitigación:** usar directamente la función step `u()` disponible en todos los builds:
```
V = 20 * u(V(p)) - 10       ; == +10 si V(p)>0, -10 si no
```

Evitamos `tanh`, `sin`, funciones hiperbólicas salvo que una prueba standalone confirme soporte.

## 5. Valores absolutos de Is para LEDs ajustados al Vf empíricamente

En `componentToSpice.ts` existen modelos LED_RED/LED_GREEN/etc. con `Is=1e-20 … 1e-28` y N=1.7..2.0. Estos valores **son correctos para dar Vf realista** a 10 mA (datasheets típicos), pero están al límite de la precisión float64: en `.op` con drive agresivo (p.ej. 5V directo con 40Ω de serie) el Newton puede cebar con `V_d > 5V` → `exp(V_d/(N·VT))` overflow → cuelgue.

**Mitigación:**
- Siempre incluir `Rs>0` en el modelo (limita `exp()` vía `V_d → V_d - I·Rs`).
- Alternativamente, subir Is a `1e-14` (diodo estándar) perdiendo tuning de Vf exacto — aceptable en sistemas donde "encenderse / no encenderse" importa más que el Vf medido.

## 6. Checklist de un mapper nuevo

Antes de fusionar un mapper SPICE:

- [ ] Título del netlist **solo ASCII**.
- [ ] Salida del componente tiene camino DC a 0 (resistencia pull-down, otro elemento, o canonicalización a `0`/`vcc_rail`).
- [ ] MOSFETs usan `Level=1` con W/L físicamente razonable (`W ≤ 10 mm`, `W/L` entre 10 y 10 000).
- [ ] Modelo no-lineal tiene `Rs>0` y `Rc>0` si aplica.
- [ ] `.op` converge en < 1 s en una topología mínima (V-source + resistencia + DUT).
- [ ] Truth table / behavior verificado con ngspice real en `test/test_circuit/test/`.

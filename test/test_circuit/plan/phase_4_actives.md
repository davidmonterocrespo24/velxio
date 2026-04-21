# Fase 4 — Componentes activos

## Modelo de diodo / LED (Shockley)

```
I_d = Is · (exp(V_d / (n · Vt)) − 1)
Vt = 25.85 mV @ 300 K
```

Linealización en cada iteración de Newton:

```
gd  = (Is / (n·Vt)) · exp(V_d_prev / (n·Vt))
Ieq = I_d(V_d_prev) − gd · V_d_prev
```

Stamp:
- G[a,a] += gd, G[b,b] += gd, G[a,b] −= gd, G[b,a] −= gd
- b[a] −= Ieq, b[b] += Ieq

## Parámetros típicos

| LED color | Is (A) | n | V_forward @ 10 mA |
|---|---|---|---|
| rojo | 1e-20 | 1.7 | ~2.0 V |
| verde | 1e-22 | 1.9 | ~2.2 V |
| azul / blanco | 1e-24 | 2.0 | ~3.2 V |

## BJT (Ebers-Moll, simplificado)

```
I_c = Is · (exp(V_be / Vt) − exp(V_bc / Vt)) − (1/β_r) · Is · (exp(V_bc/Vt) − 1)
I_b = Is/β_f · (exp(V_be / Vt) − 1) + Is/β_r · (exp(V_bc / Vt) − 1)
```

## Tests

1. **LED rojo con R=220Ω, V=5V** → esperamos `V_LED ≈ 2.0 V`, `I ≈ 13.6 mA`
2. **LED azul con R=220Ω, V=5V** → `V_LED ≈ 3.2 V`, `I ≈ 8.2 mA`
3. **Diodo rectificador en serie con R** → caída ≈ 0.6 V
4. **Transistor NPN como switch** (base vía R=10k) → `V_CE < 0.2 V` cuando ON
5. **Amplificador emisor común** (opcional) — verificar ganancia en pequeña señal

## Archivos

- `test/diodes.test.js`
- `test/bjt.test.js` (opcional / si alcanza tiempo)

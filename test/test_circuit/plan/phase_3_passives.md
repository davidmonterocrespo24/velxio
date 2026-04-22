# Fase 3 — Componentes pasivos

## Tests planificados

1. **Divisor de voltaje** — `R1=1k, R2=2k, V=9V` → `V_out = 9 · 2k/(1k+2k) = 6 V`
2. **Ley de Ohm** — `R=220, V=5V` → `I = 5/220 = 22.7 mA`
3. **Serie / paralelo** — 3 resistencias en paralelo: `R_eq = R/n`
4. **RC charging** — `R=10k, C=100µF, V=5V` → `V(τ) = 5 · (1 − 1/e) ≈ 3.16 V` en `t=1s`
5. **Filtro pasa-bajos RC** — respuesta escalón
6. **Potenciómetro** — wiper al 50 % con `R_pot=10k, V=5V` → salida 2.5 V
7. **Termistor NTC (10k, β=3950)** — `R(25°C)=10k`, `R(50°C)≈3.6k`, `R(0°C)≈27.3k`

## Criterios de aceptación

- Error < 0.5 % en DC
- Error < 2 % en el paso transitorio a `t = τ`

## Archivos

- `test/passive.test.js` — casos arriba
- `test/transient_rc.test.js` — respuesta RC con varios `dt`

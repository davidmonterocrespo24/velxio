# Fase 0 — Alcance de la campaña

## Objetivo

Probar que podemos emular circuitos completos (analógicos + digitales + Arduino) en JavaScript puro, validando el enfoque antes de integrarlo en Velxio. El plan1.md propone usar ngspice-WASM (40 MB); esta campaña explora una alternativa **nativa JS** más ligera.

## No es objetivo

- Producir código listo para producción (es sandbox de pruebas).
- Reemplazar a ngspice en precisión numérica para circuitos analógicos complejos.
- Cubrir todos los componentes de wokwi-elements.

## Éxito =

1. Solver DC (MNA) resuelve redes con R, V, I, diodo, LED, termistor, potenciómetro con error < 1 % vs valor analítico conocido.
2. Solver transitorio resuelve RC charging, filtro pasa-bajos con error < 5 % vs solución analítica en t = τ.
3. Integración con `avr8js` (igual que Velxio) ejecuta una .hex real y el solver responde al estado de pines en cada frame.
4. Caso end-to-end: potenciómetro → `analogRead(A0)` → `analogWrite(9, val/4)` → brillo de LED varía monótonamente con la posición del potenciómetro.
5. Caso end-to-end: termistor NTC + divisor → lectura ADC corresponde a una temperatura esperada vía Steinhart-Hart.

## Riesgos / supuestos

- **avr-gcc no instalado** — los sketches se ensamblan a mano o se usa HEX pre-compilada cometida (pequeña).
- **Precisión numérica** — MNA-DC con Newton-Raphson para diodos puede no converger en topologías patológicas. Aceptamos fallos y los documentamos.
- **Co-simulación AVR ↔ circuito** — se hace en modo cuasi-estático (solver recalcula cuando cambian pines o cada N ms), no ciclo a ciclo.

## Plazo

Sesión única. Todo código generado bajo `test/test_circuit/`.

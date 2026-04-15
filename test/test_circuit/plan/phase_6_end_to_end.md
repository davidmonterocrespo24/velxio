# Fase 6 — Pruebas end-to-end

## E2E-1: Potenciómetro → PWM → brillo LED

### Topología

```
       +5V ─┬──── pot_top
            │
            R_pot_top (variable)
            │
            ├──── A0  (canal 0 del ADC)
            │
            R_pot_bot (variable = 10k - R_pot_top)
            │
       GND ─┴──── pot_bot

       Pin 9 (PWM) ─── R_series=220Ω ─── LED_anode
       LED_cathode ──── GND
```

### Sketch (lógica)

```c
void setup() { pinMode(9, OUTPUT); }
void loop() {
  int v = analogRead(A0);          // 0..1023
  analogWrite(9, v >> 2);           // 0..255
}
```

### Expected

- Wiper al 0 %  → `ADC=0`  → PWM duty 0 %   → corriente LED ≈ 0 mA
- Wiper al 50 % → `ADC≈512` → PWM duty 50 % → V_pin9_avg = 2.5 V → corriente ≈ 2.27 mA
- Wiper al 100 %→ `ADC=1023` → PWM duty ~100 % → corriente ≈ 13.6 mA (rojo, 220Ω)

### Verificación

Monótonamente creciente: `I(wiper=0) < I(wiper=50) < I(wiper=100)`.

## E2E-2: Termistor NTC → lectura de temperatura

### Topología

```
       +5V ─── R_pullup=10kΩ ─┬─── A0
                               │
                               NTC (10k, β=3950)
                               │
       GND ─────────────────────
```

### Sketch (lógica)

```c
void loop() {
  int raw = analogRead(A0);
  // V_A0 = 5 · raw/1023
  // R_ntc = 10k · V_A0 / (5 − V_A0)
  // T = 1 / (1/298.15 + (1/β) · ln(R_ntc/10k))
}
```

### Expected

| T ambiente | R_ntc | V_A0 | ADC raw |
|---|---|---|---|
| 0 °C | 27.3 kΩ | 3.66 V | 749 |
| 25 °C | 10.0 kΩ | 2.50 V | 512 |
| 50 °C | 3.6 kΩ | 1.32 V | 270 |

### Verificación

- Para 3 valores de T, el ADC raw debe coincidir con la tabla ± 2 LSB.

## Archivos

- `test/e2e_pot_pwm_led.test.js`
- `test/e2e_thermistor.test.js`

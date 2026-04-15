# Fase 5 — Integración con avr8js

## Cómo Velxio usa avr8js

`frontend/src/simulation/AVRSimulator.ts`:

```typescript
this.cpu = new CPU(programUint16, sramBytes);
this.portB = new AVRIOPort(this.cpu, portBConfig);
this.adc = new AVRADC(this.cpu, adcConfig);
this.peripherals = [new AVRTimer(this.cpu, timer0Config), ...];

// En el loop:
avrInstruction(this.cpu);
this.cpu.tick();

// Inyectar voltaje analógico:
this.adc.channelValues[channel] = voltage; // 0–5V
```

Velxio dispara listeners de pines al escribir PORTB/C/D y enruta al PinManager. Los ADC se leen cuando el sketch hace `analogRead`.

## En la sandbox replicamos ese patrón

`src/avr/AVRHarness.js`:

- Carga .hex via `hexToUint8Array` (implementado localmente, mismo formato Intel HEX)
- Instancia `CPU`, `AVRIOPort`, `AVRADC`, `AVRTimer` igual que Velxio
- Expone `step(cycles)`, `setAnalogVoltage(channel, v)`, `getPin(arduinoPin)`, `onPinChange(pin, cb)`, `getPWMDuty(pin)`

## Puente circuito ↔ MCU

`src/bridge/CircuitAVRBridge.js`:

```
cada N ciclos (por defecto cada 1 ms):
  1. leer estado GPIO → actualiza VoltageSources del circuito
  2. leer duty PWM → actualiza V_pwm = Vcc · duty
  3. solveDC() del circuito
  4. inyectar voltajes de nodos conectados a pines ADC
```

## HEX files requeridos

Como no tenemos `avr-gcc` disponible, usamos:

- HEX **ensamblada a mano** para blink y programas simples
- HEX de `frontend/src/__tests__/fixtures/avr-blink/avr-blink.ino.hex` (copiada)
- Para el test de potenciómetro + PWM escribimos un loop AVR assembly mínimo que:
  1. Inicia ADC (ADMUX=0x40 para AVCC ref + canal 0; ADCSRA=0x87)
  2. Dispara conversión (set ADSC)
  3. Espera fin
  4. Escribe ADCH en OCR1AL (PWM timer1)
  5. Salta al paso 2

Ese programa cabe en ~30 instrucciones y se asembla manualmente a bytes.

## Archivos

- `src/avr/AVRHarness.js`
- `src/avr/intelHex.js`
- `src/bridge/CircuitAVRBridge.js`
- `test/avr_blink.test.js`
- `fixtures/blink.hex` — del fixture existente de Velxio
- `fixtures/pot_pwm.hex` — ensamblada a mano

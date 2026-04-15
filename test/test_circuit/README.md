# test_circuit — sandbox de emulación de circuitos

Sandbox para validar la emulación de circuitos analógicos + digitales + Arduino en JS puro antes de tocar Velxio.

## Estructura

```
test_circuit/
├── plan/                   # Documentos de planificación (fases 0–7)
├── src/
│   ├── solver/             # MNA hand-rolled (legacy, baseline)
│   ├── components/         # Modelos JS (legacy, baseline)
│   ├── avr/                # AVRHarness (avr8js estilo Velxio)
│   └── spice/              # SpiceEngine (ngspice-WASM) + AVRSpiceBridge
├── test/                   # Vitest tests
│   ├── passive.test.js               # baseline JS
│   ├── transient_rc.test.js          # baseline JS
│   ├── diodes.test.js                # baseline JS
│   ├── avr_blink.test.js             # avr8js con blink.hex
│   ├── e2e_pot_pwm_led.test.js       # baseline JS + avr8js
│   ├── e2e_thermistor.test.js        # baseline JS + avr8js
│   ├── ngspice_smoke.test.js         # ngspice boot
│   ├── spice_passive.test.js         # ngspice DC
│   ├── spice_transient.test.js       # ngspice .tran
│   ├── spice_ac.test.js              # ngspice .ac Bode
│   ├── spice_active.test.js          # diodo, BJT, MOSFET, op-amp
│   ├── spice_digital.test.js         # lógica behavioral
│   ├── spice_555_astable.test.js     # oscilador relajación
│   └── spice_avr_mixed.test.js       # co-simulación avr8js ↔ ngspice
├── fixtures/               # .hex pre-compilados / ensamblados a mano
├── autosearch/             # Hallazgos, métricas, propuestas
└── package.json
```

## Correr las pruebas

```bash
cd test/test_circuit
npm install
npm test
```

Por fase:

```bash
npm run test:phase3   # pasivos
npm run test:phase4   # activos (diodos)
npm run test:avr      # integración avr8js
npm run test:e2e      # end-to-end Arduino + circuito
```

## Alcance

Ver [plan/phase_0_scope.md](plan/phase_0_scope.md).

# Hallazgos — ngspice-WASM (sesión 2)

## Resultado

**47 tests, todos pasando en ~5 segundos** mezclando:
- DC op-point (pasivos, divisores)
- Transient (RC, RLC)
- AC / Bode (low-pass, bandpass)
- Dispositivos no-lineales (diodo, BJT, MOSFET, op-amp)
- Lógica digital behavioral (AND/NAND/XOR)
- Circuitos mixtos (lógica → RC filter)
- Osciladores de relajación (555 core)
- **Co-simulación avr8js ↔ ngspice** (NTC+sketch, PWM+RC, pot dinámico)

## Qué aprendimos

### eecircuit-engine es suficiente

- Importa limpio en Node: `import { Simulation } from 'eecircuit-engine'`.
- Boot único: ~400 ms. Cada simulación: 5–500 ms.
- Serializable: un solo netlist por call, respuesta asíncrona.
- No hay `.reset()` pero `setNetList` + `runSim` es idempotente si el netlist está limpio.
- Soporta `.op` `.tran` `.ac` `.dc` sin problema.

### Tamaño

- `node_modules/eecircuit-engine/` = 39 MB
- En Velxio (browser) esto es muchísimo — debe cargarse **lazy** y **solo cuando el usuario activa "simulación eléctrica"**.
- El módulo incluye WASM + glue JS. Puede servirse con CDN / caché de navegador para primer load < 5s en banda ancha.

### B-sources (behavioral) son la clave para mixed-signal

ngspice no tiene compuertas lógicas como primitivas (en este build sin XSPICE). Pero con `B1 y 0 V = expresión`, podemos modelar cualquier compuerta:
```
Band y 0 V = 5 * u(V(a)-2.5) * u(V(b)-2.5)
```
donde `u(x)` es step de Heaviside. Gates, comparadores, ALUs — todo se expresa así.

### Trampa: `&` no es AND

En B-source de ngspice:
- `&` = bitwise AND (ints). En nuestra primera versión, `V(a) > 2.5 & V(b) > 2.5` se colgó.
- Usar **productos de `u()`**  es más portable: `u(V(a)-2.5) * u(V(b)-2.5)`.

### Trampa: matriz singular

Si dejas un nodo sin camino DC (ej. capacitor en serie con un resistor → nodo interior flota en `.op`), ngspice entra en un **loop de recovery** (gmin stepping → source stepping → retry) que puede tomar > 60 s antes de fallar. **Fix**: añadir un resistor de alta impedancia (10 MΩ) al nodo. En Velxio, el parser debería detectar esta topología y añadir el pull-down automáticamente.

### Trampa: switch con histéresis

`.model SMOD SW(Vt=2.5 Vh=0.833 Ron=100 Roff=1G)` es la forma más compacta de crear un flip-flop analógico. El switch retiene su estado entre `Vt−Vh` y `Vt+Vh`, lo cual ES memoria. Sin esto no podemos hacer relaxation oscillators ni SR latches en behavioral.

## Performance por tipo de análisis

| Análisis | Circuito | Tiempo por `runSim` |
|---|---|---|
| `.op` (R/V/I solamente) | 3–5 componentes | ~5–10 ms |
| `.op` con diodo / BJT | 5–10 componentes | 20–50 ms |
| `.tran` 3 ms con R/C/switch | 10 componentes | 100–300 ms |
| `.tran` 20 ms con switches | 555-core | ~400 ms |
| `.ac dec 20 10 1Meg` | RC filter | ~10 ms |
| Bridge rectifier 40 ms | 4 diodos + cap | ~300 ms |

Boot inicial: 400 ms (una sola vez por proceso).

## Propuesta de integración en Velxio

### Cambios mínimos

1. `frontend/package.json` añadir `"eecircuit-engine": "^1.7.0"` (40 MB, lazy-load).
2. Nuevo `frontend/src/simulation/SpiceEngine.ts` espejo del `SpiceEngine.js` de este sandbox.
3. Nuevo `frontend/src/simulation/NetlistBuilder.ts`:
   - Entrada: `wires[]` + `components[]` del store.
   - Salida: string netlist ngspice.
   - Union-Find sobre wires → nets.
   - Mapeo `metadataId` → primitiva ngspice (ver tabla abajo).
4. `useSimulatorStore` añade `spiceResults: ResultType | null` y `runSpice: () => Promise<void>`.
5. Hook en `PinManager.onPinChange()` debounce 50 ms → build netlist → run → inyectar ADC.
6. Toggle en toolbar `⚡ Simulación eléctrica` (off por defecto para no costar 40 MB a todos).

### Tabla de mapeo

| `metadataId` Velxio | Elemento ngspice | Nota |
|---|---|---|
| `resistor` | `R<id> n1 n2 <value>` | |
| `resistor-us` | idem | |
| `capacitor` | `C<id> n1 n2 <value>` | |
| `inductor` | `L<id> n1 n2 <value>` | |
| `led` | `D<id> a c LED_<color>` + `.model LED_RED D(Is=…)` | Brillo = `|i(d)|/0.02` |
| `diode` | `D<id> a c DMOD` | |
| `pushbutton` (pressed) | resistor 10 mΩ | else 1 GΩ |
| `slide-potentiometer` | dos R con `wiperPos` | |
| `ntc-temperature-sensor` | R con valor calculado vía β | |
| `photoresistor` | R dependiente de `lux` | |
| `arduino pin` HIGH/LOW | `V<id> pin 0 DC {5|0}` | |
| `arduino pin` PWM | `V<id> pin 0 DC {duty*5}` (quasi-static) | |

### Caveat

Componentes que NO tienen modelo eléctrico (LCD, NeoPixel, motor, servomotor) se ignoran en el netlist — siguen teniendo su lógica propia fuera del solver.

## Pendientes / futuro

- Probar que el mismo flujo funciona en **browser** (no solo Node). Requiere bundler que soporte el `.wasm` de eecircuit-engine (Vite debería funcionar, ya lo usa Velxio).
- Medir el peso del bundle + WASM en producción de Velxio.
- Implementar warnings automáticos (LED quemado, corto, nodo flotante) desde los resultados de ngspice.
- Componentes XSPICE (compuertas, FFs) — chequear si `eecircuit-engine` los incluye compilados; si no, contribuir aguas arriba.
- Subcircuits `.subckt` para encapsular op-amps, transistor packs, etc.

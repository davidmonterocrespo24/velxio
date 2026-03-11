# Wokwi Libraries Integration

Este proyecto utiliza los repositorios oficiales de Wokwi clonados localmente, lo que permite mantenerlos actualizados y compatibles con las últimas versiones. Los repositorios locales alimentan tanto la emulación AVR como el sistema dinámico de componentes con 48+ elementos electrónicos.

## Repositorios Clonados

### wokwi-elements
- **Ubicación**: `wokwi-libs/wokwi-elements/`
- **Descripción**: Web Components (Lit) para 48+ elementos electrónicos (LEDs, resistencias, botones, LCDs, sensores, etc.)
- **Repositorio**: https://github.com/wokwi/wokwi-elements
- **Licencia**: MIT
- **Uso actual**: Renderizado visual de todos los componentes en el canvas de simulación. Un script de generación de metadata (`scripts/generate-component-metadata.ts`) parsea el código fuente TypeScript para descubrir automáticamente todos los componentes, sus propiedades y pines.

### avr8js
- **Ubicación**: `wokwi-libs/avr8js/`
- **Descripción**: Emulador completo de microcontroladores AVR8 (ATmega328p) en JavaScript
- **Repositorio**: https://github.com/wokwi/avr8js
- **Licencia**: MIT
- **Uso actual**: Emulación real del CPU a 16MHz, con Timer0/1/2, USART, ADC, y puertos GPIO (PORTB/C/D). Ejecuta ~267,000 ciclos por frame a ~60fps.

### rp2040js
- **Ubicación**: `wokwi-libs/rp2040js/`
- **Descripción**: Emulador de Raspberry Pi Pico (RP2040) en JavaScript
- **Repositorio**: https://github.com/wokwi/rp2040js
- **Licencia**: MIT
- **Uso**: Clonado para futuro soporte de Raspberry Pi Pico

### wokwi-features
- **Ubicación**: `wokwi-libs/wokwi-features/`
- **Descripción**: Documentación y tracking de features de Wokwi
- **Repositorio**: https://github.com/wokwi/wokwi-features

## Configuración del Proyecto

### Frontend (Vite)

El archivo `frontend/vite.config.ts` está configurado para usar los repositorios locales mediante aliases:

```typescript
resolve: {
  alias: {
    'avr8js': path.resolve(__dirname, '../wokwi-libs/avr8js/dist/esm'),
    '@wokwi/elements': path.resolve(__dirname, '../wokwi-libs/wokwi-elements/dist/esm'),
  },
},
optimizeDeps: {
  include: ['avr8js', '@wokwi/elements'],
}
```

El archivo `frontend/package.json` referencia los paquetes locales:

```json
{
  "dependencies": {
    "@wokwi/elements": "file:../wokwi-libs/wokwi-elements",
    "avr8js": "file:../wokwi-libs/avr8js"
  }
}
```

### Generación Automática de Metadata

El script `scripts/generate-component-metadata.ts` parsea el código fuente de wokwi-elements usando AST de TypeScript para extraer:
- Nombre del tag (`@customElement('wokwi-led')` → `wokwi-led`)
- Propiedades (`@property()` decorators → tipo, valor por defecto)
- Cantidad de pines
- Categoría, descripción y tags

El resultado se almacena en `frontend/public/components-metadata.json` y es consumido por el `ComponentRegistry` en tiempo de ejecución.

## Actualizar las Librerías de Wokwi

Para mantener tu proyecto actualizado con las últimas versiones de Wokwi:

### Opción 1: Actualizar todas las librerías (Recomendado)

```bash
# Script para actualizar todos los repositorios
update-wokwi-libs.bat
```

### Opción 2: Actualizar manualmente cada repositorio

```bash
cd wokwi-libs

# Actualizar wokwi-elements
cd wokwi-elements
git pull origin main
npm install
npm run build

# Actualizar avr8js
cd ../avr8js
git pull origin main
npm install
npm run build

# Actualizar rp2040js
cd ../rp2040js
git pull origin main
npm install
npm run build
```

### Opción 3: Actualizar a una versión específica

```bash
cd wokwi-libs/wokwi-elements

# Ver versiones disponibles
git tag -l

# Cambiar a una versión específica
git checkout v1.9.2

# Recompilar
npm install
npm run build
```

### Después de Actualizar wokwi-elements

Si actualizaste wokwi-elements, regenera la metadata de componentes para que nuevos componentes aparezcan en la UI:

```bash
cd frontend
npx tsx ../scripts/generate-component-metadata.ts
```

## Script de Actualización Automática

El script `update-wokwi-libs.bat` facilita las actualizaciones:

```batch
@echo off
echo ========================================
echo Actualizando Wokwi Libraries
echo ========================================

cd wokwi-libs

echo [1/3] Actualizando wokwi-elements...
cd wokwi-elements
git pull origin main
npm install
npm run build
cd ..

echo [2/3] Actualizando avr8js...
cd avr8js
git pull origin main
npm install
npm run build
cd ..

echo [3/3] Actualizando rp2040js...
cd rp2040js
git pull origin main
npm install
npm run build
cd ..

echo ========================================
echo Actualizacion completada!
echo ========================================
pause
```

## Cómo Se Usan las Librerías

### avr8js — Emulación AVR

El `AVRSimulator` (`frontend/src/simulation/AVRSimulator.ts`) usa avr8js para crear:

```typescript
import { CPU, avrInstruction, AVRTimer, AVRUSART, AVRADC, AVRIOPort } from 'avr8js';

// CPU ATmega328p a 16MHz
const cpu = new CPU(programMemory);

// Periféricos
const timer0 = new AVRTimer(cpu, timer0Config);
const timer1 = new AVRTimer(cpu, timer1Config);
const timer2 = new AVRTimer(cpu, timer2Config);
const usart  = new AVRUSART(cpu, usart0Config, CLOCK);
const adc    = new AVRADC(cpu, adcConfig);
const portB  = new AVRIOPort(cpu, portBConfig);  // pins 8-13
const portC  = new AVRIOPort(cpu, portCConfig);  // A0-A5
const portD  = new AVRIOPort(cpu, portDConfig);  // pins 0-7

// Loop de simulación (~60fps)
function runFrame() {
  const cyclesToRun = Math.floor(267000 * speed);
  for (let i = 0; i < cyclesToRun; i++) {
    avrInstruction(cpu);  // Ejecuta instrucción AVR
    cpu.tick();            // Actualiza periféricos
  }
  requestAnimationFrame(runFrame);
}
```

### wokwi-elements — Componentes Visuales

Los componentes se renderizan de dos formas:

**1. DynamicComponent (sistema actual — 48 componentes)**

```typescript
import { ComponentRegistry } from './services/ComponentRegistry';

// Carga metadata desde /components-metadata.json
const registry = ComponentRegistry.getInstance();
const metadata = registry.getById('led');

// DynamicComponent crea el web component dinámicamente
// document.createElement(metadata.tagName) → <wokwi-led>
// Sincroniza propiedades React → web component
// Extrae pinInfo del DOM para wire connections
```

**2. React wrappers legacy (5 componentes)**

```tsx
// ArduinoUno.tsx — sigue en uso activo para el board principal
<wokwi-arduino-uno ref={ref} led13={led13} />
```

### PartSimulationRegistry — Comportamientos de Simulación

16 partes tienen lógica de simulación registrada que conecta los web components con el emulador AVR:

| Parte | Tipo | Comportamiento |
|-------|------|----------------|
| `led` | Output | Pin state → `element.value` |
| `rgb-led` | Output | Digital + PWM en R/G/B |
| `led-bar-graph` | Output | 10 LEDs independientes |
| `7segment` | Output | 8 segmentos (A-G + DP) |
| `pushbutton` | Input | Press/release → `setPinState()` |
| `pushbutton-6mm` | Input | Mismo que pushbutton |
| `slide-switch` | Input | Change event → pin state |
| `dip-switch-8` | Input | 8 switches independientes |
| `potentiometer` | Input | Valor → voltaje ADC |
| `slide-potentiometer` | Input | Misma lógica por SIG/OUT |
| `photoresistor-sensor` | Input/Output | Voltaje analógico + LED digital |
| `analog-joystick` | Input | VRX/VRY (ADC) + SW (digital) |
| `servo` | Output | Registros OCR1A/ICR1 → ángulo 0-180° |
| `buzzer` | Output | Web Audio API + Timer2 |
| `lcd1602` | Output | Protocolo HD44780 4-bit completo (16×2) |
| `lcd2004` | Output | Protocolo HD44780 4-bit completo (20×4) |

## Componentes Wokwi Disponibles (48)

### Boards (4)
- `wokwi-arduino-uno` — Arduino Uno R3
- `wokwi-arduino-mega` — Arduino Mega 2560
- `wokwi-arduino-nano` — Arduino Nano
- `wokwi-esp32-devkit-v1` — ESP32 DevKit v1

### Sensors (6)
- `wokwi-dht22` — Temperatura y humedad
- `wokwi-hc-sr04` — Ultrasónico de distancia
- `wokwi-pir-motion-sensor` — Sensor de movimiento PIR
- `wokwi-photoresistor-sensor` — Fotoresistor (LDR)
- `wokwi-ntc-temperature-sensor` — Sensor NTC
- `wokwi-analog-joystick` — Joystick analógico

### Displays (3)
- `wokwi-lcd1602` — LCD 16x2 con protocolo HD44780
- `wokwi-lcd2004` — LCD 20x4 con protocolo HD44780
- `wokwi-7segment` — Display de 7 segmentos

### Input (5)
- `wokwi-pushbutton` — Botón pulsador
- `wokwi-pushbutton-6mm` — Botón 6mm
- `wokwi-slide-switch` — Interruptor deslizante
- `wokwi-dip-switch-8` — DIP switch de 8 posiciones
- `wokwi-potentiometer` — Potenciómetro

### Output (5)
- `wokwi-led` — LED de colores
- `wokwi-rgb-led` — LED RGB
- `wokwi-led-bar-graph` — Barra de LEDs (10)
- `wokwi-buzzer` — Buzzer piezoeléctrico
- `wokwi-neopixel` — LED RGB direccionable (WS2812)

### Motors (2)
- `wokwi-servo` — Servo motor
- `wokwi-stepper-motor` — Motor paso a paso

### Passive (4)
- `wokwi-resistor` — Resistencia con código de colores
- `wokwi-slide-potentiometer` — Potenciómetro deslizante
- `wokwi-led-ring` — Anillo de LEDs
- `wokwi-membrane-keypad` — Teclado matricial

### Other (19)
- Componentes variados incluyendo `wokwi-ir-receiver`, `wokwi-ds1307`, breadboards, etc.

## Ventajas de Este Enfoque

### Ventajas

1. **Actualización Fácil**: Un simple `git pull` + rebuild te da las últimas mejoras
2. **Compatible con Wokwi**: Usas exactamente el mismo código que Wokwi.com
3. **Descubrimiento Automático**: Nuevos componentes aparecen automáticamente tras regenerar metadata
4. **Control de Versiones**: Puedes hacer checkout a versiones específicas
5. **Desarrollo Flexible**: Código fuente disponible para debugging y modificaciones
6. **Sin Dependencia de npm**: No dependes de que publiquen actualizaciones en npm
7. **100% Offline**: Funciona completamente sin internet después de la configuración inicial

### Consideraciones

1. **Espacio en Disco**: Los repositorios clonados ocupan más espacio (~200MB)
2. **Compilación**: Debes compilar los repositorios después de actualizarlos
3. **Metadata**: Regenerar `components-metadata.json` después de actualizar wokwi-elements

## Troubleshooting

### Error: "Module not found: @wokwi/elements"

Asegúrate de que wokwi-elements esté compilado:

```bash
cd wokwi-libs/wokwi-elements
npm install
npm run build
```

### Error: "Cannot find module 'avr8js'"

Verifica que el alias en `vite.config.ts` esté correcto y que avr8js esté compilado:

```bash
cd wokwi-libs/avr8js
npm install
npm run build
```

### Los componentes no se muestran en el picker

Regenera la metadata de componentes:

```bash
cd frontend
npx tsx ../scripts/generate-component-metadata.ts
```

### Nuevo componente de wokwi-elements no aparece

1. Actualiza wokwi-elements: `cd wokwi-libs/wokwi-elements && git pull && npm run build`
2. Regenera metadata: `cd frontend && npx tsx ../scripts/generate-component-metadata.ts`
3. Si necesita simulación, registra su comportamiento en `frontend/src/simulation/parts/`

### Los componentes se ven pero no responden a la simulación

Verifica que el componente tenga lógica de simulación registrada en `PartSimulationRegistry` (archivos `BasicParts.ts` o `ComplexParts.ts`). Solo los 16 componentes registrados tienen comportamiento interactivo.

## Referencias

- [Wokwi Elements Documentation](https://elements.wokwi.com/)
- [AVR8js Repository](https://github.com/wokwi/avr8js)
- [Wokwi Simulator](https://wokwi.com)
- [Lit Documentation](https://lit.dev/) — Framework usado por wokwi-elements
- [Web Components Guide](https://developer.mozilla.org/en-US/docs/Web/Web_Components)

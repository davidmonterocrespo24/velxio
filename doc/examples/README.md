# Example Projects

Esta carpeta contiene las imágenes de preview para los 8 proyectos de ejemplo de la galería.

## Ejemplos Disponibles

| ID | Título | Categoría | Dificultad | Componentes |
|----|--------|-----------|------------|-------------|
| `blink-led` | Blink LED | basics | beginner | Arduino Uno |
| `traffic-light` | Traffic Light | basics | beginner | 3 LEDs (R/Y/G) |
| `button-led` | Button Control | basics | beginner | Button + LED |
| `fade-led` | Fade LED (PWM) | basics | beginner | 1 LED |
| `serial-hello` | Serial Hello World | communication | beginner | Arduino Uno |
| `rgb-led` | RGB LED Colors | basics | intermediate | RGB LED |
| `simon-says` | Simon Says Game | games | advanced | 4 LEDs + 4 buttons |
| `lcd-hello` | LCD 20x4 Display | displays | intermediate | LCD 2004 |

Cada ejemplo incluye:
- Código Arduino completo
- Definiciones de componentes con posiciones
- Conexiones de cables con pines y colores

Los ejemplos se definen en `frontend/src/data/examples.ts` y se renderizan en la galería `ExamplesGallery.tsx` con filtros por categoría y dificultad.

## Cómo Crear Screenshots

### Método 1: Captura Manual (Recomendado)

1. Carga el ejemplo en el editor (http://localhost:5173/examples)
2. Haz click en el ejemplo para cargarlo
3. Ajusta el zoom del canvas si es necesario
4. Usa una herramienta de captura de pantalla para capturar solo el área del simulador
5. Guarda la imagen con el nombre correspondiente

### Método 2: Usando DevTools

1. Abre el ejemplo en el navegador
2. Abre DevTools (F12)
3. Ve a la consola y ejecuta:
```javascript
const canvas = document.querySelector('.canvas-content');
html2canvas(canvas).then(canvas => {
  const link = document.createElement('a');
  link.download = 'example-name.png';
  link.href = canvas.toDataURL();
  link.click();
});
```

## Nombres de Archivos

Los archivos deben seguir el ID del ejemplo:

- `blink-led.png` — Blink LED
- `traffic-light.png` — Traffic Light
- `button-led.png` — Button Control
- `fade-led.png` — Fade LED
- `serial-hello.png` — Serial Hello World
- `rgb-led.png` — RGB LED Colors
- `simon-says.png` — Simon Says Game
- `lcd-hello.png` — LCD 20x4 Display

## Dimensiones Recomendadas

- **Ancho**: 800px
- **Alto**: 500px
- **Formato**: PNG con fondo oscuro (#1e1e1e)

## Placeholder Actual

Mientras no haya imágenes, se muestra un placeholder con:
- Icono de la categoría (emoji grande)
- Número de componentes (azul cian)
- Número de cables (amarillo)
- Fondo degradado con borde punteado

## Agregar un Nuevo Ejemplo

1. Agregar la definición en `frontend/src/data/examples.ts` con:
   - `id`, `title`, `description`, `category`, `difficulty`
   - `code`: Sketch Arduino completo
   - `components[]`: Tipo, posición, propiedades
   - `wires[]`: Conexiones con `startPinName`, `endPinName`, `color`
2. (Opcional) Capturar screenshot y guardarlo aquí como `{id}.png`
3. El ejemplo aparecerá automáticamente en la galería con filtrado por categoría y dificultad

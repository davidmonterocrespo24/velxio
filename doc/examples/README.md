# Example Project Screenshots

Esta carpeta contiene las imágenes de preview para los proyectos de ejemplo de la galería.

## Cómo Crear Screenshots

### Método 1: Captura Manual (Recomendado)

1. Carga el ejemplo en el editor (http://localhost:5173/examples)
2. Haz click en el ejemplo
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

- `blink-led.png` - Blink LED example
- `traffic-light.png` - Traffic Light example
- `button-control.png` - Button Control example
- `fade-led.png` - Fade LED example
- `serial-hello.png` - Serial Hello World example
- `rgb-led.png` - RGB LED Colors example
- `simon-says.png` - Simon Says Game example

## Dimensiones Recomendadas

- **Ancho**: 800px
- **Alto**: 500px
- **Formato**: PNG con fondo transparente o oscuro (#1e1e1e)

## Actualizar el Código

Una vez tengas las imágenes, actualiza `frontend/src/data/examples.ts`:

```typescript
{
  id: 'blink-led',
  title: 'Blink LED',
  // ... resto de propiedades
  thumbnail: '/doc/examples/blink-led.png',  // Agregar esta línea
}
```

## Placeholder Actual

Mientras no haya imágenes, se muestra un placeholder con:
- Icono de la categoría (emoji grande)
- Número de componentes (azul cian)
- Número de cables (amarillo)
- Fondo degradado con borde punteado

Este placeholder es más profesional que el preview SVG generado automáticamente.

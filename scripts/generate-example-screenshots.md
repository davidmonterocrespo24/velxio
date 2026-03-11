# Generar Screenshots de Ejemplos

Debido a restricciones CORS del navegador, no podemos capturar el canvas automáticamente con `toDataURL()`. En su lugar, necesitamos screenshots manuales.

## Método Rápido: Captura de Pantalla

### 1. Preparar el Navegador

```bash
cd frontend
npm run dev
```

Abre http://localhost:5173

### 2. Para Cada Ejemplo

1. Ve a http://localhost:5173/examples
2. Haz click en un ejemplo (ej: "Blink LED")
3. Espera a que se cargue en el editor
4. Ajusta el zoom del canvas si es necesario para que el circuito se vea bien centrado

### 3. Capturar Solo el Canvas

**Windows (Win + Shift + S):**
- Presiona `Win + Shift + S`
- Selecciona el área del simulador (panel derecho)
- La captura se guarda en el portapapeles

**Guardar la imagen:**
1. Abre Paint o cualquier editor
2. Pega (Ctrl + V)
3. Guarda como PNG en `docs/examples/[nombre-ejemplo].png`

### 4. Nombres de Archivo

Usa el ID del ejemplo:

- `blink-led.png` - Solo Arduino
- `traffic-light.png` - Arduino + 3 LEDs (rojo, amarillo, verde)
- `button-control.png` - Arduino + botón + LED
- `fade-led.png` - Arduino + LED azul
- `serial-hello.png` - Solo Arduino
- `rgb-led.png` - Arduino + LED RGB
- `simon-says.png` - Arduino + 4 LEDs + 4 botones

### 5. Actualizar el Código

Una vez tengas las imágenes, edita `frontend/src/data/examples.ts`:

```typescript
{
  id: 'blink-led',
  title: 'Blink LED',
  description: 'Classic Arduino blink example - toggle an LED on and off',
  category: 'basics',
  difficulty: 'beginner',
  thumbnail: '/docs/examples/blink-led.png',  // ← Agregar esta línea
  code: `...`,
  // ... resto
}
```

## Alternativa: Script Browser DevTools

Si prefieres algo más automatizado:

1. Abre el ejemplo en http://localhost:5173
2. Abre DevTools (F12)
3. Ve a la consola
4. Ejecuta:

```javascript
// Tomar screenshot del canvas del simulador
const simulatorPanel = document.querySelector('.simulator-panel');
const rect = simulatorPanel.getBoundingClientRect();

// Usar la API de screenshot del navegador (Chrome/Edge)
chrome.tabs.captureVisibleTab(null, {format: 'png'}, function(dataUrl) {
  const link = document.createElement('a');
  link.download = 'example.png';
  link.href = dataUrl;
  link.click();
});
```

**Nota:** Este método requiere una extensión del navegador.

## Dimensiones Recomendadas

- **Ancho**: 600-800px
- **Alto**: 400-600px
- **Formato**: PNG
- **Fondo**: El mismo del canvas (#1e1e1e)

## Resultado Esperado

Cada tarjeta en `/examples` mostrará la screenshot real del circuito en lugar del placeholder genérico.

## Limpieza (Opcional)

Una vez tengas las screenshots, puedes eliminar:
- `frontend/src/utils/captureCanvasPreview.ts` (ya no se necesita)
- `frontend/src/utils/generateExamplePreview.tsx` (SVG antiguo)

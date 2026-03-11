# Arduino Emulator - Frontend

React + TypeScript + Vite frontend for the Arduino emulator with visual simulator and code editor.

## Features

- **Monaco Code Editor** - Full VSCode-like Arduino code editing experience
- **Dynamic Component System** - 48+ wokwi-elements components with search and categories
- **Visual Simulator Canvas** - Interactive drag-and-drop circuit builder
- **Component Property Dialog** - Single-click component interaction (rotate, delete, view pins)
- **Segment-Based Wire Editing** - Drag wire segments perpendicular to orientation (like Wokwi)
- **Real AVR8 Emulation** - Actual ATmega328p emulation using avr8js
- **Pin Management** - Automatic pin mapping and state synchronization
- **Grid Snapping** - 20px grid alignment for clean circuit layouts

## Tech Stack

- **React** 18 - UI framework
- **TypeScript** - Static typing
- **Vite** 5 - Build tool and dev server
- **Monaco Editor** - Code editor (VSCode engine)
- **Zustand** - State management
- **Axios** - HTTP client for backend API
- **avr8js** - AVR8 CPU emulator (local clone)
- **@wokwi/elements** - Electronic web components (local clone)

## Development

### Prerequisites
- Node.js 18+
- Backend running at http://localhost:8001
- Wokwi libraries built in `../wokwi-libs/`

### Install Dependencies
```bash
npm install
```

### Run Development Server
```bash
npm run dev
```

The app will be available at http://localhost:5173

### Build for Production
```bash
npm run build
```

Output will be in the `dist/` directory.

### Lint
```bash
npm run lint
```

## Project Structure

```
frontend/
├── src/
│   ├── components/
│   │   ├── components-wokwi/     # React wrappers for wokwi-elements
│   │   ├── editor/               # Monaco Editor components
│   │   │   ├── CodeEditor.tsx
│   │   │   └── EditorToolbar.tsx
│   │   └── simulator/            # Simulation canvas components
│   │       ├── SimulatorCanvas.tsx
│   │       ├── WireLayer.tsx
│   │       ├── WireRenderer.tsx
│   │       ├── PinOverlay.tsx
│   │       ├── ComponentPropertyDialog.tsx
│   │       ├── ComponentPickerModal.tsx
│   │       └── ComponentPalette.tsx
│   ├── simulation/
│   │   ├── AVRSimulator.ts       # AVR8 CPU wrapper
│   │   └── PinManager.ts         # Pin mapping and callbacks
│   ├── store/
│   │   ├── useEditorStore.ts     # Code editor state
│   │   └── useSimulatorStore.ts  # Simulation state
│   ├── services/
│   │   ├── api.ts                # Backend API client
│   │   └── ComponentRegistry.ts  # Component metadata
│   ├── types/                    # TypeScript definitions
│   ├── utils/
│   │   ├── hexParser.ts          # Intel HEX parser
│   │   ├── wirePathGenerator.ts  # Wire SVG path generation
│   │   └── wireSegments.ts       # Segment-based wire editing
│   ├── App.tsx                   # Main app component
│   └── main.tsx                  # Entry point
├── public/                       # Static assets
├── vite.config.ts               # Vite configuration
└── package.json
```

## Key Architecture Patterns

### State Management (Zustand)
Two main stores:
- **useEditorStore** - Code content, theme, compilation state
- **useSimulatorStore** - Simulation running state, components, wires, compiled hex

### Local Wokwi Libraries
Vite aliases point to local clones instead of npm packages:
```typescript
resolve: {
  alias: {
    'avr8js': path.resolve(__dirname, '../wokwi-libs/avr8js/dist/esm'),
    '@wokwi/elements': path.resolve(__dirname, '../wokwi-libs/wokwi-elements/dist/esm'),
  },
}
```

### AVR Simulation Loop
- Runs at ~60 FPS using `requestAnimationFrame`
- Executes ~267,000 CPU cycles per frame (16MHz / 60fps)
- Port listeners fire when GPIO registers change
- PinManager routes pin states to component callbacks

### Component System
Components are Web Components from wokwi-elements:
1. React wrappers in `components-wokwi/`
2. Dynamic loading via ComponentRegistry
3. Pin info extracted from component metadata
4. State updates via refs and callbacks

### Wire Editing System
Segment-based editing (like Wokwi):
- Wires consist of orthogonal segments (horizontal/vertical)
- Drag segments perpendicular to orientation:
  - Horizontal segments: move up/down (ns-resize)
  - Vertical segments: move left/right (ew-resize)
- Local preview state during drag (requestAnimationFrame)
- Store update only on mouse up with grid snapping (20px)

### Performance Optimizations
- `requestAnimationFrame` for smooth wire dragging
- Local state for real-time previews
- Memoized path generation and segment computation
- Store updates batched at interaction completion

## API Integration

Backend endpoints (http://localhost:8001):
- `POST /api/compile` - Compile Arduino code to .hex
- `GET /api/compile/status/{task_id}` - Check compilation status
- `GET /api/compile/download/{filename}` - Download compiled .hex

See [backend documentation](../backend/README.md) for API details.

## Component Development

### Adding a New Component Type

1. Check if wokwi-elements has the component:
   ```bash
   ls ../wokwi-libs/wokwi-elements/src/
   ```

2. Create React wrapper in `src/components/components-wokwi/`:
   ```typescript
   import React, { useRef, useEffect } from 'react';

   export const WokwiMyComponent: React.FC<Props> = ({ ... }) => {
     const elementRef = useRef<any>(null);

     useEffect(() => {
       if (elementRef.current) {
         elementRef.current.setAttribute('prop', value);
       }
     }, [value]);

     return <wokwi-my-component ref={elementRef} />;
   };
   ```

3. Add to ComponentRegistry metadata

4. Use in SimulatorCanvas or make available in ComponentPalette

## Troubleshooting

### Monaco Editor Not Loading
- Check if `monaco-editor` is installed
- Verify Vite worker configuration in vite.config.ts

### Components Not Rendering
- Ensure wokwi-elements is built: `cd ../wokwi-libs/wokwi-elements && npm run build`
- Check browser console for Web Component registration errors
- Verify Vite alias paths in vite.config.ts

### Wire Editing Performance Issues
- Ensure `requestAnimationFrame` is being used
- Check that store updates only happen on mouse up, not during drag
- Verify no unnecessary re-renders with React DevTools

### Pin Alignment Issues
- Pin coordinates from wokwi-elements are in CSS pixels
- Do NOT multiply by MM_TO_PX conversion factor
- Verify component position + pin offset calculation

### Compilation Fails
- Check backend is running at http://localhost:8001
- Verify arduino-cli is installed and `arduino:avr` core is available
- Check CORS configuration in backend

## References

- [Main Project README](../README.md)
- [Development Guide (CLAUDE.md)](../CLAUDE.md)
- [Architecture Documentation](../docs/ARCHITECTURE.md)
- [Wokwi Integration](../docs/WOKWI_LIBS.md)
- [Monaco Editor API](https://microsoft.github.io/monaco-editor/api/index.html)
- [Vite Documentation](https://vitejs.dev/)
- [Zustand Guide](https://docs.pmnd.rs/zustand/getting-started/introduction)

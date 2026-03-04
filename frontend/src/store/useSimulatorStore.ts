import { create } from 'zustand';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { RP2040Simulator } from '../simulation/RP2040Simulator';
import { PinManager } from '../simulation/PinManager';
import type { Wire, WireInProgress, WireEndpoint } from '../types/wire';
import { calculatePinPosition } from '../utils/pinPositionCalculator';

export type BoardType = 'arduino-uno' | 'raspberry-pi-pico';

export const BOARD_FQBN: Record<BoardType, string> = {
  'arduino-uno': 'arduino:avr:uno',
  'raspberry-pi-pico': 'rp2040:rp2040:rpipico',
};

export const BOARD_LABELS: Record<BoardType, string> = {
  'arduino-uno': 'Arduino Uno',
  'raspberry-pi-pico': 'Raspberry Pi Pico',
};

// Fixed position for the Arduino board (not in components array)
export const ARDUINO_POSITION = { x: 50, y: 50 };

interface Component {
  id: string;
  metadataId: string;  // References ComponentMetadata by ID (e.g., 'led', 'dht22')
  x: number;
  y: number;
  properties: Record<string, unknown>;  // Flexible properties for any component type
}

interface SimulatorState {
  // Board selection
  boardType: BoardType;
  setBoardType: (type: BoardType) => void;

  // Simulation state
  simulator: AVRSimulator | RP2040Simulator | null;
  pinManager: PinManager;
  running: boolean;
  compiledHex: string | null;

  // Components
  components: Component[];

  // Wire state (Phase 1)
  wires: Wire[];
  selectedWireId: string | null;
  wireInProgress: WireInProgress | null;

  // Actions
  initSimulator: () => void;
  loadHex: (hex: string) => void;
  loadBinary: (base64: string) => void;
  startSimulation: () => void;
  stopSimulation: () => void;
  resetSimulation: () => void;
  setCompiledHex: (hex: string) => void;
  setCompiledBinary: (base64: string) => void;
  setRunning: (running: boolean) => void;

  // Component management
  addComponent: (component: Component) => void;
  removeComponent: (id: string) => void;
  updateComponent: (id: string, updates: Partial<Component>) => void;
  updateComponentState: (id: string, state: boolean) => void;
  handleComponentEvent: (componentId: string, eventName: string, data?: any) => void;
  setComponents: (components: Component[]) => void;

  // Wire management (Phase 1)
  addWire: (wire: Wire) => void;
  removeWire: (wireId: string) => void;
  updateWire: (wireId: string, updates: Partial<Wire>) => void;
  setSelectedWire: (wireId: string | null) => void;
  setWires: (wires: Wire[]) => void;

  // Wire creation (Phase 2)
  startWireCreation: (endpoint: WireEndpoint) => void;
  updateWireInProgress: (x: number, y: number) => void;
  finishWireCreation: (endpoint: WireEndpoint) => void;
  cancelWireCreation: () => void;

  // Wire position updates (auto-update when components move)
  updateWirePositions: (componentId: string) => void;
  recalculateAllWirePositions: () => void;
}

export const useSimulatorStore = create<SimulatorState>((set, get) => {
  // Create PinManager instance
  const pinManager = new PinManager();

  return {
    boardType: 'arduino-uno' as BoardType,
    simulator: null,
    pinManager,
    running: false,
    compiledHex: null,
    components: [
      {
        id: 'led-builtin',
        metadataId: 'led',
        x: 350,
        y: 100,
        properties: {
          color: 'red',
          pin: 13,
          state: false,
        },
      },
    ],

    // Wire state with test wires (Phase 1 - Testing)
    // Positions will be recalculated dynamically after DOM mount
    wires: [
      {
        id: 'wire-test-1',
        start: {
          componentId: 'arduino-uno',
          pinName: 'GND.1',
          x: 0,
          y: 0,
        },
        end: {
          componentId: 'led-builtin',
          pinName: 'A',
          x: 0,
          y: 0,
        },
        controlPoints: [],
        color: '#000000', // Black for GND
        signalType: 'power-gnd',
        isValid: true,
      },
      {
        id: 'wire-test-2',
        start: {
          componentId: 'arduino-uno',
          pinName: '13',
          x: 0,
          y: 0,
        },
        end: {
          componentId: 'led-builtin',
          pinName: 'C',
          x: 0,
          y: 0,
        },
        controlPoints: [],
        color: '#00ff00', // Green for digital
        signalType: 'digital',
        isValid: true,
      },
    ],
    selectedWireId: null,
    wireInProgress: null,

    setBoardType: (type: BoardType) => {
      const { running } = get();
      if (running) {
        get().stopSimulation();
      }
      const simulator = type === 'arduino-uno'
        ? new AVRSimulator(pinManager)
        : new RP2040Simulator(pinManager);
      set({ boardType: type, simulator, compiledHex: null });
      console.log(`Board switched to: ${type}`);
    },

    initSimulator: () => {
      const { boardType } = get();
      const simulator = boardType === 'arduino-uno'
        ? new AVRSimulator(pinManager)
        : new RP2040Simulator(pinManager);
      set({ simulator });
      console.log(`Simulator initialized: ${boardType}`);
    },

    loadHex: (hex: string) => {
      const { simulator } = get();
      if (simulator && simulator instanceof AVRSimulator) {
        try {
          simulator.loadHex(hex);
          set({ compiledHex: hex });
          console.log('HEX file loaded successfully');
        } catch (error) {
          console.error('Failed to load HEX:', error);
        }
      } else {
        console.warn('loadHex: simulator not initialized or wrong board type');
      }
    },

    loadBinary: (base64: string) => {
      const { simulator } = get();
      if (simulator && simulator instanceof RP2040Simulator) {
        try {
          simulator.loadBinary(base64);
          set({ compiledHex: base64 }); // reuse compiledHex as "program loaded" flag
          console.log('Binary loaded into RP2040 successfully');
        } catch (error) {
          console.error('Failed to load binary:', error);
        }
      } else {
        console.warn('loadBinary: simulator not initialized or wrong board type');
      }
    },

    startSimulation: () => {
      const { simulator } = get();
      if (simulator) {
        simulator.start();
        set({ running: true });
      }
    },

    stopSimulation: () => {
      const { simulator } = get();
      if (simulator) {
        simulator.stop();
        set({ running: false });
      }
    },

    resetSimulation: () => {
      const { simulator } = get();
      if (simulator) {
        simulator.reset();
        set({ running: false });
      }
    },

    setCompiledHex: (hex: string) => {
      set({ compiledHex: hex });
      get().loadHex(hex);
    },

    setCompiledBinary: (base64: string) => {
      set({ compiledHex: base64 }); // use compiledHex as "program ready" flag
      get().loadBinary(base64);
    },

    setRunning: (running: boolean) => set({ running }),

    addComponent: (component) => {
      set((state) => ({
        components: [...state.components, component],
      }));
    },

    removeComponent: (id) => {
      set((state) => ({
        components: state.components.filter((c) => c.id !== id),
        // Also remove wires connected to this component
        wires: state.wires.filter((w) =>
          w.start.componentId !== id && w.end.componentId !== id
        ),
      }));
    },

    updateComponent: (id, updates) => {
      set((state) => ({
        components: state.components.map((c) =>
          c.id === id ? { ...c, ...updates } : c
        ),
      }));

      // Update wire positions if component moved
      if (updates.x !== undefined || updates.y !== undefined) {
        get().updateWirePositions(id);
      }
    },

    updateComponentState: (id, state) => {
      set((prevState) => ({
        components: prevState.components.map((c) =>
          c.id === id ? { ...c, properties: { ...c.properties, state, value: state } } : c
        ),
      }));
    },

    handleComponentEvent: (_componentId, _eventName, _data) => {
      // Legacy UI-based handling can be placed here if needed
      // but device simulation events are now in DynamicComponent via PartSimulationRegistry
    },

    setComponents: (components) => {
      set({ components });
    },

    // Wire management actions
    addWire: (wire) => {
      set((state) => ({
        wires: [...state.wires, wire],
      }));
    },

    removeWire: (wireId) => {
      set((state) => ({
        wires: state.wires.filter((w) => w.id !== wireId),
        selectedWireId: state.selectedWireId === wireId ? null : state.selectedWireId,
      }));
    },

    updateWire: (wireId, updates) => {
      set((state) => ({
        wires: state.wires.map((w) =>
          w.id === wireId ? { ...w, ...updates } : w
        ),
      }));
    },

    setSelectedWire: (wireId) => {
      set({ selectedWireId: wireId });
    },

    setWires: (wires) => {
      set({ wires });
    },

    // Wire creation actions (Phase 2)
    startWireCreation: (endpoint) => {
      set({
        wireInProgress: {
          startEndpoint: endpoint,
          currentX: endpoint.x,
          currentY: endpoint.y,
        },
      });
    },

    updateWireInProgress: (x, y) => {
      set((state) => {
        if (!state.wireInProgress) return state;
        return {
          wireInProgress: {
            ...state.wireInProgress,
            currentX: x,
            currentY: y,
          },
        };
      });
    },

    finishWireCreation: (endpoint) => {
      const state = get();
      if (!state.wireInProgress) return;

      const { startEndpoint } = state.wireInProgress;

      // Calculate midpoint for control point
      const midX = (startEndpoint.x + endpoint.x) / 2;
      const midY = (startEndpoint.y + endpoint.y) / 2;

      const newWire: Wire = {
        id: `wire-${Date.now()}`,
        start: startEndpoint,
        end: endpoint,
        controlPoints: [
          {
            id: `cp-${Date.now()}`,
            x: midX,
            y: midY,
          },
        ],
        color: '#00ff00', // Default green, will be calculated based on signal type
        signalType: 'digital',
        isValid: true,
      };

      set((state) => ({
        wires: [...state.wires, newWire],
        wireInProgress: null,
      }));
    },

    cancelWireCreation: () => {
      set({ wireInProgress: null });
    },

    // Update wire positions when component moves
    updateWirePositions: (componentId) => {
      set((state) => {
        const component = state.components.find((c) => c.id === componentId);
        // For fixed components like Arduino, use ARDUINO_POSITION
        const compX = component ? component.x : ARDUINO_POSITION.x;
        const compY = component ? component.y : ARDUINO_POSITION.y;

        const updatedWires = state.wires.map((wire) => {
          const updated = { ...wire };
          if (wire.start.componentId === componentId) {
            const pos = calculatePinPosition(
              componentId,
              wire.start.pinName,
              compX,
              compY
            );
            if (pos) {
              updated.start = { ...wire.start, x: pos.x, y: pos.y };
            }
          }

          // Update end endpoint if it belongs to this component
          if (wire.end.componentId === componentId) {
            const pos = calculatePinPosition(
              componentId,
              wire.end.pinName,
              compX,
              compY
            );
            if (pos) {
              updated.end = { ...wire.end, x: pos.x, y: pos.y };
            }
          }

          return updated;
        });

        return { wires: updatedWires };
      });
    },

    // Recalculate all wire positions from actual DOM pinInfo
    recalculateAllWirePositions: () => {
      const state = get();

      const updatedWires = state.wires.map((wire) => {
        const updated = { ...wire };
        const startComp = state.components.find((c) => c.id === wire.start.componentId);
        const startX = startComp ? startComp.x : ARDUINO_POSITION.x;
        const startY = startComp ? startComp.y : ARDUINO_POSITION.y;

        const startPos = calculatePinPosition(
          wire.start.componentId,
          wire.start.pinName,
          startX,
          startY
        );
        if (startPos) {
          updated.start = { ...wire.start, x: startPos.x, y: startPos.y };
        }

        // Resolve end component position
        const endComp = state.components.find((c) => c.id === wire.end.componentId);
        const endX = endComp ? endComp.x : ARDUINO_POSITION.x;
        const endY = endComp ? endComp.y : ARDUINO_POSITION.y;

        const endPos = calculatePinPosition(
          wire.end.componentId,
          wire.end.pinName,
          endX,
          endY
        );
        if (endPos) {
          updated.end = { ...wire.end, x: endPos.x, y: endPos.y };
        }

        return updated;
      });

      set({ wires: updatedWires });
    },
  };
});

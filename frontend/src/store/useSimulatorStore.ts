import { create } from 'zustand';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { RP2040Simulator } from '../simulation/RP2040Simulator';
import { RiscVSimulator } from '../simulation/RiscVSimulator';
import { Esp32C3Simulator } from '../simulation/Esp32C3Simulator';
import { PinManager } from '../simulation/PinManager';
import { VirtualDS1307, VirtualTempSensor, I2CMemoryDevice } from '../simulation/I2CBusManager';
import type { RP2040I2CDevice } from '../simulation/RP2040Simulator';
import type { Wire, WireInProgress, WireEndpoint } from '../types/wire';
import type { BoardKind, BoardInstance } from '../types/board';
import { calculatePinPosition } from '../utils/pinPositionCalculator';
import { useOscilloscopeStore } from './useOscilloscopeStore';
import { RaspberryPi3Bridge } from '../simulation/RaspberryPi3Bridge';
import { Esp32Bridge } from '../simulation/Esp32Bridge';
import { useEditorStore } from './useEditorStore';
import { useVfsStore } from './useVfsStore';
import { boardPinToNumber, isBoardComponent } from '../utils/boardPinMapping';

// ── Sensor pre-registration ──────────────────────────────────────────────────
// Maps component metadataId → { sensorType, dataPinName, propertyKeys }
// Used to pre-register sensors in the start_esp32 payload so the QEMU worker
// has them ready before the firmware starts executing (prevents race conditions).
const SENSOR_COMPONENT_MAP: Record<string, {
  sensorType: string;
  dataPinName: string;
  propertyKeys: string[];
  extraPins?: Record<string, string>; // extra pin mappings: prop name → component pin name
}> = {
  'dht22': { sensorType: 'dht22', dataPinName: 'SDA', propertyKeys: ['temperature', 'humidity'] },
  'hc-sr04': { sensorType: 'hc-sr04', dataPinName: 'TRIG', propertyKeys: ['distance'], extraPins: { echo_pin: 'ECHO' } },
};

// ── Legacy type aliases (keep external consumers working) ──────────────────
export type BoardType = 'arduino-uno' | 'arduino-nano' | 'arduino-mega' | 'raspberry-pi-pico';

export const BOARD_FQBN: Record<BoardType, string> = {
  'arduino-uno': 'arduino:avr:uno',
  'arduino-nano': 'arduino:avr:nano:cpu=atmega328',
  'arduino-mega': 'arduino:avr:mega',
  'raspberry-pi-pico': 'rp2040:rp2040:rpipico',
};

export const BOARD_LABELS: Record<BoardType, string> = {
  'arduino-uno': 'Arduino Uno',
  'arduino-nano': 'Arduino Nano',
  'arduino-mega': 'Arduino Mega 2560',
  'raspberry-pi-pico': 'Raspberry Pi Pico',
};

export const DEFAULT_BOARD_POSITION = { x: 50, y: 50 };
export const ARDUINO_POSITION = DEFAULT_BOARD_POSITION;

// ── Lightweight shim wrapping Esp32Bridge so component simulations (DHT22, etc.)
// can call setPinState / pinManager just like they would on a local simulator. ──
class Esp32BridgeShim {
  pinManager: PinManager;
  onSerialData: ((ch: string) => void) | null = null;
  onPinChangeWithTime: ((pin: number, state: boolean, timeMs: number) => void) | null = null;
  onBaudRateChange: ((baud: number) => void) | null = null;
  private bridge: Esp32Bridge;

  constructor(bridge: Esp32Bridge, pm: PinManager) {
    this.bridge = bridge;
    this.pinManager = pm;
  }

  setPinState(pin: number, state: boolean): void { this.bridge.sendPinEvent(pin, state); }
  getCurrentCycles(): number { return -1; }
  getClockHz(): number { return 240_000_000; }
  isRunning(): boolean { return this.bridge.connected; }
  serialWrite(text: string): void {
    this.bridge.sendSerialBytes(Array.from(new TextEncoder().encode(text)));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getADC(): any { return null; }

  /**
   * Set ADC value for an ESP32 GPIO pin.
   * ESP32 ADC1: GPIO 36-39 → CH0-3, GPIO 32-35 → CH4-7
   * Returns true if the pin is a valid ADC pin.
   */
  setAdcVoltage(pin: number, voltage: number): boolean {
    let channel = -1;
    if (pin >= 36 && pin <= 39) channel = pin - 36;       // GPIO 36→CH0, 37→CH1, 38→CH2, 39→CH3
    else if (pin >= 32 && pin <= 35) channel = pin - 28;   // GPIO 32→CH4, 33→CH5, 34→CH6, 35→CH7
    if (channel < 0) return false;
    const millivolts = Math.round(voltage * 1000);
    this.bridge.setAdc(channel, millivolts);
    return true;
  }
  getMCU(): null { return null; }
  start(): void { /* managed by bridge */ }
  stop(): void { /* managed by bridge */ }
  reset(): void { /* managed by bridge */ }
  setSpeed(_s: number): void { /* no-op */ }
  getSpeed(): number { return 1; }
  loadHex(_hex: string): void { /* no-op */ }
  loadBinary(_b64: string): void { /* no-op */ }

  // ── Generic sensor registration (board-agnostic API) ──────────────────────
  // ESP32 delegates sensor protocols to the backend QEMU.

  registerSensor(type: string, pin: number, properties: Record<string, unknown>): boolean {
    this.bridge.sendSensorAttach(type, pin, properties);
    return true; // backend handles the protocol
  }
  updateSensor(pin: number, properties: Record<string, unknown>): void {
    this.bridge.sendSensorUpdate(pin, properties);
  }
  unregisterSensor(pin: number): void {
    this.bridge.sendSensorDetach(pin);
  }
}

// ── Shared LEDC update handler (used by addBoard, setBoardType, initSimulator) ─
function makeLedcUpdateHandler(boardId: string) {
  return (update: { channel: number; duty_pct: number; gpio?: number }) => {
    const boardPm = pinManagerMap.get(boardId);
    if (!boardPm) return;
    const dutyCycle = update.duty_pct / 100;
    if (update.gpio !== undefined && update.gpio >= 0) {
      boardPm.updatePwm(update.gpio, dutyCycle);
    } else {
      // gpio unknown (QEMU doesn't expose gpio_out_sel for LEDC):
      // broadcast to ALL PWM listeners. Components filter by duty range
      // (servo accepts 0.01–0.20, LEDs use 0–1.0).
      boardPm.broadcastPwm(dutyCycle);
    }
  };
}

// ── Runtime Maps (outside Zustand — not serialisable) ─────────────────────
const simulatorMap = new Map<string, AVRSimulator | RP2040Simulator | RiscVSimulator | Esp32C3Simulator | Esp32BridgeShim>();
const pinManagerMap = new Map<string, PinManager>();
const bridgeMap = new Map<string, RaspberryPi3Bridge>();
const esp32BridgeMap = new Map<string, Esp32Bridge>();

export const getBoardSimulator = (id: string) => simulatorMap.get(id);
export const getBoardPinManager = (id: string) => pinManagerMap.get(id);
export const getBoardBridge = (id: string) => bridgeMap.get(id);
export const getEsp32Bridge = (id: string) => esp32BridgeMap.get(id);

// Xtensa-based ESP32 boards — use QEMU bridge (backend)
const ESP32_KINDS = new Set<BoardKind>([
  'esp32', 'esp32-devkit-c-v4', 'esp32-cam', 'wemos-lolin32-lite',
  'esp32-s3', 'xiao-esp32-s3', 'arduino-nano-esp32',
]);

// RISC-V ESP32 boards — also use QEMU bridge (qemu-system-riscv32 -M esp32c3)
// The browser-side Esp32C3Simulator cannot handle the 150+ ROM functions ESP-IDF needs.
const ESP32_RISCV_KINDS = new Set<BoardKind>([
  'esp32-c3', 'xiao-esp32-c3', 'aitewinrobot-esp32c3-supermini',
]);

function isEsp32Kind(kind: BoardKind): boolean {
  return ESP32_KINDS.has(kind) || ESP32_RISCV_KINDS.has(kind);
}

function isRiscVEsp32Kind(kind: BoardKind): boolean {
  return ESP32_RISCV_KINDS.has(kind);
}

// ── Component type ────────────────────────────────────────────────────────
interface Component {
  id: string;
  metadataId: string;
  x: number;
  y: number;
  properties: Record<string, unknown>;
}

// ── Store interface ───────────────────────────────────────────────────────
interface SimulatorState {
  // ── Multi-board state ───────────────────────────────────────────────────
  boards: BoardInstance[];
  activeBoardId: string | null;

  addBoard: (boardKind: BoardKind, x: number, y: number) => string;
  removeBoard: (boardId: string) => void;
  updateBoard: (boardId: string, updates: Partial<BoardInstance>) => void;
  setBoardPosition: (pos: { x: number; y: number }, boardId?: string) => void;
  setActiveBoardId: (boardId: string) => void;
  compileBoardProgram: (boardId: string, program: string) => void;
  startBoard: (boardId: string) => void;
  stopBoard: (boardId: string) => void;
  resetBoard: (boardId: string) => void;

  // ── Legacy single-board API (reads/writes activeBoardId board) ───────────
  /** @deprecated use boards[]/activeBoardId directly */
  boardType: BoardType;
  /** @deprecated use boards[x].x/y */
  boardPosition: { x: number; y: number };
  /** @deprecated use getBoardSimulator(activeBoardId) */
  simulator: AVRSimulator | RP2040Simulator | RiscVSimulator | Esp32C3Simulator | Esp32BridgeShim | null;
  /** @deprecated use getBoardPinManager(activeBoardId) */
  pinManager: PinManager;
  running: boolean;
  compiledHex: string | null;
  hexEpoch: number;
  serialOutput: string;
  serialBaudRate: number;
  serialMonitorOpen: boolean;
  /** @deprecated use getBoardBridge(activeBoardId) */
  remoteConnected: boolean;
  remoteSocket: WebSocket | null;

  setBoardType: (type: BoardType) => void;
  initSimulator: () => void;
  loadHex: (hex: string) => void;
  loadBinary: (base64: string) => void;
  startSimulation: () => void;
  stopSimulation: () => void;
  resetSimulation: () => void;
  setCompiledHex: (hex: string) => void;
  setCompiledBinary: (base64: string) => void;
  setRunning: (running: boolean) => void;
  connectRemoteSimulator: (clientId: string) => void;
  disconnectRemoteSimulator: () => void;
  sendRemotePinEvent: (pin: string, state: number) => void;

  // ── ESP32 crash notification ─────────────────────────────────────────────
  esp32CrashBoardId: string | null;
  dismissEsp32Crash: () => void;

  // ── Components ──────────────────────────────────────────────────────────
  components: Component[];
  addComponent: (component: Component) => void;
  removeComponent: (id: string) => void;
  updateComponent: (id: string, updates: Partial<Component>) => void;
  updateComponentState: (id: string, state: boolean) => void;
  handleComponentEvent: (componentId: string, eventName: string, data?: unknown) => void;
  setComponents: (components: Component[]) => void;

  // ── Wires ───────────────────────────────────────────────────────────────
  wires: Wire[];
  selectedWireId: string | null;
  wireInProgress: WireInProgress | null;
  addWire: (wire: Wire) => void;
  removeWire: (wireId: string) => void;
  updateWire: (wireId: string, updates: Partial<Wire>) => void;
  setSelectedWire: (wireId: string | null) => void;
  setWires: (wires: Wire[]) => void;
  startWireCreation: (endpoint: WireEndpoint, color: string) => void;
  updateWireInProgress: (x: number, y: number) => void;
  addWireWaypoint: (x: number, y: number) => void;
  setWireInProgressColor: (color: string) => void;
  finishWireCreation: (endpoint: WireEndpoint) => void;
  cancelWireCreation: () => void;
  updateWirePositions: (componentId: string) => void;
  recalculateAllWirePositions: () => void;

  // ── Serial monitor ──────────────────────────────────────────────────────
  toggleSerialMonitor: () => void;
  serialWrite: (text: string) => void;
  serialWriteToBoard: (boardId: string, text: string) => void;
  clearSerialOutput: () => void;
  clearBoardSerialOutput: (boardId: string) => void;
}

// ── Helper: create a simulator for a given board kind ─────────────────────
function createSimulator(
  boardKind: BoardKind,
  pm: PinManager,
  onSerial: (ch: string) => void,
  onBaud: (baud: number) => void,
  onPinTime: (pin: number, state: boolean, t: number) => void,
): AVRSimulator | RP2040Simulator | RiscVSimulator | Esp32C3Simulator {
  let sim: AVRSimulator | RP2040Simulator | RiscVSimulator | Esp32C3Simulator;
  if (boardKind === 'arduino-mega') {
    sim = new AVRSimulator(pm, 'mega');
  } else if (boardKind === 'attiny85') {
    sim = new AVRSimulator(pm, 'tiny85');
  } else if (boardKind === 'raspberry-pi-pico' || boardKind === 'pi-pico-w') {
    sim = new RP2040Simulator(pm);
  } else if (isRiscVEsp32Kind(boardKind)) {
    // ESP32-C3 / XIAO-C3 / C3 SuperMini — browser-side RV32IMC emulator
    sim = new Esp32C3Simulator(pm);
  } else {
    // arduino-uno, arduino-nano
    sim = new AVRSimulator(pm, 'uno');
  }
  sim.onSerialData = onSerial;
  if (sim instanceof AVRSimulator) sim.onBaudRateChange = onBaud;
  sim.onPinChangeWithTime = onPinTime;
  return sim;
}

// ── Default initial board (Arduino Uno — same as old behaviour) ───────────
const INITIAL_BOARD_ID = 'arduino-uno';
const INITIAL_BOARD: BoardInstance = {
  id: INITIAL_BOARD_ID,
  boardKind: 'arduino-uno',
  x: DEFAULT_BOARD_POSITION.x,
  y: DEFAULT_BOARD_POSITION.y,
  running: false,
  compiledProgram: null,
  serialOutput: '',
  serialBaudRate: 0,
  serialMonitorOpen: false,
  activeFileGroupId: `group-${INITIAL_BOARD_ID}`,
};

// ── Store ─────────────────────────────────────────────────────────────────
export const useSimulatorStore = create<SimulatorState>((set, get) => {
  // Initialise runtime objects for the default board
  const initialPm = new PinManager();
  pinManagerMap.set(INITIAL_BOARD_ID, initialPm);

  function getOscilloscopeCallback(boardId: string) {
    return (pin: number, state: boolean, timeMs: number) => {
      const { channels, pushSample } = useOscilloscopeStore.getState();
      for (const ch of channels) {
        if (ch.boardId === boardId && ch.pin === pin) pushSample(ch.id, timeMs, state);
      }
    };
  }

  const initialSim = createSimulator(
    'arduino-uno',
    initialPm,
    (ch) => {
      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === INITIAL_BOARD_ID ? { ...b, serialOutput: b.serialOutput + ch } : b
        );
        const isActive = s.activeBoardId === INITIAL_BOARD_ID;
        return { boards, ...(isActive ? { serialOutput: s.serialOutput + ch } : {}) };
      });
    },
    (baud) => {
      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === INITIAL_BOARD_ID ? { ...b, serialBaudRate: baud } : b
        );
        const isActive = s.activeBoardId === INITIAL_BOARD_ID;
        return { boards, ...(isActive ? { serialBaudRate: baud } : {}) };
      });
    },
    getOscilloscopeCallback(INITIAL_BOARD_ID),
  );
  // Cross-board serial bridge for the initial board: AVR TX → Pi bridges RX
  const initialOrigSerial = initialSim.onSerialData;
  initialSim.onSerialData = (ch: string) => {
    initialOrigSerial?.(ch);
    get().boards.forEach((b) => {
      const bridge = bridgeMap.get(b.id);
      if (bridge) bridge.sendSerialBytes([ch.charCodeAt(0)]);
    });
  };
  simulatorMap.set(INITIAL_BOARD_ID, initialSim);

  // ── Legacy single-board PinManager (references initial board's pm) ───────
  const legacyPinManager = initialPm;

  return {
    // ── Multi-board state ─────────────────────────────────────────────────
    boards: [INITIAL_BOARD],
    activeBoardId: INITIAL_BOARD_ID,

    addBoard: (boardKind: BoardKind, x: number, y: number) => {
      const existing = get().boards.filter((b) => b.boardKind === boardKind);
      const id = existing.length === 0
        ? boardKind
        : `${boardKind}-${existing.length + 1}`;

      const pm = new PinManager();
      pinManagerMap.set(id, pm);

      const serialCallback = (ch: string) => {
        set((s) => {
          const boards = s.boards.map((b) =>
            b.id === id ? { ...b, serialOutput: b.serialOutput + ch } : b
          );
          const isActive = s.activeBoardId === id;
          return { boards, ...(isActive ? { serialOutput: s.serialOutput + ch } : {}) };
        });
      };

      if (boardKind === 'raspberry-pi-3') {
        const bridge = new RaspberryPi3Bridge(id);
        bridge.onSerialData = (ch: string) => {
          serialCallback(ch);
          // Cross-board serial bridge: Pi TX → all AVR simulators RX
          get().boards.forEach((b) => {
            const sim = simulatorMap.get(b.id);
            if (sim instanceof AVRSimulator || sim instanceof RiscVSimulator) sim.serialWrite(ch);
          });
        };
        bridge.onPinChange = (_gpioPin, _state) => {
          // Cross-board routing handled in SimulatorCanvas
        };
        bridgeMap.set(id, bridge);
      } else if (isEsp32Kind(boardKind)) {
        const bridge = new Esp32Bridge(id, boardKind);
        bridge.onSerialData = serialCallback;
        bridge.onPinChange = (gpioPin, state) => {
          const boardPm = pinManagerMap.get(id);
          if (boardPm) boardPm.triggerPinChange(gpioPin, state);
        };
        bridge.onCrash = () => {
          set({ esp32CrashBoardId: id });
        };
        bridge.onDisconnected = () => {
          set((s) => {
            const boards = s.boards.map((b) => b.id === id ? { ...b, running: false } : b);
            const isActive = s.activeBoardId === id;
            return { boards, ...(isActive ? { running: false } : {}) };
          });
        };
        bridge.onLedcUpdate = makeLedcUpdateHandler(id);
        bridge.onWs2812Update = (channel, pixels) => {
          // Forward WS2812 pixel data to any DOM element with id=`ws2812-{id}-{channel}`
          // (set by NeoPixel components rendered in SimulatorCanvas).
          // We fire a custom event that NeoPixel components can listen to.
          const eventTarget = document.getElementById(`ws2812-${id}-${channel}`);
          if (eventTarget) {
            eventTarget.dispatchEvent(
              new CustomEvent('ws2812-pixels', { detail: { pixels } })
            );
          }
        };
        bridge.onWifiStatus = (ws) => {
          set((s) => ({
            boards: s.boards.map((b) => b.id === id ? { ...b, wifiStatus: ws } : b),
          }));
        };
        bridge.onBleStatus = (bs) => {
          set((s) => ({
            boards: s.boards.map((b) => b.id === id ? { ...b, bleStatus: bs } : b),
          }));
        };
        esp32BridgeMap.set(id, bridge);
        // Provide a shim so PartSimulationRegistry components (DHT22, etc.)
        // can call setPinState / access pinManager on ESP32 boards.
        const shim = new Esp32BridgeShim(bridge, pm);
        shim.onSerialData = serialCallback;
        simulatorMap.set(id, shim);
      } else {
        const sim = createSimulator(
          boardKind,
          pm,
          serialCallback,
          (baud) => {
            set((s) => {
              const boards = s.boards.map((b) =>
                b.id === id ? { ...b, serialBaudRate: baud } : b
              );
              const isActive = s.activeBoardId === id;
              return { boards, ...(isActive ? { serialBaudRate: baud } : {}) };
            });
          },
          getOscilloscopeCallback(id),
        );
        // Cross-board serial bridge: AVR TX → all Pi bridges RX
        const origSerial = sim.onSerialData;
        sim.onSerialData = (ch: string) => {
          origSerial?.(ch);
          get().boards.forEach((b) => {
            const bridge = bridgeMap.get(b.id);
            if (bridge) bridge.sendSerialBytes([ch.charCodeAt(0)]);
          });
        };
        simulatorMap.set(id, sim);
      }

      const newBoard: BoardInstance = {
        id, boardKind, x, y,
        running: false, compiledProgram: null,
        serialOutput: '', serialBaudRate: 0,
        serialMonitorOpen: false,
        activeFileGroupId: `group-${id}`,
      };

      set((s) => ({ boards: [...s.boards, newBoard] }));
      // Create the editor file group for this board
      useEditorStore.getState().createFileGroup(`group-${id}`);
      // Init VFS for Raspberry Pi 3 boards
      if (boardKind === 'raspberry-pi-3') {
        useVfsStore.getState().initBoardVfs(id);
      }
      return id;
    },

    removeBoard: (boardId: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      getBoardSimulator(boardId)?.stop();
      simulatorMap.delete(boardId);
      pinManagerMap.delete(boardId);
      const bridge = getBoardBridge(boardId);
      if (bridge) { bridge.disconnect(); bridgeMap.delete(boardId); }
      const esp32Bridge = getEsp32Bridge(boardId);
      if (esp32Bridge) { esp32Bridge.disconnect(); esp32BridgeMap.delete(boardId); }
      set((s) => {
        const boards = s.boards.filter((b) => b.id !== boardId);
        const activeBoardId = s.activeBoardId === boardId
          ? (boards[0]?.id ?? null)
          : s.activeBoardId;
        // Remove wires connected to this board
        const wires = s.wires.filter((w) =>
          w.start.componentId !== boardId && w.end.componentId !== boardId
        );
        return { boards, activeBoardId, wires };
      });
      // Clean up file group in editor store
      if (board) {
        useEditorStore.getState().deleteFileGroup(board.activeFileGroupId);
      }
    },

    updateBoard: (boardId: string, updates: Partial<BoardInstance>) => {
      set((s) => ({
        boards: s.boards.map((b) => b.id === boardId ? { ...b, ...updates } : b),
      }));
    },

    setBoardPosition: (pos: { x: number; y: number }, boardId?: string) => {
      const id = boardId ?? get().activeBoardId ?? INITIAL_BOARD_ID;
      set((s) => ({
        boardPosition: s.activeBoardId === id ? pos : s.boardPosition,
        boards: s.boards.map((b) => b.id === id ? { ...b, x: pos.x, y: pos.y } : b),
      }));
    },

    setActiveBoardId: (boardId: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;
      set({
        activeBoardId: boardId,
        // Sync legacy flat fields to this board's values
        boardType: (board.boardKind === 'raspberry-pi-3' ? 'arduino-uno' : board.boardKind) as BoardType,
        boardPosition: { x: board.x, y: board.y },
        simulator: simulatorMap.get(boardId) ?? null,
        pinManager: pinManagerMap.get(boardId) ?? legacyPinManager,
        running: board.running,
        compiledHex: board.compiledProgram,
        serialOutput: board.serialOutput,
        serialBaudRate: board.serialBaudRate,
        serialMonitorOpen: board.serialMonitorOpen,
        remoteConnected: (bridgeMap.get(boardId)?.connected ?? esp32BridgeMap.get(boardId)?.connected) ?? false,
        remoteSocket: null,
      });
      // Switch the editor to this board's file group
      useEditorStore.getState().setActiveGroup(board.activeFileGroupId);
    },

    compileBoardProgram: (boardId: string, program: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;

      if (isEsp32Kind(board.boardKind)) {
        // All ESP32 boards (Xtensa + RISC-V C3): send firmware to QEMU via bridge.
        // Note: isEsp32Kind() includes C3 boards, so they route through Esp32Bridge
        // for full WiFi/BLE emulation via qemu-system-riscv32.
        const esp32Bridge = getEsp32Bridge(boardId);
        if (esp32Bridge) esp32Bridge.loadFirmware(program);
      } else if (isRiscVEsp32Kind(board.boardKind)) {
        // Fallback: browser-only RV32IMC emulation (no WiFi/BLE support).
        // Currently unreachable because isEsp32Kind() above includes C3 boards.
        const sim = getBoardSimulator(boardId);
        if (sim instanceof Esp32C3Simulator) {
          try {
            sim.loadFlashImage(program);
          } catch (err) {
            console.error(`[Esp32C3Simulator] loadFlashImage failed for ${boardId}:`, err);
            return;
          }
        }
      } else {
        const sim = getBoardSimulator(boardId);
        if (sim && board.boardKind !== 'raspberry-pi-3') {
          try {
            if (sim instanceof AVRSimulator) {
              sim.loadHex(program);
              sim.addI2CDevice(new VirtualDS1307());
              sim.addI2CDevice(new VirtualTempSensor());
              sim.addI2CDevice(new I2CMemoryDevice(0x50));
            } else if (sim instanceof RP2040Simulator) {
              sim.loadBinary(program);
              sim.addI2CDevice(new VirtualDS1307() as RP2040I2CDevice);
              sim.addI2CDevice(new VirtualTempSensor() as RP2040I2CDevice);
              sim.addI2CDevice(new I2CMemoryDevice(0x50) as RP2040I2CDevice);
            }
          } catch (err) {
            console.error(`compileBoardProgram(${boardId}):`, err);
            return;
          }
        }
      }

      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === boardId ? { ...b, compiledProgram: program } : b
        );
        const isActive = s.activeBoardId === boardId;
        return {
          boards,
          ...(isActive ? { compiledHex: program, hexEpoch: s.hexEpoch + 1 } : {}),
        };
      });
    },

    startBoard: (boardId: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;

      if (board.boardKind === 'raspberry-pi-3') {
        getBoardBridge(boardId)?.connect();
      } else if (isEsp32Kind(board.boardKind)) {
        // Pre-register sensors connected to this board so the QEMU worker
        // has them ready before the firmware starts executing.
        const esp32Bridge = getEsp32Bridge(boardId);
        if (esp32Bridge) {
          const { components, wires } = get();
          const sensors: Array<Record<string, unknown>> = [];
          for (const comp of components) {
            const sensorDef = SENSOR_COMPONENT_MAP[comp.metadataId];
            if (!sensorDef) continue;
            // Find the wire connecting this component's data pin to the board
            for (const w of wires) {
              const compEndpoint = (w.start.componentId === comp.id && w.start.pinName === sensorDef.dataPinName)
                ? w.start : (w.end.componentId === comp.id && w.end.pinName === sensorDef.dataPinName)
                ? w.end : null;
              if (!compEndpoint) continue;
              const boardEndpoint = compEndpoint === w.start ? w.end : w.start;
              if (!isBoardComponent(boardEndpoint.componentId)) continue;
              // Resolve GPIO pin number
              const gpioPin = boardPinToNumber(board.boardKind, boardEndpoint.pinName);
              if (gpioPin === null || gpioPin < 0) continue;
              // Collect sensor properties from the component
              const props: Record<string, unknown> = {
                sensor_type: sensorDef.sensorType,
                pin: gpioPin,
              };
              for (const key of sensorDef.propertyKeys) {
                const val = comp.properties[key];
                if (val !== undefined) props[key] = typeof val === 'string' ? parseFloat(val) : val;
              }
              // Resolve extra pins (e.g. echo_pin for HC-SR04) from wires
              if (sensorDef.extraPins) {
                for (const [propName, compPinName] of Object.entries(sensorDef.extraPins)) {
                  for (const ew of wires) {
                    const epComp = (ew.start.componentId === comp.id && ew.start.pinName === compPinName)
                      ? ew.start : (ew.end.componentId === comp.id && ew.end.pinName === compPinName)
                      ? ew.end : null;
                    if (!epComp) continue;
                    const epBoard = epComp === ew.start ? ew.end : ew.start;
                    if (!isBoardComponent(epBoard.componentId)) continue;
                    const extraGpio = boardPinToNumber(board.boardKind, epBoard.pinName);
                    if (extraGpio !== null && extraGpio >= 0) {
                      props[propName] = extraGpio;
                    }
                    break;
                  }
                }
              }
              sensors.push(props);
              break; // only one data pin per sensor
            }
          }
          esp32Bridge.setSensors(sensors);

          // Auto-detect WiFi usage in sketch files
          const editorFiles = useEditorStore.getState().files;
          const hasWifi = editorFiles.some(f =>
            f.content.includes('#include <WiFi.h>') ||
            f.content.includes('#include <esp_wifi.h>') ||
            f.content.includes('#include "WiFi.h"') ||
            f.content.includes('WiFi.begin(')
          );
          esp32Bridge.wifiEnabled = hasWifi;

          // Ensure firmware is loaded into the bridge (handles page-refresh case
          // where _pendingFirmware is lost but compiledProgram is still in store).
          if (!esp32Bridge.hasFirmware() && board.compiledProgram) {
            esp32Bridge.loadFirmware(board.compiledProgram);
          }

          esp32Bridge.connect();
        }
      } else {
        getBoardSimulator(boardId)?.start();
      }

      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === boardId ? { ...b, running: true, serialMonitorOpen: true } : b
        );
        const isActive = s.activeBoardId === boardId;
        return { boards, ...(isActive ? { running: true, serialMonitorOpen: true } : {}) };
      });
    },

    stopBoard: (boardId: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;

      if (board.boardKind === 'raspberry-pi-3') {
        getBoardBridge(boardId)?.disconnect();
      } else if (isEsp32Kind(board.boardKind)) {
        getEsp32Bridge(boardId)?.disconnect();
      } else {
        getBoardSimulator(boardId)?.stop();
      }

      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === boardId ? { ...b, running: false } : b
        );
        const isActive = s.activeBoardId === boardId;
        return { boards, ...(isActive ? { running: false } : {}) };
      });
    },

    resetBoard: (boardId: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;

      if (isEsp32Kind(board.boardKind)) {
        // Reset ESP32: disconnect then reconnect the QEMU bridge
        const esp32Bridge = getEsp32Bridge(boardId);
        if (esp32Bridge?.connected) {
          esp32Bridge.disconnect();
          setTimeout(() => esp32Bridge.connect(), 500);
        }
      } else if (board.boardKind !== 'raspberry-pi-3') {
        const sim = getBoardSimulator(boardId);
        if (sim) {
          sim.reset();
          // Re-wire serial callback after reset
          sim.onSerialData = (ch) => {
            set((s) => {
              const boards = s.boards.map((b) =>
                b.id === boardId ? { ...b, serialOutput: b.serialOutput + ch } : b
              );
              const isActive = s.activeBoardId === boardId;
              return { boards, ...(isActive ? { serialOutput: s.serialOutput + ch } : {}) };
            });
          };
          if (sim instanceof AVRSimulator) {
            sim.onBaudRateChange = (baud) => {
              set((s) => {
                const boards = s.boards.map((b) =>
                  b.id === boardId ? { ...b, serialBaudRate: baud } : b
                );
                const isActive = s.activeBoardId === boardId;
                return { boards, ...(isActive ? { serialBaudRate: baud } : {}) };
              });
            };
          }
        }
      }

      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === boardId ? { ...b, running: false, serialOutput: '', serialBaudRate: 0 } : b
        );
        const isActive = s.activeBoardId === boardId;
        return { boards, ...(isActive ? { running: false, serialOutput: '', serialBaudRate: 0 } : {}) };
      });
    },

    // ── Legacy single-board API ───────────────────────────────────────────
    boardType: 'arduino-uno',
    boardPosition: { ...DEFAULT_BOARD_POSITION },
    simulator: initialSim,
    pinManager: legacyPinManager,
    running: false,
    compiledHex: null,
    hexEpoch: 0,
    serialOutput: '',
    serialBaudRate: 0,
    serialMonitorOpen: false,
    remoteConnected: false,
    remoteSocket: null,

    esp32CrashBoardId: null,
    dismissEsp32Crash: () => set({ esp32CrashBoardId: null }),

    setBoardType: (type: BoardType) => {
      const { activeBoardId, running, stopSimulation } = get();
      if (running) stopSimulation();

      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      const pm = getBoardPinManager(boardId) ?? legacyPinManager;

      // Stop and remove old simulator / bridge
      getBoardSimulator(boardId)?.stop();
      simulatorMap.delete(boardId);
      getEsp32Bridge(boardId)?.disconnect();
      esp32BridgeMap.delete(boardId);

      const serialCallback = (ch: string) => set((s) => {
        const boards = s.boards.map((b) =>
          b.id === boardId ? { ...b, serialOutput: b.serialOutput + ch } : b
        );
        return { boards, serialOutput: s.serialOutput + ch };
      });

      if (isEsp32Kind(type as BoardKind)) {
        // ESP32: use bridge, not AVR simulator
        const bridge = new Esp32Bridge(boardId, type as BoardKind);
        bridge.onSerialData = serialCallback;
        bridge.onPinChange = (gpioPin, state) => {
          const boardPm = pinManagerMap.get(boardId);
          if (boardPm) boardPm.triggerPinChange(gpioPin, state);
        };
        bridge.onCrash = () => { set({ esp32CrashBoardId: boardId }); };
        bridge.onDisconnected = () => {
          set((s) => {
            const boards = s.boards.map((b) => b.id === boardId ? { ...b, running: false } : b);
            const isActive = s.activeBoardId === boardId;
            return { boards, ...(isActive ? { running: false } : {}) };
          });
        };
        bridge.onLedcUpdate = makeLedcUpdateHandler(boardId);
        bridge.onWs2812Update = (channel, pixels) => {
          const eventTarget = document.getElementById(`ws2812-${boardId}-${channel}`);
          if (eventTarget) {
            eventTarget.dispatchEvent(new CustomEvent('ws2812-pixels', { detail: { pixels } }));
          }
        };
        esp32BridgeMap.set(boardId, bridge);
        const shim = new Esp32BridgeShim(bridge, pm);
        shim.onSerialData = serialCallback;
        simulatorMap.set(boardId, shim);

        set((s) => ({
          boardType: type,
          simulator: shim as any,
          compiledHex: null,
          serialOutput: '',
          serialBaudRate: 0,
          boards: s.boards.map((b) =>
            b.id === boardId
              ? { ...b, boardKind: type as BoardKind, compiledProgram: null, serialOutput: '', serialBaudRate: 0 }
              : b
          ),
        }));
      } else {
        const sim = createSimulator(
          type as BoardKind,
          pm,
          serialCallback,
          (baud) => set((s) => {
            const boards = s.boards.map((b) =>
              b.id === boardId ? { ...b, serialBaudRate: baud } : b
            );
            return { boards, serialBaudRate: baud };
          }),
          getOscilloscopeCallback(),
        );
        simulatorMap.set(boardId, sim);

        set((s) => ({
          boardType: type,
          simulator: sim,
          compiledHex: null,
          serialOutput: '',
          serialBaudRate: 0,
          boards: s.boards.map((b) =>
            b.id === boardId
              ? { ...b, boardKind: type as BoardKind, compiledProgram: null, serialOutput: '', serialBaudRate: 0 }
              : b
          ),
        }));
      }
      console.log(`Board switched to: ${type}`);
    },

    initSimulator: () => {
      const { boardType, activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      const pm = getBoardPinManager(boardId) ?? legacyPinManager;

      getBoardSimulator(boardId)?.stop();
      simulatorMap.delete(boardId);
      getEsp32Bridge(boardId)?.disconnect();
      esp32BridgeMap.delete(boardId);

      const serialCallback = (ch: string) => set((s) => {
        const boards = s.boards.map((b) =>
          b.id === boardId ? { ...b, serialOutput: b.serialOutput + ch } : b
        );
        return { boards, serialOutput: s.serialOutput + ch };
      });

      if (isEsp32Kind(boardType as BoardKind)) {
        // ESP32: create bridge + shim (same as setBoardType)
        const bridge = new Esp32Bridge(boardId, boardType as BoardKind);
        bridge.onSerialData = serialCallback;
        bridge.onPinChange = (gpioPin, state) => {
          const boardPm = pinManagerMap.get(boardId);
          if (boardPm) boardPm.triggerPinChange(gpioPin, state);
        };
        bridge.onCrash = () => { set({ esp32CrashBoardId: boardId }); };
        bridge.onDisconnected = () => {
          set((s) => {
            const boards = s.boards.map((b) => b.id === boardId ? { ...b, running: false } : b);
            const isActive = s.activeBoardId === boardId;
            return { boards, ...(isActive ? { running: false } : {}) };
          });
        };
        bridge.onLedcUpdate = makeLedcUpdateHandler(boardId);
        bridge.onWs2812Update = (channel, pixels) => {
          const eventTarget = document.getElementById(`ws2812-${boardId}-${channel}`);
          if (eventTarget) {
            eventTarget.dispatchEvent(new CustomEvent('ws2812-pixels', { detail: { pixels } }));
          }
        };
        esp32BridgeMap.set(boardId, bridge);
        const shim = new Esp32BridgeShim(bridge, pm);
        shim.onSerialData = serialCallback;
        simulatorMap.set(boardId, shim);
        set({ simulator: shim as any, serialOutput: '', serialBaudRate: 0 });
      } else {
        const sim = createSimulator(
          boardType as BoardKind,
          pm,
          serialCallback,
          (baud) => set((s) => {
            const boards = s.boards.map((b) =>
              b.id === boardId ? { ...b, serialBaudRate: baud } : b
            );
            return { boards, serialBaudRate: baud };
          }),
          getOscilloscopeCallback(),
        );
        simulatorMap.set(boardId, sim);
        set({ simulator: sim, serialOutput: '', serialBaudRate: 0 });
      }
      console.log(`Simulator initialized: ${boardType}`);
    },

    loadHex: (hex: string) => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      const sim = getBoardSimulator(boardId);
      if (sim && sim instanceof AVRSimulator) {
        try {
          sim.loadHex(hex);
          sim.addI2CDevice(new VirtualDS1307());
          sim.addI2CDevice(new VirtualTempSensor());
          sim.addI2CDevice(new I2CMemoryDevice(0x50));
          set((s) => ({ compiledHex: hex, hexEpoch: s.hexEpoch + 1 }));
          console.log('HEX file loaded successfully');
        } catch (error) {
          console.error('Failed to load HEX:', error);
        }
      } else {
        console.warn('loadHex: simulator not initialized or wrong board type');
      }
    },

    loadBinary: (base64: string) => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      const sim = getBoardSimulator(boardId);
      if (sim && sim instanceof RP2040Simulator) {
        try {
          sim.loadBinary(base64);
          sim.addI2CDevice(new VirtualDS1307() as RP2040I2CDevice);
          sim.addI2CDevice(new VirtualTempSensor() as RP2040I2CDevice);
          sim.addI2CDevice(new I2CMemoryDevice(0x50) as RP2040I2CDevice);
          set((s) => ({ compiledHex: base64, hexEpoch: s.hexEpoch + 1 }));
          console.log('Binary loaded into RP2040 successfully');
        } catch (error) {
          console.error('Failed to load binary:', error);
        }
      } else {
        console.warn('loadBinary: simulator not initialized or wrong board type');
      }
    },

    startSimulation: () => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      get().startBoard(boardId);
    },

    stopSimulation: () => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      get().stopBoard(boardId);
    },

    resetSimulation: () => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      get().resetBoard(boardId);
    },

    setCompiledHex: (hex: string) => {
      set({ compiledHex: hex });
      get().loadHex(hex);
    },

    setCompiledBinary: (base64: string) => {
      set({ compiledHex: base64 });
      get().loadBinary(base64);
    },

    setRunning: (running: boolean) => set({ running }),

    connectRemoteSimulator: (clientId: string) => {
      // Legacy: connect a Pi bridge for the given clientId
      const boardId = clientId;
      let bridge = getBoardBridge(boardId);
      if (!bridge) {
        bridge = new RaspberryPi3Bridge(boardId);
        bridge.onSerialData = (ch) => {
          set((s) => {
            const boards = s.boards.map((b) =>
              b.id === boardId ? { ...b, serialOutput: b.serialOutput + ch } : b
            );
            const isActive = s.activeBoardId === boardId;
            return { boards, ...(isActive ? { serialOutput: s.serialOutput + ch } : {}) };
          });
        };
        bridge.onPinChange = (gpioPin, state) => {
          const { wires } = get();
          const sim = getBoardSimulator(get().activeBoardId ?? INITIAL_BOARD_ID);
          if (!sim) return;
          const wire = wires.find(w =>
            (w.start.componentId.includes('raspberry-pi') && w.start.pinName === String(gpioPin)) ||
            (w.end.componentId.includes('raspberry-pi') && w.end.pinName === String(gpioPin))
          );
          if (wire) {
            const isArduinoStart = !wire.start.componentId.includes('raspberry-pi');
            const targetEndpoint = isArduinoStart ? wire.start : wire.end;
            const pinNum = parseInt(targetEndpoint.pinName, 10);
            if (!isNaN(pinNum)) sim.setPinState(pinNum, state);
          }
        };
        bridgeMap.set(boardId, bridge);
      }
      bridge.connect();
      set({ remoteConnected: true });
    },

    disconnectRemoteSimulator: () => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      getBoardBridge(boardId)?.disconnect();
      set({ remoteConnected: false, remoteSocket: null });
    },

    sendRemotePinEvent: (pin: string, state: number) => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      getBoardBridge(boardId)?.sendPinEvent(parseInt(pin, 10), state === 1);
    },

    // ── Components ────────────────────────────────────────────────────────
    components: [
      {
        id: 'led-builtin',
        metadataId: 'led',
        x: 350,
        y: 100,
        properties: { color: 'red', pin: 13, state: false },
      },
    ],

    wires: [
      {
        id: 'wire-test-1',
        start: { componentId: 'arduino-uno', pinName: 'GND.1', x: 0, y: 0 },
        end: { componentId: 'led-builtin', pinName: 'A', x: 0, y: 0 },
        waypoints: [],
        color: '#000000',
      },
      {
        id: 'wire-test-2',
        start: { componentId: 'arduino-uno', pinName: '13', x: 0, y: 0 },
        end: { componentId: 'led-builtin', pinName: 'C', x: 0, y: 0 },
        waypoints: [],
        color: '#22c55e',
      },
    ],
    selectedWireId: null,
    wireInProgress: null,

    addComponent: (component) => set((state) => ({ components: [...state.components, component] })),

    removeComponent: (id) => set((state) => ({
      components: state.components.filter((c) => c.id !== id),
      wires: state.wires.filter((w) => w.start.componentId !== id && w.end.componentId !== id),
    })),

    updateComponent: (id, updates) => {
      set((state) => ({
        components: state.components.map((c) => c.id === id ? { ...c, ...updates } : c),
      }));
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

    handleComponentEvent: (_componentId, _eventName, _data) => {},

    setComponents: (components) => set({ components }),

    addWire: (wire) => set((state) => ({ wires: [...state.wires, wire] })),

    removeWire: (wireId) => set((state) => ({
      wires: state.wires.filter((w) => w.id !== wireId),
      selectedWireId: state.selectedWireId === wireId ? null : state.selectedWireId,
    })),

    updateWire: (wireId, updates) => set((state) => ({
      wires: state.wires.map((w) => w.id === wireId ? { ...w, ...updates } : w),
    })),

    setSelectedWire: (wireId) => set({ selectedWireId: wireId }),

    setWires: (wires) => set({
      // Ensure every wire has waypoints (backwards-compatible with saved projects)
      wires: wires.map((w) => ({ waypoints: [], ...w })),
    }),

    startWireCreation: (endpoint, color) => set({
      wireInProgress: {
        startEndpoint: endpoint,
        waypoints: [],
        color,
        currentX: endpoint.x,
        currentY: endpoint.y,
      },
    }),

    updateWireInProgress: (x, y) => set((state) => {
      if (!state.wireInProgress) return state;
      return { wireInProgress: { ...state.wireInProgress, currentX: x, currentY: y } };
    }),

    addWireWaypoint: (x, y) => set((state) => {
      if (!state.wireInProgress) return state;
      return {
        wireInProgress: {
          ...state.wireInProgress,
          waypoints: [...state.wireInProgress.waypoints, { x, y }],
        },
      };
    }),

    setWireInProgressColor: (color) => set((state) => {
      if (!state.wireInProgress) return state;
      return { wireInProgress: { ...state.wireInProgress, color } };
    }),

    finishWireCreation: (endpoint) => {
      const state = get();
      if (!state.wireInProgress) return;
      const { startEndpoint, waypoints, color } = state.wireInProgress;
      const newWire: Wire = {
        id: `wire-${Date.now()}`,
        start: startEndpoint,
        end: endpoint,
        waypoints,
        color,
      };
      set((state) => ({ wires: [...state.wires, newWire], wireInProgress: null }));
    },

    cancelWireCreation: () => set({ wireInProgress: null }),

    updateWirePositions: (componentId) => {
      set((state) => {
        const component = state.components.find((c) => c.id === componentId);
        // Check if this componentId matches a board id
        const board = state.boards.find((b) => b.id === componentId);
        // Components have a DynamicComponent wrapper with border:2px + padding:4px → offset (4,6)
        // Boards are rendered directly without a wrapper, so no offset.
        const compX = component ? component.x + 4 : (board ? board.x : state.boardPosition.x);
        const compY = component ? component.y + 6 : (board ? board.y : state.boardPosition.y);

        const updatedWires = state.wires.map((wire) => {
          const updated = { ...wire };
          if (wire.start.componentId === componentId) {
            const pos = calculatePinPosition(componentId, wire.start.pinName, compX, compY);
            if (pos) updated.start = { ...wire.start, x: pos.x, y: pos.y };
          }
          if (wire.end.componentId === componentId) {
            const pos = calculatePinPosition(componentId, wire.end.pinName, compX, compY);
            if (pos) updated.end = { ...wire.end, x: pos.x, y: pos.y };
          }
          return updated;
        });
        return { wires: updatedWires };
      });
    },

    recalculateAllWirePositions: () => {
      const state = get();
      const updatedWires = state.wires.map((wire) => {
        const updated = { ...wire };

        // Resolve start — components have wrapper offset (4,6), boards do not
        const startComp = state.components.find((c) => c.id === wire.start.componentId);
        const startBoard = state.boards.find((b) => b.id === wire.start.componentId);
        const startX = startComp ? startComp.x + 4 : (startBoard ? startBoard.x : state.boardPosition.x);
        const startY = startComp ? startComp.y + 6 : (startBoard ? startBoard.y : state.boardPosition.y);
        const startPos = calculatePinPosition(wire.start.componentId, wire.start.pinName, startX, startY);
        updated.start = startPos
          ? { ...wire.start, x: startPos.x, y: startPos.y }
          : { ...wire.start, x: startX, y: startY };

        // Resolve end — components have wrapper offset (4,6), boards do not
        const endComp = state.components.find((c) => c.id === wire.end.componentId);
        const endBoard = state.boards.find((b) => b.id === wire.end.componentId);
        const endX = endComp ? endComp.x + 4 : (endBoard ? endBoard.x : state.boardPosition.x);
        const endY = endComp ? endComp.y + 6 : (endBoard ? endBoard.y : state.boardPosition.y);
        const endPos = calculatePinPosition(wire.end.componentId, wire.end.pinName, endX, endY);
        updated.end = endPos
          ? { ...wire.end, x: endPos.x, y: endPos.y }
          : { ...wire.end, x: endX, y: endY };

        return updated;
      });
      set({ wires: updatedWires });
    },

    toggleSerialMonitor: () => set((s) => ({ serialMonitorOpen: !s.serialMonitorOpen })),

    serialWrite: (text: string) => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;

      if (board.boardKind === 'raspberry-pi-3') {
        const bridge = getBoardBridge(boardId);
        if (bridge) {
          for (let i = 0; i < text.length; i++) {
            bridge.sendSerialByte(text.charCodeAt(i));
          }
        }
      } else if (isEsp32Kind(board.boardKind)) {
        const esp32Bridge = getEsp32Bridge(boardId);
        if (esp32Bridge) {
          esp32Bridge.sendSerialBytes(Array.from(new TextEncoder().encode(text)));
        }
      } else {
        getBoardSimulator(boardId)?.serialWrite(text);
      }
    },

    clearSerialOutput: () => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      set((s) => ({
        serialOutput: '',
        boards: s.boards.map((b) => b.id === boardId ? { ...b, serialOutput: '' } : b),
      }));
    },

    serialWriteToBoard: (boardId: string, text: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;
      if (board.boardKind === 'raspberry-pi-3') {
        const bridge = getBoardBridge(boardId);
        if (bridge) {
          for (let i = 0; i < text.length; i++) {
            bridge.sendSerialByte(text.charCodeAt(i));
          }
        }
      } else if (isEsp32Kind(board.boardKind)) {
        const esp32Bridge = getEsp32Bridge(boardId);
        if (esp32Bridge) {
          esp32Bridge.sendSerialBytes(Array.from(new TextEncoder().encode(text)));
        }
      } else {
        getBoardSimulator(boardId)?.serialWrite(text);
      }
    },

    clearBoardSerialOutput: (boardId: string) => {
      const isActive = get().activeBoardId === boardId;
      set((s) => ({
        ...(isActive ? { serialOutput: '' } : {}),
        boards: s.boards.map((b) => b.id === boardId ? { ...b, serialOutput: '' } : b),
      }));
    },
  };
});

// ── Helper: get the active board instance (convenience for consumers) ─────
export function getActiveBoard(): BoardInstance | null {
  const { boards, activeBoardId } = useSimulatorStore.getState();
  return boards.find((b) => b.id === activeBoardId) ?? null;
}

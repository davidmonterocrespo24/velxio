/**
 * Multi-board integration tests
 *
 * Covers:
 *  1. useEditorStore  — file group management per board
 *  2. useSimulatorStore — boards[], addBoard, startBoard/stopBoard, legacy compat
 *  3. boardPinMapping  — PI3_PHYSICAL_TO_BCM, boardPinToNumber for raspberry-pi-3
 *  4. RaspberryPi3Bridge — WebSocket connect/disconnect/message protocol
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────

// AVRSimulator: bare minimum stub (must use function, not arrow, for `new` to work)
vi.mock('../simulation/AVRSimulator', () => ({
  AVRSimulator: vi.fn(function (this: any) {
    this.onSerialData = null;
    this.onBaudRateChange = null;
    this.onPinChangeWithTime = null;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.reset = vi.fn();
    this.loadHex = vi.fn();
    this.serialWrite = vi.fn();
    this.addI2CDevice = vi.fn();
    this.setPinState = vi.fn();
  }),
}));

vi.mock('../simulation/RP2040Simulator', () => ({
  RP2040Simulator: vi.fn(function (this: any) {
    this.onSerialData = null;
    this.onPinChangeWithTime = null;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.reset = vi.fn();
    this.loadBinary = vi.fn();
    this.serialWrite = vi.fn();
    this.addI2CDevice = vi.fn();
  }),
}));

vi.mock('../simulation/PinManager', () => ({
  PinManager: vi.fn(function (this: any) {
    this.updatePort = vi.fn();
    this.onPinChange = vi.fn().mockReturnValue(() => {});
    this.getListenersCount = vi.fn().mockReturnValue(0);
  }),
}));

vi.mock('../simulation/I2CBusManager', () => ({
  VirtualDS1307: vi.fn(function (this: any) {}),
  VirtualTempSensor: vi.fn(function (this: any) {}),
  I2CMemoryDevice: vi.fn(function (this: any) {}),
}));

vi.mock('../store/useOscilloscopeStore', () => ({
  useOscilloscopeStore: {
    getState: vi.fn().mockReturnValue({ channels: [], pushSample: vi.fn() }),
  },
}));

// WebSocket mock (global)
class MockWebSocket {
  static OPEN = 1;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  // Helper: simulate incoming message
  receive(payload: object) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  // Simulate open
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);
vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1);
vi.stubGlobal('cancelAnimationFrame', vi.fn());

// ── Imports (after mocks) ────────────────────────────────────────────────
import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore, getBoardSimulator, getBoardBridge } from '../store/useSimulatorStore';
import {
  PI3_PHYSICAL_TO_BCM,
  PI3_BCM_TO_PHYSICAL,
  boardPinToNumber,
  isBoardComponent,
} from '../utils/boardPinMapping';
import { RaspberryPi3Bridge } from '../simulation/RaspberryPi3Bridge';

// ─────────────────────────────────────────────────────────────────────────────
// 1. boardPinMapping — Raspberry Pi 3B BCM map
// ─────────────────────────────────────────────────────────────────────────────

describe('boardPinMapping — Pi3B BCM', () => {
  it('maps known GPIO physical pins to correct BCM numbers', () => {
    expect(PI3_PHYSICAL_TO_BCM[11]).toBe(17); // BCM17
    expect(PI3_PHYSICAL_TO_BCM[12]).toBe(18); // BCM18 PWM0
    expect(PI3_PHYSICAL_TO_BCM[13]).toBe(27); // BCM27
    expect(PI3_PHYSICAL_TO_BCM[40]).toBe(21); // BCM21
  });

  it('maps power/GND pins to -1', () => {
    expect(PI3_PHYSICAL_TO_BCM[1]).toBe(-1); // 3.3V
    expect(PI3_PHYSICAL_TO_BCM[2]).toBe(-1); // 5V
    expect(PI3_PHYSICAL_TO_BCM[6]).toBe(-1); // GND
    expect(PI3_PHYSICAL_TO_BCM[9]).toBe(-1); // GND
  });

  it('reverse map BCM→physical is consistent', () => {
    // BCM17 is on physical pin 11
    expect(PI3_BCM_TO_PHYSICAL[17]).toBe(11);
    expect(PI3_BCM_TO_PHYSICAL[18]).toBe(12);
    expect(PI3_BCM_TO_PHYSICAL[27]).toBe(13);
  });

  it('boardPinToNumber returns BCM for raspberry-pi-3', () => {
    expect(boardPinToNumber('raspberry-pi-3', '11')).toBe(17);
    expect(boardPinToNumber('raspberry-pi-3', '12')).toBe(18);
    expect(boardPinToNumber('raspberry-pi-3', '40')).toBe(21);
  });

  it('boardPinToNumber returns -1 for power/GND pins', () => {
    expect(boardPinToNumber('raspberry-pi-3', '1')).toBe(-1);
    expect(boardPinToNumber('raspberry-pi-3', '6')).toBe(-1);
  });

  it('boardPinToNumber returns null for out-of-range pin', () => {
    expect(boardPinToNumber('raspberry-pi-3', '41')).toBeNull();
    expect(boardPinToNumber('raspberry-pi-3', 'SDA')).toBeNull();
  });

  it('isBoardComponent recognises raspberry-pi-3 and numbered variants', () => {
    expect(isBoardComponent('raspberry-pi-3')).toBe(true);
    expect(isBoardComponent('raspberry-pi-3-2')).toBe(true);
    expect(isBoardComponent('arduino-uno')).toBe(true);
    expect(isBoardComponent('led-builtin')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. useEditorStore — file groups
// ─────────────────────────────────────────────────────────────────────────────

describe('useEditorStore — file groups', () => {
  beforeEach(() => {
    // Reset store to initial state between tests
    useEditorStore.setState(useEditorStore.getInitialState?.() ?? {});
  });

  it('starts with a default file group for the initial Arduino Uno board', () => {
    const { fileGroups, activeGroupId } = useEditorStore.getState();
    expect(Object.keys(fileGroups)).toContain('group-arduino-uno');
    expect(activeGroupId).toBe('group-arduino-uno');
    expect(fileGroups['group-arduino-uno'].length).toBeGreaterThan(0);
    expect(fileGroups['group-arduino-uno'][0].name).toMatch(/\.ino$/);
  });

  it('createFileGroup creates a new group with a .ino file for Arduino', () => {
    const { createFileGroup, fileGroups } = useEditorStore.getState();
    createFileGroup('group-arduino-uno-2');
    const updated = useEditorStore.getState().fileGroups;
    expect(updated['group-arduino-uno-2']).toBeDefined();
    expect(updated['group-arduino-uno-2'][0].name).toMatch(/\.ino$/);
  });

  it('createFileGroup creates a .py file for Raspberry Pi 3', () => {
    const { createFileGroup } = useEditorStore.getState();
    createFileGroup('group-raspberry-pi-3');
    const updated = useEditorStore.getState().fileGroups;
    expect(updated['group-raspberry-pi-3']).toBeDefined();
    expect(updated['group-raspberry-pi-3'][0].name).toMatch(/\.py$/);
  });

  it('createFileGroup accepts custom initial files', () => {
    const { createFileGroup } = useEditorStore.getState();
    createFileGroup('group-custom', [
      { name: 'main.py', content: 'print("hello")' },
      { name: 'utils.py', content: '' },
    ]);
    const updated = useEditorStore.getState().fileGroups;
    expect(updated['group-custom'].length).toBe(2);
    expect(updated['group-custom'][0].name).toBe('main.py');
  });

  it('setActiveGroup switches files to the selected group', () => {
    const { createFileGroup, setActiveGroup } = useEditorStore.getState();
    createFileGroup('group-raspberry-pi-3');
    setActiveGroup('group-raspberry-pi-3');
    const s = useEditorStore.getState();
    expect(s.activeGroupId).toBe('group-raspberry-pi-3');
    expect(s.files[0].name).toMatch(/\.py$/);
  });

  it('deleteFileGroup removes the group', () => {
    const { createFileGroup, deleteFileGroup } = useEditorStore.getState();
    createFileGroup('group-temp');
    deleteFileGroup('group-temp');
    const updated = useEditorStore.getState().fileGroups;
    expect(updated['group-temp']).toBeUndefined();
  });

  it('createFile adds to active group', () => {
    const { createFile, activeGroupId } = useEditorStore.getState();
    const id = createFile('helper.h');
    const s = useEditorStore.getState();
    const groupFile = s.fileGroups[activeGroupId].find((f) => f.id === id);
    expect(groupFile).toBeDefined();
    expect(groupFile?.name).toBe('helper.h');
  });

  it('does not create duplicate groups', () => {
    const { createFileGroup } = useEditorStore.getState();
    createFileGroup('group-dup');
    createFileGroup('group-dup');
    const updated = useEditorStore.getState().fileGroups;
    expect(Object.keys(updated).filter((k) => k === 'group-dup').length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. useSimulatorStore — multi-board
// ─────────────────────────────────────────────────────────────────────────────

describe('useSimulatorStore — multi-board', () => {
  it('starts with one Arduino Uno board', () => {
    const { boards, activeBoardId } = useSimulatorStore.getState();
    expect(boards.length).toBe(1);
    expect(boards[0].boardKind).toBe('arduino-uno');
    expect(activeBoardId).toBe('arduino-uno');
  });

  it('addBoard creates a new board and registers runtime objects', async () => {
    const { addBoard, boards: before } = useSimulatorStore.getState();
    const id = addBoard('arduino-nano', 200, 100);
    const { boards: after } = useSimulatorStore.getState();
    expect(after.length).toBe(before.length + 1);
    const newBoard = after.find((b) => b.id === id);
    expect(newBoard).toBeDefined();
    expect(newBoard?.boardKind).toBe('arduino-nano');
    expect(newBoard?.x).toBe(200);
    expect(newBoard?.y).toBe(100);
  });

  it('addBoard for the same kind generates unique IDs', () => {
    const { addBoard } = useSimulatorStore.getState();
    const id1 = addBoard('arduino-mega', 0, 0);
    const id2 = addBoard('arduino-mega', 100, 0);
    expect(id1).not.toBe(id2);
  });

  it('removeBoard removes the board and cleans up', () => {
    const { addBoard, removeBoard } = useSimulatorStore.getState();
    const id = addBoard('arduino-nano', 0, 0);
    removeBoard(id);
    const { boards } = useSimulatorStore.getState();
    expect(boards.find((b) => b.id === id)).toBeUndefined();
  });

  it('setActiveBoardId switches legacy flat fields', () => {
    const { addBoard, setActiveBoardId } = useSimulatorStore.getState();
    addBoard('arduino-mega', 0, 0);
    const { boards } = useSimulatorStore.getState();
    const megaBoard = boards.find((b) => b.boardKind === 'arduino-mega');
    expect(megaBoard).toBeDefined();
    setActiveBoardId(megaBoard!.id);
    const s = useSimulatorStore.getState();
    expect(s.activeBoardId).toBe(megaBoard!.id);
    expect(s.boardType).toBe('arduino-mega');
  });

  it('setBoardPosition updates both legacy boardPosition and boards[]', () => {
    const { setBoardPosition, activeBoardId } = useSimulatorStore.getState();
    setBoardPosition({ x: 123, y: 456 });
    const s = useSimulatorStore.getState();
    expect(s.boardPosition).toEqual({ x: 123, y: 456 });
    const board = s.boards.find((b) => b.id === activeBoardId);
    expect(board?.x).toBe(123);
    expect(board?.y).toBe(456);
  });

  it('updateBoard merges partial updates', () => {
    const { activeBoardId, updateBoard } = useSimulatorStore.getState();
    updateBoard(activeBoardId!, { serialMonitorOpen: true });
    const s = useSimulatorStore.getState();
    const board = s.boards.find((b) => b.id === activeBoardId);
    expect(board?.serialMonitorOpen).toBe(true);
  });

  it('addBoard for raspberry-pi-3 creates a bridge (not a simulator)', () => {
    const { addBoard } = useSimulatorStore.getState();
    const id = addBoard('raspberry-pi-3', 500, 50);
    const { boards } = useSimulatorStore.getState();
    const piBoard = boards.find((b) => b.id === id);
    expect(piBoard?.boardKind).toBe('raspberry-pi-3');
    // No AVRSimulator for Pi — verify via module-level helpers
    expect(getBoardSimulator(id)).toBeUndefined();
    expect(getBoardBridge(id)).toBeDefined();
  });

  it('legacy startSimulation delegates to activeBoardId board', () => {
    const s = useSimulatorStore.getState();
    const startSpy = vi.spyOn(s, 'startBoard');
    s.startSimulation();
    expect(startSpy).toHaveBeenCalledWith(s.activeBoardId);
    startSpy.mockRestore();
  });

  it('legacy stopSimulation delegates to activeBoardId board', () => {
    const s = useSimulatorStore.getState();
    const stopSpy = vi.spyOn(s, 'stopBoard');
    s.stopSimulation();
    expect(stopSpy).toHaveBeenCalledWith(s.activeBoardId);
    stopSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. RaspberryPi3Bridge — WebSocket protocol
// ─────────────────────────────────────────────────────────────────────────────

describe('RaspberryPi3Bridge — WebSocket protocol', () => {
  let bridge: RaspberryPi3Bridge;
  let ws: MockWebSocket;

  beforeEach(() => {
    bridge = new RaspberryPi3Bridge('test-pi');
    bridge.connect();
    // Retrieve the mocked WebSocket instance
    ws = (bridge as any).socket as MockWebSocket;
    ws.open();
  });

  afterEach(() => {
    bridge.disconnect();
  });

  it('connects and sends start_pi on open', () => {
    expect(ws.sent.length).toBeGreaterThan(0);
    const firstMsg = JSON.parse(ws.sent[0]);
    expect(firstMsg.type).toBe('start_pi');
    expect(firstMsg.data.board).toBe('raspberry-pi-3');
  });

  it('connected property is true after open', () => {
    expect(bridge.connected).toBe(true);
  });

  it('sends stop_pi and closes on disconnect', () => {
    bridge.disconnect();
    const msgs = ws.sent.map((m) => JSON.parse(m));
    const stopMsg = msgs.find((m) => m.type === 'stop_pi');
    expect(stopMsg).toBeDefined();
    expect(bridge.connected).toBe(false);
  });

  it('sendSerialByte sends serial_input with correct byte', () => {
    bridge.sendSerialByte(65); // 'A'
    const last = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(last.type).toBe('serial_input');
    expect(last.data.bytes).toEqual([65]);
  });

  it('sendSerialBytes sends multiple bytes', () => {
    bridge.sendSerialBytes([72, 105, 10]); // "Hi\n"
    const last = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(last.type).toBe('serial_input');
    expect(last.data.bytes).toEqual([72, 105, 10]);
  });

  it('sendPinEvent sends gpio_in with correct pin and state', () => {
    bridge.sendPinEvent(17, true);
    const last = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(last.type).toBe('gpio_in');
    expect(last.data.pin).toBe(17);
    expect(last.data.state).toBe(1);

    bridge.sendPinEvent(17, false);
    const last2 = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(last2.data.state).toBe(0);
  });

  it('fires onSerialData for each character in serial_output', () => {
    const received: string[] = [];
    bridge.onSerialData = (ch) => received.push(ch);
    ws.receive({ type: 'serial_output', data: { data: 'Hello\n' } });
    expect(received).toEqual(['H', 'e', 'l', 'l', 'o', '\n']);
  });

  it('fires onPinChange for gpio_change events', () => {
    let gotPin = -1,
      gotState = false;
    bridge.onPinChange = (pin, state) => {
      gotPin = pin;
      gotState = state;
    };
    ws.receive({ type: 'gpio_change', data: { pin: 17, state: 1 } });
    expect(gotPin).toBe(17);
    expect(gotState).toBe(true);

    ws.receive({ type: 'gpio_change', data: { pin: 17, state: 0 } });
    expect(gotState).toBe(false);
  });

  it('fires onSystemEvent for system events', () => {
    let lastEvent = '';
    bridge.onSystemEvent = (event) => {
      lastEvent = event;
    };
    ws.receive({ type: 'system', data: { event: 'booted' } });
    expect(lastEvent).toBe('booted');
  });

  it('fires onError for error events', () => {
    let errMsg = '';
    bridge.onError = (msg) => {
      errMsg = msg;
    };
    ws.receive({ type: 'error', data: { message: 'QEMU crashed' } });
    expect(errMsg).toBe('QEMU crashed');
  });

  it('connected is false after server closes the socket', () => {
    ws.close();
    expect(bridge.connected).toBe(false);
  });

  it('does not send when socket is not open', () => {
    const closedBridge = new RaspberryPi3Bridge('closed-pi');
    // No connect() called
    const sentBefore = ws.sent.length;
    closedBridge.sendSerialByte(65);
    expect(ws.sent.length).toBe(sentBefore); // No new messages on old socket
  });
});

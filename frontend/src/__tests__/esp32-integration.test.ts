/**
 * ESP32 integration tests — frontend side
 *
 * Covers:
 *  1. boardPinMapping  — ESP32 GPIO pin number resolution
 *  2. Esp32Bridge      — WebSocket connect/disconnect/message protocol
 *  3. useSimulatorStore — addBoard('esp32'), startBoard, stopBoard,
 *                         compileBoardProgram (→ loadFirmware)
 *  4. useEditorStore   — ESP32 file groups default to sketch.ino
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../simulation/AVRSimulator', () => ({
  AVRSimulator: vi.fn(function (this: any) {
    this.onSerialData = null;
    this.onBaudRateChange = null;
    this.onPinChangeWithTime = null;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.reset = vi.fn();
    this.loadHex = vi.fn();
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

// WebSocket mock
class MockWebSocket {
  static OPEN    = 1;
  static CLOSING = 2;
  static CLOSED  = 3;

  readyState = MockWebSocket.OPEN;
  onopen:    (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose:   (() => void) | null = null;
  onerror:   (() => void) | null = null;
  sent: string[] = [];

  send(data: string)  { this.sent.push(data); }
  close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(); }
  open()  { this.readyState = MockWebSocket.OPEN;   this.onopen?.(); }
  receive(payload: object) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);
vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1);
vi.stubGlobal('cancelAnimationFrame', vi.fn());

// ── Imports (after mocks) ────────────────────────────────────────────────────
import { boardPinToNumber, isBoardComponent } from '../utils/boardPinMapping';
import { Esp32Bridge } from '../simulation/Esp32Bridge';
import { useSimulatorStore, getEsp32Bridge, getBoardSimulator } from '../store/useSimulatorStore';
import { useEditorStore } from '../store/useEditorStore';

// ─────────────────────────────────────────────────────────────────────────────
// 1. boardPinMapping — ESP32 GPIO pin resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('boardPinMapping — ESP32', () => {
  it('numeric string pin names map to GPIO numbers', () => {
    expect(boardPinToNumber('esp32', '2')).toBe(2);
    expect(boardPinToNumber('esp32', '13')).toBe(13);
    expect(boardPinToNumber('esp32', '0')).toBe(0);
    expect(boardPinToNumber('esp32', '39')).toBe(39);
  });

  it('GPIO-name aliases resolve correctly', () => {
    expect(boardPinToNumber('esp32', 'GPIO2')).toBe(2);
    expect(boardPinToNumber('esp32', 'GPIO13')).toBe(13);
    expect(boardPinToNumber('esp32', 'GPIO32')).toBe(32);
    expect(boardPinToNumber('esp32', 'GPIO36')).toBe(36);
  });

  it('UART aliases TX=1, RX=3', () => {
    expect(boardPinToNumber('esp32', 'TX')).toBe(1);
    expect(boardPinToNumber('esp32', 'RX')).toBe(3);
  });

  it('ADC input-only aliases VP=36, VN=39', () => {
    expect(boardPinToNumber('esp32', 'VP')).toBe(36);
    expect(boardPinToNumber('esp32', 'VN')).toBe(39);
  });

  it('out-of-range numeric string returns null', () => {
    expect(boardPinToNumber('esp32', '40')).toBeNull();
    expect(boardPinToNumber('esp32', '-1')).toBeNull();
  });

  it('unknown alias returns null', () => {
    expect(boardPinToNumber('esp32', 'MISO')).toBeNull();
    expect(boardPinToNumber('esp32', 'SDA')).toBeNull();
  });

  it('works for esp32-s3 and esp32-c3 board IDs', () => {
    expect(boardPinToNumber('esp32-s3', '13')).toBe(13);
    expect(boardPinToNumber('esp32-c3', 'GPIO5')).toBe(5);
  });

  it('isBoardComponent recognises esp32 variants', () => {
    expect(isBoardComponent('esp32')).toBe(true);
    expect(isBoardComponent('esp32-s3')).toBe(true);
    expect(isBoardComponent('esp32-c3')).toBe(true);
    expect(isBoardComponent('esp32-2')).toBe(true);   // second ESP32 board
    expect(isBoardComponent('unknown-chip')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Esp32Bridge — WebSocket protocol
// ─────────────────────────────────────────────────────────────────────────────

describe('Esp32Bridge — WebSocket protocol', () => {
  let bridge: Esp32Bridge;
  let ws: MockWebSocket;

  beforeEach(() => {
    bridge = new Esp32Bridge('test-esp32', 'esp32');
    bridge.connect();
    ws = (bridge as any).socket as MockWebSocket;
    ws.open();
  });

  afterEach(() => {
    bridge.disconnect();
  });

  it('connects and sends start_esp32 on open', () => {
    expect(ws.sent.length).toBeGreaterThan(0);
    const msg = JSON.parse(ws.sent[0]);
    expect(msg.type).toBe('start_esp32');
    expect(msg.data.board).toBe('esp32');
  });

  it('includes firmware_b64 in start_esp32 when pre-loaded', () => {
    const bridge2 = new Esp32Bridge('fw-esp32', 'esp32');
    bridge2.loadFirmware('AAEC');  // set before connect
    bridge2.connect();
    const ws2 = (bridge2 as any).socket as MockWebSocket;
    ws2.open();
    const msg = JSON.parse(ws2.sent[0]);
    expect(msg.type).toBe('start_esp32');
    expect(msg.data.firmware_b64).toBe('AAEC');
    bridge2.disconnect();
  });

  it('connected is true after open', () => {
    expect(bridge.connected).toBe(true);
  });

  it('sends stop_esp32 and closes on disconnect', () => {
    bridge.disconnect();
    const msgs = ws.sent.map((m) => JSON.parse(m));
    const stopMsg = msgs.find((m) => m.type === 'stop_esp32');
    expect(stopMsg).toBeDefined();
    expect(bridge.connected).toBe(false);
  });

  it('sendSerialByte sends esp32_serial_input with correct byte', () => {
    bridge.sendSerialByte(65); // 'A'
    const last = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(last.type).toBe('esp32_serial_input');
    expect(last.data.bytes).toEqual([65]);
  });

  it('sendSerialBytes sends multiple bytes', () => {
    bridge.sendSerialBytes([72, 105, 10]);
    const last = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(last.type).toBe('esp32_serial_input');
    expect(last.data.bytes).toEqual([72, 105, 10]);
  });

  it('sendSerialBytes with empty array sends nothing', () => {
    const before = ws.sent.length;
    bridge.sendSerialBytes([]);
    expect(ws.sent.length).toBe(before);
  });

  it('sendPinEvent sends esp32_gpio_in with correct pin and state', () => {
    bridge.sendPinEvent(2, true);
    const last = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(last.type).toBe('esp32_gpio_in');
    expect(last.data.pin).toBe(2);
    expect(last.data.state).toBe(1);

    bridge.sendPinEvent(2, false);
    const last2 = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(last2.data.state).toBe(0);
  });

  it('loadFirmware when connected sends load_firmware message', () => {
    bridge.loadFirmware('base64data==');
    const last = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(last.type).toBe('load_firmware');
    expect(last.data.firmware_b64).toBe('base64data==');
  });

  it('fires onSerialData for each character in serial_output', () => {
    const received: string[] = [];
    bridge.onSerialData = (ch) => received.push(ch);
    ws.receive({ type: 'serial_output', data: { data: 'LED ON\n' } });
    expect(received).toEqual(['L', 'E', 'D', ' ', 'O', 'N', '\n']);
  });

  it('fires onPinChange for gpio_change events', () => {
    let gotPin = -1, gotState = false;
    bridge.onPinChange = (pin, state) => { gotPin = pin; gotState = state; };

    ws.receive({ type: 'gpio_change', data: { pin: 2, state: 1 } });
    expect(gotPin).toBe(2);
    expect(gotState).toBe(true);

    ws.receive({ type: 'gpio_change', data: { pin: 2, state: 0 } });
    expect(gotState).toBe(false);
  });

  it('fires onSystemEvent for system events', () => {
    let lastEvent = '';
    bridge.onSystemEvent = (event) => { lastEvent = event; };
    ws.receive({ type: 'system', data: { event: 'booted' } });
    expect(lastEvent).toBe('booted');
  });

  it('fires onError for error events', () => {
    let errMsg = '';
    bridge.onError = (msg) => { errMsg = msg; };
    ws.receive({ type: 'error', data: { message: 'QEMU not found' } });
    expect(errMsg).toBe('QEMU not found');
  });

  it('connected is false after server closes the socket', () => {
    ws.close();
    expect(bridge.connected).toBe(false);
  });

  it('does not send when socket is not open', () => {
    const closedBridge = new Esp32Bridge('closed-esp32', 'esp32');
    // No connect() called — socket is null
    const before = ws.sent.length;
    closedBridge.sendSerialByte(65);
    expect(ws.sent.length).toBe(before);
  });

  it('boardId and boardKind are set correctly', () => {
    expect(bridge.boardId).toBe('test-esp32');
    expect(bridge.boardKind).toBe('esp32');
  });

  it('ESP32-S3 bridge sends esp32-s3 in start_esp32', () => {
    const s3Bridge = new Esp32Bridge('test-esp32-s3', 'esp32-s3');
    s3Bridge.connect();
    const s3Ws = (s3Bridge as any).socket as MockWebSocket;
    s3Ws.open();
    const msg = JSON.parse(s3Ws.sent[0]);
    expect(msg.data.board).toBe('esp32-s3');
    s3Bridge.disconnect();
  });

  it('ESP32-C3 no longer uses Esp32Bridge — uses browser-side Esp32C3Simulator', () => {
    // ESP32-C3 was moved from QEMU to the browser RV32IMC emulator.
    // Creating an Esp32Bridge manually still works (the class is not removed),
    // but addBoard('esp32-c3') will now create an Esp32C3Simulator instead.
    const c3Bridge = new Esp32Bridge('test-esp32-c3', 'esp32-c3');
    expect(c3Bridge.boardKind).toBe('esp32-c3'); // bridge still instantiatable
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. useSimulatorStore — ESP32 board management
// ─────────────────────────────────────────────────────────────────────────────

describe('useSimulatorStore — ESP32 boards', () => {
  beforeEach(() => {
    // Reset store between tests
    useSimulatorStore.setState(
      (useSimulatorStore as any).getInitialState?.() ?? {}
    );
  });

  it('addBoard("esp32") creates an Esp32Bridge + a shim in simulatorMap', () => {
    const { addBoard } = useSimulatorStore.getState();
    const id = addBoard('esp32', 300, 100);
    // Esp32BridgeShim is stored in simulatorMap so PartSimulationRegistry components work
    expect(getBoardSimulator(id)).toBeDefined();
    expect(getEsp32Bridge(id)).toBeDefined();
    expect(getEsp32Bridge(id)?.boardKind).toBe('esp32');
  });

  it('addBoard("esp32-s3") creates bridge with correct boardKind', () => {
    const { addBoard } = useSimulatorStore.getState();
    const id = addBoard('esp32-s3', 300, 100);
    expect(getEsp32Bridge(id)?.boardKind).toBe('esp32-s3');
  });

  it('addBoard("esp32-c3") uses QEMU Esp32Bridge (full ESP-IDF support)', () => {
    const { addBoard } = useSimulatorStore.getState();
    const id = addBoard('esp32-c3', 300, 100);
    // ESP32-C3 uses QEMU backend via Esp32Bridge for full ESP-IDF ROM compatibility
    expect(getEsp32Bridge(id)).toBeDefined();
    expect(getEsp32Bridge(id)?.boardKind).toBe('esp32-c3');
    // Esp32BridgeShim is also present in simulatorMap for component compatibility
    expect(getBoardSimulator(id)).toBeDefined();
  });

  it('addBoard creates a file group with sketch.ino (not script.py)', () => {
    const { addBoard } = useSimulatorStore.getState();
    const id = addBoard('esp32', 300, 100);
    const { fileGroups } = useEditorStore.getState();
    const groupId = `group-${id}`;
    expect(fileGroups[groupId]).toBeDefined();
    expect(fileGroups[groupId][0].name).toMatch(/\.ino$/);
  });

  it('boards list includes the new ESP32 board with correct kind', () => {
    const { addBoard } = useSimulatorStore.getState();
    const id = addBoard('esp32', 300, 100);
    const { boards } = useSimulatorStore.getState();
    const board = boards.find((b) => b.id === id);
    expect(board).toBeDefined();
    expect(board?.boardKind).toBe('esp32');
    expect(board?.running).toBe(false);
  });

  it('startBoard calls bridge.connect() for esp32', () => {
    const { addBoard, startBoard } = useSimulatorStore.getState();
    const id = addBoard('esp32', 300, 100);
    const bridge = getEsp32Bridge(id)!;
    const connectSpy = vi.spyOn(bridge, 'connect');
    startBoard(id);
    expect(connectSpy).toHaveBeenCalledOnce();
  });

  it('stopBoard calls bridge.disconnect() for esp32', () => {
    const { addBoard, startBoard, stopBoard } = useSimulatorStore.getState();
    const id = addBoard('esp32', 300, 100);
    startBoard(id);
    const bridge = getEsp32Bridge(id)!;
    const disconnectSpy = vi.spyOn(bridge, 'disconnect');
    stopBoard(id);
    expect(disconnectSpy).toHaveBeenCalledOnce();
  });

  it('compileBoardProgram calls bridge.loadFirmware for esp32', () => {
    const { addBoard, compileBoardProgram } = useSimulatorStore.getState();
    const id = addBoard('esp32', 300, 100);
    const bridge = getEsp32Bridge(id)!;
    const loadFirmwareSpy = vi.spyOn(bridge, 'loadFirmware');
    compileBoardProgram(id, 'base64binarydata==');
    expect(loadFirmwareSpy).toHaveBeenCalledWith('base64binarydata==');
  });

  it('compileBoardProgram stores program in board state', () => {
    const { addBoard, compileBoardProgram } = useSimulatorStore.getState();
    const id = addBoard('esp32', 300, 100);
    compileBoardProgram(id, 'firmware==');
    const { boards } = useSimulatorStore.getState();
    const board = boards.find((b) => b.id === id);
    expect(board?.compiledProgram).toBe('firmware==');
  });

  it('removeBoard cleans up bridge', () => {
    const { addBoard, removeBoard } = useSimulatorStore.getState();
    const id = addBoard('esp32', 300, 100);
    const bridge = getEsp32Bridge(id)!;
    const disconnectSpy = vi.spyOn(bridge, 'disconnect');
    removeBoard(id);
    expect(disconnectSpy).toHaveBeenCalledOnce();
    expect(getEsp32Bridge(id)).toBeUndefined();
  });

  it('setActiveBoardId syncs editor file group for esp32', () => {
    const { addBoard, setActiveBoardId } = useSimulatorStore.getState();
    const id = addBoard('esp32', 300, 100);
    setActiveBoardId(id);
    const { activeGroupId } = useEditorStore.getState();
    expect(activeGroupId).toBe(`group-${id}`);
  });

  it('two esp32 boards get unique IDs', () => {
    const { addBoard } = useSimulatorStore.getState();
    const id1 = addBoard('esp32', 100, 100);
    const id2 = addBoard('esp32', 300, 100);
    expect(id1).not.toBe(id2);
    const { boards } = useSimulatorStore.getState();
    expect(boards.filter((b) => b.boardKind === 'esp32').length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. useEditorStore — ESP32 file groups
// ─────────────────────────────────────────────────────────────────────────────

describe('useEditorStore — ESP32 file groups', () => {
  beforeEach(() => {
    useEditorStore.setState(useEditorStore.getInitialState?.() ?? {});
  });

  it('createFileGroup for esp32 creates sketch.ino (not script.py)', () => {
    const { createFileGroup, fileGroups } = useEditorStore.getState();
    createFileGroup('group-esp32');
    const groups = useEditorStore.getState().fileGroups;
    expect(groups['group-esp32']).toBeDefined();
    expect(groups['group-esp32'][0].name).toMatch(/\.ino$/);
  });

  it('createFileGroup for esp32-s3 creates sketch.ino', () => {
    const { createFileGroup } = useEditorStore.getState();
    createFileGroup('group-esp32-s3');
    const groups = useEditorStore.getState().fileGroups;
    expect(groups['group-esp32-s3'][0].name).toMatch(/\.ino$/);
  });

  it('createFileGroup for esp32-c3 creates sketch.ino', () => {
    const { createFileGroup } = useEditorStore.getState();
    createFileGroup('group-esp32-c3');
    const groups = useEditorStore.getState().fileGroups;
    expect(groups['group-esp32-c3'][0].name).toMatch(/\.ino$/);
  });

  it('default sketch.ino content is valid Arduino code', () => {
    const { createFileGroup } = useEditorStore.getState();
    createFileGroup('group-esp32-content');
    const groups = useEditorStore.getState().fileGroups;
    const content = groups['group-esp32-content'][0].content;
    expect(content).toContain('setup');
    expect(content).toContain('loop');
  });
});

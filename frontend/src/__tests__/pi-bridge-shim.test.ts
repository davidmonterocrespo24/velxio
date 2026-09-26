/**
 * pi-bridge-shim.test.ts — a Raspberry Pi board gets a simulator-shaped
 * object the catalog parts can attach to (simulation/PiBridgeShim.ts).
 *
 * Until 2026-09 a Pi had no entry in simulatorMap: addBoard built a bridge
 * and a PinManager and stopped there, and DynamicComponent handed parts a
 * hand-rolled stub with setPinState and little else. Every I2C part in the
 * catalog attached through addI2CDevice / getI2CBus, so on a Pi they had
 * nowhere to go: an MPU6050 wired to SDA/SCL was drawn and never answered,
 * and the guest's smbus2 read got the "no slave" stub. This file pins the
 * contract the parts rely on, and the bus grammar both engines route
 * through the shim.
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../simulation/RaspberryPi3Bridge', () => ({
  RaspberryPi3Bridge: class {
    boardId: string;
    boardKind: string;
    connected = false;
    onSerialData: unknown = null;
    onPinChange: unknown = null;
    onPinPull: unknown = null;
    onBusRequest: unknown = null;
    onGpioPwm: unknown = null;
    onBooted: unknown = null;
    onDisconnected: unknown = null;
    onError: unknown = null;
    /** The header UART, not the console (RaspberryPi3Bridge declares both).
     *  The shim chains itself onto this slot, so the tests fire it to play
     *  the guest writing to /dev/serial0. */
    onUartTx: ((text: string) => void) | null = null;
    quietBootDefault = false;
    quietBootLabel = '';
    sent: unknown[] = [];
    constructor(id: string, kind: string) {
      this.boardId = id;
      this.boardKind = kind;
    }
    connect() {}
    disconnect() {}
    sendPinEvent(pin: number, state: boolean) {
      this.sent.push({ pin, state });
    }
    // No setSensorState / attachSlave / sendUartBytes on purpose: the 17
    // suites that mock this bridge give it about this much, and the shim
    // must not throw at them.
  },
}));

import {
  useSimulatorStore,
  getBoardSimulator,
  getBoardBridge,
  getBoardPinManager,
  piMainScript,
} from '../store/useSimulatorStore';
import { PiBridgeShim } from '../simulation/PiBridgeShim';
import { registerPiBusOp } from '../lib/proBoardRegistry';
import {
  avrUartTx,
  detectSimulatorKind,
  ensureUartBridge,
  getSimulatorBridges,
} from '../simulation/customChips/simulatorBridges';
import { feedBoardSerialOut } from '../simulation/Interconnect';
import { setWires } from './helpers/multiBoardSetup';
import { VirtualBMP280, VirtualDS3231, VirtualPCF8574, type I2CDevice } from '../simulation/I2CBusManager';
import { attachI2cTarget } from '../simulation/buses';
import { i2cTargetOf } from '../simulation/parts/i2cPart';
import { PartSimulationRegistry } from '../simulation/parts';
import { lineGaps, clearLineGaps } from '../simulation/line/requestLine';

function addPi(kind = 'raspberry-pi-4') {
  const id = useSimulatorStore.getState().addBoard(kind as never, 100, 100);
  const shim = getBoardSimulator(id) as PiBridgeShim;
  return { id, shim };
}

beforeEach(() => {
  clearLineGaps();
});

/** Wire a part's SDA/SCL to the Pi's GPIO2/GPIO3 (/dev/i2c-1), as the canvas
 *  does: an I2C part is on the bus its wires reach (board-buses F5). */
function wireI2c1(boardId: string, componentId: string): void {
  useSimulatorStore.setState((s) => ({
    wires: [
      ...s.wires.filter((w) => w.start.componentId !== componentId),
      ...(['SDA', 'SCL'] as const).map((pinName) => ({
        id: `${componentId}-${pinName}`,
        start: { componentId, pinName, x: 0, y: 0 },
        end: { componentId: boardId, pinName: pinName === 'SDA' ? 'GPIO2' : 'GPIO3', x: 0, y: 0 },
        waypoints: [],
        color: '#0a0',
      })),
    ],
  }) as never);
}

let devSeq = 0;
/** A device model on /dev/i2c-1 by its wiring, the way a part registers (board-buses F5). */
function putOnI2c1(boardId: string, device: I2CDevice): () => void {
  const owner = `dev-${device.address.toString(16)}-${++devSeq}`;
  wireI2c1(boardId, owner);
  const h = attachI2cTarget(
    { owner, componentId: owner, pins: { sda: 'SDA', scl: 'SCL' }, addresses: [device.address] },
    i2cTargetOf(device),
  );
  return () => h.dispose();
}

describe('a Pi board has a simulator entry', () => {
  it('addBoard installs a PiBridgeShim next to the bridge and the PinManager', () => {
    const { id, shim } = addPi();
    expect(shim).toBeInstanceOf(PiBridgeShim);
    expect(shim.simulatorKind).toBe('pi');
    expect(getBoardBridge(id)).toBeDefined();
    expect(shim.pinManager).toBe(getBoardPinManager(id));
  });

  it('a mocked bridge without setSensorState does not make setPinState throw', () => {
    const { id, shim } = addPi();
    expect(() => shim.setPinState(17, true)).not.toThrow();
    expect(getBoardPinManager(id)?.getPinState(17)).toBe(true);
  });
});

// ── The header UART, both directions ────────────────────────────────────────
//
// A UART part attaches to a board the way the Grove modules do: it listens on
// the custom-chip bridge's `uartListeners` and answers through the simulator's
// `sendSerialBytes`. Every module with a command grammar is this shape, so a
// stand-in of that shape is what the tests drive, and what they assert is the
// user-visible thing: the module answered.

interface MockPiBridge {
  onUartTx: ((text: string) => void) | null;
  sendUartBytes?: (bytes: number[]) => void;
}

/**
 * An AT modem in twelve lines: it says nothing until it is spoken to, and
 * answers OK to a well-formed AT line. The real Grove AT modems (ESP8285,
 * WizFi360, HM-11, BC417, Wio-E5) attach through the same two seams.
 */
function attachAtModem(shim: PiBridgeShim): () => void {
  ensureUartBridge(shim);
  const bridges = getSimulatorBridges(shim);
  let line = '';
  const listener = (byte: number) => {
    const ch = String.fromCharCode(byte);
    if (ch !== '\r') {
      line += ch;
      return;
    }
    const reply = line.trim().toUpperCase() === 'AT' ? 'OK\r\n' : 'ERROR\r\n';
    line = '';
    shim.sendSerialBytes(Array.from(new TextEncoder().encode(reply)));
  };
  bridges.uartListeners.add(listener);
  return () => bridges.uartListeners.delete(listener);
}

const decode = (bytes: number[]) => new TextDecoder().decode(Uint8Array.from(bytes));

describe('a UART part on the header', () => {
  it("is the rp2040 browser path, and the part's reply reaches the guest header UART", () => {
    const { id, shim } = addPi();
    // The part-to-board direction only. avrUartTx routes an rp2040-kind
    // simulator through serialWriteByte; the shim used to have no such
    // method, so a part's replies went nowhere. What the board SENDS is the
    // test below, and it was the half that never worked.
    expect(detectSimulatorKind(shim)).toBe('rp2040');
    const bridge = getBoardBridge(id) as unknown as { sendUartBytes?: (b: number[]) => void };
    bridge.sendUartBytes = vi.fn();
    avrUartTx(shim, 0x41);
    avrUartTx(shim, 0x1ff);
    expect(bridge.sendUartBytes).toHaveBeenNthCalledWith(1, [0x41]);
    expect(bridge.sendUartBytes).toHaveBeenNthCalledWith(2, [0xff]);
  });

  it('answers the Linux guest that spoke to it', () => {
    const { id, shim } = addPi();
    const bridge = getBoardBridge(id) as unknown as MockPiBridge;
    const answered: number[] = [];
    bridge.sendUartBytes = (bytes) => answered.push(...bytes);
    const detach = attachAtModem(shim);

    // The guest wrote "AT\r" to /dev/serial0; the backend relays it as
    // `uart_tx` and RaspberryPi3Bridge hands the decoded text to onUartTx.
    bridge.onUartTx?.('AT\r');

    expect(decode(answered)).toBe('OK\r\n');
    detach();
  });

  it('answers the in-browser engine that spoke to it', () => {
    const { id, shim } = addPi();
    useSimulatorStore.setState((s) => ({
      boards: s.boards.map((b) => (b.id === id ? { ...b, engineMode: 'instant' } : b)),
    }));
    const answered: number[] = [];
    shim.instantAdapter = { onUartRx: (bytes) => answered.push(...bytes) };
    const detach = attachAtModem(shim);

    // The in-browser engine has no bridge and no socket: it announces every
    // byte its script transmits through feedBoardSerialOut, which is the
    // seam the pro overlay's installInstantEngine already calls.
    for (const ch of 'AT\r') feedBoardSerialOut(id, ch, 0);

    expect(decode(answered)).toBe('OK\r\n');
    detach();
  });

  it('hears each byte once while a peer board is on the same wire', () => {
    const { id, shim } = addPi();
    const { id: peerId } = addPi('raspberry-pi-3');
    const bridge = getBoardBridge(id) as unknown as MockPiBridge;
    const peerBridge = getBoardBridge(peerId) as unknown as MockPiBridge;
    const peerHeard: number[] = [];
    peerBridge.sendUartBytes = (bytes) => peerHeard.push(...bytes);
    setWires(useSimulatorStore, [
      { fromBoard: id, fromPin: 'GPIO14', toBoard: peerId, toPin: 'GPIO15' },
    ]);

    // The wire makes Interconnect take the same onUartTx slot the shim
    // already chained itself onto. Both wrappers keep their predecessor, so
    // the part must hear each byte exactly once and the peer must still get
    // it: the trap the Grove uartLink comment calls out, from the other end.
    ensureUartBridge(shim);
    const heard: number[] = [];
    getSimulatorBridges(shim).uartListeners.add((b) => heard.push(b));
    bridge.onUartTx?.('AT');

    expect(heard).toEqual([0x41, 0x54]);
    expect(decode(peerHeard)).toBe('AT');
    setWires(useSimulatorStore, []);
  });
});

describe('I2C parts attach to it', () => {
  it('BMP280, DS3231 and a PCF8574 backpack wired to GPIO2/3 are on /dev/i2c-1', () => {
    const { id, shim } = addPi();
    putOnI2c1(id, new VirtualBMP280(0x76));
    putOnI2c1(id, new VirtualDS3231());
    putOnI2c1(id, new VirtualPCF8574(0x27));
    expect(shim.i2cAddresses(1)).toEqual([0x27, 0x68, 0x76]);
    expect(shim.i2cAddresses(0)).toEqual([]);
  });

  it('the mpu6050 part wired to GPIO2/3 is on /dev/i2c-1, and on no other bus', () => {
    const { id, shim } = addPi();
    wireI2c1(id, 'mpu-1');
    const logic = PartSimulationRegistry.get('mpu6050');
    expect(logic?.attachEvents).toBeTypeOf('function');
    const element = document.createElement('div');
    const cleanup = logic!.attachEvents!(element, shim as never, () => null, 'mpu-1');
    expect(shim.i2cAddresses(1)).toContain(0x68);
    expect(shim.i2cAddresses(0)).not.toContain(0x68);
    cleanup();
    expect(shim.i2cAddresses(1)).not.toContain(0x68);
  });
});

describe('one I2C transaction', () => {
  it('WHO_AM_I on the MPU6050 model answers 0x68; an empty address is a NAK', () => {
    const { id, shim } = addPi();
    wireI2c1(id, 'mpu-1');
    const logic = PartSimulationRegistry.get('mpu6050');
    const cleanup = logic!.attachEvents!(document.createElement('div'), shim as never, () => null, 'mpu-1');
    expect(shim.i2cTransfer(0x68, [0x75], 1)).toEqual([0x68]);
    expect(shim.i2cTransfer(0x69, [0x75], 1)).toBeNull();
    cleanup();
  });

  it('the bus grammar: RR reads a register, T is a repeated-start read, a NAK is I2C_ERR', () => {
    const { id, shim } = addPi();
    putOnI2c1(id, new VirtualBMP280(0x76));
    // 0x58 is the BMP280's chip id (0x60 would be a BME280).
    expect(shim.answerBusLine('I2C 1 76 T d0 1')).toBe('I2C_DATA 1 76 58');
    expect(shim.answerBusLine('I2C 1 76 RR d0 1')).toBe('I2C_DATA 1 76 58');
    expect(shim.answerBusLine('I2C 1 77 RR d0 1')).toBe('I2C_ERR 1 77 nack');
    // The chip is on the bus its wires reach, and on no other.
    expect(shim.answerBusLine('I2C 0 76 RR d0 1')).toBe('I2C_ERR 0 76 nack');
  });
});

describe('one SPI transaction', () => {
  it('X clocks the bytes out and answers MISO; W clocks the same bytes and answers nothing', () => {
    // A guest that passed no rx buffer used to be answered anyway, and the
    // daemon blocked on a reply it discarded: one round trip per chunk of a
    // display frame. W and WC are the fire-and-forget form.
    const { shim } = addPi();
    const seen: number[] = [];
    // Straight at the controller's port, which is where the fabric binds: this
    // case is about the W/X verbs of the bus protocol, not about which device
    // the wiring picks out. The block handler the fabric installed on bind
    // goes first, so it is cleared here to leave the byte path exposed.
    const p0 = shim.getBusBinding().spi[0];
    p0.setBlockHandler?.(null);
    p0.setFrameHandler((mosi: number) => {
      seen.push(mosi);
      return 0x5a;
    });
    expect(shim.answerBusLine('SPI 0 0 X a1b2')).toBe('SPI_DATA 0 0 5a5a');
    expect(shim.answerBusLine('SPI 0 0 W c3d4')).toBeNull();
    expect(seen).toEqual([0xa1, 0xb2, 0xc3, 0xd4]);
  });

  it('WC holds the chip select down after the last byte, exactly as XC does', () => {
    const { id, shim } = addPi();
    const p0 = shim.getBusBinding().spi[0];
    p0.setBlockHandler?.(null);
    p0.setFrameHandler(() => 0xff);
    shim.answerBusLine('SPI 0 0 WC a1');
    expect(getBoardPinManager(id)?.getPinState(8)).toBe(false); // CE0 still low
    shim.answerBusLine('SPI 0 0 W b2');
    expect(getBoardPinManager(id)?.getPinState(8)).toBe(true); // released
  });
});

describe('what the guest tells the canvas', () => {
  it('PWM_START reaches the PinManager as a 0-1 duty', () => {
    const { id, shim } = addPi();
    expect(shim.answerBusLine('PWM_START 18 50 7.5')).toBeNull();
    expect(getBoardPinManager(id)?.getPwmValue(18)).toBeCloseTo(0.075, 5);
    shim.answerBusLine('PWM_STOP 18');
    expect(getBoardPinManager(id)?.getPwmValue(18)).toBe(0);
  });

  it('a pull-up input rests HIGH', () => {
    const { id, shim } = addPi();
    shim.answerBusLine('GPIO_SETUP 2 in pud_up');
    expect(getBoardPinManager(id)?.getPinPull(2)).toBe(1);
    expect(getBoardPinManager(id)?.getPinState(2)).toBe(true);
  });

  it('a level a part drives is said again to a fresh guest and to a fresh browser engine', () => {
    // A part attaches when it MOUNTS; the guest and the in-browser engine
    // start later. An e-paper panel rests its BUSY pad HIGH from the moment it
    // is wired: if nobody hears that, the pad reads 0 and a correct UltraChip
    // driver waits forever for "not busy".
    const { id, shim } = addPi();
    const bridge = getBoardBridge(id) as unknown as { sent: Array<{ pin: number; state: boolean }> };
    shim.setPinState(24, true);
    bridge.sent.length = 0;

    shim.startBusSync();
    expect(bridge.sent).toEqual([{ pin: 24, state: true }]);
    shim.stopBusSync();

    const heard: Array<[number, boolean]> = [];
    shim.instantAdapter = { onPinInput: (pin: number, state: boolean) => heard.push([pin, state]) } as never;
    expect(heard).toEqual([[24, true]]);
    shim.instantAdapter = null;
  });

  it("a pull's resting level is NOT replayed: it belongs to the run that programmed it", () => {
    const { id, shim } = addPi();
    const bridge = getBoardBridge(id) as unknown as { sent: Array<{ pin: number; state: boolean }> };
    shim.answerBusLine('GPIO_SETUP 5 in pud_up');
    bridge.sent.length = 0;
    shim.startBusSync();
    expect(bridge.sent).toEqual([]);
    shim.stopBusSync();
  });

  it('a pull does not overwrite the level a part is driving on that pin', () => {
    const { id, shim } = addPi();
    shim.setPinState(24, true); // the panel's BUSY pad, at rest
    shim.answerBusLine('GPIO_SETUP 24 in pud_down');
    expect(getBoardPinManager(id)?.getPinState(24)).toBe(true);
  });

  it('an analog part is refused with a no-adc gap, never silently accepted', () => {
    const { shim } = addPi();
    expect(shim.setAdcVoltage(26, 1.65)).toBe(false);
    const gap = lineGaps().find((g) => g.code === 'no-adc');
    expect(gap?.pin).toBe(26);
    // The advice has to name a route that WORKS. The MCP3008 reads the
    // voltage the circuit solve publishes for the net its channel sits on,
    // measured end to end on production in both engines. The ADS1115 was in
    // this sentence too and answers from its own sliders instead of its pads,
    // so it sent the user to a dead end; it stays out until it reads them.
    expect(gap?.why).toMatch(/MCP3008/);
    expect(gap?.why).not.toMatch(/ADS1115/);
  });
});

describe('an op the grammar does not know', () => {
  it('is answered by whoever registered it, with the board it came from', () => {
    const { id, shim } = addPi();
    const seen: Array<[string, string[]]> = [];
    const off = registerPiBusOp('CAM', (boardId, tokens) => {
      seen.push([boardId, tokens]);
      return 'CAM_JPEG abcd';
    });
    expect(shim.answerBusLine('CAM SNAP 640 480 85')).toBe('CAM_JPEG abcd');
    expect(seen).toEqual([[id, ['CAM', 'SNAP', '640', '480', '85']]]);
    off();
    expect(shim.answerBusLine('CAM SNAP 640 480 85')).toBeNull();
  });

  it('a built-in op is never handed over, and a handler that throws answers nothing', () => {
    const { shim } = addPi();
    const offI2c = registerPiBusOp('I2C', () => 'HIJACKED');
    expect(shim.answerBusLine('I2C 1 68 RR 75 1')).toBe('I2C_ERR 1 68 nack');
    offI2c();
    const offBoom = registerPiBusOp('BOOM', () => {
      throw new Error('no');
    });
    expect(shim.answerBusLine('BOOM 1')).toBeNull();
    offBoom();
  });
});

describe('the guest runs the file the project has', () => {
  it('script.py when present, else the first .py', () => {
    expect(piMainScript([{ name: 'main.py' }, { name: 'script.py' }])).toBe('script.py');
    expect(piMainScript([{ name: 'README.md' }, { name: 'main.py' }])).toBe('main.py');
    expect(piMainScript([])).toBe('script.py');
  });
});

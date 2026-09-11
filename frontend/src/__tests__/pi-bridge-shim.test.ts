/**
 * pi-bridge-shim.test.ts — a Raspberry Pi board gets a simulator-shaped
 * object the catalog parts can attach to (simulation/PiBridgeShim.ts).
 *
 * Until 2026-09 a Pi had no entry in simulatorMap: addBoard built a bridge
 * and a PinManager and stopped there, and DynamicComponent handed parts a
 * hand-rolled stub with setPinState and little else. Every I2C part in the
 * catalog attaches through addI2CDevice / getI2CBus, so on a Pi they had
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
import { VirtualBMP280, VirtualDS3231, VirtualPCF8574 } from '../simulation/I2CBusManager';
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

describe('I2C parts attach to it', () => {
  it('BMP280, DS3231 and a PCF8574 backpack land on the header bus', () => {
    const { shim } = addPi();
    shim.addI2CDevice(new VirtualBMP280(0x76));
    shim.addI2CDevice(new VirtualDS3231());
    shim.addI2CDevice(new VirtualPCF8574(0x27));
    const addrs = shim
      .getI2CBus()
      .listDevices()
      .map((d) => d.address)
      .sort((a, b) => a - b);
    expect(addrs).toEqual([0x27, 0x68, 0x76]);
  });

  it('the mpu6050 part attaches through the registry the way it does on an ESP32', () => {
    const { shim } = addPi();
    const logic = PartSimulationRegistry.get('mpu6050');
    expect(logic?.attachEvents).toBeTypeOf('function');
    const element = document.createElement('div');
    const cleanup = logic!.attachEvents!(element, shim as never, () => null, 'mpu-1');
    expect(shim.getI2CBus().listDevices().map((d) => d.address)).toContain(0x68);
    cleanup();
  });
});

describe('one I2C transaction', () => {
  it('WHO_AM_I on the MPU6050 model answers 0x68; an empty address is a NAK', () => {
    const { shim } = addPi();
    const logic = PartSimulationRegistry.get('mpu6050');
    const cleanup = logic!.attachEvents!(document.createElement('div'), shim as never, () => null, 'mpu-1');
    expect(shim.i2cTransfer(0x68, [0x75], 1)).toEqual([0x68]);
    expect(shim.i2cTransfer(0x69, [0x75], 1)).toBeNull();
    cleanup();
  });

  it('the bus grammar: RR reads a register, T is a repeated-start read, a NAK is I2C_ERR', () => {
    const { shim } = addPi();
    shim.addI2CDevice(new VirtualBMP280(0x76));
    // 0x58 is the BMP280's chip id (0x60 would be a BME280).
    expect(shim.answerBusLine('I2C 1 76 T d0 1')).toBe('I2C_DATA 1 76 58');
    expect(shim.answerBusLine('I2C 1 76 RR d0 1')).toBe('I2C_DATA 1 76 58');
    expect(shim.answerBusLine('I2C 1 77 RR d0 1')).toBe('I2C_ERR 1 77 nack');
    // Only the header bus carries devices.
    expect(shim.answerBusLine('I2C 0 76 RR d0 1')).toBe('I2C_ERR 0 76 nack');
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

  it('an analog part is refused with a no-adc gap, never silently accepted', () => {
    const { shim } = addPi();
    expect(shim.setAdcVoltage(26, 1.65)).toBe(false);
    const gap = lineGaps().find((g) => g.code === 'no-adc');
    expect(gap?.pin).toBe(26);
    expect(gap?.why).toMatch(/MCP3008/);
  });
});

describe('the guest runs the file the project has', () => {
  it('script.py when present, else the first .py', () => {
    expect(piMainScript([{ name: 'main.py' }, { name: 'script.py' }])).toBe('script.py');
    expect(piMainScript([{ name: 'README.md' }, { name: 'main.py' }])).toBe('main.py');
    expect(piMainScript([])).toBe('script.py');
  });
});

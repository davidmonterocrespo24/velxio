/**
 * Wiring diagnostics are said of a board that RUNS.
 *
 * The agent lands one wire per call, so a chip's SDA reaches the board before
 * its SCL does for a moment. The registry used to judge that moment ("its SDA
 * is on pin 18 of arduino_uno_1 and its SCL is not connected, so the chip
 * does not answer"), write it to the board's console, and never take it back:
 * the user read it at the next Run with both lines wired and a chip that
 * answered (the Grove SHT31 on an Uno's A4/A5, 2026-10). With a resolver that
 * knows which boards run, nothing is said while a board is idle; a Run
 * re-places every device and reports what is still wrong then, once per run.
 * A resolver without `running` keeps the old behaviour (the fixtures of every
 * other suite).
 */
import { describe, it, expect } from 'vitest';
import { BusRegistry } from '../registry';
import type {
  BoardPins,
  BusDiagnostic,
  I2cControllerPort,
  I2cRouting,
  I2cTarget,
  I2cTransactionHandler,
  NetResolver,
  PinRef,
  ResolvedPin,
  SpiControllerConfig,
  SpiControllerPort,
  SpiDevice,
  SpiRouting,
} from '../types';

const PINS: BoardPins = {
  onPinChange: () => () => {},
  peekPinState: () => undefined,
  driveInput: () => {},
};

class I2cPort implements I2cControllerPort {
  readonly bus = 'i2c' as const;
  readonly unit = 0;
  readonly name = 'I2C0';
  readonly remote = false;
  handler: I2cTransactionHandler | null = null;
  setTransactionHandler(h: I2cTransactionHandler | null): void {
    this.handler = h;
  }
  routing(): I2cRouting {
    return { sda: 18, scl: 19 };
  }
}

class SpiPort implements SpiControllerPort {
  readonly bus = 'spi' as const;
  readonly unit = 0;
  readonly name = 'SPI0';
  setFrameHandler(): void {}
  config(): SpiControllerConfig {
    return { enabled: true };
  }
  routing(): SpiRouting {
    return { sck: 13, mosi: 11, miso: 12 };
  }
}

class Circuit implements NetResolver {
  nets = new Map<string, ResolvedPin>();
  ids = ['uno'];
  runningIds = new Set<string>();
  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    return this.nets.get(`${ref.componentId}:${ref.pinName}`) ?? { kind: 'floating' };
  }
  boardKind(): string | undefined {
    return 'arduino-uno';
  }
  boards(): string[] {
    return this.ids;
  }
  running(boardId: string): boolean {
    return this.runningIds.has(boardId);
  }
  set(comp: string, pin: string, where: ResolvedPin | null): void {
    if (where === null) this.nets.delete(`${comp}:${pin}`);
    else this.nets.set(`${comp}:${pin}`, where);
  }
}

const on = (pin: number): ResolvedPin => ({ kind: 'board', boardId: 'uno', pin });
const CHIP: I2cTarget = { start: () => true, write: () => true, read: () => 0x42, stop: () => {} };
const SPI_DEV: SpiDevice = { transfer: (mosi: number) => mosi };

function rig() {
  const reg = new BusRegistry();
  const circuit = new Circuit();
  const diags: BusDiagnostic[] = [];
  reg.onDiagnostic((d) => diags.push(d));
  reg.setResolver(circuit);
  reg.bindEngine('uno', { pins: PINS, spi: [new SpiPort()], i2c: [new I2cPort()] });
  const run = () => {
    circuit.runningIds.add('uno');
    reg.netlistChanged();
  };
  const stop = () => {
    circuit.runningIds.delete('uno');
    reg.netlistChanged();
  };
  return { reg, circuit, diags, run, stop, of: (code: string) => diags.filter((d) => d.code === code) };
}

describe('wiring diagnostics wait for the board to run', () => {
  it('an I2C chip wired one line at a time is not judged between the two wires', () => {
    const r = rig();
    r.reg.attachI2c({ owner: 'sht31', pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x44] }, CHIP);
    // The agent's first call: SDA only.
    r.circuit.set('sht31', 'SDA', on(18));
    r.reg.netlistChanged();
    expect(r.of('i2c-wiring')).toEqual([]);
    // Its second call: SCL. Then Run.
    r.circuit.set('sht31', 'SCL', on(19));
    r.reg.netlistChanged();
    r.run();
    expect(r.diags).toEqual([]);
  });

  it('a chip still half wired when the board runs is reported then, once', () => {
    const r = rig();
    r.reg.attachI2c({ owner: 'sht31', pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x44] }, CHIP);
    r.circuit.set('sht31', 'SDA', on(18));
    r.reg.netlistChanged();
    expect(r.of('i2c-wiring')).toEqual([]);
    r.run();
    const said = r.of('i2c-wiring');
    expect(said).toHaveLength(1);
    expect(said[0].message).toMatch(/SDA is on pin 18 of uno and its SCL is not connected/);
    // The run goes on and the circuit is recomputed again: said once.
    r.reg.netlistChanged();
    expect(r.of('i2c-wiring')).toHaveLength(1);
  });

  it('the next run reports again what is still wrong, and nothing once it is fixed', () => {
    const r = rig();
    r.reg.attachI2c({ owner: 'sht31', pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x44] }, CHIP);
    r.circuit.set('sht31', 'SDA', on(18));
    r.run();
    expect(r.of('i2c-wiring')).toHaveLength(1);
    r.stop();
    r.run();
    expect(r.of('i2c-wiring'), 'a second Run repeats the verdict for the user watching it').toHaveLength(2);
    r.stop();
    r.circuit.set('sht31', 'SCL', on(19));
    r.reg.netlistChanged();
    r.run();
    expect(r.of('i2c-wiring')).toHaveLength(2);
  });

  it('a chip wired mid-run is judged at once, as before', () => {
    const r = rig();
    r.run();
    r.reg.attachI2c({ owner: 'sht31', pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x44] }, CHIP);
    r.circuit.set('sht31', 'SDA', on(18));
    r.reg.netlistChanged();
    expect(r.of('i2c-wiring')).toHaveLength(1);
  });

  it("an SPI device's floating chip select is reported at Run, not while wiring", () => {
    const r = rig();
    r.circuit.set('adc', 'SCK', on(13));
    r.circuit.set('adc', 'MOSI', on(11));
    r.circuit.set('adc', 'MISO', on(12));
    r.reg.attachSpi({ owner: 'adc', pins: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' } }, SPI_DEV);
    expect(r.of('spi-cs-floating')).toEqual([]);
    r.circuit.set('adc', 'CS', on(10));
    r.reg.netlistChanged();
    r.run();
    expect(r.diags).toEqual([]);
  });

  it('a resolver that does not say what runs keeps the old rule', () => {
    const reg = new BusRegistry();
    const diags: BusDiagnostic[] = [];
    reg.onDiagnostic((d) => diags.push(d));
    const circuit = new Circuit();
    // Erase `running`: the plain NetResolver of every other suite.
    const plain: NetResolver = {
      resolve: (ref) => circuit.resolve(ref),
      boardKind: () => 'arduino-uno',
      boards: () => circuit.ids,
    };
    reg.setResolver(plain);
    reg.bindEngine('uno', { pins: PINS, spi: [], i2c: [new I2cPort()] });
    reg.attachI2c({ owner: 'sht31', pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x44] }, CHIP);
    circuit.set('sht31', 'SDA', on(18));
    reg.netlistChanged();
    expect(diags.filter((d) => d.code === 'i2c-wiring')).toHaveLength(1);
  });
});

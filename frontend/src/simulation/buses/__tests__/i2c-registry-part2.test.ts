/**
 * Layer 1 of project board-buses-2026-09 (TESTS.md), F5 second part: what the
 * registry tells a remote worker about I2C, and what it tells the user.
 *
 *  - `onI2cMapChange(boardId)`: a rewire mid-run reaches the map without a
 *    sensor attach (part-two item 5);
 *  - `unplacedI2cOwners()`: the owners a worker must keep silent (item 5);
 *  - `bus-remote-responder-missing` for I2C: a target on a remote controller's
 *    bus with no worker model is named, one with a model is not (item 6);
 *  - `i2c-wiring` follows SPI's rule: nothing is said about a part neither of
 *    whose lines reaches a board (item 9).
 *
 * Fake circuit and fake ports with the real contracts; no engine.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BusRegistry } from '../registry';
import { WORKER_I2C_MODELS } from '../workerI2cModels';
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
} from '../types';

const PINS: BoardPins = {
  onPinChange: () => () => {},
  peekPinState: () => undefined,
  driveInput: () => {},
};

class Port implements I2cControllerPort {
  readonly bus = 'i2c' as const;
  readonly unit: number;
  readonly name: string;
  readonly remote: boolean;
  handler: I2cTransactionHandler | null = null;
  private readonly route: I2cRouting;
  constructor(unit: number, route: I2cRouting, remote: boolean) {
    this.unit = unit;
    this.name = `I2C${unit}`;
    this.route = route;
    this.remote = remote;
  }
  setTransactionHandler(h: I2cTransactionHandler | null): void {
    this.handler = h;
  }
  routing(): I2cRouting {
    return this.route;
  }
}

class Circuit implements NetResolver {
  nets = new Map<string, ResolvedPin>();
  ids = ['a', 'b'];
  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    return this.nets.get(`${ref.componentId}:${ref.pinName}`) ?? { kind: 'floating' };
  }
  boardKind(): string | undefined {
    return undefined;
  }
  boards(): string[] {
    return this.ids;
  }
  wire(comp: string, sda: ResolvedPin, scl: ResolvedPin): void {
    this.nets.set(`${comp}:SDA`, sda);
    this.nets.set(`${comp}:SCL`, scl);
  }
}

const on = (boardId: string, pin: number): ResolvedPin => ({ kind: 'board', boardId, pin });
const FLOATING: ResolvedPin = { kind: 'floating' };

const CHIP: I2cTarget = { start: () => true, write: () => true, read: () => 0x42, stop: () => {} };

const settle = () => new Promise<void>((r) => queueMicrotask(r));

function rig(remote = true) {
  const reg = new BusRegistry();
  const circuit = new Circuit();
  const diags: BusDiagnostic[] = [];
  reg.onDiagnostic((d) => diags.push(d));
  reg.setResolver(circuit);
  // Board a: one controller on SDA 21 / SCL 22, remote or in the tab.
  const port = new Port(0, { sda: 21, scl: 22 }, remote);
  reg.bindEngine('a', { pins: PINS, spi: [], i2c: [port] });
  const heard: string[] = [];
  reg.onI2cMapChange((id) => heard.push(id));
  const attach = (owner: string, sda: ResolvedPin, scl: ResolvedPin, remoteModel?: string) => {
    circuit.wire(owner, sda, scl);
    return reg.attachI2c(
      { owner, pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x68], remoteModel },
      CHIP,
    );
  };
  return {
    reg,
    circuit,
    diags,
    port,
    heard,
    attach,
    of: (code: string) => diags.filter((d) => d.code === code),
  };
}

describe('I2C map change hook (onI2cMapChange)', () => {
  let r: ReturnType<typeof rig>;
  beforeEach(async () => {
    r = rig();
    await settle();
    r.heard.length = 0;
  });

  it('a wire moved mid-run is announced for the board, with no sensor attach', async () => {
    r.attach('mpu', on('a', 21), on('a', 22), 'mpu6050');
    await settle();
    r.heard.length = 0;
    // The user drags SDA/SCL to another pair: only the circuit changed.
    r.circuit.wire('mpu', on('a', 25), on('a', 26));
    r.reg.netlistChanged();
    expect(r.heard, 'nothing before the change settles').toEqual([]);
    await settle();
    expect(r.heard).toContain('a');
    expect(r.reg.i2cPlacement('mpu')).toMatchObject({ boardId: 'a', sdaPin: 25 });
  });

  it('a target moving between two buses that both stay populated is announced', async () => {
    // Neither bus appears or empties, so no controller is routed again: only
    // the membership of the two buses changes.
    r.attach('stay-21', on('a', 21), on('a', 22), 'mpu6050');
    r.attach('stay-25', on('a', 25), on('a', 26), 'mpu6050');
    r.attach('mover', on('a', 21), on('a', 22), 'mpu6050');
    await settle();
    r.heard.length = 0;
    r.circuit.wire('mover', on('a', 25), on('a', 26));
    r.reg.netlistChanged();
    await settle();
    expect(r.heard).toEqual(['a']);
    expect(r.reg.i2cPlacement('mover')).toMatchObject({ sdaPin: 25 });
  });

  it('is coalesced: one call per board per task, whatever the recompute did', async () => {
    r.attach('mpu', on('a', 21), on('a', 22), 'mpu6050');
    r.attach('rtc', on('a', 21), on('a', 22), 'ds3231');
    r.reg.netlistChanged();
    r.reg.netlistChanged();
    await settle();
    expect(r.heard.filter((id) => id === 'a')).toHaveLength(1);
  });

  it('a target attached or removed is news to every board, not only its own', async () => {
    const h = r.attach('mpu', on('a', 21), on('a', 22), 'mpu6050');
    await settle();
    expect([...r.heard].sort()).toEqual(['a', 'b']);
    r.heard.length = 0;
    h.dispose();
    await settle();
    expect([...r.heard].sort()).toEqual(['a', 'b']);
  });

  it('a target moving from one board to another announces both', async () => {
    r.attach('mpu', on('a', 21), on('a', 22), 'mpu6050');
    await settle();
    r.heard.length = 0;
    r.circuit.wire('mpu', on('b', 4), on('b', 5));
    r.reg.netlistChanged();
    await settle();
    expect([...r.heard].sort()).toEqual(['a', 'b']);
  });

  it('a board bound again (Stop/Run, engine swap) is announced', async () => {
    r.reg.bindEngine('a', { pins: PINS, spi: [], i2c: [new Port(0, { sda: 21, scl: 22 }, true)] });
    await settle();
    expect(r.heard).toContain('a');
  });

  it('a listener that throws does not stop the others', async () => {
    r.reg.onI2cMapChange(() => {
      throw new Error('broken');
    });
    const also: string[] = [];
    r.reg.onI2cMapChange((id) => also.push(id));
    r.attach('mpu', on('a', 21), on('a', 22), 'mpu6050');
    await settle();
    expect(also).toContain('a');
  });
});

describe('unplacedI2cOwners', () => {
  it('names every owner on no bus, and per board every owner not on that board', () => {
    const r = rig();
    r.attach('on-a', on('a', 21), on('a', 22), 'mpu6050');
    r.attach('on-b', on('b', 4), on('b', 5), 'mpu6050');
    r.attach('loose', FLOATING, FLOATING, 'mpu6050');
    r.attach('half', on('a', 21), FLOATING, 'mpu6050');
    expect(r.reg.unplacedI2cOwners()).toEqual(['half', 'loose']);
    expect(r.reg.unplacedI2cOwners('a')).toEqual(['half', 'loose', 'on-b']);
    expect(r.reg.unplacedI2cOwners('b')).toEqual(['half', 'loose', 'on-a']);
  });

  it('an owner that leaves is in no list at all', () => {
    const r = rig();
    r.attach('loose', FLOATING, FLOATING).dispose();
    expect(r.reg.unplacedI2cOwners()).toEqual([]);
    expect(r.reg.unplacedI2cOwners('a')).toEqual([]);
  });
});

describe('I2C on a remote controller: a target the worker has no model of', () => {
  it('is named, once, with the board and its address', () => {
    const r = rig(true);
    r.attach('tab-only', on('a', 21), on('a', 22));
    r.reg.netlistChanged();
    const missing = r.of('bus-remote-responder-missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ bus: 'i2c', boardId: 'a', owners: ['tab-only'] });
    expect(missing[0].message).toMatch(/0x68/);
  });

  it('a target whose record the worker models is not named: no false positive', () => {
    const r = rig(true);
    for (const model of WORKER_I2C_MODELS) r.attach(`part-${model}`, on('a', 21), on('a', 22), model);
    expect(r.of('bus-remote-responder-missing')).toEqual([]);
  });

  it('a record type the worker has no branch for is named like no model at all', () => {
    const r = rig(true);
    r.attach('sht31', on('a', 21), on('a', 22), 'sht31');
    expect(r.of('bus-remote-responder-missing').map((d) => d.owners[0])).toEqual(['sht31']);
  });

  it('the same target on a controller in the tab is not named', () => {
    const r = rig(false);
    r.attach('tab-only', on('a', 21), on('a', 22));
    expect(r.of('bus-remote-responder-missing')).toEqual([]);
  });

  it('a target that never sees the clock gets its wiring note, not this one', () => {
    const r = rig(true);
    r.attach('lost', on('a', 21), on('a', 7));
    expect(r.of('bus-remote-responder-missing')).toEqual([]);
    expect(r.of('i2c-wiring').map((d) => d.owners[0])).toEqual(['lost']);
  });

  it('a target already placed is named when the board is bound to a remote controller later', () => {
    const reg = new BusRegistry();
    const circuit = new Circuit();
    const diags: BusDiagnostic[] = [];
    reg.onDiagnostic((d) => diags.push(d));
    reg.setResolver(circuit);
    circuit.wire('tab-only', on('a', 21), on('a', 22));
    reg.attachI2c({ owner: 'tab-only', pins: { sda: 'SDA', scl: 'SCL' }, addresses: [0x68] }, CHIP);
    expect(diags.filter((d) => d.code === 'bus-remote-responder-missing')).toEqual([]);
    reg.bindEngine('a', { pins: PINS, spi: [], i2c: [new Port(0, { sda: 21, scl: 22 }, true)] });
    expect(diags.filter((d) => d.code === 'bus-remote-responder-missing').map((d) => d.owners[0])).toEqual([
      'tab-only',
    ]);
  });
});

describe('WORKER_I2C_MODELS is what the ESP32 worker registers', () => {
  it('every type in the list has an I2C branch in esp32_worker.py, and no I2C branch is missing', () => {
    const src = readFileSync(
      resolve(__dirname, '../../../../../backend/app/services/esp32_worker.py'),
      'utf8',
    );
    // The types whose branch hands a slave to the bus table (_i2c_add), plus
    // the custom chip, whose runtime registers its own address.
    const branches = new Set<string>();
    // Each branch's body runs to the next test of sensor_type.
    const heads = [...src.matchAll(/sensor_type (?:==|in) \(?([^:)]+)\)?:/g)];
    heads.forEach((m, i) => {
      const end = i + 1 < heads.length ? heads[i + 1].index! : src.length;
      const body = src.slice(m.index! + m[0].length, Math.min(end, m.index! + 1200));
      if (!/_i2c_add\(/.test(body)) return;
      for (const t of m[1].matchAll(/'([^']+)'/g)) branches.add(t[1]);
    });
    branches.add('custom-chip');
    expect([...branches].sort()).toEqual([...WORKER_I2C_MODELS].sort());
    expect(src).toMatch(/sensor_type == 'custom-chip'/);
  });
});

describe('i2c-wiring: the same rule as SPI', () => {
  it('a part with neither line on a board (just dropped, or a project still loading) says nothing', () => {
    const r = rig();
    r.attach('dropped', FLOATING, FLOATING, 'mpu6050');
    r.attach('on-rail', { kind: 'rail', rail: 'vcc' }, FLOATING, 'mpu6050');
    r.reg.netlistChanged();
    expect(r.of('i2c-wiring')).toEqual([]);
    expect(r.reg.i2cPlacement('dropped')).toBeNull();
  });

  it('a part with one line on a board is half wired, and is named on that board', () => {
    const r = rig();
    r.attach('half-sda', on('a', 21), FLOATING, 'mpu6050');
    r.attach('half-scl', FLOATING, on('b', 5), 'mpu6050');
    const wiring = r.of('i2c-wiring');
    expect(wiring.map((d) => [d.owners[0], d.boardId]).sort()).toEqual([
      ['half-scl', 'b'],
      ['half-sda', 'a'],
    ]);
    expect(wiring.every((d) => d.boardId !== null)).toBe(true);
  });

  it('a part wired later is placed and was never reported while it was loose', () => {
    const r = rig();
    r.attach('mpu', FLOATING, FLOATING, 'mpu6050');
    r.circuit.wire('mpu', on('a', 21), on('a', 22));
    r.reg.netlistChanged();
    expect(r.reg.i2cPlacement('mpu')).toMatchObject({ boardId: 'a', clocked: true });
    expect(r.of('i2c-wiring')).toEqual([]);
  });
});

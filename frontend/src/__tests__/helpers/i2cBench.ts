/**
 * A bare simulator on the bus fabric, for tests that build a simulator by
 * hand instead of through the store: bind its engine, describe the circuit
 * as board pins, and put an I2CDevice-shaped model on a board's I2C pins the
 * way a part does (parts/i2cPart.ts). A device wired to the pins of two
 * boards is on both of their buses, which is what a net wired from one
 * board's I2C header to another's is on the bench.
 *
 * The page's registry is a singleton, so a file that uses this helper owns
 * the registry's circuit for its run: clearBench() in afterEach.
 */
import { busRegistry } from '../../simulation/buses';
import { i2cTargetOf } from '../../simulation/parts/i2cPart';
import type { I2CDevice } from '../../simulation/I2CBusManager';
import type { BusHandle, NetResolver, PinRef, ResolvedPin } from '../../simulation/buses/types';

export interface BoardPin {
  boardId: string;
  pin: number;
}

class BareCircuit implements NetResolver {
  readonly kinds = new Map<string, string>();
  readonly nets = new Map<string, BoardPin[]>();

  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    const first = this.nets.get(`${ref.componentId}:${ref.pinName}`)?.[0];
    return first ? { kind: 'board', ...first } : { kind: 'floating' };
  }

  resolveAll(ref: PinRef): ResolvedPin[] {
    if (ref.kind === 'board') return [{ kind: 'board', boardId: ref.boardId, pin: ref.pin }];
    return (this.nets.get(`${ref.componentId}:${ref.pinName}`) ?? []).map((p) => ({ kind: 'board' as const, ...p }));
  }

  boardKind(boardId: string): string | undefined {
    return this.kinds.get(boardId);
  }

  boards(): string[] {
    return Array.from(this.kinds.keys());
  }
}

let circuit: BareCircuit | null = null;
const handles: BusHandle[] = [];
let seq = 0;

function live(): BareCircuit {
  if (!circuit) circuit = new BareCircuit();
  return circuit;
}

/**
 * Put `sim` (anything with getBusBinding) on the fabric as `boardId` of
 * `kind`. The circuit becomes the registry's resolver here, every time: a
 * case in the same file may have installed a resolver of its own.
 */
export function bareBoard(boardId: string, kind: string, sim: unknown): void {
  const c = live();
  c.kinds.set(boardId, kind);
  busRegistry.setResolver(c);
  busRegistry.bindBoard(boardId, sim);
}

/**
 * Wire a device's SDA and SCL to board pins (one board, or one pin per board
 * the net reaches) and put it on the bus. The handle takes it off again.
 */
export function putI2cDevice(
  device: I2CDevice,
  sda: BoardPin | BoardPin[],
  scl: BoardPin | BoardPin[],
  owner = `dev-${device.address.toString(16)}-${++seq}`,
): BusHandle {
  const c = live();
  c.nets.set(`${owner}:SDA`, ([] as BoardPin[]).concat(sda));
  c.nets.set(`${owner}:SCL`, ([] as BoardPin[]).concat(scl));
  busRegistry.netlistChanged();
  const h = busRegistry.attachI2c(
    { owner, pins: { sda: 'SDA', scl: 'SCL' }, addresses: [device.address & 0x7f] },
    i2cTargetOf(device),
  );
  handles.push(h);
  return h;
}

/**
 * Wire a canvas part's own SDA/SCL pins to board pins, for a part that
 * registers itself with the fabric under its component id (a
 * PartSimulationRegistry part attached by hand): the part then lands on the
 * bus the way it does in the app.
 */
export function wireI2cPins(componentId: string, sda: BoardPin | BoardPin[], scl: BoardPin | BoardPin[]): void {
  const c = live();
  c.nets.set(`${componentId}:SDA`, ([] as BoardPin[]).concat(sda));
  c.nets.set(`${componentId}:SCL`, ([] as BoardPin[]).concat(scl));
  busRegistry.netlistChanged();
}

/** Every device off, every board unbound, the circuit empty. */
export function clearBench(): void {
  for (const h of handles.splice(0)) h.dispose();
  if (!circuit) return;
  const ids = Array.from(circuit.kinds.keys());
  circuit.kinds.clear();
  circuit.nets.clear();
  for (const id of ids) busRegistry.unbindBoard(id);
  busRegistry.netlistChanged();
}

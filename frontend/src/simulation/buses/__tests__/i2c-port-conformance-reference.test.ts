/**
 * The I2C port conformance kit run against a REFERENCE port: a fake engine
 * whose guest performs Wire exchanges in plain JS and whose SoC object is
 * rebuilt on every reset, Stop/Run and reload, the way real engines rebuild
 * theirs. It shows the kit passes a port that keeps the contract; the
 * mutation controls recorded in STATUS show it fails ports that break it.
 * Real engines run the same kit from their own port-conformance tests.
 */
import { defineI2cPortConformance, type I2cConformanceRig, type I2cGuestResult } from '../conformance/i2cPortConformance';
import type { EngineBinding, I2cControllerPort, I2cRouting, I2cTransactionHandler } from '../types';

/** The engine's own peripheral, thrown away on every rebuild. */
class FakeSoc {
  handler: I2cTransactionHandler | null = null;
}

/** An adapter that keeps its identity and re-attaches to each new SoC. */
class ReferencePort implements I2cControllerPort {
  readonly bus = 'i2c' as const;
  readonly unit: number;
  readonly name: string;
  private handler: I2cTransactionHandler | null = null;
  private soc: FakeSoc;
  private readonly route: I2cRouting;
  constructor(unit: number, soc: FakeSoc, route: I2cRouting) {
    this.unit = unit;
    this.name = `I2C${unit}`;
    this.soc = soc;
    this.route = route;
    this.attach(soc);
  }
  attach(soc: FakeSoc): void {
    this.soc = soc;
    soc.handler = this.handler;
  }
  setTransactionHandler(h: I2cTransactionHandler | null): void {
    this.handler = h;
    this.soc.handler = h;
  }
  routing(): I2cRouting {
    return { ...this.route };
  }
}

function makeRig(): I2cConformanceRig {
  const routes: Record<number, I2cRouting> = { 0: { sda: 4, scl: 5 }, 1: { sda: 26, scl: 27 } };
  let socs: FakeSoc[] = [new FakeSoc(), new FakeSoc()];
  const ports = [new ReferencePort(0, socs[0], routes[0]), new ReferencePort(1, socs[1], routes[1])];
  const binding: EngineBinding = {
    pins: { onPinChange: () => () => {}, peekPinState: () => undefined },
    spi: [],
    i2c: ports,
  };
  const rebuild = async () => {
    socs = [new FakeSoc(), new FakeSoc()];
    ports.forEach((p, i) => p.attach(socs[i]));
  };
  return {
    units: [0, 1],
    binding: () => binding,
    async run(txs) {
      const out: I2cGuestResult[] = [];
      for (const tx of txs) {
        const h = socs[tx.unit].handler;
        let status = 0;
        if (tx.write.length > 0 || tx.read === 0) {
          const ack = h ? h.start(tx.address, false) : false;
          status = ack ? 0 : 2;
          if (ack) {
            for (const b of tx.write) {
              if (!h!.write(b)) {
                status = 3;
                break;
              }
            }
          }
          if (status !== 0 || tx.read === 0) {
            h?.stop();
            out.push({ status, read: [] });
            continue;
          }
        }
        const ack = h ? h.start(tx.address, true) : false;
        const read: number[] = [];
        if (ack) for (let i = 0; i < tx.read; i++) read.push(h!.read() & 0xff);
        h?.stop();
        out.push({ status: ack ? status : 2, read });
      }
      return out;
    },
    reset: rebuild,
    stopRun: rebuild,
    reload: rebuild,
    expectedRouting: (unit) => routes[unit],
    onPinEdge: () => () => {},
  };
}

defineI2cPortConformance('reference port', async () => makeRig());

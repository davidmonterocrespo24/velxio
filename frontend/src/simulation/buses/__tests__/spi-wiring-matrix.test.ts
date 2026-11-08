/**
 * The spi-wiring check on a GPIO-matrix board compares a part's data lines with
 * where the guest routes the controller's, never with an IO_MUX pad it only
 * assumed (velxio/velxio-prod#210).
 *
 * The UNIHIKER K10's screen sketches call SPI.begin(12, -1, 21): MOSI reaches
 * the panel's pin 21 through the GPIO matrix, and GP-SPI2's IO_MUX MOSI pad is
 * 11. A board bound through a port that cannot say where the guest routed its
 * lines (the backend worker's lane: an OSS build, ?esp32sim=qemu, or a K10
 * created before the overlay's in-browser engine was installed) fell back to
 * the controller's default pins, and the fabric printed "its MOSI is on pin 21
 * but GPSPI2 drives MOSI on pin 11" while the screen drew.
 */
import { describe, expect, it } from 'vitest';
import { BusRegistry } from '../registry';
import type {
  BoardPins,
  BusDiagnostic,
  NetResolver,
  PinRef,
  ResolvedPin,
  SpiControllerConfig,
  SpiControllerPort,
  SpiRouting,
} from '../types';
import { registerBoardPinFunctions } from '../pinFunctions';

class Pins implements BoardPins {
  onPinChange(): () => void {
    return () => {};
  }
  peekPinState(): boolean | undefined {
    return undefined;
  }
  driveInput(): void {}
}

class Port implements SpiControllerPort {
  readonly bus = 'spi' as const;
  constructor(
    readonly unit: number,
    readonly name: string,
    public route: SpiRouting | 'static',
  ) {}
  setFrameHandler(): void {}
  setBlockHandler(): void {}
  setHardwareCsHandler(): void {}
  config(): SpiControllerConfig {
    return { enabled: true, mode: 0, bitOrder: 'msb', bits: 8 };
  }
  routing(): SpiRouting | 'static' {
    return this.route;
  }
}

class Circuit implements NetResolver {
  constructor(private readonly kind: string) {}
  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    return { kind: 'floating' };
  }
  boardKind(): string | undefined {
    return this.kind;
  }
  boards(): string[] {
    return ['k10'];
  }
}

// An ESP32-S3 board: any pad carries any signal through the GPIO matrix, and
// GP-SPI2's IO_MUX pads are SCK 12, MOSI 11, MISO 13, CS 10.
registerBoardPinFunctions(['test-s3-matrix'], {
  routing: 'matrix',
  source: 'test',
  controllers: [
    { bus: 'spi', unit: 2, name: 'GPSPI2', arduino: ['SPI'], defaultPins: { sck: 12, mosi: 11, miso: 13, cs: 10 } },
  ],
  pins: {},
});
// A board whose SPI pins are the hardware's (no matrix).
registerBoardPinFunctions(['test-fixed'], {
  routing: 'fixed',
  source: 'test',
  controllers: [
    { bus: 'spi', unit: 0, name: 'SPI', arduino: ['SPI'], defaultPins: { sck: 13, mosi: 11, miso: 12, cs: 10 } },
  ],
  pins: {},
});

/** A panel on the board's own pins, as builtinPanelBus() puts the K10's. */
function wiring(kind: string, port: Port, panel: { sck: number; mosi: number; cs: number }): string[] {
  const reg = new BusRegistry();
  const diags: BusDiagnostic[] = [];
  reg.onDiagnostic((d) => diags.push(d));
  reg.setResolver(new Circuit(kind));
  reg.bindEngine('k10', { pins: new Pins(), spi: [port] });
  const at = (pin: number): PinRef => ({ kind: 'board', boardId: 'k10', pin });
  reg.attachSpi(
    { owner: 'builtin:k10:lcd', pins: { sck: at(panel.sck), mosi: at(panel.mosi), cs: at(panel.cs) } },
    { transfer: () => 0xff },
  );
  return diags.filter((d) => d.code === 'spi-wiring').map((d) => d.message);
}

describe('spi-wiring on a GPIO-matrix board', () => {
  it('a port that cannot say where the guest routed MOSI calls nothing miswired (the K10 case)', () => {
    expect(wiring('test-s3-matrix', new Port(2, 'GPSPI2', 'static'), { sck: 12, mosi: 21, cs: 14 })).toEqual([]);
  });

  it('the routing the guest set through the matrix is what the part is checked against', () => {
    const port = new Port(2, 'GPSPI2', { sck: 12, mosi: 21, cs: [] });
    expect(wiring('test-s3-matrix', port, { sck: 12, mosi: 21, cs: 14 })).toEqual([]);
    const off = wiring('test-s3-matrix', new Port(2, 'GPSPI2', { sck: 12, mosi: 21, cs: [] }), {
      sck: 12,
      mosi: 22,
      cs: 14,
    });
    expect(off).toEqual([
      'builtin:k10:lcd: its MOSI is on pin 22 but GPSPI2 drives MOSI on pin 21; the chip will not receive the controller\'s data.',
    ]);
  });

  it('a guest on the IO_MUX pads still gets a part miswired off them named', () => {
    const port = new Port(2, 'GPSPI2', { sck: 12, mosi: 11, miso: 13, cs: [10] });
    expect(wiring('test-s3-matrix', port, { sck: 12, mosi: 21, cs: 14 })).toEqual([
      'builtin:k10:lcd: its MOSI is on pin 21 but GPSPI2 drives MOSI on pin 11; the chip will not receive the controller\'s data.',
    ]);
  });
});

describe('spi-wiring on a board with fixed SPI pins', () => {
  it('the default pins are the hardware’s, so a part off them is still miswired', () => {
    expect(wiring('test-fixed', new Port(0, 'SPI', 'static'), { sck: 13, mosi: 12, cs: 10 })).toEqual([
      'builtin:k10:lcd: its MOSI is on pin 12 but SPI drives MOSI on pin 11; the chip will not receive the controller\'s data.',
    ]);
  });
});

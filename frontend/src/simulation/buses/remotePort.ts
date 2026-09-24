/**
 * The controller port of a board whose CPU is not in this tab (project
 * board-buses-2026-09, F4).
 *
 * An ESP32, an STM32 or a Pi runs its firmware in a backend QEMU worker. The
 * worker asks for the MISO of every byte synchronously and cannot wait for a
 * round trip, so everything that DRIVES MISO runs beside the guest and the tab
 * keeps the SINKS: displays, e-paper, LED drivers, anything that only listens.
 *
 * This port is that half. The worker hands the tab the MOSI bytes it clocked,
 * in order and already framed by the chip-select and D/C edges around them
 * (`esp32_worker.py` flushes its batch before every one), and this port pushes
 * them into the board's fabric exactly as a local engine would. The fabric
 * arbitrates by chip select the same way for both lanes, which is the point:
 * one bus model, two places the master can live.
 *
 * What comes back goes nowhere. A responder in the tab answers a byte the
 * guest clocked milliseconds ago, and a late answer is worse than none: it
 * lands on some later byte (the 2026-09 "touch reads the previous command"
 * finding). A responder that matters is sent to the worker as a portable model
 * in the bus map instead, and one with no portable model is reported rather
 * than left half working.
 */

import type {
  SpiControllerConfig,
  SpiControllerPort,
  SpiMode,
  SpiRouting,
} from './types';

export interface RemoteSpiPortOptions {
  /** The SoC's index for this controller (matches the pin function table). */
  unit: number;
  /** Datasheet name, for diagnostics. */
  name: string;
  /** Live routing when the engine reports it; 'static' uses the board table. */
  routing?: () => SpiRouting | 'static';
  mode?: SpiMode;
}

/**
 * A controller port fed by a remote worker. `deliver` is the only way bytes
 * enter it; nothing in the tab can clock it.
 */
export class RemoteSpiPort implements SpiControllerPort {
  readonly bus = 'spi' as const;
  readonly unit: number;
  readonly name: string;
  /** Tells the bus this master is not in the tab, so a responder that cannot
   *  be hosted here is worth a diagnostic instead of a silent wrong answer. */
  readonly remote = true;

  private frameHandler: ((mosi: number, bits: number) => number) | null = null;
  private blockHandler: ((mosi: Uint8Array, miso: Uint8Array | null) => void) | null = null;
  private hwCsHandler: ((index: number, active: boolean) => void) | null = null;
  private routingHandler: (() => void) | null = null;
  private readonly routingOf: () => SpiRouting | 'static';
  private readonly mode: SpiMode;

  constructor(opts: RemoteSpiPortOptions) {
    this.unit = opts.unit;
    this.name = opts.name;
    this.routingOf = opts.routing ?? (() => 'static');
    this.mode = opts.mode ?? 0;
  }

  setFrameHandler(handler: ((mosi: number, bits: number) => number) | null): void {
    this.frameHandler = handler;
  }

  setBlockHandler(handler: ((mosi: Uint8Array, miso: Uint8Array | null) => void) | null): void {
    this.blockHandler = handler;
  }

  setHardwareCsHandler(handler: ((index: number, active: boolean) => void) | null): void {
    this.hwCsHandler = handler;
  }

  setRoutingChangeHandler(handler: (() => void) | null): void {
    this.routingHandler = handler;
  }

  config(): SpiControllerConfig {
    // The worker does not report the guest's mode or bit order, so the port
    // declares the default rather than a guess: a mode diagnostic the fabric
    // raised from an invented value would be worse than no diagnostic.
    return { enabled: true, mode: this.mode, bitOrder: 'msb', bits: 8 };
  }

  routing(): SpiRouting | 'static' {
    return this.routingOf();
  }

  /** The engine's pins moved (SPI.begin with explicit pins). */
  routingChanged(): void {
    this.routingHandler?.();
  }

  /**
   * MOSI bytes the guest already clocked. Delivered as a block: the selection
   * cannot have changed inside a batch, because the worker flushes before
   * every chip-select and pin edge, so this is what byte-by-byte would give.
   * `miso` is null on purpose - the answer has nowhere to go.
   */
  deliver(mosi: Uint8Array): void {
    if (mosi.length === 0) return;
    if (this.blockHandler) {
      this.blockHandler(mosi, null);
      return;
    }
    const frame = this.frameHandler;
    if (!frame) return;
    for (let i = 0; i < mosi.length; i++) frame(mosi[i], 8);
  }

  /**
   * A chip select the SPI peripheral drives itself. QEMU moves no GPIO for a
   * pad the peripheral owns, so this event is the only place its level exists
   * in the tab, exactly as it is the only place it exists in the worker.
   */
  hardwareCs(index: number, active: boolean): void {
    this.hwCsHandler?.(index, active);
  }
}

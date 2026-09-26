/**
 * Per-simulator bridge state for custom chips.
 *
 * Each simulator family exposes its peripherals differently:
 *   - AVR (avr8js)   — `simulator.usart` / `simulator.i2cBus`
 *   - RP2040 (rp2040js) — `simulator.serialWriteByte` / `simulator.getBusBinding`
 *   - ESP32 (bridge shim) — `simulator.sendPinEvent`. The shim wraps either
 *     the backend QEMU bridge, which hosts custom chips in its worker
 *     (CustomChipPart hands the WASM over and no browser instance exists),
 *     or an overlay's in-browser engine, which answers `hostsCustomChips()`
 *     false so the chip runs here: GPIO through the shim's PinManager, UART
 *     on CHIP_UART.
 *
 * The bridges in this module install a single dispatcher per simulator that
 * fans out to every chip subscribed, regardless of family. SPI and I2C are
 * not among them: a chip joins a bus from vx_spi_attach / vx_i2c_attach and
 * the fabric (simulation/buses) routes it by its wiring.
 */
export type SimulatorKind = 'avr' | 'rp2040' | 'esp32' | 'unknown';

/**
 * Which family a simulator belongs to, from the shape of its surface. These
 * are FINGERPRINTS of the family, never a place to hang a chip: a chip's SPI
 * and I2C bytes come from the bus fabric, and its UART from the bridge below.
 *
 * They used to read `spi` and `setSPIHandler` (the F2 transition bridge,
 * gone with F3) and then `addI2CDevice` (the I2C one, gone with F5). The RP
 * family answers to `serialWriteByte`, the very call the UART bridge makes
 * on it, plus `getBusBinding`, the fabric's way in (the AVR has no
 * serialWriteByte, the ESP32 shim has none either), so a simulator that
 * passes the test is one the bridges can actually drive.
 */
export function detectSimulatorKind(simulator: any): SimulatorKind {
  if (!simulator) return 'unknown';
  if (simulator.usart && simulator.i2cBus) return 'avr';
  if (
    typeof simulator.serialWriteByte === 'function' &&
    typeof simulator.getBusBinding === 'function'
  ) {
    return 'rp2040';
  }
  if (typeof simulator.sendPinEvent === 'function') return 'esp32';
  return 'unknown';
}

/**
 * Whether an ESP32-kind simulator hosts custom chips in a backend worker
 * (the QEMU path: the WASM is shipped with `registerSensor` and runs next
 * to the guest) or leaves them to the browser runtime. The shim answers
 * for whichever bridge the build installed; a bridge with no opinion is the
 * OSS QEMU one, and QEMU hosts them. An in-browser engine has no worker,
 * so it must say no, or the chip is filed as a sensor nothing runs.
 */
export function hostsChipsInWorker(simulator: any): boolean {
  if (!simulator) return false;
  if (typeof simulator.hostsCustomChips !== 'function') return true;
  try {
    return simulator.hostsCustomChips() !== false;
  } catch {
    return true;
  }
}

export interface SimulatorBridges {
  /** Set of UART RX listeners (one per UART chip). */
  uartListeners: Set<(byte: number) => void>;
  /** Whether the UART dispatcher has already been wired to the simulator. */
  uartInstalled: boolean;
  /** Original onByteTransmit so non-chip listeners still receive bytes. */
  uartPreviousOnByteTransmit: ((byte: number) => void) | null;
  /** Pending bytes to inject into the AVR/RP2040 RX register, drained at
   *  ~baud rate by `uartDrainHandle`. Without this queue, chips that emit
   *  bursts (e.g. an i8080 printing a banner) overflow the 2-byte USART
   *  RX register and most bytes get silently dropped. */
  uartRxQueue: number[];
  /** setTimeout handle for the queue drainer (0 if not active). */
  uartDrainHandle: number;
}

const SIM_BRIDGES = new WeakMap<object, SimulatorBridges>();

/** Hard cap on the AVR RX FIFO (see avrUartTx) — at the 1 byte/ms drain
 *  rate this is ~4 s of backlog, plenty for bursts, bounded for firehoses. */
const MAX_UART_RX_QUEUE = 4096;

export function getSimulatorBridges(simulator: any): SimulatorBridges {
  let b = SIM_BRIDGES.get(simulator);
  if (!b) {
    b = {
      uartListeners: new Set(),
      uartInstalled: false,
      uartPreviousOnByteTransmit: null,
      uartRxQueue: [],
      uartDrainHandle: 0,
    };
    SIM_BRIDGES.set(simulator, b);
  }
  return b;
}

// ── UART ────────────────────────────────────────────────────────────────────

/**
 * Install the UART TX-out dispatcher idempotently. Whatever family the
 * simulator belongs to, the dispatcher fans bytes out to every listener in
 * `uartListeners` (one per UART chip).
 */
/**
 * The UART a chip talks on when the board has more than one. UART0 is the
 * serial monitor on every ESP32 family, so a chip on UART0 would babble
 * into the console and read the sketch's own prints back.
 */
export const CHIP_UART = 1;

export function ensureUartBridge(simulator: any): void {
  const b = getSimulatorBridges(simulator);
  if (b.uartInstalled) return;
  const kind = detectSimulatorKind(simulator);

  if (kind === 'avr' && simulator.usart) {
    b.uartPreviousOnByteTransmit = simulator.usart.onByteTransmit ?? null;
    const previous = b.uartPreviousOnByteTransmit;
    simulator.usart.onByteTransmit = (byte: number) => {
      if (previous) { try { previous(byte); } catch { /* swallow */ } }
      for (const listener of b.uartListeners) {
        try { listener(byte); } catch { /* swallow */ }
      }
    };
    b.uartInstalled = true;
    return;
  }

  if (kind === 'rp2040') {
    // RP2040 emits each TX byte through `onSerialData(char)` (a string).
    const previous = simulator.onSerialData;
    simulator.onSerialData = (charStr: string) => {
      if (previous) { try { previous(charStr); } catch { /* swallow */ } }
      const code = typeof charStr === 'string' ? charStr.charCodeAt(0) : Number(charStr);
      if (!Number.isFinite(code)) return;
      for (const listener of b.uartListeners) {
        try { listener(code & 0xff); } catch { /* swallow */ }
      }
    };
    b.uartInstalled = true;
    return;
  }
  // esp32: nothing to install. The shim's `onSerialData` is a property the
  // store never calls for an ESP32 board (the bridge's own handler feeds the
  // monitor), so a dispatcher hung on it would never fire; a version of it
  // lived here and silently did nothing. A chip hosted in the browser next
  // to an overlay engine gets its UART from that overlay's attach extension
  // (the engines publish every TX byte on the overlay's uart bus), and a
  // chip on the OSS QEMU bridge is hosted in the worker, not here.
  // unknown: no client-side UART bridge (QEMU has its own path).
}

/**
 * Inject a byte into the simulator's RX path so the sketch's `Serial.read()`
 * returns it.
 *
 * For AVR we go through a JS-level FIFO + setTimeout drainer instead of
 * calling `simulator.usart.writeByte` directly. Two reasons:
 *
 *  1. The non-immediate form silently returns `false` for bytes that arrive
 *     while `rxBusyValue` is still set from the previous one — so chips
 *     that emit bursts (e.g. an i8080 print_string sequence) lose ~99% of
 *     their bytes.
 *  2. The immediate form overwrites `rxByte` directly without waiting for
 *     the AVR sketch to drain it — same outcome, only the last byte of
 *     each burst survives.
 *
 * The drainer attempts one non-immediate write per tick (1 ms apart). On
 * RXC busy / RXEN off it leaves the byte at the head of the queue and
 * retries on the next tick. RP2040 has its own internal buffering, so we
 * just forward to `serialWriteByte`.
 */
export function avrUartTx(simulator: any, byte: number): void {
  const kind = detectSimulatorKind(simulator);
  if (kind === 'avr') {
    // ATtiny85 has no hardware USART — silently drop instead of queueing
    // forever. Users wiring a UART chip to a tiny85 need SoftwareSerial,
    // which is a different bridge entirely (TODO).
    if (!simulator.usart || typeof simulator.usart.writeByte !== 'function') return;
    const b = getSimulatorBridges(simulator);
    // Bound the FIFO: a chip streaming while the sketch never reads (RX busy
    // forever) grew this array without limit — the browser tab died of
    // memory, not of CPU. Beyond the cap, drop new bytes and keep the oldest
    // so a sketch that starts reading late still sees the stream's head.
    if (b.uartRxQueue.length >= MAX_UART_RX_QUEUE) return;
    b.uartRxQueue.push(byte & 0xff);
    if (!b.uartDrainHandle) {
      const drain = () => {
        const b2 = getSimulatorBridges(simulator);
        if (b2.uartRxQueue.length === 0) {
          b2.uartDrainHandle = 0;
          return;
        }
        const next = b2.uartRxQueue[0];
        let accepted = false;
        try {
          accepted = simulator.usart?.writeByte?.(next) ?? false;
        } catch {
          accepted = false;
        }
        if (accepted) b2.uartRxQueue.shift();
        b2.uartDrainHandle = (setTimeout(drain, 1) as unknown) as number;
      };
      b.uartDrainHandle = (setTimeout(drain, 0) as unknown) as number;
    }
    return;
  }
  if (kind === 'rp2040' && typeof simulator.serialWriteByte === 'function') {
    try { simulator.serialWriteByte(byte); } catch { /* swallow */ }
    return;
  }
  if (kind === 'esp32' && typeof simulator.sendSerialByte === 'function') {
    // Straight into the guest's UART1 FIFO — the ESP32 worker/engine does
    // its own buffering, so there is nothing to drain here.
    try { simulator.sendSerialByte(byte & 0xff, CHIP_UART); } catch { /* swallow */ }
  }
}

// ── SPI ─────────────────────────────────────────────────────────────────────
//
// There is no SPI bridge any more. A chip joins a board's SPI bus from
// vx_spi_attach, with the pins of its own config (ChipRuntime._joinSpiBus),
// and the fabric in simulation/buses decides which bus that is and when the
// chip is selected. What stood here installed one dispatcher per SIMULATOR,
// whatever the chip was wired to and whatever bus it spoke: on AVR and the
// ESP32 shim it joined the part chain, and on RP2040, RP2350 and the XIAO it
// replaced the SPI handler on both buses. A UART-only Grove module took the
// board's SPI with it (issue #355 and findings
// grove-chip-takes-spi-on-rp-and-xiao-arm, customchip-setspihandler-steals-bus0,
// rp2-sethandler-clobbers-spi-chain).

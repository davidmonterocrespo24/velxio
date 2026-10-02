/**
 * Per-simulator bridge state for custom chips.
 *
 * Each simulator family exposes its peripherals differently:
 *   - AVR (avr8js): `simulator.usart` / `simulator.i2cBus`
 *   - ESP32 (bridge shim): `simulator.sendPinEvent`. The shim wraps either
 *     the backend QEMU bridge, which hosts custom chips in its worker
 *     (CustomChipPart hands the WASM over and no browser instance exists),
 *     or an overlay's in-browser engine, which answers `hostsCustomChips()`
 *     false so the chip runs here, GPIO through the shim's PinManager.
 *   - RP2040 family (rp2040js, rp2350js, the XIAO ARM engines, the Pi shim):
 *     `simulator.getBusBinding` and nothing of the two above.
 *
 * What is left here is the family fingerprint and the worker question. No
 * bus dispatcher lives here any more: a chip joins a bus from vx_spi_attach,
 * vx_i2c_attach and vx_uart_attach, and the fabric (simulation/buses) routes
 * it by its wiring.
 */
export type SimulatorKind = 'avr' | 'rp2040' | 'esp32' | 'unknown';

/**
 * Which family a simulator belongs to, from the shape of its surface. These
 * are FINGERPRINTS of the family, never a place to hang a chip: a chip's SPI,
 * I2C and UART bytes all come from the bus fabric.
 *
 * The fingerprint is the fabric's way in, `getBusBinding`, which every engine
 * of the product exposes: the shims are told apart first by `sendPinEvent`,
 * the AVR by its peripherals, and everything else that exposes its buses is
 * the RP family (rp2040js, rp2350js, the XIAO ARM engines, the Pi shim),
 * which for a chip host means "runs in the browser, hosts nothing in a
 * worker". It sniffs no bus method on purpose: those come and go with the
 * bus model, the binding is the contract.
 */
export function detectSimulatorKind(simulator: any): SimulatorKind {
  if (!simulator) return 'unknown';
  if (simulator.usart && simulator.i2cBus) return 'avr';
  if (typeof simulator.sendPinEvent === 'function') return 'esp32';
  if (typeof simulator.getBusBinding === 'function') return 'rp2040';
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

/**
 * Whether the board's engine runs its own copy of an I2C part of `type` next
 * to the guest, from the record the part files with registerSensor, while the
 * part keeps its copy on the fabric (an overlay's engine in a worker). No
 * bridge says so by default.
 */
export function hostsI2cModel(simulator: any, type: string): boolean {
  if (!simulator || typeof simulator.hostsI2cModel !== 'function') return false;
  try {
    return simulator.hostsI2cModel(type) === true;
  } catch {
    return false;
  }
}

// ── UART ────────────────────────────────────────────────────────────────────
//
// There is no UART bridge any more either. A chip is on a board's UART wires
// from vx_uart_attach, by the pads of its own config (ChipRuntime puts it on
// the bus fabric of simulation/buses in that very call, on every engine
// kind), and the fabric decides from the nets which controller of which board
// each pad reaches, or follows a plain GPIO on the guest's clock. A chip a
// QEMU worker hosts is placed the same way by its part, from the pads read
// off an inert copy (chipUartPads.ts). What stood here installed ONE dispatcher per
// SIMULATOR on its USART0 (rebuilt by every reset and reload, so the chip
// went deaf: findings avr-uart-dispatcher-lost-after-recompile-or-stop and
// avr-uart-dispatcher-lost-on-reload), made a chip on RP2040-family hosts
// hear every UART through the console callback and answer on UART0 only
// (rp2040-uart-lumped-and-uart0-only-rx), and drained the chip's replies into
// the AVR through a wall-clock timer FIFO shared per simulator that outlived
// Stop (avr-rx-queue-stale-and-throttled).

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

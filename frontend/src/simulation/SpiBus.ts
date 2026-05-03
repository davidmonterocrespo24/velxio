/**
 * Generic SPI bus interface, board-agnostic.
 *
 * Every simulator (AVR, RP2040, ESP32 Xtensa/RISC-V, RiscV bare-metal,
 * Pi-Pico-W, …) exposes a `.spi` member matching this shape so SPI-driven
 * components — ILI9341 displays, custom chips, SD cards, etc. — can hook
 * the bus without knowing which board they're attached to.
 *
 * The contract follows the AVRSimulator's existing shape (the original
 * implementation): the consumer assigns its handler to `onByte`, which
 * receives one MOSI byte per SPI clock cycle. If the consumer is a slave
 * that wants to drive the master's MISO line for that cycle, it calls
 * `completeTransfer(miso)`. For boards where MISO is driven externally
 * (ESP32 — the QEMU worker handles the response via _spi_response),
 * `completeTransfer` is a no-op.
 *
 * Each simulator's `.spi` is a SINGLE-LISTENER channel: assigning to
 * `onByte` overwrites any previous handler. Components that wrap an
 * existing handler must save the old one and chain it in their own
 * implementation (the standard pattern; see ili9341Simulation in
 * ComplexParts.ts).
 */
export interface SpiBusLike {
  /** Settable per-cycle byte handler. Null when no consumer is attached. */
  onByte: ((mosi: number) => void) | null;

  /**
   * Tell the master what to place on MISO for the current cycle.
   * Optional — boards where MISO is owned by the emulator (ESP32) treat
   * this as a no-op. Hardware-faithful boards (AVR, RP2040) must call
   * this before the next byte arrives or the master will read 0.
   */
  completeTransfer?(miso: number): void;
}

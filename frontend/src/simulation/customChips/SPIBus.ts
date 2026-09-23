/**
 * SPIDevice: the armed transfer of ONE custom-chip SPI handle.
 *
 * This file used to hold a bus as well: every chip on a simulator shared one
 * SPIBus, the first chip with a transfer armed answered every byte the board
 * clocked, and the sck/mosi/miso/cs of the chip's own vx_spi_config were never
 * looked at (findings spibus-selection-ignores-pins,
 * spibus-no-cs-armed-chip-swallows). The bus now lives in the fabric
 * (simulation/buses): it works out which bus a chip is on from its wiring and
 * only calls the chip while its chip select is active.
 *
 * What is left here is the part only the chip knows: the buffer vx_spi_start
 * armed, how far into it the exchange has got, and when it is complete. The
 * Wokwi-compatible semantics are unchanged: a byte reaches the chip only
 * between vx_spi_start and the completion or vx_spi_stop, and a chip with
 * nothing armed does not drive MISO and consumes nothing.
 *
 * The buffer is held as a POINTER into the chip's WASM memory and read through
 * a view taken at access time. A chip that grows its memory while a transfer is
 * armed detaches every view made before the growth, and MOSI bytes used to be
 * written into that detached view while MISO read back undefined (finding
 * spi-view-detached-on-memory-grow).
 */

/** A live view of the whole WASM memory of the chip that owns this handle. */
export type ChipMemoryView = () => Uint8Array;

/** Called when the exchange finishes (or is stopped): the chip's own buffer
 *  pointer and how many bytes were exchanged. */
export type SpiTransferDone = (bufPtr: number, count: number) => void;

export class SPIDevice {
  private readonly view: ChipMemoryView;
  private readonly onDone: SpiTransferDone;
  private ptr = 0;
  private count = 0;
  private position = 0;
  private active = false;

  constructor(view: ChipMemoryView, onDone: SpiTransferDone) {
    this.view = view;
    this.onDone = onDone;
  }

  /** vx_spi_start: arm `count` bytes at `bufPtr` of the chip's memory. */
  startTransfer(bufPtr: number, count: number): void {
    this.ptr = bufPtr;
    this.count = count;
    this.position = 0;
    // An empty exchange arms nothing: there is no byte to shift and no
    // completion to report.
    this.active = count > 0;
  }

  /** vx_spi_stop: end the exchange where it stands, as CS rising does. */
  stopTransfer(): void {
    if (!this.active) return;
    const ptr = this.ptr;
    const done = this.position;
    this.active = false;
    this.position = 0;
    this.onDone(ptr, done);
  }

  hasPendingTransfer(): boolean {
    return this.active;
  }

  /** The byte this handle will shift out NEXT, without consuming anything.
   *  Null when nothing is armed: the chip is not driving MISO. */
  peek(): number | null {
    if (!this.active) return null;
    return this.view()[this.ptr + this.position] ?? 0xff;
  }

  /**
   * One frame while the chip is selected. The master's byte lands in the
   * buffer, the byte that was there goes out on MISO, and the completion fires
   * on the last byte of the exchange. Nothing armed: no answer, no consumption.
   */
  transfer(masterByte: number): number | null {
    if (!this.active) return null;
    const mem = this.view();
    const at = this.ptr + this.position;
    const slaveByte = mem[at] ?? 0xff;
    mem[at] = masterByte & 0xff;
    this.position++;
    if (this.position >= this.count) {
      const ptr = this.ptr;
      const count = this.count;
      this.active = false;
      this.position = 0;
      this.onDone(ptr, count);
    }
    return slaveByte;
  }
}

/**
 * Software SPI: a bit-banged master on plain GPIOs (shiftOut / shiftIn, a
 * SoftSPI library, a sketch toggling pins by hand) decoded from the board's
 * pin edges into the same frames a hardware controller delivers (DESIGN 5.3).
 *
 * So one device model works whether the sketch uses SPI.transfer() or wiggles
 * the pins itself, exactly like the chip on a real board. A hardware
 * controller never produces pin edges on the pads it drives (a contract rule
 * every engine adapter is tested for), so the two paths cannot both deliver
 * the same frame.
 *
 * MISO: a real chip shifts its answer out while the master is still clocking
 * the byte in, so the decoder asks the bus what the selected chip will send
 * NEXT (SpiDevice.peekMiso) and puts each bit on the MISO pin ahead of the
 * sampling edge, the way CPHA says it must be there.
 */

import type { SpiBus, SpiMember } from './spiBus';
import type { BoardPins, SpiMode } from './types';

export class SoftSpiDecoder {
  private count = 0;
  private shiftIn = 0;
  private shiftOut = 0xff;
  private sckLevel: boolean;
  private readonly unsub: () => void;
  private readonly pins: BoardPins;
  private readonly bus: SpiBus;

  constructor(pins: BoardPins, bus: SpiBus) {
    this.pins = pins;
    this.bus = bus;
    this.sckLevel = pins.peekPinState(bus.sckPin) ?? false;
    this.unsub = pins.onPinChange(bus.sckPin, (_p, level) => this.onSck(level));
  }

  dispose(): void {
    this.unsub();
  }

  /** The bus calls this when its selection changes: a new transaction starts. */
  restart(): void {
    this.count = 0;
    this.shiftIn = 0;
    this.shiftOut = this.bus.peekMiso() & 0xff;
    const m = this.active();
    // CPHA = 0: the first bit must already be on MISO when the first sampling
    // edge arrives, so it goes out on the select edge itself.
    if (m && (this.mode(m) & 1) === 0) this.driveBit(m);
  }

  private active(): SpiMember | undefined {
    const sel = this.bus.selected();
    return sel.length ? sel[0] : undefined;
  }

  private mode(m: SpiMember): SpiMode {
    return m.desc.modes?.[0] ?? 0;
  }

  private msbFirst(m: SpiMember): boolean {
    return (m.desc.bitOrder ?? 'msb') === 'msb';
  }

  private driveBit(m: SpiMember): void {
    const miso = m.misoPin;
    if (miso === undefined || !this.pins.driveInput) return;
    const idx = this.msbFirst(m) ? 7 - this.count : this.count;
    this.pins.driveInput(miso, ((this.shiftOut >> idx) & 1) === 1);
  }

  private onSck(level: boolean): void {
    if (level === this.sckLevel) return;
    this.sckLevel = level;
    const m = this.active();
    if (!m) return;
    const mode = this.mode(m);
    const cpol = (mode & 2) !== 0;
    const cpha = (mode & 1) !== 0;
    // Leading edge = away from the idle level.
    const leading = level !== cpol;
    const sampleEdge = leading !== cpha;
    if (sampleEdge) {
      const mosiPin = m.mosiPin;
      const bit = mosiPin !== undefined && this.pins.peekPinState(mosiPin) === true ? 1 : 0;
      if (this.msbFirst(m)) this.shiftIn = ((this.shiftIn << 1) | bit) & 0xff;
      else this.shiftIn |= bit << this.count;
      this.count++;
      if (this.count === 8) {
        const byte = this.shiftIn & 0xff;
        this.count = 0;
        this.shiftIn = 0;
        this.bus.frame(byte, 8);
        this.shiftOut = this.bus.peekMiso() & 0xff;
      }
    } else {
      // Shift edge: the chip moves the next bit onto MISO.
      this.driveBit(m);
    }
  }
}

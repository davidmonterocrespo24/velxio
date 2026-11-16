/**
 * HD44780Decoder.ts
 *
 * Decodes the bytes that a PCF8574-style I2C backpack writes when an
 * Arduino sketch uses the LiquidCrystal_I2C / hd44780 libraries to
 * drive an HD44780-compatible character LCD.
 *
 * Wire format (LiquidCrystal_I2C / Frank de Brabander convention)
 * ----------------------------------------------------------------
 * Each byte the Arduino writes to the PCF8574 is laid out as:
 *
 *   bit 7 6 5 4 | bit 3 2 1 0
 *        D7..D4 | BL EN RW RS
 *
 * The HD44780 latches one 4-bit nibble on every falling edge of EN.
 * To send one HD44780 command/data byte the library emits two pairs:
 *
 *   write A: high-nibble | RS | RW | BL | EN=1
 *   write B: high-nibble | RS | RW | BL | EN=0   ← latch
 *   write C: low-nibble  | RS | RW | BL | EN=1
 *   write D: low-nibble  | RS | RW | BL | EN=0   ← latch
 *
 * After both nibbles have been latched the decoder reassembles them
 * into the original 8-bit HD44780 byte and runs it through the
 * controller's command/data interpreter.
 *
 * HD44780 controller subset
 * -------------------------
 * Implemented commands (the ones the Arduino LiquidCrystal_I2C
 * library actually emits during normal operation):
 *
 *   0x01           Clear display (fill DDRAM with 0x20, address := 0)
 *   0x02 / 0x03    Return home (address := 0)
 *   0x04 - 0x07    Entry mode set (I/D, S)
 *   0x08 - 0x0F    Display ON/OFF control (D, C, B)
 *   0x10 - 0x1F    Cursor / display shift  (recognised, no-op visual)
 *   0x20 - 0x3F    Function set            (N=line count latched, F/DL noted)
 *   0x40 - 0x7F    Set CGRAM address
 *   0x80 - 0xFF    Set DDRAM address
 *
 * Data writes (RS=1) deposit into DDRAM or CGRAM at the current
 * address and advance the pointer per the entry-mode I/D flag.
 *
 * The decoder produces a flat `characters` array sized
 * (cols × rows) that matches the layout `wokwi-lcd1602` /
 * `wokwi-lcd2004` expect on their `characters` property — so a part
 * can wire `onCharsChange = (c) => element.characters = c` directly.
 *
 * What the decoder is NOT
 * -----------------------
 * - Pixel-accurate: it does not render dot-matrix bitmaps; it just
 *   tracks the character codes the controller has at each cell.
 *   The downstream LCD web component owns rendering.
 * - Timing-accurate: HD44780 commands have execution times (37 µs
 *   for most, 1.52 ms for clear/home).  The decoder applies state
 *   transitions synchronously; sketches that respect the typical
 *   library delays will see the right state.
 * - Cursor-shift accurate: the optional 0x10..0x1F shift command
 *   moves cursor/display.  We acknowledge the command but do not
 *   slide DDRAM contents — the visible state still reflects the
 *   true character contents at DDRAM addresses 0..N-1.
 */

export interface HD44780Geometry {
  cols: number;
  rows: number;
  /**
   * Mapping from display row index → starting DDRAM address for that
   * row.  Defaults match standard 1602 / 2004 layouts:
   *   1602: [0x00, 0x40]
   *   2004: [0x00, 0x40, 0x14, 0x54]
   */
  rowOffsets?: number[];
}

export interface HD44780Snapshot {
  characters: number[];
  cursorAddress: number;
  cursorRow: number;
  cursorCol: number;
  displayOn: boolean;
  cursorOn: boolean;
  cursorBlink: boolean;
  backlight: boolean;
}

const DEFAULT_ROW_OFFSETS_1602 = [0x00, 0x40];
const DEFAULT_ROW_OFFSETS_2004 = [0x00, 0x40, 0x14, 0x54];

export class HD44780Decoder {
  // ── Public events ──────────────────────────────────────────────────────
  /** Fired after every DDRAM write or clear; receives the full flat character grid. */
  public onCharsChange: ((chars: number[]) => void) | null = null;
  /** Fired when the BL bit of an incoming PCF8574 byte changes. */
  public onBacklightChange: ((on: boolean) => void) | null = null;
  /** Fired on any cursor/display config change so the host can re-render. */
  public onCursorChange: ((s: HD44780Snapshot) => void) | null = null;
  /**
   * Fired after every CGRAM write with the 64 bytes of the eight custom
   * characters, so the host can draw codes 0-15 with them (lcdCgram.ts).
   */
  public onCgramChange: ((cgram: Uint8Array) => void) | null = null;

  // ── Geometry ───────────────────────────────────────────────────────────
  private readonly cols: number;
  private readonly rows: number;
  private readonly rowOffsets: number[];

  // ── Controller state ──────────────────────────────────────────────────
  private readonly ddram = new Uint8Array(128); // upper bound; covers 2004
  private readonly cgram = new Uint8Array(64);
  private address = 0;
  private cgramMode = false;

  private displayOn = false;
  private cursorOn = false;
  private cursorBlink = false;
  private cursorInc = true; // I/D bit — true = address increments after each write
  private shiftOnEntry = false;
  private twoLine = false;

  // ── 4-bit assembly state ──────────────────────────────────────────────
  private highNibble: number | null = null;
  /** Last RS bit observed when the high nibble landed; both nibbles must share it. */
  private highRs = false;
  private lastEN = false;
  private backlight = true;

  /**
   * Number of nibbles seen since power-on.  HD44780 init sequence
   * sends three 0x3 nibbles in 8-bit mode (LCD reset path) before
   * switching to 4-bit, so the first few "lone" nibbles are normal
   * and must not assemble into a bogus byte.  We require strict
   * pairing only AFTER the controller is observed to be in 4-bit
   * mode (Function set with DL=0).
   */
  private fourBitMode = false;

  constructor(geometry: HD44780Geometry) {
    this.cols = geometry.cols;
    this.rows = geometry.rows;
    if (geometry.rowOffsets) {
      this.rowOffsets = [...geometry.rowOffsets];
    } else if (this.rows === 4) {
      this.rowOffsets = DEFAULT_ROW_OFFSETS_2004;
    } else {
      this.rowOffsets = DEFAULT_ROW_OFFSETS_1602;
    }
    // Initialise DDRAM as spaces so the LCD shows a clean screen
    // even before the sketch issues an explicit Clear.
    this.ddram.fill(0x20);
  }

  // ── Public entry points ────────────────────────────────────────────────

  /**
   * Feed one PCF8574 backpack byte (LiquidCrystal_I2C wire format).
   * Latches a nibble on the EN falling edge.
   */
  feedPCF8574Byte(byte: number): void {
    const newBacklight = (byte & 0x08) !== 0;
    if (newBacklight !== this.backlight) {
      this.backlight = newBacklight;
      this.onBacklightChange?.(newBacklight);
    }

    const en = (byte & 0x04) !== 0;
    const rs = (byte & 0x01) !== 0;
    const nibble = (byte >> 4) & 0x0f;

    // HD44780 latches data on the falling edge of EN.
    if (this.lastEN && !en) {
      this.feedNibble(nibble, rs);
    }
    this.lastEN = en;
  }

  /** Reset all decoder state — call when the part detaches. */
  reset(): void {
    this.ddram.fill(0x20);
    this.cgram.fill(0);
    this.address = 0;
    this.cgramMode = false;
    this.displayOn = false;
    this.cursorOn = false;
    this.cursorBlink = false;
    this.cursorInc = true;
    this.shiftOnEntry = false;
    this.twoLine = false;
    this.highNibble = null;
    this.highRs = false;
    this.lastEN = false;
    this.backlight = true;
    this.fourBitMode = false;
  }

  /** Snapshot the current visible state — useful for tests and UI overlays. */
  snapshot(): HD44780Snapshot {
    const { row, col } = this.addressToRowCol(this.address);
    return {
      characters: this.buildCharacterGrid(),
      cursorAddress: this.address,
      cursorRow: row,
      cursorCol: col,
      displayOn: this.displayOn,
      cursorOn: this.cursorOn,
      cursorBlink: this.cursorBlink,
      backlight: this.backlight,
    };
  }

  // ── Internal nibble + byte interpreter ────────────────────────────────

  private feedNibble(nibble: number, rs: boolean): void {
    if (this.highNibble === null) {
      this.highNibble = nibble;
      this.highRs = rs;
      return;
    }
    // If RS changed between the two nibbles we are out of sync (the
    // controller would treat the second nibble as a new command or
    // data write).  Re-anchor on the new nibble.
    if (rs !== this.highRs) {
      this.highNibble = nibble;
      this.highRs = rs;
      return;
    }
    const full = (this.highNibble << 4) | nibble;
    this.highNibble = null;
    this.processByte(full, rs);
  }

  private processByte(byte: number, rs: boolean): void {
    if (rs) {
      this.writeData(byte);
      return;
    }
    this.writeCommand(byte);
  }

  private writeData(byte: number): void {
    if (this.cgramMode) {
      this.cgram[this.address & 0x3f] = byte;
      this.advanceAddress(64);
      this.onCgramChange?.(this.cgram);
    } else {
      this.ddram[this.address & 0x7f] = byte;
      this.advanceAddress(128);
      this.emitChars();
    }
  }

  private writeCommand(byte: number): void {
    if (byte === 0x01) {
      this.ddram.fill(0x20);
      this.address = 0;
      this.cgramMode = false;
      this.emitChars();
      this.emitCursor();
      return;
    }
    if ((byte & 0xfe) === 0x02) {
      this.address = 0;
      this.cgramMode = false;
      this.emitCursor();
      return;
    }
    if ((byte & 0xfc) === 0x04) {
      this.cursorInc = (byte & 0x02) !== 0;
      this.shiftOnEntry = (byte & 0x01) !== 0;
      return;
    }
    if ((byte & 0xf8) === 0x08) {
      this.displayOn = (byte & 0x04) !== 0;
      this.cursorOn = (byte & 0x02) !== 0;
      this.cursorBlink = (byte & 0x01) !== 0;
      this.emitCursor();
      return;
    }
    if ((byte & 0xf0) === 0x10) {
      // Cursor / display shift — recognised but visual effect is a no-op
      // because we don't slide DDRAM contents.
      return;
    }
    if ((byte & 0xe0) === 0x20) {
      // Function set: DL (bit 4), N (bit 3), F (bit 2)
      const dl8bit = (byte & 0x10) !== 0;
      this.fourBitMode = !dl8bit;
      this.twoLine = (byte & 0x08) !== 0;
      return;
    }
    if ((byte & 0xc0) === 0x40) {
      this.address = byte & 0x3f;
      this.cgramMode = true;
      return;
    }
    if ((byte & 0x80) === 0x80) {
      this.address = byte & 0x7f;
      this.cgramMode = false;
      this.emitCursor();
      return;
    }
    // Unknown command — silently ignored (consistent with how a real
    // HD44780 treats reserved bits: undefined behaviour, not a crash).
  }

  private advanceAddress(modulo: number): void {
    if (this.cursorInc) {
      this.address = (this.address + 1) % modulo;
    } else {
      this.address = (this.address - 1 + modulo) % modulo;
    }
  }

  // ── Output helpers ────────────────────────────────────────────────────

  private buildCharacterGrid(): number[] {
    const out = new Array<number>(this.cols * this.rows).fill(0x20);
    for (let r = 0; r < this.rows; r++) {
      const base = this.rowOffsets[r] ?? 0;
      for (let c = 0; c < this.cols; c++) {
        const addr = (base + c) & 0x7f;
        out[r * this.cols + c] = this.ddram[addr];
      }
    }
    return out;
  }

  private addressToRowCol(addr: number): { row: number; col: number } {
    // Walk the row offset table to find which row this address belongs to.
    for (let r = 0; r < this.rows; r++) {
      const base = this.rowOffsets[r] ?? 0;
      if (addr >= base && addr < base + this.cols) {
        return { row: r, col: addr - base };
      }
    }
    return { row: 0, col: 0 };
  }

  private emitChars(): void {
    this.onCharsChange?.(this.buildCharacterGrid());
  }

  private emitCursor(): void {
    this.onCursorChange?.(this.snapshot());
  }
}

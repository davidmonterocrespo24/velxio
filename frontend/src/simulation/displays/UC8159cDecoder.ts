/**
 * UC8159cDecoder — UltraChip UC8159c, the 7-colour ACeP controller used by
 * the 5.65" 600×448 panel (e.g. GoodDisplay GDEP0565D90, Waveshare 5.65"
 * ACeP) and a few smaller 4.01"/7.3" siblings.
 *
 * The wire-level protocol follows the SPL/SPL panel-settings family
 * (different from SSD168x): big register-with-data commands during init,
 * then a single 0x10 DTM1 stream that packs **2 pixels / byte** — upper
 * and lower nibble each is a 3-bit palette index (range 0..6).
 *
 * The 7-colour palette (per E Ink ACeP):
 *   0 = black, 1 = white, 2 = green, 3 = blue,
 *   4 = red,   5 = yellow, 6 = orange  (index 7 = "clean" ≈ white)
 *
 * Refresh sequence (from GxEPD2_565c_GDEP0565D90.cpp):
 *   0x04  POWER_ON         → BUSY high until ready
 *   0x10  DTM1 + W*H/2 bytes packed pixels
 *   0x12  DRF + 0x00       → full refresh (~12 s real, fast in emu)
 *   0x02  POWER_OFF
 *   0x07  DEEP_SLEEP + 0xA5
 *
 * The on_flush callback is fired on **0x12 DISPLAY_REFRESH** rather than
 * SSD168x's 0x20 MASTER_ACTIVATION — same role, different opcode.
 */

// ── Command opcodes ──────────────────────────────────────────────────────────

export const UC_CMD_PANEL_SETTING       = 0x00;
export const UC_CMD_POWER_SETTING       = 0x01;
export const UC_CMD_POWER_OFF           = 0x02;
export const UC_CMD_POWER_OFF_SEQ       = 0x03;
export const UC_CMD_POWER_ON            = 0x04;
export const UC_CMD_BOOSTER_SOFT_START  = 0x06;
export const UC_CMD_DEEP_SLEEP          = 0x07;
export const UC_CMD_DTM1                = 0x10;  // Data Transmission 1 (image data)
export const UC_CMD_DISPLAY_REFRESH     = 0x12;
export const UC_CMD_PLL_CONTROL         = 0x30;
export const UC_CMD_TSE                 = 0x41;
export const UC_CMD_VCOM_DATA_INTERVAL  = 0x50;
export const UC_CMD_TCON_SETTING        = 0x60;
export const UC_CMD_RESOLUTION_SETTING  = 0x61;
export const UC_CMD_PWS                 = 0xe3;

// ── ACeP 7-colour palette ────────────────────────────────────────────────────

export type ACePIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * Map ACeP palette index → RGB triple. Indices 7 = "clean" (we render as
 * white). Real panels render index 7 close to white anyway.
 */
export const ACEP_PALETTE_RGB: Record<number, [number, number, number]> = {
  0: [0x20, 0x20, 0x20], // black
  1: [0xf0, 0xf0, 0xf0], // white
  2: [0x20, 0xa0, 0x40], // green
  3: [0x30, 0x60, 0xc0], // blue
  4: [0xc0, 0x10, 0x10], // red
  5: [0xe0, 0xc8, 0x30], // yellow
  6: [0xe0, 0x80, 0x20], // orange
  7: [0xf0, 0xf0, 0xf0], // clean → white
};

export interface UC8159cFrame {
  width: number;
  height: number;
  /** width*height palette indices (0..6 typically; 7 maps to white). */
  pixels: Uint8Array;
}

export interface UC8159cDecoderOptions {
  width: number;
  height: number;
  onFlush?: (frame: UC8159cFrame) => void;
}

/**
 * Stateful UC8159c decoder. **Single 4-bit-per-pixel-pair plane** rather
 * than SSD168x's two 1-bit planes. Packing is upper-nibble = first pixel.
 */
export class UC8159cDecoder {
  readonly width: number;
  readonly height: number;
  /** width*height palette indices, default = 1 (white). */
  ram: Uint8Array;
  private writeIdx = 0;
  private currentCmd = -1;
  private params: number[] = [];
  /** Diagnostics */
  refreshedCount = 0;
  unknownCmds: number[] = [];
  inDeepSleep = false;
  poweredOn = false;

  private readonly onFlush?: (frame: UC8159cFrame) => void;

  constructor(opts: UC8159cDecoderOptions) {
    this.width = opts.width;
    this.height = opts.height;
    this.ram = new Uint8Array(opts.width * opts.height).fill(1); // white
    this.onFlush = opts.onFlush;
  }

  // ── Public API ─────────────────────────────────────────────────────

  feed(byte: number, dcHigh: boolean): void {
    if (!dcHigh) this.beginCommand(byte & 0xff);
    else this.handleData(byte & 0xff);
  }

  reset(): void {
    this.ram.fill(1);
    this.currentCmd = -1;
    this.params = [];
    this.writeIdx = 0;
    this.refreshedCount = 0;
    this.poweredOn = false;
    this.inDeepSleep = false;
  }

  composeFrame(): UC8159cFrame {
    return {
      width: this.width,
      height: this.height,
      pixels: this.ram.slice(),
    };
  }

  // ── Internal: command / data dispatch ──────────────────────────────

  private beginCommand(cmd: number): void {
    this.currentCmd = cmd;
    this.params = [];

    switch (cmd) {
      case UC_CMD_POWER_ON:
        this.poweredOn = true;
        return;
      case UC_CMD_POWER_OFF:
        this.poweredOn = false;
        return;
      case UC_CMD_DTM1:
        // Reset write cursor — every DTM1 begins a fresh frame stream.
        this.writeIdx = 0;
        return;
      case UC_CMD_DISPLAY_REFRESH: {
        // Latched RAM → on_flush. The DRF takes one data byte (0x00) but we
        // fire on the command edge; data is harmlessly buffered.
        this.refreshedCount += 1;
        const frame = this.composeFrame();
        this.onFlush?.(frame);
        return;
      }
      case UC_CMD_DEEP_SLEEP:
        // 0x07 + 0xA5 → enter deep sleep
        return;
      case UC_CMD_PANEL_SETTING:
      case UC_CMD_POWER_SETTING:
      case UC_CMD_POWER_OFF_SEQ:
      case UC_CMD_BOOSTER_SOFT_START:
      case UC_CMD_PLL_CONTROL:
      case UC_CMD_TSE:
      case UC_CMD_VCOM_DATA_INTERVAL:
      case UC_CMD_TCON_SETTING:
      case UC_CMD_RESOLUTION_SETTING:
      case UC_CMD_PWS:
        return;
      default:
        this.unknownCmds.push(cmd);
    }
  }

  private handleData(byte: number): void {
    const cmd = this.currentCmd;
    this.params.push(byte);

    if (cmd === UC_CMD_DEEP_SLEEP) {
      if (byte === 0xa5) this.inDeepSleep = true;
      return;
    }

    if (cmd === UC_CMD_DTM1) {
      // Each data byte holds two pixels: upper nibble = first, lower = second.
      // Each nibble's lower 3 bits is the palette index (0..7). Real panels
      // also use bit 3 as a "color layer" / "black layer" flag, but on the
      // pixel side the resulting nibble is already a palette index (0..6 +
      // optional 7 = clean).
      const total = this.width * this.height;
      if (this.writeIdx < total) {
        this.ram[this.writeIdx++] = (byte >> 4) & 0x07;
      }
      if (this.writeIdx < total) {
        this.ram[this.writeIdx++] = byte & 0x07;
      }
      return;
    }
    // All other commands silently buffer their parameters.
  }
}

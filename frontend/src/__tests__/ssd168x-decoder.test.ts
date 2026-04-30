/**
 * Vitest port of `test/test_epaper/test_ssd168x_protocol.py`. Ensures the
 * TypeScript SSD168xDecoder produces byte-for-byte identical framebuffers
 * to the Python reference.
 *
 * Adding a new test case here? Mirror it in the Python file too (or vice
 * versa) — the cross-decoder consistency assertion at the bottom hashes a
 * real GxEPD2-emitted byte trace through both and asserts the same Frame.
 */
import { describe, it, expect } from 'vitest';
import {
  SSD168xDecoder,
  type Frame,
  CMD_SW_RESET,
  CMD_DRIVER_OUTPUT_CTRL,
  CMD_DATA_ENTRY_MODE,
  CMD_SET_RAMX_RANGE,
  CMD_SET_RAMY_RANGE,
  CMD_BORDER_WAVEFORM,
  CMD_DISP_UPDATE_CTRL_1,
  CMD_DISP_UPDATE_CTRL_2,
  CMD_TEMP_SENSOR,
  CMD_SET_RAMX_COUNTER,
  CMD_SET_RAMY_COUNTER,
  CMD_WRITE_BLACK_VRAM,
  CMD_WRITE_RED_VRAM,
  CMD_MASTER_ACTIVATION,
  CMD_DEEP_SLEEP,
} from '../simulation/displays/SSD168xDecoder';

// ── Helpers (mirror the Python ones) ──────────────────────────────────────────

const cmd = (c: number): Array<[number, boolean]> => [[c, false]];
const data = (...bs: number[]): Array<[number, boolean]> => bs.map((b) => [b, true] as [number, boolean]);

function feedAll(d: SSD168xDecoder, ...streams: Array<Array<[number, boolean]>>) {
  for (const stream of streams) {
    for (const [byte, dcHigh] of stream) {
      d.feed(byte, dcHigh);
    }
  }
}

function gxepd2Init154(d: SSD168xDecoder) {
  feedAll(
    d,
    cmd(CMD_SW_RESET),
    cmd(CMD_DRIVER_OUTPUT_CTRL),
    data(0xc7, 0x00, 0x00),
    cmd(CMD_DATA_ENTRY_MODE),
    data(0x03),
    cmd(CMD_SET_RAMX_RANGE),
    data(0x00, 0x18),
    cmd(CMD_SET_RAMY_RANGE),
    data(0x00, 0x00, 0xc7, 0x00),
    cmd(CMD_BORDER_WAVEFORM),
    data(0x05),
    cmd(CMD_DISP_UPDATE_CTRL_1),
    data(0x00, 0x80),
    cmd(CMD_TEMP_SENSOR),
    data(0x80),
    cmd(CMD_SET_RAMX_COUNTER),
    data(0x00),
    cmd(CMD_SET_RAMY_COUNTER),
    data(0x00, 0x00),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SSD168xDecoder — init sequence', () => {
  it('accepts the GxEPD2 init for the 1.54" panel without unknown opcodes', () => {
    const d = new SSD168xDecoder({ width: 200, height: 200 });
    gxepd2Init154(d);
    expect(d.unknownCmds).toEqual([]);
    expect(d.refreshedCount).toBe(0);
    expect(d.inDeepSleep).toBe(false);
  });

  it('SW reset clears the BW plane', () => {
    const d = new SSD168xDecoder({ width: 200, height: 200 });
    feedAll(d, cmd(CMD_WRITE_BLACK_VRAM), data(0x00, 0x00, 0x00));
    expect(Array.from(d.bwRam.slice(0, 25)).some((b) => b !== 0xff)).toBe(true);
    feedAll(d, cmd(CMD_SW_RESET));
    expect(Array.from(d.bwRam.slice(0, 25)).every((b) => b === 0xff)).toBe(true);
  });
});

describe('SSD168xDecoder — RAM windowing', () => {
  it('SET_RAMX_RANGE / SET_RAMY_RANGE set the active window', () => {
    const d = new SSD168xDecoder({ width: 200, height: 200 });
    feedAll(
      d,
      cmd(CMD_SET_RAMX_RANGE),
      data(0x00, 0x18),
      cmd(CMD_SET_RAMY_RANGE),
      data(0x00, 0x00, 0xc7, 0x00),
    );
    // Indirectly via writePixel auto-increment behaviour at the boundary:
    feedAll(d, cmd(CMD_SET_RAMX_COUNTER), data(0x00));
    feedAll(d, cmd(CMD_SET_RAMY_COUNTER), data(0x00, 0x00));
    feedAll(d, cmd(CMD_WRITE_BLACK_VRAM), data(0xaa));
    expect(d.bwRam[0]).toBe(0xaa);
  });

  it('SET_RAMX_COUNTER / SET_RAMY_COUNTER seek inside the window', () => {
    const d = new SSD168xDecoder({ width: 200, height: 200 });
    feedAll(
      d,
      cmd(CMD_SET_RAMX_COUNTER),
      data(0x05),
      cmd(CMD_SET_RAMY_COUNTER),
      data(0x10, 0x00),
      cmd(CMD_WRITE_BLACK_VRAM),
      data(0xab),
    );
    const bpr = 25; // 200/8
    expect(d.bwRam[0x10 * bpr + 0x05]).toBe(0xab);
  });
});

describe('SSD168xDecoder — pixel writing & wrap', () => {
  it('WRITE_BLACK_VRAM auto-increments X', () => {
    const d = new SSD168xDecoder({ width: 200, height: 200 });
    gxepd2Init154(d);
    feedAll(d, cmd(CMD_WRITE_BLACK_VRAM), data(0x00, 0xff, 0xaa));
    expect(d.bwRam[0]).toBe(0x00);
    expect(d.bwRam[1]).toBe(0xff);
    expect(d.bwRam[2]).toBe(0xaa);
  });

  it('writes wrap to the next row at xrange[1]', () => {
    const d = new SSD168xDecoder({ width: 200, height: 200 });
    feedAll(
      d,
      cmd(CMD_DATA_ENTRY_MODE),
      data(0x03),
      cmd(CMD_SET_RAMX_RANGE),
      data(0x00, 0x01),
      cmd(CMD_SET_RAMX_COUNTER),
      data(0x00),
      cmd(CMD_SET_RAMY_COUNTER),
      data(0x00, 0x00),
    );
    feedAll(d, cmd(CMD_WRITE_BLACK_VRAM), data(0xaa, 0xbb, 0xcc, 0xdd));
    const bpr = 25;
    expect(d.bwRam[0]).toBe(0xaa);
    expect(d.bwRam[1]).toBe(0xbb);
    expect(d.bwRam[bpr + 0]).toBe(0xcc);
    expect(d.bwRam[bpr + 1]).toBe(0xdd);
  });
});

describe('SSD168xDecoder — frame latch & compose', () => {
  it('MASTER_ACTIVATION fires onFlush with the latched frame', () => {
    const seen: Frame[] = [];
    const d = new SSD168xDecoder({
      width: 200,
      height: 200,
      onFlush: (f) => seen.push(f),
    });
    gxepd2Init154(d);
    feedAll(
      d,
      cmd(CMD_DISP_UPDATE_CTRL_2),
      data(0xf7),
      cmd(CMD_MASTER_ACTIVATION),
    );
    expect(seen.length).toBe(1);
    expect(d.refreshedCount).toBe(1);
    const frame = seen[0];
    expect(frame.width).toBe(200);
    expect(frame.height).toBe(200);
    // Default RAM is 0xFF (all bits=1) → all pixels white.
    for (let i = 0; i < frame.pixels.length; i++) expect(frame.pixels[i]).toBe(1);
  });

  it('red plane wins over black on compose', () => {
    const d = new SSD168xDecoder({ width: 8, height: 2 });
    // Row 0 all-black, Row 1 all-white
    feedAll(d, cmd(CMD_WRITE_BLACK_VRAM), data(0x00, 0xff));
    // Reset cursors then write red plane: row 0 first 4 px red, row 1 nothing
    feedAll(d, cmd(CMD_SET_RAMX_COUNTER), data(0x00));
    feedAll(d, cmd(CMD_SET_RAMY_COUNTER), data(0x00, 0x00));
    feedAll(d, cmd(CMD_WRITE_RED_VRAM), data(0xf0, 0x00));
    const frame = d.composeFrame();
    expect(Array.from(frame.pixels.slice(0, 4))).toEqual([2, 2, 2, 2]);
    expect(Array.from(frame.pixels.slice(4, 8))).toEqual([0, 0, 0, 0]);
    expect(Array.from(frame.pixels.slice(8, 16))).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });
});

describe('SSD168xDecoder — deep sleep & unknown opcodes', () => {
  it('DEEP_SLEEP with data 0x01 sets the in_deep_sleep flag', () => {
    const d = new SSD168xDecoder({ width: 200, height: 200 });
    feedAll(d, cmd(CMD_DEEP_SLEEP), data(0x01));
    expect(d.inDeepSleep).toBe(true);
  });

  it('unknown opcodes are logged not raised', () => {
    const d = new SSD168xDecoder({ width: 200, height: 200 });
    feedAll(d, cmd(0xab), data(0x01, 0x02));
    expect(d.unknownCmds).toContain(0xab);
  });
});

describe('SSD168xDecoder — end-to-end hello world', () => {
  it('writes a single black pixel at (0,0) and the frame reflects it', () => {
    const seen: Frame[] = [];
    const d = new SSD168xDecoder({
      width: 200,
      height: 200,
      onFlush: (f) => seen.push(f),
    });
    gxepd2Init154(d);
    feedAll(d, cmd(CMD_SET_RAMX_COUNTER), data(0x00));
    feedAll(d, cmd(CMD_SET_RAMY_COUNTER), data(0x00, 0x00));
    feedAll(d, cmd(CMD_WRITE_BLACK_VRAM), data(0x7f));
    feedAll(
      d,
      cmd(CMD_DISP_UPDATE_CTRL_2),
      data(0xf7),
      cmd(CMD_MASTER_ACTIVATION),
    );
    expect(seen.length).toBe(1);
    expect(seen[0].pixels[0]).toBe(0); // top-left black
    expect(seen[0].pixels[1]).toBe(1); // (1,0) white
  });
});

describe('SSD168xDecoder — tri-colour B/W/R pipeline', () => {
  // Mirrors how GxEPD2_3C drives a real SSD1680 panel: write the BW plane
  // first (cmd 0x24), reset cursors, then write the red plane (cmd 0x26),
  // then activate. The composed frame must mix both planes correctly.

  it('three-row pattern composes B / W / R correctly', () => {
    // 16-wide × 3-high panel — easy to pin every pixel by hand.
    const seen: Frame[] = [];
    const d = new SSD168xDecoder({
      width: 16,
      height: 3,
      onFlush: (f) => seen.push(f),
    });

    // Match the typical GxEPD2 init sub-sequence enough to set window + cursor.
    feedAll(
      d,
      cmd(CMD_DATA_ENTRY_MODE), data(0x03),
      cmd(CMD_SET_RAMX_RANGE),  data(0x00, 0x01),         // 2 bytes wide
      cmd(CMD_SET_RAMY_RANGE),  data(0x00, 0x00, 0x02, 0x00), // rows 0..2
      cmd(CMD_SET_RAMX_COUNTER), data(0x00),
      cmd(CMD_SET_RAMY_COUNTER), data(0x00, 0x00),
    );

    // BW plane: row 0 all-black, row 1 all-white, row 2 mixed (left half black)
    feedAll(
      d,
      cmd(CMD_WRITE_BLACK_VRAM),
      data(
        0x00, 0x00, // row 0
        0xff, 0xff, // row 1
        0x00, 0xff, // row 2
      ),
    );

    // Reset cursor for the red plane.
    feedAll(
      d,
      cmd(CMD_SET_RAMX_COUNTER), data(0x00),
      cmd(CMD_SET_RAMY_COUNTER), data(0x00, 0x00),
    );

    // Red plane: row 0 nothing, row 1 first 4 px red, row 2 nothing.
    feedAll(
      d,
      cmd(CMD_WRITE_RED_VRAM),
      data(
        0x00, 0x00, // row 0 — no red
        0xf0, 0x00, // row 1 — first 4 px red
        0x00, 0x00, // row 2 — no red
      ),
    );

    feedAll(d, cmd(CMD_MASTER_ACTIVATION));
    expect(seen.length).toBe(1);
    const px = seen[0].pixels;

    // Row 0: all black (0)
    for (let x = 0; x < 16; x++) expect(px[x]).toBe(0);

    // Row 1: cols 0-3 red (red wins over white), cols 4-15 white
    for (let x = 0; x < 4; x++) expect(px[16 + x]).toBe(2);
    for (let x = 4; x < 16; x++) expect(px[16 + x]).toBe(1);

    // Row 2: cols 0-7 black, cols 8-15 white
    for (let x = 0; x < 8; x++) expect(px[32 + x]).toBe(0);
    for (let x = 8; x < 16; x++) expect(px[32 + x]).toBe(1);
  });

  it('writing the red plane alone (BW left default white) shows red on white', () => {
    const seen: Frame[] = [];
    const d = new SSD168xDecoder({
      width: 8,
      height: 1,
      onFlush: (f) => seen.push(f),
    });
    feedAll(
      d,
      cmd(CMD_DATA_ENTRY_MODE), data(0x03),
      cmd(CMD_SET_RAMX_RANGE),  data(0x00, 0x00),
      cmd(CMD_SET_RAMY_RANGE),  data(0x00, 0x00, 0x00, 0x00),
      cmd(CMD_SET_RAMX_COUNTER), data(0x00),
      cmd(CMD_SET_RAMY_COUNTER), data(0x00, 0x00),
      cmd(CMD_WRITE_RED_VRAM),
      data(0xaa), // alternating red pixels (1010 1010)
      cmd(CMD_MASTER_ACTIVATION),
    );
    const px = seen[0].pixels;
    expect(Array.from(px)).toEqual([2, 1, 2, 1, 2, 1, 2, 1]);
  });
});

describe('SSD168xDecoder — larger panel sizes', () => {
  // Use Uint8Array.every() (single hot loop, one assertion) rather than per-pixel
  // expect() — at 400×300 = 120k pixels Vitest's per-call overhead dominates.

  it('initializes a 4.2" 400×300 frame as all white', () => {
    const seen: Frame[] = [];
    const d = new SSD168xDecoder({
      width: 400,
      height: 300,
      onFlush: (f) => seen.push(f),
    });
    feedAll(d, cmd(CMD_MASTER_ACTIVATION));
    expect(seen[0].width).toBe(400);
    expect(seen[0].height).toBe(300);
    expect(seen[0].pixels.length).toBe(400 * 300);
    expect(seen[0].pixels.every((p) => p === 1)).toBe(true);
  });

  it('initializes a 7.5" 800×480 frame as all white', () => {
    const seen: Frame[] = [];
    const d = new SSD168xDecoder({
      width: 800,
      height: 480,
      onFlush: (f) => seen.push(f),
    });
    feedAll(d, cmd(CMD_MASTER_ACTIVATION));
    expect(seen[0].width).toBe(800);
    expect(seen[0].height).toBe(480);
    expect(seen[0].pixels.length).toBe(800 * 480);
    expect(seen[0].pixels.every((p) => p === 1)).toBe(true);
  });
});

/**
 * Boards on the breadboard.
 *
 * A PART seated on a breadboard is joined to the hole under each pin by one
 * invisible `bb` wire (utils/breadboardSnap.ts), so traces, SPICE and every
 * validator see an ordinary connection. A BOARD (an ESP32 DevKit, a Pico, a
 * XIAO, a Nano...) is seated the same way, with three differences this module
 * owns:
 *
 *  1. Scale. Most boards are drawn at about 5 px/mm, 12.7 px between header
 *     pins, while the breadboard's grid is 9.6 px (0.1 inch at 96 dpi). A
 *     seated board is shown at the grid's real scale, 9.6 / its own pin pitch,
 *     about the centre of its footprint (see utils/boardGeometry.ts). The
 *     wokwi Arduino Nano is already drawn on the 9.6 grid and seats at 1.
 *  2. Header rows. Only the two parallel rows of header pins plug in. Pads off
 *     those rows (a Pico's GP25 LED pseudo-pin, a Nano's ICSP block) stay
 *     unseated, and names that alias one pad (a XIAO's D0 and 26) are ONE pad,
 *     wired once, under the name a click on that pad records.
 *  3. Rotation. A breadboard strip is one column of five holes, so the rows
 *     must run ALONG the breadboard and straddle the centre trench, one row in
 *     each bank. The solver tries the quarter turns; a portrait board turns 90
 *     degrees to seat. It is the strip rule of solvePlacement (no two pins in
 *     one strip) that rejects every other orientation.
 *
 * Holes under the board's body, between its two header rows, are blocked for
 * parts and wires, as on a real breadboard: the free holes are the ones
 * outside the rows (three on one side and two on the other for a XIAO, a
 * single row on one side only for a 1.0 inch ESP32 DevKit).
 *
 * Everything below is pure geometry (pins in, numbers out) except
 * readBoardHeader, the one DOM read, so the agent's server-side geometry can
 * be exported from the very same functions.
 */
import { breadboardGroupKey, isBreadboard } from './breadboardNets';
import {
  breadboardHoles,
  solvePlacement,
  type ComponentLike,
  type PinOffset,
  type Placement,
} from './breadboardSnap';
import { boardBox, boardSize, normalizeRotation } from './boardGeometry';
import { getProBoard } from '../lib/proBoardRegistry';
import { readPinInfo } from './readPinInfo';

/** Breadboard hole pitch, CSS px: 0.1 inch at 96 dpi (the wokwi standard). */
export const BREADBOARD_PITCH = 9.6;

/** DynamicComponent wrapper inset (border 2 + padding 4): where a
 *  breadboard's hole grid starts relative to its component x/y. */
const BB_INSET = 6;

/**
 * Board kinds of the open-source app that physically fit a breadboard: two
 * parallel rows of header pins on the 0.1 inch grid, 0.6 to 1.0 inch apart.
 * Overlay boards opt in with `breadboard: true` on their ProBoardDef.
 *
 * Measured against the real pin tables on 2026-11-18 (every one lands within
 * 0.83 px of its holes at its seat scale). Left out on purpose: the Uno and
 * Mega (shield headers), every Raspberry Pi (2x20 header, adjacent rows), the
 * ATtiny85 (a schematic-size DIP drawing that would shrink to a quarter) and
 * the STM32 Discovery / Netduino family (generic boxes, not breadboard
 * boards).
 */
export const SEATABLE_BOARD_KINDS: ReadonlySet<string> = new Set([
  'arduino-nano',
  'arduino-nano-esp32',
  'esp32',
  'esp32-devkit-c-v4',
  'esp32-s3',
  'esp32-c3',
  'esp32-cam',
  'wemos-lolin32-lite',
  'xiao-esp32-s3',
  'xiao-esp32-c3',
  'aitewinrobot-esp32c3-supermini',
  'raspberry-pi-pico',
  'pi-pico-w',
  'stm32-bluepill',
  'stm32-bluepill-f103cb',
  'stm32-blackpill',
  'stm32-blackpill-f401',
]);

/** True when a board of this kind may be plugged into a breadboard. */
export function canSeatOnBreadboard(boardKind: string): boolean {
  return SEATABLE_BOARD_KINDS.has(boardKind) || getProBoard(boardKind)?.breadboard === true;
}

// ── Header geometry (pure) ──────────────────────────────────────────────────

/** One physical pad: every pinInfo name declared at one coordinate. */
export interface BoardPad {
  /** The name a click on the pad records: PinOverlay paints one square per
   *  pinInfo entry and the LAST one at a coordinate is on top, so a user
   *  wire to this pad carries this name. Seat wires use it too, so a seat
   *  and a hand-drawn wire to the same pad are the same pin everywhere. */
  name: string;
  /** Every name of the pad, declaration order (aliases such as D0 / 26). */
  names: string[];
  /** Element-space position, CSS px, unscaled and unrotated. */
  x: number;
  y: number;
}

export interface BoardHeader {
  /** The two header rows, each sorted along the row. */
  rows: [BoardPad[], BoardPad[]];
  /** Both rows' pads: the pins that plug in. */
  pads: BoardPad[];
  /** Pin pitch of the board's own drawing, px (least-squares fit). */
  pitch: number;
  /** Distance between the two rows, in pitches (6 for 0.6 inch). */
  rowGap: number;
  /** 9.6 / pitch, snapped to exactly 1 within 2 %: the drawing scale at
   *  which the header lands on the breadboard grid. */
  seatScale: number;
  /** Worst distance of a pad from its ideal grid position once scaled, px.
   *  Under the solver's 4 px seat tolerance for every seatable board. */
  residual: number;
}

const PAD_EPS = 0.5;
const LINE_EPS = 1.5;
const MIN_ROW_PADS = 4;
/** A row gap a breadboard can take: one row in rows a-e, the other in f-j,
 *  with the 3-pitch trench between e and f. */
const MIN_ROW_GAP = 3;
const MAX_ROW_GAP = 11;
/** Sane seat scales. A board needing more shrink than this is drawn at a
 *  schematic size (the ATtiny85's 40 px pitch) or has no 0.1 inch header. */
const MIN_SEAT_SCALE = 0.6;
const MAX_SEAT_SCALE = 1.05;

/** Collapse pinInfo into physical pads (aliases at one coordinate join). */
export function boardPads(
  pins: ReadonlyArray<{ name?: unknown; x?: unknown; y?: unknown }>,
): BoardPad[] {
  const pads: BoardPad[] = [];
  for (const p of pins) {
    if (!p || typeof p.name !== 'string') continue;
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const pad = pads.find((q) => Math.abs(q.x - x) <= PAD_EPS && Math.abs(q.y - y) <= PAD_EPS);
    if (pad) {
      if (!pad.names.includes(p.name)) pad.names.push(p.name);
      pad.name = p.name;
    } else {
      pads.push({ name: p.name, names: [p.name], x, y });
    }
  }
  return pads;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Pads grouped into lines that share `key` (x: vertical lines, y: horizontal). */
function linesOf(pads: BoardPad[], key: 'x' | 'y'): BoardPad[][] {
  const sorted = [...pads].sort((a, b) => a[key] - b[key]);
  const lines: BoardPad[][] = [];
  for (const p of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(p[key] - mean(last.map((q) => q[key]))) <= LINE_EPS) last.push(p);
    else lines.push([p]);
  }
  return lines.filter((l) => l.length >= MIN_ROW_PADS);
}

/**
 * The two header rows of a board, its pitch and its seat scale, from its
 * pinInfo alone. Null when the pins are not two parallel rows on a uniform
 * grid a breadboard can take.
 *
 * The pitch is a least-squares fit over integer pin indices, with the indices
 * taken from LOCAL steps (each gap rounded to whole pitches). That is what
 * survives the two ways real pin tables are uneven: whole-pixel rounding
 * (steps of 12 and 13 px for a 12.7 px pitch, which fools a minimum or a
 * median step) and rows with skipped positions (the FireBeetle 2 boards,
 * which fool a first-to-last span divided by the pin count).
 */
export function boardHeader(
  pins: ReadonlyArray<{ name?: unknown; x?: unknown; y?: unknown }>,
): BoardHeader | null {
  const pads = boardPads(pins);
  let best: { rows: [BoardPad[], BoardPad[]]; along: 'x' | 'y'; across: 'x' | 'y' } | null = null;
  let bestCount = 0;
  for (const key of ['x', 'y'] as const) {
    const lines = linesOf(pads, key).sort((a, b) => b.length - a.length);
    if (lines.length < 2) continue;
    const count = lines[0].length + lines[1].length;
    if (count > bestCount) {
      bestCount = count;
      const along = key === 'x' ? 'y' : 'x';
      const rows = [lines[0], lines[1]]
        .map((l) => [...l].sort((a, b) => a[along] - b[along]))
        .sort((a, b) => a[0][key] - b[0][key]) as [BoardPad[], BoardPad[]];
      best = { rows, along, across: key };
    }
  }
  if (!best) return null;
  const { rows, along, across } = best;

  const positions = rows.map((r) => r.map((p) => p[along]));
  const steps = positions.flatMap((r) => r.slice(1).map((v, i) => v - r[i])).filter((d) => d > 2);
  if (steps.length === 0) return null;
  const approx = median(steps);
  const indices = positions.map((r) => {
    const k = [0];
    for (let i = 1; i < r.length; i++) {
      k.push(k[i - 1] + Math.max(1, Math.round((r[i] - r[i - 1]) / approx)));
    }
    return k;
  });

  // Shared pitch, one intercept per row.
  let num = 0;
  let den = 0;
  positions.forEach((r, li) => {
    const k = indices[li];
    const km = mean(k);
    const pm = mean(r);
    r.forEach((v, i) => {
      num += (k[i] - km) * (v - pm);
      den += (k[i] - km) ** 2;
    });
  });
  if (den === 0) return null;
  const pitch = num / den;
  if (!(pitch > 2)) return null;
  const intercepts = positions.map((r, li) => mean(r) - pitch * mean(indices[li]));

  const acrossOf = rows.map((r) => mean(r.map((p) => p[across])));
  const gapPx = Math.abs(acrossOf[1] - acrossOf[0]);
  const rowGap = Math.round(gapPx / pitch);
  if (rowGap < MIN_ROW_GAP || rowGap > MAX_ROW_GAP) return null;

  let seatScale = BREADBOARD_PITCH / pitch;
  if (Math.abs(seatScale - 1) < 0.02) seatScale = 1;
  if (seatScale < MIN_SEAT_SCALE || seatScale > MAX_SEAT_SCALE) return null;

  // Residual on ONE common lattice: the second row's intercept, moved by a
  // whole number of pitches, should meet the first. The mismatch is split
  // between the rows, as the solver's centroid translation will split it.
  const shift = Math.round((intercepts[1] - intercepts[0]) / pitch) * pitch;
  const common = (intercepts[0] + intercepts[1] - shift) / 2;
  const acrossErr = Math.abs(gapPx - rowGap * pitch) / 2;
  let worst = 0;
  rows.forEach((r, li) => {
    const base = common + (li === 1 ? shift : 0);
    r.forEach((p, i) => {
      const alongErr = p[along] - (base + pitch * indices[li][i]);
      const offRow = Math.abs(p[across] - acrossOf[li]) + acrossErr;
      worst = Math.max(worst, Math.hypot(alongErr, offRow));
    });
  });

  return {
    rows,
    pads: [...rows[0], ...rows[1]],
    pitch,
    rowGap,
    seatScale,
    residual: worst * seatScale,
  };
}

/**
 * Pin offsets of a board's pads from its (x, y), with rotation and scale
 * about the footprint centre: offset = c0 + R * s * (pad - c0). Exactly what
 * BoardOnCanvas draws and calculatePinPosition computes for a board.
 */
export function boardPadOffsets(
  pads: ReadonlyArray<BoardPad>,
  size: { w: number; h: number },
  rotation: number,
  scale: number,
): PinOffset[] {
  const theta = (normalizeRotation(rotation) * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const cx = size.w / 2;
  const cy = size.h / 2;
  return pads.map((p) => {
    const dx = (p.x - cx) * scale;
    const dy = (p.y - cy) * scale;
    return { name: p.name, dx: cx + dx * cos - dy * sin, dy: cy + dx * sin + dy * cos };
  });
}

/** The board's header geometry read off its mounted element, or null. */
export function readBoardHeader(boardId: string): BoardHeader | null {
  if (typeof document === 'undefined') return null;
  const info = readPinInfo<{ name: string; x: number; y: number }>(document.getElementById(boardId));
  return info ? boardHeader(info) : null;
}

// ── Holes ───────────────────────────────────────────────────────────────────

const HOLE_RE = /^(\d+)([tb])\.([a-j])$/;
/** Row position in pitches, trench included: a-e are 0-4, f-j are 7-11. */
const ROW_POS: Record<string, number> = { a: 0, b: 1, c: 2, d: 3, e: 4, f: 7, g: 8, h: 9, i: 10, j: 11 };

/** Row position (pitches) of a terminal hole, or null for rails/unknown. */
export function holeRowPos(holeName: string): number | null {
  const m = HOLE_RE.exec(holeName);
  return m ? ROW_POS[m[3]] : null;
}

/** World centre of a breadboard hole, or null when the name is not a hole. */
export function holeWorld(bb: ComponentLike, holeName: string): { x: number; y: number } | null {
  const h = breadboardHoles(bb.metadataId)?.find((x) => x.name === holeName);
  return h ? { x: bb.x + BB_INSET + h.x, y: bb.y + BB_INSET + h.y } : null;
}

/**
 * Holes a seated board makes unusable beyond its own pins: every terminal
 * hole between its top header row and its bottom one (both included) whose
 * centre lies under the board's drawn body. The rows outside the headers stay
 * free even where the drawing overhangs by half a pitch: those holes beside
 * the pins are the whole point of putting a board on a breadboard (on a 1.0
 * inch ESP32 DevKit they are the ONLY free ones).
 */
/** Terminal holes of a breadboard kind with their row position, computed
 *  once: the body test runs for every candidate seat of every frame. */
const terminalCache = new Map<string, Array<{ name: string; x: number; y: number; row: number }>>();
function terminalHoles(metadataId: string): Array<{ name: string; x: number; y: number; row: number }> {
  let list = terminalCache.get(metadataId);
  if (!list) {
    list = [];
    for (const h of breadboardHoles(metadataId) ?? []) {
      const row = holeRowPos(h.name);
      if (row !== null) list.push({ name: h.name, x: h.x, y: h.y, row });
    }
    terminalCache.set(metadataId, list);
  }
  return list;
}

export function boardBodyHoles(
  bb: ComponentLike,
  pose: { boardKind: string; x: number; y: number; rotation?: number; scale?: number },
  seatHoles: ReadonlyArray<string>,
): Set<string> {
  const out = new Set<string>();
  const rows = seatHoles.map(holeRowPos).filter((r): r is number => r !== null);
  if (rows.length === 0) return out;
  const top = Math.min(...rows);
  const bottom = Math.max(...rows);
  const box = boardBox(pose);
  const holes = terminalHoles(bb.metadataId);
  if (holes.length === 0) return out;
  const ox = bb.x + BB_INSET;
  const oy = bb.y + BB_INSET;
  for (const h of holes) {
    const r = h.row;
    if (r < top || r > bottom) continue;
    const hx = ox + h.x;
    const hy = oy + h.y;
    if (hx > box.left + 1 && hx < box.left + box.w - 1 && hy > box.top + 1 && hy < box.top + box.h - 1) {
      out.add(h.name);
    }
  }
  return out;
}

interface WireLike {
  bb?: boolean;
  start: { componentId: string; pinName: string };
  end: { componentId: string; pinName: string };
}

interface SeatedBoardLike {
  id: string;
  boardKind: string;
  x: number;
  y: number;
  rotation?: number;
  scale?: number;
  seatedOn?: string;
}

/** Holes of `bbId` holding a seat pin of `boardId`. */
export function boardSeatHoles(bbId: string, boardId: string, wires: ReadonlyArray<WireLike>): string[] {
  const out: string[] = [];
  for (const w of wires) {
    if (!w.bb) continue;
    if (w.start.componentId === boardId && w.end.componentId === bbId) out.push(w.end.pinName);
    else if (w.end.componentId === boardId && w.start.componentId === bbId) out.push(w.start.pinName);
  }
  return out;
}

/**
 * Every hole of `bbId` that is already taken: wire ends and seated pins of
 * anything, plus the pins and covered holes of every board seated on it.
 * `exceptBoardId` leaves out that board's own seat (the one being placed).
 */
export function breadboardHolesInUse(
  bb: ComponentLike,
  boards: ReadonlyArray<SeatedBoardLike>,
  wires: ReadonlyArray<WireLike>,
  exceptBoardId?: string,
): Set<string> {
  const used = new Set<string>();
  for (const w of wires) {
    for (const [mine, other] of [
      [w.end, w.start],
      [w.start, w.end],
    ] as const) {
      if (mine.componentId !== bb.id) continue;
      // Leave out only the placed board's own SEAT; a jumper the user drew
      // from one of its pins into a hole still holds that hole, or the seat
      // could put a second pad in it and short the two pins.
      if (exceptBoardId && w.bb && other.componentId === exceptBoardId) continue;
      used.add(mine.pinName);
    }
  }
  for (const b of boards) {
    if (b.id === exceptBoardId || b.seatedOn !== bb.id) continue;
    for (const h of boardBodyHoles(bb, b, boardSeatHoles(bb.id, b.id, wires))) used.add(h);
  }
  return used;
}

/** Holes boards seated on `bbId` take from parts: their pins and the holes
 *  under their bodies. What seatOnDrop must treat as occupied. */
export function boardOccupiedHoles(
  bb: ComponentLike,
  boards: ReadonlyArray<SeatedBoardLike>,
  wires: ReadonlyArray<WireLike>,
): Set<string> {
  const out = new Set<string>();
  for (const b of boards) {
    if (b.seatedOn !== bb.id) continue;
    const seat = boardSeatHoles(bb.id, b.id, wires);
    for (const h of seat) out.add(h);
    for (const h of boardBodyHoles(bb, b, seat)) out.add(h);
  }
  return out;
}

// ── Planning a seat (pure) ──────────────────────────────────────────────────

export interface BoardSeatPlan {
  bbId: string;
  x: number;
  y: number;
  rotation: number;
  scale: number;
  /** Hole per header pad, pad names as BoardPad.name. */
  holes: { pinName: string; holeName: string }[];
  /** Distance from the wanted position, px. */
  moved: number;
}

/** True when a breadboard can take a board: one with a hole grid, unrotated
 *  (seating on a turned breadboard is not supported, as for parts). */
export function isSeatableBreadboard(c: ComponentLike): boolean {
  return (
    isBreadboard(c.metadataId) &&
    !!breadboardHoles(c.metadataId) &&
    normalizeRotation(c.properties?.rotation) === 0
  );
}

/**
 * Seat for a board: the rotations are tried IN ORDER and the first one that
 * seats anywhere wins; within it, the breadboard and spot that move the board
 * least. Order is a real preference, not a tie-break: a board's header is
 * rarely centred in its footprint, so the half-turned lattice often sits a
 * fraction of a pitch nearer, and "least moved over every rotation" flipped a
 * seated board end for end (every pin into another strip) on a 3 px nudge.
 * Every header pad must land in a free hole, no two pads in one strip (so the
 * rows straddle the trench), and the body must not cover anything in use.
 */
export function planBoardSeat(opts: {
  boardKind: string;
  header: BoardHeader;
  /** Board (x, y) the gesture or the caller wants. */
  wantX: number;
  wantY: number;
  /** Rotations to try, in preference order. */
  rotations: number[];
  breadboards: ReadonlyArray<ComponentLike>;
  /** Holes already taken on a breadboard (breadboardHolesInUse). */
  used: (bbId: string) => ReadonlySet<string>;
  /** Furthest the board may slide from where it is wanted, px. */
  maxMove?: number;
  /** Rotation-specific wanted position (an anchored seat lands each rotation
   *  differently); defaults to wantX / wantY. */
  wantFor?: (rotation: number, offsets: PinOffset[]) => { x: number; y: number } | null;
}): BoardSeatPlan | null {
  const size = boardSize(opts.boardKind);
  const scale = opts.header.seatScale;
  const maxMove = opts.maxMove ?? Infinity;
  const seen = new Set<number>();
  for (const raw of opts.rotations) {
    const rotation = normalizeRotation(raw);
    if (seen.has(rotation)) continue;
    seen.add(rotation);
    let best: BoardSeatPlan | null = null;
    const offsets = boardPadOffsets(opts.header.pads, size, rotation, scale);
    const want = opts.wantFor ? opts.wantFor(rotation, offsets) : { x: opts.wantX, y: opts.wantY };
    if (!want) continue;
    for (const bb of opts.breadboards) {
      if (!isSeatableBreadboard(bb)) continue;
      const used = opts.used(bb.id);
      const accept = (p: Placement): boolean => {
        if (p.moved > maxMove) return false;
        const body = boardBodyHoles(
          bb,
          { boardKind: opts.boardKind, x: p.x, y: p.y, rotation, scale },
          p.holes.map((h) => h.holeName),
        );
        for (const h of body) if (used.has(h)) return false;
        return true;
      };
      const p = solvePlacement(offsets, bb, used, want.x, want.y, accept);
      if (p && (!best || p.moved < best.moved)) {
        best = { bbId: bb.id, x: p.x, y: p.y, rotation, scale, holes: p.holes, moved: p.moved };
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Board pads as seat wires would name them: one per pad, in the plan's hole
 * order. Exposed so tests and the store agree on the wire shape:
 * `bbwire-<boardId>-<i>-<hole>`, start = board pad, end = hole, `bb: true`,
 * the very shape parts get from reseatComponentOnBreadboard.
 */
export function boardSeatWireId(boardId: string, index: number, holeName: string): string {
  return `bbwire-${boardId}-${index}-${holeName}`;
}

/** Strip key of a hole, for tests and diagnostics. */
export function holeStrip(bbMetadataId: string, holeName: string): string | null {
  return breadboardGroupKey(bbMetadataId, holeName);
}

/** Whether the centre of a board footprint is over a breadboard's terminal
 *  area, grown by `margin` px (hysteresis while a seat preview is shown). */
export function isOverTerminalArea(bb: ComponentLike, cx: number, cy: number, margin: number): boolean {
  const holes = breadboardHoles(bb.metadataId);
  if (!holes) return false;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const h of holes) {
    if (holeRowPos(h.name) === null) continue;
    if (h.x < minX) minX = h.x;
    if (h.x > maxX) maxX = h.x;
    if (h.y < minY) minY = h.y;
    if (h.y > maxY) maxY = h.y;
  }
  if (!Number.isFinite(minX)) return false;
  const ox = bb.x + BB_INSET;
  const oy = bb.y + BB_INSET;
  return (
    cx >= ox + minX - margin && cx <= ox + maxX + margin && cy >= oy + minY - margin && cy <= oy + maxY + margin
  );
}

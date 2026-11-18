// @vitest-environment jsdom
/**
 * Boards on the breadboard: the pure geometry of utils/boardSeat.ts, run
 * against the REAL pin tables of every board the open-source app draws.
 *
 * What a seat must be, for every board that physically fits a breadboard:
 *  - only the two header rows plug in, one pad per coordinate (aliases join);
 *  - the board is shown at the breadboard's real scale, 9.6 / its pin pitch;
 *  - every header pad lands within the 4 px seat tolerance of a hole, the
 *    rows straddle the trench (one in each bank) and no two pads share a
 *    strip, which is what makes a portrait board turn 90 degrees.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import '@wokwi/elements';
import '../components/velxio-components/Esp32Element';
import '../components/velxio-components/PiPicoWElement';
import '../components/velxio-components/Stm32BluePillElement';
import '../components/velxio-components/Attiny85Element';
import '../components/velxio-components/RaspberryPi3Element';
import {
  boardBodyHoles,
  boardHeader,
  boardPadOffsets,
  boardPads,
  breadboardHolesInUse,
  canSeatOnBreadboard,
  holeRowPos,
  holeStrip,
  holeWorld,
  isOverTerminalArea,
  planBoardSeat,
  type BoardHeader,
} from '../utils/boardSeat';
import { boardBox, boardSize, normalizeScale } from '../utils/boardGeometry';
import { calculatePinPosition } from '../utils/pinPositionCalculator';
import { SEAT_TOLERANCE } from '../utils/breadboardSnap';
import { BREADBOARD_PINS } from '../velxio-elements/breadboard-element';

type Pin = { name: string; x: number; y: number };

/** Tag and attributes BoardOnCanvas renders each kind with. */
const ELEMENT: Record<string, { tag: string; attrs?: Record<string, string> }> = {
  esp32: { tag: 'velxio-esp32', attrs: { 'board-kind': 'esp32' } },
  'esp32-devkit-c-v4': { tag: 'velxio-esp32', attrs: { 'board-kind': 'esp32-devkit-c-v4' } },
  'esp32-s3': { tag: 'velxio-esp32', attrs: { 'board-kind': 'esp32-s3' } },
  'esp32-c3': { tag: 'velxio-esp32', attrs: { 'board-kind': 'esp32-c3' } },
  'esp32-cam': { tag: 'velxio-esp32', attrs: { 'board-kind': 'esp32-cam' } },
  'wemos-lolin32-lite': { tag: 'velxio-esp32', attrs: { 'board-kind': 'wemos-lolin32-lite' } },
  'xiao-esp32-s3': { tag: 'velxio-esp32', attrs: { 'board-kind': 'xiao-esp32-s3' } },
  'xiao-esp32-c3': { tag: 'velxio-esp32', attrs: { 'board-kind': 'xiao-esp32-c3' } },
  'aitewinrobot-esp32c3-supermini': {
    tag: 'velxio-esp32',
    attrs: { 'board-kind': 'aitewinrobot-esp32c3-supermini' },
  },
  'arduino-nano-esp32': { tag: 'velxio-esp32', attrs: { 'board-kind': 'arduino-nano-esp32' } },
  'arduino-nano': { tag: 'wokwi-arduino-nano' },
  'raspberry-pi-pico': { tag: 'velxio-pi-pico-w' },
  'pi-pico-w': { tag: 'velxio-pi-pico-w' },
  'stm32-bluepill': { tag: 'velxio-stm32-bluepill' },
  'stm32-bluepill-f103cb': { tag: 'velxio-stm32-bluepill-f103cb' },
  'stm32-blackpill': { tag: 'velxio-stm32-blackpill' },
  'stm32-blackpill-f401': { tag: 'velxio-stm32-blackpill-f401' },
  // Not breadboard boards, for the negative cases.
  'arduino-uno': { tag: 'wokwi-arduino-uno' },
  attiny85: { tag: 'velxio-attiny85' },
  'raspberry-pi-3': { tag: 'velxio-raspberry-pi-3' },
};

function pinsOf(kind: string): Pin[] {
  const spec = ELEMENT[kind];
  const el = document.createElement(spec.tag) as HTMLElement & { pinInfo?: Pin[] };
  for (const [k, v] of Object.entries(spec.attrs ?? {})) el.setAttribute(k, v);
  document.body.appendChild(el);
  const pins = [...(el.pinInfo ?? [])].map((p) => ({ name: p.name, x: p.x, y: p.y }));
  el.remove();
  return pins;
}

/**
 * Expected header of each seatable kind: pads in the two rows, the row gap in
 * pitches and the seat scale. Measured from the pin tables on 2026-11-18
 * (project board-on-breadboard-2026-11, mapa/boards.md).
 */
const EXPECTED: Record<string, { pads: number; rowGap: number; scale: number }> = {
  'xiao-esp32-s3': { pads: 14, rowGap: 6, scale: 0.7572 },
  'xiao-esp32-c3': { pads: 14, rowGap: 6, scale: 0.7572 },
  'aitewinrobot-esp32c3-supermini': { pads: 16, rowGap: 6, scale: 0.7572 },
  'arduino-nano-esp32': { pads: 30, rowGap: 6, scale: 0.7561 },
  'arduino-nano': { pads: 30, rowGap: 6, scale: 1 },
  'raspberry-pi-pico': { pads: 40, rowGap: 7, scale: 0.7564 },
  'pi-pico-w': { pads: 40, rowGap: 7, scale: 0.7564 },
  esp32: { pads: 30, rowGap: 10, scale: 0.7561 },
  'esp32-devkit-c-v4': { pads: 38, rowGap: 10, scale: 0.7559 },
  'esp32-s3': { pads: 44, rowGap: 9, scale: 0.7557 },
  'esp32-c3': { pads: 30, rowGap: 9, scale: 0.7559 },
  'esp32-cam': { pads: 16, rowGap: 9, scale: 0.7536 },
  'wemos-lolin32-lite': { pads: 26, rowGap: 9, scale: 0.756 },
  'stm32-bluepill': { pads: 40, rowGap: 6, scale: 0.7555 },
  'stm32-bluepill-f103cb': { pads: 40, rowGap: 6, scale: 0.7555 },
  'stm32-blackpill': { pads: 40, rowGap: 6, scale: 0.7557 },
  'stm32-blackpill-f401': { pads: 40, rowGap: 6, scale: 0.7557 },
};

const SEATABLE = Object.keys(EXPECTED);
const BB = { id: 'bb1', metadataId: 'breadboard', x: 0, y: 0, properties: {} };

const headers = new Map<string, BoardHeader>();
beforeAll(() => {
  for (const kind of SEATABLE) {
    const h = boardHeader(pinsOf(kind));
    if (h) headers.set(kind, h);
  }
});

describe('board header geometry from the real pin tables', () => {
  it.each(SEATABLE)('%s: two header rows, the right pitch and scale, sub-pixel residual', (kind) => {
    const h = headers.get(kind);
    expect(h, `${kind} has a header`).toBeTruthy();
    const want = EXPECTED[kind];
    expect(h!.pads.length).toBe(want.pads);
    expect(h!.rowGap).toBe(want.rowGap);
    expect(h!.seatScale).toBeCloseTo(want.scale, 3);
    expect(h!.residual).toBeLessThan(1);
    expect(canSeatOnBreadboard(kind)).toBe(true);
  });

  it('boards that are not breadboard boards have no seatable header', () => {
    // Uno: shield headers far apart. Pi 3: a 2x20 header with adjacent rows.
    // ATtiny85: a schematic-size DIP drawing (40 px pitch, scale 0.24).
    for (const kind of ['arduino-uno', 'raspberry-pi-3', 'attiny85']) {
      expect(boardHeader(pinsOf(kind)), kind).toBeNull();
      expect(canSeatOnBreadboard(kind)).toBe(false);
    }
  });

  it('pads off the two rows stay out: the Pico GP25 LED and the Nano ICSP block', () => {
    const pico = headers.get('pi-pico-w')!;
    expect(pico.pads.some((p) => p.names.includes('GP25'))).toBe(false);
    const nanoPins = pinsOf('arduino-nano');
    expect(nanoPins.length).toBeGreaterThan(30); // the ICSP pads exist...
    expect(headers.get('arduino-nano')!.pads.length).toBe(30); // ...and do not seat
  });

  it('aliases of one pad are one pad, named as a click on it records it (the last name)', () => {
    const pads = boardPads([
      { name: '26', x: 7, y: 25 },
      { name: 'D0', x: 7, y: 25 },
      { name: '27', x: 7, y: 37 },
      { name: 'D1', x: 7, y: 37 },
    ]);
    expect(pads).toHaveLength(2);
    expect(pads[0]).toMatchObject({ name: 'D0', names: ['26', 'D0'] });
    // The DevKit V1 names two pads twice (RX2/16, TX2/17): 32 entries, 30 pads.
    expect(pinsOf('esp32').length).toBeGreaterThan(30);
    expect(headers.get('esp32')!.pads).toHaveLength(30);
  });

  it('a row with skipped positions still fits the true pitch (FireBeetle 2 style)', () => {
    // 12.7 px pitch, left row on positions 0,1,3..9, right row on 4..9:
    // first-to-last over the count would read 14.1 px for the left row.
    const left = [0, 1, 3, 4, 5, 6, 7, 8, 9].map((k, i) => ({ name: `L${i}`, x: 6, y: 20 + k * 12.7 }));
    const right = [4, 5, 6, 7, 8, 9].map((k, i) => ({ name: `R${i}`, x: 6 + 9 * 12.7, y: 20 + k * 12.7 }));
    const h = boardHeader([...left, ...right]);
    expect(h).not.toBeNull();
    expect(h!.pitch).toBeCloseTo(12.7, 3);
    expect(h!.rowGap).toBe(9);
    expect(h!.residual).toBeLessThan(0.01);
  });

  it('whole-pixel rounding (steps of 12 and 13 px) does not fool the pitch', () => {
    const ys = [25, 37, 50, 63, 75, 88, 101];
    const pins = [...ys.map((y, i) => ({ name: `A${i}`, x: 7, y })), ...ys.map((y, i) => ({ name: `B${i}`, x: 83, y }))];
    const h = boardHeader(pins)!;
    expect(h.pitch).toBeCloseTo(12.679, 2);
    expect(h.seatScale).toBeCloseTo(0.7572, 3);
  });
});

describe('the canvas maths and the seat maths agree', () => {
  it('boardPadOffsets equals calculatePinPosition at every rotation and scale', () => {
    const kind = 'esp32';
    const spec = ELEMENT[kind];
    const el = document.createElement(spec.tag);
    el.id = 'board-under-test';
    for (const [k, v] of Object.entries(spec.attrs ?? {})) el.setAttribute(k, v);
    document.body.appendChild(el);
    const size = boardSize(kind);
    const h = headers.get(kind)!;
    for (const rotation of [0, 90, 180, 270]) {
      for (const scale of [1, h.seatScale]) {
        const offsets = boardPadOffsets(h.pads, size, rotation, scale);
        offsets.forEach((o) => {
          const p = calculatePinPosition('board-under-test', o.name, 100, 50, rotation, size, scale)!;
          expect(p.x).toBeCloseTo(100 + o.dx, 6);
          expect(p.y).toBeCloseTo(50 + o.dy, 6);
        });
      }
    }
    el.remove();
  });

  it('boardBox keeps the footprint centre and scales the box', () => {
    const plain = boardBox({ boardKind: 'esp32', x: 10, y: 20 });
    const seated = boardBox({ boardKind: 'esp32', x: 10, y: 20, rotation: 90, scale: 0.75 });
    const centre = (b: { left: number; top: number; w: number; h: number }) => [b.left + b.w / 2, b.top + b.h / 2];
    expect(centre(seated)[0]).toBeCloseTo(centre(plain)[0], 9);
    expect(centre(seated)[1]).toBeCloseTo(centre(plain)[1], 9);
    expect(seated.w).toBeCloseTo(plain.h * 0.75, 9);
    expect(seated.h).toBeCloseTo(plain.w * 0.75, 9);
  });

  it('normalizeScale tolerates missing and corrupt values', () => {
    expect(normalizeScale(undefined)).toBe(1);
    expect(normalizeScale('0.756')).toBeCloseTo(0.756);
    expect(normalizeScale(0)).toBe(1);
    expect(normalizeScale(-2)).toBe(1);
    expect(normalizeScale(Number.NaN)).toBe(1);
    expect(normalizeScale(50)).toBe(2);
  });
});

/** A seat for `kind` with its centre near the breadboard's middle. */
function seat(kind: string, used: Set<string> = new Set(), at?: { x: number; y: number }) {
  const h = headers.get(kind)!;
  const size = boardSize(kind);
  const mid = holeWorld(BB, '30t.e')!;
  const want = at ?? { x: mid.x - size.w / 2, y: mid.y + 14 - size.h / 2 };
  return {
    h,
    plan: planBoardSeat({
      boardKind: kind,
      header: h,
      wantX: want.x,
      wantY: want.y,
      rotations: [0, 90, 270, 180],
      breadboards: [BB],
      used: () => used,
    }),
  };
}

describe('planning a seat on the full breadboard', () => {
  it.each(SEATABLE)('%s seats with every pad on a hole, the rows straddling the trench', (kind) => {
    const { h, plan } = seat(kind);
    expect(plan, `${kind} found a seat`).not.toBeNull();
    const p = plan!;
    expect(p.scale).toBe(h.seatScale);
    // Portrait drawings turn a quarter; the two landscape ones do not.
    const landscape = kind === 'arduino-nano' || kind === 'arduino-nano-esp32';
    expect(p.rotation % 180 === 0).toBe(landscape);

    const offsets = boardPadOffsets(h.pads, boardSize(kind), p.rotation, p.scale);
    const strips = new Set<string>();
    const banks = new Set<string>();
    p.holes.forEach((hole, i) => {
      const at = holeWorld(BB, hole.holeName)!;
      const dist = Math.hypot(p.x + offsets[i].dx - at.x, p.y + offsets[i].dy - at.y);
      expect(dist).toBeLessThanOrEqual(SEAT_TOLERANCE);
      const strip = holeStrip('breadboard', hole.holeName)!;
      expect(strips.has(strip), `${hole.holeName} shares a strip`).toBe(false);
      strips.add(strip);
      banks.add(hole.holeName.includes('t.') ? 't' : 'b');
    });
    expect(p.holes).toHaveLength(h.pads.length);
    expect([...banks].sort()).toEqual(['b', 't']);
  });

  it('a XIAO leaves free holes on both sides; a 1.0 inch DevKit leaves one row on one side', () => {
    const free = (kind: string) => {
      const { plan } = seat(kind);
      const p = plan!;
      const body = boardBodyHoles(
        BB,
        { boardKind: kind, x: p.x, y: p.y, rotation: p.rotation, scale: p.scale },
        p.holes.map((x) => x.holeName),
      );
      const taken = new Set([...body, ...p.holes.map((x) => x.holeName)]);
      const rows = p.holes.map((x) => holeRowPos(x.holeName)!);
      const topRow = Math.min(...rows);
      const bottomRow = Math.max(...rows);
      // Free holes in the strip of one top-row pin and one bottom-row pin.
      const topHole = p.holes.find((x) => holeRowPos(x.holeName) === topRow)!.holeName;
      const bottomHole = p.holes.find((x) => holeRowPos(x.holeName) === bottomRow)!.holeName;
      const stripFree = (hole: string) =>
        BREADBOARD_PINS.filter(
          (b) => holeStrip('breadboard', b.name) === holeStrip('breadboard', hole) && !taken.has(b.name),
        ).length;
      return [stripFree(topHole), stripFree(bottomHole)].sort();
    };
    const xiao = free('xiao-esp32-s3');
    expect(xiao[0] + xiao[1]).toBe(5); // 10 holes, 5 under the board between d..h style rows
    expect(Math.min(...xiao)).toBeGreaterThanOrEqual(2);
    const devkit = free('esp32');
    expect(devkit).toEqual([0, 1]); // the classic "ESP32 does not fit the breadboard"
  });

  it('a hole already in use is never taken, and the body never covers one', () => {
    const { plan: first } = seat('xiao-esp32-s3');
    const pinHole = first!.holes[0].holeName;
    // Something sits in the first pin's hole: the board goes elsewhere.
    const { plan: second } = seat('xiao-esp32-s3', new Set([pinHole]));
    expect(second).not.toBeNull();
    expect(second!.holes.map((h) => h.holeName)).not.toContain(pinHole);
    // Something sits under where the body would be: also elsewhere.
    const body = boardBodyHoles(
      BB,
      { boardKind: 'xiao-esp32-s3', ...first!, scale: first!.scale },
      first!.holes.map((h) => h.holeName),
    );
    const under = [...body].find((h) => !first!.holes.some((x) => x.holeName === h))!;
    const { plan: third } = seat('xiao-esp32-s3', new Set([under]));
    expect(third).not.toBeNull();
    const body3 = boardBodyHoles(
      BB,
      { boardKind: 'xiao-esp32-s3', ...third!, scale: third!.scale },
      third!.holes.map((h) => h.holeName),
    );
    expect(body3.has(under)).toBe(false);
  });

  it('no seat on a turned breadboard, and none when the board is far away', () => {
    const turned = { ...BB, properties: { rotation: 90 } };
    const h = headers.get('xiao-esp32-s3')!;
    expect(
      planBoardSeat({
        boardKind: 'xiao-esp32-s3',
        header: h,
        wantX: 100,
        wantY: 30,
        rotations: [0, 90],
        breadboards: [turned],
        used: () => new Set(),
      }),
    ).toBeNull();
    expect(seat('xiao-esp32-s3', new Set(), { x: 2000, y: 2000 }).plan).toBeNull();
  });

  it('holes in use: wire ends, seated pins, and the pins and body of another seated board', () => {
    const { plan } = seat('xiao-esp32-s3');
    const p = plan!;
    const wires = [
      // the XIAO's own seat wires
      ...p.holes.map((h) => ({
        bb: true,
        start: { componentId: 'xiao', pinName: h.pinName },
        end: { componentId: 'bb1', pinName: h.holeName },
      })),
      // a user jumper into 2t.a
      { start: { componentId: 'led1', pinName: 'A' }, end: { componentId: 'bb1', pinName: '2t.a' } },
    ];
    const boards = [{ id: 'xiao', boardKind: 'xiao-esp32-s3', x: p.x, y: p.y, rotation: p.rotation, scale: p.scale, seatedOn: 'bb1' }];
    const used = breadboardHolesInUse(BB, boards, wires);
    expect(used.has('2t.a')).toBe(true);
    for (const h of p.holes) expect(used.has(h.holeName)).toBe(true);
    // Leaving the XIAO out (it is the board being placed) frees its holes.
    const usedByOthers = breadboardHolesInUse(BB, boards, wires, 'xiao');
    expect(usedByOthers.has(p.holes[0].holeName)).toBe(false);
    expect(usedByOthers.has('2t.a')).toBe(true);
  });

  it('the terminal-area test drives the gesture: centre over the rows, with a margin', () => {
    const mid = holeWorld(BB, '30t.e')!;
    expect(isOverTerminalArea(BB, mid.x, mid.y, 0)).toBe(true);
    // The top rail sits about 29 px above row a: outside the rows, inside
    // a 40 px margin.
    const rail = holeWorld(BB, 'tp.10')!;
    expect(isOverTerminalArea(BB, rail.x, rail.y, 0)).toBe(false);
    expect(isOverTerminalArea(BB, rail.x, rail.y, 40)).toBe(true);
  });
});

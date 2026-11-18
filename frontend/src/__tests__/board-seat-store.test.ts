// @vitest-environment jsdom
/**
 * Boards on the breadboard, at the store level: the drag gesture
 * (dragBoardTo / endBoardDrag), seating from code, R on a seated board, and
 * what moving, turning, deleting (and undoing the delete of) the breadboard
 * does to a board plugged into it. Real pin tables: the board element is the
 * real <velxio-esp32>, mounted under the board's id.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import '../components/velxio-components/Esp32Element';
import '../components/velxio-components/Stm32BluePillElement';
import { useSimulatorStore } from '../store/useSimulatorStore';
import type { BoardInstance } from '../types/board';
import { BREADBOARD_PINS } from '../velxio-elements/breadboard-element';
import { boardSize } from '../utils/boardGeometry';
import {
  boardOccupiedHoles,
  holeWorld,
  readBoardHeader,
} from '../utils/boardSeat';
import { computeProjectStateHash, buildSavePayload } from '../utils/projectPayload';
import { seatOnDrop } from '../utils/breadboardSnap';

const BOARD = 'xiao-board';
const KIND = 'xiao-esp32-c3';
const BB = { id: 'bb1', metadataId: 'breadboard', x: 0, y: 0, properties: {} as Record<string, unknown> };

function mountBoard(id: string, kind: string): void {
  document.getElementById(id)?.remove();
  const el = document.createElement('velxio-esp32');
  el.id = id;
  el.setAttribute('board-kind', kind);
  document.body.appendChild(el);
}

function mountFake(id: string, pinInfo: unknown): void {
  document.getElementById(id)?.remove();
  const el = document.createElement('div');
  el.id = id;
  (el as unknown as { pinInfo: unknown }).pinInfo = pinInfo;
  document.body.appendChild(el);
}

function board(over: Partial<BoardInstance> = {}): BoardInstance {
  return {
    id: BOARD,
    boardKind: KIND as BoardInstance['boardKind'],
    x: 800,
    y: 600,
    running: false,
    compiledProgram: null,
    serialOutput: '',
    serialBaudRate: 0,
    serialMonitorOpen: false,
    activeFileGroupId: `group-${BOARD}`,
    languageMode: 'arduino',
    ...over,
  } as BoardInstance;
}

const st = () => useSimulatorStore.getState();
const theBoard = () => st().boards.find((b) => b.id === BOARD)!;
const seatWires = () => st().wires.filter((w) => w.bb && w.start.componentId === BOARD);

/** Board (x, y) that puts its footprint centre over a breadboard hole. */
function centredOver(hole: string) {
  const at = holeWorld(BB, hole)!;
  const size = boardSize(KIND);
  return { x: at.x - size.w / 2, y: at.y - size.h / 2 };
}

/** Drag the board over the breadboard middle and drop it there. */
function dragOnAndDrop(hole = '30t.e') {
  const p = centredOver(hole);
  st().dragBoardTo(BOARD, p.x + 3, p.y + 2);
  st().endBoardDrag(BOARD);
}

beforeEach(() => {
  mountBoard(BOARD, KIND);
  mountFake('bb1', BREADBOARD_PINS);
  useSimulatorStore.setState({
    boards: [board()],
    activeBoardId: BOARD,
    components: [{ ...BB, properties: {} }],
    wires: [],
    history: [],
    historyIndex: -1,
  } as never);
});

describe('dragging a board onto a breadboard', () => {
  it('previews the seat while dragging and writes it only on drop', () => {
    const header = readBoardHeader(BOARD)!;
    const p = centredOver('30t.e');
    st().dragBoardTo(BOARD, p.x, p.y);
    const preview = theBoard();
    expect(preview.scale).toBeCloseTo(header.seatScale, 6);
    expect([90, 270]).toContain(preview.rotation);
    expect(preview.seatedOn).toBeUndefined();
    expect(seatWires()).toHaveLength(0);

    st().endBoardDrag(BOARD);
    const seated = theBoard();
    expect(seated.seatedOn).toBe('bb1');
    const wires = seatWires();
    expect(wires).toHaveLength(header.pads.length);
    for (const w of wires) {
      expect(w.id.startsWith(`bbwire-${BOARD}-`)).toBe(true);
      expect(w.end.componentId).toBe('bb1');
      // Pin and hole within the seat tolerance once endpoints are stamped.
      expect(Math.hypot(w.start.x - w.end.x, w.start.y - w.end.y)).toBeLessThanOrEqual(4);
    }
    // One bank each: the rows straddle the trench.
    const banks = new Set(wires.map((w) => (w.end.pinName.includes('t.') ? 't' : 'b')));
    expect([...banks].sort()).toEqual(['b', 't']);
  });

  it('a board dragged nowhere near a breadboard is just moved', () => {
    st().dragBoardTo(BOARD, 1200, 900);
    st().endBoardDrag(BOARD);
    const b = theBoard();
    expect(b).toMatchObject({ x: 1200, y: 900 });
    expect(b.seatedOn).toBeUndefined();
    expect(b.scale).toBeUndefined();
    expect(seatWires()).toHaveLength(0);
  });

  it('dragging it off again unseats it: scale 1, seat wires gone, rotation kept', () => {
    dragOnAndDrop();
    const seatedRotation = theBoard().rotation;
    st().dragBoardTo(BOARD, 1400, 1000);
    expect(theBoard().scale).toBeUndefined();
    st().endBoardDrag(BOARD);
    const b = theBoard();
    expect(b.seatedOn).toBeUndefined();
    expect(b.scale).toBeUndefined();
    expect(b.rotation).toBe(seatedRotation);
    expect(seatWires()).toHaveLength(0);
  });

  it('the turn a preview made is undone when the same drag leaves the breadboard', () => {
    const p = centredOver('30t.e');
    st().dragBoardTo(BOARD, p.x, p.y);
    expect(theBoard().rotation).not.toBe(0);
    st().dragBoardTo(BOARD, 1400, 1000);
    expect(theBoard().rotation).toBe(0);
    st().endBoardDrag(BOARD);
    expect(theBoard().rotation).toBe(0);
  });

  it('a click with no drag leaves a seated board exactly as it was', () => {
    dragOnAndDrop();
    const before = { board: theBoard(), wires: st().wires };
    st().endBoardDrag(BOARD); // no dragBoardTo in between: no gesture
    expect(theBoard()).toBe(before.board);
    expect(st().wires).toBe(before.wires);
  });

  it('a board-ended bb wire from a Wokwi import is not a seat and is left alone', () => {
    const imported = {
      id: 'wokwi-1',
      start: { componentId: BOARD, pinName: 'D0', x: 0, y: 0 },
      end: { componentId: 'bb1', pinName: '5t.a', x: 0, y: 0 },
      waypoints: [],
      color: '',
      bb: true,
    };
    useSimulatorStore.setState({ wires: [imported] });
    st().dragBoardTo(BOARD, 1300, 900);
    st().endBoardDrag(BOARD);
    st().unseatBoard(BOARD);
    expect(st().wires.map((w) => w.id)).toEqual(['wokwi-1']);
  });
});

describe('a seated board and its breadboard', () => {
  it('moving the breadboard carries the board, holes and wire ids unchanged', () => {
    dragOnAndDrop();
    const before = theBoard();
    const ids = seatWires().map((w) => w.id).sort();
    st().updateComponent('bb1', { x: 50, y: 20 });
    const after = theBoard();
    expect(after.x).toBeCloseTo(before.x + 50, 9);
    expect(after.y).toBeCloseTo(before.y + 20, 9);
    expect(seatWires().map((w) => w.id).sort()).toEqual(ids);
    for (const w of seatWires()) {
      expect(Math.hypot(w.start.x - w.end.x, w.start.y - w.end.y)).toBeLessThanOrEqual(4);
    }
  });

  it('R turns a seated board end for end and re-seats it; an unseated one turns 90', () => {
    dragOnAndDrop();
    const r0 = theBoard().rotation!;
    const count = seatWires().length;
    st().rotateBoard(BOARD);
    expect(theBoard().rotation).toBe((r0 + 180) % 360);
    expect(theBoard().seatedOn).toBe('bb1');
    expect(seatWires()).toHaveLength(count);

    useSimulatorStore.setState({ boards: [board({ rotation: 0 })], wires: [] });
    st().rotateBoard(BOARD);
    expect(theBoard().rotation).toBe(90);
  });

  it('deleting the breadboard unseats the board; undo gives the seat back', () => {
    dragOnAndDrop();
    const seated = theBoard();
    const ids = seatWires().map((w) => w.id).sort();
    st().recordRemoveComponent('bb1');
    expect(theBoard().seatedOn).toBeUndefined();
    expect(theBoard().scale).toBeUndefined();
    expect(seatWires()).toHaveLength(0);
    st().undo();
    expect(theBoard().seatedOn).toBe('bb1');
    expect(theBoard().scale).toBe(seated.scale);
    expect(seatWires().map((w) => w.id).sort()).toEqual(ids);
  });

  it('removeComponent of the breadboard also unseats', () => {
    dragOnAndDrop();
    st().removeComponent('bb1');
    expect(theBoard()).toMatchObject({ seatedOn: undefined, scale: undefined });
  });

  it('turning the breadboard unseats the board; a properties write without a turn does not', () => {
    dragOnAndDrop();
    st().updateComponent('bb1', { properties: { rotation: 0, label: 'x' } });
    expect(theBoard().seatedOn).toBe('bb1');
    st().updateComponent('bb1', { properties: { rotation: 90 } });
    expect(theBoard().seatedOn).toBeUndefined();
    expect(seatWires()).toHaveLength(0);
  });

  it('a part dropped under the board slides to free holes, never under the body', () => {
    dragOnAndDrop();
    const occupied = boardOccupiedHoles(BB, st().boards, st().wires);
    // A 2-pin part whose legs would land on two holes under the board.
    const under = [...occupied].filter((h) => /t\.[a-e]$/.test(h));
    expect(under.length).toBeGreaterThan(0);
    const hole = BREADBOARD_PINS.find((h) => h.name === under[0])!;
    const res = { id: 'r1', metadataId: 'resistor', x: 0, y: 0, properties: {} };
    mountFake('r1', [
      { name: '1', x: 0, y: 0 },
      { name: '2', x: 0, y: 28.8 },
    ]);
    const dropX = hole.x; // pin 1 straight onto the covered hole (inset cancels)
    const dropY = hole.y;
    const placement = seatOnDrop(res, dropX, dropY, [BB, res], () => occupied);
    if (placement) {
      for (const h of placement.holes) expect(occupied.has(h.holeName)).toBe(false);
    }
  });
});

describe('seating from code and repairing a loaded seat', () => {
  it('seatBoardOnBreadboard with an anchor lands that pad in that hole', () => {
    const header = readBoardHeader(BOARD)!;
    const pad = header.pads[0].name;
    const ok = st().seatBoardOnBreadboard(BOARD, { bbId: 'bb1', rotation: 90, anchorPin: pad, anchorHole: '20t.d' });
    expect(ok).toBe(true);
    const w = seatWires().find((x) => x.start.pinName === pad)!;
    expect(w.end.pinName).toBe('20t.d');
    expect(theBoard().rotation).toBe(90);
  });

  it('refuses, changing nothing, when the anchor cannot hold', () => {
    const before = theBoard();
    // A rotation whose rows would run across the strips cannot seat.
    const ok = st().seatBoardOnBreadboard(BOARD, { bbId: 'bb1', rotation: 0, anchorPin: 'D0', anchorHole: '20t.d' });
    expect(ok).toBe(false);
    expect(theBoard()).toBe(before);
    expect(seatWires()).toHaveLength(0);
  });

  it('a loaded seat with its wires is left alone; one without them is re-seated', () => {
    dragOnAndDrop();
    const seated = theBoard();
    const wires = st().wires;
    st().repairBoardSeat(BOARD);
    expect(st().wires).toBe(wires); // nothing to repair

    useSimulatorStore.setState({ wires: [] }); // a save path dropped them
    st().repairBoardSeat(BOARD);
    expect(seatWires().length).toBeGreaterThan(0);
    expect(theBoard().seatedOn).toBe('bb1');
    expect(theBoard().x).toBeCloseTo(seated.x, 0);
  });

  it('a seat whose breadboard is gone is cleared on repair', () => {
    useSimulatorStore.setState({
      boards: [board({ seatedOn: 'bb-gone', scale: 0.757, rotation: 90 })],
    });
    st().repairBoardSeat(BOARD);
    expect(theBoard()).toMatchObject({ seatedOn: undefined, scale: undefined, rotation: 90 });
  });

  it('a board without seatedOn is never touched by the repair', () => {
    const before = theBoard();
    st().repairBoardSeat(BOARD);
    expect(theBoard()).toBe(before);
  });
});

describe('persistence', () => {
  it('an unseated board saves without scale or seatedOn, so old projects hash the same', () => {
    const json = buildSavePayload().boards_json;
    expect(json).not.toContain('seatedOn');
    expect(json).not.toContain('"scale"');
  });

  it('a seated board saves seatedOn and scale, and loads back seated', () => {
    dragOnAndDrop();
    const seated = theBoard();
    const saved = JSON.parse(buildSavePayload().boards_json ?? '[]') as BoardInstance[];
    const mine = saved.find((b) => b.id === BOARD)!;
    expect(mine.seatedOn).toBe('bb1');
    expect(mine.scale).toBeCloseTo(seated.scale!, 9);
    expect(mine.rotation).toBe(seated.rotation);
    expect(typeof computeProjectStateHash()).toBe('string');
  });
});

describe('a seated board is wired through its strips', () => {
  /** A user wire from an LED pin to a FREE hole of the strip a board pad sits in. */
  function ledOnStripOf(padName: string) {
    const seat = seatWires().find((w) => w.start.pinName === padName)!;
    const hole = seat.end.pinName; // e.g. "21t.d"
    const m = /^(\d+)([tb])\.([a-j])$/.exec(hole)!;
    const rows = m[2] === 't' ? ['a', 'b', 'c', 'd', 'e'] : ['f', 'g', 'h', 'i', 'j'];
    const taken = boardOccupiedHoles(BB, st().boards, st().wires);
    const free = rows.map((r) => `${m[1]}${m[2]}.${r}`).find((h) => !taken.has(h))!;
    expect(free, `a free hole beside ${padName}`).toBeTruthy();
    const ledWire = {
      id: 'user-led',
      start: { componentId: 'led1', pinName: 'A', x: 0, y: 0 },
      end: { componentId: 'bb1', pinName: free, x: 0, y: 0 },
      waypoints: [],
      color: '#ff0000',
    };
    useSimulatorStore.setState({
      components: [...st().components, { id: 'led1', metadataId: 'led', x: 0, y: 0, properties: {} }],
      wires: [...st().wires, ledWire],
    });
  }

  it('the digital trace resolves the LED to the pad GPIO', async () => {
    const { traceBoardGpio } = await import('../simulation/PinTrace');
    const { boardPinToNumber } = await import('../utils/boardPinMapping');
    dragOnAndDrop();
    ledOnStripOf('D2');
    const gpio = traceBoardGpio(st(), 'led1', 'A', BOARD);
    expect(gpio).not.toBeNull();
    expect(gpio).toBe(boardPinToNumber(KIND, 'D2'));
  });

  it('the SPICE netlist puts the LED pin and the pad on one net', async () => {
    const { buildNetlist } = await import('../simulation/spice/NetlistBuilder');
    dragOnAndDrop();
    ledOnStripOf('D2');
    const { pinNetMap } = buildNetlist({
      components: st().components.map((c) => ({ id: c.id, metadataId: c.metadataId, properties: c.properties ?? {} })),
      wires: st().wires.map((w) => ({ id: w.id, start: w.start, end: w.end })),
      boards: [{ id: BOARD, boardKind: KIND, vcc: 3.3, pins: {}, groundPinNames: ['GND'], vccPinNames: ['3V3'] }],
      analysis: { kind: 'op' },
    } as never);
    const ledNet = pinNetMap.get('led1:A');
    expect(ledNet).toBeTruthy();
    expect(pinNetMap.get(`${BOARD}:D2`)).toBe(ledNet);
  });
});

describe('custom chips see a seated board through the strips', () => {
  it('a chip plugged into the strip of a board pad belongs to that board', async () => {
    const chipNets = await import('../simulation/customChips/chipNets');
    chipNets.resetChipNetIndexForTest();
    dragOnAndDrop();
    const seat = seatWires().find((w) => w.start.pinName === 'D2')!;
    const m = /^(\d+)([tb])\.([a-j])$/.exec(seat.end.pinName)!;
    const rows = m[2] === 't' ? ['a', 'b', 'c', 'd', 'e'] : ['f', 'g', 'h', 'i', 'j'];
    const taken = boardOccupiedHoles(BB, st().boards, st().wires);
    const free = rows.map((r) => `${m[1]}${m[2]}.${r}`).find((h) => !taken.has(h))!;
    const state = {
      boards: st().boards,
      components: [...st().components, { id: 'custom_chip_1', metadataId: 'custom-chip' }],
      wires: [
        ...st().wires,
        {
          start: { componentId: 'custom_chip_1', pinName: 'IN' },
          end: { componentId: 'bb1', pinName: free },
        },
      ],
    };
    expect(chipNets.resolveChipOwnerBoardId(state, 'custom_chip_1')).toBe(BOARD);
  });
});

// ── Review fixes (adversarial review of stage 1, 2026-11-18) ────────────────

/** Re-mount the board element as another kind and start from a clean canvas. */
function useKind(kind: string, over: Partial<BoardInstance> = {}) {
  mountBoard(BOARD, kind);
  useSimulatorStore.setState({
    boards: [board({ boardKind: kind as BoardInstance['boardKind'], ...over })],
    components: [{ ...BB, properties: {} }],
    wires: [],
    history: [],
    historyIndex: -1,
  } as never);
}

/** Seat by dragging the board's centre over a hole, the way a user does. */
function seatByDrag(kind: string, hole = '30t.e') {
  const at = holeWorld(BB, hole)!;
  const size = boardSize(kind);
  st().dragBoardTo(BOARD, at.x - size.w / 2 + 3, at.y - size.h / 2 + 2);
  st().endBoardDrag(BOARD);
}

const holesOf = () =>
  new Map(seatWires().map((w) => [w.start.pinName, w.end.pinName]));

describe('a nudge never flips a seated board end for end', () => {
  const KINDS = ['xiao-esp32-c3', 'esp32-c3', 'esp32-cam', 'esp32'];
  const NUDGES: Array<[number, number]> = [
    [1, 0], [3, 0], [0, 3], [5, 0], [-5, 0], [4, 4], [-4, -4], [6, 2], [0, -6],
  ];
  it.each(KINDS)('%s keeps its rotation on small drags', (kind) => {
    for (const [dx, dy] of NUDGES) {
      useKind(kind);
      seatByDrag(kind);
      const before = theBoard();
      expect(before.seatedOn, `${kind} seated`).toBe('bb1');
      st().dragBoardTo(BOARD, before.x + dx, before.y + dy);
      st().endBoardDrag(BOARD);
      const after = theBoard();
      expect(after.rotation, `${kind} nudged (${dx},${dy})`).toBe(before.rotation);
      expect(after.seatedOn).toBe('bb1');
    }
  });

  it('a press that never begins a drag changes nothing (the canvas dead zone)', () => {
    seatByDrag(KIND);
    const before = theBoard();
    const wires = st().wires;
    // The canvas calls nothing until the pointer leaves its dead zone; a
    // stray end or cancel with no gesture is a no-op.
    st().endBoardDrag(BOARD);
    st().cancelBoardDrag(BOARD);
    expect(theBoard()).toBe(before);
    expect(st().wires).toBe(wires);
  });
});

describe('a cancelled gesture is not a drag', () => {
  it('an unseated board lying over a breadboard: a cancelled drag seats nothing', () => {
    const at = centredOver('30t.e');
    useSimulatorStore.setState({ boards: [board({ x: at.x, y: at.y })] });
    const before = theBoard();
    st().beginBoardDrag(BOARD);
    st().dragBoardTo(BOARD, at.x + 7, at.y + 1); // previews a seat
    expect(theBoard().scale).toBeDefined();
    st().cancelBoardDrag(BOARD);
    const after = theBoard();
    expect(after).toMatchObject({ x: before.x, y: before.y });
    expect(after.seatedOn).toBeUndefined();
    expect(after.scale).toBeUndefined();
    expect(after.rotation).toBe(before.rotation);
    expect(seatWires()).toHaveLength(0);
  });

  it('a cancelled drag of a seated board leaves its seat exactly as it was', () => {
    dragOnAndDrop();
    const before = theBoard();
    const wires = st().wires;
    st().beginBoardDrag(BOARD);
    st().dragBoardTo(BOARD, before.x + 200, before.y + 300);
    st().cancelBoardDrag(BOARD);
    expect(theBoard()).toMatchObject({
      x: before.x,
      y: before.y,
      rotation: before.rotation,
      scale: before.scale,
      seatedOn: 'bb1',
    });
    const seat = (ws: typeof wires) =>
      ws.filter((w) => w.bb).map((w) => `${w.id}:${w.start.pinName}>${w.end.pinName}`).sort();
    expect(seat(st().wires)).toEqual(seat(wires));
  });

  it('a cancel after the breadboard vanished mid-drag does not bring back the seat scale', () => {
    dragOnAndDrop();
    st().beginBoardDrag(BOARD);
    st().dragBoardTo(BOARD, theBoard().x + 40, theBoard().y);
    st().removeComponent('bb1'); // the agent, a bulk replace...
    st().cancelBoardDrag(BOARD);
    expect(theBoard().seatedOn).toBeUndefined();
    expect(theBoard().scale).toBeUndefined();
  });

  it('beginBoardDrag replaces whatever a lost gesture left behind', () => {
    st().dragBoardTo(BOARD, 1300, 900); // a gesture whose end never arrived
    st().beginBoardDrag(BOARD); // a new press
    st().dragBoardTo(BOARD, 1310, 900);
    st().cancelBoardDrag(BOARD);
    expect(theBoard()).toMatchObject({ x: 1300, y: 900 }); // this press's start
  });
});

describe('R and the drag', () => {
  it('R mid-drag sticks on a board that cannot seat', () => {
    mountFake(BOARD, [{ name: 'PB0', x: 10, y: 10 }]);
    useSimulatorStore.setState({ boards: [board({ boardKind: 'attiny85' as never })] });
    st().dragBoardTo(BOARD, 1300, 900);
    st().rotateBoard(BOARD);
    st().dragBoardTo(BOARD, 1320, 910);
    expect(theBoard().rotation).toBe(90);
    st().endBoardDrag(BOARD);
    expect(theBoard().rotation).toBe(90);
  });

  it('R mid-drag off the breadboard sticks on a seatable board too', () => {
    st().dragBoardTo(BOARD, 1300, 900);
    st().rotateBoard(BOARD);
    st().dragBoardTo(BOARD, 1320, 910);
    expect(theBoard().rotation).toBe(90);
  });

  it('R on a seated board flips it in place, on the same holes, for an off-centre header', () => {
    for (const kind of ['esp32-cam', 'xiao-esp32-c3']) {
      useKind(kind);
      seatByDrag(kind);
      const r0 = theBoard().rotation!;
      const holes = new Set(holesOf().values());
      st().rotateBoard(BOARD);
      expect(theBoard().rotation, kind).toBe((r0 + 180) % 360);
      expect(new Set(holesOf().values()), `${kind} reuses its holes`).toEqual(holes);
    }
  });

  it('R does not re-plug a running seated board', () => {
    dragOnAndDrop();
    const before = theBoard();
    useSimulatorStore.setState({ boards: [{ ...before, running: true }] });
    st().rotateBoard(BOARD);
    expect(theBoard().rotation).toBe(before.rotation);
  });
});

describe('anchors, occupancy and failed drops', () => {
  it('an anchor with two breadboards and no bbId is refused', () => {
    useSimulatorStore.setState({
      components: [{ ...BB, properties: {} }, { ...BB, id: 'bb2', x: 0, y: 400, properties: {} }],
    });
    mountFake('bb2', BREADBOARD_PINS);
    const pad = readBoardHeader(BOARD)!.pads[0].name;
    expect(st().seatBoardOnBreadboard(BOARD, { anchorPin: pad, anchorHole: '20t.d' })).toBe(false);
    expect(st().seatBoardOnBreadboard(BOARD, { bbId: 'bb2', anchorPin: pad, anchorHole: '20t.d', rotation: 90 })).toBe(true);
    expect(theBoard().seatedOn).toBe('bb2');
  });

  it("a jumper from the board's own pin keeps its hole: no pad is seated into it", () => {
    // Seat once with nothing around to learn a hole this drop would use.
    dragOnAndDrop('31t.e');
    const taken = seatWires().find((w) => w.start.pinName !== 'D0')!.end.pinName;
    // Start over, unseated, with a jumper from D0 into exactly that hole.
    useSimulatorStore.setState({
      boards: [board()],
      wires: [
        {
          id: 'own-jumper',
          start: { componentId: BOARD, pinName: 'D0', x: 0, y: 0 },
          end: { componentId: 'bb1', pinName: taken, x: 0, y: 0 },
          waypoints: [],
          color: '#00ff00',
        },
      ],
    });
    dragOnAndDrop('31t.e');
    expect(theBoard().seatedOn).toBe('bb1');
    expect(seatWires().some((w) => w.end.pinName === taken)).toBe(false);
    expect(st().wires.some((w) => w.id === 'own-jumper')).toBe(true);
  });

  it('a drop on a breadboard that vanished mid-drag leaves the board unseated, unscaled, unturned', () => {
    const p = centredOver('30t.e');
    st().dragBoardTo(BOARD, p.x, p.y);
    expect(theBoard().scale).toBeDefined();
    useSimulatorStore.setState({ components: [] });
    st().endBoardDrag(BOARD);
    const b = theBoard();
    expect(b.seatedOn).toBeUndefined();
    expect(b.scale).toBeUndefined();
    expect(b.rotation).toBe(0);
  });
});

describe('undo and redo around a seated board', () => {
  it('undo of a breadboard move takes the board back with it; redo carries it again', () => {
    dragOnAndDrop();
    const seated = theBoard();
    st().updateComponent('bb1', { x: 300, y: 200 });
    st().recordMove('bb1', { x: 0, y: 0 }, { x: 300, y: 200 });
    expect(theBoard().x).toBeCloseTo(seated.x + 300, 6);
    st().undo();
    expect(theBoard().x).toBeCloseTo(seated.x, 6);
    expect(theBoard().y).toBeCloseTo(seated.y, 6);
    expect(theBoard().seatedOn).toBe('bb1');
    st().redo();
    expect(theBoard().x).toBeCloseTo(seated.x + 300, 6);
  });

  it('undo of a breadboard delete does not seat a board that has moved since', () => {
    dragOnAndDrop();
    st().recordRemoveComponent('bb1');
    st().dragBoardTo(BOARD, 1500, 1500);
    st().endBoardDrag(BOARD);
    st().undo();
    expect(theBoard().seatedOn).toBeUndefined();
    expect(seatWires()).toHaveLength(0);
  });

  it('undo of adding a breadboard unseats the board plugged into it since', () => {
    useSimulatorStore.setState({ components: [] });
    st().recordAddComponent({ ...BB, properties: {} });
    dragOnAndDrop();
    expect(theBoard().seatedOn).toBe('bb1');
    st().undo();
    expect(theBoard().seatedOn).toBeUndefined();
    expect(theBoard().scale).toBeUndefined();
  });

  it('redo of a breadboard turn unseats the board', () => {
    st().updateComponent('bb1', { properties: { rotation: 90 } });
    st().recordRotate('bb1', 0, 90);
    st().undo();
    dragOnAndDrop();
    expect(theBoard().seatedOn).toBe('bb1');
    st().redo();
    expect(theBoard().seatedOn).toBeUndefined();
  });

  it('a bulk replace of the components without the breadboard unseats the board', () => {
    dragOnAndDrop();
    st().setComponents([]);
    expect(theBoard().seatedOn).toBeUndefined();
    expect(theBoard().scale).toBeUndefined();
  });
});

describe('a gesture that never ended does not poison the next drag', () => {
  it('a board changed by something else since is dragged as a fresh gesture', () => {
    // A drag that never got its end (a lost pointer event).
    st().dragBoardTo(BOARD, 1300, 900);
    st().rotateBoard(BOARD); // pose now rotation 90, remembered by the gesture
    // Something else moves and turns the board (an undo, the agent).
    useSimulatorStore.setState({ boards: [board({ x: 50, y: 60, rotation: 180 })] });
    // A new drag: fresh start pose, so a cancel puts back THIS pose.
    st().dragBoardTo(BOARD, 400, 300);
    st().cancelBoardDrag(BOARD);
    expect(theBoard()).toMatchObject({ x: 50, y: 60, rotation: 180 });
  });
});

describe('second review round', () => {
  it('redo of a breadboard delete leaves a board seated on another breadboard alone', () => {
    useSimulatorStore.setState({
      components: [{ ...BB, properties: {} }, { ...BB, id: 'bb2', x: 0, y: 400, properties: {} }],
    });
    mountFake('bb2', BREADBOARD_PINS);
    dragOnAndDrop(); // on bb1
    st().recordRemoveComponent('bb1');
    // Onto bb2 (a seat is not in history, so the redo stack survives).
    const at = holeWorld({ ...BB, id: 'bb2', y: 400 }, '30t.e')!;
    const size = boardSize(KIND);
    st().dragBoardTo(BOARD, at.x - size.w / 2 + 3, at.y - size.h / 2 + 2);
    st().endBoardDrag(BOARD);
    expect(theBoard().seatedOn).toBe('bb2');
    const onBb2 = seatWires().length;
    st().undo(); // bb1 back; the board stays on bb2
    expect(theBoard().seatedOn).toBe('bb2');
    st().redo(); // bb1 goes again; the board must stay on bb2, seat intact
    expect(theBoard().seatedOn).toBe('bb2');
    expect(seatWires()).toHaveLength(onBb2);
    expect(seatWires().every((w) => w.end.componentId === 'bb2')).toBe(true);
  });

  it('redo of a breadboard delete unseats a board seated on it between undo and redo', () => {
    st().recordRemoveComponent('bb1');
    st().undo();
    dragOnAndDrop();
    expect(theBoard().seatedOn).toBe('bb1');
    st().redo();
    expect(theBoard().seatedOn).toBeUndefined();
    expect(theBoard().scale).toBeUndefined();
    expect(seatWires()).toHaveLength(0);
  });

  it('R mid-drag on a board pulled off its breadboard turns it a quarter, and it sticks', () => {
    dragOnAndDrop();
    const r0 = theBoard().rotation!;
    st().beginBoardDrag(BOARD);
    st().dragBoardTo(BOARD, 1500, 1200);
    st().rotateBoard(BOARD);
    expect(theBoard().rotation).toBe((r0 + 90) % 360);
    st().dragBoardTo(BOARD, 1520, 1210);
    st().endBoardDrag(BOARD);
    expect(theBoard().rotation).toBe((r0 + 90) % 360);
    expect(theBoard().seatedOn).toBeUndefined();
  });

  it('after R in a preview, the same pointer keeps the flipped seat in place', () => {
    for (const kind of ['esp32-cam', 'esp32', 'xiao-esp32-c3']) {
      useKind(kind);
      const at = holeWorld(BB, '30t.e')!;
      const size = boardSize(kind);
      const p = { x: at.x - size.w / 2 + 3, y: at.y - size.h / 2 + 2 };
      st().beginBoardDrag(BOARD);
      st().dragBoardTo(BOARD, p.x, p.y);
      st().rotateBoard(BOARD);
      const flipped = theBoard();
      st().dragBoardTo(BOARD, p.x + 1, p.y); // a pixel of movement
      expect(theBoard().x, kind).toBeCloseTo(flipped.x, 6);
      expect(theBoard().rotation, kind).toBe(flipped.rotation);
      st().dragBoardTo(BOARD, p.x + 12, p.y); // a real move keeps the flip
      expect(theBoard().rotation, kind).toBe(flipped.rotation);
      st().endBoardDrag(BOARD);
      expect(theBoard().rotation, kind).toBe(flipped.rotation);
    }
  });

  it('while a simulation runs, nothing re-plugs a board', () => {
    dragOnAndDrop();
    const seated = theBoard();
    useSimulatorStore.setState({ boards: [{ ...seated, running: true }] });
    const r0 = seated.rotation;
    st().rotateBoard(BOARD);
    expect(theBoard().rotation).toBe(r0);
    st().unseatBoard(BOARD);
    expect(theBoard().seatedOn).toBe('bb1');
    // A gesture on a running board only moves it; the drop changes no seat.
    st().beginBoardDrag(BOARD);
    st().dragBoardTo(BOARD, 1500, 1200);
    st().endBoardDrag(BOARD);
    expect(theBoard().seatedOn).toBe('bb1');
    // And an unseated running board is never plugged in.
    useSimulatorStore.setState({ boards: [board({ running: true })], wires: [] });
    expect(st().seatBoardOnBreadboard(BOARD, { bbId: 'bb1' })).toBe(false);
    const p = centredOver('30t.e');
    st().beginBoardDrag(BOARD);
    st().dragBoardTo(BOARD, p.x, p.y);
    st().endBoardDrag(BOARD);
    expect(theBoard().seatedOn).toBeUndefined();
    expect(seatWires()).toHaveLength(0);
  });

  it('a save whose breadboard is missing loads the board unseated and drops its seat wires', () => {
    dragOnAndDrop();
    const saved = JSON.parse(buildSavePayload().boards_json ?? '[]') as BoardInstance[];
    const wires = st().wires;
    st().loadProjectState({
      boards: saved.map((b) => ({ ...b, running: false })) as BoardInstance[],
      fileGroups: {},
      components: [], // the breadboard is gone from the save
      wires,
      activeBoardId: BOARD,
    });
    const b = st().boards.find((x) => x.id === BOARD)!;
    expect(b.seatedOn).toBeUndefined();
    expect(st().wires.filter((w) => w.bb && w.start.componentId === BOARD)).toHaveLength(0);
  });
});

describe('third review round', () => {
  it('a running seated board carried by its breadboard stays on its holes at the drop and on cancel', () => {
    for (const ending of ['end', 'cancel'] as const) {
      useKind(KIND);
      seatByDrag(KIND);
      const seated = theBoard();
      useSimulatorStore.setState({ boards: [{ ...seated, running: true }] });
      st().beginBoardDrag(BOARD);
      // The canvas carries a running seated board by moving its breadboard.
      for (let i = 1; i <= 10; i++) st().updateComponent('bb1', { x: 20 * i, y: 10 * i });
      st().rotateBoard(BOARD); // R mid-carry does nothing to a running seated board
      if (ending === 'end') st().endBoardDrag(BOARD);
      else st().cancelBoardDrag(BOARD);
      const b = theBoard();
      expect(b.seatedOn, ending).toBe('bb1');
      expect(b.rotation, ending).toBe(seated.rotation);
      expect(b.x, ending).toBeCloseTo(seated.x + 200, 6);
      expect(b.y, ending).toBeCloseTo(seated.y + 100, 6);
      for (const w of seatWires()) {
        expect(Math.hypot(w.start.x - w.end.x, w.start.y - w.end.y), ending).toBeLessThanOrEqual(4);
      }
    }
  });

  it('a seated board dragged out of reach and back keeps its rotation and its holes', () => {
    // Frame by frame, as a real pointer moves: at the edge of the solver's
    // reach the half turn used to be the only seat in range, and the board
    // came back flipped end for end (esp32 seated over 30b.f, up and back).
    for (const dist of [77, 85, 120, 200]) {
      useKind('esp32');
      seatByDrag('esp32', '30b.f');
      const seated = theBoard();
      const holes = holesOf();
      st().beginBoardDrag(BOARD);
      for (let d = 4; d <= dist; d += 4) st().dragBoardTo(BOARD, seated.x, seated.y - d);
      for (let d = dist; d >= 0; d -= 4) st().dragBoardTo(BOARD, seated.x, seated.y - d);
      st().endBoardDrag(BOARD);
      expect(theBoard().rotation, `${dist} px`).toBe(seated.rotation);
      expect(holesOf(), `${dist} px`).toEqual(holes);
    }
  });

  it('after R in a preview, the board is under the pointer again once it leaves the breadboard', () => {
    useKind('esp32-cam');
    const at = holeWorld(BB, '30t.e')!;
    const size = boardSize('esp32-cam');
    st().beginBoardDrag(BOARD);
    st().dragBoardTo(BOARD, at.x - size.w / 2, at.y - size.h / 2);
    st().rotateBoard(BOARD);
    st().dragBoardTo(BOARD, 3000, 2000);
    expect(theBoard()).toMatchObject({ x: 3000, y: 2000 });
    st().endBoardDrag(BOARD);
    expect(theBoard()).toMatchObject({ x: 3000, y: 2000 });
  });

  it("a Wokwi import's plugged board is moved, never re-seated over its imported pins", () => {
    const at = centredOver('30t.e');
    const imported = [
      { id: 'wk-1', start: { componentId: BOARD, pinName: 'D0', x: 0, y: 0 }, end: { componentId: 'bb1', pinName: '19b.j', x: 0, y: 0 }, waypoints: [], color: '', bb: true },
      { id: 'wk-2', start: { componentId: BOARD, pinName: 'D1', x: 0, y: 0 }, end: { componentId: 'bb1', pinName: '20b.j', x: 0, y: 0 }, waypoints: [], color: '', bb: true },
    ];
    useSimulatorStore.setState({ boards: [board({ x: at.x, y: at.y })], wires: imported });
    st().beginBoardDrag(BOARD);
    st().dragBoardTo(BOARD, at.x + 8, at.y);
    st().endBoardDrag(BOARD);
    expect(theBoard().seatedOn).toBeUndefined();
    expect(theBoard().scale).toBeUndefined();
    expect(theBoard()).toMatchObject({ x: at.x + 8, y: at.y });
    expect(st().wires.map((w) => w.id).sort()).toEqual(['wk-1', 'wk-2']);
    expect(st().seatBoardOnBreadboard(BOARD, { bbId: 'bb1' })).toBe(false);
  });

  it('moving a seated board outside a gesture takes it off the breadboard; not while running', () => {
    dragOnAndDrop();
    const seated = theBoard();
    useSimulatorStore.setState({ boards: [{ ...seated, running: true }] });
    st().setBoardPosition({ x: 1500, y: 1200 }, BOARD); // the agent's move_board
    expect(theBoard()).toMatchObject({ x: seated.x, y: seated.y, seatedOn: 'bb1' });
    useSimulatorStore.setState({ boards: [{ ...seated, running: false }] });
    st().setBoardPosition({ x: 1500, y: 1200 }, BOARD);
    expect(theBoard()).toMatchObject({ x: 1500, y: 1200 });
    expect(theBoard().seatedOn).toBeUndefined();
    expect(theBoard().scale).toBeUndefined();
    expect(seatWires()).toHaveLength(0);
  });

  it('updateBoard that moves a seated board unseats it; other fields leave the seat alone', () => {
    dragOnAndDrop();
    st().updateBoard(BOARD, { libraries: ['DHT sensor library'] });
    expect(theBoard().seatedOn).toBe('bb1');
    st().updateBoard(BOARD, { x: theBoard().x + 40 });
    expect(theBoard().seatedOn).toBeUndefined();
    expect(seatWires()).toHaveLength(0);
  });

  it('the load repair re-checks a seat whose board was moved off its holes, and leaves a sound one alone', () => {
    dragOnAndDrop();
    const wires = st().wires;
    st().repairBoardSeat(BOARD);
    expect(st().wires).toBe(wires); // sound: untouched
    // Something wrote the position behind the store's back.
    useSimulatorStore.setState({ boards: [{ ...theBoard(), x: theBoard().x + 300 }] });
    st().repairBoardSeat(BOARD);
    const b = theBoard();
    // Too far to re-seat where it is: it comes off, seat wires gone.
    expect(b.seatedOn).toBeUndefined();
    expect(seatWires()).toHaveLength(0);
  });

  it('an STM32 pill with repeated pad names is a sound seat for the repair (no churn)', () => {
    document.getElementById(BOARD)?.remove();
    const el = document.createElement('velxio-stm32-bluepill');
    el.id = BOARD;
    document.body.appendChild(el);
    useSimulatorStore.setState({
      boards: [board({ boardKind: 'stm32-bluepill' as never })],
      components: [{ ...BB, properties: {} }],
      wires: [],
    });
    seatByDrag('stm32-bluepill');
    expect(theBoard().seatedOn).toBe('bb1');
    const wires = st().wires;
    st().repairBoardSeat(BOARD);
    expect(st().wires).toBe(wires);
  });
});

describe('final review round', () => {
  it('a carried running board keeps its seat if the run stops before the drop', () => {
    dragOnAndDrop();
    const seated = theBoard();
    useSimulatorStore.setState({ boards: [{ ...seated, running: true }] });
    st().beginBoardDrag(BOARD);
    for (let i = 1; i <= 5; i++) st().updateComponent('bb1', { x: 10 * i, y: 4 * i });
    useSimulatorStore.setState({ boards: [{ ...theBoard(), running: false }] });
    st().endBoardDrag(BOARD);
    expect(theBoard().seatedOn).toBe('bb1');
    expect(theBoard().x).toBeCloseTo(seated.x + 50, 6);
    for (const w of seatWires()) {
      expect(Math.hypot(w.start.x - w.end.x, w.start.y - w.end.y)).toBeLessThanOrEqual(4);
    }
  });

  it('a move the canvas makes mid-drag (the socket magnet) is the gesture\'s own: a cancel restores the true start', () => {
    const before = theBoard();
    st().beginBoardDrag(BOARD);
    st().dragBoardTo(BOARD, 1300, 900);
    st().moveBoardInDrag(BOARD, { x: 1400, y: 950 }); // snapped into a socket
    st().dragBoardTo(BOARD, 1420, 960); // the pointer moves on
    st().cancelBoardDrag(BOARD);
    expect(theBoard()).toMatchObject({ x: before.x, y: before.y });
  });

  it('a seated board moved behind the gesture\'s back comes off its holes when the drag goes on', () => {
    dragOnAndDrop();
    st().beginBoardDrag(BOARD);
    st().dragBoardTo(BOARD, theBoard().x + 6, theBoard().y); // previewing nearby
    // Something writes the pose directly, far from the breadboard.
    useSimulatorStore.setState({ boards: [{ ...theBoard(), x: 1500, y: 1200 }] });
    st().dragBoardTo(BOARD, 1510, 1210);
    expect(theBoard().seatedOn).toBeUndefined();
    expect(seatWires()).toHaveLength(0);
    st().cancelBoardDrag(BOARD);
    expect(theBoard().seatedOn).toBeUndefined();
  });

  it('the repair rebuilds a seat that lost one wire, or whose board was turned half round behind the store', () => {
    dragOnAndDrop();
    const n = seatWires().length;
    useSimulatorStore.setState({ wires: st().wires.filter((w) => w.id !== seatWires()[0].id) });
    st().repairBoardSeat(BOARD);
    expect(seatWires()).toHaveLength(n);
    // Half a turn written behind the store: same holes, other pads on them.
    const r = theBoard().rotation!;
    useSimulatorStore.setState({ boards: [{ ...theBoard(), rotation: (r + 180) % 360 }] });
    st().repairBoardSeat(BOARD);
    const b = theBoard();
    if (b.seatedOn) {
      for (const w of seatWires()) {
        expect(Math.hypot(w.start.x - w.end.x, w.start.y - w.end.y)).toBeLessThanOrEqual(4);
      }
    } else {
      expect(seatWires()).toHaveLength(0);
    }
  });
});

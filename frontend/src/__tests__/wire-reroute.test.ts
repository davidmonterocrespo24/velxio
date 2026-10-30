// @vitest-environment jsdom
/**
 * System-owned wire shapes (`autoRouted`): created by the router, re-routed
 * by recalculateAllWirePositions when endpoints move, and demoted to
 * hand-authored the moment the user edits them. Manual wires must never be
 * re-shaped.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useSimulatorStore, keepWireShapes } from '../store/useSimulatorStore';
import { expandOrthogonalPoints } from '../utils/wireUtils';
import { WIRE_SEPARATION } from '../utils/wireAutoRoute';

const PIN = [{ name: 'P', x: 0, y: 0, signals: [] }];

function mountComponent(id: string, w = 40, h = 12): void {
  document.getElementById(id)?.remove();
  document
    .querySelector(`.dynamic-component-wrapper[data-component-id="${id}"]`)
    ?.remove();
  const wrapper = document.createElement('div');
  wrapper.className = 'dynamic-component-wrapper';
  wrapper.setAttribute('data-component-id', id);
  Object.defineProperty(wrapper, 'offsetWidth', { value: w, configurable: true });
  Object.defineProperty(wrapper, 'offsetHeight', { value: h, configurable: true });
  const el = document.createElement('div');
  el.id = id;
  (el as unknown as { pinInfo: unknown }).pinInfo = PIN;
  wrapper.appendChild(el);
  document.body.appendChild(wrapper);
}

function wireBetween(
  id: string,
  fromId: string,
  toId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    start: { componentId: fromId, pinName: 'P', x: 0, y: 0 },
    end: { componentId: toId, pinName: 'P', x: 0, y: 0 },
    waypoints: [],
    color: '#000',
    ...extra,
  };
}

/** Total parallel-overlap px between two rendered wires (corridor < separation). */
function overlapPx(w1: { start: never; end: never; waypoints: never }, w2: typeof w1): number {
  const pts = (w: typeof w1) =>
    expandOrthogonalPoints([
      { x: (w.start as { x: number }).x, y: (w.start as { y: number }).y },
      ...((w.waypoints as { x: number; y: number }[]) ?? []),
      { x: (w.end as { x: number }).x, y: (w.end as { y: number }).y },
    ]);
  const p1 = pts(w1);
  const p2 = pts(w2);
  let total = 0;
  for (let i = 1; i < p1.length; i++) {
    for (let j = 1; j < p2.length; j++) {
      const a1 = p1[i - 1]; const b1 = p1[i];
      const a2 = p2[j - 1]; const b2 = p2[j];
      const h1 = a1.y === b1.y; const h2 = a2.y === b2.y;
      if (h1 !== h2) continue;
      const gap = h1 ? Math.abs(a1.y - a2.y) : Math.abs(a1.x - a2.x);
      if (gap >= WIRE_SEPARATION) continue;
      const lo = h1
        ? Math.max(Math.min(a1.x, b1.x), Math.min(a2.x, b2.x))
        : Math.max(Math.min(a1.y, b1.y), Math.min(a2.y, b2.y));
      const hi = h1
        ? Math.min(Math.max(a1.x, b1.x), Math.max(a2.x, b2.x))
        : Math.min(Math.max(a1.y, b1.y), Math.max(a2.y, b2.y));
      total += Math.max(0, hi - lo);
    }
  }
  return total;
}

describe('recalculateAllWirePositions — auto-route pass', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    const s = useSimulatorStore.getState();
    s.setComponents([
      { id: 'a1', metadataId: 'resistor', x: 0, y: 94, properties: {} },
      { id: 'a2', metadataId: 'resistor', x: 294, y: 94, properties: {} },
      { id: 'b1', metadataId: 'resistor', x: 0, y: 90, properties: {} },
      { id: 'b2', metadataId: 'resistor', x: 294, y: 90, properties: {} },
    ] as never);
    for (const id of ['a1', 'a2', 'b1', 'b2']) mountComponent(id);
    s.setWires([]);
  });

  it('separates two parallel autoRouted wires into side-by-side lanes', () => {
    const s = useSimulatorStore.getState();
    s.setWires([
      wireBetween('w1', 'a1', 'a2', { autoRouted: true }),
      wireBetween('w2', 'b1', 'b2', { autoRouted: true }),
    ] as never);
    s.recalculateAllWirePositions();
    const [w1, w2] = useSimulatorStore.getState().wires;
    // Their natural straight lines sit 4px apart — inside the corridor.
    // After the pass they must not ride each other.
    expect(overlapPx(w1 as never, w2 as never)).toBe(0);
  });

  it('never touches a hand-authored wire', () => {
    const s = useSimulatorStore.getState();
    const manualWaypoints = [{ x: 150, y: 400 }]; // deliberate detour
    s.setWires([
      wireBetween('auto', 'a1', 'a2', { autoRouted: true }),
      wireBetween('manual', 'b1', 'b2', { waypoints: manualWaypoints }),
    ] as never);
    s.recalculateAllWirePositions();
    const manual = useSimulatorStore.getState().wires.find((w) => w.id === 'manual')!;
    expect(manual.waypoints).toEqual(manualWaypoints);
    expect(manual.autoRouted).toBeUndefined();
  });

  it('routes an agent wire (empty waypoints) around a component in the way', () => {
    const s = useSimulatorStore.getState();
    // A tall component square in the middle of the a1->a2 line.
    s.setComponents([
      ...useSimulatorStore.getState().components,
      { id: 'blocker', metadataId: 'chip', x: 120, y: 40, properties: {} },
    ] as never);
    mountComponent('blocker', 60, 120); // spans y 40..160 — covers y=100
    s.setWires([wireBetween('agentw', 'a1', 'a2', { autoRouted: true })] as never);
    s.recalculateAllWirePositions();
    const w = useSimulatorStore.getState().wires[0];
    // Must have gained waypoints that detour around the blocker.
    expect(w.waypoints.length).toBeGreaterThan(0);
    const pts = expandOrthogonalPoints([
      { x: w.start.x, y: w.start.y },
      ...w.waypoints,
      { x: w.end.x, y: w.end.y },
    ]);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]; const b = pts[i];
      if (a.y === b.y) {
        const inside = a.y > 40 - 8 && a.y < 160 + 8
          && Math.max(a.x, b.x) > 120 - 8 && Math.min(a.x, b.x) < 180 + 8;
        expect(inside, `segment y=${a.y} crosses the blocker`).toBe(false);
      }
    }
  });

  it('a pass with nothing moved keeps the stored routes; a move routes again', () => {
    const s = useSimulatorStore.getState();
    s.setWires([
      wireBetween('w1', 'a1', 'a2', { autoRouted: true }),
      wireBetween('w2', 'b1', 'b2', { autoRouted: true }),
    ] as never);
    s.recalculateAllWirePositions();
    const first = useSimulatorStore.getState().wires;
    // Every part calls this on mount: a repeat with the same inputs must not
    // run the router again (a 71-part project froze the page for 47 s).
    s.recalculateAllWirePositions();
    expect(useSimulatorStore.getState().wires).toBe(first);
    s.updateComponent('a2', { y: 300 } as never);
    s.recalculateAllWirePositions();
    const moved = useSimulatorStore.getState().wires;
    expect(moved).not.toBe(first);
    expect(moved.find((w) => w.id === 'w1')!.end.y).not.toBe(
      first.find((w) => w.id === 'w1')!.end.y,
    );
  });

  it('a pass depends only on the parts and endpoints, not on leftover shapes', () => {
    const s = useSimulatorStore.getState();
    // w2 runs far below w1 (y ~ 300), so the two never compete for a lane.
    s.setComponents([
      ...useSimulatorStore.getState().components,
      { id: 'c1', metadataId: 'resistor', x: 0, y: 294, properties: {} },
      { id: 'c2', metadataId: 'resistor', x: 294, y: 294, properties: {} },
    ] as never);
    mountComponent('c1'); mountComponent('c2');
    const route = (w2Waypoints: { x: number; y: number }[]) => {
      s.setWires([
        wireBetween('w1', 'a1', 'a2', { autoRouted: true }),
        wireBetween('w2', 'c1', 'c2', { autoRouted: true, waypoints: w2Waypoints }),
      ] as never);
      s.recalculateAllWirePositions();
      return useSimulatorStore.getState().wires.map((w) => w.waypoints);
    };
    const clean = route([]);
    // w2 still carries a detour from an earlier pass that rides right on top
    // of w1's lane (y = 110, just under the parts). w1 is routed first and
    // must not bend around a shape this very pass is about to replace.
    const leftover = route([
      { x: 40, y: 300 }, { x: 40, y: 110 }, { x: 260, y: 110 }, { x: 260, y: 300 },
    ]);
    expect(leftover).toEqual(clean);
  });

  it('running the pass again on its own output changes nothing', () => {
    const s = useSimulatorStore.getState();
    s.setWires([
      wireBetween('w1', 'a1', 'a2', { autoRouted: true }),
      wireBetween('w2', 'b1', 'b2', { autoRouted: true }),
    ] as never);
    s.recalculateAllWirePositions();
    const once = useSimulatorStore.getState().wires.map((w) => w.waypoints);
    // A fresh array defeats the no-op memo, so the router really runs again.
    s.setWires(useSimulatorStore.getState().wires.map((w) => ({ ...w })) as never);
    s.recalculateAllWirePositions();
    expect(useSimulatorStore.getState().wires.map((w) => w.waypoints)).toEqual(once);
  });

  it('a loaded project keeps its saved shapes; moving a part re-routes only its wires', () => {
    const s = useSimulatorStore.getState();
    s.setComponents([
      ...useSimulatorStore.getState().components,
      { id: 'blocker', metadataId: 'chip', x: 120, y: 40, properties: {} },
      { id: 'c1', metadataId: 'resistor', x: 0, y: 294, properties: {} },
      { id: 'c2', metadataId: 'resistor', x: 294, y: 294, properties: {} },
    ] as never);
    mountComponent('blocker', 60, 120); // spans y 40..160, across a1 -> a2
    mountComponent('c1'); mountComponent('c2');
    // As saved: shapes the router would not choose today. w1 runs through
    // the blocker and its saved start is 3 px off the pin it resolves to
    // (a rotated part, an older release); w2 takes a needless detour.
    const w1Shape = [{ x: 100, y: 100 }, { x: 100, y: 130 }, { x: 200, y: 130 }, { x: 200, y: 100 }];
    const w2Shape = [{ x: 150, y: 300 }, { x: 150, y: 400 }, { x: 250, y: 400 }, { x: 250, y: 300 }];
    const saved = [
      { ...wireBetween('w1', 'a1', 'a2', { autoRouted: true, waypoints: w1Shape }),
        start: { componentId: 'a1', pinName: 'P', x: 9, y: 100 },
        end: { componentId: 'a2', pinName: 'P', x: 300, y: 100 } },
      { ...wireBetween('w2', 'c1', 'c2', { autoRouted: true, waypoints: w2Shape }),
        start: { componentId: 'c1', pinName: 'P', x: 6, y: 300 },
        end: { componentId: 'c2', pinName: 'P', x: 300, y: 300 } },
      // Saved without a shape: never routed (e.g. placed by the agent).
      { ...wireBetween('w3', 'b1', 'b2', { autoRouted: true }),
        start: { componentId: 'b1', pinName: 'P', x: 6, y: 96 },
        end: { componentId: 'b2', pinName: 'P', x: 300, y: 96 } },
    ];
    s.setWires(saved as never);
    keepWireShapes(useSimulatorStore.getState().wires);
    s.recalculateAllWirePositions();
    const loaded = useSimulatorStore.getState().wires;
    const byId = (ws: typeof loaded, id: string) => ws.find((w) => w.id === id)!;
    expect(byId(loaded, 'w1').waypoints).toEqual(w1Shape);
    expect(byId(loaded, 'w1').start.x).toBe(6); // the end follows the pin
    expect(byId(loaded, 'w2').waypoints).toEqual(w2Shape);
    expect(byId(loaded, 'w3').waypoints).not.toEqual([]); // routed around the blocker

    // Moving a2 moves only w1's end: w1 is routed again, w2 stays as saved.
    s.updateComponent('a2', { y: 194 } as never);
    s.recalculateAllWirePositions();
    const after = useSimulatorStore.getState().wires;
    expect(byId(after, 'w1').waypoints).not.toEqual(w1Shape);
    expect(byId(after, 'w2').waypoints).toEqual(w2Shape);
  });

  it('bb seating wires are never routed', () => {
    const s = useSimulatorStore.getState();
    s.setWires([
      wireBetween('seat', 'a1', 'a2', { bb: true, autoRouted: true }),
    ] as never);
    s.recalculateAllWirePositions();
    expect(useSimulatorStore.getState().wires[0].waypoints).toEqual([]);
  });
});

describe('re-route pass — null route materialises the CHECKED elbow', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    const s = useSimulatorStore.getState();
    // Diagonal pair with dy >> dx: previewElbow is vertical-first, while an
    // empty waypoints array renders horizontal-first — a DIFFERENT corner
    // the router never validated. Three live agent wires crossed a display
    // exactly this way.
    s.setComponents([
      { id: 'p1', metadataId: 'resistor', x: 300, y: 500, properties: {} },
      { id: 'p2', metadataId: 'resistor', x: 0, y: 100, properties: {} },
      // A blocker placed so ONLY the horizontal-first corner would cross it:
      // it sits left of p1 at p1's row.
      { id: 'blk', metadataId: 'chip', x: 100, y: 470, properties: {} },
    ] as never);
    mountComponent('p1'); mountComponent('p2');
    mountComponent('blk', 60, 80); // y 470..550 — covers p1's row (~506)
    s.setWires([]);
  });

  it('stores the longer-axis-first elbow instead of empty waypoints', () => {
    const s = useSimulatorStore.getState();
    s.setWires([wireBetween('w', 'p1', 'p2', { autoRouted: true })] as never);
    s.recalculateAllWirePositions();
    const w = useSimulatorStore.getState().wires[0];
    // Whatever shape came out, the RENDERED expansion must not cross blk.
    const pts = expandOrthogonalPoints([
      { x: w.start.x, y: w.start.y }, ...w.waypoints, { x: w.end.x, y: w.end.y },
    ]);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]; const b = pts[i];
      const inX = Math.max(a.x, b.x) > 100 + 4 && Math.min(a.x, b.x) < 160 - 4;
      const inY = Math.max(a.y, b.y) > 470 + 4 && Math.min(a.y, b.y) < 550 - 4;
      const aIn = a.x > 100 && a.x < 160 && a.y > 470 && a.y < 550;
      const bIn = b.x > 100 && b.x < 160 && b.y > 470 && b.y < 550;
      expect(inX && inY && !aIn && !bIn, `segment (${a.x},${a.y})->(${b.x},${b.y}) crosses blk`).toBe(false);
    }
  });
});

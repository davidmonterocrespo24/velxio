// @vitest-environment jsdom
/**
 * Scope channels belong to the circuit they were probed on
 * (velxio/velxio-prod#119).
 *
 * An analog channel stored only a positional net name (n0, n1, ... in
 * NetlistBuilder's order), and nothing reset the scope when another project
 * was opened:
 *  - after an import, a channel "n0" watched the NEW circuit's n0, another
 *    point, under the old label and with no warning;
 *  - an ordinary edit renumbers the nets: with an LED on D13 and a divider on
 *    A0, adding an LED on D2 moves the divider tap from n2 to n3, and the
 *    channel went on plotting n2, which is now the D13 LED's anode;
 *  - a net that no longer existed left its last capture on screen, frozen.
 *
 * A channel now follows the part pin it was probed at, through the pinNetMap
 * every solve publishes, and loading a project, an example or a new starter
 * empties the scope. The renumbering below is the real NetlistBuilder's, with
 * part ids in the app's own format.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useOscilloscopeStore } from '../store/useOscilloscopeStore';
import { useElectricalStore } from '../store/useElectricalStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { startAnalogScopeFeed, stopAnalogScopeFeed, analogScopeNets } from '../simulation/spice/analogScopeFeed';
import { resolveProbe } from '../simulation/probeResolve';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { loadExample } from '../utils/loadExample';
import { clearWorkspaceForStarter } from '../components/editor/NewProjectDialog';
import { exampleProjects } from '../data/examples';
import type { Wire } from '../types/wire';

type Comp = { id: string; metadataId: string; properties: Record<string, unknown> };

const wire = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  start: { componentId: a[0], pinName: a[1], x: 0, y: 0 },
  end: { componentId: b[0], pinName: b[1], x: 0, y: 0 },
  waypoints: [],
  color: '#0f0',
});

// Part ids as the canvas mints them (`${prefix}_${Date.now()}_${rand}`).
const R1 = 'resistor_1731000000000_a1b2c3d4e';
const LED1 = 'led_1731000005000_f5g6h7i8j';
const R2 = 'resistor_1731000010000_k9l8m7n6o';
const R3 = 'resistor_1731000015000_p5q4r3s2t';
const R4 = 'resistor_1731000900000_u1v2w3x4y';
const LED2 = 'led_1731000905000_z9y8x7w6v';

const BASE_PARTS: Comp[] = [
  { id: R1, metadataId: 'resistor', properties: { value: '220' } },
  { id: LED1, metadataId: 'led', properties: { color: 'red' } },
  { id: R2, metadataId: 'resistor', properties: { value: '10000' } },
  { id: R3, metadataId: 'resistor', properties: { value: '10000' } },
];
const BASE_WIRES: Wire[] = [
  wire('wire-1', ['arduino-uno', '13'], [R1, '1']),
  wire('wire-2', [R1, '2'], [LED1, 'A']),
  wire('wire-3', [LED1, 'C'], ['arduino-uno', 'GND.1']),
  wire('wire-4', ['arduino-uno', '5V'], [R2, '1']),
  wire('wire-5', [R2, '2'], [R3, '1']),
  wire('wire-6', [R3, '2'], ['arduino-uno', 'GND.2']),
  wire('wire-7', [R2, '2'], ['arduino-uno', 'A0']),
];
// A second LED on D2, added after the rest (so its ids sort last).
const LED2_PARTS: Comp[] = [
  { id: R4, metadataId: 'resistor', properties: { value: '220' } },
  { id: LED2, metadataId: 'led', properties: { color: 'green' } },
];
const LED2_WIRES: Wire[] = [
  wire('wire-8', ['arduino-uno', '2'], [R4, '1']),
  wire('wire-9', [R4, '2'], [LED2, 'A']),
  wire('wire-10', [LED2, 'C'], ['arduino-uno', 'GND.3']),
];

/** The canvas: an Uno and the parts, as the probe resolver reads them. */
function setCanvas(components: Comp[], wires: Wire[]): void {
  useSimulatorStore.setState({
    boards: [{ id: 'arduino-uno', boardKind: 'arduino-uno', x: 0, y: 0, running: false }],
    components: components.map((c) => ({ ...c, x: 0, y: 0 })),
    wires,
  } as never);
}

/** The pinNetMap the real netlist builder makes for that canvas. */
function solvedNets(components: Comp[], wires: Wire[]): Map<string, string> {
  const input = buildInputFromStore({
    components,
    wires,
    boards: [{ id: 'arduino-uno', boardKind: 'arduino-uno', pinStates: {} }],
  });
  return buildNetlist(input).pinNetMap;
}

/** Publish a solve of that canvas whose capture reads, on every net nK,
 *  K volts: what a channel plots then says which net it is watching. */
function publishSolve(pinNetMap: Map<string, string>): void {
  const nodes = new Map<string, number[]>();
  for (const net of new Set(pinNetMap.values())) {
    const m = /^n(\d+)$/.exec(net);
    if (m) nodes.set(net, [Number(m[1]), Number(m[1])]);
  }
  useElectricalStore.setState({
    pinNetMap,
    analysisMode: 'tran',
    timeWaveforms: undefined,
    scopeWaveforms: { time: [0, 0.001], nodes, branches: new Map() },
  });
}

/** Probe a wire the way the canvas's "Add to scope" does. */
function probe(wireId: string): string {
  const state = useSimulatorStore.getState();
  const w = state.wires.find((x) => x.id === wireId)!;
  const target = resolveProbe(w, { state, pinNetMap: useElectricalStore.getState().pinNetMap });
  expect(target?.kind).toBe('analog');
  if (target?.kind !== 'analog') throw new Error('not analog');
  return useOscilloscopeStore.getState().addNetChannel(target.netName, target.label, target.probe);
}

const plotted = (id: string) =>
  (useOscilloscopeStore.getState().samples[id] ?? []).map((s) => s.volts);
const channel = (id: string) => useOscilloscopeStore.getState().channels.find((c) => c.id === id)!;

function emptyScope(): void {
  useOscilloscopeStore.setState({
    open: true,
    running: true,
    channels: [],
    samples: {},
    triggerMode: 'auto',
    triggerChannelId: null,
    triggeredAtMs: null,
    triggerStatus: 'idle',
  });
}

/** A scope with one analog and one digital channel, the digital one as the
 *  trigger source and both with samples. */
function busyScope(): void {
  const s = useOscilloscopeStore.getState();
  const a = s.addNetChannel('n0', 'n0');
  s.addChannel('arduino-uno', 13, 'D13');
  s.pushAnalogBlock(a, [0, 1], [1, 2]);
  s.pushSample('osc-ch-arduino-uno-13', 0, true);
  s.setTriggerChannel('osc-ch-arduino-uno-13');
  expect(useOscilloscopeStore.getState().channels).toHaveLength(2);
}

function expectEmptyScope(): void {
  const s = useOscilloscopeStore.getState();
  expect(s.channels).toEqual([]);
  expect(s.samples).toEqual({});
  expect(s.triggerChannelId).toBeNull();
}

beforeEach(() => {
  emptyScope();
  useElectricalStore.getState().reset();
});
afterEach(() => {
  stopAnalogScopeFeed();
});

describe('a channel follows the pin it was probed at', () => {
  it('keeps plotting the divider tap when an added LED renumbers the nets', () => {
    startAnalogScopeFeed();
    setCanvas(BASE_PARTS, BASE_WIRES);
    const before = solvedNets(BASE_PARTS, BASE_WIRES);
    expect(before.get(`${R2}:2`)).toBe('n2'); // the divider tap
    publishSolve(before);

    const id = probe('wire-5');
    publishSolve(before);
    expect(plotted(id)).toEqual([2, 2]);

    // An LED on D2: the tap is n3 now, and n2 is the D13 LED's anode.
    const parts = [...BASE_PARTS, ...LED2_PARTS];
    const wires = [...BASE_WIRES, ...LED2_WIRES];
    setCanvas(parts, wires);
    const after = solvedNets(parts, wires);
    expect(after.get(`${R2}:2`)).toBe('n3');
    expect(after.get(`${LED1}:A`)).toBe('n2');
    publishSolve(after);

    expect(plotted(id)).toEqual([3, 3]);
    expect(channel(id)).toMatchObject({ kind: 'analog', netName: 'n3', label: 'n3' });
    // The transient the scope asks the solver for is the tap's, too.
    expect(analogScopeNets()).toEqual(['n3']);
  });

  it('blanks the channel, rather than freezing its last capture, when the probed part is deleted', () => {
    startAnalogScopeFeed();
    setCanvas(BASE_PARTS, BASE_WIRES);
    const before = solvedNets(BASE_PARTS, BASE_WIRES);
    publishSolve(before);
    const id = probe('wire-5');
    publishSolve(before);
    expect(plotted(id)).toEqual([2, 2]);

    // The divider goes: no net holds the probed pin any more.
    const parts = BASE_PARTS.filter((c) => c.id !== R2 && c.id !== R3);
    const wires = BASE_WIRES.filter((w) => !['wire-4', 'wire-5', 'wire-6', 'wire-7'].includes(w.id));
    setCanvas(parts, wires);
    publishSolve(solvedNets(parts, wires));

    expect(plotted(id)).toEqual([]);
    expect(channel(id)).toMatchObject({ kind: 'analog', lost: true });
    // A lost channel no longer holds the solver in transient mode.
    expect(analogScopeNets()).toEqual([]);
  });
});

describe('opening another circuit empties the scope', () => {
  it('importing or opening a project (loadProjectState)', () => {
    busyScope();
    useSimulatorStore.getState().loadProjectState({
      boards: [],
      components: [],
      wires: [],
      fileGroups: {},
      folderGroups: {},
      activeBoardId: null,
    } as never);
    expectEmptyScope();
  });

  it('loading a gallery example', async () => {
    busyScope();
    await loadExample(exampleProjects.find((e) => e.id === 'an-rc-low-pass')!);
    expectEmptyScope();
  });

  it('starting a new project from the starter picker', () => {
    busyScope();
    clearWorkspaceForStarter();
    expectEmptyScope();
  });
});

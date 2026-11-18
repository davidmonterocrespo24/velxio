// @vitest-environment jsdom
/**
 * Every way another circuit replaces the canvas empties the scope, the Wokwi
 * .zip import and the desktop menu's New included (velxio/velxio-prod#119).
 *
 * loadProjectState, loadExample and the starter picker empty the scope
 * (oscilloscope-channels-follow-circuit.test.ts), but three paths replace the
 * canvas without them:
 *  - the toolbar's Import and the file explorer's Open project, given a Wokwi
 *    .zip, apply the payload themselves (stopSimulation, setComponents,
 *    setWires). A Wokwi diagram names its parts r1, led1 and so on, so a
 *    channel probed at r1:2 went on to follow the NEW circuit's r1:2, another
 *    point, under the old label and with no warning;
 *  - the desktop menu's New empties the canvas, where no net holds the probed
 *    pin, so nothing ever re-pointed the channel: it kept its last capture.
 *
 * Each path is driven as the user drives it: the real toolbar and file
 * explorer get a real .zip through their file input, and the menu gets the
 * Tauri event its native item emits.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import JSZip from 'jszip';
import { useOscilloscopeStore } from '../store/useOscilloscopeStore';
import { useElectricalStore } from '../store/useElectricalStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useMessageDialogStore } from '../store/useMessageDialogStore';
import { startAnalogScopeFeed, stopAnalogScopeFeed } from '../simulation/spice/analogScopeFeed';
import { EditorToolbar } from '../components/editor/EditorToolbar';
import { FileExplorer } from '../components/editor/FileExplorer';
import { installDesktopMenuListener } from '../desktop/menu';
import { PROJECT_FILE_ACCEPT } from '../utils/importProject';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A Wokwi project: an Uno blinking an LED through r1, ids as Wokwi names them. */
async function wokwiZip(): Promise<File> {
  const zip = new JSZip();
  zip.file(
    'diagram.json',
    JSON.stringify({
      version: 1,
      author: 'test',
      editor: 'wokwi',
      parts: [
        { type: 'wokwi-arduino-uno', id: 'uno', top: 0, left: 0, attrs: {} },
        { type: 'wokwi-resistor', id: 'r1', top: 100, left: 200, attrs: { value: '1000' } },
        { type: 'wokwi-led', id: 'led1', top: 100, left: 300, attrs: { color: 'red' } },
      ],
      connections: [
        ['uno:13', 'r1:1', 'green', []],
        ['r1:2', 'led1:A', 'green', []],
        ['led1:C', 'uno:GND.1', 'black', []],
      ],
    }),
  );
  zip.file('sketch.ino', 'void setup() {}\nvoid loop() {}\n');
  return new File([await zip.generateAsync({ type: 'blob' })], 'blink.zip', { type: 'application/zip' });
}

/**
 * The open circuit's scope: an analog channel probed at r1:2 (net n1 there)
 * with a capture, and a digital one on D13 as the trigger source.
 */
function probedScope(): string {
  useElectricalStore.setState({ pinNetMap: new Map([['r1:1', 'n0'], ['r1:2', 'n1']]) });
  const s = useOscilloscopeStore.getState();
  const id = s.addNetChannel('n1', 'n1', { componentId: 'r1', pinName: '2' });
  s.addChannel('arduino-uno', 13, 'D13');
  s.pushAnalogBlock(id, [0, 1], [1, 2]);
  s.setTriggerChannel('osc-ch-arduino-uno-13');
  expect(useOscilloscopeStore.getState().channels).toHaveLength(2);
  return id;
}

/** The imported circuit's first solve: its own r1:2 is n4, at 7 V. */
function publishImportedSolve(): void {
  useElectricalStore.setState({
    pinNetMap: new Map([['r1:1', 'n3'], ['r1:2', 'n4']]),
    analysisMode: 'tran',
    timeWaveforms: undefined,
    scopeWaveforms: { time: [0, 0.001], nodes: new Map([['n4', [7, 7]]]), branches: new Map() },
  });
}

function expectEmptyScope(): void {
  const s = useOscilloscopeStore.getState();
  expect(s.channels).toEqual([]);
  expect(s.samples).toEqual({});
  expect(s.triggerChannelId).toBeNull();
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
  useElectricalStore.getState().reset();
  useSimulatorStore.setState({ components: [], wires: [] } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  startAnalogScopeFeed();
});

afterEach(() => {
  stopAnalogScopeFeed();
  act(() => root.unmount());
  host.remove();
  useMessageDialogStore.getState().close(false);
  vi.restoreAllMocks();
});

/** The hidden input the Import / Open project button clicks. */
function projectInput(): HTMLInputElement {
  const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"]')].find(
    (i) => i.accept === PROJECT_FILE_ACCEPT,
  );
  expect(input, 'the project file input').toBeDefined();
  return input!;
}

/** What the browser does when the user picks a file in that input. */
async function pick(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function until(what: string, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  expect(cond(), what).toBe(true);
}

const imported = () => useSimulatorStore.getState().components.some((c) => c.id === 'r1');

describe('importing a Wokwi .zip empties the scope', () => {
  it("through the toolbar's Import", async () => {
    probedScope();
    act(() =>
      root.render(
        createElement(EditorToolbar, {
          consoleOpen: false,
          setConsoleOpen: () => {},
          compileLogs: [],
          setCompileLogs: () => {},
        }),
      ),
    );
    await pick(projectInput(), await wokwiZip());
    await until('the .zip landed on the canvas', imported);
    publishImportedSolve();
    // Not the old channel re-pointed at the new circuit's r1:2 (n4, 7 V).
    expectEmptyScope();
  });

  it("through the file explorer's Open project", async () => {
    probedScope();
    act(() => root.render(createElement(FileExplorer, { onSaveClick: () => {}, onNewClick: () => {} })));
    await pick(projectInput(), await wokwiZip());
    // It asks before replacing the workspace.
    await until('the confirm dialog', () => {
      const d = useMessageDialogStore.getState();
      return d.open && d.mode === 'confirm';
    });
    act(() => useMessageDialogStore.getState().close(true));
    await until('the .zip landed on the canvas', imported);
    publishImportedSolve();
    expectEmptyScope();
  });
});

describe("the desktop menu's New empties the scope", () => {
  afterEach(() => {
    delete (window as { __TAURI__?: unknown }).__TAURI__;
  });

  it('as the native File > New item delivers it', async () => {
    // The Tauri event API the menu listens on; the native item emits
    // velxio://menu with { action: 'new-project' }.
    let deliver: ((event: { payload: unknown }) => void) | null = null;
    (window as { __TAURI__?: unknown }).__TAURI__ = {
      event: {
        listen: async (_name: string, cb: (event: { payload: unknown }) => void) => {
          deliver = cb;
          return () => {};
        },
      },
    };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await installDesktopMenuListener();
    expect(deliver, 'the menu listener').not.toBeNull();

    useSimulatorStore.setState({
      components: [{ id: 'r1', metadataId: 'resistor', x: 0, y: 0, properties: { value: '1k' } }],
    } as never);
    probedScope();
    await act(async () => {
      deliver!({ payload: { action: 'new-project' } });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(useSimulatorStore.getState().components).toEqual([]);
    expectEmptyScope();
  });
});

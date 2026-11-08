// @vitest-environment jsdom
/**
 * A board kind the open-source tree does not know gets no simulator until the
 * overlay registers it, and never the Uno's (velxio/velxio-prod#209).
 *
 * The overlay registers its boards from mountPro(), after main.tsx's async
 * import('@pro/index') lands and the launch flags arrive. A saved project on an
 * overlay board opened before that (seen with the XIAO RP2350) went through the
 * last branch of createSimulator, `new AVRSimulator(pm, 'uno')`: Run then ran
 * an Uno (AVR frames, 16 M cycles per 60) or failed with "Simulator already
 * running or not initialized". A kind that never registers (an OSS-only build
 * opening a project saved on velxio.dev, an embargoed board) must say so at Run.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  useSimulatorStore,
  getBoardSimulator,
  getEsp32Bridge,
} from '../store/useSimulatorStore';
import * as registry from '../lib/proBoardRegistry';
import { registerProBoards, type ProBoardSimulator } from '../lib/proBoardRegistry';
import { AVRSimulator } from '../simulation/AVRSimulator';
import type { BoardInstance, BoardKind } from '../types/board';

class FakeOverlaySim implements ProBoardSimulator {
  readonly isProBoardSimulator = true as const;
  onSerialData: ((ch: string) => void) | null = null;
  onPinChangeWithTime: ((pin: number, state: boolean, time: number) => void) | null = null;
  started = 0;
  start(): void {
    this.started++;
  }
  stop(): void {}
  reset(): void {}
}

const sims: FakeOverlaySim[] = [];

function def(kind: string, extra: Partial<registry.ProBoardDef> = {}): registry.ProBoardDef {
  return {
    kind,
    label: `Late board ${kind}`,
    fqbn: 'rp2040:rp2040:test',
    description: 'registered after the project loaded',
    tag: `velxio-test-${kind}`,
    size: { w: 10, h: 10 },
    createSimulator: () => {
      const s = new FakeOverlaySim();
      sims.push(s);
      return s;
    },
    ...extra,
  };
}

function savedProject(kind: string, id: string) {
  const board = {
    id,
    boardKind: kind as BoardKind,
    x: 40,
    y: 40,
    running: false,
    compiledProgram: null,
    serialOutput: '',
    serialBaudRate: 0,
    serialMonitorOpen: false,
    activeFileGroupId: `group-${id}`,
    languageMode: 'arduino',
  } as BoardInstance;
  return {
    boards: [board],
    fileGroups: { [`group-${id}`]: [{ name: 'sketch.ino', content: 'void setup(){}\nvoid loop(){}\n' }] },
    components: [],
    wires: [],
    activeBoardId: id,
  };
}

function resetStores() {
  const sim = useSimulatorStore.getState();
  for (const id of sim.boards.map((b) => b.id)) sim.removeBoard(id);
}

describe('a board kind the overlay registers after the project loaded', () => {
  beforeEach(resetStores);

  it('gets the overlay simulator once the kind registers, never an AVR before', () => {
    const kind = 'late-rp2350-test';
    useSimulatorStore.getState().loadProjectState(savedProject(kind, 'xiao'));

    expect(getBoardSimulator('xiao')).not.toBeInstanceOf(AVRSimulator);
    expect(useSimulatorStore.getState().boards.map((b) => b.id)).toEqual(['xiao']);

    registerProBoards([def(kind)]);

    const sim = getBoardSimulator('xiao');
    expect(sim).toBeInstanceOf(FakeOverlaySim);
    // The active board's flat mirror follows, so the part layer attaches to it.
    expect(useSimulatorStore.getState().simulator).toBe(sim);
  });

  it('builds an ESP32-family board as an ESP32 board once its kind registers', () => {
    const kind = 'late-esp32s3-test';
    useSimulatorStore.getState().loadProjectState(savedProject(kind, 'xiao-s3'));
    expect(getBoardSimulator('xiao-s3')).not.toBeInstanceOf(AVRSimulator);

    registerProBoards([def(kind, { esp32Family: 'esp32-s3', createSimulator: undefined })]);

    expect(getEsp32Bridge('xiao-s3')).toBeDefined();
    expect(getBoardSimulator('xiao-s3')).not.toBeInstanceOf(AVRSimulator);
  });

  it('keeps an OSS board on its own simulator without waiting for the overlay', () => {
    useSimulatorStore.getState().loadProjectState(savedProject('arduino-uno', 'uno'));
    expect(getBoardSimulator('uno')).toBeInstanceOf(AVRSimulator);
  });
});

// Last: settling the registry is one-way for the whole module.
describe('a board kind the registry never learns', () => {
  beforeEach(resetStores);

  it('refuses to run once the registry is final, and says why', async () => {
    const kind = 'never-registered-test';
    useSimulatorStore.getState().loadProjectState(savedProject(kind, 'ghost'));
    (registry as unknown as { markProBoardsSettled: () => void }).markProBoardsSettled();

    expect(getBoardSimulator('ghost')).toBeUndefined();
    useSimulatorStore.getState().startBoard('ghost');

    const ghost = () => useSimulatorStore.getState().boards.find((b) => b.id === 'ghost');
    expect(ghost()?.running).toBe(false);
    // Serial output is batched per animation frame.
    await vi.waitFor(() => expect(ghost()?.serialOutput ?? '').toMatch(/not available/i));
    expect(ghost()?.serialOutput ?? '').toContain(kind);
  });

  it('still attaches a kind that registers after the registry settled', () => {
    const kind = 'very-late-test';
    useSimulatorStore.getState().loadProjectState(savedProject(kind, 'late'));
    registerProBoards([def(kind)]);
    expect(getBoardSimulator('late')).toBeInstanceOf(FakeOverlaySim);
  });
});

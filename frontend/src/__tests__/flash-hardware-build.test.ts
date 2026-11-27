// @vitest-environment jsdom
/**
 * A board is flashed with firmware built for it, never with the simulator's
 * where the two differ.
 *
 * RP2040 / RP2350: the simulator's build renames Serial to Serial1, because
 * its serial monitor shows UART0. Until 2026-11 the flash dialog wrote the
 * .uf2 of that same build, and the board printed nothing on its USB port.
 * The dialog now asks the server for a build of its own (`for_hardware`),
 * which stays in the dialog: the emulator goes on running the simulator's.
 *
 * ESP32: the simulator's build of a WiFi sketch has its SSID swapped for the
 * simulated network and its password dropped, so the flashed board looked
 * for "Velxio-GUEST" at the user's home. Only such a build differs, and the
 * server says which one is (`wifi_rewritten`): the dialog builds its own
 * image then, and flashes every other ESP32 with the program it already has.
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../simulation/AVRSimulator', () => ({
  AVRSimulator: vi.fn(function (this: any) {
    this.onSerialData = null;
    this.onBaudRateChange = null;
    this.onPinChangeWithTime = null;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.reset = vi.fn();
    this.loadHex = vi.fn();
    this.addI2CDevice = vi.fn();
    this.setPinState = vi.fn();
  }),
}));

vi.mock('../simulation/RP2040Simulator', () => ({
  RP2040Simulator: vi.fn(function (this: any) {
    this.onSerialData = null;
    this.onPinChangeWithTime = null;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.reset = vi.fn();
    this.loadBinary = vi.fn();
    this.addI2CDevice = vi.fn();
    this.attachPioPeripheral = vi.fn();
    this.spi = { onByte: null, completeTransfer: vi.fn() };
  }),
}));

// The texts with what they were given, so a test can read a log line's board.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  }),
}));

vi.mock('axios', async (importOriginal) => {
  const real = await importOriginal<typeof import('axios')>();
  return { ...real, default: { ...real.default, post: vi.fn(), get: vi.fn() } };
});

vi.mock('../services/compilation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/compilation')>()),
  compileCode: vi.fn(),
}));

import axios from 'axios';
import { compileCode, type CompileResult } from '../services/compilation';
import { FlashModal } from '../components/simulator/FlashModal';
import { installWebFlashImpl, type WebFlashImpl, type WebFlashRequest } from '../lib/proWebFlash';
import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { BOARD_KIND_FQBN, BOARD_KIND_LABELS, type BoardKind } from '../types/board';
import {
  compileBoardForFlash,
  hardwareBuildDiffers,
  needsHardwareBuild,
} from '../utils/boardCompile';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const compile = vi.mocked(compileCode);
const boardOf = (id: string) => useSimulatorStore.getState().boards.find((b) => b.id === id)!;

/**
 * The server's answer: the image of the target that was asked for.
 * `wifiRewritten` is what it says of a simulator build (never of one for
 * hardware, whose sources it leaves alone); undefined is a server that
 * predates the field.
 */
function serverBuilds(wifiRewritten?: boolean): void {
  compile.mockImplementation(async (_files, _fqbn, _project, _onProgress, extras) => {
    const name = extras?.forHardware ? 'HARDWARE' : 'SIMULATOR';
    return {
      success: true,
      binary_content: btoa(`${name}.bin`),
      uf2_content: btoa(`${name}.uf2`),
      ...(wifiRewritten === undefined
        ? {}
        : { wifi_rewritten: extras?.forHardware ? false : wifiRewritten }),
      stdout: '',
      stderr: '',
    } as CompileResult;
  });
}

beforeEach(() => {
  useSimulatorStore.setState((useSimulatorStore as any).getInitialState?.() ?? {});
  compile.mockReset();
  serverBuilds();
});

describe('hardwareBuildDiffers', () => {
  it.each([
    ['rp2040:rp2040:rpipico', true],
    ['rp2040:rp2040:seeed_xiao_rp2040', true],
    ['rp2040:rp2040:rpipico2w:arch=riscv', true],
    ['arduino:avr:uno', false],
    ['esp32:esp32:esp32', false],
    [null, false],
  ])('%s: %s', (fqbn, differs) => {
    expect(hardwareBuildDiffers(fqbn)).toBe(differs);
  });
});

describe('needsHardwareBuild', () => {
  it.each([
    ['esp32:esp32:esp32', true, true],
    ['esp32:esp32:esp32', false, false],
    // A server that predates the field: flashed as it always was.
    ['esp32:esp32:esp32', undefined, false],
    ['rp2040:rp2040:rpipico', undefined, true],
    ['rp2040:rp2040:rpipico', false, true],
    ['arduino:avr:uno', undefined, false],
  ])('%s, wifiRewritten %s: %s', (fqbn, wifiRewritten, own) => {
    expect(needsHardwareBuild({ wifiRewritten }, fqbn)).toBe(own);
  });
});

describe('what the server says of a build', () => {
  it('is recorded with the program, and only of the simulator\'s build', async () => {
    serverBuilds(true);
    const id = useSimulatorStore.getState().addBoard('esp32' as BoardKind, 0, 0);
    expect(boardOf(id).wifiRewritten).toBeUndefined();

    const sim = await compileBoardForFlash(boardOf(id), () => {});
    expect(sim).toMatchObject({ ok: true, wifiRewritten: true });
    expect(boardOf(id).wifiRewritten).toBe(true);

    const own = await compileBoardForFlash(boardOf(id), () => {}, {
      record: false,
      forHardware: true,
    });
    expect(own).toMatchObject({ ok: true, wifiRewritten: false });
    expect(boardOf(id).wifiRewritten).toBe(true);
    expect(boardOf(id).compiledProgram).toBe(btoa('SIMULATOR.bin'));
  });

  it('does not outlive the build it was said of', async () => {
    const id = useSimulatorStore.getState().addBoard('esp32' as BoardKind, 0, 0);
    const store = useSimulatorStore.getState();
    store.compileBoardProgram(id, btoa('SIMULATOR.bin'), { wifiRewritten: true });
    expect(boardOf(id).wifiRewritten).toBe(true);
    // A firmware file loaded by hand, a caller that knows nothing of it.
    store.compileBoardProgram(id, btoa('LOADED.bin'));
    expect(boardOf(id).wifiRewritten).toBeUndefined();
  });
});

describe('compileBoardForFlash', () => {
  it('asks for a build for real hardware only when told, and does not record it', async () => {
    const id = useSimulatorStore.getState().addBoard('raspberry-pi-pico' as BoardKind, 0, 0);
    useSimulatorStore.getState().compileBoardProgram(id, btoa('SIMULATOR.bin'));

    const own = await compileBoardForFlash(boardOf(id), () => {}, {
      record: false,
      forHardware: true,
    });
    expect(compile.mock.calls[0][4]).toMatchObject({ forHardware: true });
    expect(own).toMatchObject({ ok: true, uf2: btoa('HARDWARE.uf2') });
    expect(boardOf(id).compiledProgram).toBe(btoa('SIMULATOR.bin'));

    await compileBoardForFlash(boardOf(id), () => {});
    expect(compile.mock.calls[1][4]?.forHardware).toBeUndefined();
    expect(boardOf(id).compiledProgram).toBe(btoa('SIMULATOR.bin'));
  });
});

describe('the compile request', () => {
  it('carries for_hardware only for such a build', async () => {
    const real =
      await vi.importActual<typeof import('../services/compilation')>('../services/compilation');
    vi.mocked(axios.post).mockResolvedValue({ data: { job_id: 'j' } });
    vi.mocked(axios.get).mockResolvedValue({
      data: { state: 'done', started_at: 0, finished_at: 0, stdout: '', error: null, result: { success: true, stdout: '', stderr: '' } },
    });
    const files = [{ name: 'sketch.ino', content: '' }];
    await real.compileCode(files, 'rp2040:rp2040:rpipico', null, undefined, { forHardware: true });
    await real.compileCode(files, 'rp2040:rp2040:rpipico', null, undefined, {});
    const bodies = vi.mocked(axios.post).mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(bodies[0].for_hardware).toBe(true);
    expect(bodies[1]).not.toHaveProperty('for_hardware');
  });
});

describe('the flash dialog', () => {
  let host: HTMLDivElement;
  let root: Root;
  const flashed: WebFlashRequest[] = [];

  beforeEach(() => {
    flashed.length = 0;
    installWebFlashImpl({
      available: () => true,
      flash: async (req: WebFlashRequest) => {
        flashed.push(req);
        return { chipName: 'chip', elapsedMs: 1 };
      },
    } as WebFlashImpl);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    installWebFlashImpl(null);
  });

  /**
   * Opens the dialog on a board whose simulator build is current (`built`,
   * with what the server said of it), or on one never compiled.
   */
  async function open(
    kind: string,
    built: { wifiRewritten?: boolean } | null = {},
  ): Promise<string> {
    const id = useSimulatorStore.getState().addBoard(kind as BoardKind, 0, 0);
    if (built) {
      useSimulatorStore.getState().compileBoardProgram(id, btoa('SIMULATOR.bin'), built);
    }
    const fqbn = (BOARD_KIND_FQBN as Record<string, string>)[kind];
    await act(async () => {
      root.render(createElement(FlashModal, { board: boardOf(id), fqbn, onClose: () => {} }));
    });
    return id;
  }

  /**
   * The dialog's own button, "Connect & flash" with or without a build
   * first. Not the last button: an RP2 board has "Download .uf2" below it.
   */
  const button = (named: RegExp = /connect/i) =>
    [...host.querySelectorAll('button')].find((b) => named.test(b.textContent ?? ''))!;
  /** Presses it and waits for the flash it ends in (the builds come first). */
  const press = (named: RegExp = /connect/i) => act(async () => {
    const before = flashed.length;
    button(named).click();
    for (let i = 0; i < 200 && flashed.length === before; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 20));
  });

  it('builds an RP2040 its own image and leaves the simulator its program', async () => {
    const id = await open('raspberry-pi-pico');
    await press();
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile.mock.calls[0][4]).toMatchObject({ forHardware: true });
    expect(flashed.map((r) => r.binaryBase64)).toEqual([btoa('HARDWARE.uf2')]);
    expect(boardOf(id).compiledProgram).toBe(btoa('SIMULATOR.bin'));
  });

  it('flashes an Uno with the program the simulator runs, without a build', async () => {
    await open('arduino-uno');
    await press();
    expect(compile).not.toHaveBeenCalled();
    expect(flashed.map((r) => r.binaryBase64)).toEqual([btoa('SIMULATOR.bin')]);
  });

  const forHardware = () => compile.mock.calls.map((c) => c[4]?.forHardware === true);

  it('builds an ESP32 its own image when its WiFi was rewritten for the simulator', async () => {
    const id = await open('esp32', { wifiRewritten: true });
    await press();
    expect(forHardware()).toEqual([true]);
    expect(flashed.map((r) => r.binaryBase64)).toEqual([btoa('HARDWARE.bin')]);
    expect(boardOf(id).compiledProgram).toBe(btoa('SIMULATOR.bin'));
  });

  it.each([
    ['nothing was rewritten', false],
    ['the server predates the field', undefined],
  ])('flashes an ESP32 with the simulator\'s program when %s, without a build', async (_why, said) => {
    await open('esp32', { wifiRewritten: said });
    await press();
    expect(compile).not.toHaveBeenCalled();
    expect(flashed.map((r) => r.binaryBase64)).toEqual([btoa('SIMULATOR.bin')]);
  });

  it('learns from the build it makes that an ESP32 needs its own', async () => {
    serverBuilds(true);
    const id = await open('esp32', null);
    await press();
    // The simulator's first, as ever, then the board's.
    expect(forHardware()).toEqual([false, true]);
    expect(flashed.map((r) => r.binaryBase64)).toEqual([btoa('HARDWARE.bin')]);
    expect(boardOf(id).compiledProgram).toBe(btoa('SIMULATOR.bin'));
    expect(boardOf(id).wifiRewritten).toBe(true);
  });

  it('files its own build under the sources it was made from', async () => {
    // Reject the simulator build if the sketch changes while it runs.
    // Retry with the edited sketch, then undo the edit and retry the failed
    // upload. The dialog must build again instead of reusing the edited image.
    const id = await open('esp32', null);
    const group = boardOf(id).activeFileGroupId;
    const file = () => useEditorStore.getState().getGroupFiles(group)[0];
    const written = file().content;
    const edit = (content: string) =>
      act(async () => useEditorStore.getState().updateGroupFile(group, file().id, content));
    let editDuringBuild = true;
    compile.mockImplementation(async (files, _fqbn, _project, _onProgress, extras) => {
      const name = `${extras?.forHardware ? 'HARDWARE' : 'SIMULATOR'} of ${files[0].content}`;
      if (!extras?.forHardware && editDuringBuild) {
        editDuringBuild = false;
        await edit('EDITED');
      }
      return {
        success: true,
        binary_content: name,
        wifi_rewritten: !extras?.forHardware,
        stdout: '',
        stderr: '',
      } as CompileResult;
    });
    let unplugged = true;
    installWebFlashImpl({
      available: () => true,
      flash: async (req: WebFlashRequest) => {
        flashed.push(req);
        if (unplugged) throw new Error('unplugged');
        return { chipName: 'chip', elapsedMs: 1 };
      },
    } as WebFlashImpl);

    await press();
    expect(flashed).toEqual([]);
    expect(boardOf(id).compiledProgram).toBeFalsy();
    expect(host.textContent).toContain('The sketch changed during compilation');

    await press(/retry/i);
    expect(flashed.map((r) => r.binaryBase64)).toEqual(['HARDWARE of EDITED']);

    await edit(written);
    unplugged = false;
    await press(/retry/i);
    expect(flashed.map((r) => r.binaryBase64)[1]).toBe(`HARDWARE of ${written}`);
  });

  it('names the board in its log, not the id of its kind', async () => {
    const id = await open('esp32', { wifiRewritten: true });
    compile.mockResolvedValue({ success: false, error: 'stop', stdout: '', stderr: '' } as CompileResult);
    await act(async () => {
      button().click();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(boardOf(id).boardKind).toBe('esp32');
    expect(host.textContent).toContain(`"revision":"${BOARD_KIND_LABELS.esp32}"`);
    expect(BOARD_KIND_LABELS.esp32).not.toBe('esp32');
  });

  it.each([
    ['nothing was rewritten', false],
    ['the server predates the field', undefined],
  ])('makes one build of a never-compiled ESP32 when %s', async (_why, said) => {
    serverBuilds(said);
    const id = await open('esp32', null);
    await press();
    expect(forHardware()).toEqual([false]);
    expect(flashed.map((r) => r.binaryBase64)).toEqual([btoa('SIMULATOR.bin')]);
    expect(boardOf(id).compiledProgram).toBe(btoa('SIMULATOR.bin'));
  });
});

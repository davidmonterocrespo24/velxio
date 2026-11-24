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
import { useSimulatorStore } from '../store/useSimulatorStore';
import { BOARD_KIND_FQBN, type BoardKind } from '../types/board';
import { compileBoardForFlash, hardwareBuildDiffers } from '../utils/boardCompile';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const compile = vi.mocked(compileCode);
const boardOf = (id: string) => useSimulatorStore.getState().boards.find((b) => b.id === id)!;

/** The server's answer: the image of the target that was asked for. */
function serverBuilds(): void {
  compile.mockImplementation(async (_files, _fqbn, _project, _onProgress, extras) => {
    const name = extras?.forHardware ? 'HARDWARE' : 'SIMULATOR';
    return {
      success: true,
      binary_content: btoa(`${name}.bin`),
      uf2_content: btoa(`${name}.uf2`),
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

  /** Opens the dialog on a board whose simulator build is current. */
  async function open(kind: string): Promise<string> {
    const id = useSimulatorStore.getState().addBoard(kind as BoardKind, 0, 0);
    useSimulatorStore.getState().compileBoardProgram(id, btoa('SIMULATOR.bin'));
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
});

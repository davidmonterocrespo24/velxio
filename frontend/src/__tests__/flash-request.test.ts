// @vitest-environment jsdom
/**
 * lib/flashRequest.ts: the one answer to "can this board be flashed here?"
 * (context menu, toolbar button and overlays all ask it) and the one way to
 * open the Flash dialog (a window event the canvas listens to).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPEN_FLASH_EVENT,
  boardFlashSupport,
  requestFlashDialog,
  type OpenFlashDetail,
} from '../lib/flashRequest';
import { installWebFlashImpl, onWebFlashImplChange, type WebFlashImpl } from '../lib/proWebFlash';

const impl = (available: (kind: string) => boolean, mpy = false): WebFlashImpl => ({
  available,
  flash: vi.fn(),
  ...(mpy ? { flashMicroPython: vi.fn() } : {}),
});

describe('boardFlashSupport', () => {
  afterEach(() => installWebFlashImpl(null));

  it('no board, no route', () => {
    expect(boardFlashSupport(null, false)).toEqual({ route: null, micropython: false, disabled: true });
  });

  it('pure OSS web build: an AVR board has no route at all', () => {
    const s = boardFlashSupport({ boardKind: 'arduino-uno' }, false);
    expect(s.route).toBeNull();
    expect(s.disabled).toBe(true);
  });

  it('pure OSS web build: an RP2040 still flashes, through the .uf2 download', () => {
    const s = boardFlashSupport({ boardKind: 'raspberry-pi-pico' }, false);
    expect(s.route).toBe('uf2');
    expect(s.disabled).toBe(false);
  });

  it('the desktop shell flashes every family', () => {
    expect(boardFlashSupport({ boardKind: 'arduino-uno' }, true).route).toBe('desktop');
    expect(boardFlashSupport({ boardKind: 'arduino-uno' }, true).disabled).toBe(false);
  });

  it('an installed web flasher takes the boards it supports', () => {
    installWebFlashImpl(impl((k) => k === 'esp32'));
    expect(boardFlashSupport({ boardKind: 'esp32' }, false)).toEqual({
      route: 'web',
      micropython: false,
      disabled: false,
    });
    expect(boardFlashSupport({ boardKind: 'arduino-uno' }, false).route).toBeNull();
  });

  it('a MicroPython board on the web needs the flasher MicroPython path', () => {
    installWebFlashImpl(impl((k) => k === 'esp32'));
    const without = boardFlashSupport({ boardKind: 'esp32', languageMode: 'micropython' }, false);
    expect(without.route).toBe('web');
    expect(without.disabled).toBe(true);
    installWebFlashImpl(impl((k) => k === 'esp32', true));
    expect(
      boardFlashSupport({ boardKind: 'esp32', languageMode: 'micropython' }, false).disabled,
    ).toBe(false);
  });

  it('a MicroPython RP2040 is not offered the .uf2 download (there is no image)', () => {
    const s = boardFlashSupport({ boardKind: 'raspberry-pi-pico', languageMode: 'micropython' }, false);
    expect(s.route).toBeNull();
    expect(s.disabled).toBe(true);
  });
});

describe('requestFlashDialog', () => {
  it('dispatches the open event with the board and where it came from', () => {
    const seen: OpenFlashDetail[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent<OpenFlashDetail>).detail);
    window.addEventListener(OPEN_FLASH_EVENT, on);
    requestFlashDialog('esp32-1', 'toolbar');
    requestFlashDialog(null, 'agent');
    window.removeEventListener(OPEN_FLASH_EVENT, on);
    expect(seen).toEqual([
      { boardId: 'esp32-1', source: 'toolbar' },
      { boardId: null, source: 'agent' },
    ]);
  });
});

describe('onWebFlashImplChange', () => {
  afterEach(() => installWebFlashImpl(null));

  it('tells listeners when the overlay installs its flasher, until unsubscribed', () => {
    const fn = vi.fn();
    const off = onWebFlashImplChange(fn);
    installWebFlashImpl(impl(() => true));
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    installWebFlashImpl(null);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener does not stop the install', () => {
    const off = onWebFlashImplChange(() => {
      throw new Error('boom');
    });
    expect(() => installWebFlashImpl(impl(() => true))).not.toThrow();
    off();
  });
});

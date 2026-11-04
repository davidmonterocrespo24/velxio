/**
 * "Flash to real board": who may offer it, and one way to open it.
 *
 * The Flash dialog belongs to SimulatorCanvas (it owns the board list and
 * the modal mount). Until now the only way in was the board's context menu,
 * which is why almost nobody found it. Three places ask for it now, the
 * context menu, the toolbar button next to Run and any overlay that wants to
 * offer it (the pro agent's chat card), so the question "can this board be
 * flashed here?" and the request to open the dialog live here, once.
 *
 * Opening goes through a window event instead of a callback prop: the
 * callers sit in unrelated trees (toolbar, canvas, an overlay root mounted
 * outside React's tree), and an event needs no wiring between them. The
 * canvas is the single listener. The `source` travels with it so an overlay
 * can count where people come from without any of these callers knowing.
 */
import { isTauri } from '../desktop/tauriBridge';
import { boardKindHasUf2 } from '../utils/uf2Download';
import { webFlashAvailable, webFlashMpyAvailable } from './proWebFlash';

export const OPEN_FLASH_EVENT = 'velxio-open-flash';

/** Where the request came from. Free-form for overlays; these are ours. */
export type FlashRequestSource = 'toolbar' | 'context_menu' | 'agent' | (string & {});

export interface OpenFlashDetail {
  /** The board to flash. null = the active board. */
  boardId: string | null;
  source: FlashRequestSource;
}

/**
 * How a board reaches real hardware from this build, or why it cannot.
 *
 *  - `desktop`: the Tauri shell (arduino-cli over USB), every family.
 *  - `web`:     a Web Serial / WebUSB flasher installed by an overlay.
 *  - `uf2`:     RP2040 / RP2350 without a flasher: the dialog compiles and
 *               hands over the .uf2 for the board's BOOTSEL drive.
 *  - null:      no route in this build or browser.
 *
 * `disabled` is set when there IS a route but not for this project: a
 * MicroPython board on the web when the overlay has no MicroPython path.
 */
export interface FlashSupport {
  route: 'desktop' | 'web' | 'uf2' | null;
  micropython: boolean;
  disabled: boolean;
}

export interface FlashableBoard {
  boardKind: string;
  languageMode?: string;
}

export function boardFlashSupport(
  board: FlashableBoard | null | undefined,
  tauri: boolean = isTauri(),
): FlashSupport {
  if (!board) return { route: null, micropython: false, disabled: true };
  const micropython = board.languageMode === 'micropython';
  const web = webFlashAvailable(board.boardKind);
  const route: FlashSupport['route'] = tauri
    ? 'desktop'
    : web
      ? 'web'
      : !micropython && boardKindHasUf2(board.boardKind)
        ? 'uf2'
        : null;
  // MicroPython boards don't compile to an image; on the web they flash only
  // through the overlay's MicroPython path (firmware install + file upload).
  const disabled =
    route === null || (micropython && !tauri && !webFlashMpyAvailable(board.boardKind));
  return { route, micropython, disabled };
}

/** Ask the canvas to open the Flash dialog. Safe to call anywhere. */
export function requestFlashDialog(
  boardId: string | null,
  source: FlashRequestSource,
): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<OpenFlashDetail>(OPEN_FLASH_EVENT, { detail: { boardId, source } }),
  );
}

/** Flash capabilities and the shared event that opens the workspace Flash view. */
import { isTauri } from '../desktop/tauriBridge';
import { boardKindHasUf2 } from '../utils/uf2Download';
import { webFlashAvailable, webFlashMpyAvailable } from './proWebFlash';
export { getBrowserFlashSerial } from './browserFlashSerial';

export const OPEN_FLASH_EVENT = 'velxio-open-flash';

/** Where the request came from. Free-form for overlays; these are ours. */
export type FlashRequestSource = 'toolbar' | 'context_menu' | 'agent' | (string & {});

export interface OpenFlashDetail {
  /** The board to flash. null = the active board. */
  boardId: string | null;
  source: FlashRequestSource;
}

export function isFlashPortSelectionCancelled(error: unknown, choosingPort = false): boolean {
  if (!(error instanceof Error) || error.name === 'NotInBootloaderError') return false;
  return (choosingPort && (error.name === 'NotFoundError' || error.name === 'AbortError')) ||
    /no (?:port|device) selected/i.test(error.message);
}

/**
 * How a board reaches real hardware from this build, or why it cannot.
 *
 *  - `desktop`: the Tauri shell (arduino-cli over USB), every family.
 *  - `web`:     a built-in or overlay browser flasher.
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

/** Ask the editor to open the Flash sidebar. Safe to call anywhere. */
export function requestFlashDialog(
  boardId: string | null,
  source: FlashRequestSource,
): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<OpenFlashDetail>(OPEN_FLASH_EVENT, { detail: { boardId, source } }),
  );
}

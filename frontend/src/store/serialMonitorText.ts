/**
 * serialMonitorText — what the serial monitor renders of a board's output.
 *
 * The monitor runs its clean-up passes over this text and renders it on every
 * flush of the serial batcher (up to 60 a second). Nothing in OSS installs a
 * hook, so the default is the identity: the board's whole serialOutput, as
 * before. The pro overlay installs a bounded window (the tail of the output,
 * fed from the serial wire's display() chunks, store/serialWire.ts), so a
 * chatty sketch no longer makes every flush cost time linear in everything it
 * has printed (velxio/velxio-prod#19). The store keeps the whole text; only
 * the monitor's rendering reads this.
 */

/** The part of a board the monitor's text is made from. */
export interface BoardSerialText {
  id: string;
  serialOutput: string;
}

type SerialMonitorTextFn = (board: BoardSerialText) => string;

let _impl: SerialMonitorTextFn | null = null;
let warned = false;

/** Installed by the pro overlay. Pass null to clear (hot reload). */
export function installSerialMonitorText(impl: SerialMonitorTextFn | null): void {
  _impl = impl;
}

/** The text the monitor renders for `board`. The board's whole output with no hook. */
export function serialMonitorText(board: BoardSerialText): string {
  if (!_impl) return board.serialOutput;
  try {
    return _impl(board);
  } catch (err) {
    // A broken hook must never cost the monitor its output: show it all.
    if (!warned) {
      warned = true;
      console.warn('[serialMonitorText] hook threw; the whole output is shown from here on:', err);
    }
    return board.serialOutput;
  }
}

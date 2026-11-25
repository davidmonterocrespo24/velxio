/**
 * serialBatcher — coalesces per-byte USART output into one store update
 * per animation frame.
 *
 * Problem: AVR/RP2040/ESP32 emit one callback per byte. A sketch running
 * `Serial.println(value)` at 200 Hz (e.g. the Half-Wave Rectifier example)
 * produces ~600 store sets/sec. React's useSyncExternalStore can't reconcile
 * that fast and eventually throws "Maximum update depth exceeded" from any
 * effect whose deps include `serialOutput.length`.
 *
 * Fix: buffer chars in memory, flush once per `requestAnimationFrame` (≤60 Hz).
 * No semantic change — the buffer preserves byte order and groups by board.
 *
 * In non-browser environments (Vitest, Node) `requestAnimationFrame` is
 * typically polyfilled to `setTimeout(…, 0)`, which also coalesces correctly.
 *
 * A tab in the background gets no animation frames at all, while a simulation
 * whose engine runs in a worker keeps running there. Bytes that waited for a
 * frame then sat in this buffer until the user came back: an assistant working
 * in that tab read an empty serial monitor for as long as it cared to wait and
 * concluded that the firmware never printed (2026-11-23, ten reads of up to
 * 90 s of a board that had printed its boot banner). So a frame is raced by a
 * timer: the first of the two flushes.
 */

/** How long bytes wait for an animation frame before a timer flushes them. */
export const FRAME_WAIT_MS = 200;

export type BatchFlush = (perBoard: Map<string, string>) => void;

export interface SerialBatcher {
  append(boardId: string, ch: string): void;
  /** Immediately flush any pending bytes. Exposed for tests. */
  flushNow(): void;
}

export function createSerialBatcher(flush: BatchFlush): SerialBatcher {
  const buf = new Map<string, string>();
  let scheduled = false;

  let timer: ReturnType<typeof setTimeout> | null = null;

  const doFlush = () => {
    scheduled = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (buf.size === 0) return;
    const snapshot = new Map(buf);
    buf.clear();
    flush(snapshot);
  };

  // The frame that loses the race to the timer still fires later: it finds
  // nothing scheduled and leaves the bytes that came since to their own.
  const onFrame = () => {
    if (scheduled) doFlush();
  };

  const schedule = () => {
    scheduled = true;
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(onFrame, 0);
      return;
    }
    requestAnimationFrame(onFrame);
    timer = setTimeout(onFrame, FRAME_WAIT_MS);
  };

  return {
    append(boardId, ch) {
      buf.set(boardId, (buf.get(boardId) ?? '') + ch);
      if (!scheduled) schedule();
    },
    flushNow() {
      doFlush();
    },
  };
}

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
 */

export type BatchFlush = (perBoard: Map<string, string>) => void;

export interface SerialBatcher {
  append(boardId: string, ch: string): void;
  /** Immediately flush any pending bytes. Exposed for tests. */
  flushNow(): void;
}

export function createSerialBatcher(flush: BatchFlush): SerialBatcher {
  const buf = new Map<string, string>();
  let scheduled = false;

  const raf: (cb: () => void) => void =
    typeof requestAnimationFrame === 'function'
      ? (cb) => {
          requestAnimationFrame(cb);
        }
      : (cb) => {
          setTimeout(cb, 0);
        };

  const doFlush = () => {
    scheduled = false;
    if (buf.size === 0) return;
    const snapshot = new Map(buf);
    buf.clear();
    flush(snapshot);
  };

  return {
    append(boardId, ch) {
      buf.set(boardId, (buf.get(boardId) ?? '') + ch);
      if (!scheduled) {
        scheduled = true;
        raf(doFlush);
      }
    },
    flushNow() {
      scheduled = false;
      doFlush();
    },
  };
}

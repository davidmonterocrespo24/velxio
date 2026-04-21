/**
 * Verifies createSerialBatcher coalesces many per-byte appends into a single
 * RAF-scheduled flush, preserving byte order and grouping by board.
 *
 * Regression guard: `Serial.println` at 200 Hz fires ~600 callbacks/sec. If
 * the batcher ever reverts to per-byte flushing, the "Maximum update depth
 * exceeded" React error returns in the simulator.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSerialBatcher } from '../store/serialBatcher';

describe('createSerialBatcher', () => {
  let rafCalls: Array<() => void>;
  let rafSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    rafCalls = [];
    rafSpy = vi.fn((cb: () => void) => {
      rafCalls.push(cb);
      return rafCalls.length;
    });
    vi.stubGlobal('requestAnimationFrame', rafSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('coalesces 10_000 synchronous appends into a single RAF flush', () => {
    const flush = vi.fn();
    const batcher = createSerialBatcher(flush);

    for (let i = 0; i < 10_000; i++) {
      batcher.append('arduino-uno', String.fromCharCode(65 + (i % 26)));
    }

    expect(rafSpy).toHaveBeenCalledTimes(1);
    expect(flush).not.toHaveBeenCalled();

    rafCalls[0]();

    expect(flush).toHaveBeenCalledTimes(1);
    const snapshot = flush.mock.calls[0][0] as Map<string, string>;
    expect(snapshot.get('arduino-uno')?.length).toBe(10_000);
  });

  it('preserves byte order', () => {
    const flush = vi.fn();
    const batcher = createSerialBatcher(flush);

    const msg = 'Hello, World!\n';
    for (const ch of msg) batcher.append('b1', ch);

    rafCalls[0]();
    expect(flush.mock.calls[0][0].get('b1')).toBe(msg);
  });

  it('groups chunks per board', () => {
    const flush = vi.fn();
    const batcher = createSerialBatcher(flush);

    batcher.append('a', 'A1');
    batcher.append('b', 'B1');
    batcher.append('a', 'A2');
    batcher.append('b', 'B2');

    rafCalls[0]();
    const snap = flush.mock.calls[0][0] as Map<string, string>;
    expect(snap.get('a')).toBe('A1A2');
    expect(snap.get('b')).toBe('B1B2');
  });

  it('re-schedules after flush for subsequent appends', () => {
    const flush = vi.fn();
    const batcher = createSerialBatcher(flush);

    batcher.append('x', 'hi');
    rafCalls[0]();
    batcher.append('x', ' there');

    expect(rafSpy).toHaveBeenCalledTimes(2);
    rafCalls[1]();
    expect(flush.mock.calls[1][0].get('x')).toBe(' there');
  });

  it('flushNow drains synchronously without waiting for RAF', () => {
    const flush = vi.fn();
    const batcher = createSerialBatcher(flush);

    batcher.append('x', 'sync');
    batcher.flushNow();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0].get('x')).toBe('sync');
  });

  it('supports destructured { append } usage (regression guard)', () => {
    // useSimulatorStore uses `const { append: appendSerial } = createSerialBatcher(...)`
    // and calls `appendSerial(boardId, ch)`. If `append` ever stops being
    // safely destructurable (e.g. gets turned into a method that captures
    // `this`), the USART callback throws "appendSerial is not a function".
    const flush = vi.fn();
    const { append } = createSerialBatcher(flush);

    expect(() => append('board', 'A')).not.toThrow();
    rafCalls[0]();
    expect(flush.mock.calls[0][0].get('board')).toBe('A');
  });
});

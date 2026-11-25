/**
 * The serial monitor of a tab in the background. No animation frame fires
 * there, a worker-hosted engine keeps printing, and what it prints has to
 * reach the store anyway: an assistant that works in that tab reads the store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSerialBatcher, FRAME_WAIT_MS } from '../store/serialBatcher';

describe('serial batching', () => {
  let frames: Array<() => void> = [];
  beforeEach(() => {
    vi.useFakeTimers();
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const runFrames = () => frames.splice(0).forEach((f) => f());

  it('flushes on the animation frame, once, in order and by board', () => {
    const flush = vi.fn();
    const b = createSerialBatcher(flush);
    b.append('uno', 'a');
    b.append('esp', 'x');
    b.append('uno', 'b');
    runFrames();
    expect(flush).toHaveBeenCalledTimes(1);
    expect([...flush.mock.calls[0][0]]).toEqual([['uno', 'ab'], ['esp', 'x']]);
    vi.advanceTimersByTime(FRAME_WAIT_MS * 3);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('flushes without a frame when the tab is in the background', () => {
    const flush = vi.fn();
    const b = createSerialBatcher(flush);
    b.append('esp', 'ESP-ROM\r\n');
    b.append('esp', '[1] ready\r\n');
    vi.advanceTimersByTime(FRAME_WAIT_MS);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0].get('esp')).toBe('ESP-ROM\r\n[1] ready\r\n');
    b.append('esp', 'more');
    vi.advanceTimersByTime(FRAME_WAIT_MS);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('a frame that comes after the timer does not flush half a batch', () => {
    const flush = vi.fn();
    const b = createSerialBatcher(flush);
    b.append('esp', 'a');
    vi.advanceTimersByTime(FRAME_WAIT_MS);
    runFrames(); // the tab is back: the old frame finds nothing to do
    expect(flush).toHaveBeenCalledTimes(1);
    b.append('esp', 'b');
    runFrames();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush.mock.calls[1][0].get('esp')).toBe('b');
  });
});

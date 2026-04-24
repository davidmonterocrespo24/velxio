/**
 * Live stats feed for the Installed Plugins panel (CORE-006b step 4).
 *
 * `PluginHost.getStats()` returns a fresh `PluginHostStats` object every
 * call — there is no equality by reference. That means naive wiring with
 * `useSyncExternalStore(subscribe, () => manager.get(id)?.stats)` would
 * trip the "getSnapshot should be cached" warning and spin a render loop.
 *
 * We decouple: the external store here publishes a monotonic **tick**
 * counter (stable, comparable by value) driven by a single 1 Hz
 * `setInterval` that is shared across every subscriber on the page.
 * The counter is the React-facing snapshot; the hook re-reads fresh
 * stats after each tick from `getPluginManager().get(id)?.stats`.
 *
 * Why 1 Hz? Byte/request counters move slowly enough that a higher
 * rate does not help the user; a lower rate makes the panel feel dead.
 * The timer is armed lazily on first subscriber and cleared on last —
 * closing the modal stops the wakeup cycle (no background drain).
 *
 * Why sit outside `useInstalledPluginsStore`? That store is a join
 * layer — it never owns plugin state itself (see the module docstring).
 * Stats are transient per-frame data sourced from the manager; keeping
 * them in a standalone hook preserves the invariant and makes the
 * polling lifetime (modal open/closed) match the subscriber lifetime.
 */

import { useSyncExternalStore } from 'react';

import type { PluginHostStats } from './PluginHost';
import { getPluginManager } from './PluginManager';

/** How often the stats tick fires while at least one component is subscribed. */
export const HOST_STATS_POLL_INTERVAL_MS = 1000;

let tick = 0;
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Factory for the interval timer. Replaced in tests via `__setHostStatsTimerForTests`. */
type TimerFactory = (fn: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
type TimerClearer = (handle: ReturnType<typeof setInterval>) => void;

let startTimer: TimerFactory = setInterval;
let stopTimer: TimerClearer = clearInterval;

function fireTick(): void {
  tick = (tick + 1) | 0;
  // Snapshot subscribers so that re-entrant add/remove during dispatch
  // does not mutate the set we're iterating.
  for (const fn of Array.from(subscribers)) {
    try {
      fn();
    } catch {
      // A misbehaving subscriber must not cut the tick short for others.
    }
  }
}

function armIfNeeded(): void {
  if (timer !== null) return;
  timer = startTimer(fireTick, HOST_STATS_POLL_INTERVAL_MS);
}

function disarmIfIdle(): void {
  if (timer !== null && subscribers.size === 0) {
    stopTimer(timer);
    timer = null;
  }
}

function subscribe(onChange: () => void): () => void {
  subscribers.add(onChange);
  armIfNeeded();
  return () => {
    subscribers.delete(onChange);
    disarmIfIdle();
  };
}

function getTickSnapshot(): number {
  return tick;
}

/**
 * React hook — re-renders on each 1 Hz tick while the component is
 * mounted and returns the latest stats for `pluginId`. Returns `null`
 * when the plugin has no active host (not loaded, failed, unloaded).
 *
 * The returned object identity is **new on every tick** by design —
 * `PluginHost.getStats()` produces a fresh object each call. Consumers
 * that care about identity-stable slices should pull individual
 * numeric fields and pass those to `useMemo`/`React.memo`.
 */
export function usePluginHostStats(pluginId: string): PluginHostStats | null {
  useSyncExternalStore(subscribe, getTickSnapshot, getTickSnapshot);
  const entry = getPluginManager().get(pluginId);
  return entry?.stats ?? null;
}

/**
 * Non-hook accessor — a one-shot read for code paths that are not
 * running inside a React render (tests, telemetry snapshots). Does NOT
 * drive polling; returns whatever the manager currently holds.
 */
export function getPluginHostStats(pluginId: string): PluginHostStats | null {
  return getPluginManager().get(pluginId)?.stats ?? null;
}

/**
 * Force a tick immediately. Used by tests to avoid leaning on real
 * wall-clock timers. In production there is no caller.
 */
export function __fireHostStatsTickForTests(): void {
  fireTick();
}

/**
 * Swap the timer factory (for tests that use fake timers or want to
 * assert the factory is never called when there are zero subscribers).
 * Passing `null` restores `setInterval` / `clearInterval`.
 */
export function __setHostStatsTimerForTests(
  factories: { start: TimerFactory; stop: TimerClearer } | null,
): void {
  if (factories === null) {
    startTimer = setInterval;
    stopTimer = clearInterval;
    return;
  }
  startTimer = factories.start;
  stopTimer = factories.stop;
}

/** Test-only: reset the module-scope singletons. */
export function __resetHostStatsForTests(): void {
  if (timer !== null) {
    stopTimer(timer);
    timer = null;
  }
  subscribers.clear();
  tick = 0;
  startTimer = setInterval;
  stopTimer = clearInterval;
}

/** Test-only: current subscriber count. */
export function __getHostStatsSubscriberCountForTests(): number {
  return subscribers.size;
}

/** Test-only: whether the interval timer is currently armed. */
export function __isHostStatsTimerArmedForTests(): boolean {
  return timer !== null;
}

/**
 * Test-only: subscribe a raw callback to the tick source without going
 * through React. Returns the unsubscribe. Lets tests assert that
 * `fireTick()` tolerates a throwing subscriber without cutting the
 * dispatch loop short.
 */
export function __subscribeHostStatsForTests(fn: () => void): () => void {
  return subscribe(fn);
}

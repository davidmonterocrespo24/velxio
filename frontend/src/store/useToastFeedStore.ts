/**
 * `useToastFeedStore` — in-modal feed surface for `auto-approve-with-toast`
 * plugin updates (SDK-008d).
 *
 * The "toast" name is historical: today the surface is the in-modal banner
 * inside the Installed Plugins panel (Option A in the SDK-008d task spec),
 * not a global toast container. When the editor grows a real toast
 * container (Option B) the store will keep the same shape and only the
 * sink will move.
 *
 * Lifecycle:
 *
 *   - `push(event)` is called from `App.tsx`'s `configureInstallFlow`
 *     wiring — every `auto-approve-with-toast` update emits one event.
 *   - Entries carry a millisecond `pushedAt` timestamp. `getRecent()`
 *     filters by a 24h TTL on read so a banner that has not been opened
 *     for a day will see an empty feed without us running a sweeper.
 *   - `dismiss(eventId)` removes one entry; `dismissAll()` clears the
 *     feed without a TTL filter.
 *   - The full state is persisted in `sessionStorage` so a page reload
 *     within the session keeps the feed (matches "show me what
 *     happened recently" UX) but a new tab starts empty.
 *
 * The store is intentionally small and append-mostly. We never compact
 * `entries` on push because the cap is bounded (`MAX_ENTRIES`) and
 * filtering on read is O(n) over a small array.
 */

import { create } from 'zustand';

import type { InstallToastEvent } from '../plugin-host/InstallFlowController';

export const TOAST_FEED_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 50;
const STORAGE_KEY = 'velxio.pluginUpdateToasts';

export interface ToastFeedEntry extends InstallToastEvent {
  /** Locally-generated id; stable across renders. */
  readonly id: string;
  /** Wall-clock time the event was pushed (`Date.now()`). */
  readonly pushedAt: number;
}

export interface ToastFeedStoreState {
  /**
   * All non-dismissed entries the store holds. May contain entries
   * older than `TOAST_FEED_TTL_MS` — `getRecent()` does the filtering.
   */
  readonly entries: readonly ToastFeedEntry[];
  /** Increment whenever `entries` mutates — drives `useSyncExternalStore`. */
  readonly tick: number;

  /**
   * Append a fresh `InstallToastEvent` to the feed. De-duplicates by
   * `(pluginId, toVersion)` so a rapid retry tick that re-classifies the
   * same update does not stack identical banners.
   */
  push(event: InstallToastEvent): void;
  /** Remove one entry by id. No-op for unknown ids. */
  dismiss(entryId: string): void;
  /** Empty the feed. */
  dismissAll(): void;
  /**
   * Entries newer than `TOAST_FEED_TTL_MS`, sorted newest first. Pure
   * read — the store does not mutate stale entries, just filters them
   * out. They are GC'd next time the store is hydrated from storage.
   */
  getRecent(now?: number): readonly ToastFeedEntry[];

  /** Test-only. Wipes state and storage. */
  __resetForTests(): void;
}

// ── Storage layer ────────────────────────────────────────────────────────

function loadFromStorage(): ToastFeedEntry[] {
  try {
    if (typeof sessionStorage === 'undefined') return [];
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    const out: ToastFeedEntry[] = [];
    for (const candidate of parsed) {
      const entry = coerceEntry(candidate);
      if (entry === null) continue;
      if (now - entry.pushedAt > TOAST_FEED_TTL_MS) continue;
      out.push(entry);
    }
    // Cap on hydration in case a previous session over-filled.
    return out.slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

function persistToStorage(entries: readonly ToastFeedEntry[]): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // sessionStorage quota / private mode → drop silently. The feed
    // remains in-memory for the rest of the session, which is the right
    // failure mode (the persisted blob is a nice-to-have, not load-bearing).
  }
}

function coerceEntry(candidate: unknown): ToastFeedEntry | null {
  if (candidate === null || typeof candidate !== 'object') return null;
  const c = candidate as Record<string, unknown>;
  if (typeof c.id !== 'string') return null;
  if (typeof c.pluginId !== 'string') return null;
  if (typeof c.fromVersion !== 'string') return null;
  if (typeof c.toVersion !== 'string') return null;
  if (typeof c.pushedAt !== 'number') return null;
  if (!Array.isArray(c.added)) return null;
  return {
    id: c.id,
    pluginId: c.pluginId,
    fromVersion: c.fromVersion,
    toVersion: c.toVersion,
    pushedAt: c.pushedAt,
    added: c.added as ToastFeedEntry['added'],
  };
}

// ── ID generation ────────────────────────────────────────────────────────

let _idSeq = 0;
function nextEntryId(): string {
  _idSeq += 1;
  return `toast-${Date.now()}-${_idSeq}`;
}

// ── Store ────────────────────────────────────────────────────────────────

export const useToastFeedStore = create<ToastFeedStoreState>((set, get) => ({
  entries: loadFromStorage(),
  tick: 0,

  push(event: InstallToastEvent) {
    const now = Date.now();
    const existing = get().entries;
    // De-dupe: same (pluginId, toVersion) — drop the older one.
    const filtered = existing.filter(
      (e) => !(e.pluginId === event.pluginId && e.toVersion === event.toVersion),
    );
    const next: ToastFeedEntry = {
      id: nextEntryId(),
      pluginId: event.pluginId,
      fromVersion: event.fromVersion,
      toVersion: event.toVersion,
      added: event.added,
      pushedAt: now,
    };
    const combined = [...filtered, next];
    // Cap so a misbehaving caller can't blow up sessionStorage.
    const trimmed = combined.length > MAX_ENTRIES
      ? combined.slice(-MAX_ENTRIES)
      : combined;
    persistToStorage(trimmed);
    set({ entries: trimmed, tick: get().tick + 1 });
  },

  dismiss(entryId: string) {
    const filtered = get().entries.filter((e) => e.id !== entryId);
    if (filtered.length === get().entries.length) return;
    persistToStorage(filtered);
    set({ entries: filtered, tick: get().tick + 1 });
  },

  dismissAll() {
    if (get().entries.length === 0) return;
    persistToStorage([]);
    set({ entries: [], tick: get().tick + 1 });
  },

  getRecent(now: number = Date.now()) {
    const cutoff = now - TOAST_FEED_TTL_MS;
    return get().entries
      .filter((e) => e.pushedAt >= cutoff)
      .slice()
      .sort((a, b) => b.pushedAt - a.pushedAt);
  },

  __resetForTests() {
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch { /* ignore */ }
    _idSeq = 0;
    set({ entries: [], tick: 0 });
  },
}));

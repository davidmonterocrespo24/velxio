/**
 * `HostSlotRegistry` — the host-side aggregator that gives `<SlotOutlet />`
 * a single source of truth across every loaded plugin.
 *
 * ## Why an aggregator
 *
 * SDK-002 made each plugin's UI registries (`commands`, `toolbar`, etc.)
 * **per-plugin** instances, so disposing one plugin tears down only its
 * own contributions. That is correct for the lifecycle, but bad for a
 * renderer: the editor would otherwise have to subscribe to every single
 * `InMemoryXxxRegistry` of every loaded plugin, re-discover them when a
 * plugin is loaded/unloaded, and merge the lists by hand. The aggregator
 * does that once, in the host, and exposes a flat `(slotId) → items[]`
 * snapshot keyed by stable slot ids.
 *
 * ## How it stays in sync
 *
 * `mountPlugin(pluginId, ui)` subscribes to each per-plugin registry's
 * `subscribe()` callback. On every notify, the aggregator runs a small
 * diff against the registry's current `entries()` and updates its own
 * slot tables (additions, deletions, replacements). The bridge returns
 * a `Disposable` — the host adds it to the plugin's `subscriptions`
 * store so the bridge dies with the plugin and removes every item the
 * plugin contributed.
 *
 * ## How `<SlotOutlet />` reads
 *
 * `subscribe(slotId, fn)` re-fires `fn` only when the items of THAT
 * specific slot changed. The slot is computed by the static
 * `SLOT_ROUTING` table — the aggregator knows e.g. that toolbar items
 * with `position: 'left'` belong to `editor.toolbar.left` and items
 * with `position: 'center'` belong to `simulator.toolbar`. A change to
 * one of those slots does not wake the other.
 *
 * `getEntries(slotId)` returns a stable, frozen array; React's
 * `useSyncExternalStore` will not re-render an outlet if the array
 * identity is unchanged, so a noisy plugin updating an unrelated slot
 * costs only the diff (one Map lookup per item).
 *
 * ## Performance budget (PERF-001)
 *
 * The aggregator runs entirely off the simulator hot path. It is woken
 * only by plugin load/unload + `register`/`dispose` calls, which are
 * setup-time operations. The renderer subscribes via
 * `useSyncExternalStore` whose snapshot equality skips renders. The
 * worst case is N plugins × M items per plugin during a hot reload —
 * still O(N·M) once, never per frame.
 */

import type {
  CommandDefinition,
  ToolbarItemDefinition,
  PanelDefinition,
  StatusBarItemDefinition,
  EditorActionDefinition,
  CanvasOverlayDefinition,
  ContextMenuItemDefinition,
  Disposable,
} from '@velxio/sdk';

import type { PluginUIRegistries } from './createPluginContext';
import { ALL_SLOT_IDS, SLOT_ROUTING, type SlotId } from './SlotIds';

/**
 * Each item in a slot is paired with the plugin that contributed it. This
 * is what the renderer needs to:
 *   - show "by Acme" provenance in the command palette,
 *   - route a `commandId` reference through `executeCommand` so the right
 *     plugin's command-registry handler runs,
 *   - filter slots by trust level (Pro adds a "verified" badge, etc.).
 */
export interface SlotEntry<T = unknown> {
  readonly pluginId: string;
  readonly item: T;
}

/**
 * Each per-plugin UI registry has the same minimal shape: `entries()` +
 * `subscribe(fn)`. Strongly typed below so the bridge can fan out across
 * all seven without `any`.
 */
type AnyEntry =
  | CommandDefinition
  | ToolbarItemDefinition
  | PanelDefinition
  | StatusBarItemDefinition
  | EditorActionDefinition
  | CanvasOverlayDefinition
  | ContextMenuItemDefinition;

interface PerPluginRegistryView<T extends AnyEntry> {
  entries(): ReadonlyArray<T>;
  subscribe(fn: () => void): () => void;
}

const REGISTRY_KEYS = [
  'commands',
  'toolbar',
  'panels',
  'statusBar',
  'editorActions',
  'canvasOverlays',
  'contextMenu',
] as const;
type RegistryKey = (typeof REGISTRY_KEYS)[number];

class HostSlotRegistry {
  /**
   * Per-slot table. Each slot maps `(pluginId, itemId)` → `SlotEntry`.
   * Two-level Map so a plugin's contributions can be wiped in one O(1)
   * pass when the plugin unloads.
   */
  private readonly slots: Map<SlotId, Map<string, Map<string, SlotEntry>>> = new Map();

  /**
   * Per-slot snapshot cache. Recomputed lazily on `getEntries(slotId)`
   * and reused until the next mutation in that slot. The cache is what
   * keeps `useSyncExternalStore` from re-rendering when nothing changed.
   */
  private readonly snapshotCache: Map<SlotId, ReadonlyArray<SlotEntry>> = new Map();

  /** Per-slot subscriber list — fired on changes to THAT slot only. */
  private readonly slotSubscribers: Map<SlotId, Set<() => void>> = new Map();

  /** Global subscribers — fired on any change in any slot (debug/inspector). */
  private readonly globalSubscribers = new Set<() => void>();

  constructor() {
    for (const slotId of ALL_SLOT_IDS) {
      this.slots.set(slotId, new Map());
      this.slotSubscribers.set(slotId, new Set());
    }
  }

  /**
   * Read a snapshot for one slot. Returns the same frozen array reference
   * until something changes in that slot — `useSyncExternalStore`
   * compares by identity, so nothing re-renders unnecessarily.
   */
  getEntries(slotId: SlotId): ReadonlyArray<SlotEntry> {
    const cached = this.snapshotCache.get(slotId);
    if (cached !== undefined) return cached;
    const buckets = this.slots.get(slotId);
    if (buckets === undefined || buckets.size === 0) {
      const empty: ReadonlyArray<SlotEntry> = Object.freeze([]);
      this.snapshotCache.set(slotId, empty);
      return empty;
    }
    const flat: SlotEntry[] = [];
    for (const perPlugin of buckets.values()) {
      for (const entry of perPlugin.values()) flat.push(entry);
    }
    const frozen: ReadonlyArray<SlotEntry> = Object.freeze(flat);
    this.snapshotCache.set(slotId, frozen);
    return frozen;
  }

  /** Subscribe to changes in ONE slot. */
  subscribe(slotId: SlotId, fn: () => void): () => void {
    const set = this.slotSubscribers.get(slotId);
    if (set === undefined) {
      throw new Error(`Unknown slot id: ${slotId}`);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  /** Subscribe to ANY change. Cheap-but-noisy; only the inspector should use it. */
  subscribeAll(fn: () => void): () => void {
    this.globalSubscribers.add(fn);
    return () => {
      this.globalSubscribers.delete(fn);
    };
  }

  /**
   * Connect a plugin's UI registries to the aggregator. Every time the
   * plugin registers/disposes a UI item, the aggregator's slot snapshot
   * for the affected slot is invalidated and subscribers are notified.
   *
   * Returns a `Disposable` whose `dispose()` removes every item the
   * plugin contributed and unsubscribes from the per-plugin registries.
   * Idempotent.
   */
  mountPlugin(pluginId: string, ui: PluginUIRegistries): Disposable {
    const unsubscribers: Array<() => void> = [];
    let disposed = false;

    for (const key of REGISTRY_KEYS) {
      const registry = ui[key] as PerPluginRegistryView<AnyEntry>;
      const reconcile = () => this.reconcilePluginRegistry(pluginId, key, registry);
      reconcile(); // seed initial state
      unsubscribers.push(registry.subscribe(reconcile));
    }

    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        for (const u of unsubscribers) {
          try {
            u();
          } catch {
            /* swallow — the per-plugin registry may already be torn down */
          }
        }
        this.removeAllForPlugin(pluginId);
      },
    };
  }

  /**
   * Diff one plugin's view of one registry against the aggregator's
   * current bucket and apply additions / replacements / deletions.
   */
  private reconcilePluginRegistry<T extends AnyEntry>(
    pluginId: string,
    key: RegistryKey,
    registry: PerPluginRegistryView<T>,
  ): void {
    const current = new Map<string, T>();
    for (const item of registry.entries()) {
      current.set(item.id, item);
    }
    const dirtySlots = new Set<SlotId>();

    // Walk every slot routed from this registry; reconcile its bucket.
    for (const slotId of ALL_SLOT_IDS) {
      const routing = SLOT_ROUTING[slotId];
      if (routing.source !== key) continue;

      const slotBuckets = this.slots.get(slotId);
      if (slotBuckets === undefined) continue;
      let perPlugin = slotBuckets.get(pluginId);

      // Filter current items to those that belong in THIS slot.
      const accept = routing.accepts;
      const accepted = new Map<string, T>();
      for (const [itemId, item] of current.entries()) {
        if (accept === undefined || accept(item)) {
          accepted.set(itemId, item);
        }
      }

      // No items for this slot from this plugin → drop the bucket if it existed.
      if (accepted.size === 0) {
        if (perPlugin !== undefined && perPlugin.size > 0) {
          slotBuckets.delete(pluginId);
          dirtySlots.add(slotId);
        }
        continue;
      }

      if (perPlugin === undefined) {
        perPlugin = new Map();
        slotBuckets.set(pluginId, perPlugin);
      }

      let changed = false;

      // Additions + replacements.
      for (const [itemId, item] of accepted.entries()) {
        const existing = perPlugin.get(itemId);
        if (existing === undefined || existing.item !== item) {
          perPlugin.set(itemId, { pluginId, item });
          changed = true;
        }
      }
      // Deletions — items that left this slot for this plugin.
      for (const itemId of [...perPlugin.keys()]) {
        if (!accepted.has(itemId)) {
          perPlugin.delete(itemId);
          changed = true;
        }
      }
      if (changed) dirtySlots.add(slotId);
    }

    // Notify only the slots that actually changed.
    for (const slotId of dirtySlots) {
      this.invalidateSlot(slotId);
    }
    if (dirtySlots.size > 0) this.notifyGlobal();
  }

  private removeAllForPlugin(pluginId: string): void {
    let anyChanged = false;
    for (const slotId of ALL_SLOT_IDS) {
      const buckets = this.slots.get(slotId);
      if (buckets === undefined) continue;
      if (buckets.delete(pluginId)) {
        this.invalidateSlot(slotId);
        anyChanged = true;
      }
    }
    if (anyChanged) this.notifyGlobal();
  }

  private invalidateSlot(slotId: SlotId): void {
    this.snapshotCache.delete(slotId);
    const subscribers = this.slotSubscribers.get(slotId);
    if (subscribers === undefined) return;
    for (const fn of subscribers) {
      try {
        fn();
      } catch (err) {
        // Subscriber faults must not break siblings. Logged here; the
        // SlotOutlet typically retreats to its last snapshot.
        console.error(`[plugin-host] SlotOutlet subscriber for "${slotId}" threw:`, err);
      }
    }
  }

  private notifyGlobal(): void {
    for (const fn of this.globalSubscribers) {
      try {
        fn();
      } catch (err) {
        console.error('[plugin-host] Global slot subscriber threw:', err);
      }
    }
  }

  /** Test-only — clear every slot without notifying. */
  __clearForTests(): void {
    for (const slotId of ALL_SLOT_IDS) {
      const buckets = this.slots.get(slotId);
      if (buckets) buckets.clear();
      this.snapshotCache.delete(slotId);
    }
  }
}

let instance: HostSlotRegistry | null = null;

/**
 * Per-page singleton. Acquired by `createPluginContext()` (mount) and
 * by `<SlotOutlet />` (read). Tests can call `__resetHostSlotRegistry()`
 * to start with a clean slate without disturbing module identity.
 */
export function getHostSlotRegistry(): HostSlotRegistry {
  if (instance === null) instance = new HostSlotRegistry();
  return instance;
}

/** Test helper — drop the singleton. */
export function __resetHostSlotRegistry(): void {
  instance = null;
}

export type { HostSlotRegistry };

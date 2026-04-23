/**
 * `<SlotOutlet />` — the React surface that projects plugin UI
 * contributions into specific spots in the editor.
 *
 * Reads from `getHostSlotRegistry()` via `useSyncExternalStore` so React
 * can short-circuit re-renders when the slot's snapshot identity does
 * not change. The aggregator's `getEntries(slotId)` returns a frozen
 * array reference that is reused as long as nothing in that slot
 * changed — see `HostSlotRegistry` for the cache invariant.
 *
 * ## What this component does NOT do
 *
 * - It does NOT decide what an item looks like. The `children` prop is a
 *   render function that takes one `SlotEntry` and returns whatever JSX
 *   the surface wants. A toolbar slot might render `<button>`s; a
 *   command palette might render rows in a virtualized list. The slot
 *   id is the only common contract.
 * - It does NOT execute commands. Toolbar buttons that point at a
 *   `commandId` need a wrapper that resolves the command's plugin and
 *   calls `commands.execute(id)` on its registry. That's the job of the
 *   surface layer; the outlet just enumerates.
 * - It does NOT enforce sort order. Items are returned in registration
 *   order across plugins — the surface can sort by `priority` (toolbar)
 *   or alphabetically (command palette) however it wants.
 *
 * Each `<SlotOutlet />` instance is `React.memo`'d so that re-renders
 * higher in the tree do not push the outlet through the diff again
 * unless the slot itself changed. The render function passed via
 * `children` MUST be stable (declared at module top level or wrapped
 * in `useCallback`) — passing a fresh closure every render defeats the
 * memo. We document this contract here because TypeScript can't catch
 * it.
 */

import { memo, useCallback, useSyncExternalStore } from 'react';

import { getHostSlotRegistry, type SlotEntry } from '../../plugin-host/HostSlotRegistry';
import type { SlotId } from '../../plugin-host/SlotIds';

export interface SlotOutletProps {
  /** Stable id from `SlotIds.ts`. Renaming a slot is a breaking change. */
  readonly slot: SlotId;
  /**
   * Renderer for one entry. MUST be stable across renders — declare at
   * module top level or memoize with `useCallback`.
   */
  readonly children: (entry: SlotEntry) => React.ReactNode;
  /**
   * Optional fallback when the slot is empty. Defaults to `null` so
   * empty slots collapse to nothing in the layout.
   */
  readonly fallback?: React.ReactNode;
}

const SlotOutletImpl = ({ slot, children, fallback = null }: SlotOutletProps) => {
  const subscribe = useCallback((onChange: () => void) => {
    return getHostSlotRegistry().subscribe(slot, onChange);
  }, [slot]);

  const getSnapshot = useCallback(() => {
    return getHostSlotRegistry().getEntries(slot);
  }, [slot]);

  // SSR/prerender safety: we currently don't ship plugin items into the
  // prerender pipeline, so the server snapshot is empty. Once SDK-009
  // lands a static-only contributions phase, this returns the frozen
  // server snapshot from the build.
  const getServerSnapshot = useCallback(() => {
    const empty: ReadonlyArray<SlotEntry> = Object.freeze([]);
    return empty;
  }, []);

  const entries = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  if (entries.length === 0) return <>{fallback}</>;

  return (
    <>
      {entries.map((entry) => {
        // Each item carries a stable id; pair with pluginId so two
        // plugins contributing items with the same id don't collide.
        const item = entry.item as { id: string };
        const key = `${entry.pluginId}::${item.id}`;
        return <SlotOutletEntry key={key} entry={entry} render={children} />;
      })}
    </>
  );
};

/** Stable wrapper so React reconciles per-entry, not the whole list. */
const SlotOutletEntry = memo(
  ({
    entry,
    render,
  }: {
    entry: SlotEntry;
    render: (entry: SlotEntry) => React.ReactNode;
  }) => {
    return <>{render(entry)}</>;
  },
);
SlotOutletEntry.displayName = 'SlotOutletEntry';

/**
 * Memoized so the parent surface re-rendering doesn't cascade through
 * the outlet's subscription machinery. The slot id is the only prop the
 * outlet cares about; the render fn is expected to be referentially
 * stable (see component docstring).
 */
export const SlotOutlet = memo(SlotOutletImpl);
SlotOutlet.displayName = 'SlotOutlet';

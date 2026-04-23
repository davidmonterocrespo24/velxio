/**
 * Stable slot identifiers used by the host's `<SlotOutlet />`.
 *
 * Each slot id names a specific surface in the editor where plugin
 * contributions can appear. The id strings are part of the host↔plugin
 * contract — renaming one breaks every layout that references it, so they
 * live here as a single typed enum and never as inline literals at call
 * sites.
 *
 * Slots have a fixed mapping to one of the seven UI registries
 * (`commands`, `toolbar`, `panels`, `statusBar`, `editorActions`,
 * `canvasOverlays`, `contextMenu`). The renderer resolves the source
 * registry from the slot id; plugins never address a slot directly,
 * they call `ctx.toolbar.register(...)` etc. and the host's slot
 * aggregator routes the item to whichever slot a future layout asks
 * about.
 *
 * Naming: `surface.region` (or `surface.region.bucket`). Surfaces:
 *   - `editor.*`   — anything in the code editor / file explorer area.
 *   - `simulator.*` — the canvas + its toolbar.
 *   - `command-palette` — the global Ctrl+P picker.
 */

/** Editor surface — toolbar, panels, status bar, command palette. */
export type EditorSlotId =
  | 'editor.toolbar.left'
  | 'editor.toolbar.right'
  | 'editor.panel.left'
  | 'editor.panel.right'
  | 'editor.panel.bottom'
  | 'editor.statusBar.left'
  | 'editor.statusBar.right'
  | 'editor.action.code-focus'
  | 'editor.action.canvas-focus'
  | 'editor.action.always'
  | 'file-explorer.context-menu';

/** Simulator surface — canvas overlays + canvas-area toolbar. */
export type SimulatorSlotId =
  | 'simulator.toolbar'
  | 'simulator.canvas.overlay'
  | 'simulator.context-menu.component'
  | 'simulator.context-menu.wire'
  | 'simulator.context-menu.canvas';

/** Cross-cutting: the global command palette. */
export type GlobalSlotId = 'command-palette';

export type SlotId = EditorSlotId | SimulatorSlotId | GlobalSlotId;

/**
 * Frozen runtime list — useful for tests, dev tools, and the slot debug
 * inspector. Keep in sync with the union types above; the tests in
 * `SlotOutlet.test.tsx` assert that every union member appears here.
 */
export const ALL_SLOT_IDS = [
  'editor.toolbar.left',
  'editor.toolbar.right',
  'editor.panel.left',
  'editor.panel.right',
  'editor.panel.bottom',
  'editor.statusBar.left',
  'editor.statusBar.right',
  'editor.action.code-focus',
  'editor.action.canvas-focus',
  'editor.action.always',
  'file-explorer.context-menu',
  'simulator.toolbar',
  'simulator.canvas.overlay',
  'simulator.context-menu.component',
  'simulator.context-menu.wire',
  'simulator.context-menu.canvas',
  'command-palette',
] as const satisfies ReadonlyArray<SlotId>;

/**
 * Each registry contributes to one or more slots. The aggregator uses this
 * map to route a per-plugin registry's items to the right slot bucket.
 *
 * Toolbar items carry `position: 'left' | 'right' | 'center'`; the
 * aggregator splits a single registry across two slots. Status bar items
 * carry `alignment: 'left' | 'right'` — same idea. Context menu items
 * carry `context` for the same reason. Other registries map 1-to-1.
 */
export type RegistrySource =
  | 'commands'
  | 'toolbar'
  | 'panels'
  | 'statusBar'
  | 'editorActions'
  | 'canvasOverlays'
  | 'contextMenu';

export interface SlotRouting {
  readonly source: RegistrySource;
  /**
   * Optional predicate run against each item in the source registry — items
   * that pass land in this slot. `undefined` means every item from this
   * source belongs to this slot.
   */
  readonly accepts?: (item: unknown) => boolean;
}

/**
 * Static routing table: which registry feeds which slot, and how to
 * partition items that come from the same registry but render in
 * different slots (e.g. toolbar `left` vs `right`).
 *
 * The aggregator reads this table at build time. Plugins do not see it.
 */
export const SLOT_ROUTING: Readonly<Record<SlotId, SlotRouting>> = {
  'command-palette': { source: 'commands' },
  'editor.toolbar.left': {
    source: 'toolbar',
    accepts: (i) => (i as { position?: string }).position === 'left',
  },
  'editor.toolbar.right': {
    source: 'toolbar',
    accepts: (i) => (i as { position?: string }).position === 'right',
  },
  'editor.panel.left': {
    source: 'panels',
    accepts: (i) => (i as { dock?: string }).dock === 'left',
  },
  'editor.panel.right': {
    source: 'panels',
    accepts: (i) => (i as { dock?: string }).dock === 'right',
  },
  'editor.panel.bottom': {
    source: 'panels',
    accepts: (i) => (i as { dock?: string }).dock === 'bottom',
  },
  'editor.statusBar.left': {
    source: 'statusBar',
    accepts: (i) => (i as { alignment?: string }).alignment === 'left',
  },
  'editor.statusBar.right': {
    source: 'statusBar',
    accepts: (i) => (i as { alignment?: string }).alignment === 'right',
  },
  'editor.action.code-focus': {
    source: 'editorActions',
    accepts: (i) => (i as { when?: string }).when === 'code-focus',
  },
  'editor.action.canvas-focus': {
    source: 'editorActions',
    accepts: (i) => (i as { when?: string }).when === 'canvas-focus',
  },
  'editor.action.always': {
    source: 'editorActions',
    accepts: (i) => {
      const w = (i as { when?: string }).when;
      return w === undefined || w === 'always';
    },
  },
  'simulator.toolbar': {
    source: 'toolbar',
    accepts: (i) => (i as { position?: string }).position === 'center',
  },
  'simulator.canvas.overlay': { source: 'canvasOverlays' },
  'simulator.context-menu.component': {
    source: 'contextMenu',
    accepts: (i) => (i as { context?: string }).context === 'component',
  },
  'simulator.context-menu.wire': {
    source: 'contextMenu',
    accepts: (i) => (i as { context?: string }).context === 'wire',
  },
  'simulator.context-menu.canvas': {
    source: 'contextMenu',
    accepts: (i) => (i as { context?: string }).context === 'canvas',
  },
  'file-explorer.context-menu': {
    source: 'contextMenu',
    accepts: (i) => (i as { context?: string }).context === 'file-tree',
  },
};

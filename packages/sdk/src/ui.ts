/**
 * UI extension surface.
 *
 * Plugins declare UI contributions (commands, toolbar buttons, panels) via
 * the contribution registries. Every registration returns a `Disposable` so
 * `deactivate()` can clean up.
 *
 * These interfaces deliberately do NOT expose React/DOM types directly —
 * plugins describe WHAT they want shown; the host decides HOW. This keeps
 * Pro's rendering flexible (native / webview / headless).
 */

import type { Disposable } from './components';
import type { SvgNode } from './svg';

// ── Commands ──────────────────────────────────────────────────────────────

/** A command is an action the user can invoke from the palette. */
export interface CommandDefinition {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
  /** Optional icon URL or `wokwi-icon:*` reference. */
  readonly icon?: string;
  /** When true, the command is hidden until `precondition()` is satisfied. */
  readonly precondition?: () => boolean;
  /** Handler; can be async. Host surfaces errors via notifications. */
  readonly run: () => void | Promise<void>;
}

export interface CommandRegistry {
  register(command: CommandDefinition): Disposable;
  /** Execute by id — used by toolbar/menu/keybinding glue. */
  execute(id: string): Promise<void>;
}

// ── Toolbar ───────────────────────────────────────────────────────────────

export interface ToolbarItemDefinition {
  readonly id: string;
  readonly commandId: string;
  readonly label: string;
  readonly icon?: string;
  readonly position: 'left' | 'right' | 'center';
  readonly priority?: number;
}

export interface ToolbarRegistry {
  register(item: ToolbarItemDefinition): Disposable;
}

// ── Panels ────────────────────────────────────────────────────────────────

export interface PanelDefinition {
  readonly id: string;
  readonly title: string;
  readonly dock: 'left' | 'right' | 'bottom';
  readonly initialSize?: number;
  readonly icon?: string;
  /**
   * Mount callback. The host gives you a container element; you render into
   * it with whatever framework you want. Return a teardown fn.
   */
  readonly mount: (container: HTMLElement) => () => void;
}

export interface PanelRegistry {
  register(panel: PanelDefinition): Disposable;
}

// ── Status bar ────────────────────────────────────────────────────────────

export interface StatusBarItemDefinition {
  readonly id: string;
  readonly text: string;
  readonly tooltip?: string;
  readonly alignment: 'left' | 'right';
  readonly commandId?: string;
  readonly priority?: number;
}

export interface StatusBarRegistry {
  register(item: StatusBarItemDefinition): Disposable;
  /** Update an already-registered item (text/tooltip). */
  update(id: string, patch: Partial<Omit<StatusBarItemDefinition, 'id'>>): void;
}

// ── Editor actions ────────────────────────────────────────────────────────

export interface EditorActionDefinition {
  readonly id: string;
  readonly label: string;
  readonly keybinding?: string;
  readonly when?: 'code-focus' | 'canvas-focus' | 'always';
  readonly run: () => void | Promise<void>;
}

export interface EditorActionRegistry {
  register(action: EditorActionDefinition): Disposable;
}

// ── Canvas overlays ───────────────────────────────────────────────────────

/**
 * A canvas overlay can ship as one of two shapes:
 *
 *   1. **Main-thread `mount`** — the historical form. The host hands the
 *      plugin a live `SVGGElement` and the plugin renders into it with
 *      arbitrary DOM APIs. This only works for plugins that run in the
 *      main-thread dev loader; worker-sandboxed plugins have no DOM
 *      access and a `mount` function cannot cross `postMessage`.
 *
 *   2. **Declarative `svg`** — a pure-data tree of `SvgNode`s. The host
 *      validates the tree, walks it, and builds the real SVG via
 *      `createElementNS`. Safe for worker plugins and trivially
 *      serialisable. Static for now (re-renders on next registration).
 *
 * Authors pick one. If both are supplied the host prefers `svg` and
 * ignores `mount` (with a logger warning) so the safer path wins.
 *
 * User interaction with a declarative overlay is intentionally not
 * wired yet — canvas overlays are typically passive annotations. The
 * companion interactive path is `PartSimulation.events` / `onEvent`
 * in `./simulation`.
 */
export interface CanvasOverlayDefinition {
  readonly id: string;
  /**
   * Imperative mount. Runs on the main thread; receives a live SVG
   * element sharing the canvas coordinate space. Prefer `svg` for
   * worker-safe plugins.
   */
  readonly mount?: (svg: SVGGElement) => () => void;
  /**
   * Declarative, worker-safe alternative to `mount`. The host validates
   * the tree (`validateSvgNode`) at register time and renders it on the
   * main thread via `document.createElementNS`. No scripts, no event
   * attributes, no foreignObject — see `./svg` for the schema.
   */
  readonly svg?: SvgNode;
  readonly zIndex?: number;
}

export interface CanvasOverlayRegistry {
  register(overlay: CanvasOverlayDefinition): Disposable;
}

/**
 * Identity helper for worker-safe canvas overlays. Carries no runtime
 * behaviour — exists so plugin authors can drop `mount` entirely and
 * still satisfy the `CanvasOverlayDefinition` contract with full type
 * inference.
 *
 * ```ts
 * import { defineSvgOverlay } from '@velxio/sdk';
 *
 * export const gridOverlay = defineSvgOverlay({
 *   id: 'grid',
 *   zIndex: 10,
 *   svg: {
 *     tag: 'g',
 *     attrs: { stroke: '#88888844' },
 *     children: [
 *       { tag: 'line', attrs: { x1: 0, y1: 0, x2: 1000, y2: 0 } },
 *       { tag: 'line', attrs: { x1: 0, y1: 0, x2: 0, y2: 1000 } },
 *     ],
 *   },
 * });
 * ```
 */
export function defineSvgOverlay<
  T extends Omit<CanvasOverlayDefinition, 'mount'> & { readonly svg: SvgNode },
>(definition: T): T {
  return definition;
}

// ── Context menu ──────────────────────────────────────────────────────────

export interface ContextMenuItemDefinition {
  readonly id: string;
  readonly label: string;
  readonly commandId: string;
  /** Which right-click context it shows up in. */
  readonly context: 'component' | 'wire' | 'canvas' | 'editor' | 'file-tree';
  readonly when?: (target: unknown) => boolean;
}

export interface ContextMenuRegistry {
  register(item: ContextMenuItemDefinition): Disposable;
}

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

export interface CanvasOverlayDefinition {
  readonly id: string;
  /** Mount receives an SVG element that shares the canvas's coordinate space. */
  readonly mount: (svg: SVGGElement) => () => void;
  readonly zIndex?: number;
}

export interface CanvasOverlayRegistry {
  register(overlay: CanvasOverlayDefinition): Disposable;
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

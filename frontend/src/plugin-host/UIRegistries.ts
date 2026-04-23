/**
 * In-memory implementations of the SDK's UI registries.
 *
 * These hold the registered items in a `Map<string, T>` per registry. They
 * do NOT render anything on their own — the editor reads from each registry
 * via `<SlotOutlet />` (CORE-002b) to project items into the actual UI.
 * Splitting "data store" from "renderer" lets the host:
 *
 *   - Run plugin `activate(ctx)` before the editor mounts.
 *   - Render plugin contributions during normal React rendering, no race.
 *   - Test the contract here without spinning up React.
 *
 * Each registry exposes `entries()` so the renderer can enumerate items and
 * `subscribe(fn)` so React can re-render when the set changes. `register()`
 * returns a `Disposable` that removes the item — last-writer-wins on id
 * collision, just like every other Velxio registry.
 */

import type {
  CommandDefinition,
  CommandRegistry,
  ToolbarItemDefinition,
  ToolbarRegistry,
  PanelDefinition,
  PanelRegistry,
  StatusBarItemDefinition,
  StatusBarRegistry,
  EditorActionDefinition,
  EditorActionRegistry,
  CanvasOverlayDefinition,
  CanvasOverlayRegistry,
  ContextMenuItemDefinition,
  ContextMenuRegistry,
  Disposable,
} from '@velxio/sdk';

// ── Subscriber list shared by every registry ──────────────────────────────

class Subscribers {
  private readonly fns = new Set<() => void>();
  add(fn: () => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  notify(): void {
    for (const fn of this.fns) {
      try {
        fn();
      } catch (err) {
        // A misbehaving subscriber must not break the others.
        console.error('[plugin-host] UI registry subscriber threw:', err);
      }
    }
  }
}

/**
 * Common shape: a Map keyed by id, register/dispose with last-writer-wins,
 * `entries()` for the renderer, `subscribe()` for React. Each concrete
 * registry below is a thin instantiation of this generic.
 */
class MapBackedRegistry<T extends { id: string }> {
  protected readonly items = new Map<string, T>();
  protected readonly subscribers = new Subscribers();

  protected internalRegister(item: T): Disposable {
    const previous = this.items.get(item.id);
    this.items.set(item.id, item);
    this.subscribers.notify();
    return {
      dispose: () => {
        // Slot ownership: only roll back if we still own the slot.
        if (this.items.get(item.id) !== item) return;
        if (previous === undefined) {
          this.items.delete(item.id);
        } else {
          this.items.set(item.id, previous);
        }
        this.subscribers.notify();
      },
    };
  }

  entries(): ReadonlyArray<T> {
    return [...this.items.values()];
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  size(): number {
    return this.items.size;
  }

  /** React glue — fired on every register/dispose. */
  subscribe(fn: () => void): () => void {
    return this.subscribers.add(fn);
  }

  /** Test-only — drop every item without notifying. */
  __clearForTests(): void {
    this.items.clear();
  }
}

// ── Commands ──────────────────────────────────────────────────────────────

export class InMemoryCommandRegistry
  extends MapBackedRegistry<CommandDefinition>
  implements CommandRegistry
{
  register(command: CommandDefinition): Disposable {
    return this.internalRegister(command);
  }

  /**
   * Execute by id. Errors propagate to the caller — the host's command
   * dispatcher catches and surfaces them via notification (in CORE-002b).
   */
  async execute(id: string): Promise<void> {
    const cmd = this.items.get(id);
    if (!cmd) throw new Error(`Unknown command: ${id}`);
    if (cmd.precondition && !cmd.precondition()) {
      throw new Error(`Command "${id}" precondition not satisfied`);
    }
    await cmd.run();
  }
}

// ── Toolbar ───────────────────────────────────────────────────────────────

export class InMemoryToolbarRegistry
  extends MapBackedRegistry<ToolbarItemDefinition>
  implements ToolbarRegistry
{
  register(item: ToolbarItemDefinition): Disposable {
    return this.internalRegister(item);
  }
}

// ── Panels ────────────────────────────────────────────────────────────────

export class InMemoryPanelRegistry
  extends MapBackedRegistry<PanelDefinition>
  implements PanelRegistry
{
  register(panel: PanelDefinition): Disposable {
    return this.internalRegister(panel);
  }
}

// ── Status bar ────────────────────────────────────────────────────────────

export class InMemoryStatusBarRegistry
  extends MapBackedRegistry<StatusBarItemDefinition>
  implements StatusBarRegistry
{
  register(item: StatusBarItemDefinition): Disposable {
    return this.internalRegister(item);
  }

  /**
   * Patch an existing status-bar item in place. The host uses this when an
   * item's text/tooltip changes (e.g. a "compiling…" label flipping to
   * "compiled in 1.2s"); recreating the item every change would force every
   * subscriber to re-render.
   */
  update(
    id: string,
    patch: Partial<Omit<StatusBarItemDefinition, 'id'>>,
  ): void {
    const current = this.items.get(id);
    if (!current) return;
    this.items.set(id, { ...current, ...patch });
    this.subscribers.notify();
  }
}

// ── Editor actions ────────────────────────────────────────────────────────

export class InMemoryEditorActionRegistry
  extends MapBackedRegistry<EditorActionDefinition>
  implements EditorActionRegistry
{
  register(action: EditorActionDefinition): Disposable {
    return this.internalRegister(action);
  }
}

// ── Canvas overlays ───────────────────────────────────────────────────────

export class InMemoryCanvasOverlayRegistry
  extends MapBackedRegistry<CanvasOverlayDefinition>
  implements CanvasOverlayRegistry
{
  register(overlay: CanvasOverlayDefinition): Disposable {
    return this.internalRegister(overlay);
  }
}

// ── Context menu ──────────────────────────────────────────────────────────

export class InMemoryContextMenuRegistry
  extends MapBackedRegistry<ContextMenuItemDefinition>
  implements ContextMenuRegistry
{
  register(item: ContextMenuItemDefinition): Disposable {
    return this.internalRegister(item);
  }

  /** Items filtered by `context` ('component', 'wire', etc.). */
  forContext(context: ContextMenuItemDefinition['context']): ReadonlyArray<ContextMenuItemDefinition> {
    return this.entries().filter((i) => i.context === context);
  }
}

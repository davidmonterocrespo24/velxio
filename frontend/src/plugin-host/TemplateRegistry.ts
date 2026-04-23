/**
 * Host-side template registry — singleton.
 *
 * Plugin contributions land here through `ctx.templates.register()`. The
 * editor reads from `list()` to populate the "New from template" picker.
 *
 * Validation runs at register time: a malformed snapshot or an oversized
 * bundle throws synchronously so the error reaches the plugin's
 * `activate(ctx)` call, not the user pressing the "instantiate" button.
 *
 * The registry is process-wide. There is no per-plugin partition because
 * templates are pure data; deduplication on `id` is handled by the
 * per-plugin gate in `createPluginContext`.
 */

import {
  validateProjectSnapshot,
  type Disposable,
  type RegisteredTemplate,
  type TemplateDefinition,
  type TemplateRegistry,
} from '@velxio/sdk';

class HostTemplateRegistry implements TemplateRegistry {
  private readonly entries = new Map<string, RegisteredTemplate>();
  /** Notified after every register/unregister so the React UI can re-render. */
  private readonly listeners = new Set<() => void>();

  /**
   * Register from a plugin. The caller (`createPluginContext`) is the one
   * tagging the entry with `pluginId`; we accept either the SDK signature
   * (`register(def)`) or a host-side `registerFromPlugin(def, pluginId)`.
   */
  register(definition: TemplateDefinition): Disposable {
    return this.registerFromPlugin(definition, '<host>');
  }

  registerFromPlugin(definition: TemplateDefinition, pluginId: string): Disposable {
    // Validate snapshot upfront — an InvalidTemplateError surfaces with
    // the plugin id baked in, so the author sees a useful trace.
    validateProjectSnapshot(definition.snapshot, definition.id, pluginId);
    const record: RegisteredTemplate = { definition, pluginId };
    this.entries.set(definition.id, record);
    this.notify();
    return {
      dispose: () => {
        const current = this.entries.get(definition.id);
        if (current === record) {
          this.entries.delete(definition.id);
          this.notify();
        }
      },
    };
  }

  get(id: string): RegisteredTemplate | undefined {
    return this.entries.get(id);
  }

  list(): ReadonlyArray<RegisteredTemplate> {
    // Stable order: category bucket then alphabetical name. UI relies on
    // this so picker columns don't reorder when a plugin loads after others.
    return Array.from(this.entries.values()).sort((a, b) => {
      if (a.definition.category !== b.definition.category) {
        return a.definition.category.localeCompare(b.definition.category);
      }
      return a.definition.name.localeCompare(b.definition.name);
    });
  }

  size(): number {
    return this.entries.size;
  }

  /** Subscribe to mutation events. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Test helper — wipe state between tests. */
  clearForTests(): void {
    this.entries.clear();
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Listener errors are not the registry's problem — swallow so a
        // misbehaving subscriber can't block plugin teardown.
      }
    }
  }
}

let singleton: HostTemplateRegistry | null = null;

export function getTemplateRegistry(): HostTemplateRegistry {
  if (singleton === null) singleton = new HostTemplateRegistry();
  return singleton;
}

export function resetTemplateRegistryForTests(): void {
  singleton = null;
}

export type { HostTemplateRegistry };

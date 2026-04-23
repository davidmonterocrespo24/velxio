/**
 * Host-side plugin settings — singleton registry + per-plugin `SettingsAPI`
 * factory.
 *
 * Each plugin declares one schema via `ctx.settings.declare()`. The host
 * persists the values per (user, pluginId) and notifies the plugin (and
 * later the renderer in the editor's Settings panel) on changes.
 *
 * Persistence boundary: in this commit values live in an in-memory Map
 * keyed by pluginId. The eventual swap to IndexedDB / `plugin_installs.
 * settings_json` happens behind the same `SettingsBackend` seam — the
 * SDK contract does not change.
 *
 * Permission model: `ctx.settings.declare()` requires `settings.declare`.
 * `get` / `set` / `reset` / `onChange` need NO permission once a schema
 * is declared, because the values belong to the plugin's own namespace
 * and there is nothing sensitive to gate beyond "you must own a schema
 * here". This matches `ctx.i18n` (read-only data) and stops short of
 * over-gating the way storage does.
 */

import {
  applyAndValidate,
  validateSettingsSchema,
  type Disposable,
  type PluginLogger,
  type PluginManifest,
  type SettingsAPI,
  type SettingsDeclaration,
  type SettingsSchema,
  type SettingsValidationResult,
  type SettingsValues,
} from '@velxio/sdk';

/**
 * Walk the schema and pull every declared `default` into a plain values
 * object — no validation. Defaults intentionally bypass per-field
 * checks so a form can render its empty state even when the default
 * itself violates a constraint (e.g. `default: ''` on a string with
 * `minLength: 4` — the user sees the empty input and learns the rule
 * via a validation error on `set()`).
 */
function fillDefaultsRaw(schema: SettingsSchema): SettingsValues {
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.type === 'object') {
      const inner: Record<string, unknown> = {};
      for (const [k, p] of Object.entries(prop.properties)) {
        if ('default' in p && p.default !== undefined) inner[k] = p.default;
      }
      if (Object.keys(inner).length > 0) out[key] = inner;
    } else if ('default' in prop && prop.default !== undefined) {
      out[key] = prop.default;
    }
  }
  return out as SettingsValues;
}

// ─── Persistence backend ───────────────────────────────────────────────────

/**
 * Async key/value store for settings values, scoped per plugin. The
 * default implementation is an in-memory Map; production builds can
 * pass a backend that hits IndexedDB or the Pro backend's
 * `plugin_installs.settings_json` column.
 */
export interface SettingsBackend {
  read(pluginId: string): Promise<SettingsValues | undefined>;
  write(pluginId: string, values: SettingsValues): Promise<void>;
  clear(pluginId: string): Promise<void>;
}

export class InMemorySettingsBackend implements SettingsBackend {
  private readonly store = new Map<string, SettingsValues>();

  async read(pluginId: string): Promise<SettingsValues | undefined> {
    return this.store.get(pluginId);
  }

  async write(pluginId: string, values: SettingsValues): Promise<void> {
    this.store.set(pluginId, values);
  }

  async clear(pluginId: string): Promise<void> {
    this.store.delete(pluginId);
  }

  /** Test helper. */
  clearAllForTests(): void {
    this.store.clear();
  }
}

// ─── Registry singleton ────────────────────────────────────────────────────

interface PluginEntry {
  readonly pluginId: string;
  schema: SettingsSchema;
  validate: SettingsDeclaration['validate'];
  cachedValues: SettingsValues | undefined; // populated lazily on first get/set
}

class HostSettingsRegistry {
  private readonly entries = new Map<string, PluginEntry>();
  private readonly listeners = new Set<() => void>();
  private backend: SettingsBackend = new InMemorySettingsBackend();

  setBackend(backend: SettingsBackend): void {
    this.backend = backend;
  }

  getBackend(): SettingsBackend {
    return this.backend;
  }

  upsert(pluginId: string, declaration: SettingsDeclaration): PluginEntry {
    const existing = this.entries.get(pluginId);
    const validated = validateSettingsSchema(declaration.schema, pluginId);

    let cachedValues: SettingsValues | undefined;
    if (existing?.cachedValues !== undefined) {
      // Two-pass schema migration:
      //   1) keep values that still validate against the new schema
      //      (`r1.values` is populated even on failure — invalid keys are
      //      simply absent from it),
      //   2) re-fill defaults for the dropped keys by passing the kept
      //      slice as `current` with an empty partial,
      //   3) raw defaults underneath catch any default that fails its own
      //      schema check (matches the read shape returned by `get()`).
      const r1 = applyAndValidate(validated, existing.cachedValues, {});
      const kept = r1.values ?? ({} as SettingsValues);
      const r2 = applyAndValidate(validated, {}, kept);
      const validatedValues = r2.values ?? kept;
      cachedValues = { ...fillDefaultsRaw(validated), ...validatedValues };
    }

    // Always create a NEW entry on re-declare so the OLD declare's
    // `dispose()` can detect (via `registry.get(pluginId) === entry`)
    // that it no longer owns the live declaration and bail out.
    const entry: PluginEntry = {
      pluginId,
      schema: validated,
      validate: declaration.validate,
      cachedValues,
    };
    this.entries.set(pluginId, entry);
    this.notify();
    return entry;
  }

  remove(pluginId: string): void {
    if (this.entries.delete(pluginId)) {
      this.notify();
    }
  }

  get(pluginId: string): PluginEntry | undefined {
    return this.entries.get(pluginId);
  }

  list(): ReadonlyArray<PluginEntry> {
    return Array.from(this.entries.values()).sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Test helper: drop every declaration and reset the backend to in-memory. */
  clearForTests(): void {
    this.entries.clear();
    this.listeners.clear();
    this.backend = new InMemorySettingsBackend();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Subscriber errors are theirs to handle.
      }
    }
  }
}

let singleton: HostSettingsRegistry | null = null;

export function getSettingsRegistry(): HostSettingsRegistry {
  if (singleton === null) singleton = new HostSettingsRegistry();
  return singleton;
}

export function resetSettingsRegistryForTests(): void {
  singleton = null;
}

export type { HostSettingsRegistry };

// ─── Per-plugin SettingsAPI factory ───────────────────────────────────────

/**
 * Build the `SettingsAPI` instance for a single plugin. The factory
 * captures `manifest`/`logger` so all errors and listener throws route
 * through the plugin's own logger with the right prefix.
 *
 * `declare()` is what `createPluginContext`'s gate calls (after
 * checking the `settings.declare` permission); the API is otherwise
 * permission-free.
 */
export function createPluginSettings(
  manifest: PluginManifest,
  logger: PluginLogger,
  registry: HostSettingsRegistry = getSettingsRegistry(),
): SettingsAPI {
  const pluginId = manifest.id;
  const onChangeListeners = new Set<(values: SettingsValues) => void>();

  function ensureEntry(): PluginEntry {
    const entry = registry.get(pluginId);
    if (entry === undefined) {
      // The SDK contract says reads return `{}` when no schema is declared,
      // and writes throw the same way the API would if the plugin called
      // `set()` before `declare()` — but the path is structurally callable,
      // so we let `get()` return `{}` and have `set()` reject explicitly.
      throw new Error(
        `Plugin "${pluginId}" called settings API before declare(); declare a schema first.`,
      );
    }
    return entry;
  }

  async function loadCached(entry: PluginEntry): Promise<SettingsValues> {
    if (entry.cachedValues !== undefined) return entry.cachedValues;
    const persisted = await registry.getBackend().read(pluginId);
    // Run defaults+validation against the schema even on read — the
    // persisted blob may predate a schema migration, so missing fields
    // pick up new defaults instead of being left undefined. We use
    // `r.values` regardless of `r.ok`: `get()` is a read; surfacing
    // defaults for required-but-empty fields is the right shape, and
    // validation errors only matter on `set()`. The raw defaults are
    // layered underneath so even keys whose default fails its own
    // schema constraint (e.g. an empty `''` for a `minLength: 4`
    // string) still appear in the read shape.
    const r = applyAndValidate(entry.schema, persisted ?? {}, {});
    const validated = r.values ?? ({} as SettingsValues);
    entry.cachedValues = { ...fillDefaultsRaw(entry.schema), ...validated };
    return entry.cachedValues;
  }

  function fireOnChange(values: SettingsValues): void {
    const snapshot = Array.from(onChangeListeners);
    for (const fn of snapshot) {
      try {
        fn(values);
      } catch (err) {
        logger.error('settings.onChange listener threw:', err);
      }
    }
  }

  return {
    declare(declaration: SettingsDeclaration): Disposable {
      const entry = registry.upsert(pluginId, declaration);
      // Pre-warm the cache so the first `get()` from a UI render path is
      // synchronous-ish (no I/O storm at panel open). Errors here are
      // logged and ignored — the next `get()` will retry.
      loadCached(entry).catch((err) => {
        logger.error('failed to load persisted settings:', err);
      });
      return {
        dispose: () => {
          // Only remove if this declaration is still the live one. A
          // re-declare overwrites in place; disposing the original handle
          // afterwards would otherwise wipe a still-valid schema.
          if (registry.get(pluginId) === entry) {
            registry.remove(pluginId);
          }
        },
      };
    },

    async get(): Promise<SettingsValues> {
      const entry = registry.get(pluginId);
      if (entry === undefined) return {} as SettingsValues;
      return loadCached(entry);
    },

    async set(partial: SettingsValues): Promise<SettingsValidationResult> {
      const entry = ensureEntry();
      const current = await loadCached(entry);
      const schemaResult = applyAndValidate(entry.schema, partial, current);
      if (!schemaResult.ok) return { ok: false, errors: schemaResult.errors };
      const next = schemaResult.values!;
      if (entry.validate) {
        const pluginResult = await entry.validate(next);
        if (!pluginResult.ok) return pluginResult;
      }
      entry.cachedValues = next;
      await registry.getBackend().write(pluginId, next);
      fireOnChange(next);
      return { ok: true };
    },

    async reset(): Promise<void> {
      const entry = ensureEntry();
      // Same as `loadCached`: defaults are the read-shape; required-empty
      // doesn't disqualify them from being returned/persisted, and raw
      // defaults are layered under the validated set so even
      // self-invalid defaults survive.
      const r = applyAndValidate(entry.schema, {}, {});
      const validated = r.values ?? ({} as SettingsValues);
      const cleared = { ...fillDefaultsRaw(entry.schema), ...validated };
      entry.cachedValues = cleared;
      await registry.getBackend().write(pluginId, cleared);
      fireOnChange(cleared);
    },

    onChange(fn: (values: SettingsValues) => void): () => void {
      onChangeListeners.add(fn);
      return () => {
        onChangeListeners.delete(fn);
      };
    },
  };
}

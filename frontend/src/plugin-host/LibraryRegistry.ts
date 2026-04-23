/**
 * Host-side Arduino library registry — singleton.
 *
 * Plugins register library bundles via `ctx.libraries.register()`. The
 * client-side compile middleware reads from `list()` (or `resolve()`) at
 * compile time and injects the library files into the sketch payload sent
 * to `arduino-cli`. Nothing here downloads from the network — every byte
 * comes from the plugin bundle.
 *
 * Ids must be unique because arduino-cli identifies libraries by folder
 * name; the per-plugin gate in `createPluginContext` enforces uniqueness
 * with `DuplicateLibraryError` so authors see the conflict at activation.
 */

import {
  validateLibraryDefinition,
  LibraryDependencyCycleError,
  type Disposable,
  type LibraryDefinition,
  type LibraryRegistry,
  type RegisteredLibrary,
} from '@velxio/sdk';

class HostLibraryRegistry implements LibraryRegistry {
  private readonly entries = new Map<string, RegisteredLibrary>();
  private readonly listeners = new Set<() => void>();
  /**
   * Cached sorted snapshot. Same rationale as TemplateRegistry — keeps
   * `useSyncExternalStore` happy and lets `compileCode()` pay the sort
   * cost once per mutation instead of once per compile.
   */
  private snapshotCache: ReadonlyArray<RegisteredLibrary> | null = null;

  register(definition: LibraryDefinition): Disposable {
    return this.registerFromPlugin(definition, '<host>');
  }

  registerFromPlugin(definition: LibraryDefinition, pluginId: string): Disposable {
    // Validate the bundle eagerly. Any failure throws `InvalidLibraryError`
    // with the plugin id baked in — this is the activation-time signal we
    // want plugin authors to fix in dev, not at compile time.
    validateLibraryDefinition(definition, pluginId);
    const record: RegisteredLibrary = { definition, pluginId };
    this.entries.set(definition.id, record);
    this.snapshotCache = null;
    this.notify();
    return {
      dispose: () => {
        const current = this.entries.get(definition.id);
        if (current === record) {
          this.entries.delete(definition.id);
          this.snapshotCache = null;
          this.notify();
        }
      },
    };
  }

  get(id: string): RegisteredLibrary | undefined {
    return this.entries.get(id);
  }

  list(): ReadonlyArray<RegisteredLibrary> {
    if (this.snapshotCache !== null) return this.snapshotCache;
    const sorted = Array.from(this.entries.values()).sort((a, b) =>
      a.definition.id.localeCompare(b.definition.id),
    );
    this.snapshotCache = Object.freeze(sorted);
    return this.snapshotCache;
  }

  /**
   * Topological sort of the dependency closure.
   *
   * The host's compile middleware uses this to know in what order to copy
   * library folders into the sketch directory; arduino-cli doesn't care
   * about copy order, but a stable order makes diffing build logs easier.
   *
   * Unknown ids are silently skipped — they are a runtime concern handled
   * by the compiler ("library not found"). A cycle throws
   * `LibraryDependencyCycleError`.
   */
  resolve(ids: ReadonlyArray<string>): ReadonlyArray<RegisteredLibrary> {
    const result: RegisteredLibrary[] = [];
    const seen = new Set<string>();
    const stack = new Set<string>();
    const path: string[] = [];

    const visit = (id: string): void => {
      if (seen.has(id)) return;
      const lib = this.entries.get(id);
      if (lib === undefined) return; // unknown — skip silently
      if (stack.has(id)) {
        // Cycle detected — slice from where the id first entered the path
        // to make the error message actionable.
        const cycleStart = path.indexOf(id);
        const cyclePath = [...path.slice(cycleStart), id];
        throw new LibraryDependencyCycleError(cyclePath);
      }
      stack.add(id);
      path.push(id);
      for (const dep of lib.definition.dependsOn ?? []) {
        visit(dep);
      }
      stack.delete(id);
      path.pop();
      seen.add(id);
      result.push(lib);
    };

    for (const id of ids) {
      visit(id);
    }
    return result;
  }

  size(): number {
    return this.entries.size;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Test helper. */
  clearForTests(): void {
    this.entries.clear();
    this.snapshotCache = null;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Subscriber errors don't cascade.
      }
    }
  }
}

let singleton: HostLibraryRegistry | null = null;

export function getLibraryRegistry(): HostLibraryRegistry {
  if (singleton === null) singleton = new HostLibraryRegistry();
  return singleton;
}

export function resetLibraryRegistryForTests(): void {
  singleton = null;
}

export type { HostLibraryRegistry };

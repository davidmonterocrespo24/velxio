/**
 * Host-side SPICE mapper registry.
 *
 * Wraps a `Map<metadataId, mapper>` so the Core's built-in mappers and
 * any future plugin-registered mappers share one lookup surface. The
 * registry is what implements (a subset of) the SDK's `SpiceRegistry`
 * interface — the SDK's `registerMapper` becomes `register` here, and
 * `registerModel` is delegated to a separate model registry which the
 * NetlistBuilder consults.
 *
 * Performance contract (PERF-001 / principle #0):
 *   - `lookup()` is the only hot path; it's O(1) Map.get.
 *   - Callers (NetlistBuilder) call `lookup()` **once per component
 *     per netlist build**, not per simulator tick. The hot tick path
 *     uses cached references the builder produced.
 *   - `register()` / `unregister()` are setup-time only.
 *
 * Built-ins are seeded by `componentToSpice.ts` on module load via
 * `seedBuiltinMappers()`. That keeps the giant MAPPERS table (~1100
 * lines of resistor/cap/diode/IC mappings) in one file but makes the
 * registry the single source of truth at runtime.
 */

import type {
  SpiceMapper,
  SpiceComponentView,
  SpiceEmission,
  SpiceNetLookup,
} from '@velxio/sdk';

import type { ComponentForSpice } from './types';
import type { MapperContext } from './componentToSpice';

/**
 * Internal mapper signature used by the host. Mirrors the SDK's
 * `SpiceMapper` shape but typed against `ComponentForSpice` (the host's
 * richer view) and the host's `MapperContext` (today: `{ vcc }`; the SDK
 * surface adds `analysis` which the host wraps in via `asSdkMapper`).
 */
export type HostSpiceMapper = (
  comp: ComponentForSpice,
  netLookup: SpiceNetLookup,
  ctx: MapperContext,
) => SpiceEmission | null;

export interface SpiceMapperHandle {
  dispose(): void;
}

export class SpiceMapperRegistry {
  private readonly mappers: Map<string, HostSpiceMapper> = new Map();

  /**
   * Register a mapper for a metadataId. Replaces any previous mapping
   * for that id — last-writer-wins is intentional (built-ins seed
   * first, plugin overrides second). Returns a handle to revert.
   */
  register(metadataId: string, mapper: HostSpiceMapper): SpiceMapperHandle {
    const previous = this.mappers.get(metadataId);
    this.mappers.set(metadataId, mapper);
    return {
      dispose: () => {
        // Only revert if we still own the slot. A second register() after
        // ours wins; disposing then must not clobber the newer mapper.
        if (this.mappers.get(metadataId) !== mapper) return;
        if (previous === undefined) {
          this.mappers.delete(metadataId);
        } else {
          this.mappers.set(metadataId, previous);
        }
      },
    };
  }

  /** Aliasing helper — `register(presetId, lookup(baseId))` if `baseId` exists. */
  alias(presetId: string, baseId: string): SpiceMapperHandle | null {
    const base = this.mappers.get(baseId);
    if (!base) return null;
    return this.register(presetId, base);
  }

  /** Remove a mapper by id. Returns `true` if something was removed. */
  unregister(metadataId: string): boolean {
    return this.mappers.delete(metadataId);
  }

  /** O(1) lookup. Returns `undefined` for unknown ids. */
  lookup(metadataId: string): HostSpiceMapper | undefined {
    return this.mappers.get(metadataId);
  }

  /** True if this id has a mapper. */
  has(metadataId: string): boolean {
    return this.mappers.has(metadataId);
  }

  /** Stable, sorted list of every registered id (for docs / UI hints). */
  list(): string[] {
    return [...this.mappers.keys()].sort();
  }

  /** Number of registered mappers. */
  size(): number {
    return this.mappers.size;
  }

  /** Test-only — drop every mapper. */
  __clearForTests(): void {
    this.mappers.clear();
  }
}

// ── SDK interface adapter ──────────────────────────────────────────────────

/**
 * Wrap a host registry so it satisfies the SDK's `SpiceMapper` view
 * (where the component is `SpiceComponentView`, not `ComponentForSpice`).
 * Used by future plugin-facing context to forward `registerMapper` calls.
 */
export function asSdkMapper(host: HostSpiceMapper): SpiceMapper {
  return (component: SpiceComponentView, netLookup, context) => {
    // The host's ComponentForSpice is structurally a SpiceComponentView
    // plus optional fields; the cast is safe.
    return host(component as ComponentForSpice, netLookup, context);
  };
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _registry: SpiceMapperRegistry | null = null;

export function getSpiceMapperRegistry(): SpiceMapperRegistry {
  if (_registry === null) _registry = new SpiceMapperRegistry();
  return _registry;
}

export function __resetSpiceMapperRegistryForTests(): void {
  _registry = null;
}

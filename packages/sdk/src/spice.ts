/**
 * SPICE extension surface.
 *
 * A `SpiceMapper` converts a Velxio component instance into SPICE netlist
 * cards. Plugins register mappers for their own components via
 * `ctx.spice.registerMapper(componentId, mapper)`.
 *
 * The mapper receives:
 *   - `component`: the data for this instance (id, metadataId, properties)
 *   - `netLookup(pinName)`: canonical net name for a pin, or `null` if the
 *     pin is floating (not wired anywhere). Return `null` from the mapper
 *     to skip emission entirely.
 *   - `context`: global state (supply voltage, analysis mode).
 *
 * The mapper returns `SpiceCard` entries plus the set of SPICE models it
 * depends on. The host emits matching `.model` cards at netlist-build time.
 */

/** Minimal component shape the mapper gets. */
export interface SpiceComponentView {
  readonly id: string;
  readonly metadataId: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** Callback that maps a pin name to the SPICE net name it lives on. */
export type SpiceNetLookup = (pinName: string) => string | null;

/** Shared context for a mapper invocation. */
export interface SpiceMapperContext {
  /** VCC rail in volts. */
  readonly vcc: number;
  /** The analysis ngspice will run. */
  readonly analysis: SpiceAnalysisMode;
  /**
   * Mint a SPICE net name that is unique to **this component instance**.
   *
   * A mapper that needs an internal node — e.g. a BJT model with an
   * intermediate collector tap, or a behavioural source whose output is
   * fed back through an integrator — should never invent its own net
   * name. Two instances of the same component would produce identical
   * strings and short their internal state together.
   *
   * `internalNode(suffix)` solves that: the host scopes the returned
   * name by the current component id, so two instances of the same
   * mapper get distinct nets. The same `suffix` returned twice in one
   * invocation always produces the same string (deterministic), and
   * the returned name is stable across netlist builds (so AC analyses
   * can reference the same internal node across rebuilds).
   *
   * Implementation contract (enforced by the host):
   *   - The returned net is in the namespace `n_${componentId}_${suffix}`
   *     after both `componentId` and `suffix` are sanitized to
   *     `[A-Za-z0-9_]`. Two different components cannot collide.
   *   - `suffix` MUST be a non-empty string. The host throws otherwise.
   *   - Calling `internalNode('foo')` twice within the same mapper
   *     invocation returns the same string (idempotent).
   *   - Internal nodes participate in floating-net detection just like
   *     any other auto-generated net. A floating internal node will get
   *     the same auto pull-down treatment as an unwired component pin.
   *
   * Example — a BJT with an internal Vbe tap:
   *
   * ```ts
   * defineSpiceMapper((comp, netLookup, ctx) => {
   *   const c = netLookup('C');
   *   const e = netLookup('E');
   *   if (!c || !e) return null;
   *   const internal = ctx.internalNode('vbe_tap');  // n_<comp.id>_vbe_tap
   *   return {
   *     cards: [
   *       `Q_${comp.id} ${c} ${internal} ${e} BJT_NPN`,
   *       `R_${comp.id}_base ${internal} 0 1k`,
   *     ],
   *     modelsUsed: new Set(['BJT_NPN']),
   *   };
   * });
   * ```
   */
  internalNode(suffix: string): string;
}

export type SpiceAnalysisMode =
  | { readonly kind: 'op' }
  | { readonly kind: 'tran'; readonly step: string; readonly stop: string }
  | {
      readonly kind: 'ac';
      readonly type?: 'dec' | 'oct' | 'lin';
      readonly points?: number;
      readonly fstart?: number;
      readonly fstop?: number;
    };

/** What a mapper returns. `cards` are raw ngspice lines; `modelsUsed` drives `.model` emission. */
export interface SpiceEmission {
  readonly cards: ReadonlyArray<string>;
  readonly modelsUsed: ReadonlySet<string>;
}

/** The mapper function signature. */
export type SpiceMapper = (
  component: SpiceComponentView,
  netLookup: SpiceNetLookup,
  context: SpiceMapperContext,
) => SpiceEmission | null;

/** The registry interface plugins consume. */
export interface SpiceRegistry {
  /** Register a mapper for a component id. Overrides any prior registration. */
  registerMapper(componentId: string, mapper: SpiceMapper): { dispose(): void };
  /** Register a reusable `.model` card, e.g. the BJT or diode you use. */
  registerModel(name: string, card: string): { dispose(): void };
  /** True once the underlying ngspice-WASM engine has finished booting. */
  isReady(): boolean;
}

/**
 * Identity helper for authoring `SpiceMapper` functions with type
 * inference. Equivalent to writing `: SpiceMapper` on the function but
 * lets editors infer parameter types from the helper's generic.
 *
 * ```ts
 * import { defineSpiceMapper } from '@velxio/sdk';
 * export const resistorMapper = defineSpiceMapper((comp, netLookup) => {
 *   const a = netLookup('1');
 *   const b = netLookup('2');
 *   if (!a || !b) return null;
 *   return { cards: [`R_${comp.id} ${a} ${b} 1k`], modelsUsed: new Set() };
 * });
 * ```
 */
export function defineSpiceMapper(mapper: SpiceMapper): SpiceMapper {
  return mapper;
}

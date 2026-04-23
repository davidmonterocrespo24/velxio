/**
 * Component model exposed to plugins.
 *
 * A Velxio component is an instance of a wokwi-element (or a plugin-supplied
 * web component) placed on the canvas. Plugins register `ComponentDefinition`
 * records to tell the Core how to render them in the picker and how to build
 * their DOM at runtime.
 *
 * The host (Core) owns the `ComponentRegistry`; plugins call `register()`
 * from their `activate()` lifecycle via `PluginContext.components`.
 */

/** One pin on a component. Position is relative to the component's bounding box. */
export interface PinInfo {
  /** Canonical name used everywhere (wire endpoints, netlists, property refs). */
  readonly name: string;
  /** X offset from component origin, in SVG units. */
  readonly x: number;
  /** Y offset from component origin, in SVG units. */
  readonly y: number;
  /** Human-readable label (defaults to `name`). */
  readonly label?: string;
  /** Primary electrical role — drives default wire coloring and validations. */
  readonly signal?: PinSignal;
}

export type PinSignal =
  | 'gpio'
  | 'analog'
  | 'power-vcc'
  | 'power-gnd'
  | 'serial-tx'
  | 'serial-rx'
  | 'i2c-sda'
  | 'i2c-scl'
  | 'spi-miso'
  | 'spi-mosi'
  | 'spi-sck'
  | 'spi-cs'
  | 'pwm'
  | 'unused';

/** User-editable property for a component (surfaced in the properties dialog). */
export interface ComponentPropertyDefinition {
  readonly name: string;
  readonly label?: string;
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'color';
  /** Default value. Must match `kind`. */
  readonly default: string | number | boolean;
  /** Options for `kind: 'enum'`. */
  readonly options?: ReadonlyArray<{ value: string; label: string }>;
  /** For `kind: 'number'`. */
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

/**
 * Full definition of a component type. Registered once at plugin activation.
 *
 * `id` is the single source of truth — it maps to:
 *   - `metadataId` in the canvas store
 *   - Tag name when the component is a custom element (`<wokwi-led>`).
 *   - Key in `componentToSpice` MAPPERS.
 *   - Key in `PartSimulationRegistry`.
 */
export interface ComponentDefinition {
  readonly id: string;
  /** Short label shown in the picker ("LED", "Resistor"). */
  readonly name: string;
  /** Marketplace-style category bucket. */
  readonly category: ComponentCategory;
  /** One-line description. */
  readonly description: string;
  /** SVG/HTML element tag for rendering, e.g. `wokwi-led`. */
  readonly element: string;
  readonly pins: ReadonlyArray<PinInfo>;
  readonly properties?: ReadonlyArray<ComponentPropertyDefinition>;
  /** Default width/height for placement snapping. */
  readonly size?: { readonly width: number; readonly height: number };
  /** URL to a static SVG icon — required for picker rendering. */
  readonly icon?: string;
  /** Searchable keywords for the picker ("red", "diode"). */
  readonly keywords?: ReadonlyArray<string>;
  /** Tagged "Pro" / "beta" etc. for UI badges. */
  readonly badges?: ReadonlyArray<string>;
}

export type ComponentCategory =
  | 'boards'
  | 'basic'
  | 'sensors'
  | 'displays'
  | 'actuators'
  | 'communication'
  | 'ic'
  | 'logic'
  | 'power'
  | 'instruments'
  | 'misc';

/**
 * The registry interface exposed to plugins. The host implementation lives
 * in the Core; this interface is what plugins see via `ctx.components`.
 */
export interface ComponentRegistry {
  /** Register a new component definition. Returns a Disposable that unregisters it. */
  register(definition: ComponentDefinition): Disposable;
  /**
   * Compact authoring shape: register a component plus its part simulation
   * and SPICE mapper/models in one call. The returned `Disposable` tears
   * down all registrations LIFO. If a sub-registration throws (typically
   * because of a missing permission), the prior ones are rolled back so
   * the component never appears half-registered in the picker.
   *
   * Permission requirements are the union of the underlying calls:
   *   - always: `components.register`
   *   - if `simulation` is set: `simulator.pins.read`
   *   - if `spice` or `spiceModels` is set: `simulator.spice.read`
   *
   * See `defineCompoundComponent` for the authoring helper.
   */
  registerCompound(definition: CompoundComponentDefinition): Disposable;
  /** Lookup by `id`. Returns `undefined` when not registered. */
  get(id: string): ComponentDefinition | undefined;
  /** Enumerate every known definition (including built-ins). */
  list(): ReadonlyArray<ComponentDefinition>;
}

/** Result of `registry.register()` — call `.dispose()` to unregister. */
export interface Disposable {
  dispose(): void;
}

/**
 * Thrown by `ctx.components.register()` when a plugin tries to register a
 * component whose `id` is already taken — by a built-in, by another plugin,
 * or by an earlier call from the same plugin. The host's `ComponentRegistry`
 * is intentionally last-writer-wins for built-in seeding, but plugins are
 * forbidden from silently overriding existing ids: the resulting picker
 * confusion would be a foot-gun. To replace your own registration, dispose
 * the previous handle first.
 */
export class DuplicateComponentError extends Error {
  public override readonly name = 'DuplicateComponentError';
  constructor(
    public readonly componentId: string,
    public readonly pluginId: string,
  ) {
    super(
      `Plugin "${pluginId}" tried to register component "${componentId}", but that id is already registered. Dispose the existing registration first, or pick a unique id (e.g. "${pluginId}.${componentId}").`,
    );
  }
}

/**
 * Compact authoring shape used by `defineCompoundComponent` /
 * `registry.registerCompound`. Bundles a `ComponentDefinition` together
 * with its optional part simulation, SPICE mapper, and SPICE models so
 * that a plugin can describe the entire component in one literal:
 *
 * ```ts
 * import { defineCompoundComponent, definePartSimulation, defineSpiceMapper } from '@velxio/sdk';
 *
 * export const myLed = defineCompoundComponent({
 *   id: 'my-led', name: 'My LED', category: 'basic',
 *   element: 'wokwi-led', description: '',
 *   pins: [
 *     { name: 'A', x: 0, y: 0, signal: 'gpio' },
 *     { name: 'C', x: 0, y: 10, signal: 'power-gnd' },
 *   ],
 *   simulation: definePartSimulation({
 *     onPinStateChange(pinName, state, element) { ... },
 *   }),
 *   spice: defineSpiceMapper((comp, netLookup) => ({ ... })),
 *   spiceModels: [{ name: 'D_LED', card: '.model D_LED D ...' }],
 * });
 *
 * // In activate(ctx):
 * const reg = ctx.components.registerCompound(myLed);
 * ctx.subscriptions.add(reg);
 * ```
 *
 * Each of `simulation`, `spice`, `spiceModels` is optional — the author
 * only declares what their component needs. A picker-only component is
 * just `defineCompoundComponent({ ...componentFields })`; the host runs
 * exactly one underlying registration.
 */
export interface CompoundComponentDefinition extends ComponentDefinition {
  readonly simulation?: import('./simulation').PartSimulation;
  readonly spice?: import('./spice').SpiceMapper;
  readonly spiceModels?: ReadonlyArray<{
    readonly name: string;
    readonly card: string;
  }>;
}

/**
 * Identity helper for `CompoundComponentDefinition` records. Same shape
 * as `defineComponent`/`definePartSimulation`/`defineSpiceMapper` so
 * authors get type inference without a runtime wrapper.
 */
export function defineCompoundComponent<T extends CompoundComponentDefinition>(
  definition: T,
): T {
  return definition;
}

/**
 * Identity helper that gives authors type inference on a
 * `ComponentDefinition` without forcing a runtime wrapper. Use it as:
 *
 * ```ts
 * import { defineComponent } from '@velxio/sdk';
 * export const myLed = defineComponent({
 *   id: 'my-led',
 *   name: 'My LED',
 *   category: 'basic',
 *   element: 'wokwi-led',
 *   pins: [
 *     { name: 'A', x: 0, y: 0, signal: 'gpio' },
 *     { name: 'C', x: 0, y: 10, signal: 'power-gnd' },
 *   ],
 *   description: '',
 * });
 * ```
 */
export function defineComponent<T extends ComponentDefinition>(definition: T): T {
  return definition;
}

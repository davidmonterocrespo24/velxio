/**
 * Project templates exposed to plugins.
 *
 * A "template" is a pure-data plugin contribution: a serializable snapshot
 * of a Velxio project (board kind, sketch files, components, wires) that
 * the editor can instantiate from scratch as a starting point. The user
 * sees them in a "New from template" picker.
 *
 * Templates carry **no executable code** beyond what plugins normally ship
 * with — the snapshot itself is JSON. The host validates the schema before
 * letting the template hit the canvas; mismatches fail at registration
 * time, not on instantiation, so authors find out during dev rather than
 * after publishing.
 *
 * The host (Core) owns the `TemplateRegistry`; plugins call `register()`
 * from their `activate()` lifecycle via `PluginContext.templates`.
 */

import { z } from 'zod';

import type { Disposable } from './components';

/** A single source file inside a template's sketch. */
export const TemplateSketchFileSchema = z.object({
  name: z.string().min(1).max(128),
  content: z.string().max(512_000), // 500 KB per file is plenty for a template sketch
});
export type TemplateSketchFile = z.infer<typeof TemplateSketchFileSchema>;

/** A component placement inside the snapshot. Matches the canvas store shape. */
export const TemplateComponentSchema = z.object({
  id: z.string().min(1),
  /** Component kind id — must match a registered `ComponentDefinition.id`. */
  metadataId: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  rotation: z.number().finite().optional(),
  properties: z.record(z.unknown()).optional(),
});
export type TemplateComponent = z.infer<typeof TemplateComponentSchema>;

/** A wire endpoint — pin on a specific component. */
export const TemplateWireEndpointSchema = z.object({
  componentId: z.string().min(1),
  pinName: z.string().min(1),
});
export type TemplateWireEndpoint = z.infer<typeof TemplateWireEndpointSchema>;

/** A wire between two component pins. */
export const TemplateWireSchema = z.object({
  id: z.string().min(1),
  start: TemplateWireEndpointSchema,
  end: TemplateWireEndpointSchema,
  color: z.string().optional(),
  signalType: z.string().optional(),
});
export type TemplateWire = z.infer<typeof TemplateWireSchema>;

/**
 * Serializable project snapshot. Only fields the editor consumes when
 * instantiating a template are validated — extra fields are stripped,
 * since plugin manifests are user-editable text and we don't want to
 * round-trip implementation details.
 */
export const ProjectSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  board: z.string().min(1),
  files: z.array(TemplateSketchFileSchema).min(1).max(64),
  components: z.array(TemplateComponentSchema).max(512),
  wires: z.array(TemplateWireSchema).max(2048),
});
export type ProjectSnapshot = z.infer<typeof ProjectSnapshotSchema>;

export const TEMPLATE_CATEGORIES = [
  'beginner',
  'intermediate',
  'advanced',
  'showcase',
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/** Hard cap on a template's total bytes (sum of file contents). */
export const TEMPLATE_MAX_TOTAL_BYTES = 1_048_576 as const; // 1 MB

/** Hard cap on a template's optional readme. */
export const TEMPLATE_README_MAX_BYTES = 262_144 as const; // 256 KB

/**
 * Plugin-supplied template definition.
 *
 * Validation runs at `register()` time. A template that fails validation
 * throws `InvalidTemplateError` synchronously — instantiation can never
 * surface a malformed snapshot.
 */
export interface TemplateDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: TemplateCategory;
  readonly difficulty: 1 | 2 | 3 | 4 | 5;
  readonly tags?: ReadonlyArray<string>;
  /** Optional thumbnail (data: or https: URL). Picker falls back to a placeholder if absent. */
  readonly thumbnail?: string;
  /** Markdown rendered in the picker's preview pane. Sandboxed. */
  readonly readme?: string;
  readonly snapshot: ProjectSnapshot;
}

/** Result of `registry.list()` — the registry decorates the original record with the owning plugin id. */
export interface RegisteredTemplate {
  readonly definition: TemplateDefinition;
  readonly pluginId: string;
}

export interface TemplateRegistry {
  /**
   * Register a new template. The snapshot is validated; throws
   * `InvalidTemplateError` if the schema, byte cap, or component-id rules
   * do not pass.
   */
  register(definition: TemplateDefinition): Disposable;
  /** Lookup by id — returns the most recently registered template for that id. */
  get(id: string): RegisteredTemplate | undefined;
  /** Enumerate every currently registered template, sorted by category then name. */
  list(): ReadonlyArray<RegisteredTemplate>;
}

/**
 * Thrown by `ctx.templates.register()` when the definition is malformed:
 * snapshot fails Zod validation, total bytes exceed the cap, or any other
 * structural rule is violated. The error message is plugin-author-facing.
 */
export class InvalidTemplateError extends Error {
  public override readonly name = 'InvalidTemplateError';
  constructor(
    public readonly templateId: string,
    public readonly pluginId: string,
    public readonly reason: string,
  ) {
    super(
      `Plugin "${pluginId}" tried to register template "${templateId}" but it is invalid: ${reason}`,
    );
  }
}

/**
 * Thrown by `ctx.templates.register()` when a plugin tries to register a
 * template id that is already taken (same plugin, cross-plugin, or built-in).
 * Same rationale as `DuplicateComponentError`: silent shadowing is a foot-gun.
 */
export class DuplicateTemplateError extends Error {
  public override readonly name = 'DuplicateTemplateError';
  constructor(
    public readonly templateId: string,
    public readonly pluginId: string,
  ) {
    super(
      `Plugin "${pluginId}" tried to register template "${templateId}", but that id is already registered. Dispose the existing registration first, or pick a unique id (e.g. "${pluginId}.${templateId}").`,
    );
  }
}

/**
 * Identity helper for authoring `TemplateDefinition` records with type
 * inference. The Zod schema is *not* run by this helper — it runs in the
 * registry. Define here, register in `activate(ctx)`.
 *
 * ```ts
 * import { defineTemplate } from '@velxio/sdk';
 * export const blink = defineTemplate({
 *   id: 'demo.blink',
 *   name: 'Blink',
 *   description: 'The Hello World of Arduino.',
 *   category: 'beginner',
 *   difficulty: 1,
 *   snapshot: { schemaVersion: 1, board: 'arduino-uno', files: [...], components: [], wires: [] },
 * });
 * ```
 */
export function defineTemplate<T extends TemplateDefinition>(definition: T): T {
  return definition;
}

/**
 * Programmatic validator — exposed so plugin author tools (CLI, dev server)
 * can lint a snapshot without round-tripping through the host. Returns the
 * parsed snapshot on success; throws `InvalidTemplateError` on failure.
 */
export function validateProjectSnapshot(
  snapshot: unknown,
  templateId = '<unknown>',
  pluginId = '<unknown>',
): ProjectSnapshot {
  const parsed = ProjectSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.length ? first.path.join('.') : '<root>';
    throw new InvalidTemplateError(
      templateId,
      pluginId,
      `snapshot fails schema at "${path}": ${first?.message ?? 'unknown error'}`,
    );
  }
  let total = 0;
  for (const file of parsed.data.files) {
    total += file.content.length;
    if (total > TEMPLATE_MAX_TOTAL_BYTES) {
      throw new InvalidTemplateError(
        templateId,
        pluginId,
        `total file bytes (${total}) exceed the ${TEMPLATE_MAX_TOTAL_BYTES}-byte cap`,
      );
    }
  }
  // Wire endpoint integrity: every endpoint must reference a known component.
  const componentIds = new Set(parsed.data.components.map((c) => c.id));
  for (const wire of parsed.data.wires) {
    if (!componentIds.has(wire.start.componentId)) {
      throw new InvalidTemplateError(
        templateId,
        pluginId,
        `wire "${wire.id}" references unknown start component "${wire.start.componentId}"`,
      );
    }
    if (!componentIds.has(wire.end.componentId)) {
      throw new InvalidTemplateError(
        templateId,
        pluginId,
        `wire "${wire.id}" references unknown end component "${wire.end.componentId}"`,
      );
    }
  }
  return parsed.data;
}

/**
 * Declarative SVG schema for worker-safe UI contributions.
 *
 * Plugins that run inside the Web Worker sandbox (CORE-006) have no DOM
 * access. The pre-existing UI surfaces — `CanvasOverlayDefinition.mount(svg)`
 * and `PartSimulation.attachEvents(element, sim)` — both hand the plugin a
 * live DOM node, which is unreachable across the worker boundary.
 *
 * This module defines a **declarative, data-only** alternative: the plugin
 * emits a tree of `SvgNode` objects describing what to render; the host
 * walks the tree on the main thread and builds the real SVG element using
 * `document.createElementNS`. User interaction flows back into the plugin
 * through event delegation (see `DelegatedPartEvent` in `./simulation`).
 *
 * Design goals:
 *   1. **Safe by construction.** No `<script>`, no `<foreignObject>`, no
 *      `on*` event attributes, no `javascript:` URIs. Every tag and every
 *      attribute is in an explicit allowlist — a typo becomes a validation
 *      error, not a silent no-op.
 *   2. **Cheap to validate.** Structural + size limits run in a single
 *      recursive pass. `MAX_SVG_NODES` + `MAX_SVG_DEPTH` bound the work per
 *      render regardless of what the plugin sends.
 *   3. **Transport-friendly.** Every `SvgNode` is plain JSON — serializable
 *      via `structuredClone` / `postMessage` with no function handles and
 *      no class instances. This is what lets the node survive the
 *      worker→host hop.
 *
 * Rendering lives in `frontend/src/plugin-host/mountDeclarativeSvg.ts`.
 * The host validates the incoming node at the API boundary (register-time)
 * and then again just before rendering (defence-in-depth; cheap).
 */

/**
 * Supported SVG element tag names. Intentionally small: every tag here
 * has a well-defined visual semantic and no side channel.
 *
 * Excluded on purpose:
 *   - `<script>` — arbitrary code execution.
 *   - `<foreignObject>` — lets the plugin inject raw HTML (defeats the sandbox).
 *   - `<image>` — would require HTTP allowlist integration; deferred.
 *   - `<animate*>` / `<set>` — SMIL is deprecated and has security history.
 *   - `<style>` — CSS selectors can leak cross-document state on old engines.
 */
export const ALLOWED_SVG_TAGS = [
  'g',
  'rect',
  'circle',
  'ellipse',
  'line',
  'path',
  'polygon',
  'polyline',
  'text',
  'tspan',
  'use',
  'defs',
  'title',
  'desc',
] as const;

export type SvgTag = (typeof ALLOWED_SVG_TAGS)[number];

/**
 * Per-tag attribute allowlist. Any attribute not in this list is rejected
 * at validation time. Global attributes (id, class, transform, visibility,
 * opacity, stroke / fill + variants) are inlined on every tag so authors
 * don't need to think about which subset applies.
 *
 * Notable omissions:
 *   - `style` — inline CSS would bypass our per-attribute allowlist.
 *   - `href` / `xlink:href` on anything other than `<use>` — prevents
 *     `<a href="javascript:...">` style escapes. `<use href="#foo">`
 *     is allowed because it only references in-document ids (validated
 *     via the `SVG_HREF_PATTERN` below).
 *   - `on*` — every DOM event attribute is rejected structurally by
 *     `isForbiddenAttribute` regardless of per-tag allowlist.
 */
const GLOBAL_SVG_ATTRS: ReadonlyArray<string> = [
  'id',
  'class',
  'transform',
  'visibility',
  'opacity',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'clip-path',
  'clip-rule',
  'mask',
  'pointer-events',
  // `data-*` is allowed structurally via isDataAttribute — plugins use
  // these to tag nodes for their own event delegation routing.
];

const SVG_ATTR_ALLOWLIST: Readonly<Record<SvgTag, ReadonlyArray<string>>> = {
  g: [],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  path: ['d'],
  polygon: ['points'],
  polyline: ['points'],
  text: ['x', 'y', 'dx', 'dy', 'text-anchor', 'dominant-baseline', 'font-family', 'font-size', 'font-weight'],
  tspan: ['x', 'y', 'dx', 'dy', 'text-anchor', 'font-family', 'font-size', 'font-weight'],
  use: ['href', 'x', 'y', 'width', 'height'],
  defs: [],
  title: [],
  desc: [],
};

/** `<use href>` only accepts fragment references — `#symbol-id`. */
const SVG_USE_HREF_PATTERN = /^#[A-Za-z_][A-Za-z0-9_-]*$/;

/** Hard cap on the total number of nodes in one render tree. */
export const MAX_SVG_NODES = 256;

/** Hard cap on nesting depth (root element counts as depth 1). */
export const MAX_SVG_DEPTH = 8;

/** Hard cap on the length of any single attribute value. */
export const MAX_SVG_ATTR_LENGTH = 1024;

/** Hard cap on the length of any single text node. */
export const MAX_SVG_TEXT_LENGTH = 1024;

/**
 * One node in a declarative SVG tree. `attrs` values are constrained to
 * strings and numbers so the shape is cleanly serialisable; booleans and
 * objects are rejected at validation time. `children` is either a flat
 * string (rendered as `textContent`) or a recursive list of `SvgNode`s —
 * never both.
 */
export type SvgNodeAttrs = Readonly<Record<string, string | number>>;

export interface SvgNode {
  readonly tag: SvgTag;
  readonly attrs?: SvgNodeAttrs;
  readonly children?: ReadonlyArray<SvgNode>;
  readonly text?: string;
}

/**
 * Thrown by `validateSvgNode()` when a declarative SVG fails structural
 * checks. The error message identifies the plugin that produced it plus
 * the specific field at fault — the host surfaces these via `logger.error`
 * and the plugin registration fails cleanly (no half-rendered overlay).
 */
export class InvalidSvgNodeError extends Error {
  public override readonly name = 'InvalidSvgNodeError';
  constructor(
    public readonly pluginId: string,
    public readonly reason: string,
  ) {
    super(
      `Plugin "${pluginId}" submitted an invalid SVG node: ${reason}`,
    );
  }
}

/**
 * Reject anything that smells like a DOM event attribute. Runs before the
 * per-tag allowlist so even a hypothetical future allowlist typo can't
 * open a regression.
 */
function isForbiddenAttribute(name: string): boolean {
  return name.startsWith('on');
}

function isDataAttribute(name: string): boolean {
  // data-* names per HTML: lower-case letter after `data-`, remaining chars
  // are `[a-z0-9-]`. We keep this loose to match real-world CSS-in-SVG.
  return /^data-[a-z][a-z0-9-]*$/.test(name);
}

function validateAttrValue(
  value: unknown,
  tag: SvgTag,
  attrName: string,
  pluginId: string,
): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InvalidSvgNodeError(
        pluginId,
        `non-finite number for ${tag}.${attrName}`,
      );
    }
    return;
  }
  if (typeof value !== 'string') {
    throw new InvalidSvgNodeError(
      pluginId,
      `attribute ${tag}.${attrName} must be string or number, got ${typeof value}`,
    );
  }
  if (value.length > MAX_SVG_ATTR_LENGTH) {
    throw new InvalidSvgNodeError(
      pluginId,
      `attribute ${tag}.${attrName} exceeds ${MAX_SVG_ATTR_LENGTH} chars`,
    );
  }
  // Defence-in-depth: no `javascript:` / `data:` protocols even if the
  // attribute slipped through the per-tag allowlist. The host never needs
  // these for anything declarative-SVG should express.
  const lower = value.toLowerCase();
  if (lower.includes('javascript:') || lower.includes('data:text/html')) {
    throw new InvalidSvgNodeError(
      pluginId,
      `attribute ${tag}.${attrName} contains a disallowed URI scheme`,
    );
  }
  // For `<use href>` enforce the fragment-only rule explicitly.
  if (tag === 'use' && attrName === 'href' && !SVG_USE_HREF_PATTERN.test(value)) {
    throw new InvalidSvgNodeError(
      pluginId,
      `<use href> must reference a local fragment (e.g. "#symbol-id"), got "${value}"`,
    );
  }
}

function validateAttrs(
  tag: SvgTag,
  attrs: SvgNodeAttrs | undefined,
  pluginId: string,
): void {
  if (!attrs) return;
  const allowed = SVG_ATTR_ALLOWLIST[tag];
  for (const [name, value] of Object.entries(attrs)) {
    if (isForbiddenAttribute(name)) {
      throw new InvalidSvgNodeError(
        pluginId,
        `event handler attribute "${name}" on <${tag}> is never allowed`,
      );
    }
    const isAllowed =
      allowed.includes(name) ||
      GLOBAL_SVG_ATTRS.includes(name) ||
      isDataAttribute(name);
    if (!isAllowed) {
      throw new InvalidSvgNodeError(
        pluginId,
        `attribute "${name}" is not allowed on <${tag}>`,
      );
    }
    validateAttrValue(value, tag, name, pluginId);
  }
}

function walk(
  node: SvgNode,
  depth: number,
  counter: { count: number },
  pluginId: string,
): void {
  if (!node || typeof node !== 'object') {
    throw new InvalidSvgNodeError(pluginId, 'node is not an object');
  }
  if (typeof node.tag !== 'string') {
    throw new InvalidSvgNodeError(pluginId, 'node.tag must be a string');
  }
  if (!(ALLOWED_SVG_TAGS as ReadonlyArray<string>).includes(node.tag)) {
    throw new InvalidSvgNodeError(
      pluginId,
      `tag <${node.tag}> is not in the allowlist`,
    );
  }
  if (depth > MAX_SVG_DEPTH) {
    throw new InvalidSvgNodeError(
      pluginId,
      `nesting depth exceeds ${MAX_SVG_DEPTH}`,
    );
  }
  counter.count += 1;
  if (counter.count > MAX_SVG_NODES) {
    throw new InvalidSvgNodeError(
      pluginId,
      `total node count exceeds ${MAX_SVG_NODES}`,
    );
  }
  if (node.attrs !== undefined) {
    if (typeof node.attrs !== 'object' || Array.isArray(node.attrs)) {
      throw new InvalidSvgNodeError(
        pluginId,
        `${node.tag}.attrs must be a plain object`,
      );
    }
    validateAttrs(node.tag as SvgTag, node.attrs, pluginId);
  }
  if (node.text !== undefined) {
    if (typeof node.text !== 'string') {
      throw new InvalidSvgNodeError(
        pluginId,
        `${node.tag}.text must be a string`,
      );
    }
    if (node.text.length > MAX_SVG_TEXT_LENGTH) {
      throw new InvalidSvgNodeError(
        pluginId,
        `${node.tag}.text exceeds ${MAX_SVG_TEXT_LENGTH} chars`,
      );
    }
    if (node.children !== undefined && node.children.length > 0) {
      throw new InvalidSvgNodeError(
        pluginId,
        `${node.tag} cannot mix text and children`,
      );
    }
  }
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) {
      throw new InvalidSvgNodeError(
        pluginId,
        `${node.tag}.children must be an array`,
      );
    }
    for (const child of node.children) {
      walk(child as SvgNode, depth + 1, counter, pluginId);
    }
  }
}

/**
 * Walk the tree, check every invariant, throw `InvalidSvgNodeError` on
 * the first violation. `pluginId` is embedded in the error so the host's
 * logger can attribute failures.
 */
export function validateSvgNode(node: unknown, pluginId: string): void {
  const counter = { count: 0 };
  walk(node as SvgNode, 1, counter, pluginId);
}

/** Read-only view of the attribute allowlist for tests / tooling. */
export function getAllowedAttributes(tag: SvgTag): ReadonlyArray<string> {
  return SVG_ATTR_ALLOWLIST[tag];
}

/** Read-only view of the global attributes for tests / tooling. */
export function getGlobalAttributes(): ReadonlyArray<string> {
  return GLOBAL_SVG_ATTRS;
}

/**
 * Declarative HTML schema for worker-safe panel contributions.
 *
 * Plugins that run inside the Web Worker sandbox (CORE-006) have no DOM
 * access. The pre-existing `PanelDefinition.mount(container)` API hands the
 * plugin a live `HTMLElement`, which is unreachable across the worker
 * boundary. CORE-006b-step5 closed the same gap for `CanvasOverlayDefinition`
 * (SVG) and `PartSimulation.attachEvents` (event delegation); this module
 * closes the third surface — panels — with a parallel declarative path.
 *
 * The plugin emits a tree of `PanelLayoutNode` objects describing the panel
 * UI; the host walks the tree on the main thread and builds real DOM via
 * `document.createElement`. User interaction is delegated through a small
 * set of allowed event kinds (`click`, `change`, `input`, `focus`, `blur`)
 * that the host installs once on the container and forwards back as
 * serializable `DelegatedPanelEvent` payloads.
 *
 * Why a separate schema from `./svg`:
 *   - HTML and SVG share the validation mechanics (recursive walk, allowlist,
 *     caps) but not the content (tags, attrs, attribute semantics). Forcing a
 *     super-schema would mix XSS surface between two contexts that don't
 *     overlap.
 *   - HTML attributes carry semantic booleans (`disabled`, `checked`,
 *     `required`, …); SVG doesn't. Modeling them as `boolean` here lets the
 *     renderer presence-toggle the attribute correctly instead of writing
 *     literal `"false"` (which the browser treats as truthy).
 *
 * Design goals:
 *   1. **Safe by construction.** No `<script>`, no `<iframe>`, no
 *      `<form>`/`<a>` (deferred to a follow-up that needs URI/HTTP allowlist
 *      integration), no `on*` event attributes, no `style` attribute, no
 *      `javascript:` / `data:text/html` URIs. Every tag and every attribute
 *      is in an explicit allowlist.
 *   2. **Cheap to validate.** Structural + size limits run in a single
 *      recursive pass. `MAX_PANEL_NODES` + `MAX_PANEL_DEPTH` bound the work
 *      per render regardless of what the plugin sends.
 *   3. **Transport-friendly.** Every `PanelLayoutNode` is plain JSON —
 *      serializable via `structuredClone` / `postMessage` with no function
 *      handles and no class instances.
 *
 * Rendering lives in `frontend/src/plugin-host/mountDeclarativePanel.ts`.
 * The host validates the incoming layout at the API boundary (register-time)
 * and then again just before rendering (defence-in-depth; cheap).
 */

/**
 * Supported HTML element tag names. Intentionally small: every tag here has a
 * well-defined visual or semantic role and no side channel (no script
 * execution, no frame escape, no network fetch).
 *
 * Excluded on purpose:
 *   - `<script>`, `<style>`, `<link>`, `<meta>` — code/CSS injection.
 *   - `<iframe>`, `<frame>`, `<object>`, `<embed>` — frame escapes,
 *     cross-origin foothold.
 *   - `<img>`, `<picture>`, `<source>`, `<video>`, `<audio>` — would require
 *     HTTP allowlist integration; deferred to step5c.
 *   - `<a>` — would require URI scheme allowlist (reject `javascript:` and
 *     `data:`) + `target="_blank"` rewriting; deferred to step5c.
 *   - `<form>` — submit handlers + action URLs; plugins emit events via
 *     delegation, not via form submission.
 *   - `<dialog>` — would steal modal focus from the editor.
 *   - `<template>`, `<slot>` — Web Components escape hatch.
 */
export const ALLOWED_PANEL_TAGS = [
  // structure
  'div',
  'section',
  'header',
  'footer',
  'article',
  'aside',
  'nav',
  // text
  'span',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'em',
  'code',
  'pre',
  'small',
  // lists
  'ul',
  'ol',
  'li',
  // forms (interactive — see PanelEventKind for delegation)
  'button',
  'input',
  'label',
  'select',
  'option',
  'textarea',
  'fieldset',
  'legend',
  // tables
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  // separators
  'hr',
  'br',
] as const;

export type PanelLayoutTag = (typeof ALLOWED_PANEL_TAGS)[number];

/**
 * Globals applicable to every tag. Includes accessibility (`role`,
 * `aria-*`), tagging (`data-*`), and structural state (`hidden`,
 * `tabindex`). `class` is the only path to styling — `style` is rejected
 * because inline CSS is an XSS vector via `background: url("javascript:…")`
 * on legacy engines and an exfiltration vector via `background-image`.
 *
 * Notable omissions:
 *   - `style` — see above.
 *   - `href` / `src` / `srcdoc` / `action` / `formaction` — URI side
 *     channels.
 *   - `on*` — every DOM event attribute is rejected structurally by
 *     `isForbiddenAttribute` regardless of per-tag allowlist.
 */
const PANEL_GLOBAL_ATTRS: ReadonlyArray<string> = [
  'id',
  'class',
  'title',
  'lang',
  'dir',
  'tabindex',
  'role',
  'hidden',
  // `aria-*` and `data-*` are validated structurally via isAriaAttribute /
  // isDataAttribute below — they don't need to be enumerated here.
];

/**
 * Per-tag attribute allowlist. Any attribute not in this list (and not a
 * global, `aria-*` or `data-*`) is rejected at validation time.
 */
const PANEL_ATTR_ALLOWLIST: Readonly<Record<PanelLayoutTag, ReadonlyArray<string>>> = {
  // structure (just globals)
  div: [],
  section: [],
  header: [],
  footer: [],
  article: [],
  aside: [],
  nav: [],
  // text (just globals)
  span: [],
  p: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  strong: [],
  em: [],
  code: [],
  pre: [],
  small: [],
  // lists
  ul: [],
  ol: ['start', 'reversed', 'type'],
  li: ['value'],
  // forms
  button: ['type', 'disabled', 'name', 'value'],
  input: [
    'type',
    'name',
    'value',
    'placeholder',
    'disabled',
    'readonly',
    'required',
    'min',
    'max',
    'step',
    'pattern',
    'maxlength',
    'minlength',
    'checked',
    'autocomplete',
  ],
  label: ['for'],
  select: ['name', 'value', 'disabled', 'required', 'multiple', 'size'],
  option: ['value', 'selected', 'disabled', 'label'],
  textarea: [
    'name',
    'value',
    'placeholder',
    'rows',
    'cols',
    'disabled',
    'readonly',
    'required',
    'maxlength',
    'minlength',
    'wrap',
    'autocomplete',
  ],
  fieldset: ['disabled', 'name'],
  legend: [],
  // tables
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ['colspan', 'rowspan', 'headers', 'scope'],
  td: ['colspan', 'rowspan', 'headers', 'scope'],
  // separators (just globals — `hr`/`br` carry no per-tag attrs)
  hr: [],
  br: [],
};

/**
 * `<input type>` is constrained to types that can't reach the network or
 * trigger a file picker. `file`/`submit`/`reset`/`image`/`button` are
 * deliberately excluded — `submit`/`reset` because there's no `<form>` to
 * submit, `file` because uploads need an explicit storage flow, `image`
 * because it's effectively a submit + URL load.
 */
export const INPUT_TYPE_ALLOWLIST: ReadonlyArray<string> = [
  'text',
  'number',
  'checkbox',
  'radio',
  'range',
  'search',
  'email',
  'url',
  'password',
];

/**
 * `<button type>` is constrained to `button` only. Without a `<form>` to
 * submit, `submit` and `reset` would be no-ops at best and surprising at
 * worst (a `submit` button inside a virtual form would still fire on
 * Enter inside an `<input>` ancestor).
 */
export const BUTTON_TYPE_ALLOWLIST: ReadonlyArray<string> = ['button'];

/**
 * `<ol type>` is constrained to the standard list-marker enumerators.
 */
export const OL_TYPE_ALLOWLIST: ReadonlyArray<string> = ['1', 'a', 'A', 'i', 'I'];

/**
 * Boolean-semantic HTML attributes. The renderer presence-toggles these:
 *   - `true` → `setAttribute(name, '')` (browser treats as truthy)
 *   - `false` → no `setAttribute` call (browser treats absence as falsy)
 *
 * Writing `setAttribute(name, 'false')` would be wrong: the HTML spec says
 * any value (including the literal string `"false"`) makes a boolean
 * attribute *present*, hence truthy. Modeling these as a closed set lets
 * the renderer apply that semantic without scanning the entire attr list.
 */
export const BOOLEAN_ATTRS: ReadonlySet<string> = new Set([
  'disabled',
  'checked',
  'readonly',
  'required',
  'multiple',
  'selected',
  'hidden',
  'reversed',
  'autofocus',
]);

/** Hard cap on the total number of nodes in one panel layout. */
export const MAX_PANEL_NODES = 256;

/**
 * Hard cap on nesting depth (root element counts as depth 1). Slightly
 * higher than SVG (8) because panel UIs naturally nest more
 * (`nav > ul > li > details > div > label > input`).
 */
export const MAX_PANEL_DEPTH = 12;

/** Hard cap on the length of any single attribute value. */
export const MAX_PANEL_ATTR_LENGTH = 1024;

/**
 * Hard cap on the length of any single text node. Higher than SVG (1024)
 * because panels show prose (validation messages, inline help).
 */
export const MAX_PANEL_TEXT_LENGTH = 4096;

/**
 * One node in a declarative panel tree. `attrs` values are constrained to
 * strings, numbers, and booleans so the shape is cleanly serialisable;
 * objects, arrays, and `null` are rejected at validation time. `children`
 * is either a flat string (rendered as `textContent`) or a recursive list
 * of `PanelLayoutNode`s — never both.
 */
export type PanelLayoutAttrs = Readonly<Record<string, string | number | boolean>>;

export interface PanelLayoutNode {
  readonly tag: PanelLayoutTag;
  readonly attrs?: PanelLayoutAttrs;
  readonly children?: ReadonlyArray<PanelLayoutNode>;
  readonly text?: string;
}

/**
 * Event kinds that a declarative panel can subscribe to. The host installs
 * one delegated listener per kind on the panel container; each event is
 * forwarded to the plugin as a serialisable `DelegatedPanelEvent`.
 *
 * `focus` / `blur` use `focusin` / `focusout` under the hood so they bubble
 * — without that the delegated handler on the container would never see
 * focus events from descendants.
 *
 * Notable omissions:
 *   - `submit` — no `<form>` in the allowlist.
 *   - `keydown` / `keyup` / `keypress` — `input` covers the value-change
 *     case; keybindings remain `editorActions.register`'s responsibility.
 *   - `wheel` / `pointer*` / drag — out of scope for step5b; panels
 *     needing those can fall back to imperative `mount`.
 */
export type PanelEventKind = 'click' | 'change' | 'input' | 'focus' | 'blur';

const ALLOWED_PANEL_EVENT_KINDS: ReadonlySet<PanelEventKind> = new Set<PanelEventKind>([
  'click',
  'change',
  'input',
  'focus',
  'blur',
]);

/**
 * Payload delivered to the plugin's `onEvent(...)` for every delegated event.
 * Element-local: the host reads `value`/`checked` directly from the target
 * input element so the plugin doesn't need DOM access. `targetId` is the
 * value of the closest ancestor's `data-velxio-event-target` attribute, or
 * `null` if no marker is found — plugins use this for hit-testing
 * ("which button was clicked?") without scanning the DOM themselves.
 */
export interface DelegatedPanelEvent {
  readonly type: PanelEventKind;
  /** Value of the closest `[data-velxio-event-target]` ancestor; `null` if none. */
  readonly targetId: string | null;
  /**
   * For `<input>` / `<select>` / `<textarea>` — the current value, capped at
   * `MAX_PANEL_TEXT_LENGTH` chars. Omitted when the event target is not a
   * value-bearing element.
   */
  readonly value?: string;
  /**
   * For `<input type="checkbox">` / `<input type="radio">` — the current
   * checked state. Omitted otherwise.
   */
  readonly checked?: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

/**
 * A complete declarative panel: the root layout tree plus optional event
 * subscriptions. `events` enumerates which kinds the plugin wants
 * delegated; `onEvent` receives the payload for every delegated event of
 * any subscribed kind.
 *
 * The two fields are validated jointly: `events` without `onEvent` is a
 * configuration error (no place to deliver events) and is rejected at
 * register time.
 */
export interface PanelLayout {
  readonly root: PanelLayoutNode;
  readonly events?: ReadonlyArray<PanelEventKind>;
  readonly onEvent?: (event: DelegatedPanelEvent) => void;
}

/**
 * Thrown by `validatePanelLayout()` / `validatePanelLayoutNode()` /
 * `validatePanelDefinition()` when a declarative panel fails structural
 * checks. The error message identifies the plugin that produced it plus
 * the specific field at fault.
 */
export class InvalidPanelLayoutError extends Error {
  public override readonly name = 'InvalidPanelLayoutError';
  constructor(
    public readonly pluginId: string,
    public readonly reason: string,
  ) {
    super(`Plugin "${pluginId}" submitted an invalid panel layout: ${reason}`);
  }
}

function isForbiddenAttribute(name: string): boolean {
  return name.startsWith('on');
}

function isAriaAttribute(name: string): boolean {
  // `aria-*` per ARIA: lower-case name after `aria-`, hyphens allowed.
  return /^aria-[a-z][a-z0-9-]*$/.test(name);
}

function isDataAttribute(name: string): boolean {
  // `data-*` per HTML: lower-case letter after `data-`, remaining chars
  // are `[a-z0-9-]`.
  return /^data-[a-z][a-z0-9-]*$/.test(name);
}

function validateAttrValue(
  value: unknown,
  tag: PanelLayoutTag,
  attrName: string,
  pluginId: string,
): void {
  if (typeof value === 'boolean') {
    // Booleans are presence-toggles. Any boolean is structurally fine; the
    // renderer handles the present-vs-absent semantic.
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InvalidPanelLayoutError(
        pluginId,
        `non-finite number for ${tag}.${attrName}`,
      );
    }
    return;
  }
  if (typeof value !== 'string') {
    throw new InvalidPanelLayoutError(
      pluginId,
      `attribute ${tag}.${attrName} must be string, number, or boolean, got ${
        value === null ? 'null' : typeof value
      }`,
    );
  }
  if (value.length > MAX_PANEL_ATTR_LENGTH) {
    throw new InvalidPanelLayoutError(
      pluginId,
      `attribute ${tag}.${attrName} exceeds ${MAX_PANEL_ATTR_LENGTH} chars`,
    );
  }
  // Defence-in-depth: no `javascript:` / `data:text/html` even if the
  // attribute slipped through the per-tag allowlist somehow. The
  // declarative panel surface never legitimately needs these URI schemes
  // because every URL-bearing tag (`<a>`, `<img>`, `<iframe>`) is excluded.
  const lower = value.toLowerCase();
  if (lower.includes('javascript:') || lower.includes('data:text/html')) {
    throw new InvalidPanelLayoutError(
      pluginId,
      `attribute ${tag}.${attrName} contains a disallowed URI scheme`,
    );
  }
  // Per-attribute enum validation for the constrained string-typed attrs.
  if (tag === 'input' && attrName === 'type' && !INPUT_TYPE_ALLOWLIST.includes(value)) {
    throw new InvalidPanelLayoutError(
      pluginId,
      `<input type="${value}"> is not allowed (allowed: ${INPUT_TYPE_ALLOWLIST.join(', ')})`,
    );
  }
  if (tag === 'button' && attrName === 'type' && !BUTTON_TYPE_ALLOWLIST.includes(value)) {
    throw new InvalidPanelLayoutError(
      pluginId,
      `<button type="${value}"> is not allowed (allowed: ${BUTTON_TYPE_ALLOWLIST.join(', ')})`,
    );
  }
  if (tag === 'ol' && attrName === 'type' && !OL_TYPE_ALLOWLIST.includes(value)) {
    throw new InvalidPanelLayoutError(
      pluginId,
      `<ol type="${value}"> is not allowed (allowed: ${OL_TYPE_ALLOWLIST.join(', ')})`,
    );
  }
}

function validateAttrs(
  tag: PanelLayoutTag,
  attrs: PanelLayoutAttrs | undefined,
  pluginId: string,
): void {
  if (!attrs) return;
  const allowed = PANEL_ATTR_ALLOWLIST[tag];
  for (const [name, value] of Object.entries(attrs)) {
    if (isForbiddenAttribute(name)) {
      throw new InvalidPanelLayoutError(
        pluginId,
        `event handler attribute "${name}" on <${tag}> is never allowed`,
      );
    }
    const isAllowed =
      allowed.includes(name) ||
      PANEL_GLOBAL_ATTRS.includes(name) ||
      isAriaAttribute(name) ||
      isDataAttribute(name);
    if (!isAllowed) {
      throw new InvalidPanelLayoutError(
        pluginId,
        `attribute "${name}" is not allowed on <${tag}>`,
      );
    }
    validateAttrValue(value, tag, name, pluginId);
  }
}

function walk(
  node: PanelLayoutNode,
  depth: number,
  counter: { count: number },
  pluginId: string,
): void {
  if (!node || typeof node !== 'object') {
    throw new InvalidPanelLayoutError(pluginId, 'node is not an object');
  }
  if (typeof node.tag !== 'string') {
    throw new InvalidPanelLayoutError(pluginId, 'node.tag must be a string');
  }
  if (!(ALLOWED_PANEL_TAGS as ReadonlyArray<string>).includes(node.tag)) {
    throw new InvalidPanelLayoutError(
      pluginId,
      `tag <${node.tag}> is not in the allowlist`,
    );
  }
  if (depth > MAX_PANEL_DEPTH) {
    throw new InvalidPanelLayoutError(
      pluginId,
      `nesting depth exceeds ${MAX_PANEL_DEPTH}`,
    );
  }
  counter.count += 1;
  if (counter.count > MAX_PANEL_NODES) {
    throw new InvalidPanelLayoutError(
      pluginId,
      `total node count exceeds ${MAX_PANEL_NODES}`,
    );
  }
  if (node.attrs !== undefined) {
    if (typeof node.attrs !== 'object' || Array.isArray(node.attrs)) {
      throw new InvalidPanelLayoutError(
        pluginId,
        `${node.tag}.attrs must be a plain object`,
      );
    }
    validateAttrs(node.tag as PanelLayoutTag, node.attrs, pluginId);
  }
  if (node.text !== undefined) {
    if (typeof node.text !== 'string') {
      throw new InvalidPanelLayoutError(
        pluginId,
        `${node.tag}.text must be a string`,
      );
    }
    if (node.text.length > MAX_PANEL_TEXT_LENGTH) {
      throw new InvalidPanelLayoutError(
        pluginId,
        `${node.tag}.text exceeds ${MAX_PANEL_TEXT_LENGTH} chars`,
      );
    }
    if (node.children !== undefined && node.children.length > 0) {
      throw new InvalidPanelLayoutError(
        pluginId,
        `${node.tag} cannot mix text and children`,
      );
    }
  }
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) {
      throw new InvalidPanelLayoutError(
        pluginId,
        `${node.tag}.children must be an array`,
      );
    }
    for (const child of node.children) {
      walk(child as PanelLayoutNode, depth + 1, counter, pluginId);
    }
  }
}

/**
 * Walk the tree, check every invariant, throw `InvalidPanelLayoutError` on
 * the first violation. `pluginId` is embedded in the error so the host's
 * logger can attribute failures.
 */
export function validatePanelLayoutNode(node: unknown, pluginId: string): void {
  const counter = { count: 0 };
  walk(node as PanelLayoutNode, 1, counter, pluginId);
}

/**
 * Validate a complete `PanelLayout`: the root tree plus the event
 * subscription pair. `events` without `onEvent` is rejected because there
 * would be no place to deliver the events; `onEvent` without `events` is
 * accepted (it just means no events are delivered).
 */
export function validatePanelLayout(layout: unknown, pluginId: string): void {
  if (!layout || typeof layout !== 'object') {
    throw new InvalidPanelLayoutError(pluginId, 'layout is not an object');
  }
  const l = layout as PanelLayout;
  validatePanelLayoutNode(l.root, pluginId);
  if (l.events !== undefined) {
    if (!Array.isArray(l.events)) {
      throw new InvalidPanelLayoutError(pluginId, 'layout.events must be an array');
    }
    const seen = new Set<PanelEventKind>();
    for (const kind of l.events) {
      if (typeof kind !== 'string' || !ALLOWED_PANEL_EVENT_KINDS.has(kind as PanelEventKind)) {
        throw new InvalidPanelLayoutError(
          pluginId,
          `event kind "${String(kind)}" is not allowed (allowed: ${[...ALLOWED_PANEL_EVENT_KINDS].join(', ')})`,
        );
      }
      if (seen.has(kind as PanelEventKind)) {
        throw new InvalidPanelLayoutError(
          pluginId,
          `duplicate event kind "${kind}" in layout.events`,
        );
      }
      seen.add(kind as PanelEventKind);
    }
    if (l.events.length > 0 && typeof l.onEvent !== 'function') {
      throw new InvalidPanelLayoutError(
        pluginId,
        'layout.events declared but layout.onEvent is missing',
      );
    }
  }
}

/**
 * Validate that a `PanelDefinition` has at least one of `mount` or `layout`.
 * Both undefined would silently produce a panel that renders nothing, which
 * is almost always a bug — surface it loudly at registration time.
 */
export function validatePanelDefinition(
  def: { readonly mount?: unknown; readonly layout?: unknown },
  pluginId: string,
): void {
  if (def.mount === undefined && def.layout === undefined) {
    throw new InvalidPanelLayoutError(
      pluginId,
      'panel definition must provide either `mount` (imperative) or `layout` (declarative)',
    );
  }
}

/** Read-only view of a tag's per-tag attribute allowlist for tests / tooling. */
export function getAllowedPanelAttributes(tag: PanelLayoutTag): ReadonlyArray<string> {
  return PANEL_ATTR_ALLOWLIST[tag];
}

/** Read-only view of the global panel attributes for tests / tooling. */
export function getPanelGlobalAttributes(): ReadonlyArray<string> {
  return PANEL_GLOBAL_ATTRS;
}

/** Read-only view of the allowed panel event kinds. */
export function getAllowedPanelEventKinds(): ReadonlyArray<PanelEventKind> {
  return [...ALLOWED_PANEL_EVENT_KINDS];
}

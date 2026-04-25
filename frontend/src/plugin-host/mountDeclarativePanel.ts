/**
 * Render a declarative `PanelLayout` into a live host-owned container.
 *
 * This is the main-thread side of the worker-safe panel path added in
 * CORE-006b-step5b. The plugin emits a pure-data `PanelLayoutNode` tree
 * via `PanelDefinition.layout`; the host validates it (once, at register
 * time), then walks it with this function when the host's panel surface
 * mounts the panel.
 *
 * Why re-validate at render time as well as at register time:
 *   The register-time check runs in `createPluginContext`, before the
 *   host holds the value. In tests + future use cases,
 *   `mountDeclarativePanel` may be called with a layout that never went
 *   through the SDK boundary (built-in panels that opt into the same
 *   shape for consistency). Re-validating is cheap — a linear pass
 *   bounded by `MAX_PANEL_NODES = 256` — and the double check turns any
 *   future validation-order bug into a loud rejection instead of an XSS.
 *
 * Event delegation:
 *   When the layout declares `events` + `onEvent`, this function installs
 *   one delegated listener per kind on the container. Each listener walks
 *   `event.target.closest('[data-velxio-event-target]')` to find the
 *   plugin-marked ancestor, reads `value`/`checked` defensively from
 *   form elements, and forwards a serialisable `DelegatedPanelEvent` to
 *   the plugin's `onEvent`. Listener exceptions are logged via the
 *   plugin's logger and swallowed (fault isolation matches EventBus).
 */

import {
  BOOLEAN_ATTRS,
  InvalidPanelLayoutError,
  MAX_PANEL_TEXT_LENGTH,
  validatePanelLayout,
  type DelegatedPanelEvent,
  type PanelEventKind,
  type PanelLayout,
  type PanelLayoutNode,
} from '@velxio/sdk';

const PANEL_EVENT_TARGET_ATTR = 'data-velxio-event-target';

/**
 * Map declarative `PanelEventKind` to the actual DOM event name. `focus`
 * and `blur` get rewritten to `focusin` / `focusout` so the delegated
 * listener on the container actually catches them — `focus` / `blur`
 * don't bubble.
 */
const DOM_EVENT_NAME: Readonly<Record<PanelEventKind, string>> = {
  click: 'click',
  change: 'change',
  input: 'input',
  focus: 'focusin',
  blur: 'focusout',
};

interface PluginLoggerLike {
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

/**
 * Build a live `HTMLElement` tree from a declarative `PanelLayoutNode`.
 * The caller is responsible for appending the returned element to the
 * DOM. On error this function throws synchronously — by the time it
 * runs, the input should already have passed `validatePanelLayout`, so
 * a throw here means the host's own call-site is buggy.
 */
function buildElement(node: PanelLayoutNode, doc: Document): HTMLElement {
  const el = doc.createElement(node.tag);
  if (node.attrs) {
    for (const [name, value] of Object.entries(node.attrs)) {
      if (typeof value === 'boolean') {
        // Boolean attribute semantics: presence = truthy. `setAttribute(name,
        // 'false')` is wrong because the browser treats *any* value as
        // truthy when the attribute is in `BOOLEAN_ATTRS`.
        if (BOOLEAN_ATTRS.has(name) && value === false) {
          continue;
        }
        if (value) {
          el.setAttribute(name, '');
        }
        continue;
      }
      el.setAttribute(name, typeof value === 'number' ? String(value) : value);
    }
  }
  if (node.text !== undefined) {
    // `textContent` (NOT `innerHTML`) so a literal string like
    // "<script>alert(1)</script>" renders as text and not as markup.
    el.textContent = node.text;
  } else if (node.children) {
    for (const child of node.children) {
      el.appendChild(buildElement(child, doc));
    }
  }
  return el;
}

/**
 * Read the value of the closest `[data-velxio-event-target]` ancestor of
 * `target`. Returns `null` when no marker is found — plugins use this
 * for hit-testing without scanning the DOM themselves.
 */
function lookupTargetId(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const marked = target.closest(`[${PANEL_EVENT_TARGET_ATTR}]`);
  if (!marked) return null;
  return marked.getAttribute(PANEL_EVENT_TARGET_ATTR);
}

/**
 * Read `value` / `checked` from a value-bearing element. Cap the value at
 * `MAX_PANEL_TEXT_LENGTH` so a misbehaving `<textarea>` can't blow the
 * RPC payload size. Logs a warn on truncation so the plugin author can
 * raise the cap upstream if it's a real use case.
 */
function extractValueAndChecked(
  target: EventTarget | null,
  pluginId: string,
  logger: PluginLoggerLike,
): { value?: string; checked?: boolean } {
  if (!(target instanceof Element)) return {};
  const out: { value?: string; checked?: boolean } = {};
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  ) {
    let value = target.value;
    if (typeof value === 'string' && value.length > MAX_PANEL_TEXT_LENGTH) {
      logger.warn?.(
        `[plugin:${pluginId}] panel event value truncated (${value.length} → ${MAX_PANEL_TEXT_LENGTH} chars)`,
      );
      value = value.slice(0, MAX_PANEL_TEXT_LENGTH);
    }
    out.value = value;
  }
  if (target instanceof HTMLInputElement) {
    if (target.type === 'checkbox' || target.type === 'radio') {
      out.checked = target.checked;
    }
  }
  return out;
}

interface InstallParams {
  readonly container: HTMLElement;
  readonly events: ReadonlyArray<PanelEventKind>;
  readonly onEvent: (event: DelegatedPanelEvent) => void;
  readonly pluginId: string;
  readonly logger: PluginLoggerLike;
}

interface InstalledListeners {
  dispose(): void;
}

/**
 * Install one delegated listener per kind on `container`. Each listener:
 *   - looks up the closest `[data-velxio-event-target]` ancestor for `targetId`
 *   - reads `value` / `checked` from the actual event target if it's a
 *     form element
 *   - calls `onEvent` inside a try/catch so a throwing plugin handler
 *     doesn't take down the listener (next event still flows)
 *
 * Returns a handle whose `dispose()` removes every listener it installed.
 * De-duplicates kinds defensively, skips unknown kinds with no error
 * (validation already ran upstream — this is purely defensive against
 * future changes).
 */
function installDelegatedListeners(params: InstallParams): InstalledListeners {
  const { container, events, onEvent, pluginId, logger } = params;
  const installed: Array<{ name: string; handler: EventListener }> = [];
  const seen = new Set<PanelEventKind>();
  for (const kind of events) {
    if (seen.has(kind)) continue;
    const domEventName = DOM_EVENT_NAME[kind];
    if (domEventName === undefined) continue;
    seen.add(kind);
    const handler: EventListener = (rawEvent) => {
      // Narrow to MouseEvent / FocusEvent / Event for modifier-key access.
      const me = rawEvent as MouseEvent;
      const targetId = lookupTargetId(rawEvent.target);
      const valueAndChecked = extractValueAndChecked(rawEvent.target, pluginId, logger);
      const payload: DelegatedPanelEvent = {
        type: kind,
        targetId,
        shiftKey: !!me.shiftKey,
        altKey: !!me.altKey,
        ctrlKey: !!me.ctrlKey,
        metaKey: !!me.metaKey,
        ...valueAndChecked,
      };
      try {
        onEvent(payload);
      } catch (err) {
        logger.error?.(
          `[plugin:${pluginId}] panel onEvent threw for kind "${kind}":`,
          err,
        );
      }
    };
    container.addEventListener(domEventName, handler);
    installed.push({ name: domEventName, handler });
  }
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const { name, handler } of installed) {
        container.removeEventListener(name, handler);
      }
      installed.length = 0;
    },
  };
}

export interface MountDeclarativePanelResult {
  /** The top-level element that was mounted into `container`. */
  readonly element: HTMLElement;
  /** Detach + forget — safe to call multiple times. */
  dispose(): void;
}

/**
 * Validate `layout`, build its DOM tree, append it to `container`,
 * install delegated listeners (when `events` + `onEvent` are present),
 * return a handle with an idempotent `dispose()`. Validation errors
 * bubble as `InvalidPanelLayoutError` (from the SDK).
 */
export function mountDeclarativePanel(
  container: HTMLElement,
  layout: PanelLayout,
  pluginId: string,
  logger: PluginLoggerLike = {},
): MountDeclarativePanelResult {
  // Cheap re-validation. If `layout` came from the SDK boundary this is a
  // no-op; if it came from anywhere else it catches structural bugs before
  // a malformed attribute reaches `setAttribute`.
  validatePanelLayout(layout, pluginId);
  const doc = container.ownerDocument;
  if (!doc) {
    throw new InvalidPanelLayoutError(
      pluginId,
      'container element has no ownerDocument',
    );
  }
  const element = buildElement(layout.root, doc);
  container.appendChild(element);
  let listeners: InstalledListeners | null = null;
  if (
    layout.events !== undefined &&
    layout.events.length > 0 &&
    typeof layout.onEvent === 'function'
  ) {
    listeners = installDelegatedListeners({
      container,
      events: layout.events,
      onEvent: layout.onEvent,
      pluginId,
      logger,
    });
  }
  let disposed = false;
  return {
    element,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (listeners) {
        try {
          listeners.dispose();
        } catch {
          // Listener teardown shouldn't throw, but be defensive — we still
          // need to remove the DOM node.
        }
        listeners = null;
      }
      if (element.parentNode === container) {
        container.removeChild(element);
      }
    },
  };
}

/**
 * Re-export the `data-*` marker name so consumers (tests, downstream
 * panel-rendering code) don't have to hardcode the string.
 */
export { PANEL_EVENT_TARGET_ATTR };

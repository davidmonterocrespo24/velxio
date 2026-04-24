/**
 * Install delegated DOM event listeners on a part's root element and
 * forward each event to the plugin's `onEvent(DelegatedPartEvent)` sink.
 *
 * This is the main-thread side of `PartSimulation.events` / `onEvent` —
 * the worker-safe alternative to `attachEvents(element, handle)` added in
 * CORE-006b-step5. The plugin never sees a live `MouseEvent`; instead the
 * host converts each event into a flat JSON-serialisable
 * `DelegatedPartEvent` that survives the worker `postMessage` hop.
 *
 * Fault isolation follows the same rule as `onPinStateChange` wrappers:
 * an `onEvent` that throws is logged through the plugin logger and
 * swallowed. A buggy plugin never blocks sibling parts.
 *
 * Coordinate space:
 *   The returned `x` / `y` are **relative to the element's bounding box
 *   top-left** — not to the page, not to the SVG root. Plugins use them
 *   for hit-testing without needing CTM access or DOM reads.
 *
 * Listener cleanup:
 *   The returned `dispose()` removes every listener it added. Safe to
 *   call multiple times. Called automatically when the host tears the
 *   part down (stop sim, plugin unload).
 */

import type { DelegatedPartEvent, PartEventKind } from '@velxio/sdk';

/** Minimal logger surface — matches `PluginLogger.error`. */
interface Logger {
  error(message: string, ...args: unknown[]): void;
}

export interface DelegatePartEventsOptions {
  readonly element: HTMLElement | SVGElement;
  readonly events: ReadonlyArray<PartEventKind>;
  readonly onEvent: (event: DelegatedPartEvent) => void;
  readonly pluginId: string;
  readonly componentId: string;
  readonly logger: Logger;
}

export interface DelegatePartEventsHandle {
  dispose(): void;
}

/**
 * De-duplicate + normalize the `events` list. Unknown kinds are filtered
 * (defensive — the SDK types forbid them, but plugins that skipped type
 * checking could still ship bad data).
 */
const ALLOWED_KINDS: ReadonlySet<PartEventKind> = new Set([
  'click',
  'mousedown',
  'mouseup',
  'mouseenter',
  'mouseleave',
  'contextmenu',
]);

function toDelegated(
  type: PartEventKind,
  ev: MouseEvent,
  element: Element,
  pluginId: string,
): DelegatedPartEvent {
  const rect = element.getBoundingClientRect();
  return {
    type,
    x: ev.clientX - rect.left,
    y: ev.clientY - rect.top,
    button: ev.button,
    shiftKey: ev.shiftKey,
    altKey: ev.altKey,
    ctrlKey: ev.ctrlKey,
    metaKey: ev.metaKey,
    pluginId,
  };
}

export function delegatePartEvents(
  options: DelegatePartEventsOptions,
): DelegatePartEventsHandle {
  const { element, events, onEvent, pluginId, componentId, logger } = options;
  const attached: Array<{ kind: PartEventKind; handler: (ev: Event) => void }> = [];
  const seen = new Set<PartEventKind>();
  for (const kind of events) {
    if (!ALLOWED_KINDS.has(kind) || seen.has(kind)) {
      continue;
    }
    seen.add(kind);
    const handler = (rawEv: Event) => {
      const mouse = rawEv as MouseEvent;
      try {
        onEvent(toDelegated(kind, mouse, element, pluginId));
      } catch (err) {
        logger.error(
          `onEvent threw for component "${componentId}" on "${kind}":`,
          err,
        );
      }
    };
    element.addEventListener(kind, handler);
    attached.push({ kind, handler });
  }
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const { kind, handler } of attached) {
        element.removeEventListener(kind, handler);
      }
      attached.length = 0;
    },
  };
}

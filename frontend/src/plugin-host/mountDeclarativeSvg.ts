/**
 * Render a declarative `SvgNode` tree into a live host-owned SVG element.
 *
 * This is the main-thread side of the worker-safe canvas overlay path
 * added in CORE-006b-step5. The plugin emits a pure-data `SvgNode` tree
 * via `CanvasOverlayDefinition.svg`; the host validates it (once, at
 * register time), then walks it with this function when the host's
 * canvas layer mounts the overlay.
 *
 * Why re-validate at render time as well as at register time:
 *   The register-time check runs in `createPluginContext`, before the
 *   host holds the value. In tests + future use cases, `mountDeclarativeSvg`
 *   may be called with a tree that never went through the SDK boundary
 *   (e.g. built-in overlays that opt into the same shape for consistency).
 *   Re-validating is cheap — a linear pass bounded by `MAX_SVG_NODES = 256`
 *   — and the double check turns any future validation-order bug into a
 *   loud rejection instead of an XSS.
 *
 * The function takes a `root` SVG container (a `<g>` is ideal so the
 * overlay has its own coordinate scope) and returns a `dispose()` that
 * removes every child it created. Plugin teardown + sim stop both hit
 * this path.
 */

import { validateSvgNode, type SvgNode, type SvgTag } from '@velxio/sdk';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Build a live `SVGElement` tree from a declarative `SvgNode`. The caller
 * is responsible for appending the returned element to the DOM. On error
 * this function throws synchronously — by the time it runs, the input
 * should already have passed `validateSvgNode`, so a throw here means the
 * host's own call-site is buggy.
 */
function buildElement(node: SvgNode, doc: Document): SVGElement {
  const el = doc.createElementNS(SVG_NS, node.tag) as SVGElement;
  if (node.attrs) {
    for (const [name, value] of Object.entries(node.attrs)) {
      // The validator has already confirmed the name is allowlisted for
      // this tag and the value is finite string|number; converting to
      // string here is safe.
      el.setAttribute(name, typeof value === 'number' ? String(value) : value);
    }
  }
  if (node.text !== undefined) {
    el.textContent = node.text;
  } else if (node.children) {
    for (const child of node.children) {
      el.appendChild(buildElement(child, doc));
    }
  }
  return el;
}

export interface MountDeclarativeSvgResult {
  /** The top-level element that was mounted into `root`. */
  readonly element: SVGElement;
  /** Detach + forget — safe to call multiple times. */
  dispose(): void;
}

/**
 * Validate `node`, build its element tree, append it to `root`, return a
 * handle with an idempotent `dispose()`. Validation errors bubble as
 * `InvalidSvgNodeError` (from the SDK); rendering errors are caller's
 * responsibility (this function performs no DOM introspection beyond
 * append/remove).
 */
export function mountDeclarativeSvg(
  root: SVGElement,
  node: SvgNode,
  pluginId: string,
): MountDeclarativeSvgResult {
  // Cheap re-validation. If `node` came from the SDK boundary this is a
  // no-op; if it came from anywhere else it catches structural bugs
  // before a malformed attribute reaches `setAttribute`.
  validateSvgNode(node, pluginId);
  const doc = root.ownerDocument;
  if (!doc) {
    throw new Error(
      `mountDeclarativeSvg: root element for plugin "${pluginId}" has no ownerDocument`,
    );
  }
  const element = buildElement(node, doc);
  root.appendChild(element);
  let disposed = false;
  return {
    element,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (element.parentNode === root) {
        root.removeChild(element);
      }
    },
  };
}

/**
 * Tag allowlist re-export for consumers that want to guard their own
 * rendering paths (tests, debug tooling). Kept near the renderer so
 * callers only need one import.
 */
export type { SvgTag, SvgNode };

import type { editor } from 'monaco-editor';

const LIST = '.suggest-widget';
const DETAILS = '.suggest-details-container';
const POPUPS = LIST + ', ' + DETAILS;
const DETAILS_GAP = 4;

export function keepSuggestionsInEditor(instance: editor.IStandaloneCodeEditor) {
  const root = instance.getDomNode();
  if (!root) return;

  const offsets = new WeakMap<HTMLElement, { x: number; y: number }>();
  let frame = 0;

  const originalBounds = (popup: HTMLElement) => {
    const box = popup.getBoundingClientRect();
    const { x, y } = offsets.get(popup) ?? { x: 0, y: 0 };
    return new DOMRect(box.left - x, box.top - y, box.width, box.height);
  };

  const place = (
    popup: HTMLElement,
    original: DOMRect,
    pane: DOMRect,
    left: number,
    top: number,
  ) => {
    const x = Math.max(pane.left, Math.min(left, pane.right - original.width));
    const y = Math.max(pane.top, Math.min(top, pane.bottom - original.height));
    const offset = { x: x - original.left, y: y - original.top };
    const previous = offsets.get(popup);
    if (previous?.x !== offset.x || previous?.y !== offset.y) {
      offsets.set(popup, offset);
      popup.style.translate =
        Math.abs(offset.x) < 0.01 && Math.abs(offset.y) < 0.01
          ? ''
          : offset.x + 'px ' + offset.y + 'px';
    }
    return new DOMRect(x, y, original.width, original.height);
  };

  const fit = () => {
    frame = 0;
    const pane = root.getBoundingClientRect();
    if (!pane.width || !pane.height) return;
    root.style.setProperty('--suggestion-pane-width', pane.width + 'px');
    root.style.setProperty('--suggestion-pane-height', pane.height + 'px');

    const list = root.querySelector<HTMLElement>(LIST + '.visible');
    if (!list) return;
    const original = originalBounds(list);
    const position = instance.getPosition();
    const cursor = position ? instance.getScrolledVisiblePosition(position) : null;
    let top = original.top;
    // Monaco picks above or below using the window height. The terminal can
    // leave much less room below the cursor inside the actual editor.
    if (cursor && original.bottom > pane.bottom) {
      top = pane.top + cursor.top - original.height;
    } else if (cursor && original.top < pane.top) {
      top = pane.top + cursor.top + cursor.height;
    }
    const anchor = place(list, original, pane, original.left, top);

    const details = root.querySelector<HTMLElement>(DETAILS);
    if (!details || !details.getClientRects().length) return;
    const doc = originalBounds(details);
    let left = anchor.left;
    top = anchor.top;
    if (anchor.right + DETAILS_GAP + doc.width <= pane.right) {
      left = anchor.right + DETAILS_GAP;
    } else if (anchor.left - DETAILS_GAP - doc.width >= pane.left) {
      left = anchor.left - DETAILS_GAP - doc.width;
    } else if (anchor.bottom + DETAILS_GAP + doc.height <= pane.bottom) {
      top = anchor.bottom + DETAILS_GAP;
    } else {
      top = anchor.top - DETAILS_GAP - doc.height;
    }
    place(details, doc, pane, left, top);
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(fit);
  };

  const observer = new MutationObserver((changes) => {
    if (
      changes.some(({ type, target, addedNodes }) =>
        type === 'attributes'
          ? target instanceof HTMLElement && target.matches(POPUPS)
          : Array.from(addedNodes).some(
              (node) => node instanceof HTMLElement && node.matches(POPUPS),
            ),
      )
    ) {
      schedule();
    }
  });
  observer.observe(root, {
    attributes: true,
    attributeFilter: ['class', 'style'],
    childList: true,
    subtree: true,
  });
  const layout = instance.onDidLayoutChange(schedule);
  const scroll = instance.onDidScrollChange(schedule);
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    layout.dispose();
    scroll.dispose();
    root.style.removeProperty('--suggestion-pane-width');
    root.style.removeProperty('--suggestion-pane-height');
    for (const popup of root.querySelectorAll<HTMLElement>(POPUPS)) popup.style.translate = '';
  };
}

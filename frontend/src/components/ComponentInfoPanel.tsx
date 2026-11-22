/**
 * Component Info Panel
 *
 * Floating "datasheet" popover shown when the user hovers a card in the
 * Component Picker. It combines two data sources:
 *
 *   1. The already-loaded ComponentMetadata (name, category, pin count, live
 *      default properties, tags) — always available, no network.
 *   2. An optional hand-authored Markdown datasheet (see `componentDocs.ts`
 *      and `component-docs/`) with the richer prose, pinout, wiring tips,
 *      plus the component's brand and a purchase link. Lazy-loaded + cached.
 *
 * The panel is INTERACTIVE: the mouse can move off the card onto the panel to
 * scroll a long datasheet or click the Buy link without it closing. This is
 * driven from the modal via a grace-period hide timer — `onPanelEnter` cancels
 * the pending hide, `onPanelLeave` re-arms it. Rendered through a portal to
 * <body> so the modal's `overflow` never clips it, and flipped/clamped to stay
 * inside the viewport.
 */

import { ExternalLink } from 'lucide-react';
import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PropertyDescriptor } from '../types/component-metadata';
import { loadDoc, productPageHref, productLinkKind, type ComponentDoc } from './componentDocs';
import { trackProductPageClick } from '../utils/analytics';
import { scalableSvgThumbnail } from '../utils/svgThumbnail';
import './ComponentInfoPanel.css';

export interface PanelData {
  id: string; // component / board id — used to look up the Markdown doc
  name: string;
  category: string; // already display-formatted (e.g. "Sensors")
  description?: string;
  pinCount: number;
  properties: PropertyDescriptor[];
  tags: string[];
  thumbnail?: string;
  pro_only?: boolean;
  custom?: boolean;
}

export interface HoverTarget {
  data: PanelData;
  rect: DOMRect; // bounding box of the hovered card, in viewport coords
}

/** Delay before the panel appears — long enough to not flash on a fly-by. */
export const HOVER_DELAY = 160;

// Bulk / opaque properties that are never useful in a datasheet popover
// (base64 blobs, embedded source, framebuffers, …).
export const HIDDEN_PROPS = new Set([
  'imageData',
  'wasmBase64',
  'sourceC',
  'romBytes',
  'chipJson',
  'programFile',
  'programTarget',
  // The Part Inspector reuses this list; sdFiles is a base64 payload too.
  'sdFiles',
]);

/** Only allow real web links through to the Buy button (no javascript:, etc.). */
export function safeHref(url?: string): string | null {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

export function formatValue(p: PropertyDescriptor): string {
  const raw = p.defaultValue;
  let def = raw === undefined || raw === null || raw === '' ? '' : String(raw);
  if (def.length > 40) def = def.slice(0, 39) + '…';

  if (p.min !== undefined || p.max !== undefined) {
    const range = `${p.min ?? '?'}–${p.max ?? '?'}`;
    return def ? `${def} (${range})` : range;
  }
  if (p.options && p.options.length) {
    const opts = p.options.join(' / ');
    // A long option list would blow out the row — fall back to the default.
    return opts.length > 44 ? def || String(p.options[0]) : opts;
  }
  return def || '—';
}

/**
 * Load the authored Markdown datasheet (if any) for a component/board id.
 * Thin hook over `loadDoc`'s cache so both the hover panel and the Part
 * Inspector dialog share one code path (and one cache) for docs.
 */
export function useComponentDoc(id: string): ComponentDoc | null {
  const [doc, setDoc] = React.useState<ComponentDoc | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    setDoc(null);
    loadDoc(id).then((d) => {
      if (!cancelled) setDoc(d);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);
  return doc;
}

/**
 * The panel's CONTENT, with no portal, no positioning and no header: the doc
 * markdown (or the metadata description as fallback), the default-property
 * rows, the tag chips and the Buy footer. The hover panel wraps it; the Part
 * Inspector dialog embeds it as its Datasheet tab.
 */
export const ComponentInfoBody: React.FC<{
  data: PanelData;
  /** false = doc/description + tags + Buy only (the dialog has its own props UI). */
  showProps?: boolean;
}> = ({ data, showProps = true }) => {
  const { t: translate } = useTranslation();
  const doc = useComponentDoc(data.id);

  const visibleProps = data.properties.filter((p) => !HIDDEN_PROPS.has(p.name));
  const shownProps = visibleProps.slice(0, 8);
  const hiddenCount = visibleProps.length - shownProps.length;
  const buyHref = safeHref(doc?.buy);

  return (
    <>
      {/* Authored datasheet supersedes the thin auto-generated description.
          91 of the 156 catalogue parts have NEITHER, so say so rather than
          leaving the reader looking at an empty panel wondering if it broke. */}
      {doc?.body ? (
        <div className="cip-doc">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.body}</ReactMarkdown>
        </div>
      ) : data.description ? (
        <p className="cip-desc">{data.description}</p>
      ) : (
        <p className="cip-desc cip-desc--empty">
          No datasheet written for this part yet.
          {data.pinCount > 0 && ' Its pins are listed on the left.'}
        </p>
      )}

      {showProps && shownProps.length > 0 && (
        <div className="cip-props">
          <div className="cip-section-title">Properties</div>
          <div className="cip-prop-list">
            {shownProps.map((p) => (
              <div className="cip-prop-row" key={p.name}>
                <span className="cip-prop-name">{p.name}</span>
                <span className="cip-prop-val">{formatValue(p)}</span>
              </div>
            ))}
          </div>
          {hiddenCount > 0 && <div className="cip-more">+{hiddenCount} more</div>}
        </div>
      )}

      {data.tags && data.tags.length > 0 && (
        <div className="cip-tags">
          {data.tags.slice(0, 6).map((t) => (
            <span className="cip-tag" key={t}>
              {t}
            </span>
          ))}
        </div>
      )}

      {buyHref && (
        <div className="cip-footer">
          <a
            className="cip-buy"
            href={productPageHref(buyHref, data.id)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackProductPageClick(data.id, doc?.brand, buyHref)}
          >
            <ExternalLink size={14} aria-hidden />
            {productLinkKind(buyHref) === 'docs'
              ? translate('editor.inspector.datasheetPage')
              : translate('editor.inspector.productPage')}
          </a>
        </div>
      )}
    </>
  );
};

interface ComponentInfoPanelProps {
  target: HoverTarget;
  /** Called when the pointer enters the panel — cancels the pending hide. */
  onPanelEnter: () => void;
  /** Called when the pointer leaves the panel — re-arms the hide timer. */
  onPanelLeave: () => void;
}

export const ComponentInfoPanel: React.FC<ComponentInfoPanelProps> = ({
  target,
  onPanelEnter,
  onPanelLeave,
}) => {
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
  const { data, rect } = target;

  // The doc is loaded here TOO (same cached loadDoc as ComponentInfoBody):
  // the panel needs it for the brand line in its header, and as a dependency
  // of the measure effect below — the doc arriving changes the panel height.
  const doc = useComponentDoc(data.id);

  // The panel is portaled to <body>, OUTSIDE the React root container, so
  // React's synthetic onMouseEnter/onMouseLeave never fire on it (React binds
  // event delegation to the root). Attach NATIVE listeners on the node itself
  // so the "keep the panel open while the pointer is over it" bridge works.
  // Handlers are read through refs so the listeners bind once per mount.
  const enterRef = React.useRef(onPanelEnter);
  const leaveRef = React.useRef(onPanelLeave);
  enterRef.current = onPanelEnter;
  leaveRef.current = onPanelLeave;
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onEnter = () => enterRef.current();
    const onLeave = () => leaveRef.current();
    el.addEventListener('mouseenter', onEnter);
    el.addEventListener('mouseleave', onLeave);
    return () => {
      el.removeEventListener('mouseenter', onEnter);
      el.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  // Measure the rendered panel and flip/clamp it into the viewport. Runs
  // before paint so there is no visible jump from the fallback position, and
  // re-runs when the doc loads (which changes the panel's height).
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const margin = 12;
    const gap = 12;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const fitsRight = rect.right + gap + w <= vw - margin;
    const fitsLeft = rect.left - gap - w >= margin;

    let left: number;
    let top: number;
    if (fitsRight || fitsLeft) {
      // Side placement (preferred): never overlaps the card horizontally.
      left = fitsRight ? rect.right + gap : rect.left - w - gap;
      top = Math.max(margin, Math.min(rect.top, vh - h - margin));
    } else {
      // Neither side fits (narrow viewport / zoom). Dock below the card — or
      // above if there is no room — so the panel never covers its own trigger
      // and block the add-click.
      left = Math.max(margin, Math.min(rect.left, vw - w - margin));
      const below = rect.bottom + gap;
      top = below + h <= vh - margin ? below : Math.max(margin, rect.top - gap - h);
    }

    setPos({ left, top });
  }, [rect, doc]);

  // Scaled to the 40px box, not cropped (see scalableSvgThumbnail).
  const svgThumb = scalableSvgThumbnail(data.thumbnail);

  const brand = doc?.brand;

  return createPortal(
    <div
      ref={ref}
      className="component-info-panel"
      // Clicks inside the panel (Buy link, text selection) must not bubble
      // through the React portal to the overlay's onClose and shut the picker.
      onClick={(e) => e.stopPropagation()}
      style={{
        left: pos?.left ?? rect.right + 12,
        top: pos?.top ?? rect.top,
        opacity: pos ? 1 : 0,
      }}
    >
      <div className="cip-header">
        {svgThumb && (
          <div className="cip-thumb" dangerouslySetInnerHTML={{ __html: svgThumb }} />
        )}
        <div className="cip-title">
          <span className="cip-name">{data.name}</span>
          <span className="cip-badges">
            <span className="cip-cat">{data.category}</span>
            {data.custom && <span className="cip-custom">CUSTOM</span>}
            {data.pro_only && <span className="cip-pro">PRO</span>}
            {data.pinCount > 0 && <span className="cip-pins">{data.pinCount} pins</span>}
          </span>
          {brand && <span className="cip-brand">by {brand}</span>}
        </div>
      </div>

      <ComponentInfoBody data={data} />
    </div>,
    document.body,
  );
};

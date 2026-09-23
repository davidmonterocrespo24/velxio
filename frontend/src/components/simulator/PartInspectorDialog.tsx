/**
 * Part Inspector — the right-click dialog for canvas components.
 *
 * Merges the two surfaces that used to exist separately: the old
 * ComponentPropertyDialog (a 250px column of pin names, editors and
 * Rotate/Delete) and the component-picker info card (datasheet, brand, Buy).
 * Layout: a live preview of the part on the left, Properties / Datasheet
 * tabs on the right, and one action bar across the bottom (Rotate/Delete on
 * the left, Buy on the right) that stays put whichever tab is open.
 *
 * The preview is the REAL web component, mounted and scaled — not a drawing.
 * Pin markers are laid over it at their true positions and their labels flank
 * the art on the side each pin lives on (pinInspectorLayout); hovering a name
 * lights its leader line and its pad so the two can be traced to each other.
 * Everything is driven by the element's own pinInfo and measured size, so any
 * part present or future works with zero per-part data.
 *
 * Clicking a pin keeps the exact contract of the old dialog: onPinSelect ->
 * the canvas starts (or finishes) a wire through handlePinClick, with its
 * undo, colors and running-state gating.
 */

import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { ComponentMetadata } from '../../types/component-metadata';
import {
  exampleProjects,
  subscribeProExamples,
  getProExamplesVersion,
  type ExampleProject,
} from '../../data/examples';
import { stripBrandPrefix } from '../../utils/exampleToBuildNetlistInput';
import { SdCardPanel } from './SdCardPanel';
import type { UploadedSdFile } from '../../utils/sdCardFiles';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import {
  isKeyBindable,
  isModifierKey,
  normalizeKey,
  formatKeyLabel,
} from '../../utils/keyButtonBindings';
import {
  ComponentInfoBody,
  useComponentDoc,
  HIDDEN_PROPS,
  formatValue,
  safeHref,
  type PanelData,
} from '../ComponentInfoPanel';
import { productPageHref, productLinkKind } from '../componentDocs';
import { trackProductPageClick } from '../../utils/analytics';
import {
  layoutInspectorPins,
  type InspectorPinInput,
  type PinLayoutResult,
} from '../../utils/pinInspectorLayout';
import { showConfirmDialog } from '../../store/useMessageDialogStore';
// The keybind chips and the SD Card panel keep their existing class names and
// styles — both live in ComponentPropertyDialog.css, imported here so the old
// dialog file can eventually retire without orphaning them.
import './ComponentPropertyDialog.css';
import './PartInspectorDialog.css';

function isEditable(prop: any): boolean {
  if (prop.control === 'select' && prop.options) return true;
  if (prop.control === 'text' || prop.control === 'number') return true;
  return false;
}

/** "input" -> "Input" — the picker formats categories for display; match it. */
function displayCategory(cat: string): string {
  return cat ? cat.charAt(0).toUpperCase() + cat.slice(1) : cat;
}

/**
 * Gallery examples that actually use this part. The id doubles as both keys
 * the gallery uses: a component's metadata id (examples reference it in
 * components[].type, brand prefix stripped) and a board's kind (boardType /
 * boardFilter / boards[].boardKind) — the board inspector passes boardKind as
 * metadata.id, so one lookup serves both dialogs.
 */
function examplesForPart(id: string): ExampleProject[] {
  return exampleProjects.filter(
    (ex) =>
      ex.boardType === id ||
      ex.boardFilter === id ||
      ex.boards?.some((b) => b.boardKind === id) ||
      // Overlay-registered examples are cast in, so components may be absent.
      (ex.components ?? []).some((c) => c.type === id || stripBrandPrefix(c.type) === id),
  );
}

/**
 * An action shown in the left column instead of Rotate. Boards do not rotate;
 * they carry Board Options / Flash instead, and the canvas owns what those do.
 */
export interface InspectorAction {
  id: string;
  label: string;
  title?: string;
  disabled?: boolean;
  onSelect: () => void;
}

interface PartInspectorDialogProps {
  componentId: string;
  componentMetadata: ComponentMetadata;
  componentProperties: Record<string, any>;
  /** Anchor point in VIEWPORT coordinates (both open gestures now agree). */
  position: { x: number; y: number };
  pinInfo: Array<{ name: string; x: number; y: number; signals?: any[]; description?: string }>;
  onClose: () => void;
  /** Omitted for boards, which do not rotate. */
  onRotate?: (componentId: string) => void;
  onDelete: (componentId: string) => void;
  onPropertyChange?: (componentId: string, propertyName: string, value: unknown) => void;
  /** Same contract as the old dialog: the canvas starts/finishes a wire here. */
  onPinSelect?: (componentId: string, pinName: string) => void;
  wireInProgress?: boolean;
  /** Board-only extras, rendered above Delete in the actions column. */
  extraActions?: InspectorAction[];
  /** Overrides the Delete button's label (boards say "Remove board"). */
  deleteLabel?: string;
  /** The caller confirms deletion itself (boards open the remove-board modal
      with its wire count), so Delete fires onDelete without asking here. */
  skipDeleteConfirm?: boolean;
  /** Tag rendered live in the preview when the element is not the metadata's. */
  previewTagName?: string;
  /** Attributes to set on the preview element (boards need board-kind). */
  previewAttributes?: Record<string, string>;
  /** The simulation is running: the part can be inspected (pins, datasheet,
      the SD card's live contents) but not edited. Rotate/Delete are hidden
      and the property editors are disabled; the canvas already withholds
      onPinSelect so pins are labels, not wire starts. */
  readOnly?: boolean;
}

/**
 * The art box the part is scaled into. The pin gutters are added around it, so
 * the dialog's left column ends up a little wider than this.
 */
const PINS_ART = 190;
/**
 * Taller art box used when a wide many-pin board is shown ROTATED (Mega, the
 * Pi Linux family): its long pin rows become side columns, and the labels
 * need vertical room — the dialog column has it to spare.
 */
const PINS_ART_ROTATED_H = 420;

export const PartInspectorDialog: React.FC<PartInspectorDialogProps> = ({
  componentId,
  componentMetadata,
  componentProperties,
  position,
  pinInfo,
  onClose,
  onRotate,
  onDelete,
  onPropertyChange,
  onPinSelect,
  wireInProgress,
  extraActions,
  deleteLabel,
  skipDeleteConfirm,
  previewTagName,
  previewAttributes,
  readOnly = false,
}) => {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previewHostRef = useRef<HTMLDivElement>(null);
  const [dialogPos, setDialogPos] = useState<{ x: number; y: number } | null>(null);
  const [tab, setTab] = useState<'properties' | 'datasheet'>('properties');
  // The pin the pointer is on — its leader line and dot light up together, so
  // a name in the gutter can be traced to the pad it belongs to.
  const [hoverPin, setHoverPin] = useState<string | null>(null);
  const [layout, setLayout] = useState<PinLayoutResult | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);

  const doc = useComponentDoc(componentMetadata.id);

  // Pro examples register asynchronously (dynamic overlay import): the
  // version subscription re-derives the list the moment they land, so a
  // dialog opened early does not miss them.
  useSyncExternalStore(subscribeProExamples, getProExamplesVersion);
  const partExamples = examplesForPart(componentMetadata.id);

  // ── Keyboard binding capture (unchanged from the old dialog) ─────────────
  const [capturingKey, setCapturingKey] = useState(false);
  const allComponents = useSimulatorStore((s) => s.components);
  const boundKey =
    typeof componentProperties.key === 'string' && componentProperties.key
      ? componentProperties.key
      : '';
  const keyInUseElsewhere =
    !!boundKey &&
    allComponents.some(
      (c) =>
        c.id !== componentId &&
        isKeyBindable(c.metadataId) &&
        typeof c.properties.key === 'string' &&
        !!c.properties.key &&
        normalizeKey(c.properties.key) === normalizeKey(boundKey),
    );

  useEffect(() => setCapturingKey(false), [componentId]);

  useEffect(() => {
    if (!capturingKey) return;
    const onCaptureKey = (e: KeyboardEvent) => {
      // Capture-phase + stopPropagation: the pressed key must not reach the
      // dialog's Escape-close handler, the canvas delete handler, or the
      // runtime key->button bridge while we're recording it.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturingKey(false);
        return;
      }
      if (isModifierKey(e.key)) return; // keep waiting for a real key
      onPropertyChange?.(componentId, 'key', normalizeKey(e.key));
      setCapturingKey(false);
    };
    window.addEventListener('keydown', onCaptureKey, true);
    return () => window.removeEventListener('keydown', onCaptureKey, true);
  }, [capturingKey, componentId, onPropertyChange]);

  // The preview effect must NOT re-run on every parent render, or the element
  // is torn down and remounted and the dialog visibly flickers whenever the
  // canvas re-renders (moving the pointer in and out is enough). Both of the
  // inputs it cares about arrive as fresh objects each render — pinInfo is a
  // getter that builds a new array, and componentProperties a new object — so
  // depend on stable string digests of them instead of their identities.
  const propsKey = Object.entries(componentProperties)
    .map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 32 ? v.length : String(v)}`)
    .join('|');
  const pinsKey = pinInfo.map((p) => `${p.name}:${p.x},${p.y}`).join('|');
  // componentMetadata is stable for components (the registry hands back the
  // same object) but NOT for boards, whose metadata the canvas builds inline
  // per render — depending on its identity remounted the preview on every
  // parent render and the dialog flickered under the pointer.
  const metaKey = `${componentMetadata.id}|${componentMetadata.tagName}|${Object.entries(
    componentMetadata.defaultValues ?? {},
  )
    .map(([k, v]) => `${k}=${String(v).slice(0, 24)}`)
    .join(',')}`;
  const metaRef = useRef(componentMetadata);
  metaRef.current = componentMetadata;

  // ── Live preview: mount the real element, measure, lay out pins ──────────
  useEffect(() => {
    const host = previewHostRef.current;
    if (!host) return;
    setPreviewFailed(false);
    setLayout(null);
    host.textContent = '';

    type PreviewEl = HTMLElement & {
      pinInfo?: Array<{ name: string; x: number; y: number; signals?: any[] }>;
    };
    const tag = previewTagName || metaRef.current.tagName;
    let el: PreviewEl | null = null;
    if (tag && customElements.get(tag)) {
      el = document.createElement(tag) as PreviewEl;
      // Apply the instance's properties (an LED's color/flip changes both the
      // art and, for flip, the pinInfo itself), then the metadata defaults for
      // whatever the instance does not carry.
      for (const [k, v] of Object.entries({
        ...metaRef.current.defaultValues,
        ...componentProperties,
      })) {
        try {
          (el as any)[k] = v;
        } catch {
          /* read-only prop on some element - ignore */
        }
      }
      // Boards select their art through an ATTRIBUTE (board-kind), not a
      // property: velxio-esp32 renders nothing until it has one.
      for (const [k, v] of Object.entries(previewAttributes ?? {})) el!.setAttribute(k, v);
    } else {
      // Not a registered custom element. The Pi Linux family draws on the
      // canvas as a plain <img> React wrapper carrying pinInfo as a JS
      // property — so the old "unregistered tag → give up" path showed the
      // Pi 3/4/5 inspector with NO pins at all. Clone the live canvas node
      // instead: same art, same natural size, pins from the pinInfo prop.
      const live = document.getElementById(componentId);
      if (live) {
        el = live.cloneNode(true) as HTMLElement;
        el.removeAttribute('id');
        // Neutralize the canvas placement so the clone lays out at its
        // natural size inside the preview box.
        el.style.position = 'static';
        el.style.left = '';
        el.style.top = '';
      }
    }
    if (!el) {
      // No element and no live node: the header thumbnail already shows the
      // art, so the preview just reports there is nothing live to mount.
      setPreviewFailed(true);
      return;
    }
    const pel: PreviewEl = el;
    pel.classList.add('pid-preview-element');
    host.appendChild(pel);

    let cancelled = false;
    let tries = 0;
    const measure = () => {
      if (cancelled) return;
      const w = pel.offsetWidth;
      const h = pel.offsetHeight;
      if ((w < 2 || h < 2) && tries < 12) {
        // Elements render in connectedCallback and settle a tick later —
        // same retry pattern as the canvas PinOverlay (issues #230/#232).
        tries++;
        setTimeout(() => requestAnimationFrame(measure), tries < 4 ? 16 : 50);
        return;
      }
      if (w < 2 || h < 2) {
        setPreviewFailed(true);
        return;
      }
      const pins: InspectorPinInput[] =
        (pel.pinInfo && pel.pinInfo.length ? pel.pinInfo : pinInfo) ?? [];
      // Wide many-pin boards (Arduino Mega, the Pi Linux family) show
      // ROTATED 90°: their pins live in long horizontal rows whose labels
      // crowd past the art width; as side columns the labels stack
      // vertically, where the taller art box has room.
      const rotate = w > h * 1.25 && pins.length >= 40;
      const layoutPins = rotate
        ? pins.map((p) => ({ ...p, x: h - p.y, y: p.x }))
        : pins;
      const natural = rotate ? { width: h, height: w } : { width: w, height: h };
      const result = layoutInspectorPins(layoutPins, natural, {
        maxArtWidth: PINS_ART,
        maxArtHeight: rotate ? PINS_ART_ROTATED_H : PINS_ART,
      });
      // translate+rotate about the top-left maps (x,y) → (h−y, x) scaled —
      // exactly the transform applied to layoutPins above, so dots land on
      // the rotated pads.
      pel.style.transform = rotate
        ? `translate(${h * result.scale}px, 0px) rotate(90deg) scale(${result.scale})`
        : `scale(${result.scale})`;
      pel.style.transformOrigin = 'top left';
      setLayout(result);
    };
    requestAnimationFrame(measure);

    // Some parts move their pins at runtime (LED flip, custom chip JSON).
    const onPinsChange = () => requestAnimationFrame(measure);
    pel.addEventListener('pininfo-change', onPinsChange);
    return () => {
      cancelled = true;
      pel.removeEventListener('pininfo-change', onPinsChange);
      host.textContent = '';
    };
    // propsKey/pinsKey stand in for componentProperties/pinInfo: a real change
    // (a colour edit, an LED flip) changes the digest and repaints; a bare
    // re-render does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaKey, propsKey, pinsKey, previewTagName]);

  // ── Position: viewport coords, clamped, portaled to body ─────────────────
  // NOTE the guard inside place(): setDialogPos only fires on a real move.
  // Without it the ResizeObserver below and this effect feed each other and
  // the dialog jitters.
  // Re-run on every SIZE change, not just on the inputs we can name. The
  // datasheet arrives asynchronously (loadDoc) and the markdown can be long,
  // so a one-shot measure placed the dialog while it was still short and it
  // then grew off the bottom of the screen — the user only saw it corrected
  // when some other event happened to re-render and re-measure it.
  useLayoutEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const place = () => {
      const margin = 12;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let x = position.x + 16;
      let y = position.y;
      if (x + w > vw - margin) x = Math.max(margin, position.x - w - 16);
      x = Math.max(margin, Math.min(x, vw - w - margin));
      y = Math.max(margin, Math.min(y, vh - h - margin));
      setDialogPos((prev) =>
        prev && Math.abs(prev.x - x) < 0.5 && Math.abs(prev.y - y) < 0.5 ? prev : { x, y },
      );
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [position]);

  // ── Delete goes through the global confirm modal ─────────────────────────
  // Same pattern as FileExplorer / BoardOptionsModal. The old inline
  // confirmation swapped the action bar's contents in place, which made the
  // buttons jump around. While the modal is open the dialog's Escape and
  // click-outside close handlers must stand down — the modal is portaled to
  // document.body, so interacting with it looks like "outside" to them.
  const confirmOpenRef = useRef(false);
  const handleDeleteClick = async () => {
    if (skipDeleteConfirm) {
      onDelete(componentId);
      return;
    }
    confirmOpenRef.current = true;
    const confirmed = await showConfirmDialog(
      t('editor.componentProps.confirmDelete', { name: componentMetadata.name }),
      {
        kind: 'error',
        title: t('editor.componentProps.confirmDeleteTitle'),
        confirmLabel: deleteLabel ?? t('editor.componentProps.delete'),
        cancelLabel: t('editor.componentProps.cancel'),
        danger: true,
      },
    );
    confirmOpenRef.current = false;
    if (confirmed) onDelete(componentId);
  };

  // ── Close behaviours (unchanged semantics) ───────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirmOpenRef.current) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (confirmOpenRef.current) return;
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) onClose();
    };
    // Delay to avoid immediate close from the click that opened the dialog.
    const timer = setTimeout(() => document.addEventListener('mousedown', handleClickOutside), 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // ── Data for the datasheet tab (the picker card's own body) ──────────────
  const panelData: PanelData = {
    id: componentMetadata.id,
    name: componentMetadata.name,
    category: displayCategory(componentMetadata.category),
    description: componentMetadata.description,
    pinCount: componentMetadata.pinCount,
    properties: componentMetadata.properties,
    tags: componentMetadata.tags ?? [],
    thumbnail: componentMetadata.thumbnail,
    pro_only: componentMetadata.pro_only,
  };

  const svgThumb =
    componentMetadata.thumbnail && componentMetadata.thumbnail.trim().startsWith('<svg')
      ? componentMetadata.thumbnail
      : null;

  // Same http(s)-only guard the picker card applies — docs are a surface the
  // pro overlay can write to, so the validation is load-bearing.
  const buyHref = safeHref(doc?.buy);

  const editableProps = componentMetadata.properties.filter((p: any) => isEditable(p));
  const readOnlyProps = componentMetadata.properties.filter(
    (p: any) => !isEditable(p) && !HIDDEN_PROPS.has(p.name),
  );

  const pinTitle = (name: string, description?: string) => {
    const base = description ? `${name} (${description})` : name;
    if (!onPinSelect) return base;
    return `${base} - ${wireInProgress ? t('editor.componentProps.tapToConnect') : t('editor.componentProps.tapToWire')}`;
  };

  return createPortal(
    <div
      ref={dialogRef}
      className="part-inspector-dialog"
      style={{
        left: `${dialogPos?.x ?? position.x}px`,
        top: `${dialogPos?.y ?? position.y}px`,
        opacity: dialogPos ? 1 : 0,
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Header: art + name + badges + brand, like the picker card. */}
      <div className="pid-header">
        {svgThumb && <div className="pid-thumb" dangerouslySetInnerHTML={{ __html: svgThumb }} />}
        <div className="pid-title">
          <span className="pid-name">{componentMetadata.name}</span>
          <span className="pid-badges">
            <span className="pid-cat">{panelData.category}</span>
            {componentMetadata.pro_only && <span className="pid-pro">PRO</span>}
            {componentMetadata.pinCount > 0 && (
              <span className="pid-pins-badge">{componentMetadata.pinCount} pins</span>
            )}
          </span>
          {doc?.brand && <span className="pid-brand">by {doc.brand}</span>}
        </div>
        <button className="pid-close" onClick={onClose} title={t('editor.componentProps.close')}>
          ×
        </button>
      </div>

      <div className="pid-columns">
        {/* Left column: live preview, pin toggle, actions. */}
        <div className="pid-left">
          <div
            className="pid-preview pid-preview--pins"
            style={
              layout
                ? {
                    width: layout.artWidth + layout.padLeft + layout.padRight,
                    height: layout.artHeight + layout.padTop + layout.padBottom,
                  }
                : undefined
            }
          >
            <div
              className="pid-preview-art"
              ref={previewHostRef}
              style={layout ? { left: layout.padLeft, top: layout.padTop } : undefined}
            />
            {previewFailed && !svgThumb && <div className="pid-preview-missing">—</div>}
            {previewFailed && svgThumb && (
              <div className="pid-preview-fallback" dangerouslySetInnerHTML={{ __html: svgThumb }} />
            )}

            {/* Pin markers + labels, at their true positions. */}
            {layout &&
              layout.pins.map((p) => {
                const ox = layout.padLeft;
                const oy = layout.padTop;
                const clickable = Boolean(onPinSelect);
                const activate = () => onPinSelect?.(componentId, p.name);
                const lit = hoverPin === p.name;
                // Hovering EITHER the label or the dot lights the whole run:
                // label, leader and pad. On a 32-pin board that is the only
                // way to be sure which pad a gutter name belongs to.
                const trace = {
                  onMouseEnter: () => setHoverPin(p.name),
                  onMouseLeave: () => setHoverPin((c) => (c === p.name ? null : c)),
                  onFocus: () => setHoverPin(p.name),
                  onBlur: () => setHoverPin((c) => (c === p.name ? null : c)),
                };
                return (
                  <React.Fragment key={p.name}>
                    {p.needsLeader && (
                      <svg
                        className={`pid-pin-leader${lit ? ' pid-pin-leader--lit' : ''}`}
                        aria-hidden="true"
                      >
                        <line
                          x1={ox + p.dotX}
                          y1={oy + p.dotY}
                          x2={ox + p.labelX}
                          y2={oy + p.labelY}
                        />
                      </svg>
                    )}
                    <button
                      type="button"
                      className={`pid-pin-dot pid-sig-${p.signalKind}${lit ? ' pid-pin-dot--lit' : ''}`}
                      style={{ left: ox + p.dotX, top: oy + p.dotY }}
                      title={pinTitle(p.name, pinInfo.find((q) => q.name === p.name)?.description)}
                      onClick={clickable ? activate : undefined}
                      disabled={!clickable}
                      {...trace}
                    />
                    <button
                      type="button"
                      className={`pid-pin-label pid-pin-label--${p.edge}${lit ? ' pid-pin-label--lit' : ''}`}
                      style={{ left: ox + p.labelX, top: oy + p.labelY }}
                      title={pinTitle(p.name, pinInfo.find((q) => q.name === p.name)?.description)}
                      onClick={clickable ? activate : undefined}
                      disabled={!clickable}
                      {...trace}
                    >
                      {p.name}
                    </button>
                  </React.Fragment>
                );
              })}
          </div>

          {pinInfo.length > 0 && (
            <div className="pid-pin-hint">
              {wireInProgress
                ? t('editor.componentProps.tapToConnect')
                : onPinSelect
                  ? t('editor.componentProps.tapToWire')
                  : t('editor.componentProps.pinRoles')}
            </div>
          )}

        </div>

        {/* Right column: tabs. */}
        <div className="pid-right">
          <div className="pid-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === 'properties'}
              className={`pid-tab${tab === 'properties' ? ' pid-tab--active' : ''}`}
              onClick={() => setTab('properties')}
            >
              {t('editor.inspector.propertiesTab')}
            </button>
            <button
              role="tab"
              aria-selected={tab === 'datasheet'}
              className={`pid-tab${tab === 'datasheet' ? ' pid-tab--active' : ''}`}
              onClick={() => setTab('datasheet')}
            >
              {t('editor.inspector.datasheetTab')}
            </button>
          </div>

          {tab === 'properties' ? (
            <div className="pid-tab-body">
              {/* Current Arduino pin assignment (read-only) */}
              {componentProperties.pin !== undefined && (
                <div className="pid-row">
                  <span className="pid-row-label">{t('editor.componentProps.arduinoPin')}</span>
                  <span className="pid-row-value">
                    {componentProperties.pin >= 14
                      ? `A${componentProperties.pin - 14}`
                      : `D${componentProperties.pin}`}
                  </span>
                </div>
              )}

              {/* Editable properties (select / text / number) */}
              {editableProps.map((prop: any) => {
                const current = String(componentProperties[prop.name] ?? prop.defaultValue ?? '');
                if (prop.control === 'select' && prop.options) {
                  return (
                    <div key={prop.name} className="pid-row">
                      <label className="pid-row-label">{prop.description || prop.name}</label>
                      <select
                        className="pid-select"
                        value={current}
                        disabled={readOnly}
                        onChange={(e) => onPropertyChange?.(componentId, prop.name, e.target.value)}
                      >
                        {prop.options.map((opt: string) => (
                          <option key={opt} value={opt}>
                            {opt.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                }
                return (
                  <div key={prop.name} className="pid-row">
                    <label className="pid-row-label">{prop.description || prop.name}</label>
                    <input
                      type={prop.control === 'number' ? 'number' : 'text'}
                      className="pid-input"
                      value={current}
                      disabled={readOnly}
                      onChange={(e) => onPropertyChange?.(componentId, prop.name, e.target.value)}
                    />
                  </div>
                );
              })}

              {/* Custom chip attribute defaults — declared in chip.json's
                  `attributes`, read by the chip via vx_attr_read. These are
                  the design-time values; live tweaking during a run happens
                  in the sensor control panel (chip.json `controls`). */}
              {componentMetadata.id === 'custom-chip' &&
                (() => {
                  let defs: Array<{
                    name: string; label?: string; type?: string;
                    default?: number; min?: number; max?: number; step?: number;
                  }> = [];
                  try {
                    const obj = JSON.parse(String(componentProperties.chipJson ?? '{}'));
                    if (Array.isArray(obj.attributes)) defs = obj.attributes;
                  } catch { /* mid-edit manifest */ }
                  if (defs.length === 0) return null;
                  const attrs = (componentProperties.attrs ?? {}) as Record<string, number>;
                  const setAttr = (name: string, v: number) => {
                    const sim = useSimulatorStore.getState();
                    const comp = sim.components.find((c) => c.id === componentId);
                    if (!comp) return;
                    sim.updateComponent(componentId, {
                      properties: {
                        ...comp.properties,
                        attrs: { ...(comp.properties.attrs as Record<string, number> ?? {}), [name]: v },
                      },
                    } as never);
                  };
                  return (
                    <div className="pid-chip-attrs">
                      <div className="pid-row" style={{ opacity: 0.7, fontSize: 11 }}>
                        {t('editor.customChip.attributes')}
                      </div>
                      {defs.filter((d) => d && d.name).map((d) => {
                        const isInt = d.type === 'int';
                        const value = Number.isFinite(attrs[d.name])
                          ? attrs[d.name]
                          : (d.default ?? 0);
                        const showSlider = d.min !== undefined && d.max !== undefined;
                        return (
                          <div key={d.name} className="pid-row">
                            <label className="pid-row-label">{d.label || d.name}</label>
                            {showSlider && (
                              <input
                                type="range"
                                min={d.min}
                                max={d.max}
                                step={d.step ?? (isInt ? 1 : 0.01)}
                                value={value}
                                onChange={(e) => {
                                  const v = parseFloat(e.target.value);
                                  if (Number.isFinite(v)) setAttr(d.name, isInt ? Math.round(v) : v);
                                }}
                                style={{ flex: 1 }}
                              />
                            )}
                            <input
                              type="number"
                              className="pid-input"
                              style={{ width: 76 }}
                              min={d.min}
                              max={d.max}
                              step={d.step ?? (isInt ? 1 : 0.01)}
                              value={value}
                              onChange={(e) => {
                                const v = parseFloat(e.target.value);
                                if (Number.isFinite(v)) setAttr(d.name, isInt ? Math.round(v) : v);
                              }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}

              {/* Keyboard binding - drive this pushbutton with a keyboard key */}
              {isKeyBindable(componentMetadata.id) && (
                <div className="pid-keybind">
                  <div className="pid-row">
                    <label className="pid-row-label">{t('editor.componentProps.keyboardKey')}</label>
                    <div className="keybind-controls">
                      <button
                        type="button"
                        className={`keybind-chip${capturingKey ? ' keybind-chip--capturing' : ''}${
                          !boundKey && !capturingKey ? ' keybind-chip--empty' : ''
                        }`}
                        onClick={() => setCapturingKey((c) => !c)}
                      >
                        {capturingKey
                          ? t('editor.componentProps.pressAKey')
                          : boundKey
                            ? formatKeyLabel(boundKey)
                            : t('editor.componentProps.assignKey')}
                      </button>
                      {boundKey && !capturingKey && (
                        <button
                          type="button"
                          className="keybind-clear"
                          title={t('editor.componentProps.clearKey')}
                          onClick={() => onPropertyChange?.(componentId, 'key', '')}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </div>
                  {keyInUseElsewhere && (
                    <div className="keybind-hint">{t('editor.componentProps.keyInUse')}</div>
                  )}
                </div>
              )}

              {/* microSD upload panel: the standalone card and any part that
                  declares its own TF slot (metadata.sdSlot). For a board
                  (sdSlot) the componentId IS the board id. For a card on the
                  canvas it names the card itself, so the listing comes from
                  THAT card's model even when the canvas holds two of them. */}
              {(componentMetadata.id === 'microsd-card' || componentMetadata.sdSlot === true) && (
                <SdCardPanel
                  files={(componentProperties.sdFiles as UploadedSdFile[] | undefined) ?? []}
                  onChange={(next) => onPropertyChange?.(componentId, 'sdFiles', next)}
                  boardId={componentMetadata.sdSlot === true ? componentId : undefined}
                  componentId={componentMetadata.sdSlot === true ? undefined : componentId}
                />
              )}

              {/* Remaining defaults, read-only, like the picker card shows. */}
              {readOnlyProps.length > 0 && (
                <div className="pid-defaults">
                  {readOnlyProps.slice(0, 8).map((p) => (
                    <div className="pid-row pid-row--dim" key={p.name}>
                      <span className="pid-row-label">{p.name}</span>
                      <span className="pid-row-value">{formatValue(p)}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Gallery examples that use this part — each opens the live
                  editor (/example/:id) in a new tab, so the running project
                  is never disturbed. */}
              {partExamples.length > 0 && (
                <div className="pid-examples">
                  <div className="pid-examples-title">
                    {t('editor.inspector.examplesTitle')}
                  </div>
                  {partExamples.slice(0, 8).map((ex) => (
                    <a
                      key={ex.id}
                      className="pid-example-link"
                      href={`/example/${ex.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={ex.description}
                    >
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                      </svg>
                      <span>{ex.title}</span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="pid-tab-body pid-tab-body--doc">
              <ComponentInfoBody data={panelData} showProps={false} />
            </div>
          )}
        </div>
      </div>

        <div className="pid-actions">
          {/* Boards pass no onRotate (they do not rotate); they pass
              Board Options / Flash as extraActions instead. */}
          {onRotate && !readOnly && (
            <button
              className="pid-action-button"
              onClick={() => onRotate(componentId)}
              title={t('editor.componentProps.rotate90')}
            >
              {t('editor.componentProps.rotate')}
            </button>
          )}
          {extraActions?.map((a) => (
            <button
              key={a.id}
              className="pid-action-button"
              onClick={a.disabled ? undefined : a.onSelect}
              disabled={a.disabled}
              title={a.title}
            >
              {a.label}
            </button>
          ))}
          {!readOnly && (
            <button
              className="pid-action-button pid-action-delete"
              onClick={handleDeleteClick}
              title={t('editor.componentProps.deleteTitle')}
            >
              {deleteLabel ?? t('editor.componentProps.delete')}
            </button>
          )}

          {/* Buy lives here, right-aligned, so it is reachable from BOTH
              tabs — it used to sit at the end of the datasheet body, which
              meant scrolling to the bottom of the right tab to find it. */}
          {buyHref && (
            <div className="pid-actions-right">
              <a
                className="pid-buy-button"
                href={productPageHref(buyHref, componentMetadata.id)}
                target="_blank"
                rel="noopener noreferrer"
                title={buyHref}
                onClick={() =>
                  trackProductPageClick(componentMetadata.id, doc?.brand, buyHref)
                }
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
                {productLinkKind(buyHref) === 'docs'
                  ? t('editor.inspector.datasheetPage')
                  : t('editor.inspector.productPage')}
              </a>
            </div>
          )}
        </div>
    </div>,
    document.body,
  );
};

/**
 * How the editor toolbar strip is laid out in the header: on the brand row
 * or on its own full-width bar below it, and with labels or icon-only.
 *
 * The strip rides inside the header next to the brand + menus. When the
 * window is small or the AI chat is docked, one row genuinely cannot hold
 * it and it must drop to a full-width second bar; and before that, its
 * labels (Serial / Camera / Mic / Scope / Add / Libraries) go icon-only.
 * Deciding either with media / container queries meant guessing widths
 * (1040 / 1060 / 1400px by chat state; 1010px for the labels) that were
 * only right for one board: a XIAO with display + camera + mic + scope
 * needs a wider strip than an Uno, so at 1440px with the chat docked the
 * strip wrapped INSIDE the header — an orphan group of canvas controls
 * floating in a tall header next to a black hole — and, once dropped
 * below, kept its labels at 1060px and wrapped that bar in two as well.
 *
 * So the header measures instead. Pure decision over measured widths so it
 * can be unit-tested; `AppHeader` wires it to a ResizeObserver.
 */

export interface StripFitInput {
  /** Width of `.header-content` — the row the brand, menus and strip share. */
  contentWidth: number;
  /** Width of `.header-left` (brand + menus), pinned to the first row. */
  leftWidth: number;
  /** Horizontal margins of the strip host (`.header-editor-toolbar`) on the
   *  brand row (positive) and as its own bar (negative: it bleeds into the
   *  header padding). */
  hostMarginXInline: number;
  hostMarginXBelow: number;
  /** Horizontal padding of the strip itself (`.unified-toolbar`). */
  stripPaddingX: number;
  /** Natural OUTER width of each strip zone at its own content size —
   *  border box plus horizontal margins — measured IN the candidate layout
   *  it is compared against, since the zones carry their own container
   *  queries (the view-mode toggle hides under 760px, its labels under
   *  1140px, the board pill under 905px), so the same strip is wider on the
   *  wide own-bar than on the narrow brand row.
   *
   *  Margins are part of the width on purpose: the view-mode toggle carries
   *  `margin: 0 6px`, and leaving those 12px out made the decision claim a
   *  strip fit on one row when it did not. It then WRAPPED inside the header
   *  instead of collapsing to icons — a 44px row silently becoming 83px,
   *  with the canvas controls stranded on a second line. Anything that
   *  contributes to the row's used width belongs in this number. */
  inlineZoneWidths: readonly number[];
  inlineCompactZoneWidths: readonly number[];
  belowZoneWidths: readonly number[];
}

export interface StripLayout {
  /** The strip drops to a full-width bar under the brand row. */
  below: boolean;
  /** The strip's first collapse tier (labels -> icons) is forced on. */
  compact: boolean;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** Natural single-row width the strip needs in a candidate layout. */
export function stripNeededWidth(
  i: StripFitInput,
  layout: 'inline' | 'inline-compact' | 'below' = 'inline',
): number {
  const zones =
    layout === 'inline'
      ? i.inlineZoneWidths
      : layout === 'inline-compact'
        ? i.inlineCompactZoneWidths
        : i.belowZoneWidths;
  return sum(zones) + i.stripPaddingX;
}

/** Width the strip gets on the brand row next to the brand + menus. */
export function stripAvailableInline(i: StripFitInput): number {
  return i.contentWidth - i.leftWidth - i.hostMarginXInline;
}

/** Width the strip gets as its own bar. */
export function stripAvailableBelow(i: StripFitInput): number {
  return i.contentWidth - i.hostMarginXBelow;
}

/**
 * One row beats two: stay on the brand row with labels if they fit, else
 * icon-only if that fits; only then drop below — with labels if the full
 * bar holds them, icon-only otherwise (past that the bar wraps, which is
 * the phone regime).
 */
export function decideStripLayout(i: StripFitInput): StripLayout {
  const inline = stripAvailableInline(i);
  if (stripNeededWidth(i, 'inline') <= inline) return { below: false, compact: false };
  if (stripNeededWidth(i, 'inline-compact') <= inline) return { below: false, compact: true };
  return { below: true, compact: stripNeededWidth(i, 'below') > stripAvailableBelow(i) };
}

export const STRIP_BELOW_CLASS = 'app-header--strip-below';
export const STRIP_COMPACT_CLASS = 'unified-toolbar--compact';

/**
 * Measure the live header in the three layouts the decision compares —
 * brand-row with labels, brand-row compact, own-bar with labels — by
 * toggling the two classes and reading widths, then restoring what was
 * there. Zones are read at
 * `flex: 0 0 auto` so a zone flexbox has grown to fill the row (the editor
 * zone) reports its content width, not the width it happens to occupy.
 * Everything runs synchronously before the rendering step: nothing paints
 * in between and ResizeObserver never sees the transients.
 */
export function measureStripFit(header: HTMLElement): StripFitInput | null {
  const content = header.querySelector<HTMLElement>(':scope > .header-content');
  const left = content?.querySelector<HTMLElement>(':scope > .header-left');
  const host = content?.querySelector<HTMLElement>(':scope > .header-editor-toolbar');
  const strip = host?.firstElementChild as HTMLElement | null | undefined;
  if (!content || !left || !host || !strip) return null;

  const hadBelow = header.classList.contains(STRIP_BELOW_CLASS);
  const hadCompact = strip.classList.contains(STRIP_COMPACT_CLASS);
  const zones = Array.from(strip.children) as HTMLElement[];
  const savedFlex = zones.map((z) => z.style.flex);
  const px = (v: string) => parseFloat(v) || 0;
  const marginX = (el: HTMLElement) => {
    const cs = getComputedStyle(el);
    return px(cs.marginLeft) + px(cs.marginRight);
  };
  /** Outer width: what the zone actually consumes on the row. Margins are
   *  outside getBoundingClientRect, so they have to be added back. */
  const zoneWidths = () => zones.map((z) => z.getBoundingClientRect().width + marginX(z));

  try {
    for (const z of zones) z.style.flex = '0 0 auto';
    header.classList.remove(STRIP_BELOW_CLASS);
    strip.classList.remove(STRIP_COMPACT_CLASS);
    const inlineZoneWidths = zoneWidths();
    const stripCs = getComputedStyle(strip);
    const stripPaddingX = px(stripCs.paddingLeft) + px(stripCs.paddingRight);
    const hostMarginXInline = marginX(host);
    const contentWidth = content.clientWidth;
    const leftWidth = left.getBoundingClientRect().width;

    strip.classList.add(STRIP_COMPACT_CLASS);
    const inlineCompactZoneWidths = zoneWidths();

    strip.classList.remove(STRIP_COMPACT_CLASS);
    header.classList.add(STRIP_BELOW_CLASS);
    const belowZoneWidths = zoneWidths();
    const hostMarginXBelow = marginX(host);

    return {
      contentWidth,
      leftWidth,
      hostMarginXInline,
      hostMarginXBelow,
      stripPaddingX,
      inlineZoneWidths,
      inlineCompactZoneWidths,
      belowZoneWidths,
    };
  } finally {
    zones.forEach((z, k) => {
      z.style.flex = savedFlex[k];
    });
    header.classList.toggle(STRIP_BELOW_CLASS, hadBelow);
    strip.classList.toggle(STRIP_COMPACT_CLASS, hadCompact);
  }
}

/** Measure and apply: the two classes end up matching the decision. */
export function applyStripLayout(header: HTMLElement): StripLayout | null {
  const m = measureStripFit(header);
  if (!m) return null;
  const layout = decideStripLayout(m);
  header.classList.toggle(STRIP_BELOW_CLASS, layout.below);
  const content = header.querySelector<HTMLElement>(':scope > .header-content');
  const strip = content?.querySelector<HTMLElement>(':scope > .header-editor-toolbar > *');
  if (content && strip) {
    strip.classList.toggle(STRIP_COMPACT_CLASS, layout.compact);
    // The brand and menus live outside the strip. Balance their width on
    // the other side so the layout switch stays centered in the whole row.
    const row = content.getBoundingClientRect();
    const toolbar = strip.getBoundingClientRect();
    const imbalance = toolbar.left - row.left - (row.right - toolbar.right);
    strip.style.setProperty('--workspace-toolbar-balance', `${Math.max(0, imbalance)}px`);
  }
  return layout;
}

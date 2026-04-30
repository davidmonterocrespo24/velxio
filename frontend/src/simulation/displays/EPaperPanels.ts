/**
 * EPaperPanels — per-panel geometry + controller assignments.
 *
 * Phase 1 ships the SSD168x mono family. Adding a panel = add an entry
 * here; the Web Component, simulation hook, and ESP32 backend slave all
 * key off the `id` field. See `test/test_epaper/autosearch/06_svg_layouts.md`
 * for sources.
 */

export type EPaperControllerFamily = 'ssd168x' | 'uc8159c';

/**
 * Visible palette for a panel.
 *  - 'bw'   → black / white only (single 1-bit RAM plane)
 *  - 'bwr'  → black / white / red (two 1-bit RAM planes; red wins on compose)
 *  - 'acep' → 7-colour ACeP (single 3-bit-per-pixel RAM, palette 0..6)
 */
export type EPaperPalette = 'bw' | 'bwr' | 'acep';

export interface EPaperPanelConfig {
  /** Unique kebab-case identifier — also the metadataId used by the registry. */
  id: string;
  /** Human-readable label (gallery card). */
  name: string;
  /** Active area resolution, in panel-native pixels. */
  width: number;
  height: number;
  /** Panel body width including bezel + FPC strip (CSS px). */
  bodyW: number;
  bodyH: number;
  /** Bezel margin on the canvas (CSS px). */
  bezelPx: number;
  /** FPC tail height (CSS px). */
  fpcStripPx: number;
  /** Default refresh duration the emulator drives BUSY high for (ms). */
  refreshMs: number;
  /** Controller family — picks the decoder. */
  controllerFamily: EPaperControllerFamily;
  /** Concrete controller IC (informational, drives the Inspector tooltip). */
  controllerIc: string;
  /** Visible palette. Tri-colour panels (B/W/R) use the red RAM plane. */
  palette: EPaperPalette;
}

export const PANEL_CONFIGS: Record<string, EPaperPanelConfig> = {
  // ── 1.54" 200×200 — the canonical Phase-1 panel ─────────────────────
  'epaper-1in54-bw': {
    id: 'epaper-1in54-bw',
    name: '1.54" ePaper (200×200, B/W)',
    width: 200,
    height: 200,
    bodyW: 240,
    bodyH: 280,
    bezelPx: 14,
    fpcStripPx: 36,
    refreshMs: 50,
    controllerFamily: 'ssd168x',
    controllerIc: 'SSD1681',
    palette: 'bw',
  },

  // ── 2.13" 250×122 — most popular community badge size ───────────────
  'epaper-2in13-bw': {
    id: 'epaper-2in13-bw',
    name: '2.13" ePaper (250×122, B/W)',
    width: 250,
    height: 122,
    bodyW: 290,
    bodyH: 170,
    bezelPx: 14,
    fpcStripPx: 32,
    refreshMs: 50,
    controllerFamily: 'ssd168x',
    controllerIc: 'SSD1675A / IL3897',
    palette: 'bw',
  },

  // ── 2.13" 250×122 tri-colour B/W/R ───────────────────────────────────
  'epaper-2in13-bwr': {
    id: 'epaper-2in13-bwr',
    name: '2.13" ePaper (250×122, B/W/Red)',
    width: 250,
    height: 122,
    bodyW: 290,
    bodyH: 170,
    bezelPx: 14,
    fpcStripPx: 32,
    refreshMs: 80,
    controllerFamily: 'ssd168x',
    controllerIc: 'SSD1680 (3-colour)',
    palette: 'bwr',
  },

  // ── 2.9" 296×128 — slightly bigger badge size ───────────────────────
  'epaper-2in9-bw': {
    id: 'epaper-2in9-bw',
    name: '2.9" ePaper (296×128, B/W)',
    width: 296,
    height: 128,
    bodyW: 340,
    bodyH: 180,
    bezelPx: 16,
    fpcStripPx: 32,
    refreshMs: 50,
    controllerFamily: 'ssd168x',
    controllerIc: 'SSD1680',
    palette: 'bw',
  },

  // ── 2.9" 296×128 tri-colour B/W/R ────────────────────────────────────
  'epaper-2in9-bwr': {
    id: 'epaper-2in9-bwr',
    name: '2.9" ePaper (296×128, B/W/Red)',
    width: 296,
    height: 128,
    bodyW: 340,
    bodyH: 180,
    bezelPx: 16,
    fpcStripPx: 32,
    refreshMs: 80,
    controllerFamily: 'ssd168x',
    controllerIc: 'SSD1680 (3-colour)',
    palette: 'bwr',
  },

  // ── 4.2" 400×300 — mid-size, popular for dashboards ─────────────────
  'epaper-4in2-bw': {
    id: 'epaper-4in2-bw',
    name: '4.2" ePaper (400×300, B/W)',
    width: 400,
    height: 300,
    bodyW: 440,
    bodyH: 360,
    bezelPx: 16,
    fpcStripPx: 36,
    refreshMs: 80,
    controllerFamily: 'ssd168x',
    controllerIc: 'SSD1683 / UC8176',
    palette: 'bw',
  },

  // ── 7.5" 800×480 — biggest mono panel we ship in Phase 1 ────────────
  'epaper-7in5-bw': {
    id: 'epaper-7in5-bw',
    name: '7.5" ePaper (800×480, B/W)',
    width: 800,
    height: 480,
    bodyW: 860,
    bodyH: 540,
    bezelPx: 24,
    fpcStripPx: 36,
    refreshMs: 100,
    controllerFamily: 'ssd168x',
    controllerIc: 'UC8179 / GD7965',
    palette: 'bw',
  },

  // ── 5.65" 600×448 — ACeP 7-colour (UC8159c family) ──────────────────
  // Real refresh time: ~12 s. We default to 150 ms emulator pulse.
  'epaper-5in65-7c': {
    id: 'epaper-5in65-7c',
    name: '5.65" ePaper (600×448, ACeP 7-colour)',
    width: 600,
    height: 448,
    bodyW: 660,
    bodyH: 520,
    bezelPx: 22,
    fpcStripPx: 36,
    refreshMs: 150,
    controllerFamily: 'uc8159c',
    controllerIc: 'UC8159c',
    palette: 'acep',
  },
};

export const PANEL_IDS = Object.keys(PANEL_CONFIGS);

/** Default if the Web Component is mounted without a panel-kind attribute. */
export const DEFAULT_PANEL_KIND = 'epaper-1in54-bw';

export function getPanelConfig(panelKind: string | null | undefined): EPaperPanelConfig {
  return PANEL_CONFIGS[panelKind ?? DEFAULT_PANEL_KIND] ?? PANEL_CONFIGS[DEFAULT_PANEL_KIND];
}

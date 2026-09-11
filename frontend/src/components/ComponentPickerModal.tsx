/**
 * Component Picker Modal
 *
 * Modal interface for searching and selecting components from the wokwi-elements library.
 * Features:
 * - Search bar with real-time filtering
 * - Category tabs for filtering
 * - Grid layout with component thumbnails
 * - Click to select and add component
 */

import React, { useState, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ComponentRegistry } from '../services/ComponentRegistry';
import type { ComponentMetadata, ComponentCategory } from '../types/component-metadata';
import { ComponentInfoPanel, HOVER_DELAY, type HoverTarget, type PanelData } from './ComponentInfoPanel';

// Grace period after the pointer leaves a card before the datasheet popover
// hides — long enough to cross the gap onto the (interactive) panel. Must be
// comfortably larger than HOVER_DELAY so re-entering a card cancels the hide
// before it fires.
const HIDE_DELAY = 220;

/** Hover controls handed to each card so it can drive the shared popover. */
interface CardHoverApi {
  show: (t: HoverTarget) => void;
  cancelHide: () => void;
  scheduleHide: () => void;
  /** Current show generation — an armed show is void once this changes. */
  showGen: () => number;
}
import type { BoardKind } from '../types/board';
import { BOARD_KIND_LABELS } from '../types/board';
import { isProBoardKind } from '../lib/proBoardGate';
import { matchesSearch } from '../utils/searchMatch';
import { boardSearchKeywords } from '../data/componentSearchKeywords';
import {
  getProBoard,
  listProBoards,
  subscribeProBoards,
  getProBoardsVersion,
} from '../lib/proBoardRegistry';
import {
  ONLINE_ONLY_BOARD_ADS,
  ONLINE_ONLY_COMPONENT_ADS,
  ONLINE_EDITOR_URL,
  isOnlineOnlyAdSuppressed,
  type OnlineOnlyBoardAd,
  type OnlineOnlyComponentAd,
} from '../lib/onlineOnlyBoards';
import raspberryPiZeroSvg from '../assets/Raspberry_Pi_Zero_illustration.svg';
import raspberryPi1Svg from '../assets/Raspberry_Pi_1_illustration.svg';
import raspberryPi2Svg from '../assets/Raspberry_Pi_2_illustration.svg';
import raspberryPi3Svg from '../assets/Raspberry_Pi_3_illustration.svg';
import raspberryPi4Png from '../assets/raspberry-pi-4-board.png';
import raspberryPi5Png from '../assets/raspberry-pi-5-board.png';
import { Attiny85 } from './velxio-components/Attiny85';
import './velxio-components/Esp32Element'; // registers velxio-esp32
import './velxio-components/PiPicoWElement'; // registers velxio-pi-pico-w
import './velxio-components/Stm32BluePillElement'; // registers velxio-stm32-bluepill
import './velxio-components/Ssd1306I2cElement'; // registers velxio-ssd1306-i2c-4pin
// Register every wokwi tag that the picker might try to instantiate as a
// thumbnail. The picker calls `document.createElement(tagName)`, so any tag
// that isn't already a registered custom element renders as an empty
// HTMLUnknownElement (blank card preview).
import '@wokwi/elements';
import '../velxio-elements';
import './ComponentPickerModal.css';

interface ComponentPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectComponent: (metadata: ComponentMetadata) => void;
  onSelectBoard?: (kind: BoardKind) => void;
}

const BOARD_DESCRIPTIONS: Record<BoardKind, string> = {
  'arduino-uno': '8-bit AVR, 32KB flash, 14 digital I/O',
  'arduino-nano': 'Compact 8-bit AVR, same as Uno',
  'arduino-mega': '8-bit AVR, 256KB flash, 54 digital I/O',
  'raspberry-pi-pico': 'RP2040 dual-core Cortex-M0+',
  'pi-pico-w': 'RP2040 + WiFi/BT, same emulator as Pico',
  'raspberry-pi-zero': 'ARM Cortex-A7, 1 core / 512 MB, Linux/Python (QEMU)',
  'raspberry-pi-1': 'Pi 1 B+, ARM Cortex-A7 profile, Linux/Python (QEMU)',
  'raspberry-pi-2': 'Pi 2B, ARM Cortex-A7 quad-core, Linux/Python (QEMU)',
  'raspberry-pi-3': 'ARM64 Cortex-A53 quad-core, Linux/Python (QEMU)',
  'raspberry-pi-4': 'ARM64 Cortex-A72 quad-core, Linux/Python (QEMU)',
  'raspberry-pi-5': 'ARM64 Cortex-A76 quad-core + RP1 I/O, Linux/Python (QEMU)',
  esp32: 'Xtensa LX6 dual-core, WiFi+BT, 38 GPIO (QEMU)',
  'esp32-devkit-c-v4': 'ESP32 DevKit C V4, official Espressif (QEMU)',
  'esp32-cam': 'ESP32 + 2MP camera, microSD (QEMU)',
  'wemos-lolin32-lite': 'Compact ESP32, LiPo battery support (QEMU)',
  'esp32-s3': 'Xtensa LX7 dual-core, WiFi+BT, AI accel (QEMU)',
  'xiao-esp32-s3': 'Seeed XIAO tiny form, 8MB flash+PSRAM (QEMU)',
  'arduino-nano-esp32': 'Nano form-factor, ESP32-S3, RGB LED (QEMU)',
  'esp32-c3': 'RISC-V single-core, WiFi+BLE, 22 GPIO (QEMU)',
  'xiao-esp32-c3': 'Seeed XIAO ESP32-C3 mini board (QEMU)',
  'aitewinrobot-esp32c3-supermini': 'ESP32-C3 SuperMini (QEMU)',
  'stm32-bluepill': 'STM32F103C8 Cortex-M3, 64KB flash, 37 GPIO (QEMU)',
  'stm32-blackpill': 'STM32F411CE Cortex-M4, 512KB flash, 50 GPIO (QEMU)',
  'stm32-bluepill-f103cb': 'STM32F103CB Cortex-M3, 128KB flash, 37 GPIO (QEMU)',
  'stm32-blackpill-f401': 'STM32F401CE Cortex-M4, 512KB flash, 50 GPIO (QEMU)',
  'stm32-f4-discovery': 'STM32F407VG Cortex-M4, 1MB flash, 4 onboard LEDs (QEMU)',
  'stm32-olimex-h405': 'Olimex STM32-H405, F405RG Cortex-M4, 1MB flash (QEMU)',
  'stm32-netduino-plus2': 'Netduino Plus 2, STM32F405 Cortex-M4 (QEMU)',
  'stm32-netduino2': 'Netduino 2, STM32F205 Cortex-M3 (QEMU, serial)',
  attiny85: '8-bit AVR, 8KB flash, 6 GPIO (browser)',
};

/**
 * wokwi-elements ships art for boards Velxio does not emulate; the metadata
 * auto-scan sweeps them into the registry as plain components. Listing one in
 * the picker promises a board that will never boot, so they are hidden here —
 * NOT deleted from components-metadata.json, because saved projects that
 * already contain one still need the element to render.
 */
const UNSIMULATED_BOARD_SHELLS = new Set(['nano-rp2040-connect']);

/**
 * Parts created only by canvas gestures, never placed from the picker. The
 * junction node is minted by dropping a wire-end onto a wire (or the node
 * tool); a bare junction on empty canvas connects nothing, so offering it
 * here would only confuse. Metadata registration stays mandatory — the
 * canvas renders null for unknown metadataIds — hiding happens HERE only.
 */
const GESTURE_ONLY_COMPONENTS = new Set(['junction']);

/**
 * Maker-first category order for the picker grid and the category filter.
 * Velxio's audience is hobbyist-heavy: everyday digital parts (sensors,
 * LEDs/outputs, displays, buttons) lead, while diodes/resistors/capacitors
 * ('passive'), transistors/op-amps/instruments ('analog') and logic gates
 * sink to the end of the list.
 */
const CATEGORY_ORDER: string[] = [
  'sensors',
  'output',
  'displays',
  'input',
  'motors',
  'communication',
  'electromech',
  'boards',
  'other',
  'passive',
  'analog',
  'logic',
];

function categoryRank(category: string): number {
  const i = CATEGORY_ORDER.indexOf(category);
  // Unknown/future categories land before the passive tail, not after it.
  return i === -1 ? CATEGORY_ORDER.indexOf('other') : i;
}

const ALL_BOARDS: BoardKind[] = [
  'arduino-uno',
  'arduino-nano',
  'arduino-mega',
  'raspberry-pi-pico',
  'pi-pico-w',
  'raspberry-pi-zero',
  'raspberry-pi-1',
  'raspberry-pi-2',
  'raspberry-pi-3',
  'raspberry-pi-4',
  'raspberry-pi-5',
  'esp32',
  'esp32-devkit-c-v4',
  'esp32-cam',
  'wemos-lolin32-lite',
  'esp32-s3',
  'xiao-esp32-s3',
  'arduino-nano-esp32',
  'esp32-c3',
  'xiao-esp32-c3',
  'aitewinrobot-esp32c3-supermini',
  'stm32-bluepill',
  'stm32-blackpill',
  'stm32-bluepill-f103cb',
  'stm32-blackpill-f401',
  'stm32-f4-discovery',
  'stm32-olimex-h405',
  'stm32-netduino-plus2',
  'stm32-netduino2',
  'attiny85',
];

export const ComponentPickerModal: React.FC<ComponentPickerModalProps> = ({
  isOpen,
  onClose,
  onSelectComponent,
  onSelectBoard,
}) => {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<ComponentCategory | 'all' | 'boards'>(
    'all',
  );
  const [registry] = useState(() => ComponentRegistry.getInstance());
  // Late-overlay registrations must re-render an already-mounted picker:
  // the @pro import is dynamic, so boards/components can register AFTER the
  // first render. Without these subscriptions the memos below freeze on the
  // pre-registration state (boards missing, ONLINE ads instead of the real
  // components - and which one you got depended on a reload race).
  const proBoardsVersion = useSyncExternalStore(
    subscribeProBoards,
    getProBoardsVersion,
    getProBoardsVersion,
  );
  const registryVersion = useSyncExternalStore(
    registry.subscribe,
    registry.getVersion,
    registry.getVersion,
  );

  const [isLoading, setIsLoading] = useState(true);
  // Floating datasheet popover shown on card hover. A single instance is
  // driven from here so only one panel ever exists in the DOM. Hiding is
  // DEFERRED through a grace-period timer so the pointer can travel from the
  // card onto the panel (to scroll a long doc or click Buy) without it
  // vanishing: the card's leave arms the hide, the panel's enter cancels it.
  const [hoverTarget, setHoverTarget] = useState<HoverTarget | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  // Monotonic generation stamped when a card arms its show timer. Bumping it
  // invalidates any already-armed show so a grid change (scroll/filter/search)
  // can't pop a panel at a now-stale card rect after the pointer's card reflows.
  const showGenRef = useRef(0);
  const cancelHide = () => window.clearTimeout(hideTimer.current);
  const showPanel = (t: HoverTarget) => {
    window.clearTimeout(hideTimer.current);
    setHoverTarget(t);
  };
  const scheduleHide = () => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setHoverTarget(null), HIDE_DELAY);
  };
  // Immediate hide — used when the grid itself changes under the pointer
  // (scroll, filter, search) so a stale panel never lingers. Also invalidates
  // any armed (not-yet-fired) show timer.
  const clearHover = () => {
    showGenRef.current++;
    window.clearTimeout(hideTimer.current);
    setHoverTarget(null);
  };
  const hoverApi: CardHoverApi = {
    show: showPanel,
    cancelHide,
    scheduleHide,
    showGen: () => showGenRef.current,
  };
  // Clear any pending hide timer if the modal unmounts mid-hover.
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  // The modal stays mounted (parent toggles `isOpen`), so reset the popover
  // when it closes — otherwise a panel left showing at close (e.g. clicking a
  // card to add it, or ESC while hovering) reappears detached on reopen.
  useEffect(() => {
    if (!isOpen) {
      showGenRef.current++;
      window.clearTimeout(hideTimer.current);
      setHoverTarget(null);
    }
  }, [isOpen]);

  // Wait for registry to load
  useEffect(() => {
    const loadRegistry = async () => {
      await registry.load();
      setIsLoading(false);
    };
    loadRegistry();
  }, [registry]);

  // Filter components based on search and category
  const filteredComponents = useMemo(() => {
    if (isLoading) return [];

    let components = searchQuery ? registry.search(searchQuery) : registry.getAllComponents();

    if (selectedCategory !== 'all') {
      components = components.filter((c) => c.category === selectedCategory);
    }

    // Registry entries that ARE boards (the injected Raspberry Pi family)
    // must never render as component cards: the boards row above already
    // shows every BoardKind with the real art, and adding one through the
    // component path drops a dead canvas part instead of a running board
    // (that is how "add a Pi 4" placed a 40-pin prop that never boots).
    components = components.filter((c) => !(c.id in BOARD_KIND_LABELS));

    // wokwi-elements board shells with no simulator behind them. They come
    // in through the metadata auto-scan and offering them reads as board
    // support we don't have. Filtered here rather than removed from the
    // metadata: saved projects that already placed one must keep rendering.
    components = components.filter((c) => !UNSIMULATED_BOARD_SHELLS.has(c.id));
    components = components.filter((c) => !GESTURE_ONLY_COMPONENTS.has(c.id));

    // Maker-first ordering: most users reach for a sensor, an LED or a
    // display far more often than a bare transistor or a 74HC gate, so
    // passives / analog / logic sink to the end. Array.sort is stable —
    // the registry's own order is preserved within each category.
    // While a query is typed the registry already returns best-match
    // first; re-sorting by category would bury "LED" under every sensor
    // whose description mentions one.
    if (!searchQuery.trim()) {
      components = [...components].sort(
        (a, b) => categoryRank(a.category) - categoryRank(b.category),
      );
    }

    return components;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, selectedCategory, registry, isLoading, registryVersion, proBoardsVersion]);


  // Boards list: static OSS kinds + overlay-registered boards (proBoardRegistry).
  const allBoards = useMemo(() => {
    return [...ALL_BOARDS, ...(listProBoards().map((d) => d.kind) as BoardKind[])];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proBoardsVersion]);

  // Online-only component ads: shown where the real component would sit, and
  // hidden automatically in any build whose registry has the real component
  // (the hosted overlay merges it in) — same contract as VISIBLE_BOARD_ADS.
  const visibleComponentAds = useMemo(() => {
    if (isLoading) return [];
    return ONLINE_ONLY_COMPONENT_ADS.filter(
      (ad) =>
        !registry.getById(ad.id) &&
        !isOnlineOnlyAdSuppressed(ad.id) &&
        (selectedCategory === 'all' || ad.category === selectedCategory) &&
        matchesSearch(searchQuery, [ad.label]),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, isLoading, searchQuery, selectedCategory, registryVersion, proBoardsVersion]);

  // Get available categories — same maker-first order as the grid.
  const categories = useMemo(() => {
    if (isLoading) return [];
    return [...registry.getCategories()].sort(
      (a, b) => categoryRank(a) - categoryRank(b),
    );
  }, [registry, isLoading]);

  // Handle ESC key to close modal
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    if (isOpen) {
      window.addEventListener('keydown', handleEsc);
      return () => window.removeEventListener('keydown', handleEsc);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Portal to <body>: the picker must escape the canvas subtree so no ancestor
  // stacking context can pin it below floating panels (e.g. the AI chat).
  return createPortal(
    <div className="component-picker-overlay" onClick={onClose}>
      <div className="component-picker-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header: title + inline search + category filter + close, all on
            one row to maximise the space left for the components grid. */}
        <div className="modal-header">
          <h2>{t('editor.componentPicker.title')}</h2>

          <div className="header-search-wrapper">
            <svg
              className="search-icon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              className="search-input"
              placeholder={t('editor.componentPicker.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                clearHover();
              }}
              autoFocus
            />
            {searchQuery && (
              <button
                className="clear-search-btn"
                onClick={() => setSearchQuery('')}
                aria-label={t('editor.componentPicker.clearSearch')}
              >
                X
              </button>
            )}
          </div>

          <select
            className="category-select"
            value={selectedCategory}
            onChange={(e) => {
              setSelectedCategory(e.target.value as ComponentCategory | 'all' | 'boards');
              clearHover();
            }}
            aria-label="Filter by category"
          >
            <option value="all">{t('editor.componentPicker.allComponents')}</option>
            {categories
              .filter((c) => c !== 'boards')
              .map((category) => (
                <option key={category} value={category}>
                  {ComponentRegistry.getCategoryDisplayName(category)}
                </option>
              ))}
            {onSelectBoard && (
              <option value="boards">{t('editor.componentPicker.boards')}</option>
            )}
          </select>

          <button className="close-btn" onClick={onClose} aria-label={t('editor.componentPicker.close')}>
            X
          </button>
        </div>

        {/* Boards Panel */}
        {selectedCategory === 'boards' ? (
          <div className="components-grid" onScroll={clearHover}>
            {allBoards.map((kind) => (
              <BoardCard
                key={kind}
                kind={kind}
                onSelect={() => {
                  onSelectBoard?.(kind);
                  onClose();
                }}
                hoverApi={hoverApi}
              />
            ))}
            {visibleBoardAds().map((ad) => (
              <OnlineOnlyBoardCard key={ad.id} ad={ad} />
            ))}
          </div>
        ) : (
          <>
            {/* Single scrollable area wrapping both the boards row (only in
                "All Components" view) and the components grid, so the modal
                shows ONE scrollbar instead of two stacked ones. */}
            <div className="components-scroll" onScroll={clearHover}>
              {selectedCategory === 'all' && onSelectBoard && (
                <div
                  className="components-grid components-grid--inline"
                  style={{ borderBottom: '1px solid var(--wb-6)', paddingBottom: 8, marginBottom: 4 }}
                >
                  {allBoards
                    .filter((k) =>
                      matchesSearch(searchQuery, [BOARD_KIND_LABELS[k], k, boardSearchKeywords(k)]),
                    )
                    .map((kind) => (
                      <BoardCard
                        key={kind}
                        kind={kind}
                        onSelect={() => {
                          onSelectBoard(kind);
                          onClose();
                        }}
                        hoverApi={hoverApi}
                      />
                    ))}
                  {visibleBoardAds()
                    .filter((ad) => matchesSearch(searchQuery, [ad.label]))
                    .map((ad) => (
                      <OnlineOnlyBoardCard key={ad.id} ad={ad} />
                    ))}
                </div>
              )}

              <div className="components-grid components-grid--inline">
                {isLoading ? (
                  <div className="loading-state">
                    <div className="spinner"></div>
                    <p>{t('editor.componentPicker.loading')}</p>
                  </div>
                ) : filteredComponents.length === 0 && visibleComponentAds.length === 0 ? (
                  <div className="no-results">
                    <p>{t('editor.componentPicker.noResults')}</p>
                    {searchQuery && (
                      <button
                        className="clear-filters-btn"
                        onClick={() => {
                          setSearchQuery('');
                          setSelectedCategory('all');
                        }}
                      >
                        {t('editor.componentPicker.clearFilters')}
                      </button>
                    )}
                  </div>
                ) : (
                  filteredComponents.map((component) => (
                    <ComponentCard
                      key={component.id}
                      component={component}
                      hoverApi={hoverApi}
                      onSelect={() => {
                        // Pro overlays can intercept clicks on pro_only
                        // components by setting window.__velxio_pro_gate__.
                        // Returning true means "handled — do not pass through".
                        if (component.pro_only) {
                          const gate = (window as unknown as {
                            __velxio_pro_gate__?: (c: typeof component) => boolean;
                          }).__velxio_pro_gate__;
                          if (gate && gate(component)) return;
                        }
                        onSelectComponent(component);
                      }}
                    />
                  ))
                )}
                {!isLoading &&
                  visibleComponentAds.map((ad) => (
                    <OnlineOnlyComponentCard key={ad.id} ad={ad} />
                  ))}
              </div>
            </div>

            {/* Footer Info */}
            <div className="modal-footer">
              <span className="component-count">
                {filteredComponents.length} component{filteredComponents.length !== 1 ? 's' : ''}{' '}
                available
              </span>
            </div>
          </>
        )}
      </div>

      {/* Floating datasheet popover (portals to <body>). Keyed on the anchor
          so it remounts per card and re-measures its position cleanly. */}
      {hoverTarget && (
        <ComponentInfoPanel
          key={`${hoverTarget.data.name}-${Math.round(hoverTarget.rect.left)}-${Math.round(
            hoverTarget.rect.top,
          )}`}
          target={hoverTarget}
          onPanelEnter={cancelHide}
          onPanelLeave={scheduleHide}
        />
      )}
    </div>,
    document.body
  );
};

/**
 * Shared hover behaviour for the picker cards: on enter/focus cancel any
 * pending hide and arm a delayed "show panel"; on leave/blur cancel that arm
 * and hand off to the modal's grace-period hide (so the pointer can travel
 * onto the panel). Always clears its own arm timer on unmount.
 */
function useCardHover(buildData: () => PanelData, api: CardHoverApi) {
  const timer = useRef<number | undefined>(undefined);
  const start = (e: React.MouseEvent | React.FocusEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    api.cancelHide();
    window.clearTimeout(timer.current);
    const gen = api.showGen();
    timer.current = window.setTimeout(() => {
      // Voided if a grid change (clearHover) bumped the generation meanwhile.
      if (api.showGen() !== gen) return;
      api.show({ data: buildData(), rect });
    }, HOVER_DELAY);
  };
  const end = () => {
    window.clearTimeout(timer.current);
    api.scheduleHide();
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { onMouseEnter: start, onMouseLeave: end, onFocus: start, onBlur: end };
}

/**
 * Component Card - Individual component display in the grid
 */
interface ComponentCardProps {
  component: ComponentMetadata;
  onSelect: () => void;
  hoverApi: CardHoverApi;
}

// Passive components (resistor / capacitor / inductor) come with metadata
// thumbnails that already encode the preset value (color bands for resistors,
// value labels for caps/inductors). The live wokwi elements either ignore
// `value` visually or render it identically across presets, so for these we
// short-circuit to the SVG. Everything else still uses the live element so
// LEDs, displays, etc. preview correctly.
const PASSIVE_TAGS = new Set([
  'wokwi-resistor',
  'wokwi-capacitor',
  'velxio-capacitor-electrolytic',
  'wokwi-inductor',
]);

// Static illustrations for the Pi Linux family. A live velxio-raspberry-pi-*
// custom element at natural size + CSS scale keeps its unscaled layout box,
// so the 100px thumbnail clips it to a sliver — images render fully instead.
// Keyed by tagName because the registry's Pi Zero/1/2 entries deliberately
// reuse the Pi 3 board art.
const PI_BOARD_ART: Record<string, string> = {
  'velxio-raspberry-pi-3': raspberryPi3Svg,
  'velxio-raspberry-pi-4': raspberryPi4Png,
  'velxio-raspberry-pi-5': raspberryPi5Png,
};

/** Gold PRO pill shown on cards for paid-gated boards (Pi Linux + STM32). */
const ProBadge: React.FC = () => (
  <span
    title="Pro board — you can place and wire it; running it depends on your plan"
    style={{
      position: 'absolute',
      top: 8,
      right: 8,
      zIndex: 1,
      padding: '3px 10px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 0.6,
      // Ink and fill both fixed: a gold PRO pill is gold on either theme,
      // and --color-feedback-warning is a red-orange in light mode, which
      // this gradient is not meant to be.
      color: '#1a1205',
      background: 'linear-gradient(180deg,#ffd566,#f5a623)',
      boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
    }}
  >
    PRO
  </span>
);

/** Violet CUSTOM pill: a chip from the user's own My Chips library. */
const CustomBadge: React.FC = () => (
  <span
    title="Your saved custom chip — only you see this part"
    style={{
      position: 'absolute',
      top: 8,
      right: 8,
      zIndex: 1,
      padding: '3px 10px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 0.6,
      color: 'var(--wb-13)',
      background: 'linear-gradient(180deg,#8b5cf6,#6d28d9)',
      boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
    }}
  >
    CUSTOM
  </span>
);

const ComponentCard: React.FC<ComponentCardProps> = ({ component, onSelect, hoverApi }) => {
  const thumbnailRef = React.useRef<HTMLDivElement>(null);
  const hover = useCardHover(
    () => ({
      id: component.id,
      name: component.name,
      category: ComponentRegistry.getCategoryDisplayName(component.category),
      description: component.description,
      pinCount: component.pinCount,
      properties: component.properties,
      tags: component.tags,
      thumbnail: component.thumbnail,
      pro_only: component.pro_only,
      custom: component.custom,
    }),
    hoverApi,
  );
  // Two reasons to render the metadata SVG instead of a live element:
  //   1. Passives (resistor / capacitor / inductor) — their preset SVG encodes
  //      the value (color bands, printed label) and the live element doesn't.
  //   2. The tag is not a registered custom element. `document.createElement`
  //      on an unknown tag yields an inert HTMLUnknownElement, so the card
  //      preview came up blank — which is what happened to every part drawn in
  //      React rather than as a web component (the SPICE probes, tagged
  //      `velxio-instr-voltmeter` / `velxio-instr-ammeter`).
  const hasSvgThumbnail =
    typeof component.thumbnail === 'string' && component.thumbnail.trim().startsWith('<svg');
  const tagIsRegistered =
    typeof customElements !== 'undefined' && customElements.get(component.tagName) !== undefined;
  const usePresetSvg =
    hasSvgThumbnail && (PASSIVE_TAGS.has(component.tagName) || !tagIsRegistered);
  const boardArt = PI_BOARD_ART[component.tagName];

  // Render actual web component as thumbnail
  React.useEffect(() => {
    if (!thumbnailRef.current) return;
    if (usePresetSvg) return; // SVG is rendered via dangerouslySetInnerHTML below
    if (boardArt) return; // static illustration rendered below

    // Create the actual wokwi element
    const element = document.createElement(component.tagName);

    // Scale factors for different component types
    let scale = 0.5;
    if (component.tagName.includes('arduino') || component.tagName.includes('esp32')) {
      scale = 0.35; // Boards are larger, scale them down more
    } else if (component.tagName.includes('lcd') || component.tagName.includes('display')) {
      scale = 0.4; // Displays need a bit more space
    }

    (element as HTMLElement).style.transform = `scale(${scale})`;
    (element as HTMLElement).style.transformOrigin = 'center center';

    // Pass the preset's defaults through so variant-sensitive elements render
    // the right look in the picker — e.g. wokwi-resistor color bands (value)
    // or the M5Stack Chain matrix light/dark housing (mono). Same property
    // assignment DynamicComponent performs when the part is placed, so any
    // element that tolerates placement tolerates the preview.
    for (const [key, val] of Object.entries(component.defaultValues ?? {})) {
      try {
        (element as any)[key] = val;
      } catch {
        /* read-only prop on some upstream element — skip */
      }
    }

    // Set default properties for better preview appearance
    if (component.tagName === 'wokwi-led') {
      (element as any).value = true; // Turn on LED
      (element as any).color = component.defaultValues?.color || 'red';
    } else if (component.tagName === 'wokwi-rgb-led') {
      (element as any).red = true;
      (element as any).green = true;
      (element as any).blue = true;
    } else if (component.tagName === 'wokwi-pushbutton') {
      (element as any).color = component.defaultValues?.color || 'red';
    } else if (component.tagName === 'wokwi-lcd1602' || component.tagName === 'wokwi-lcd2004') {
      (element as any).text = 'Hello World!';
    }

    thumbnailRef.current.innerHTML = '';
    thumbnailRef.current.appendChild(element);

    return () => {
      if (thumbnailRef.current) {
        thumbnailRef.current.innerHTML = '';
      }
    };
  }, [component.tagName, component.defaultValues, usePresetSvg, boardArt]);

  return (
    <button className="component-card" onClick={onSelect} style={{ position: 'relative' }} {...hover}>
      {component.custom ? <CustomBadge /> : isProBoardKind(component.id) && <ProBadge />}
      <div className="card-thumbnail">
        {boardArt ? (
          <img
            src={boardArt}
            alt={component.name}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
        ) : usePresetSvg ? (
          <div
            className="component-preview"
            dangerouslySetInnerHTML={{ __html: component.thumbnail }}
          />
        ) : (
          <div ref={thumbnailRef} className="component-preview" />
        )}
      </div>
      <div className="card-content">
        <div className="card-name">{component.name}</div>
        {component.description && <div className="card-description">{component.description}</div>}
        <div className="card-meta">
          <span className="card-category">{component.category}</span>
          {component.pinCount > 0 && <span className="card-pins">{component.pinCount} pins</span>}
        </div>
      </div>
    </button>
  );
};

// Tag name used to render a thumbnail for each board kind.
// Boards without a tag will show a generic chip icon.
const BOARD_TAG: Partial<Record<BoardKind, string>> = {
  'arduino-uno': 'wokwi-arduino-uno',
  'arduino-nano': 'wokwi-arduino-nano',
  'arduino-mega': 'wokwi-arduino-mega',
  'raspberry-pi-pico': 'wokwi-nano-rp2040-connect',
  'pi-pico-w': 'velxio-pi-pico-w',
  esp32: 'velxio-esp32',
  'esp32-devkit-c-v4': 'velxio-esp32',
  'esp32-cam': 'velxio-esp32',
  'wemos-lolin32-lite': 'velxio-esp32',
  'esp32-s3': 'velxio-esp32',
  'xiao-esp32-s3': 'velxio-esp32',
  'arduino-nano-esp32': 'velxio-esp32',
  'esp32-c3': 'velxio-esp32',
  'xiao-esp32-c3': 'velxio-esp32',
  'aitewinrobot-esp32c3-supermini': 'velxio-esp32',
  'stm32-bluepill': 'velxio-stm32-bluepill',
  'stm32-blackpill': 'velxio-stm32-blackpill',
  'stm32-bluepill-f103cb': 'velxio-stm32-bluepill-f103cb',
  'stm32-blackpill-f401': 'velxio-stm32-blackpill-f401',
  'stm32-f4-discovery': 'velxio-stm32-f4-discovery',
  'stm32-olimex-h405': 'velxio-stm32-olimex-h405',
  'stm32-netduino-plus2': 'velxio-stm32-netduino-plus2',
  'stm32-netduino2': 'velxio-stm32-netduino2',
};

interface BoardCardProps {
  kind: BoardKind;
  onSelect: () => void;
  hoverApi: CardHoverApi;
}

const BoardCard: React.FC<BoardCardProps> = ({ kind, onSelect, hoverApi }) => {
  const thumbnailRef = React.useRef<HTMLDivElement>(null);
  const hover = useCardHover(
    () => ({
      id: kind,
      name: BOARD_KIND_LABELS[kind],
      category: 'Boards',
      description: BOARD_DESCRIPTIONS[kind] ?? getProBoard(kind)?.description ?? '',
      pinCount: 0,
      properties: [],
      tags: [],
      pro_only: isProBoardKind(kind),
    }),
    hoverApi,
  );

  React.useEffect(() => {
    if (!thumbnailRef.current) return;
    // Static-image boards handled below via reactThumbnail: the whole Pi
    // Linux family uses board illustrations (a live custom element at
    // natural size + CSS scale keeps its unscaled layout box, so the
    // 100px thumbnail clips it to a narrow sliver).
    if (
      kind === 'raspberry-pi-zero' ||
      kind === 'raspberry-pi-1' ||
      kind === 'raspberry-pi-2' ||
      kind === 'raspberry-pi-3' ||
      kind === 'raspberry-pi-4' ||
      kind === 'raspberry-pi-5' ||
      kind === 'attiny85'
    )
      return;

    const tag = BOARD_TAG[kind] ?? getProBoard(kind)?.tag;
    if (!tag) return;

    const el = document.createElement(tag) as HTMLElement;
    // Use setAttribute so observedAttributes + connectedCallback read the correct value
    el.setAttribute('board-kind', kind);
    el.style.transform = 'scale(0.28)';
    el.style.transformOrigin = 'center center';

    thumbnailRef.current.innerHTML = '';
    thumbnailRef.current.appendChild(el);

    return () => {
      if (thumbnailRef.current) thumbnailRef.current.innerHTML = '';
    };
  }, [kind]);

  // Every Pi shows its own board. The cards used to share the Pi 3's picture,
  // which made the picker claim a Zero looks like a Pi 3.
  const piArt: Partial<Record<string, string>> = {
    'raspberry-pi-zero': raspberryPiZeroSvg,
    'raspberry-pi-1': raspberryPi1Svg,
    'raspberry-pi-2': raspberryPi2Svg,
    'raspberry-pi-3': raspberryPi3Svg,
  };

  const reactThumbnail = piArt[kind] ? (
      <img
        src={piArt[kind]}
        alt={BOARD_KIND_LABELS[kind]}
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
      />
    ) : kind === 'raspberry-pi-4' ? (
      <img
        src={raspberryPi4Png}
        alt="Raspberry Pi 4"
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
      />
    ) : kind === 'raspberry-pi-5' ? (
      <img
        src={raspberryPi5Png}
        alt="Raspberry Pi 5"
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
      />
    ) : kind === 'attiny85' ? (
      <div style={{ transform: 'scale(0.55)', transformOrigin: 'center center' }}>
        <Attiny85 />
      </div>
    ) : null;

  return (
    <button
      className="component-card"
      onClick={onSelect}
      style={{ position: 'relative' }}
      {...hover}
    >
      {isProBoardKind(kind) && <ProBadge />}
      <div className="card-thumbnail">
        {reactThumbnail ? reactThumbnail : <div ref={thumbnailRef} className="component-preview" />}
      </div>
      <div className="card-content">
        <div className="card-name">{BOARD_KIND_LABELS[kind]}</div>
        <div className="card-description">{BOARD_DESCRIPTIONS[kind] ?? getProBoard(kind)?.description}</div>
      </div>
    </button>
  );
};

// ── Online-only board ads ───────────────────────────────────────────────────
// Boards implemented by the hosted editor (velxio.com), free to use there.
// Hidden automatically in any build that registers the real BoardKind.
/** Recomputed on access (not module load): overlay board registration patches
 *  BOARD_KIND_LABELS at mount, which must hide the corresponding ad. */
const visibleBoardAds = () =>
  ONLINE_ONLY_BOARD_ADS.filter(
    (ad) => !(ad.id in BOARD_KIND_LABELS) && !isOnlineOnlyAdSuppressed(ad.id),
  );

/** Teal "ONLINE" pill: the board runs (free) in the hosted editor. */
const OnlineBadge: React.FC = () => (
  <span
    title="Free in the online editor — velxio.com"
    style={{
      position: 'absolute',
      top: 8,
      right: 8,
      zIndex: 1,
      padding: '3px 10px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 0.6,
      color: '#04241a',
      background: 'linear-gradient(180deg,#4ade80,#14b8a6)',
      boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
    }}
  >
    ONLINE
  </span>
);

/** Advertisement card for a component only available in the hosted editor. */
const OnlineOnlyComponentCard: React.FC<{ ad: OnlineOnlyComponentAd }> = ({ ad }) => (
  <button
    className="component-card"
    style={{ position: 'relative' }}
    title={`${ad.label} — available in the online editor at velxio.com`}
    onClick={() => window.open(ONLINE_EDITOR_URL, '_blank', 'noopener')}
  >
    <OnlineBadge />
    <div className="card-thumbnail">
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        dangerouslySetInnerHTML={{ __html: ad.thumbnailSvg }}
      />
    </div>
    <div className="card-content">
      <div className="card-name">{ad.label}</div>
      <div className="card-description">{ad.description}</div>
    </div>
  </button>
);

/** Advertisement card for a board only available in the hosted editor. */
const OnlineOnlyBoardCard: React.FC<{ ad: OnlineOnlyBoardAd }> = ({ ad }) => (
  <button
    className="component-card"
    style={{ position: 'relative' }}
    title={`${ad.label} — free to use in the online editor at velxio.com`}
    onClick={() => window.open(ONLINE_EDITOR_URL, '_blank', 'noopener')}
  >
    <OnlineBadge />
    <div className="card-thumbnail">
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        dangerouslySetInnerHTML={{ __html: ad.thumbnailSvg }}
      />
    </div>
    <div className="card-content">
      <div className="card-name">{ad.label}</div>
      <div className="card-description">{ad.description}</div>
    </div>
  </button>
);

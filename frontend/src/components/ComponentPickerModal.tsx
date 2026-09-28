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
  SUBCATEGORIES,
  categoryKey,
  categoryRank,
  normalizeCategory,
  subcategoryDefsInDisplayOrder,
  subcategoryKey,
  subcategoryLabel,
  subcategoryOf,
  subcategoryRank,
} from '../data/componentTaxonomy';
import { ComponentTree, type TreeNode } from './ComponentTree';
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
  'cyd-esp32-2424s012': 'CYD 1.28" round GC9A01 display, ESP32-C3 (QEMU)',
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
const UNSIMULATED_BOARD_SHELLS = new Set(['nano-rp2040-connect', 'esp32-devkit-v1']);

/**
 * Parts created only by canvas gestures, never placed from the picker. The
 * junction node is minted by dropping a wire-end onto a wire (or the node
 * tool); a bare junction on empty canvas connects nothing, so offering it
 * here would only confuse. Metadata registration stays mandatory — the
 * canvas renders null for unknown metadataIds — hiding happens HERE only.
 */
const GESTURE_ONLY_COMPONENTS = new Set(['junction']);

// ── Recently used ───────────────────────────────────────────────────────────
// In an editor the same handful of parts get placed over and over, so the
// shortest path to a part is usually "the one I used last time", not any
// taxonomy. Stored per browser; a private window or blocked site data simply
// yields an empty list, which is why every access is guarded.
const RECENTS_KEY = 'velxio-picker-recents';
const RECENTS_MAX = 12;

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.filter((x): x is string => typeof x === 'string').slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

function pushRecent(id: string): string[] {
  const next = [id, ...loadRecents().filter((x) => x !== id)].slice(0, RECENTS_MAX);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable - the list just doesn't persist */
  }
  return next;
}

// ── Deferred thumbnails ─────────────────────────────────────────────────────
/**
 * True once the card has come within `IN_VIEW_MARGIN` of the viewport, and
 * true forever after.
 *
 * Every card preview is a REAL custom element built with
 * `document.createElement(tagName)` — upgrading 400+ of them on open cost
 * most of a second before the modal painted. Building each one only when its
 * card approaches the viewport moves that work off the open path; keeping it
 * once built means scrolling back up never rebuilds (and never re-flashes) a
 * preview.
 */
const IN_VIEW_MARGIN = '600px';

function useNearViewport(ref: React.RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el) return;
    // No IntersectionObserver (jsdom in the unit tests, very old browsers):
    // fall back to building every preview eagerly, i.e. the old behaviour.
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: IN_VIEW_MARGIN },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, near]);
  return near;
}

/** Selection keys for the rail entries that are not a category. */
const KEY_ALL = 'all';
const KEY_BOARDS = 'boards';
const KEY_RECENT = 'recent';

/** Does a part belong to the branch the rail currently has selected? */
function inSelection(component: ComponentMetadata, selectedKey: string): boolean {
  if (!selectedKey.startsWith('cat:')) return true;
  const [cat, sub] = selectedKey.slice(4).split('/');
  if (normalizeCategory(component.category) !== cat) return false;
  return !sub || subcategoryOf(component) === sub;
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
  'cyd-esp32-2424s012',
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
  // Which branch of the left rail is active. 'all' / 'boards' / 'recent', or
  // 'cat:<category>' / 'cat:<category>/<subgroup>'.
  const [selectedKey, setSelectedKey] = useState<string>(KEY_ALL);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set<string>());
  const [recentIds, setRecentIds] = useState<string[]>(loadRecents);
  const scrollRef = useRef<HTMLDivElement>(null);
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

  // Every part the current SEARCH admits, before the rail narrows it. The
  // tree counts are computed from this, so they track the query: type "temp"
  // and each branch reports how many of its parts survive.
  const baseComponents = useMemo(() => {
    if (isLoading) return [];

    let components = searchQuery ? registry.search(searchQuery) : registry.getAllComponents();

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
  }, [searchQuery, registry, isLoading, registryVersion, proBoardsVersion]);

  /** The parts actually on screen: the search set narrowed by the rail. */
  const filteredComponents = useMemo(
    () => baseComponents.filter((c) => inSelection(c, selectedKey)),
    [baseComponents, selectedKey],
  );


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
    // An ad has no metadata object, so it is matched on its own category
    // against whichever branch the rail has selected.
    const selectedCat = selectedKey.startsWith('cat:')
      ? selectedKey.slice(4).split('/')[0]
      : null;
    return ONLINE_ONLY_COMPONENT_ADS.filter(
      (ad) =>
        !registry.getById(ad.id) &&
        !isOnlineOnlyAdSuppressed(ad.id) &&
        (selectedKey === KEY_ALL || (!!selectedCat && normalizeCategory(ad.category) === selectedCat)) &&
        matchesSearch(searchQuery, [ad.label]),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, isLoading, searchQuery, selectedKey, registryVersion, proBoardsVersion]);

  /** Parts placed recently, in recency order, honouring the active search. */
  const recentComponents = useMemo(() => {
    if (isLoading) return [];
    const admitted = new Set(baseComponents.map((c) => c.id));
    const out: ComponentMetadata[] = [];
    for (const id of recentIds) {
      const hit = registry.getById(id);
      if (hit && admitted.has(hit.id)) out.push(hit);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentIds, baseComponents, registry, isLoading, registryVersion]);

  /** Boards the current search admits (the rail's Boards branch). */
  const matchingBoards = useMemo(
    () =>
      allBoards.filter((k) =>
        matchesSearch(searchQuery, [BOARD_KIND_LABELS[k], k, boardSearchKeywords(k)]),
      ),
    [allBoards, searchQuery],
  );

  const matchingBoardAds = useMemo(
    () => visibleBoardAds().filter((ad) => matchesSearch(searchQuery, [ad.label])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchQuery, proBoardsVersion],
  );

  /**
   * The rail's nodes, counted from the search set.
   *
   * Counts come from `baseComponents` rather than from the registry totals so
   * they answer the question the user is actually asking while typing: how
   * many matches are in this branch. Zero-count branches are dropped by the
   * tree itself, which is what keeps the rail short during a search.
   *
   * Built from the components PRESENT, never from a fixed list of categories:
   * the old dropdown was memoised on load alone, so every category that only
   * a runtime overlay introduced (Communication, and 20-odd Grove parts with
   * it) never appeared and could not be filtered to at all.
   */
  const treeNodes = useMemo<TreeNode[]>(() => {
    if (isLoading) return [];

    const counts = new Map<string, Map<string, number>>();
    for (const c of baseComponents) {
      const cat = normalizeCategory(c.category);
      const sub = subcategoryOf(c);
      let subCounts = counts.get(cat);
      if (!subCounts) {
        subCounts = new Map();
        counts.set(cat, subCounts);
      }
      subCounts.set(sub, (subCounts.get(sub) ?? 0) + 1);
    }

    const categoryNodes: TreeNode[] = [];
    // Categories the taxonomy does not rank go after the ones it does, in
    // whatever order the registry reports them, rather than disappearing.
    const seen = [...counts.keys()].sort((a, b) => categoryRank(a) - categoryRank(b));
    for (const cat of seen) {
      const subCounts = counts.get(cat)!;
      let total = 0;
      for (const n of subCounts.values()) total += n;
      const defs = SUBCATEGORIES[cat as ComponentCategory]
        ? subcategoryDefsInDisplayOrder(cat as ComponentCategory)
        : null;
      const children = defs
        ? defs
            .filter((d) => (subCounts.get(d.id) ?? 0) > 0)
            .map((d) => ({
              key: subcategoryKey(cat as ComponentCategory, d.id),
              label: d.label,
              count: subCounts.get(d.id)!,
            }))
        : [];
      categoryNodes.push({
        key: categoryKey(cat as ComponentCategory),
        label: ComponentRegistry.getCategoryDisplayName(cat as ComponentCategory),
        count: total,
        // A lone subgroup is not a subdivision - don't give it a twisty that
        // opens onto a copy of its parent.
        children: children.length > 1 ? children : undefined,
      });
    }

    const head: TreeNode[] = [
      { key: KEY_ALL, label: t('editor.componentPicker.allComponents'), count: baseComponents.length },
    ];
    if (recentComponents.length > 0) {
      head.push({
        key: KEY_RECENT,
        label: t('editor.componentPicker.recentlyUsed', 'Recently used'),
        count: recentComponents.length,
      });
    }
    if (onSelectBoard) {
      head.push({
        key: KEY_BOARDS,
        label: t('editor.componentPicker.boards'),
        count: matchingBoards.length + matchingBoardAds.length,
      });
    }
    return [...head, ...categoryNodes];
  }, [
    baseComponents,
    isLoading,
    recentComponents,
    matchingBoards,
    matchingBoardAds,
    onSelectBoard,
    t,
  ]);

  // A branch can vanish under the user: narrowing the search until the
  // selected subgroup has no matches would otherwise leave the grid empty
  // with no hint as to why. Fall back to the whole catalogue instead.
  useEffect(() => {
    if (selectedKey === KEY_ALL || isLoading) return;
    const alive = (nodes: TreeNode[]): boolean =>
      nodes.some((n) => (n.key === selectedKey && n.count > 0) || alive(n.children ?? []));
    if (!alive(treeNodes)) setSelectedKey(KEY_ALL);
  }, [treeNodes, selectedKey, isLoading]);

  /** Auto-open the branch that holds the selection. */
  useEffect(() => {
    if (!selectedKey.startsWith('cat:')) return;
    const [cat, sub] = selectedKey.slice(4).split('/');
    if (!sub) return;
    setExpandedKeys((prev) => {
      const parent = categoryKey(cat as ComponentCategory);
      if (prev.has(parent)) return prev;
      const next = new Set(prev);
      next.add(parent);
      return next;
    });
  }, [selectedKey]);

  /**
   * One block of the results area: a header plus its grid. Chunking the grid
   * is what turns 60-odd rows of undifferentiated cards into something you
   * can skim - the old grid was already sorted by category but printed no
   * headers, so the grouping was invisible.
   */
  type GridSection =
    | { kind: 'boards'; key: string; label: string; boards: BoardKind[]; ads: OnlineOnlyBoardAd[] }
    | { kind: 'parts'; key: string; label: string; items: ComponentMetadata[] };

  const sections = useMemo<GridSection[]>(() => {
    if (isLoading) return [];
    const out: GridSection[] = [];

    const wantsBoards = !!onSelectBoard && (selectedKey === KEY_ALL || selectedKey === KEY_BOARDS);
    if (wantsBoards && (matchingBoards.length > 0 || matchingBoardAds.length > 0)) {
      out.push({
        kind: 'boards',
        key: KEY_BOARDS,
        label: t('editor.componentPicker.boards'),
        boards: matchingBoards,
        ads: matchingBoardAds,
      });
    }
    if (selectedKey === KEY_BOARDS) return out;

    if ((selectedKey === KEY_ALL || selectedKey === KEY_RECENT) && recentComponents.length > 0) {
      out.push({
        kind: 'parts',
        key: KEY_RECENT,
        label: t('editor.componentPicker.recentlyUsed', 'Recently used'),
        items: recentComponents,
      });
    }
    if (selectedKey === KEY_RECENT) return out;

    // While a query is typed the registry already returns best-match first.
    // Regrouping that by category would bury "LED" under every sensor whose
    // description mentions one, so ranked order wins and the rail carries the
    // structure instead.
    if (searchQuery.trim()) {
      if (filteredComponents.length > 0) {
        out.push({
          kind: 'parts',
          key: 'results',
          label: t('editor.componentPicker.searchResults', 'Search results'),
          items: filteredComponents,
        });
      }
      return out;
    }

    const groups = new Map<string, ComponentMetadata[]>();
    for (const c of filteredComponents) {
      const key = subcategoryKey(normalizeCategory(c.category), subcategoryOf(c));
      const bucket = groups.get(key);
      if (bucket) bucket.push(c);
      else groups.set(key, [c]);
    }
    const ordered = [...groups.entries()].sort((a, b) => {
      const [catA, subA] = a[0].slice(4).split('/');
      const [catB, subB] = b[0].slice(4).split('/');
      const byCategory = categoryRank(catA) - categoryRank(catB);
      if (byCategory !== 0) return byCategory;
      return (
        subcategoryRank(catA as ComponentCategory, subA ?? '') -
        subcategoryRank(catB as ComponentCategory, subB ?? '')
      );
    });
    for (const [key, items] of ordered) {
      const [cat, sub] = key.slice(4).split('/');
      const categoryLabel = ComponentRegistry.getCategoryDisplayName(cat as ComponentCategory);
      out.push({
        kind: 'parts',
        key,
        label: sub
          ? `${categoryLabel} / ${subcategoryLabel(cat as ComponentCategory, sub)}`
          : categoryLabel,
        items,
      });
    }
    return out;
  }, [
    isLoading,
    onSelectBoard,
    selectedKey,
    searchQuery,
    filteredComponents,
    recentComponents,
    matchingBoards,
    matchingBoardAds,
    t,
  ]);

  /** How many items the footer should report for the active branch. */
  const shownCount =
    selectedKey === KEY_BOARDS
      ? matchingBoards.length + matchingBoardAds.length
      : selectedKey === KEY_RECENT
        ? recentComponents.length
        : filteredComponents.length;

  /** Label of the selected branch, for the removable filter chip. */
  const activeBranchLabel = useMemo(() => {
    if (selectedKey === KEY_ALL) return null;
    const find = (nodes: TreeNode[]): TreeNode | null => {
      for (const n of nodes) {
        if (n.key === selectedKey) return n;
        const hit = find(n.children ?? []);
        if (hit) return hit;
      }
      return null;
    };
    return find(treeNodes)?.label ?? null;
  }, [treeNodes, selectedKey]);

  const selectBranch = (key: string) => {
    setSelectedKey(key);
    clearHover();
    scrollRef.current?.scrollTo({ top: 0 });
  };

  const toggleBranch = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /**
   * Place a part, and remember it. Pro overlays can intercept the click on a
   * pro_only component by setting window.__velxio_pro_gate__; returning true
   * means "handled - do not pass through", and nothing is recorded because
   * nothing was placed.
   */
  const handleSelectComponent = (component: ComponentMetadata) => {
    if (component.pro_only) {
      const gate = (
        window as unknown as {
          __velxio_pro_gate__?: (c: ComponentMetadata) => boolean;
        }
      ).__velxio_pro_gate__;
      if (gate && gate(component)) return;
    }
    setRecentIds(pushRecent(component.id));
    onSelectComponent(component);
  };

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

          <button className="close-btn" onClick={onClose} aria-label={t('editor.componentPicker.close')}>
            X
          </button>
        </div>

        <div className="picker-body">
          <ComponentTree
            nodes={treeNodes}
            selected={selectedKey}
            onSelect={selectBranch}
            expanded={expandedKeys}
            onToggle={toggleBranch}
            label={t('editor.componentPicker.categoriesTree', 'Component categories')}
          />

          <div className="picker-results">
            {(activeBranchLabel || searchQuery) && (
              <div className="picker-chips">
                {searchQuery && (
                  <button
                    type="button"
                    className="picker-chip"
                    onClick={() => {
                      setSearchQuery('');
                      clearHover();
                    }}
                  >
                    <span className="picker-chip-text">
                      {t('editor.componentPicker.searchChip', 'Search')}: {searchQuery}
                    </span>
                    <span className="picker-chip-x" aria-hidden="true">
                      X
                    </span>
                  </button>
                )}
                {activeBranchLabel && (
                  <button
                    type="button"
                    className="picker-chip"
                    onClick={() => selectBranch(KEY_ALL)}
                  >
                    <span className="picker-chip-text">{activeBranchLabel}</span>
                    <span className="picker-chip-x" aria-hidden="true">
                      X
                    </span>
                  </button>
                )}
              </div>
            )}

            <div className="components-scroll" ref={scrollRef} onScroll={clearHover}>
              {isLoading ? (
                <div className="loading-state">
                  <div className="spinner"></div>
                  <p>{t('editor.componentPicker.loading')}</p>
                </div>
              ) : sections.length === 0 && visibleComponentAds.length === 0 ? (
                <div className="no-results">
                  <p>{t('editor.componentPicker.noResults')}</p>
                  <button
                    className="clear-filters-btn"
                    onClick={() => {
                      setSearchQuery('');
                      selectBranch(KEY_ALL);
                    }}
                  >
                    {t('editor.componentPicker.clearFilters')}
                  </button>
                </div>
              ) : (
                <>
                  {sections.map((section) => (
                    <section key={section.key} className="picker-section">
                      <h3 className="picker-section-header">
                        <span className="picker-section-title">{section.label}</span>
                        <span className="picker-section-count">
                          {section.kind === 'boards'
                            ? section.boards.length + section.ads.length
                            : section.items.length}
                        </span>
                      </h3>
                      <div className="components-grid components-grid--inline">
                        {section.kind === 'boards' ? (
                          <>
                            {section.boards.map((kind) => (
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
                            {section.ads.map((ad) => (
                              <OnlineOnlyBoardCard key={ad.id} ad={ad} />
                            ))}
                          </>
                        ) : (
                          // Keyed by section as well as id: a part shown under
                          // "Recently used" also appears in its own category
                          // section, and two React children cannot share a key.
                          section.items.map((component) => (
                            <ComponentCard
                              key={`${section.key}:${component.id}`}
                              component={component}
                              hoverApi={hoverApi}
                              onSelect={() => handleSelectComponent(component)}
                            />
                          ))
                        )}
                      </div>
                    </section>
                  ))}

                  {visibleComponentAds.length > 0 && (
                    <div className="components-grid components-grid--inline">
                      {visibleComponentAds.map((ad) => (
                        <OnlineOnlyComponentCard key={ad.id} ad={ad} />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Footer Info */}
        <div className="modal-footer">
          <span className="component-count">
            {shownCount} {shownCount === 1 ? 'item' : 'items'}
          </span>
        </div>
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
  const cardRef = React.useRef<HTMLButtonElement>(null);
  const nearViewport = useNearViewport(cardRef);
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
    if (!nearViewport) return; // off-screen: don't pay for a custom element yet

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
  }, [component.tagName, component.defaultValues, usePresetSvg, boardArt, nearViewport]);

  return (
    <button
      className="component-card"
      ref={cardRef}
      onClick={onSelect}
      style={{ position: 'relative' }}
      {...hover}
    >
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
  'cyd-esp32-2424s012': 'velxio-esp32',
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
  const cardRef = React.useRef<HTMLButtonElement>(null);
  const nearViewport = useNearViewport(cardRef);
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
    if (!nearViewport) return; // off-screen: don't pay for a custom element yet
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
    for (const [name, value] of Object.entries(getProBoard(kind)?.thumbnailAttrs ?? {})) {
      el.setAttribute(name, value);
    }
    el.style.transform = 'scale(0.28)';
    el.style.transformOrigin = 'center center';

    thumbnailRef.current.innerHTML = '';
    thumbnailRef.current.appendChild(el);

    return () => {
      if (thumbnailRef.current) thumbnailRef.current.innerHTML = '';
    };
  }, [kind, nearViewport]);

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
      ref={cardRef}
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

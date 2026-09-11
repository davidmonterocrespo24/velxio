/**
 * Examples Gallery Component
 *
 * Displays a gallery of example Arduino projects that users can load and run
 */

import React, { useState, useCallback, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  exampleProjects,
  subscribeProExamples,
  getProExamplesVersion,
  type ExampleProject,
} from '../../data/examples';
import { subscribeProBoards, getProBoardsVersion } from '../../lib/proBoardRegistry';
import { BOARD_KIND_LABELS } from '../../types/board';
import { parseSearchQuery, scoreSearch } from '../../utils/searchMatch';
import { exampleSearchFields } from '../../utils/exampleSearch';
import { ExampleThumbnail } from './ExampleThumbnail';
import './ExamplesGallery.css';

interface ExamplesGalleryProps {
  onLoadExample: (example: ExampleProject) => void;
}

// ── Board config ───────────────────────────────────────────────────────────

interface BoardTab {
  id: string;
  label: string;
  color: string;
  bg: string;
}

const BOARD_TABS: BoardTab[] = [
  { id: 'all', label: 'All', color: '#ffffff', bg: '#444444' },
  { id: 'retro', label: 'Retro', color: '#1a1a1a', bg: '#e0a82e' },
  { id: 'arduino-uno', label: 'Arduino Uno', color: '#ffffff', bg: '#007acc' },
  { id: 'arduino-nano', label: 'Arduino Nano', color: '#ffffff', bg: '#0055aa' },
  { id: 'arduino-mega', label: 'Arduino Mega', color: '#ffffff', bg: '#003388' },
  { id: 'raspberry-pi-pico', label: 'Pico', color: '#ffffff', bg: '#c11c31' },
  { id: 'pi-pico-w', label: 'Pico W (Wi-Fi)', color: '#ffffff', bg: '#8c0e1e' },
  { id: 'esp32', label: 'ESP32 (Xtensa)', color: '#ffffff', bg: '#e77d11' },
  { id: 'esp32-cam', label: 'ESP32-CAM', color: '#ffffff', bg: '#d35400' },
  { id: 'esp32-s3', label: 'ESP32-S3 (Xtensa)', color: '#ffffff', bg: '#b3540e' },
  { id: 'esp32-c3', label: 'ESP32-C3 (RISC-V)', color: '#ffffff', bg: '#27ae60' },
  { id: 'stm32-bluepill', label: 'STM32 Blue Pill', color: '#ffffff', bg: '#0a7ea4' },
  { id: 'stm32-blackpill', label: 'STM32 Black Pill', color: '#ffffff', bg: '#2d3436' },
  { id: 'attiny85', label: 'ATtiny85', color: '#ffffff', bg: '#5d4037' },
  { id: 'multi', label: 'Multi-Board', color: '#ffffff', bg: '#7b2d8b' },
  { id: 'analog', label: 'Analog', color: '#ffffff', bg: '#0ea5a5' },
  { id: 'digital', label: 'Digital', color: '#ffffff', bg: '#6366f1' },
];

/** The "Retro" tab is tag-based (not board-kind based) so it can collect the
 *  Z80 / Intel / vintage-CPU examples regardless of their board filter. They
 *  also still appear under their board tab (Digital), so this is additive. */
function isRetro(example: ExampleProject): boolean {
  return (example.tags ?? []).includes('retro');
}

function getBoardFilter(example: ExampleProject): string {
  // An explicit boardFilter is the author's intent and wins — even for
  // examples authored with the multi-board `boards[]` format (e.g. the STM32
  // single-board examples). Genuinely multi-board examples with no boardFilter
  // still fall through to 'multi'.
  if ((example as any).boardFilter) return (example as any).boardFilter;
  if (example.boards) return 'multi';
  return example.boardType ?? 'arduino-uno';
}

export const ExamplesGallery: React.FC<ExamplesGalleryProps> = ({ onLoadExample }) => {
  const { t } = useTranslation();
  const [selectedBoard, setSelectedBoard] = useState<string>('all');
  const [selectedCategory, setSelectedCategory] = useState<ExampleProject['category'] | 'all'>(
    'all',
  );
  const [selectedDifficulty, setSelectedDifficulty] = useState<
    ExampleProject['difficulty'] | 'all'
  >('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [search, setSearch] = useState<string>('');

  // Overlay boards and their examples register asynchronously — re-derive the
  // filter options when either lands, so a pro board's tab appears without a
  // reload.
  useSyncExternalStore(subscribeProExamples, getProExamplesVersion, getProExamplesVersion);
  useSyncExternalStore(subscribeProBoards, getProBoardsVersion, getProBoardsVersion);

  // The static tabs cover the OSS boards; every other board kind that appears
  // in the (possibly overlay-extended) gallery gets a tab of its own, labelled
  // from the board registry. Without this, examples for runtime-registered
  // boards (XIAO, M5Stack, Raspberry Pi, ...) were reachable only via "All".
  const boardTabs: BoardTab[] = (() => {
    const known = new Set(BOARD_TABS.map((tab) => tab.id));
    const extra: BoardTab[] = [];
    for (const ex of exampleProjects) {
      const bf = getBoardFilter(ex);
      if (known.has(bf)) continue;
      known.add(bf);
      extra.push({
        id: bf,
        label: (BOARD_KIND_LABELS as Record<string, string>)[bf] ?? bf,
        color: '#ffffff',
        bg: '#4a5568',
      });
    }
    extra.sort((a, b) => a.label.localeCompare(b.label));
    return [...BOARD_TABS, ...extra];
  })();

  const handleCopyLink = useCallback((e: React.MouseEvent, exampleId: string) => {
    e.stopPropagation(); // Don't trigger card click
    const url = `${window.location.origin}/examples/${exampleId}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(exampleId);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }, []);

  // Parsed once per keystroke. Every word must land somewhere in the
  // example (title, tags, parts, board, category, description); words can
  // be partial ("ultra"), misspelled ("potenciometer"), in the user's own
  // language ("temperatura") or spaced differently ("hc sr04"), and the
  // matches come back best-first. See utils/searchMatch.
  const searchQuery = parseSearchQuery(search);

  const browseOrder = exampleProjects
    .filter((example) => {
      const boardMatch =
        selectedBoard === 'all' ||
        (selectedBoard === 'retro' ? isRetro(example) : getBoardFilter(example) === selectedBoard);
      const catMatch = selectedCategory === 'all' || example.category === selectedCategory;
      const diffMatch = selectedDifficulty === 'all' || example.difficulty === selectedDifficulty;
      return boardMatch && catMatch && diffMatch;
    })
    .sort((a, b) => {
      // Order by board following the boardTabs order (so Arduino Uno comes
      // first), then alphabetically by title within each board.
      const ra = boardTabs.findIndex((t) => t.id === getBoardFilter(a));
      const rb = boardTabs.findIndex((t) => t.id === getBoardFilter(b));
      if (ra !== rb) return (ra < 0 ? 999 : ra) - (rb < 0 ? 999 : rb);
      return (a.title ?? '').localeCompare(b.title ?? '');
    });

  const filteredExamples = searchQuery
    ? browseOrder
        .map((example) => ({
          example,
          score: scoreSearch(searchQuery, exampleSearchFields(example, getBoardFilter(example))),
        }))
        .filter((s) => s.score > 0)
        // Stable sort: equal scores keep the board/title order from above.
        .sort((a, b) => b.score - a.score)
        .map((s) => s.example)
    : browseOrder;

  // Count per board for tab badges
  const boardCounts: Record<string, number> = {
    all: exampleProjects.length,
    retro: exampleProjects.filter(isRetro).length,
  };
  exampleProjects.forEach((ex) => {
    const b = getBoardFilter(ex);
    boardCounts[b] = (boardCounts[b] ?? 0) + 1;
  });

  const getCategoryIcon = (category: ExampleProject['category']): React.ReactNode => {
    const svgProps = {
      width: 16,
      height: 16,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round' as const,
      strokeLinejoin: 'round' as const,
      style: { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 },
    };
    const icons: Record<ExampleProject['category'], React.ReactNode> = {
      basics: (
        <svg {...svgProps}>
          <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
          <path d="M9 18h6" />
          <path d="M10 22h4" />
        </svg>
      ),
      sensors: (
        <svg {...svgProps}>
          <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
          <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" />
          <circle cx="12" cy="12" r="2" />
          <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" />
          <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19" />
        </svg>
      ),
      displays: (
        <svg {...svgProps}>
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      ),
      communication: (
        <svg {...svgProps}>
          <path d="M5 12.55a11 11 0 0 1 14.08 0" />
          <path d="M1.42 9a16 16 0 0 1 21.16 0" />
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
          <circle cx="12" cy="20" r="1" fill="currentColor" />
        </svg>
      ),
      games: (
        <svg {...svgProps}>
          <line x1="6" y1="11" x2="10" y2="11" />
          <line x1="8" y1="9" x2="8" y2="13" />
          <circle cx="15" cy="12" r="1" fill="currentColor" />
          <circle cx="17" cy="10" r="1" fill="currentColor" />
          <path d="M17 2H7a5 5 0 0 0-5 5v4.4A2.9 2.9 0 0 0 4.8 14l1.5 2.7A3 3 0 0 0 9 18h6a3 3 0 0 0 2.7-1.3l1.5-2.7a2.9 2.9 0 0 0 .3-1.3V7a5 5 0 0 0-5-5Z" />
        </svg>
      ),
      robotics: (
        <svg {...svgProps}>
          <path d="M12 8V4H8" />
          <rect width="16" height="12" x="4" y="8" rx="2" />
          <path d="M2 14h2" />
          <path d="M20 14h2" />
          <path d="M15 13v2" />
          <path d="M9 13v2" />
        </svg>
      ),
      circuits: (
        <svg {...svgProps}>
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
      ),
    };
    return icons[category];
  };

  const getDifficultyColor = (difficulty: ExampleProject['difficulty']): string =>
    ({
      beginner: '#4ade80',
      intermediate: '#fbbf24',
      advanced: 'var(--color-feedback-error)',
    })[difficulty];

  const getBoardBadge = (
    example: ExampleProject,
  ): { label: string; color: string; bg: string } | null => {
    const bf = getBoardFilter(example);
    const tab = boardTabs.find((t) => t.id === bf);
    if (!tab || tab.id === 'all') return null;
    return { label: tab.label, color: tab.color, bg: tab.bg };
  };

  const CATEGORIES = [
    'all',
    'basics',
    'sensors',
    'displays',
    'communication',
    'games',
    'robotics',
    'circuits',
  ] as const;
  const DIFFICULTIES = ['all', 'beginner', 'intermediate', 'advanced'] as const;

  // Active filters rendered as removable chips (the compact replacement for
  // the old three rows of always-visible filter buttons). Each chip clears
  // its own filter; "Clear all" resets everything.
  const boardTabForChip = boardTabs.find((tb) => tb.id === selectedBoard);
  const activeChips: { key: string; label: string; onClear: () => void }[] = [];
  if (selectedBoard !== 'all' && boardTabForChip) {
    activeChips.push({
      key: 'board',
      label: boardTabForChip.label,
      onClear: () => setSelectedBoard('all'),
    });
  }
  if (selectedCategory !== 'all') {
    activeChips.push({
      key: 'cat',
      label: t(`examples.filters.category.${selectedCategory}`),
      onClear: () => setSelectedCategory('all'),
    });
  }
  if (selectedDifficulty !== 'all') {
    activeChips.push({
      key: 'diff',
      label: t(`examples.filters.difficulty.${selectedDifficulty}`),
      onClear: () => setSelectedDifficulty('all'),
    });
  }
  if (search.trim()) {
    activeChips.push({
      key: 'search',
      label: `“${search.trim()}”`,
      onClear: () => setSearch(''),
    });
  }
  const resetAll = () => {
    setSearch('');
    setSelectedBoard('all');
    setSelectedCategory('all');
    setSelectedDifficulty('all');
  };

  return (
    <div className="examples-gallery">
      <div className="examples-header">
        <h1>{t('examples.heading')}</h1>
        <p>{t('examples.subtitle')}</p>
      </div>

      {/* Compact toolbar: search + three dropdowns + live count.
          Replaces the old search row + 16 board tabs + two filter rows. */}
      <div className="examples-toolbar">
        <div className="examples-search-wrap">
          <svg
            className="examples-search-icon"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            className="examples-search-input"
            placeholder={t('examples.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={t('examples.searchLabel')}
          />
          {search && (
            <button
              type="button"
              className="examples-search-clear"
              onClick={() => setSearch('')}
              aria-label={t('examples.clearSearch')}
              title={t('examples.clear')}
            >
              ×
            </button>
          )}
        </div>

        <select
          className="examples-select"
          value={selectedBoard}
          onChange={(e) => setSelectedBoard(e.target.value)}
          aria-label={t('examples.filters.boardLabel', 'Board')}
        >
          {boardTabs.map((tab) => (
            <option key={tab.id} value={tab.id}>
              {tab.id === 'all' ? t('examples.filters.allBoards', 'All boards') : tab.label}
              {boardCounts[tab.id] != null ? ` (${boardCounts[tab.id]})` : ''}
            </option>
          ))}
        </select>

        <select
          className="examples-select"
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value as typeof selectedCategory)}
          aria-label={t('examples.filters.categoryLabel')}
        >
          {CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>
              {t(`examples.filters.category.${cat}`)}
            </option>
          ))}
        </select>

        <select
          className="examples-select"
          value={selectedDifficulty}
          onChange={(e) => setSelectedDifficulty(e.target.value as typeof selectedDifficulty)}
          aria-label={t('examples.filters.difficultyLabel')}
        >
          {DIFFICULTIES.map((diff) => (
            <option key={diff} value={diff}>
              {t(`examples.filters.difficulty.${diff}`)}
            </option>
          ))}
        </select>

        <span className="examples-count">
          {t('examples.matchCount', { count: filteredExamples.length })}
        </span>
      </div>

      {/* Active-filter chips (removable badges). */}
      {activeChips.length > 0 && (
        <div className="examples-chips">
          {activeChips.map((chip) => (
            <span key={chip.key} className="filter-chip">
              {chip.label}
              <button
                type="button"
                className="filter-chip-x"
                onClick={chip.onClear}
                aria-label={t('examples.clear')}
                title={t('examples.clear')}
              >
                ×
              </button>
            </span>
          ))}
          {activeChips.length > 1 && (
            <button type="button" className="filter-chip-clear-all" onClick={resetAll}>
              {t('examples.resetFilters')}
            </button>
          )}
        </div>
      )}

      {/* Examples Grid */}
      <div className="examples-grid">
        {filteredExamples.map((example) => {
          const boardBadge = getBoardBadge(example);
          return (
            <div key={example.id} className="example-card" onClick={() => onLoadExample(example)}>
              <div className="example-thumbnail">
                <ExampleThumbnail
                  example={example}
                  width={300}
                  height={180}
                  background="var(--wb-0)"
                  style={{ width: '100%', height: '100%' }}
                />
              </div>
              <div className="example-info">
                <h3 className="example-title">{example.title}</h3>
                <p className="example-description">{example.description}</p>
                <div className="example-meta">
                  <span
                    className="example-difficulty"
                    style={{ backgroundColor: getDifficultyColor(example.difficulty) }}
                  >
                    {example.difficulty}
                  </span>
                  <span className="example-category">
                    {getCategoryIcon(example.category)} {example.category}
                  </span>
                  {boardBadge && (
                    <span
                      className="example-board-badge"
                      style={{
                        backgroundColor: boardBadge.bg + '33',
                        color: boardBadge.bg,
                        border: `1px solid ${boardBadge.bg}66`,
                        padding: '2px 6px',
                        borderRadius: '4px',
                        fontSize: '0.7rem',
                        fontWeight: 600,
                      }}
                    >
                      {boardBadge.label}
                    </span>
                  )}
                  <button
                    className="example-copy-link"
                    onClick={(e) => handleCopyLink(e, example.id)}
                    title={t('examples.copyLink')}
                  >
                    {copiedId === example.id ? (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#4ade80"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {filteredExamples.length === 0 && (
        <div className="examples-empty">
          <p>
            {searchQuery !== null
              ? t('examples.emptyForQuery', { query: search.trim() })
              : t('examples.empty')}
          </p>
          {(searchQuery !== null ||
            selectedBoard !== 'all' ||
            selectedCategory !== 'all' ||
            selectedDifficulty !== 'all') && (
            <button
              className="examples-empty-reset"
              onClick={() => {
                setSearch('');
                setSelectedBoard('all');
                setSelectedCategory('all');
                setSelectedDifficulty('all');
              }}
            >
              {t('examples.resetFilters')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Examples Gallery Component
 *
 * Displays a gallery of example Arduino projects that users can load and run
 */

import React, { useState, useCallback } from 'react';
import { exampleProjects, type ExampleProject } from '../../data/examples';
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
  { id: 'all',                label: 'All Boards',      color: '#ffffff', bg: '#444444' },
  { id: 'arduino-uno',        label: 'Arduino Uno',     color: '#ffffff', bg: '#007acc' },
  { id: 'arduino-nano',       label: 'Arduino Nano',    color: '#ffffff', bg: '#0055aa' },
  { id: 'arduino-mega',       label: 'Arduino Mega',    color: '#ffffff', bg: '#003388' },
  { id: 'raspberry-pi-pico',  label: 'Pico',            color: '#ffffff', bg: '#c11c31' },
  { id: 'esp32',              label: 'ESP32 (Xtensa)',  color: '#ffffff', bg: '#e77d11' },
  { id: 'esp32-c3',           label: 'ESP32-C3 (RISC-V)', color: '#ffffff', bg: '#27ae60' },
  { id: 'multi',              label: 'Multi-Board',     color: '#ffffff', bg: '#7b2d8b' },
];

function getBoardFilter(example: ExampleProject): string {
  if (example.boards) return 'multi';
  if ((example as any).boardFilter) return (example as any).boardFilter;
  return example.boardType ?? 'arduino-uno';
}

export const ExamplesGallery: React.FC<ExamplesGalleryProps> = ({ onLoadExample }) => {
  const [selectedBoard, setSelectedBoard] = useState<string>('all');
  const [selectedCategory, setSelectedCategory] = useState<ExampleProject['category'] | 'all'>('all');
  const [selectedDifficulty, setSelectedDifficulty] = useState<ExampleProject['difficulty'] | 'all'>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopyLink = useCallback((e: React.MouseEvent, exampleId: string) => {
    e.stopPropagation(); // Don't trigger card click
    const url = `${window.location.origin}/examples/${exampleId}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(exampleId);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }, []);

  const filteredExamples = exampleProjects.filter((example) => {
    const boardMatch  = selectedBoard === 'all' || getBoardFilter(example) === selectedBoard;
    const catMatch    = selectedCategory === 'all' || example.category === selectedCategory;
    const diffMatch   = selectedDifficulty === 'all' || example.difficulty === selectedDifficulty;
    return boardMatch && catMatch && diffMatch;
  });

  // Count per board for tab badges
  const boardCounts: Record<string, number> = { all: exampleProjects.length };
  exampleProjects.forEach((ex) => {
    const b = getBoardFilter(ex);
    boardCounts[b] = (boardCounts[b] ?? 0) + 1;
  });

  const getCategoryIcon = (category: ExampleProject['category']): React.ReactNode => {
    const svgProps = {
      width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 2,
      strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
      style: { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 },
    };
    const icons: Record<ExampleProject['category'], React.ReactNode> = {
      basics: (
        <svg {...svgProps}>
          <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
          <path d="M9 18h6" /><path d="M10 22h4" />
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
          <path d="M2 14h2" /><path d="M20 14h2" />
          <path d="M15 13v2" /><path d="M9 13v2" />
        </svg>
      ),
    };
    return icons[category];
  };

  const getDifficultyColor = (difficulty: ExampleProject['difficulty']): string => ({
    beginner: '#4ade80', intermediate: '#fbbf24', advanced: '#f87171',
  }[difficulty]);

  const getBoardBadge = (example: ExampleProject): { label: string; color: string; bg: string } | null => {
    const bf = getBoardFilter(example);
    const tab = BOARD_TABS.find((t) => t.id === bf);
    if (!tab || tab.id === 'all') return null;
    return { label: tab.label, color: tab.color, bg: tab.bg };
  };

  return (
    <div className="examples-gallery">
      <div className="examples-header">
        <h1>Featured Projects</h1>
        <p>Explore and run example projects — organized by board</p>
      </div>

      {/* Board tabs */}
      <div className="examples-board-tabs">
        {BOARD_TABS.map((tab) => (
          <button
            key={tab.id}
            className={`board-tab ${selectedBoard === tab.id ? 'active' : ''}`}
            style={selectedBoard === tab.id ? { backgroundColor: tab.bg, color: tab.color, borderColor: tab.bg } : {}}
            onClick={() => setSelectedBoard(tab.id)}
          >
            {tab.label}
            {boardCounts[tab.id] != null && (
              <span className="board-tab-count">{boardCounts[tab.id]}</span>
            )}
          </button>
        ))}
      </div>

      {/* Category + Difficulty filters */}
      <div className="examples-filters">
        <div className="filter-group">
          <label>Category:</label>
          <div className="filter-buttons">
            {(['all', 'basics', 'sensors', 'displays', 'communication', 'games', 'robotics'] as const).map((cat) => (
              <button
                key={cat}
                className={`filter-button ${selectedCategory === cat ? 'active' : ''}`}
                onClick={() => setSelectedCategory(cat)}
              >
                {cat !== 'all' && getCategoryIcon(cat as ExampleProject['category'])} {cat === 'all' ? 'All' : cat.charAt(0).toUpperCase() + cat.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-group">
          <label>Difficulty:</label>
          <div className="filter-buttons">
            {(['all', 'beginner', 'intermediate', 'advanced'] as const).map((diff) => (
              <button
                key={diff}
                className={`filter-button ${selectedDifficulty === diff ? 'active' : ''}`}
                onClick={() => setSelectedDifficulty(diff)}
              >
                {diff === 'all' ? 'All' : diff.charAt(0).toUpperCase() + diff.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Examples Grid */}
      <div className="examples-grid">
        {filteredExamples.map((example) => {
          const boardBadge = getBoardBadge(example);
          return (
            <div
              key={example.id}
              className="example-card"
              onClick={() => onLoadExample(example)}
            >
              <div className="example-thumbnail">
                {example.thumbnail ? (
                  <img src={example.thumbnail} alt={example.title} className="example-preview-image" />
                ) : (
                  <div className="example-placeholder-new">
                    <div className="placeholder-icon">{getCategoryIcon(example.category)}</div>
                    <div className="placeholder-text">
                      <div className="component-count">
                        {example.components.length} component{example.components.length !== 1 ? 's' : ''}
                      </div>
                      <div className="wire-count">
                        {example.wires.length} wire{example.wires.length !== 1 ? 's' : ''}
                      </div>
                    </div>
                  </div>
                )}
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
                    <span className="example-board-badge" style={{
                      backgroundColor: boardBadge.bg + '33',
                      color: boardBadge.bg,
                      border: `1px solid ${boardBadge.bg}66`,
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: '0.7rem',
                      fontWeight: 600,
                    }}>
                      {boardBadge.label}
                    </span>
                  )}
                  <button
                    className="example-copy-link"
                    onClick={(e) => handleCopyLink(e, example.id)}
                    title="Copy shareable link"
                  >
                    {copiedId === example.id ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
          <p>No examples found with the selected filters</p>
        </div>
      )}
    </div>
  );
};

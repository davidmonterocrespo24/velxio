import React, { useState } from 'react';
import type { BoardKind } from '../../types/board';
import { BOARD_KIND_LABELS } from '../../types/board';

export type BoardCompileState = 'pending' | 'compiling' | 'success' | 'error' | 'skipped';

export interface BoardCompileStatus {
  boardId: string;
  boardKind: BoardKind;
  state: BoardCompileState;
  error?: string;
}

interface CompileAllProgressProps {
  statuses: BoardCompileStatus[];
  isRunning: boolean;
  onRunAll: () => void;
  onClose: () => void;
}

const BOARD_ICON: Record<BoardKind, string> = {
  'arduino-uno': '⬤',
  'arduino-nano': '▪',
  'arduino-mega': '▬',
  'raspberry-pi-pico': '◆',
  'raspberry-pi-3': '⬛',
  esp32: '⬡',
  'esp32-s3': '⬡',
  'esp32-c3': '⬡',
};

const BOARD_COLOR: Record<BoardKind, string> = {
  'arduino-uno': '#4fc3f7',
  'arduino-nano': '#4fc3f7',
  'arduino-mega': '#4fc3f7',
  'raspberry-pi-pico': '#ce93d8',
  'raspberry-pi-3': '#ef9a9a',
  esp32: '#a5d6a7',
  'esp32-s3': '#a5d6a7',
  'esp32-c3': '#a5d6a7',
};

function StateIcon({ state }: { state: BoardCompileState }) {
  switch (state) {
    case 'pending':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
        </svg>
      );
    case 'compiling':
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#4fc3f7"
          strokeWidth="2"
          className="cap-spin"
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      );
    case 'success':
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#4caf50"
          strokeWidth="2.5"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      );
    case 'error':
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#ef5350"
          strokeWidth="2.5"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      );
    case 'skipped':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2">
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      );
  }
}

export const CompileAllProgress: React.FC<CompileAllProgressProps> = ({
  statuses,
  isRunning,
  onRunAll,
  onClose,
}) => {
  const [expandedError, setExpandedError] = useState<string | null>(null);

  const allDone =
    !isRunning && statuses.every((s) => s.state !== 'pending' && s.state !== 'compiling');
  const successCount = statuses.filter(
    (s) => s.state === 'success' || s.state === 'skipped',
  ).length;
  const errorCount = statuses.filter((s) => s.state === 'error').length;

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.title}>
            {isRunning
              ? 'Compiling all boards…'
              : allDone
                ? `Done — ${successCount} succeeded, ${errorCount} failed`
                : 'Compile All'}
          </span>
          <button style={styles.closeBtn} onClick={onClose} title="Close">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Board rows */}
        <div style={styles.list}>
          {statuses.map((s) => {
            const isExpanded = expandedError === s.boardId;
            return (
              <div key={s.boardId} style={styles.boardRow}>
                <div style={styles.boardRowMain}>
                  <StateIcon state={s.state} />
                  <span style={{ color: BOARD_COLOR[s.boardKind], fontSize: 10, marginLeft: 2 }}>
                    {BOARD_ICON[s.boardKind]}
                  </span>
                  <span style={styles.boardLabel}>{BOARD_KIND_LABELS[s.boardKind]}</span>
                  <span
                    style={{
                      ...styles.stateLabel,
                      color:
                        s.state === 'success'
                          ? '#4caf50'
                          : s.state === 'error'
                            ? '#ef5350'
                            : s.state === 'compiling'
                              ? '#4fc3f7'
                              : s.state === 'skipped'
                                ? '#888'
                                : '#555',
                    }}
                  >
                    {s.state === 'skipped' ? 'skipped (no compile needed)' : s.state}
                  </span>
                  {s.state === 'error' && s.error && (
                    <button
                      style={styles.expandBtn}
                      onClick={() => setExpandedError(isExpanded ? null : s.boardId)}
                      title="Show error"
                    >
                      {isExpanded ? '▲' : '▼'}
                    </button>
                  )}
                </div>
                {isExpanded && s.error && <pre style={styles.errorDetail}>{s.error}</pre>}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <button
            style={{
              ...styles.runAllBtn,
              ...(!allDone || successCount === 0 ? styles.runAllBtnDisabled : {}),
            }}
            disabled={!allDone || successCount === 0}
            onClick={onRunAll}
            title="Start all successfully compiled boards"
          >
            ▶ Run All
          </button>
        </div>
      </div>

      <style>{`@keyframes cap-spin { to { transform: rotate(360deg); } } .cap-spin { animation: cap-spin 0.8s linear infinite; }`}</style>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    right: 0,
    display: 'flex',
    justifyContent: 'center',
    zIndex: 1000,
    padding: '0 8px 4px',
  },
  panel: {
    background: '#252526',
    border: '1px solid #3c3c3c',
    borderRadius: 6,
    boxShadow: '0 -4px 20px rgba(0,0,0,0.5)',
    width: '100%',
    maxWidth: 480,
    fontFamily: 'Segoe UI, sans-serif',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    borderBottom: '1px solid #3c3c3c',
    background: '#2d2d2d',
  },
  title: {
    color: '#ccc',
    fontSize: 12,
    fontWeight: 600,
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#888',
    cursor: 'pointer',
    padding: 2,
    display: 'flex',
    alignItems: 'center',
  },
  list: {
    padding: '6px 0',
    maxHeight: 240,
    overflowY: 'auto',
  },
  boardRow: {
    padding: '0',
  },
  boardRowMain: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 12px',
  },
  boardLabel: {
    color: '#ddd',
    fontSize: 12,
    flex: 1,
  },
  stateLabel: {
    fontSize: 11,
    fontStyle: 'italic',
  },
  expandBtn: {
    background: 'none',
    border: 'none',
    color: '#ef5350',
    cursor: 'pointer',
    fontSize: 10,
    padding: '0 2px',
  },
  errorDetail: {
    margin: '0 12px 6px',
    padding: '6px 8px',
    background: '#1a0000',
    border: '1px solid #5a1a1a',
    color: '#f48fb1',
    fontSize: 11,
    fontFamily: 'Consolas, monospace',
    borderRadius: 3,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    maxHeight: 120,
    overflowY: 'auto',
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    padding: '8px 12px',
    borderTop: '1px solid #3c3c3c',
  },
  runAllBtn: {
    background: '#0e639c',
    border: 'none',
    color: '#fff',
    padding: '5px 16px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
  },
  runAllBtnDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
};

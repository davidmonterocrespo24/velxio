/**
 * Serial Monitor — multi-board tabbed view.
 * Each board has its own tab with serial output, input, and clear button.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { getTabSessionId } from '../../simulation/Esp32Bridge';
import type { BoardKind } from '../../types/board';
import { BOARD_KIND_LABELS } from '../../types/board';

// Short labels for tabs
const BOARD_SHORT_LABEL: Record<string, string> = {
  'arduino-uno':       'Uno',
  'arduino-nano':      'Nano',
  'arduino-mega':      'Mega',
  'raspberry-pi-pico': 'Pico',
  'raspberry-pi-3':    'Pi 3B',
  'esp32':    'ESP32',
  'esp32-s3': 'ESP32-S3',
  'esp32-c3': 'ESP32-C3',
};

const BOARD_ICON: Record<string, string> = {
  'arduino-uno':       '⬤',
  'arduino-nano':      '▪',
  'arduino-mega':      '▬',
  'raspberry-pi-pico': '◆',
  'raspberry-pi-3':    '⬛',
  'esp32':    '⬡',
  'esp32-s3': '⬡',
  'esp32-c3': '⬡',
};

const BOARD_COLOR: Record<string, string> = {
  'arduino-uno':       '#4fc3f7',
  'arduino-nano':      '#4fc3f7',
  'arduino-mega':      '#4fc3f7',
  'raspberry-pi-pico': '#ce93d8',
  'raspberry-pi-3':    '#ef9a9a',
  'esp32':    '#a5d6a7',
  'esp32-s3': '#a5d6a7',
  'esp32-c3': '#a5d6a7',
};

export const SerialMonitor: React.FC = () => {
  const boards = useSimulatorStore((s) => s.boards);
  const activeBoardId = useSimulatorStore((s) => s.activeBoardId);
  const serialWriteToBoard = useSimulatorStore((s) => s.serialWriteToBoard);
  const clearBoardSerialOutput = useSimulatorStore((s) => s.clearBoardSerialOutput);

  // Active tab defaults to activeBoardId, updates when active board changes
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // Track last-seen serial output length per board for unread dots
  const [lastSeenLen, setLastSeenLen] = useState<Record<string, number>>({});

  const [inputValue, setInputValue] = useState('');
  const [lineEnding, setLineEnding] = useState<'none' | 'nl' | 'cr' | 'both'>('nl');
  const [autoscroll, setAutoscroll] = useState(true);
  const outputRef = useRef<HTMLPreElement>(null);

  // Sync active tab to activeBoardId when it changes
  useEffect(() => {
    if (activeBoardId) setActiveTabId(activeBoardId);
  }, [activeBoardId]);

  // Fallback: if activeTab is gone, pick first board
  const resolvedTabId = (boards.find((b) => b.id === activeTabId) ? activeTabId : boards[0]?.id) ?? null;
  const activeBoard = boards.find((b) => b.id === resolvedTabId);

  // Mark tab as read when it becomes active
  useEffect(() => {
    if (resolvedTabId && activeBoard) {
      setLastSeenLen((prev) => ({ ...prev, [resolvedTabId]: activeBoard.serialOutput.length }));
    }
  }, [resolvedTabId, activeBoard?.serialOutput.length]);

  // Auto-scroll when output changes on the visible tab
  useEffect(() => {
    if (autoscroll && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [activeBoard?.serialOutput, autoscroll]);

  const handleSend = useCallback(() => {
    if (!resolvedTabId) return;
    if (!inputValue && lineEnding === 'none') return;
    let text = inputValue;
    switch (lineEnding) {
      case 'nl':   text += '\n';   break;
      case 'cr':   text += '\r';   break;
      case 'both': text += '\r\n'; break;
    }
    serialWriteToBoard(resolvedTabId, text);
    setInputValue('');
  }, [resolvedTabId, inputValue, lineEnding, serialWriteToBoard]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleTabClick = (boardId: string) => {
    setActiveTabId(boardId);
    const board = boards.find((b) => b.id === boardId);
    if (board) {
      setLastSeenLen((prev) => ({ ...prev, [boardId]: board.serialOutput.length }));
    }
  };

  if (boards.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <span style={styles.title}>Serial Monitor</span>
        </div>
        <pre style={styles.output}>Add a board to start the serial monitor.</pre>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Tab strip */}
      <div style={styles.tabStrip}>
        {boards.map((board) => {
          const isActive = board.id === resolvedTabId;
          const color = BOARD_COLOR[board.boardKind];
          const hasUnread = (board.serialOutput.length) > (lastSeenLen[board.id] ?? 0);
          return (
            <button
              key={board.id}
              style={{
                ...styles.tab,
                ...(isActive ? { ...styles.tabActive, borderBottomColor: color, color } : {}),
              }}
              onClick={() => handleTabClick(board.id)}
              title={BOARD_KIND_LABELS[board.boardKind]}
            >
              <span style={{ fontSize: 9, marginRight: 3, color: isActive ? color : '#888' }}>
                {BOARD_ICON[board.boardKind]}
              </span>
              {BOARD_SHORT_LABEL[board.boardKind]}
              {hasUnread && !isActive && <span style={styles.unreadDot} />}
            </button>
          );
        })}

        {/* Right-side controls */}
        <div style={styles.tabControls}>
          {activeBoard?.serialBaudRate != null && activeBoard.serialBaudRate > 0 && (
            <span style={styles.baudRate}>{activeBoard.serialBaudRate.toLocaleString()} baud</span>
          )}
          <label style={styles.autoscrollLabel}>
            <input
              type="checkbox"
              checked={autoscroll}
              onChange={(e) => setAutoscroll(e.target.checked)}
              style={styles.checkbox}
            />
            Autoscroll
          </label>
          <button
            onClick={() => resolvedTabId && clearBoardSerialOutput(resolvedTabId)}
            style={styles.clearBtn}
            title="Clear output for this board"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Output area */}
      <pre ref={outputRef} style={styles.output}>
        {activeBoard?.serialOutput ? (() => {
          const text = activeBoard.serialOutput;
          const ipRegex = /http:\/\/192\.168\.4\.(\d+)(\/[^\s]*)?/g;
          const matches = [...text.matchAll(ipRegex)];

          if (matches.length > 0) {
            const parts: (string | React.ReactNode)[] = [];
            let lastIdx = 0;
            const sessionId = getTabSessionId();
            const backendBase = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8001/api';

            matches.forEach((m, i) => {
              const start = m.index!;
              const end = start + m[0].length;
              const path = m[2] || '/';
              const clientId = `${sessionId}::${activeBoard.id}`;
              const gatewayUrl = `${backendBase}/gateway/${clientId}${path}`;

              parts.push(text.slice(lastIdx, start));
              parts.push(
                <a
                  key={i}
                  href={gatewayUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    color: '#4fc3f7',
                    textDecoration: 'underline',
                    fontWeight: 'bold',
                    cursor: 'pointer'
                  }}
                  title="Click to open through IoT Gateway"
                >
                  {m[0]} (Open IoT Gateway ↗)
                </a>
              );
              lastIdx = end;
            });
            parts.push(text.slice(lastIdx));
            return parts;
          }
          return text;
        })() : (activeBoard?.running ? 'Waiting for serial data...\n' : 'Start simulation to see serial output.\n')}
      </pre>

      {/* Input row */}
      <div style={styles.inputRow}>
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type message to send..."
          style={styles.input}
          disabled={!activeBoard?.running}
        />
        <select
          value={lineEnding}
          onChange={(e) => setLineEnding(e.target.value as typeof lineEnding)}
          style={styles.select}
        >
          <option value="none">No line ending</option>
          <option value="nl">Newline</option>
          <option value="cr">Carriage return</option>
          <option value="both">Both NL &amp; CR</option>
        </select>
        <button onClick={handleSend} disabled={!activeBoard?.running} style={styles.sendBtn}>
          Send
        </button>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: '#1e1e1e',
    borderTop: '1px solid #333',
    fontFamily: 'monospace',
    fontSize: 13,
    minHeight: 0,
  },
  tabStrip: {
    display: 'flex',
    alignItems: 'center',
    background: '#252526',
    borderBottom: '1px solid #333',
    minHeight: 32,
    flexShrink: 0,
    overflow: 'hidden',
  },
  tab: {
    background: 'none',
    border: 'none',
    borderBottom: '2px solid transparent',
    color: '#999',
    padding: '5px 12px',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
    fontFamily: 'inherit',
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    whiteSpace: 'nowrap',
    position: 'relative',
  },
  tabActive: {
    background: 'rgba(255,255,255,0.04)',
  },
  tabControls: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    paddingRight: 8,
    flexShrink: 0,
  },
  unreadDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#4fc3f7',
    flexShrink: 0,
    marginLeft: 3,
  },
  title: {
    color: '#cccccc',
    fontWeight: 600,
    fontSize: 12,
  },
  baudRate: {
    color: '#569cd6',
    fontSize: 11,
    fontFamily: 'monospace',
    background: '#1e1e1e',
    border: '1px solid #3a3a3a',
    borderRadius: 3,
    padding: '1px 6px',
  },
  autoscrollLabel: {
    color: '#999',
    fontSize: 11,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    cursor: 'pointer',
  },
  checkbox: {
    margin: 0,
    cursor: 'pointer',
  },
  clearBtn: {
    background: 'transparent',
    border: '1px solid #555',
    color: '#ccc',
    padding: '2px 8px',
    borderRadius: 3,
    cursor: 'pointer',
    fontSize: 11,
  },
  output: {
    flex: 1,
    margin: 0,
    padding: 8,
    color: '#00ff41',
    background: '#0a0a0a',
    overflowY: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    minHeight: 0,
    fontSize: 13,
    lineHeight: '1.4',
  },
  inputRow: {
    display: 'flex',
    gap: 4,
    padding: 4,
    background: '#252526',
    borderTop: '1px solid #333',
    flexShrink: 0,
  },
  input: {
    flex: 1,
    background: '#1e1e1e',
    border: '1px solid #444',
    color: '#ccc',
    padding: '4px 8px',
    borderRadius: 3,
    fontFamily: 'monospace',
    fontSize: 12,
    outline: 'none',
  },
  select: {
    background: '#1e1e1e',
    border: '1px solid #444',
    color: '#ccc',
    padding: '4px',
    borderRadius: 3,
    fontSize: 11,
    outline: 'none',
  },
  sendBtn: {
    background: '#0e639c',
    border: 'none',
    color: '#fff',
    padding: '4px 12px',
    borderRadius: 3,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
  },
};

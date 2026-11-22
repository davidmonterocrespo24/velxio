/**
 * RaspberryPiWorkspace — replaces the Monaco editor when a Raspberry Pi 3B
 * board is active. Shows a VFS explorer on the left and either:
 *   - An xterm.js terminal (default), or
 *   - A Monaco editor for the selected file
 * on the right.
 */

import React, { useState, lazy, Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Editor from '@monaco-editor/react';
import { VirtualFileSystem } from './VirtualFileSystem';
import { useVfsStore } from '../../store/useVfsStore';
import { getBoardBridge, useSimulatorStore } from '../../store/useSimulatorStore';
import { attachSlavesFromCanvas } from '../../simulation/piSlaveScanner';
import { boardDisplayName } from '../../types/board';
import { defineVelxioThemes, useMonacoTheme } from '../editor/monacoThemes';

// Lazy-load PiTerminal so @xterm/xterm is only bundled when needed
const PiTerminal = lazy(() => import('./PiTerminal').then((m) => ({ default: m.PiTerminal })));

interface RaspberryPiWorkspaceProps {
  boardId: string;
}

interface OpenFile {
  nodeId: string;
  filename: string;
}

// Inline SVG icons (house style: no emoji). currentColor lets them inherit the
// surrounding text colour.
const PlayIcon: React.FC = () => (
  <svg width="11" height="11" viewBox="0 0 10 10" aria-hidden="true" style={{ marginRight: 5, verticalAlign: -1 }}>
    <path d="M2 1.2 L8.5 5 L2 8.8 Z" fill="currentColor" />
  </svg>
);

const TerminalIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" style={{ marginRight: 4, verticalAlign: -1 }}>
    <rect x="1" y="2.5" width="14" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <path d="M4 6 L6.5 8 L4 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="8" y1="10.3" x2="11.5" y2="10.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

const MonitorIcon: React.FC = () => (
  <svg width="40" height="40" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="2.5" y="3.5" width="19" height="13" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <line x1="9" y1="20.5" x2="15" y2="20.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <line x1="12" y1="16.5" x2="12" y2="20.5" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

// Indeterminate spinner using SMIL (self-contained — no global CSS keyframes).
const BootSpinner: React.FC = () => (
  <svg width="34" height="34" viewBox="0 0 44 44" aria-hidden="true">
    <circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="4" />
    <path d="M22 4 a18 18 0 0 1 18 18" fill="none" stroke="#4fc3f7" strokeWidth="4" strokeLinecap="round">
      <animateTransform attributeName="transform" type="rotate" from="0 22 22" to="360 22 22" dur="0.9s" repeatCount="indefinite" />
    </path>
  </svg>
);

export const RaspberryPiWorkspace: React.FC<RaspberryPiWorkspaceProps> = ({ boardId }) => {
  const { t } = useTranslation();
  const [activePane, setActivePane] = useState<'terminal' | string>('terminal'); // string = nodeId
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [bridgeConnected, setBridgeConnected] = useState(false);
  const monacoTheme = useMonacoTheme();

  const board = useSimulatorStore((s) => s.boards.find((b) => b.id === boardId));
  const startBoard = useSimulatorStore((s) => s.startBoard);
  const setContent = useVfsStore((s) => s.setContent);
  const getNode = useVfsStore((s) => s.getNode);

  // Display the active board's real name (Pi 3B / 4B / 5 / Zero / …) instead of
  // a hardcoded "Raspberry Pi 3B" — the workspace serves the whole Pi family.
  const boardLabel = board ? boardDisplayName(board) : 'Raspberry Pi';
  // Overlay QEMU-Linux boards (piFamily kinds) are not Raspberry Pis — their
  // start button / power title must carry the board's own name.
  const isRaspberry = !board || board.boardKind.startsWith('raspberry-pi');
  const startLabel = isRaspberry
    ? t('editor.pi.startPi')
    : t('editor.pi.startBoard', { board: boardLabel, defaultValue: 'Start {{board}}' });
  const powerOnTitle = isRaspberry
    ? t('editor.pi.powerOnTitle')
    : t('editor.pi.powerOnBoardTitle', { board: boardLabel, defaultValue: 'Power on {{board}}' });

  // Three display states: offline (!running) → booting (running, guest Linux
  // still coming up) → ready (running + booted shell). `running` flips on click
  // but the guest takes 30-60s; `piBooted` is the real "shell ready" signal.
  const booting = !!board?.running && !board?.piBooted;
  const booted = !!board?.running && !!board?.piBooted;

  // Auto-connect terminal when board starts running
  useEffect(() => {
    if (!board?.running) {
      setBridgeConnected(false);
      return;
    }
    // Small delay to let the bridge WebSocket establish after QEMU starts
    const timer = setTimeout(() => {
      const bridge = getBoardBridge(boardId);
      if (bridge && !bridge.connected) {
        bridge.connect();
      }
      setBridgeConnected(bridge?.connected ?? false);

      // After the WS is open, scan the canvas for I2C/SPI/UART
      // peripherals wired to this Pi and tell the backend to attach
      // their slave models. We retry up to ~3s in case attachSlave
      // calls race the WS open.
      const attachOnce = (): boolean => {
        const b = getBoardBridge(boardId);
        if (!b?.connected) return false;
        const { components, wires } = useSimulatorStore.getState();
        attachSlavesFromCanvas(boardId, b, components, wires);
        return true;
      };
      if (!attachOnce()) {
        let attempts = 0;
        const interval = setInterval(() => {
          attempts++;
          if (attachOnce() || attempts >= 6) clearInterval(interval);
        }, 500);
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [board?.running, boardId]);

  // Poll bridge.connected state to reflect it in toolbar
  useEffect(() => {
    const interval = setInterval(() => {
      const bridge = getBoardBridge(boardId);
      setBridgeConnected(bridge?.connected ?? false);
    }, 1000);
    return () => clearInterval(interval);
  }, [boardId]);

  const handleFileSelect = (nodeId: string, _content: string, filename: string) => {
    setOpenFiles((prev) => {
      if (prev.find((f) => f.nodeId === nodeId)) return prev;
      return [...prev, { nodeId, filename }];
    });
    setActivePane(nodeId);
  };

  const handleCloseFile = (nodeId: string) => {
    setOpenFiles((prev) => prev.filter((f) => f.nodeId !== nodeId));
    if (activePane === nodeId) setActivePane('terminal');
  };

  const handleConnect = () => {
    const bridge = getBoardBridge(boardId);
    if (bridge && !bridge.connected) {
      bridge.connect();
      setTimeout(() => setBridgeConnected(getBoardBridge(boardId)?.connected ?? false), 500);
    }
  };

  const handleDisconnect = () => {
    const bridge = getBoardBridge(boardId);
    if (bridge && bridge.connected) {
      bridge.disconnect();
      setBridgeConnected(false);
    }
  };

  const activeFileNode =
    typeof activePane === 'string' && activePane !== 'terminal'
      ? getNode(boardId, activePane)
      : null;

  return (
    <div style={styles.container}>
      {/* Left: VFS explorer */}
      <div style={styles.sidebar}>
        <VirtualFileSystem boardId={boardId} onFileSelect={handleFileSelect} />
      </div>

      {/* Right: terminal or file editor */}
      <div style={styles.main}>
        {/* Pi-specific toolbar */}
        <div style={styles.toolbar}>
          <span style={styles.toolbarTitle}>{boardLabel}</span>
          <div style={styles.toolbarActions}>
            {/* Status indicator */}
            <span
              style={{
                ...styles.statusDot,
                background: booted ? '#4caf50' : board?.running ? '#f59e0b' : 'var(--wb-9)',
              }}
            />
            <span style={styles.statusLabel}>
              {booted
                ? t('editor.pi.connected')
                : board?.running
                  ? t('editor.pi.starting')
                  : t('editor.pi.offline')}
            </span>

            {!board?.running ? (
              <button
                style={{ ...styles.toolbarBtn, color: '#4caf50', borderColor: '#4caf50' }}
                onClick={() => startBoard(boardId)}
                title={powerOnTitle}
              >
                <PlayIcon />{startLabel}
              </button>
            ) : (
              <>
                <button
                  style={{ ...styles.toolbarBtn, color: bridgeConnected ? 'var(--wb-10)' : '#4fc3f7' }}
                  onClick={handleConnect}
                  title={t('editor.pi.connectTitle')}
                  disabled={bridgeConnected}
                >
                  {t('editor.pi.connect')}
                </button>
                <button
                  style={{ ...styles.toolbarBtn, color: 'var(--color-feedback-error)' }}
                  onClick={handleDisconnect}
                  title={t('editor.pi.disconnectTitle')}
                  disabled={!bridgeConnected}
                >
                  {t('editor.pi.disconnect')}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Tab strip */}
        <div style={styles.tabStrip}>
          {/* Terminal tab */}
          <button
            style={{
              ...styles.tab,
              ...(activePane === 'terminal' ? styles.tabActive : {}),
            }}
            onClick={() => setActivePane('terminal')}
          >
            <TerminalIcon />{t('editor.pi.terminal')}
          </button>

          {/* File tabs */}
          {openFiles.map((f) => (
            <button
              key={f.nodeId}
              style={{
                ...styles.tab,
                ...(activePane === f.nodeId ? styles.tabActive : {}),
              }}
              onClick={() => setActivePane(f.nodeId)}
            >
              {f.filename}
              <span
                style={styles.tabClose}
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseFile(f.nodeId);
                }}
                title={t('editor.pi.close')}
              >
                ×
              </span>
            </button>
          ))}
        </div>

        {/* Pane content */}
        <div style={styles.pane}>
          {/* Offline overlay — shown over terminal/editor when Pi is not running */}
          {!board?.running && (
            <div style={styles.offlineOverlay}>
              <div style={styles.offlineBox}>
                <div style={styles.offlineIcon}><MonitorIcon /></div>
                <div style={styles.offlineTitle}>{t('editor.pi.offlineTitle', { board: boardLabel })}</div>
                <div style={styles.offlineSubtitle}>{t('editor.pi.offlineSubtitle')}</div>
                <button style={styles.startBtn} onClick={() => startBoard(boardId)}>
                  <PlayIcon />{startLabel}
                </button>
                <div style={styles.offlineNote}>
                  {t('editor.pi.offlineNote1')}
                  <br />
                  {t('editor.pi.offlineNote2')}
                </div>
              </div>
            </div>
          )}

          {/* Booting overlay — shown while the guest Linux comes up (~30-60s).
              Without it the user clicks Start and sees nothing change for a
              minute and assumes it is broken. */}
          {booting && (
            <div style={styles.offlineOverlay}>
              <div style={styles.offlineBox}>
                <div style={styles.bootingIcon}><BootSpinner /></div>
                <div style={styles.offlineTitle}>{t('editor.pi.bootingTitle', { board: boardLabel })}</div>
                <div style={styles.offlineSubtitle}>{t('editor.pi.bootingNote')}</div>
              </div>
            </div>
          )}
          {activePane === 'terminal' ? (
            <Suspense fallback={<div style={styles.loading}>{t('editor.pi.loadingTerminal')}</div>}>
              <PiTerminal boardId={boardId} />
            </Suspense>
          ) : activeFileNode ? (
            <Editor
              key={activePane}
              height="100%"
              language={activeFileNode.name.endsWith('.py') ? 'python' : 'shell'}
              theme={monacoTheme}
              beforeMount={defineVelxioThemes}
              value={activeFileNode.content ?? ''}
              onChange={(val) => setContent(boardId, activePane, val ?? '')}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                automaticLayout: true,
                scrollBeyondLastLine: false,
                wordWrap: 'on',
              }}
            />
          ) : (
            <div style={styles.loading}>{t('editor.pi.selectFile')}</div>
          )}
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    background: 'var(--wb-2)',
  },
  sidebar: {
    width: 200,
    minWidth: 160,
    maxWidth: 280,
    flexShrink: 0,
    overflow: 'hidden',
    borderRight: '1px solid var(--wb-6)',
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    minWidth: 0,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: 'var(--wb-3)',
    borderBottom: '1px solid var(--wb-6)',
    padding: '0 10px',
    height: 36,
    flexShrink: 0,
  },
  toolbarTitle: {
    color: 'var(--color-feedback-error)',
    fontSize: 11,
    fontWeight: 700,
    fontFamily: 'Segoe UI, sans-serif',
  },
  toolbarActions: {
    display: 'flex',
    gap: 6,
  },
  toolbarBtn: {
    background: 'none',
    border: '1px solid var(--wb-7)',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 11,
    padding: '2px 10px',
    fontFamily: 'Segoe UI, sans-serif',
  },
  tabStrip: {
    display: 'flex',
    alignItems: 'center',
    background: 'var(--wb-3)',
    borderBottom: '1px solid var(--wb-6)',
    minHeight: 30,
    flexShrink: 0,
    overflow: 'hidden',
  },
  tab: {
    background: 'none',
    border: 'none',
    borderBottom: '2px solid transparent',
    color: 'var(--wb-11)',
    padding: '5px 12px',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
    fontFamily: 'Segoe UI, sans-serif',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    whiteSpace: 'nowrap',
  },
  tabActive: {
    borderBottomColor: 'var(--color-feedback-error)',
    color: 'var(--color-feedback-error)',
    background: 'rgba(255,255,255,0.04)',
  },
  tabClose: {
    marginLeft: 4,
    fontSize: 14,
    lineHeight: 1,
    opacity: 0.6,
    cursor: 'pointer',
  },
  pane: {
    flex: 1,
    overflow: 'hidden',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
  },
  loading: {
    color: 'var(--wb-9)',
    fontSize: 12,
    padding: 16,
    fontFamily: 'Segoe UI, sans-serif',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  statusLabel: {
    color: 'var(--wb-11)',
    fontSize: 11,
    fontFamily: 'Segoe UI, sans-serif',
    marginRight: 6,
  },
  offlineOverlay: {
    position: 'absolute' as const,
    inset: 0,
    background: 'rgba(10,10,10,0.88)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  offlineBox: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 12,
    padding: '36px 40px',
    background: 'var(--wb-2)',
    border: '1px solid var(--wb-7)',
    borderRadius: 10,
    maxWidth: 360,
    textAlign: 'center' as const,
  },
  offlineIcon: {
    color: 'var(--wb-10)',
    lineHeight: 0,
    marginBottom: 2,
  },
  bootingIcon: {
    lineHeight: 0,
    marginBottom: 2,
  },
  offlineTitle: {
    color: 'var(--color-feedback-error)',
    fontSize: 15,
    fontWeight: 700,
    fontFamily: 'Segoe UI, sans-serif',
  },
  offlineSubtitle: {
    color: 'var(--wb-11)',
    fontSize: 12,
    fontFamily: 'Segoe UI, sans-serif',
    lineHeight: 1.5,
  },
  startBtn: {
    background: 'var(--color-feedback-success-soft)',
    border: '1px solid #4caf50',
    borderRadius: 6,
    color: '#4caf50',
    fontSize: 13,
    fontWeight: 700,
    fontFamily: 'Segoe UI, sans-serif',
    padding: '8px 24px',
    cursor: 'pointer',
    marginTop: 4,
  },
  offlineNote: {
    color: 'var(--wb-9)',
    fontSize: 10,
    fontFamily: 'Segoe UI, sans-serif',
    lineHeight: 1.5,
    marginTop: 4,
  },
};

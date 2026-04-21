/**
 * RaspberryPiWorkspace — replaces the Monaco editor when a Raspberry Pi 3B
 * board is active. Shows a VFS explorer on the left and either:
 *   - An xterm.js terminal (default), or
 *   - A Monaco editor for the selected file
 * on the right.
 */

import React, { useState, lazy, Suspense, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { VirtualFileSystem } from './VirtualFileSystem';
import { useVfsStore } from '../../store/useVfsStore';
import { getBoardBridge, useSimulatorStore } from '../../store/useSimulatorStore';

// Lazy-load PiTerminal so @xterm/xterm is only bundled when needed
const PiTerminal = lazy(() => import('./PiTerminal').then((m) => ({ default: m.PiTerminal })));

interface RaspberryPiWorkspaceProps {
  boardId: string;
}

interface OpenFile {
  nodeId: string;
  filename: string;
}

export const RaspberryPiWorkspace: React.FC<RaspberryPiWorkspaceProps> = ({ boardId }) => {
  const [activePane, setActivePane] = useState<'terminal' | string>('terminal'); // string = nodeId
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [bridgeConnected, setBridgeConnected] = useState(false);

  const board = useSimulatorStore((s) => s.boards.find((b) => b.id === boardId));
  const startBoard = useSimulatorStore((s) => s.startBoard);
  const setContent = useVfsStore((s) => s.setContent);
  const getNode = useVfsStore((s) => s.getNode);

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
          <span style={styles.toolbarTitle}>Raspberry Pi 3B</span>
          <div style={styles.toolbarActions}>
            {/* Status indicator */}
            <span
              style={{
                ...styles.statusDot,
                background: board?.running ? (bridgeConnected ? '#4caf50' : '#f59e0b') : '#6b7280',
              }}
            />
            <span style={styles.statusLabel}>
              {board?.running ? (bridgeConnected ? 'Connected' : 'Starting…') : 'Offline'}
            </span>

            {!board?.running ? (
              <button
                style={{ ...styles.toolbarBtn, color: '#4caf50', borderColor: '#4caf50' }}
                onClick={() => startBoard(boardId)}
                title="Power on the Raspberry Pi"
              >
                ▶ Start Pi
              </button>
            ) : (
              <>
                <button
                  style={{ ...styles.toolbarBtn, color: bridgeConnected ? '#888' : '#4fc3f7' }}
                  onClick={handleConnect}
                  title="Connect terminal to Pi"
                  disabled={bridgeConnected}
                >
                  Connect
                </button>
                <button
                  style={{ ...styles.toolbarBtn, color: '#ef9a9a' }}
                  onClick={handleDisconnect}
                  title="Disconnect terminal"
                  disabled={!bridgeConnected}
                >
                  Disconnect
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
            ⌨ Terminal
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
                title="Close"
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
                <div style={styles.offlineIcon}>🖥️</div>
                <div style={styles.offlineTitle}>Raspberry Pi 3B is powered off</div>
                <div style={styles.offlineSubtitle}>
                  Start the Pi to open a terminal and interact with the Linux system.
                </div>
                <button style={styles.startBtn} onClick={() => startBoard(boardId)}>
                  ▶ Start Pi
                </button>
                <div style={styles.offlineNote}>
                  Note: The file explorer shows a staging area.
                  <br />
                  Use "Upload to Pi" after starting to transfer files to the running Pi.
                </div>
              </div>
            </div>
          )}
          {activePane === 'terminal' ? (
            <Suspense fallback={<div style={styles.loading}>Loading terminal…</div>}>
              <PiTerminal boardId={boardId} />
            </Suspense>
          ) : activeFileNode ? (
            <Editor
              key={activePane}
              height="100%"
              language={activeFileNode.name.endsWith('.py') ? 'python' : 'shell'}
              theme="vs-dark"
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
            <div style={styles.loading}>Select a file from the explorer to edit it.</div>
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
    background: '#1e1e1e',
  },
  sidebar: {
    width: 200,
    minWidth: 160,
    maxWidth: 280,
    flexShrink: 0,
    overflow: 'hidden',
    borderRight: '1px solid #333',
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
    background: '#252526',
    borderBottom: '1px solid #333',
    padding: '0 10px',
    height: 36,
    flexShrink: 0,
  },
  toolbarTitle: {
    color: '#ef9a9a',
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
    border: '1px solid #3c3c3c',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 11,
    padding: '2px 10px',
    fontFamily: 'Segoe UI, sans-serif',
  },
  tabStrip: {
    display: 'flex',
    alignItems: 'center',
    background: '#252526',
    borderBottom: '1px solid #333',
    minHeight: 30,
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
    fontFamily: 'Segoe UI, sans-serif',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    whiteSpace: 'nowrap',
  },
  tabActive: {
    borderBottomColor: '#ef9a9a',
    color: '#ef9a9a',
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
    color: '#666',
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
    color: '#aaa',
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
    background: '#1e1e1e',
    border: '1px solid #444',
    borderRadius: 10,
    maxWidth: 360,
    textAlign: 'center' as const,
  },
  offlineIcon: {
    fontSize: 40,
    lineHeight: 1,
  },
  offlineTitle: {
    color: '#ef9a9a',
    fontSize: 15,
    fontWeight: 700,
    fontFamily: 'Segoe UI, sans-serif',
  },
  offlineSubtitle: {
    color: '#aaa',
    fontSize: 12,
    fontFamily: 'Segoe UI, sans-serif',
    lineHeight: 1.5,
  },
  startBtn: {
    background: '#1b5e20',
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
    color: '#666',
    fontSize: 10,
    fontFamily: 'Segoe UI, sans-serif',
    lineHeight: 1.5,
    marginTop: 4,
  },
};

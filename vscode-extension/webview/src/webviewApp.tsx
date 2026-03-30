/**
 * WebView App — Stripped-down Velxio simulator for VS Code WebView.
 *
 * This is a minimal React app that embeds:
 * - SimulatorCanvas (board visualization + components)
 * - SerialMonitor (serial output/input)
 *
 * It does NOT include: routing, auth, Monaco editor, project persistence.
 * Communication with the VS Code extension is via postMessage bridge.
 */

import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { onMessage, notifyReady, sendSerialOutput, sendSimulationState, sendError } from './bridge';

/**
 * Placeholder app — Phase 1 MVP
 *
 * In the full implementation, this will import and render:
 * - SimulatorCanvas from the shared frontend/src/components/
 * - SerialMonitor from the shared frontend/src/components/
 * - useSimulatorStore from the shared frontend/src/store/
 *
 * For now, this is a functional skeleton that handles the postMessage
 * protocol and shows a basic simulation status panel.
 */
const App: React.FC = () => {
  const [board, setBoard] = useState('arduino-uno');
  const [running, setRunning] = useState(false);
  const [serialOutput, setSerialOutput] = useState('');
  const [status, setStatus] = useState('Ready');
  const [hexLoaded, setHexLoaded] = useState(false);

  useEffect(() => {
    onMessage((msg) => {
      switch (msg.type) {
        case 'setBoard':
          setBoard(msg.board);
          setStatus(`Board: ${msg.board}`);
          break;
        case 'loadHex':
          setHexLoaded(true);
          setStatus(`Firmware loaded for ${msg.board}`);
          break;
        case 'loadBinary':
          setHexLoaded(true);
          setStatus(`Binary firmware loaded for ${msg.board}`);
          break;
        case 'loadMicroPython':
          setHexLoaded(true);
          setStatus(`MicroPython loaded (${msg.files.length} files)`);
          break;
        case 'start':
          setRunning(true);
          setStatus('Simulation running');
          sendSimulationState(true);
          break;
        case 'stop':
          setRunning(false);
          setStatus('Simulation stopped');
          sendSimulationState(false);
          break;
        case 'serialInput':
          setSerialOutput(prev => prev + `> ${msg.text}\n`);
          break;
        case 'setApiBase':
          setStatus(`Backend: ${msg.apiBase}`);
          break;
      }
    });

    // Tell the extension we're ready
    notifyReady();
  }, []);

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.logo}>Velxio</span>
        <span style={styles.boardBadge}>{board}</span>
        <span style={{
          ...styles.statusDot,
          background: running ? '#4caf50' : hexLoaded ? '#ff9800' : '#666',
        }} />
        <span style={styles.status}>{status}</span>
      </div>

      {/* Simulation Canvas Placeholder */}
      <div style={styles.canvas}>
        <div style={styles.canvasPlaceholder}>
          <div style={styles.boardIcon}>
            {board.includes('esp32') ? '⬡' : board.includes('pico') ? '◆' : '⬤'}
          </div>
          <div style={styles.boardName}>{board}</div>
          {running && (
            <div style={styles.runningIndicator}>
              <span style={styles.pulsingDot} />
              Simulating...
            </div>
          )}
          {!running && !hexLoaded && (
            <div style={styles.hint}>
              Use <code>Velxio: Run Simulation</code> to start
            </div>
          )}
          {!running && hexLoaded && (
            <div style={styles.hint}>
              Firmware loaded. Press <strong>Run</strong> to start.
            </div>
          )}
        </div>
      </div>

      {/* Serial Monitor */}
      <div style={styles.serialContainer}>
        <div style={styles.serialHeader}>
          <span style={styles.serialTitle}>Serial Monitor</span>
          {running && <span style={styles.serialBadge}>CONNECTED</span>}
        </div>
        <pre style={styles.serialOutput}>
          {serialOutput || (running ? 'Waiting for serial data...\n' : 'Start simulation to see output.\n')}
        </pre>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: 'var(--vscode-editor-background, #1e1e1e)',
    color: 'var(--vscode-editor-foreground, #cccccc)',
    fontFamily: 'var(--vscode-font-family, monospace)',
    fontSize: 13,
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 12px',
    background: 'var(--vscode-titleBar-activeBackground, #3c3c3c)',
    borderBottom: '1px solid var(--vscode-panel-border, #333)',
    flexShrink: 0,
  },
  logo: {
    fontWeight: 700,
    fontSize: 14,
    color: 'var(--vscode-textLink-foreground, #4fc3f7)',
  },
  boardBadge: {
    background: 'var(--vscode-badge-background, #0e639c)',
    color: 'var(--vscode-badge-foreground, #fff)',
    padding: '1px 8px',
    borderRadius: 10,
    fontSize: 11,
    fontWeight: 600,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  status: {
    fontSize: 11,
    color: 'var(--vscode-descriptionForeground, #999)',
  },
  canvas: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 0,
    background: 'var(--vscode-editor-background, #1e1e1e)',
  },
  canvasPlaceholder: {
    textAlign: 'center' as const,
    padding: 40,
  },
  boardIcon: {
    fontSize: 64,
    marginBottom: 16,
    opacity: 0.5,
  },
  boardName: {
    fontSize: 18,
    fontWeight: 600,
    marginBottom: 8,
  },
  runningIndicator: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    color: '#4caf50',
    fontSize: 14,
    marginTop: 12,
  },
  pulsingDot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    background: '#4caf50',
    animation: 'pulse 1.5s ease-in-out infinite',
  },
  hint: {
    color: 'var(--vscode-descriptionForeground, #888)',
    fontSize: 12,
    marginTop: 12,
  },
  serialContainer: {
    height: 200,
    display: 'flex',
    flexDirection: 'column',
    borderTop: '1px solid var(--vscode-panel-border, #333)',
    flexShrink: 0,
  },
  serialHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 12px',
    background: 'var(--vscode-sideBar-background, #252526)',
    borderBottom: '1px solid var(--vscode-panel-border, #333)',
  },
  serialTitle: {
    fontWeight: 600,
    fontSize: 12,
  },
  serialBadge: {
    background: '#4caf50',
    color: '#fff',
    padding: '0 6px',
    borderRadius: 3,
    fontSize: 9,
    fontWeight: 700,
  },
  serialOutput: {
    flex: 1,
    margin: 0,
    padding: 8,
    color: '#00ff41',
    background: '#0a0a0a',
    overflowY: 'auto' as const,
    whiteSpace: 'pre-wrap' as const,
    fontSize: 12,
    lineHeight: 1.4,
  },
};

// Mount
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}

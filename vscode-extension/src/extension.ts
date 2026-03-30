/**
 * Velxio VS Code Extension — Entry point
 *
 * Provides commands to compile, simulate, and interact with Arduino/ESP32
 * sketches directly within VS Code. Simulation runs locally using avr8js,
 * rp2040js (in the WebView), and QEMU (via the backend) for ESP32 boards.
 */

import * as vscode from 'vscode';
import { SimulatorPanel } from './SimulatorPanel';
import { BackendManager } from './BackendManager';
import { ProjectConfig } from './ProjectConfig';
import { SerialTerminal } from './SerialTerminal';
import { FileWatcher } from './FileWatcher';
import { BOARD_LABELS, type BoardKind } from './types';

let backend: BackendManager;
let serialTerminal: SerialTerminal;
let fileWatcher: FileWatcher;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Velxio');
  backend = new BackendManager(outputChannel);
  serialTerminal = new SerialTerminal();
  fileWatcher = new FileWatcher();

  // Status bar item showing current board
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBarItem.command = 'velxio.selectBoard';
  statusBarItem.tooltip = 'Click to change board';
  updateStatusBar('arduino-uno');

  // ── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('velxio.openSimulator', () => {
      const panel = SimulatorPanel.createOrShow(context.extensionUri);
      setupPanelListeners(panel, context);
      statusBarItem.show();
    }),

    vscode.commands.registerCommand('velxio.compile', async () => {
      await compileAndLoad(context);
    }),

    vscode.commands.registerCommand('velxio.run', async () => {
      const panel = SimulatorPanel.createOrShow(context.extensionUri);
      setupPanelListeners(panel, context);

      if (!panel.ready) {
        // Wait for the WebView to initialize
        await new Promise<void>(resolve => {
          const disposable = panel.onReady(() => { disposable.dispose(); resolve(); });
        });
      }

      await compileAndLoad(context);
      panel.start();
    }),

    vscode.commands.registerCommand('velxio.stop', () => {
      const panel = SimulatorPanel.createOrShow(context.extensionUri);
      panel.stop();
    }),

    vscode.commands.registerCommand('velxio.selectBoard', async () => {
      const boards = Object.entries(BOARD_LABELS) as [BoardKind, string][];
      const items = boards.map(([kind, label]) => ({
        label,
        description: kind,
        kind: kind,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a board',
        title: 'Velxio: Select Board',
      });

      if (selected) {
        const boardKind = selected.description as BoardKind;
        updateStatusBar(boardKind);

        // Update velxio.toml if it exists
        const workspaceRoot = getWorkspaceRoot();
        if (workspaceRoot) {
          const config = new ProjectConfig(workspaceRoot);
          const existingConfig = config.readVelxioToml();
          if (existingConfig) {
            await config.createDefaultConfig(boardKind);
          }
        }

        // Update the WebView
        try {
          const panel = SimulatorPanel.createOrShow(context.extensionUri);
          panel.setBoard(boardKind);
        } catch {
          // Panel not open yet, that's fine
        }
      }
    }),
  );

  // ── Auto-activation ───────────────────────────────────────────────────────

  // If velxio.toml or diagram.json exists, show the status bar
  const workspaceRoot = getWorkspaceRoot();
  if (workspaceRoot) {
    const config = new ProjectConfig(workspaceRoot);
    const velxioConfig = config.readVelxioToml();
    if (velxioConfig) {
      updateStatusBar(config.getBoard());
      statusBarItem.show();
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  context.subscriptions.push(
    outputChannel,
    statusBarItem,
    serialTerminal,
    fileWatcher,
    { dispose: () => { backend.stop(); } },
  );

  outputChannel.appendLine('Velxio extension activated');
}

export function deactivate() {
  backend.stop();
  fileWatcher.stop();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getWorkspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  return folders?.[0]?.uri.fsPath ?? null;
}

function updateStatusBar(board: BoardKind): void {
  const label = BOARD_LABELS[board] ?? board;
  statusBarItem.text = `$(circuit-board) ${label}`;
}

let panelListenersSet = false;

function setupPanelListeners(panel: SimulatorPanel, context: vscode.ExtensionContext): void {
  if (panelListenersSet) return;
  panelListenersSet = true;

  // Wire serial output to the VS Code terminal
  panel.onSerialOutput((text) => {
    serialTerminal.write(text);
  });

  // Wire terminal input back to the simulation
  serialTerminal.onInput((text) => {
    panel.serialInput(text);
  });

  // When the panel is ready, send initial configuration
  panel.onReady(async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const config = new ProjectConfig(workspaceRoot);
    const board = config.getBoard();
    panel.setBoard(board);

    // Read diagram.json if it exists
    const diagram = config.readDiagramJson();
    if (diagram) {
      panel.postMessage({ type: 'setDiagram', diagram });
    }

    // Start backend if needed (for ESP32 boards)
    if (needsBackend(board)) {
      try {
        await backend.start();
        panel.setApiBase(backend.apiBase);
      } catch (err) {
        outputChannel.appendLine(`[Backend] Failed to start: ${err}`);
      }
    }
  });
}

function needsBackend(board: BoardKind): boolean {
  // Arduino compilation always needs the backend
  // ESP32 boards also need QEMU via the backend WebSocket
  return true; // For MVP, always start the backend
}

async function compileAndLoad(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }

  const config = new ProjectConfig(workspaceRoot);
  const board = config.getBoard();
  const language = config.getLanguageMode();

  const panel = SimulatorPanel.createOrShow(context.extensionUri);
  setupPanelListeners(panel, context);

  // Check for pre-compiled firmware first
  const firmwarePath = config.getFirmwarePath();
  if (firmwarePath) {
    outputChannel.appendLine(`[Compile] Loading pre-compiled firmware: ${firmwarePath}`);
    const fs = await import('fs');
    const data = fs.readFileSync(firmwarePath);

    if (firmwarePath.endsWith('.hex')) {
      panel.loadHex(data.toString('utf-8'), board);
    } else {
      panel.loadBinary(data.toString('base64'), board);
    }
    return;
  }

  // MicroPython: just send .py files
  if (language === 'micropython') {
    const files = await config.getSketchFiles();
    panel.loadMicroPython(files, board);
    return;
  }

  // Arduino: compile via backend
  try {
    await backend.start();

    const files = await config.getSketchFiles();
    outputChannel.appendLine(`[Compile] Compiling ${files.length} files for ${board}...`);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Velxio: Compiling...' },
      async () => {
        const response = await fetch(`${backend.apiBase}/compile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            files: files.map(f => ({ name: f.name, content: f.content })),
            board_fqbn: getBoardFqbn(board),
          }),
        });

        if (!response.ok) {
          const error = await response.json() as { detail?: string };
          throw new Error(error.detail ?? `Compilation failed (${response.status})`);
        }

        const result = await response.json() as { hex?: string; binary?: string };
        if (result.hex) {
          panel.loadHex(result.hex, board);
          outputChannel.appendLine('[Compile] Success — hex loaded');
        }
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Compilation failed: ${msg}`);
    outputChannel.appendLine(`[Compile] Error: ${msg}`);
  }
}

function getBoardFqbn(board: BoardKind): string {
  const fqbnMap: Record<string, string> = {
    'arduino-uno': 'arduino:avr:uno',
    'arduino-nano': 'arduino:avr:nano:cpu=atmega328',
    'arduino-mega': 'arduino:avr:mega',
    'raspberry-pi-pico': 'rp2040:rp2040:rpipico',
    'pi-pico-w': 'rp2040:rp2040:rpipicow',
    'esp32': 'esp32:esp32:esp32',
    'esp32-s3': 'esp32:esp32:esp32s3',
    'esp32-c3': 'esp32:esp32:esp32c3',
    'attiny85': 'ATTinyCore:avr:attinyx5:chip=85,clock=internal16mhz',
  };
  return fqbnMap[board] ?? 'arduino:avr:uno';
}

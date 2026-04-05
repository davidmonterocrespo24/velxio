/**
 * SimulatorPanel — Manages the VS Code WebView panel that hosts the simulation UI.
 *
 * The WebView runs a stripped-down version of the Velxio React frontend
 * (SimulatorCanvas + SerialMonitor) with simulation engines (avr8js, rp2040js)
 * running directly in the WebView's JavaScript context.
 *
 * Communication with the extension host uses VS Code's postMessage API.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { ToWebviewMessage, FromWebviewMessage, BoardKind } from './types';

export class SimulatorPanel {
  public static readonly viewType = 'velxio.simulator';
  private static instance: SimulatorPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private _ready = false;
  private _onSerialOutput = new vscode.EventEmitter<string>();
  private _onSimulationState = new vscode.EventEmitter<boolean>();
  private _onReady = new vscode.EventEmitter<void>();

  /** Fired when serial data arrives from the simulation */
  public readonly onSerialOutput = this._onSerialOutput.event;
  /** Fired when simulation starts/stops */
  public readonly onSimulationState = this._onSimulationState.event;
  /** Fired when the WebView is ready */
  public readonly onReady = this._onReady.event;

  public get ready(): boolean { return this._ready; }

  /** Get or create the singleton panel */
  public static createOrShow(extensionUri: vscode.Uri): SimulatorPanel {
    const column = vscode.ViewColumn.Beside;

    if (SimulatorPanel.instance) {
      SimulatorPanel.instance.panel.reveal(column);
      return SimulatorPanel.instance;
    }

    const panel = vscode.window.createWebviewPanel(
      SimulatorPanel.viewType,
      'Velxio Simulator',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'dist', 'webview'),
          vscode.Uri.joinPath(extensionUri, 'media'),
        ],
      },
    );

    SimulatorPanel.instance = new SimulatorPanel(panel, extensionUri);
    return SimulatorPanel.instance;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.webview.html = this.getHtmlContent();

    // Handle messages from the WebView
    this.panel.webview.onDidReceiveMessage(
      (msg: FromWebviewMessage) => this.handleMessage(msg),
      null,
      this.disposables,
    );

    // Cleanup on dispose
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /** Send a message to the WebView */
  public postMessage(message: ToWebviewMessage): void {
    if (this._ready) {
      this.panel.webview.postMessage(message);
    }
  }

  /** Send compiled hex to the WebView */
  public loadHex(hex: string, board: BoardKind): void {
    this.postMessage({ type: 'loadHex', hex, board });
  }

  /** Send firmware binary (base64) for ESP32 */
  public loadBinary(firmwareBase64: string, board: BoardKind): void {
    this.postMessage({ type: 'loadBinary', firmwareBase64, board });
  }

  /** Load MicroPython files */
  public loadMicroPython(files: Array<{ name: string; content: string }>, board: BoardKind): void {
    this.postMessage({ type: 'loadMicroPython', files, board });
  }

  /** Start the simulation */
  public start(): void {
    this.postMessage({ type: 'start' });
  }

  /** Stop the simulation */
  public stop(): void {
    this.postMessage({ type: 'stop' });
  }

  /** Send serial input text */
  public serialInput(text: string): void {
    this.postMessage({ type: 'serialInput', text });
  }

  /** Set the board type */
  public setBoard(board: BoardKind): void {
    this.postMessage({ type: 'setBoard', board });
  }

  /** Set the backend API base URL */
  public setApiBase(apiBase: string): void {
    this.postMessage({ type: 'setApiBase', apiBase });
  }

  private handleMessage(msg: FromWebviewMessage): void {
    switch (msg.type) {
      case 'ready':
        this._ready = true;
        this._onReady.fire();
        break;
      case 'serialOutput':
        this._onSerialOutput.fire(msg.text);
        break;
      case 'simulationState':
        this._onSimulationState.fire(msg.running);
        break;
      case 'error':
        vscode.window.showErrorMessage(`Velxio: ${msg.message}`);
        break;
      case 'log':
        // Forward WebView logs to the output channel
        break;
    }
  }

  private getHtmlContent(): string {
    const webview = this.panel.webview;
    const webviewDistUri = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');

    // In development, point to local files; in production, use bundled assets
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDistUri, 'index.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDistUri, 'index.css'));

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}' 'unsafe-eval';
    img-src ${webview.cspSource} data: https:;
    font-src ${webview.cspSource};
    connect-src http://127.0.0.1:* ws://127.0.0.1:* https://micropython.org;
  ">
  <link rel="stylesheet" href="${styleUri}">
  <title>Velxio Simulator</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    SimulatorPanel.instance = undefined;
    this._onSerialOutput.dispose();
    this._onSimulationState.dispose();
    this._onReady.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/**
 * BackendManager — Spawns and manages the Velxio FastAPI backend process.
 *
 * The backend provides:
 * - /api/compile — Arduino sketch compilation via arduino-cli
 * - /api/simulation/ws — WebSocket bridge to QEMU for ESP32 simulation
 *
 * AVR/RP2040 boards don't need the backend (simulation runs in the WebView).
 */

import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';

export class BackendManager {
  private process: ChildProcess | null = null;
  private _port = 0;
  private _ready = false;
  private outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  get port(): number { return this._port; }
  get ready(): boolean { return this._ready; }
  get apiBase(): string { return `http://localhost:${this._port}/api`; }

  /** Start the backend on a free port. Returns the port number. */
  async start(): Promise<number> {
    if (this.process && this._ready) return this._port;

    this._port = await this.findFreePort();
    const configPort = vscode.workspace.getConfiguration('velxio').get<number>('backendPort');
    if (configPort && configPort > 0) {
      this._port = configPort;
    }

    // Find the backend directory
    const backendDir = await this.findBackendDir();
    if (!backendDir) {
      throw new Error('Velxio backend not found. Please install the Velxio backend or set the path in settings.');
    }

    this.outputChannel.appendLine(`[Backend] Starting on port ${this._port}...`);
    this.outputChannel.appendLine(`[Backend] Directory: ${backendDir}`);

    // Spawn uvicorn
    const python = this.findPython(backendDir);
    this.process = spawn(python, [
      '-m', 'uvicorn',
      'app.main:app',
      '--port', String(this._port),
      '--host', '127.0.0.1',
    ], {
      cwd: backendDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    this.process.stdout?.on('data', (data) => {
      this.outputChannel.appendLine(`[Backend] ${data.toString().trim()}`);
    });

    this.process.stderr?.on('data', (data) => {
      this.outputChannel.appendLine(`[Backend] ${data.toString().trim()}`);
    });

    this.process.on('exit', (code) => {
      this.outputChannel.appendLine(`[Backend] Process exited (code=${code})`);
      this._ready = false;
      this.process = null;
    });

    // Wait for the server to be ready
    await this.waitForReady();
    this._ready = true;
    this.outputChannel.appendLine(`[Backend] Ready at ${this.apiBase}`);
    return this._port;
  }

  /** Stop the backend process */
  async stop(): Promise<void> {
    if (!this.process) return;

    this.outputChannel.appendLine('[Backend] Stopping...');
    this.process.kill('SIGTERM');

    // Give it 3 seconds to shut down gracefully
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.process?.kill('SIGKILL');
        resolve();
      }, 3000);

      this.process?.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.process = null;
    this._ready = false;
  }

  /** Find the backend directory (relative to extension or workspace) */
  private async findBackendDir(): Promise<string | null> {
    // 1. Check relative to the extension (monorepo layout)
    const extensionDir = path.resolve(__dirname, '..');
    const monorepoBackend = path.resolve(extensionDir, '..', 'backend');
    if (fs.existsSync(path.join(monorepoBackend, 'app', 'main.py'))) {
      return monorepoBackend;
    }

    // 2. Check workspace folders
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const wsBackend = path.join(folder.uri.fsPath, 'backend');
      if (fs.existsSync(path.join(wsBackend, 'app', 'main.py'))) {
        return wsBackend;
      }
    }

    return null;
  }

  /** Find the correct Python executable (venv or system) */
  private findPython(backendDir: string): string {
    // Check for venv
    const venvPaths = [
      path.join(backendDir, 'venv', 'Scripts', 'python.exe'),  // Windows
      path.join(backendDir, 'venv', 'bin', 'python'),          // Unix
      path.join(backendDir, '.venv', 'Scripts', 'python.exe'),
      path.join(backendDir, '.venv', 'bin', 'python'),
    ];

    for (const p of venvPaths) {
      if (fs.existsSync(p)) return p;
    }

    return 'python';
  }

  /** Find a free TCP port */
  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address() as net.AddressInfo;
        srv.close(() => resolve(addr.port));
      });
      srv.on('error', reject);
    });
  }

  /** Wait for the backend health endpoint to respond */
  private async waitForReady(maxRetries = 30): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${this._port}/docs`);
        if (response.ok) return;
      } catch {
        // Not ready yet
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`Backend failed to start after ${maxRetries} seconds`);
  }
}

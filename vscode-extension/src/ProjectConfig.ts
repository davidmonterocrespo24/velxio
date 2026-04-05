/**
 * ProjectConfig — Reads velxio.toml and diagram.json from the workspace.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import TOML from '@iarna/toml';
import type { VelxioConfig, DiagramJson, BoardKind } from './types';

export class ProjectConfig {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /** Read and parse velxio.toml from the workspace root */
  readVelxioToml(): VelxioConfig | null {
    const tomlPath = path.join(this.workspaceRoot, 'velxio.toml');
    if (!fs.existsSync(tomlPath)) return null;

    try {
      const content = fs.readFileSync(tomlPath, 'utf-8');
      const parsed = TOML.parse(content) as unknown as VelxioConfig;
      return parsed;
    } catch (err) {
      vscode.window.showWarningMessage(`Failed to parse velxio.toml: ${err}`);
      return null;
    }
  }

  /** Read and parse diagram.json from the workspace root */
  readDiagramJson(): DiagramJson | null {
    const jsonPath = path.join(this.workspaceRoot, 'diagram.json');
    if (!fs.existsSync(jsonPath)) return null;

    try {
      const content = fs.readFileSync(jsonPath, 'utf-8');
      return JSON.parse(content) as DiagramJson;
    } catch (err) {
      vscode.window.showWarningMessage(`Failed to parse diagram.json: ${err}`);
      return null;
    }
  }

  /** Resolve the board kind from config or settings */
  getBoard(): BoardKind {
    const config = this.readVelxioToml();
    if (config?.velxio?.board) {
      return config.velxio.board as BoardKind;
    }
    return vscode.workspace.getConfiguration('velxio').get<BoardKind>('defaultBoard') ?? 'arduino-uno';
  }

  /** Get the language mode (arduino or micropython) */
  getLanguageMode(): 'arduino' | 'micropython' {
    const config = this.readVelxioToml();
    return config?.velxio?.language ?? 'arduino';
  }

  /** Get the pre-compiled firmware path (if specified) */
  getFirmwarePath(): string | null {
    const config = this.readVelxioToml();
    if (!config?.velxio?.firmware) return null;
    return path.resolve(this.workspaceRoot, config.velxio.firmware);
  }

  /** Collect all sketch files (.ino, .h, .cpp, .py) from the workspace */
  async getSketchFiles(): Promise<Array<{ name: string; content: string }>> {
    const language = this.getLanguageMode();
    const pattern = language === 'micropython' ? '**/*.py' : '**/*.{ino,h,cpp,c}';
    const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
    const files: Array<{ name: string; content: string }> = [];

    for (const uri of uris) {
      const relativePath = path.relative(this.workspaceRoot, uri.fsPath);
      const content = fs.readFileSync(uri.fsPath, 'utf-8');
      files.push({ name: relativePath, content });
    }

    return files;
  }

  /** Create a default velxio.toml in the workspace */
  async createDefaultConfig(board: BoardKind): Promise<void> {
    const tomlPath = path.join(this.workspaceRoot, 'velxio.toml');
    const content = `[velxio]\nversion = 1\nboard = "${board}"\n`;
    fs.writeFileSync(tomlPath, content, 'utf-8');
  }
}

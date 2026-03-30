/**
 * FileWatcher — Watches sketch files for changes and triggers recompilation.
 */

import * as vscode from 'vscode';

export class FileWatcher {
  private watcher: vscode.FileSystemWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private _onChange = new vscode.EventEmitter<vscode.Uri>();

  /** Fired when a sketch file changes (debounced by 500ms) */
  public readonly onChange = this._onChange.event;

  /** Start watching sketch files */
  start(): void {
    if (this.watcher) return;

    this.watcher = vscode.workspace.createFileSystemWatcher(
      '**/*.{ino,h,cpp,c,py}',
      false, // creations
      false, // changes
      false, // deletions
    );

    const debouncedFire = (uri: vscode.Uri) => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this._onChange.fire(uri), 500);
    };

    this.watcher.onDidChange(debouncedFire);
    this.watcher.onDidCreate(debouncedFire);
    this.watcher.onDidDelete(debouncedFire);
  }

  /** Stop watching */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.watcher?.dispose();
    this.watcher = null;
  }

  dispose(): void {
    this.stop();
    this._onChange.dispose();
  }
}

/**
 * SerialTerminal — VS Code pseudo-terminal for simulation serial I/O.
 *
 * Provides a native VS Code terminal that displays serial output from the
 * running simulation and sends user input back to the simulated UART.
 */

import * as vscode from 'vscode';

export class SerialTerminal {
  private terminal: vscode.Terminal | null = null;
  private writeEmitter = new vscode.EventEmitter<string>();
  private closeEmitter = new vscode.EventEmitter<number | void>();
  private _onInput = new vscode.EventEmitter<string>();

  /** Fired when the user types in the terminal */
  public readonly onInput = this._onInput.event;

  /** Create and show the serial terminal */
  open(boardName: string): void {
    if (this.terminal) {
      this.terminal.show();
      return;
    }

    const pty: vscode.Pseudoterminal = {
      onDidWrite: this.writeEmitter.event,
      onDidClose: this.closeEmitter.event,
      open: () => {
        this.writeEmitter.fire(`\x1b[36m--- Velxio Serial Monitor (${boardName}) ---\x1b[0m\r\n`);
      },
      close: () => {
        this.terminal = null;
      },
      handleInput: (data: string) => {
        this._onInput.fire(data);
        // Echo input in a dim color
        this.writeEmitter.fire(`\x1b[90m${data}\x1b[0m`);
      },
    };

    this.terminal = vscode.window.createTerminal({
      name: `Velxio Serial (${boardName})`,
      pty,
      iconPath: new vscode.ThemeIcon('circuit-board'),
    });
    this.terminal.show(true); // preserve focus
  }

  /** Write serial output to the terminal */
  write(text: string): void {
    if (!this.terminal) return;
    // Convert \n to \r\n for terminal display
    this.writeEmitter.fire(text.replace(/\n/g, '\r\n'));
  }

  /** Clear the terminal */
  clear(): void {
    this.writeEmitter.fire('\x1b[2J\x1b[H'); // ANSI clear + home
  }

  /** Close the terminal */
  close(): void {
    if (this.terminal) {
      this.closeEmitter.fire();
      this.terminal.dispose();
      this.terminal = null;
    }
  }

  dispose(): void {
    this.close();
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
    this._onInput.dispose();
  }
}

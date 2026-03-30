/**
 * WebView ↔ Extension bridge
 *
 * Receives messages from the VS Code extension host and translates them
 * into simulation actions. Sends simulation events back to the extension.
 */

// @ts-expect-error — acquireVsCodeApi is injected by VS Code's webview runtime
const vscode = acquireVsCodeApi();

export type ToWebviewMessage =
  | { type: 'loadHex'; hex: string; board: string }
  | { type: 'loadBinary'; firmwareBase64: string; board: string }
  | { type: 'loadMicroPython'; files: Array<{ name: string; content: string }>; board: string }
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'serialInput'; text: string }
  | { type: 'setBoard'; board: string }
  | { type: 'setDiagram'; diagram: unknown }
  | { type: 'setApiBase'; apiBase: string };

type MessageHandler = (msg: ToWebviewMessage) => void;
const handlers: MessageHandler[] = [];

/** Register a handler for messages from the extension */
export function onMessage(handler: MessageHandler): void {
  handlers.push(handler);
}

/** Send a message to the extension host */
export function postToExtension(message: unknown): void {
  vscode.postMessage(message);
}

/** Notify the extension that the WebView is ready */
export function notifyReady(): void {
  postToExtension({ type: 'ready' });
}

/** Send serial output to the extension */
export function sendSerialOutput(text: string): void {
  postToExtension({ type: 'serialOutput', text });
}

/** Send simulation state change to the extension */
export function sendSimulationState(running: boolean): void {
  postToExtension({ type: 'simulationState', running });
}

/** Send an error to the extension */
export function sendError(message: string): void {
  postToExtension({ type: 'error', message });
}

// Listen for messages from the extension host
window.addEventListener('message', (event) => {
  const msg = event.data as ToWebviewMessage;
  for (const handler of handlers) {
    handler(msg);
  }
});

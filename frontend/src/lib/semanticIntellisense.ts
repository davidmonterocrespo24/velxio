import type { CancellationToken, Position } from 'monaco-editor';
import { getApiBase } from './apiBase';
import { fqbnForLanguage, type BoardInstance } from '../types/board';
import type { WorkspaceFile } from '../store/useEditorStore';

export type SemanticEngine = 'arduino' | 'micropython' | 'espidf';
type Method = 'completion' | 'hover' | 'signatureHelp' | 'definition';

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface SemanticDiagnostic {
  message: string;
  severity?: number;
  range: LspRange;
}

export interface SemanticContext {
  engine: SemanticEngine;
  board: string;
  libraries?: string[];
}

export function semanticContext(board: BoardInstance | undefined): SemanticContext | null {
  if (!board) return null;
  if (board.languageMode === 'micropython') {
    return { engine: 'micropython', board: board.boardKind };
  }
  const fqbn = fqbnForLanguage(board.boardKind, board.languageMode);
  if (board.languageMode === 'espidf') return fqbn ? { engine: 'espidf', board: fqbn } : null;
  return fqbn?.startsWith('arduino:avr:')
    ? { engine: 'arduino', board: fqbn, libraries: board.libraries }
    : null;
}

export function semanticFile(file: WorkspaceFile, engine: SemanticEngine) {
  if (engine === 'micropython') return /\.pyi?$/i.test(file.name);
  if (engine === 'arduino' && /\.ino$/i.test(file.name)) return true;
  return /\.(?:c|cpp|cc|cxx|h|hh|hpp|hxx)$/i.test(file.name);
}

type Capabilities = Partial<Record<SemanticEngine, string[]>>;
let capabilities: { base: string; expires: number; data: Promise<Capabilities> } | null = null;

function supported(context: SemanticContext) {
  const base = getApiBase();
  if (!capabilities || capabilities.base !== base || Date.now() >= capabilities.expires) {
    capabilities = {
      base,
      expires: Date.now() + 30_000,
      data: fetch(base + '/intellisense/semantic/capabilities', {
        signal: AbortSignal.timeout(3500),
      })
        .then((response) => (response.ok ? (response.json() as Promise<Capabilities>) : {}))
        .catch(() => ({})),
    };
  }
  return capabilities.data.then((data) => Boolean(data[context.engine]?.includes(context.board)));
}

type Message =
  | { type: 'ready' }
  | { type: 'result'; id: number; result: unknown }
  | { type: 'diagnostics'; name: string; version?: number | null; items: SemanticDiagnostic[] };

export class SemanticSession {
  private socket: WebSocket | null = null;
  private closed = false;
  private connecting = false;
  private retryAfter = 0;
  private nextId = 0;
  private ready = false;
  private documents = new Map<string, { text: string; version: number }>();
  private files = new Map<string, string>();
  private pending = new Map<number, (result: unknown) => void>();
  private diagnostics = new Map<string, SemanticDiagnostic[]>();
  private listeners = new Set<() => void>();
  private context: SemanticContext;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(context: SemanticContext, files: WorkspaceFile[]) {
    this.context = context;
    this.update(files);
    void this.connect();
  }

  private async connect() {
    if (this.closed || this.connecting || this.socket || Date.now() < this.retryAfter) return;
    this.connecting = true;
    this.retryAfter = Date.now() + 10_000;
    try {
      if (!(await supported(this.context)) || this.closed) return;
      const endpoint = new URL(getApiBase() + '/intellisense/semantic/ws', location.href);
      endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(endpoint);
      this.socket = socket;
      socket.onopen = () => {
        this.documents = new Map(
          [...this.files].map(([name, text]) => [name, { text, version: 1 }]),
        );
        this.send({
          ...this.context,
          files: [...this.files].map(([name, content]) => ({ name, content })),
        });
      };
      socket.onmessage = ({ data }) => this.receive(JSON.parse(data) as Message);
      socket.onclose = () => {
        this.socket = null;
        this.ready = false;
        this.diagnostics.clear();
        this.notify();
        for (const resolve of this.pending.values()) resolve(null);
        this.pending.clear();
      };
    } catch {
      // Symbol suggestions remain available when the optional server is down.
    } finally {
      this.connecting = false;
    }
  }

  private receive(message: Message) {
    if (this.closed) return;
    if (message.type === 'ready') {
      this.ready = true;
      this.flush();
    } else if (message.type === 'result') {
      this.pending.get(message.id)?.(message.result);
    } else {
      const document = this.documents.get(message.name);
      if (
        !document ||
        document.text !== this.files.get(message.name) ||
        (message.version != null && message.version !== document.version)
      )
        return;
      this.diagnostics.set(message.name, message.items);
      this.notify();
    }
  }

  private send(message: object) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private flush() {
    clearTimeout(this.flushTimer);
    if (!this.ready) return;
    for (const [name, text] of this.files) {
      const document = this.documents.get(name);
      if (!document || document.text === text) continue;
      document.text = text;
      document.version += 1;
      this.send({ type: 'change', name, text, version: document.version });
    }
  }

  update(files: WorkspaceFile[]) {
    let changed = false;
    for (const { name, content } of files) {
      if (this.files.get(name) === content) continue;
      this.files.set(name, content);
      changed = true;
    }
    if (!changed) return;
    // An edit in a header can invalidate diagnostics in any translation unit.
    this.diagnostics.clear();
    this.notify();
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), 120);
  }

  async request<T>(
    method: Method,
    name: string,
    position: Position,
    token: CancellationToken,
    context?: { triggerKind: number; triggerCharacter?: string },
  ) {
    if (!this.ready || !this.files.has(name)) {
      void this.connect();
      return null;
    }
    if (token.isCancellationRequested) return null;
    this.flush();
    const id = ++this.nextId;
    return new Promise<T | null>((resolve) => {
      const finish = (value: unknown) => {
        clearTimeout(timer);
        cancellation.dispose();
        this.pending.delete(id);
        resolve(value as T | null);
      };
      const cancel = () => {
        this.send({ type: 'cancel', id });
        finish(null);
      };
      const timer = setTimeout(cancel, 4000);
      const cancellation = token.onCancellationRequested(cancel);
      this.pending.set(id, finish);
      this.send({
        type: 'request',
        id,
        method,
        name,
        context,
        position: {
          line: position.lineNumber - 1,
          character: position.column - 1,
        },
      });
    });
  }

  getDiagnostics(name: string, content: string) {
    return this.files.get(name) === content ? (this.diagnostics.get(name) ?? []) : [];
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose() {
    this.closed = true;
    this.ready = false;
    clearTimeout(this.flushTimer);
    this.socket?.close();
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
    this.listeners.clear();
  }
}

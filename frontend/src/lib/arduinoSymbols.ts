import type { Monaco } from '@monaco-editor/react';
import type { CancellationToken, Position, editor, languages } from 'monaco-editor';
import { getApiBase } from './apiBase';
import { ARDUINO_LIBRARIES_CHANGED } from '../services/libraryService';
import { fqbnForLanguage, type BoardInstance } from '../types/board';

interface Library {
  name: string;
  version: string;
  headers: string[];
  architectures?: string[];
}

interface SymbolInfo {
  name: string;
  kind: string;
  owner?: string;
  signature?: string;
  detail?: string;
  doc?: string;
  insertText?: string;
  inheritedFrom?: string;
}

interface SymbolTable {
  symbols: SymbolInfo[];
}

// Arduino CLI adds Arduino.h to .ino sketches. Keep the common AVR APIs
// available even before the sketch includes a library or the host connects.
const coreFunctions: [name: string, signature: string, doc: string][] = [
  [
    'pinMode',
    'void pinMode(uint8_t pin, uint8_t mode)',
    'Configure a digital pin as an input or output.',
  ],
  ['digitalRead', 'int digitalRead(uint8_t pin)', 'Read HIGH or LOW from a digital pin.'],
  [
    'digitalWrite',
    'void digitalWrite(uint8_t pin, uint8_t value)',
    'Set a digital output to HIGH or LOW.',
  ],
  ['analogRead', 'int analogRead(uint8_t pin)', 'Read the value at an analog input pin.'],
  [
    'analogWrite',
    'void analogWrite(uint8_t pin, int value)',
    'Set the duty cycle on a PWM-capable pin.',
  ],
  [
    'delay',
    'void delay(unsigned long ms)',
    'Pause the sketch for the specified number of milliseconds.',
  ],
  [
    'delayMicroseconds',
    'void delayMicroseconds(unsigned int us)',
    'Pause the sketch for the specified number of microseconds.',
  ],
  ['millis', 'unsigned long millis()', 'Return the elapsed milliseconds since the sketch started.'],
  ['micros', 'unsigned long micros()', 'Return the elapsed microseconds since the sketch started.'],
  [
    'tone',
    'void tone(uint8_t pin, unsigned int frequency, unsigned long duration = 0)',
    'Generate a square wave on a pin.',
  ],
  ['noTone', 'void noTone(uint8_t pin)', 'Stop the tone on a pin.'],
];

const coreSymbols: SymbolInfo[] = [
  ...coreFunctions.map(([name, signature, doc]) => ({
    name,
    signature,
    doc,
    kind: 'function',
    detail: 'Arduino core',
  })),
  ...['HIGH', 'LOW', 'INPUT', 'OUTPUT', 'INPUT_PULLUP', 'LED_BUILTIN'].map((name) => ({
    name,
    kind: 'constant',
    detail: 'Arduino core',
  })),
];

const serialMethods: [name: string, signature: string, doc: string][] = [
  [
    'begin',
    'void begin(unsigned long baud)',
    'Start serial communication at the selected baud rate.',
  ],
  ['end', 'void end()', 'Stop serial communication.'],
  ['available', 'int available()', 'Return the number of received bytes waiting to be read.'],
  ['read', 'int read()', 'Read the next received byte, or return -1 if none is available.'],
  ['print', 'size_t print(value)', 'Write a value as text.'],
  ['println', 'size_t println(value)', 'Write a value as text followed by a line break.'],
  ['write', 'size_t write(uint8_t byte)', 'Send a byte without converting it to text.'],
];

const serialSymbols: SymbolInfo[] = serialMethods.map(([name, signature, doc]) => ({
  name,
  signature,
  doc,
  kind: 'method',
  detail: 'Arduino HardwareSerial',
}));

const cache = new Map<string, Promise<unknown>>();
let libraryRevision = 0;

export function getLibraryRevision() {
  return libraryRevision;
}

export function subscribeLibraryRevision(listener: () => void) {
  window.addEventListener(ARDUINO_LIBRARIES_CHANGED, listener);
  window.addEventListener('velxio-custom-library-installed', listener);
  return () => {
    window.removeEventListener(ARDUINO_LIBRARIES_CHANGED, listener);
    window.removeEventListener('velxio-custom-library-installed', listener);
  };
}

if (typeof window !== 'undefined') {
  subscribeLibraryRevision(() => {
    libraryRevision += 1;
    cache.clear();
  });
}

function get<T>(path: string): Promise<T | null> {
  const url = `${getApiBase()}/intellisense/${path}`;
  const existing = cache.get(url) as Promise<T | null> | undefined;
  if (existing) return existing;
  const request = fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
    .then((response) => (response.ok ? (response.json() as Promise<T>) : null))
    .catch(() => null);
  cache.set(url, request);
  void request.then((result) => {
    if (!result && cache.get(url) === request) cache.delete(url);
  });
  return request;
}

const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const specFor = (lib: Library) => (lib.version ? `${lib.name}@${lib.version}` : lib.name);

export function supportsArduinoSymbols(board: BoardInstance) {
  return (
    (board.languageMode === undefined || board.languageMode === 'arduino') &&
    !!fqbnForLanguage(board.boardKind, board.languageMode)
  );
}

async function librariesFor(board: BoardInstance) {
  const architecture = fqbnForLanguage(board.boardKind, board.languageMode)?.split(':')[1];
  const catalog = await get<{ libraries: Library[] }>('catalog');
  const selected = new Set(board.libraries?.map((spec) => normalize(spec.split('@')[0])) ?? []);
  const pins = new Set(board.libraries?.map((spec) => spec.toLowerCase()) ?? []);
  const result = new Map<string, Library>();
  for (const lib of catalog?.libraries ?? []) {
    if (
      lib.architectures?.length &&
      !lib.architectures.some((arch) => arch === '*' || arch === architecture)
    ) {
      continue;
    }
    const key = normalize(lib.name);
    if (selected.size > 0 && !selected.has(key)) continue;
    const prior = result.get(key);
    if (
      !prior ||
      pins.has(specFor(lib).toLowerCase()) ||
      (!pins.has(specFor(prior).toLowerCase()) &&
        lib.version.localeCompare(prior.version, undefined, { numeric: true }) > 0)
    ) {
      result.set(key, lib);
    }
  }
  return [...result.values()];
}

function includedHeaders(text: string) {
  return new Set(
    [...text.matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm)].map((match) => match[1]),
  );
}

export function includePathPrefix(linePrefix: string): string | undefined {
  return /^\s*#\s*include\s*[<"]([^>"]*)$/.exec(linePrefix)?.[1];
}

async function tablesFor(headers: Set<string>, libraries: Library[]) {
  const included = libraries.filter((lib) => lib.headers.some((header) => headers.has(header)));
  return Promise.all(
    included.map(async (library) => ({
      library,
      symbols:
        (await get<SymbolTable>(`symbols/${encodeURIComponent(specFor(library))}`))?.symbols ?? [],
    })),
  );
}

function receiverType(text: string, receiver: string, classes: Set<string>) {
  const declarations = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const pattern = new RegExp(
    `\\b([A-Za-z_]\\w*)\\s*(?:[*&]\\s*)?${receiver}\\b(?=\\s*[({=;,)\\[])`,
    'g',
  );
  const found = [...declarations.matchAll(pattern)].at(-1)?.[1];
  return found && classes.has(found) ? found : undefined;
}

async function symbolsAt(
  text: string,
  before: string,
  context: string,
  board: BoardInstance,
  token: CancellationToken,
  localOnly = false,
) {
  if (token.isCancellationRequested) return [];
  const member = /\b([A-Za-z_]\w*)\s*(\.|->|::)\s*\w*$/.exec(context);
  const serialPorts =
    board.boardKind === 'arduino-mega' ? ['Serial', 'Serial1', 'Serial2', 'Serial3'] : ['Serial'];
  if (member?.[2] === '.' && serialPorts.includes(member[1])) return serialSymbols;

  const headers = includedHeaders(text);
  headers.delete('Arduino.h');
  const libraries = !localOnly && headers.size > 0 ? await librariesFor(board) : [];
  if (token.isCancellationRequested) return [];
  const tables = await tablesFor(headers, libraries);
  if (token.isCancellationRequested) return [];
  if (!member) {
    const ports = serialPorts.map<SymbolInfo>((name) => ({
      name,
      kind: 'variable',
      signature: 'HardwareSerial ' + name,
      detail: 'Arduino core',
    }));
    return [
      ...coreSymbols,
      ...ports,
      ...tables.flatMap(({ symbols }) => symbols.filter((item) => !item.owner)),
    ];
  }

  const classes = new Set(
    tables.flatMap(({ symbols }) =>
      symbols.filter(({ kind }) => kind === 'class').map(({ name }) => name),
    ),
  );
  const type = member[2] === '::' ? member[1] : receiverType(before, member[1], classes);
  if (!type) return [];
  const owner = tables.find(({ symbols }) =>
    symbols.some((item) => item.name === type || item.owner === type),
  );
  if (!owner) return [];
  const own = owner.symbols.filter((item) => item.owner === type);
  const payload = await get<SymbolTable>(
    `type/${encodeURIComponent(type)}?library=${encodeURIComponent(specFor(owner.library))}`,
  );
  return payload?.symbols.length ? payload.symbols : own;
}

export async function arduinoCompletions(
  monaco: Monaco,
  model: editor.ITextModel,
  position: Position,
  board: BoardInstance,
  localHeaders: string[],
  token: CancellationToken,
  localOnly = false,
): Promise<languages.CompletionItem[]> {
  const prefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
  const header = includePathPrefix(prefix);
  if (token.isCancellationRequested) return [];
  if (header !== undefined) {
    const libraries = localOnly ? [] : await librariesFor(board);
    if (token.isCancellationRequested) return [];
    const start = position.column - header.length;
    const range = new monaco.Range(
      position.lineNumber,
      start,
      position.lineNumber,
      position.column,
    );
    const headers = [
      'Arduino.h',
      'Wire.h',
      'SPI.h',
      'EEPROM.h',
      ...localHeaders,
      ...libraries.flatMap((lib) => lib.headers),
    ];
    return [...new Set(headers)].map((name) => ({
      label: name,
      insertText: name,
      range,
      kind: monaco.languages.CompletionItemKind.File,
    }));
  }

  const text = model.getValue();
  const word = model.getWordUntilPosition(position);
  const range = new monaco.Range(
    position.lineNumber,
    word.startColumn,
    position.lineNumber,
    word.endColumn,
  );
  const kinds: Record<string, languages.CompletionItemKind> = {
    class: monaco.languages.CompletionItemKind.Class,
    function: monaco.languages.CompletionItemKind.Function,
    method: monaco.languages.CompletionItemKind.Method,
    constant: monaco.languages.CompletionItemKind.Constant,
    field: monaco.languages.CompletionItemKind.Field,
    enum: monaco.languages.CompletionItemKind.Enum,
  };
  const items = await symbolsAt(
    text,
    text.slice(0, model.getOffsetAt(position)),
    prefix,
    board,
    token,
    localOnly,
  );
  return [...new Map(items.map((item) => [item.name, item])).values()].map((item) => ({
    label: item.name,
    kind: kinds[item.kind] ?? monaco.languages.CompletionItemKind.Variable,
    insertText: item.insertText?.includes('$') ? item.name : (item.insertText ?? item.name),
    detail: item.signature ?? item.detail,
    documentation: item.doc,
    range,
  }));
}

export async function arduinoHover(
  monaco: Monaco,
  model: editor.ITextModel,
  position: Position,
  board: BoardInstance,
  token: CancellationToken,
): Promise<languages.Hover | null> {
  const word = model.getWordAtPosition(position);
  if (!word) return null;
  const text = model.getValue();
  const prefix = model.getLineContent(position.lineNumber).slice(0, word.endColumn - 1);
  const items = await symbolsAt(
    text,
    text.slice(0, model.getOffsetAt(position)),
    prefix,
    board,
    token,
  );
  const item = items.find(({ name }) => name === word.word);
  if (!item) return null;
  const contents = [{ value: `\`\`\`cpp\n${item.signature ?? item.name}\n\`\`\`` }];
  if (item.detail) contents.push({ value: item.detail });
  if (item.doc) contents.push({ value: item.doc });
  return {
    contents,
    range: new monaco.Range(
      position.lineNumber,
      word.startColumn,
      position.lineNumber,
      word.endColumn,
    ),
  };
}

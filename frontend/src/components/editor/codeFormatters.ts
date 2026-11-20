/**
 * codeFormatters — "Format document" for the code editor.
 *
 * Monaco only ships formatters for JSON, HTML, CSS and TypeScript. The
 * languages a sketch is written in (C/C++ for Arduino and ESP-IDF, Python for
 * MicroPython) had none, so "Format Document" was missing from the editor's
 * context menu and Shift+Alt+F did nothing. This registers a document
 * formatting provider for each:
 *
 *   cpp     clang-format (WebAssembly build of the real tool), configured
 *           with the Arduino IDE 2 style so a sketch formatted here comes
 *           out the way the IDE would format it: 2-space indent, braces on
 *           the same line, no column limit (long lines are left alone).
 *   python  ruff's formatter (WebAssembly), Black-compatible. MicroPython is
 *           plain Python syntax, so the same rules apply.
 *
 * Both engines are a few MB of wasm and load on first use only, never at
 * page load. Once a provider exists Monaco itself puts "Format Document" in
 * the right-click menu and binds Shift+Alt+F; the Edit menu reaches the same
 * action through the `edit.formatDocument` editor command (CodeEditor
 * registers it while a formattable file is open).
 *
 * The providers return the minimal set of changed line ranges rather than
 * one whole-document replacement: Monaco tracks the cursor, selection,
 * markers and scroll position through edits, so a full replace would throw
 * the caret to the end of the file on every format.
 */
import type * as Monaco from 'monaco-editor';
import { showMessageDialog } from '../../store/useMessageDialogStore';

/** Monaco language ids this module can format. */
export type FormatterLanguage = 'cpp' | 'python';

/**
 * Languages the "Format document" menu row should be enabled for. JSON is
 * formatted by Monaco's own worker (chip.json manifests), the two below by
 * the providers registered here. Everything else (plaintext, markdown, the
 * retro assembler) has no formatter and the row stays disabled.
 */
const FORMATTABLE = new Set<string>(['cpp', 'python', 'json']);

export function hasDocumentFormatter(languageId: string): boolean {
  return FORMATTABLE.has(languageId);
}

/**
 * The Arduino IDE 2 formatter configuration, trimmed to the options that
 * matter for C/C++ (the upstream file also carries Java/ObjC/Qt settings).
 * Source: arduino/tooling-project-assets, other/clang-format-configuration.
 * Deliberately NOT a preset name: the presets all wrap at 80 columns and
 * reflow comments, which rewrites far more of a beginner's sketch than they
 * asked for.
 */
export const ARDUINO_CLANG_FORMAT_STYLE = {
  BasedOnStyle: 'LLVM',
  Language: 'Cpp',
  Standard: 'Auto',
  IndentWidth: 2,
  TabWidth: 2,
  UseTab: 'Never',
  ColumnLimit: 0,
  ContinuationIndentWidth: 2,
  ConstructorInitializerIndentWidth: 2,
  AccessModifierOffset: -2,
  BreakBeforeBraces: 'Attach',
  AllowShortBlocksOnASingleLine: 'Always',
  AllowShortCaseLabelsOnASingleLine: true,
  AllowShortEnumsOnASingleLine: true,
  AllowShortFunctionsOnASingleLine: 'Empty',
  AllowShortIfStatementsOnASingleLine: 'AllIfsAndElse',
  AllowShortLambdasOnASingleLine: 'Empty',
  AllowShortLoopsOnASingleLine: true,
  AlignTrailingComments: true,
  AlignAfterOpenBracket: 'Align',
  AlignOperands: 'Align',
  AlignEscapedNewlines: 'DontAlign',
  BinPackArguments: true,
  BinPackParameters: true,
  BreakBeforeBinaryOperators: 'NonAssignment',
  BreakBeforeTernaryOperators: true,
  BreakStringLiterals: false,
  Cpp11BracedListStyle: false,
  DerivePointerAlignment: true,
  PointerAlignment: 'Right',
  IndentCaseLabels: true,
  IndentCaseBlocks: true,
  IndentPPDirectives: 'None',
  KeepEmptyLinesAtTheStartOfBlocks: true,
  MaxEmptyLinesToKeep: 100000,
  ReflowComments: false,
  SortIncludes: 'Never',
  IncludeBlocks: 'Preserve',
  FixNamespaceComments: false,
  NamespaceIndentation: 'None',
  SpaceBeforeParens: 'ControlStatements',
  SpacesBeforeTrailingComments: 2,
  SpaceAfterCStyleCast: false,
  SpaceInEmptyBlock: false,
  SpacesInAngles: 'Leave',
  // Keep the file's own line endings (CRLF sketches from Windows stay CRLF).
  LineEnding: 'DeriveLF',
} as const;

/** ruff defaults, except quotes: a maker's `'single'` strings stay as typed. */
export const PYTHON_FORMAT_CONFIG = {
  indent_style: 'space',
  indent_width: 4,
  line_width: 88,
  quote_style: 'preserve',
  magic_trailing_comma: 'respect',
} as const;

interface FormatIndentation {
  insertSpaces: boolean;
  indentSize: number;
  tabSize: number;
}

type FormatFn = (
  source: string,
  filename: string,
  eol: '\n' | '\r\n',
  indentation?: FormatIndentation,
) => string;

// Each engine is loaded once per page and memoised as a promise so that a
// burst of format requests shares one download. A failed load is forgotten
// so the next attempt retries instead of replaying the same rejection.
const engines: Partial<Record<FormatterLanguage, Promise<FormatFn>>> = {};

async function loadEngine(language: FormatterLanguage): Promise<FormatFn> {
  let p = engines[language];
  if (!p) {
    p = (language === 'cpp' ? loadClangFormat() : loadRuff()).catch((err) => {
      delete engines[language];
      throw err;
    });
    engines[language] = p;
  }
  return p;
}

async function loadClangFormat(): Promise<FormatFn> {
  const mod = await import('@wasm-fmt/clang-format/vite');
  await mod.default();
  return (source, filename, _eol, indentation) => {
    const style = indentation
      ? {
          ...ARDUINO_CLANG_FORMAT_STYLE,
          IndentWidth: indentation.indentSize,
          TabWidth: indentation.tabSize,
          ContinuationIndentWidth: indentation.indentSize,
          ConstructorInitializerIndentWidth: indentation.indentSize,
          AccessModifierOffset: -indentation.indentSize,
          UseTab: indentation.insertSpaces ? 'Never' : 'ForIndentation',
        }
      : ARDUINO_CLANG_FORMAT_STYLE;
    return mod.format(source, filename, JSON.stringify(style));
  };
}

async function loadRuff(): Promise<FormatFn> {
  const mod = await import('@wasm-fmt/ruff_fmt/vite');
  await mod.default();
  return (source, filename, eol, indentation) =>
    mod.format(source, filename, {
      ...PYTHON_FORMAT_CONFIG,
      ...(indentation && {
        indent_style: indentation.insertSpaces ? 'space' : 'tab',
        indent_width: indentation.indentSize,
      }),
      line_ending: eol === '\r\n' ? 'crlf' : 'lf',
    });
}

/**
 * clang-format picks the language from the extension. `.ino` is unknown to
 * it and falls back to C++ (which is what an Arduino sketch is), but be
 * explicit so a rename of the mapping upstream cannot silently turn sketches
 * into C. Headers are formatted as C++ too: that is what Arduino compiles
 * them as.
 */
export function formatterFilename(language: FormatterLanguage, filename: string): string {
  if (language === 'python') return filename.endsWith('.py') ? filename : 'main.py';
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'c') return filename;
  return ext && ['cpp', 'cc', 'cxx', 'h', 'hpp', 'hh'].includes(ext) ? filename : 'sketch.cpp';
}

/**
 * Format a whole source text. Resolves to the formatted text; rejects with
 * the engine's error (ruff refuses code it cannot parse, clang-format
 * formats anything it is given).
 */
export async function formatSource(
  language: FormatterLanguage,
  filename: string,
  source: string,
  eol: '\n' | '\r\n' = '\n',
  indentation?: FormatIndentation,
): Promise<string> {
  const format = await loadEngine(language);
  return format(source, formatterFilename(language, filename), eol, indentation);
}

/** Half-open line ranges: replace old[aStart, aEnd) with new[bStart, bEnd). */
export interface LineHunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

// Above this many cells the LCS table is not worth its memory; one hunk
// covering everything between the common prefix and suffix is still a
// correct edit, it just moves the caret if it sat inside that region.
const MAX_LCS_CELLS = 4_000_000;

/**
 * Line-level diff: the hunks that turn `a` into `b`. Common prefix and
 * suffix are peeled off first (formatting usually touches a few lines), then
 * the middle goes through a plain LCS so a change at the top and one at the
 * bottom of a function become two edits, not one that spans the function.
 */
export function diffLines(a: readonly string[], b: readonly string[]): LineHunk[] {
  let prefix = 0;
  const maxPrefix = Math.min(a.length, b.length);
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = maxPrefix - prefix;
  while (suffix < maxSuffix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  const n = a.length - prefix - suffix;
  const m = b.length - prefix - suffix;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || n * m > MAX_LCS_CELLS) {
    return [{ aStart: prefix, aEnd: prefix + n, bStart: prefix, bEnd: prefix + m }];
  }

  // lcs[i][j] = length of the LCS of a[prefix+i..] and b[prefix+j..].
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const ai = a[prefix + i];
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        ai === b[prefix + j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }

  const hunks: LineHunk[] = [];
  let i = 0;
  let j = 0;
  let open: LineHunk | null = null;
  const flush = (): void => {
    if (open) hunks.push(open);
    open = null;
  };
  const touch = (): LineHunk => {
    if (!open) open = { aStart: prefix + i, aEnd: prefix + i, bStart: prefix + j, bEnd: prefix + j };
    return open;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[prefix + i] === b[prefix + j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) {
      touch().bEnd = prefix + ++j;
    } else {
      touch().aEnd = prefix + ++i;
    }
  }
  flush();
  return hunks;
}

const LINE_SPLIT = /\r\n|\r|\n/;

/**
 * Turn "old text -> formatted text" into Monaco text edits. Ranges are
 * expressed in the model's coordinates; each hunk replaces whole lines
 * including their line break, except at the end of the document where the
 * preceding break is the one that goes (so deleting the last line does not
 * leave a dangling blank one behind).
 */
export function computeFormatEdits(
  model: Monaco.editor.ITextModel,
  formatted: string,
): Monaco.languages.TextEdit[] {
  const oldLines = model.getValue().split(LINE_SPLIT);
  const newLines = formatted.split(LINE_SPLIT);
  const eol = model.getEOL();
  const lineCount = oldLines.length;
  const hunks = diffLines(oldLines, newLines);

  // A hunk that deletes the last lines, or appends after them, has to edit
  // the line break BEFORE them, so it starts at the end of the last kept
  // line. If the previous hunk ends right before that same line and the line
  // is empty, the two edits would meet at one position and Monaco's ordering
  // of touching edits would decide the outcome. Fold them into one hunk
  // instead; the kept line is simply re-emitted as part of the replacement.
  const last = hunks[hunks.length - 1];
  const prev = hunks[hunks.length - 2];
  if (last && prev && last.aEnd === lineCount && prev.aEnd === last.aStart - 1) {
    hunks.splice(hunks.length - 2, 2, {
      aStart: prev.aStart,
      aEnd: last.aEnd,
      bStart: prev.bStart,
      bEnd: last.bEnd,
    });
  }

  return hunks.map(({ aStart, aEnd, bStart, bEnd }) => {
    const inserted = newLines.slice(bStart, bEnd);
    if (aEnd < lineCount) {
      return {
        range: {
          startLineNumber: aStart + 1,
          startColumn: 1,
          endLineNumber: aEnd + 1,
          endColumn: 1,
        },
        text: inserted.map((l) => l + eol).join(''),
      };
    }
    // Hunk runs to the end of the document.
    const end = { endLineNumber: lineCount, endColumn: model.getLineMaxColumn(lineCount) };
    if (aStart === 0) {
      return { range: { startLineNumber: 1, startColumn: 1, ...end }, text: inserted.join(eol) };
    }
    if (aStart < aEnd && inserted.length) {
      // Replacing existing tail lines: their own line breaks suffice.
      return {
        range: { startLineNumber: aStart + 1, startColumn: 1, ...end },
        text: inserted.join(eol),
      };
    }
    // Pure append or pure delete at the end: the break before the hunk goes
    // with it (delete) or comes with it (append).
    return {
      range: { startLineNumber: aStart, startColumn: model.getLineMaxColumn(aStart), ...end },
      text: inserted.length ? eol + inserted.join(eol) : '',
    };
  });
}

/** Strings the failure dialog needs; CodeEditor supplies them translated. */
export interface FormatterMessages {
  failedTitle: () => string;
}

let messages: FormatterMessages = { failedTitle: () => 'Could not format the file' };

export function setFormatterMessages(m: FormatterMessages): void {
  messages = m;
}

/**
 * ruff reports parse errors as UTF-8 byte offsets ("... at byte range
 * 6..7"); a person needs the line. Anything else passes through as-is.
 */
export function describeFormatError(err: unknown, source: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const m = /^(.*?) at byte range (\d+)\.\.\d+$/s.exec(message);
  if (!m) return message;
  const target = Number(m[2]);
  const enc = new TextEncoder();
  let bytes = 0;
  let line = 1;
  for (const l of source.split(LINE_SPLIT)) {
    const next = bytes + enc.encode(l).length + 1;
    if (target < next) break;
    bytes = next;
    line++;
  }
  return `Line ${line}: ${m[1]}`;
}

/**
 * Register the cpp and python formatting providers (and the Shift+Alt+F
 * rule) on a monaco instance. Idempotent per instance: CodeEditor's
 * beforeMount runs on every file switch (the editor is keyed by file id) and
 * Monaco would otherwise stack a duplicate provider each time.
 */
export function registerCodeFormatters(monaco: typeof Monaco): void {
  const g = monaco as unknown as { __velxioCodeFormatters?: boolean };
  if (g.__velxioCodeFormatters) return;
  g.__velxioCodeFormatters = true;

  const provider = (language: FormatterLanguage): Monaco.languages.DocumentFormattingEditProvider => ({
    displayName: language === 'cpp' ? 'clang-format (Arduino style)' : 'ruff',
    async provideDocumentFormattingEdits(model) {
      const filename = model.uri.path.split('/').pop() || '';
      const eol = model.getEOL() as '\n' | '\r\n';
      const source = model.getValue();
      let formatted: string;
      try {
        formatted = await formatSource(language, filename, source, eol, model.getOptions());
      } catch (err) {
        // ruff rejects code it cannot parse (an unclosed bracket, a stray
        // indent); say so with the parser's own position instead of doing
        // nothing. A failed wasm download lands here too.
        showMessageDialog(describeFormatError(err, source), {
          kind: 'error',
          title: messages.failedTitle(),
        });
        return [];
      }
      if (model.isDisposed() || model.getValue() !== source) return [];
      return computeFormatEdits(model, formatted);
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider('cpp', provider('cpp'));
  monaco.languages.registerDocumentFormattingEditProvider('python', provider('python'));

  // Shift+Alt+F on every platform. Monaco's own binding is Shift+Alt+F on
  // Windows and macOS but Ctrl+Shift+I on Linux, where the browser grabs
  // that chord for DevTools before the page ever sees it; this rule adds the
  // one the Edit menu advertises, and it is what the context menu then
  // prints next to "Format Document".
  monaco.editor.addKeybindingRule({
    keybinding: monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
    command: 'editor.action.formatDocument',
    when: 'editorHasDocumentFormattingProvider && editorTextFocus && !editorReadonly',
  });
}

import type { CancellationToken, Position, editor, languages } from 'monaco-editor';
import {
  arduinoCompletions,
  arduinoHover,
  getLibraryRevision,
  includePathPrefix,
  supportsArduinoSymbols,
} from './arduinoSymbols';
import { hasIntellisenseImpl } from './intellisenseRegistry';
import type { Candidate } from './codeCompletions';
import { revealWorkspaceFile } from './workspaceNavigation';
import type { LspRange, SemanticSession } from './semanticIntellisense';
import { useEditorStore, type WorkspaceFile } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';

type Monaco = typeof import('monaco-editor');

interface Binding {
  groupId: string;
  fileId: string;
  session: SemanticSession | null;
  refreshSuggestions: (position: Position) => void;
}

interface Markup {
  kind?: string;
  language?: string;
  value: string;
}
type Documentation = string | Markup;
interface Edit {
  newText: string;
  range?: LspRange;
  insert?: LspRange;
  replace?: LspRange;
}
interface Completion {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: Documentation;
  insertText?: string;
  insertTextFormat?: number;
  filterText?: string;
  sortText?: string;
  textEdit?: Edit;
  additionalTextEdits?: Edit[];
}

interface Signature {
  label: string;
  documentation?: Documentation;
  parameters?: { label: string | [number, number]; documentation?: Documentation }[];
}

interface Definition {
  name: string;
  range: LspRange;
  dependency?: { id: string; content: string };
}

export interface DependencyPreview {
  name: string;
  content: string;
  lineNumber: number;
  column: number;
}

export const OPEN_DEPENDENCY = 'velxio-open-intellisense-dependency';
const bindings = new WeakMap<editor.ITextModel, Binding>();
const installed = new WeakSet<Monaco>();
const pendingCompletions = new WeakMap<editor.ITextModel, { version: number }>();

export function completionWasInterrupted(model: editor.ITextModel) {
  const pending = pendingCompletions.get(model);
  return pending !== undefined && pending.version !== model.getVersionId();
}

function trackCompletion(
  provide: languages.CompletionItemProvider['provideCompletionItems'],
): typeof provide {
  return async (model, position, trigger, token) => {
    const request = { version: model.getVersionId() };
    pendingCompletions.set(model, request);
    try {
      return await provide(model, position, trigger, token);
    } finally {
      if (pendingCompletions.get(model) === request) pendingCompletions.delete(model);
    }
  };
}

export function workspaceModelPath(groupId: string, file: WorkspaceFile) {
  const name = file.name.split('/').map(encodeURIComponent).join('/');
  return `velxio-workspace:/${encodeURIComponent(groupId)}/${encodeURIComponent(file.id)}/${name}`;
}

export function bindIntellisenseModel(model: editor.ITextModel, binding: Binding) {
  bindings.set(model, binding);
  return () => {
    if (bindings.get(model) === binding) bindings.delete(model);
  };
}

function current(model: editor.ITextModel) {
  const binding = bindings.get(model);
  const state = useEditorStore.getState();
  if (
    !binding ||
    model.isDisposed() ||
    state.manifestViewBoardId ||
    state.activeGroupId !== binding.groupId ||
    state.activeFileId !== binding.fileId
  )
    return null;
  const files = state.getGroupFiles(binding.groupId);
  const file = files.find(({ id }) => id === binding.fileId);
  const simulator = useSimulatorStore.getState();
  const board = simulator.boards.find(
    ({ activeFileGroupId }) => activeFileGroupId === binding.groupId,
  );
  if (!file) return null;
  const stamp = JSON.stringify([
    board?.id,
    board?.boardKind,
    board?.languageMode,
    board?.libraries,
    getLibraryRevision(),
  ]);
  return { binding, file, files, board, stamp };
}

function snapshot(model: editor.ITextModel, token: CancellationToken) {
  const initial = current(model);
  if (!initial || token.isCancellationRequested) return null;
  const version = model.getVersionId();
  const matchesModel = () => {
    if (model.isDisposed() || model.getVersionId() !== version) return false;
    const latest = current(model);
    return (
      latest?.binding === initial.binding &&
      latest.files === initial.files &&
      latest.stamp === initial.stamp &&
      latest.file.name === initial.file.name
    );
  };
  return {
    ...initial,
    matchesModel,
    fresh: () => !token.isCancellationRequested && matchesModel(),
  };
}

function range(monaco: Monaco, span: LspRange) {
  return new monaco.Range(
    span.start.line + 1,
    span.start.character + 1,
    span.end.line + 1,
    span.end.character + 1,
  );
}

function markdown(value: Documentation | undefined) {
  if (!value) return undefined;
  if (typeof value === 'string') return { value };
  if (value.language) return { value: `~~~${value.language}\n${value.value}\n~~~` };
  return { value: value.value };
}

function completionItems(
  monaco: Monaco,
  model: editor.ITextModel,
  position: Position,
  items: Completion[],
): languages.CompletionItem[] {
  const kinds = monaco.languages.CompletionItemKind;
  const byLspKind = [
    kinds.Text,
    kinds.Method,
    kinds.Function,
    kinds.Constructor,
    kinds.Field,
    kinds.Variable,
    kinds.Class,
    kinds.Interface,
    kinds.Module,
    kinds.Property,
    kinds.Unit,
    kinds.Value,
    kinds.Enum,
    kinds.Keyword,
    kinds.Snippet,
    kinds.Color,
    kinds.File,
    kinds.Reference,
    kinds.Folder,
    kinds.EnumMember,
    kinds.Constant,
    kinds.Struct,
    kinds.Event,
    kinds.Operator,
    kinds.TypeParameter,
  ];
  const word = model.getWordUntilPosition(position);
  const wordRange = new monaco.Range(
    position.lineNumber,
    word.startColumn,
    position.lineNumber,
    word.endColumn,
  );
  return items.slice(0, 500).map((item) => {
    const edit = item.textEdit;
    const replacement = edit?.range
      ? range(monaco, edit.range)
      : edit?.insert && edit.replace
        ? { insert: range(monaco, edit.insert), replace: range(monaco, edit.replace) }
        : wordRange;
    return {
      label: item.label,
      kind: byLspKind[(item.kind ?? 1) - 1] ?? kinds.Text,
      detail: item.detail,
      documentation: markdown(item.documentation),
      insertText: edit?.newText ?? item.insertText ?? item.label,
      insertTextRules:
        item.insertTextFormat === 2
          ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
          : undefined,
      filterText: item.filterText,
      sortText: item.sortText,
      range: replacement,
      additionalTextEdits: item.additionalTextEdits?.flatMap((extra) =>
        extra.range ? [{ range: range(monaco, extra.range), text: extra.newText }] : [],
      ),
    };
  });
}

function localItems(
  monaco: Monaco,
  candidates: Candidate[],
  span: languages.CompletionItem['range'],
) {
  return candidates.map(
    (item): languages.CompletionItem => ({
      label: item.label,
      kind: monaco.languages.CompletionItemKind[item.kind],
      detail: item.detail,
      insertText: item.insertText ?? item.label,
      insertTextRules:
        item.kind === 'Snippet'
          ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
          : undefined,
      range: span,
    }),
  );
}

function mergeItems(primary: languages.CompletionItem[], fallback: languages.CompletionItem[]) {
  const labels = new Set(primary.map((item) => item.filterText ?? item.label));
  return primary.concat(
    fallback.filter(({ label }) => {
      if (labels.has(label)) return false;
      labels.add(label);
      return true;
    }),
  );
}

export function registerEditorIntellisense(monaco: Monaco) {
  if (installed.has(monaco)) return;
  installed.add(monaco);
  const dependencies = new Map<string, { name: string; content: string }>();

  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selection) {
      const position =
        selection &&
        ('startLineNumber' in selection
          ? { lineNumber: selection.startLineNumber, column: selection.startColumn }
          : { lineNumber: selection.lineNumber, column: selection.column });
      if (resource.scheme === 'velxio-workspace') {
        const [, groupId, fileId] = resource.path.split('/');
        const model = source.getModel();
        // Monaco is still completing its navigation action. Let it finish
        // before switching tabs and disposing the initiating editor.
        setTimeout(() => {
          if (model && bindings.has(model)) {
            revealWorkspaceFile(groupId, fileId, position ?? { lineNumber: 1, column: 1 });
          }
        }, 0);
        return true;
      }
      const dependency = dependencies.get(resource.toString());
      if (!dependency) return false;
      window.dispatchEvent(
        new CustomEvent<DependencyPreview>(OPEN_DEPENDENCY, {
          detail: {
            ...dependency,
            lineNumber: position?.lineNumber ?? 1,
            column: position?.column ?? 1,
          },
        }),
      );
      return true;
    },
  });

  monaco.languages.registerCompletionItemProvider('yaml', {
    triggerCharacters: [':', ' ', '*'],
    provideCompletionItems: trackCompletion(async (model, position, trigger, token) => {
      const ctx = snapshot(model, token);
      if (!ctx || hasIntellisenseImpl()) return;
      const prefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      if (trigger.triggerCharacter === ' ' && !/(?:^\s+|[:-] )$/.test(prefix)) return;
      const { yamlCandidates } = await import('./yamlCompletions');
      if (!ctx.fresh()) return;
      const offset = model.getOffsetAt(position);
      const { suggestions, start, end } = yamlCandidates(
        ctx.file.name,
        model.getValue(),
        offset,
        ctx.files,
      );
      const column = position.column - (offset - start);
      const span = (last: number) =>
        new monaco.Range(position.lineNumber, column, position.lineNumber, last);
      return {
        suggestions: localItems(monaco, suggestions, {
          insert: span(position.column),
          replace: span(column + end - start),
        }),
      };
    }),
  });

  // A late server result can refresh the open widget once at the same cursor.
  // The retrigger consumes the completed list without sending a second request.
  const readyLists = new WeakMap<
    editor.ITextModel,
    { position: Position; fresh: () => boolean; list: languages.CompletionList }
  >();
  for (const language of ['cpp', 'c', 'python']) {
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: language === 'python' ? ['.', ' '] : ['.', '>', ':', '<', '"', '/', '#'],
      provideCompletionItems: trackCompletion(async (model, position, trigger, token) => {
        const ctx = snapshot(model, token);
        if (!ctx || hasIntellisenseImpl()) return;
        const { file, board, binding, files } = ctx;
        const ready = readyLists.get(model);
        readyLists.delete(model);
        if (ready?.position.equals(position) && ready.fresh()) return ready.list;
        const prefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        const header = language !== 'python' ? includePathPrefix(prefix) : undefined;
        const ch = trigger.triggerCharacter;
        if (ch === ' ' && !/^\s*(?:from(?:\s+[\w.]+\s+import)?|import) $/.test(prefix)) return;
        if (ch && ['<', '"', '/'].includes(ch) && header === undefined) return;
        if ((ch === '>' && !prefix.endsWith('->')) || (ch === ':' && !prefix.endsWith('::')))
          return;
        const arduino = board && language !== 'python' && supportsArduinoSymbols(board);
        const headers = files.map((f) => f.name).filter((name) => /\.(h|hpp|hh|hxx)$/i.test(name));
        const word = model.getWordUntilPosition(position);
        const span = new monaco.Range(
          position.lineNumber,
          header !== undefined ? position.column - header.length : word.startColumn,
          position.lineNumber,
          position.column,
        );
        const remote = async (): Promise<languages.CompletionList> => {
          const result =
            header !== undefined && arduino
              ? null
              : await binding.session?.request<
                  Completion[] | { items: Completion[] | null; isIncomplete?: boolean }
                >('completion', file.name, position, token, {
                  triggerKind: trigger.triggerKind + 1,
                  triggerCharacter: trigger.triggerCharacter,
                });
          const items = Array.isArray(result) ? result : result?.items;
          if (!ctx.fresh()) return { suggestions: [] };
          const semantic = items ? completionItems(monaco, model, position, items) : [];
          const indexed =
            arduino && (!semantic.length || /(?:\.|->|::)\s*\w*$/.test(prefix))
              ? await arduinoCompletions(monaco, model, position, board, headers, token)
              : [];
          return {
            suggestions: mergeItems(semantic, indexed),
            incomplete: !Array.isArray(result) && result?.isIncomplete,
          };
        };
        const pending = remote();
        const { codeCandidates, standardHeaders } = await import('./codeCompletions');
        if (!ctx.fresh()) return;
        const local =
          header !== undefined
            ? localItems(
                monaco,
                [
                  ...headers.map((label): Candidate => ({ label, kind: 'File' })),
                  ...standardHeaders,
                ],
                span,
              )
            : localItems(
                monaco,
                codeCandidates(
                  file,
                  files,
                  model.getOffsetAt(position),
                  prefix,
                  board?.languageMode === 'micropython',
                ),
                span,
              );
        if (arduino)
          local.push(
            ...(await arduinoCompletions(monaco, model, position, board, headers, token, true)),
          );
        if (!ctx.fresh() || hasIntellisenseImpl()) return;
        const complete = pending.then((list) => ({
          ...list,
          suggestions: mergeItems(list.suggestions, local),
        }));
        const typed = (header ?? word.word).toLowerCase();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = local.some(
          (item) => typeof item.label === 'string' && item.label.toLowerCase().startsWith(typed),
        )
          ? await Promise.race([
              complete,
              new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), 65);
              }),
            ])
          : await complete;
        clearTimeout(timer);
        if (!ctx.fresh() || hasIntellisenseImpl()) return;
        if (result) return result;
        void complete.then((list) => {
          if (!ctx.fresh() || hasIntellisenseImpl()) return;
          // Closing the old widget cancels its token. Reuse the prepared list
          // only while the document, board and workspace still match.
          readyLists.set(model, { position, fresh: ctx.matchesModel, list });
          binding.refreshSuggestions(position);
        });
        return { suggestions: mergeItems([], local), incomplete: true };
      }),
    });
    monaco.languages.registerHoverProvider(language, {
      async provideHover(model, position, token) {
        const ctx = snapshot(model, token);
        if (!ctx || hasIntellisenseImpl()) return;
        const { file, board, binding } = ctx;
        const result = await binding.session?.request<{
          contents: Documentation | Documentation[];
          range?: LspRange;
        }>('hover', file.name, position, token);
        if (!ctx.fresh()) return;
        if (result) {
          const values = Array.isArray(result.contents) ? result.contents : [result.contents];
          return {
            contents: values.flatMap((value) => markdown(value) ?? []),
            range: result.range ? range(monaco, result.range) : undefined,
          };
        }
        if (!board || !supportsArduinoSymbols(board) || language === 'python') return;
        const hover = await arduinoHover(monaco, model, position, board, token);
        if (ctx.fresh() && !hasIntellisenseImpl()) return hover;
      },
    });
    monaco.languages.registerSignatureHelpProvider(language, {
      signatureHelpTriggerCharacters: ['(', ','],
      signatureHelpRetriggerCharacters: [','],
      async provideSignatureHelp(model, position, token) {
        const ctx = snapshot(model, token);
        if (!ctx?.binding.session || hasIntellisenseImpl()) return;
        const result = await ctx.binding.session.request<{
          signatures: Signature[];
          activeSignature?: number;
          activeParameter?: number;
        }>('signatureHelp', ctx.file.name, position, token);
        if (!result?.signatures.length || !ctx.fresh()) return;
        return {
          value: {
            signatures: result.signatures.map((signature) => ({
              label: signature.label,
              documentation: markdown(signature.documentation),
              parameters: (signature.parameters ?? []).map((parameter) => ({
                label: parameter.label,
                documentation: markdown(parameter.documentation),
              })),
            })),
            activeSignature: result.activeSignature ?? 0,
            activeParameter: result.activeParameter ?? 0,
          },
          dispose() {},
        };
      },
    });
    monaco.languages.registerDefinitionProvider(language, {
      async provideDefinition(model, position, token) {
        const ctx = snapshot(model, token);
        if (!ctx?.binding.session || hasIntellisenseImpl()) return;
        const result = await ctx.binding.session.request<Definition[]>(
          'definition',
          ctx.file.name,
          position,
          token,
        );
        if (!result || !ctx.fresh()) return;
        return result.flatMap((definition) => {
          const target = { range: range(monaco, definition.range) };
          if (definition.dependency) {
            const uri = monaco.Uri.parse(
              `velxio-dependency:/${definition.dependency.id}/${encodeURIComponent(definition.name)}`,
            );
            dependencies.set(uri.toString(), {
              name: definition.name,
              content: definition.dependency.content,
            });
            if (dependencies.size > 24) dependencies.delete(dependencies.keys().next().value!);
            return [{ ...target, uri }];
          }
          const file = ctx.files.find(({ name }) => name === definition.name);
          return file
            ? [{ ...target, uri: monaco.Uri.parse(workspaceModelPath(ctx.binding.groupId, file)) }]
            : [];
        });
      },
    });
  }
}

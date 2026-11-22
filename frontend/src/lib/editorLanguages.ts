import { LANGUAGE_ID as RETRO_ASM_ID } from '../components/editor/retroAsmLanguage';

// The first extension is the one used when a file changes language. Keep
// the other extensions so opening an existing sketch detects them correctly.
export const editorLanguages = [
  { id: RETRO_ASM_ID, label: 'Assembly', extensions: ['asm', 's'] },
  {
    id: 'cpp',
    label: 'C/C++',
    extensions: ['cpp', 'ino', 'c', 'cc', 'cxx', 'h', 'hh', 'hpp', 'hxx'],
  },
  { id: 'css', label: 'CSS', extensions: ['css'] },
  { id: 'html', label: 'HTML', extensions: ['html', 'htm'] },
  { id: 'javascript', label: 'JavaScript', extensions: ['js', 'mjs'] },
  { id: 'json', label: 'JSON', extensions: ['json'] },
  { id: 'markdown', label: 'Markdown', extensions: ['md'] },
  { id: 'plaintext', label: 'Plain Text', extensions: ['txt'] },
  { id: 'python', label: 'Python', extensions: ['py', 'pyi'] },
  { id: 'typescript', label: 'TypeScript', extensions: ['ts'] },
  { id: 'yaml', label: 'YAML', extensions: ['yaml', 'yml'] },
];

function extensionIndex(filename: string): number {
  const index = filename.lastIndexOf('.');
  return index > filename.lastIndexOf('/') + 1 ? index : -1;
}

export function getEditorLanguage(filename: string): string {
  const index = extensionIndex(filename);
  const extension = index < 0 ? '' : filename.slice(index + 1).toLowerCase();
  return (
    editorLanguages.find((language) => language.extensions.includes(extension))?.id ?? 'plaintext'
  );
}

// Generated regex patterns for detecting the language of a source file
const sourceSignatures = [
  {
    id: 'cpp',
    patterns: [
      /^\s*#\s*(?:include\s*[<"]|(?:define|ifdef|ifndef|pragma)\s+\w)/m,
      /\b(?:std::\w+|(?:int|void|double|float|char|bool)\s+\w+\s*\([^;\n]*\)\s*\{)/,
      /^\s*(?:namespace\s+\w+\s*\{|(?:struct|class)\s+\w+\s*\{[^}]*\};)/m,
    ],
  },
  {
    id: 'python',
    patterns: [
      /^\s*(?:async\s+def|def)\s+\w+\s*\(|^\s*print\s*\(/m,
      /^\s*from\s+[\w.]+\s+import\s+|^\s*import\s+\w+(?:\.\w+)*(?:\s+as\s+\w+)?[ \t]*$/m,
      /^\s*(?:if|elif|for|while|with|class)\s+[^\n{}]+:\s*(?:#.*)?$/m,
    ],
  },
  {
    id: RETRO_ASM_ID,
    patterns: [
      /^\s*\.(?:org|equ|byte|word|section|globl)\b/im,
      /^\s*(?:\w+:[ \t]*)?(?:(?:mvi|lxi|ld|ldi|mov|jmp)[ \t]+(?:[\w$#(]+[ \t]*,|[$#0-9][\w$]*)|(?:ret|hlt|nop)[ \t]*(?:;.*)?$)/im,
    ],
  },
  {
    id: 'typescript',
    patterns: [
      /^\s*(?:export\s+)?(?:interface\s+\w+(?:\s+extends\s+[\w, ]+)?\s*\{|type\s+\w+\s*=)/m,
      /\b(?:const|let|var)\s+\w+\s*:\s*[^\n=]+=/,
      /\bfunction\s+\w+\s*\([^\n()]*\b\w+\s*:\s*[^\n()]+\)/,
    ],
  },
  {
    id: 'javascript',
    patterns: [
      /^\s*(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\b|import\s+(?:[^\n]+\s+from\s+)?['"])/m,
      /^\s*(?:(?:const|let|var)\s+\w+\s*=|(?:async\s+)?function\s*\w*\s*\()/m,
      /\bconsole\.\w+\s*\(/,
    ],
  },
  {
    id: 'css',
    patterns: [
      /^\s*@(?:media|supports|keyframes)\b/m,
      /^\s*(?:[.#:\w]|\[)[^{};\n]*\{\s*(?:--)?[a-z][\w-]*\s*:\s*[^{}\n;]+[;}]/im,
    ],
  },
];

export function detectEditorLanguage(filename: string, content: string): string | undefined {
  const fromName = getEditorLanguage(filename);
  const source = content.slice(0, 64 * 1024).trim();
  const firstLine = source.split('\n', 1)[0];

  if (firstLine.startsWith('#!')) {
    if (/\b(?:python[\d.]*|micropython)\b/.test(firstLine)) return 'python';
    if (/\b(?:node|nodejs|deno|bun)\b/.test(firstLine))
      return fromName === 'typescript' ? fromName : 'javascript';
  }

  const markup = source.replace(/^(?:<!--[\s\S]*?-->\s*)+/, '');
  if (
    /^(?:<!doctype\s+html\b|<(?:html|head|body|title|main|div|p|h[1-6]|section|article|script|style|img|form|input|a|ul|ol|li|table)(?:\s|\/?>))/i.test(
      markup,
    )
  )
    return 'html';
  if (/^(?:\{|\[)/.test(source)) {
    try {
      JSON.parse(source);
      return fromName === 'yaml' ? 'yaml' : 'json';
    } catch {
      // Programs and YAML can also start with a brace or bracket.
    }
  }
  if (/^(?:```|~~~)/m.test(source)) return 'markdown';
  if (fromName === 'markdown' && /^---[ \t]*\r?\n/.test(source)) return 'markdown';
  // An indented block scalar can contain code in a different language.
  if (
    /^%YAML\s/m.test(source) ||
    /^[ \t]*(?:-[ \t]+)?[\w.-]+:[ \t]+[|>][+\d-]*[ \t]*(?:#.*)?\r?\n[ \t]+\S/m.test(source)
  )
    return 'yaml';

  const match = sourceSignatures.find(({ patterns }) =>
    patterns.some((pattern) => pattern.test(source)),
  );
  if (match) {
    return match.id === 'javascript' && fromName === 'typescript' ? fromName : match.id;
  }

  if (fromName === 'markdown' || (fromName === 'plaintext' && /^#{1,6}[ \t]+\S/.test(source)))
    return 'markdown';

  // Look for a block mapping or sequence. A standalone line of prose such
  // as "Note: try again" is ambiguous, so require structure or more keys.
  const mappingKeys = source.match(/^[ \t]*(?:-[ \t]+)?[\w.-]+:(?=[ \t]|$)/gm);
  if (
    (mappingKeys?.length ?? 0) >= 2 ||
    /^\s*[\w.-]+:[ \t]*\n[ \t]+-\s+\S/m.test(source) ||
    /^\s*-\s+\S.*\n[ \t]*-\s+\S/m.test(source)
  )
    return 'yaml';

  return fromName === 'plaintext' ? undefined : fromName;
}

export function editorLanguageLabel(id: string): string {
  return editorLanguages.find((language) => language.id === id)?.label ?? id;
}

export function renameForEditorLanguage(filename: string, id: string): string {
  const language = editorLanguages.find((option) => option.id === id);
  if (!language) return filename;
  const index = extensionIndex(filename);
  if (index >= 0 && language.extensions.includes(filename.slice(index + 1).toLowerCase()))
    return filename;
  const stem = index < 0 ? filename : filename.slice(0, index);
  return `${stem}.${language.extensions[0]}`;
}

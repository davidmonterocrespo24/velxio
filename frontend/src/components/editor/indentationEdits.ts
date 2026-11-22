import type { editor as MonacoEditor } from 'monaco-editor';
import type { Indentation } from '../../store/useEditorPreferences';

export function indentationEdits(
  lines: string[],
  source: Indentation & { indentSize: number },
  target: Indentation,
  isLiteralLine: (index: number) => boolean,
): MonacoEditor.IIdentifiedSingleEditOperation[] {
  const tabWidth = source.insertSpaces ? source.tabSize : source.indentSize;
  const indents = lines.flatMap((line, index) => {
    const whitespace = /^[ \t]+/.exec(line)?.[0];
    if (!whitespace || isLiteralLine(index)) return [];
    let columns = 0;
    for (const char of whitespace) {
      columns += char === '\t' ? tabWidth - (columns % tabWidth) : 1;
    }
    return [{ index, whitespace, columns }];
  });

  // If a narrower width would make an alignment offset reach the next indent
  // level, preserve the existing columns so irregular indentation stays ordered.
  const resize = indents.every(({ columns }) => columns % source.indentSize < target.tabSize);
  return indents.flatMap(({ index, whitespace, columns }) => {
    const targetColumns = resize
      ? Math.floor(columns / source.indentSize) * target.tabSize + columns % source.indentSize
      : columns;
    const text = target.insertSpaces
      ? ' '.repeat(targetColumns)
      : '\t'.repeat(Math.floor(targetColumns / target.tabSize)) + ' '.repeat(targetColumns % target.tabSize);
    if (text === whitespace) return [];
    return [{
      range: { startLineNumber: index + 1, startColumn: 1, endLineNumber: index + 1, endColumn: whitespace.length + 1 },
      text,
    }];
  });
}

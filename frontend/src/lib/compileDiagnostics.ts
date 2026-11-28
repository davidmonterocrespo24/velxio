import type { WorkspaceFile } from '../store/useEditorStore';

export interface BuildLocation {
  groupId: string;
  fileId: string;
  name: string;
  content: string;
  position: { lineNumber: number; column: number };
  severity: 'error' | 'warning';
  message: string;
}

export function compilerLocation(
  line: string,
  groupId: string,
  files: readonly WorkspaceFile[],
): BuildLocation | undefined {
  const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
  const match = /^(.+?):(\d+)(?::(\d+))?:\s*(fatal error|error|warning):\s*(.+)$/i.exec(clean);
  if (!match) return;
  const [, rawPath, row, col, severity, message] = match;
  const path = rawPath.replace(/\\/g, '/');
  const matches = files.filter(({ name }) => path === name || path.endsWith('/' + name));
  // A relative folder match is more precise than just the file's basename.
  const direct = matches.sort((a, b) => b.name.length - a.name.length)[0];
  // arduino-cli promotes the main tab to sketch.ino in its scratch folder.
  const file =
    direct ??
    (/(?:^|\/)sketch\.ino$/.test(path)
      ? files.find(({ name }) => name.endsWith('.ino'))
      : undefined);
  const lineNumber = Number(row);
  const column = Number(col ?? 1);
  if (
    !file ||
    !Number.isSafeInteger(lineNumber) ||
    lineNumber < 1 ||
    lineNumber > file.content.split('\n').length ||
    !Number.isSafeInteger(column) ||
    column < 1
  )
    return;

  return {
    groupId,
    fileId: file.id,
    name: file.name,
    content: file.content,
    position: { lineNumber, column },
    severity: severity.toLowerCase() === 'warning' ? 'warning' : 'error',
    message,
  };
}

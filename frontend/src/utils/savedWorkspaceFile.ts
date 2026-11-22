export interface SavedWorkspaceFile {
  id?: string;
  name: string;
  content: string;
}

export function savedWorkspaceFileId(file: Pick<SavedWorkspaceFile, 'id' | 'name'>): string {
  // Older snapshots only have a name. Use it to find their history on the first save.
  return typeof file.id === 'string' && file.id ? file.id : `legacy:${file.name}`;
}

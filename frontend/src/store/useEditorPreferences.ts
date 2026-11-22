import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';

const indentation = z.object({
  insertSpaces: z.boolean(),
  tabSize: z.number().int().min(1).max(8),
});
const preferences = z.object({
  fontSize: z.number().int().min(10).max(30),
  wordWrap: z.boolean(),
  minimap: z.boolean(),
  indentation,
  detectIndentation: z.boolean(),
  languageIndentation: z.object({ cpp: indentation.optional(), python: indentation.optional() }),
  autoSave: z.boolean(),
  sidebarWidth: z.number().int().min(100).max(500),
  sidebarView: z.enum(['explorer', 'search', 'libraries', 'flash']),
});

export type Indentation = z.infer<typeof indentation>;
export type EditorPreferences = z.infer<typeof preferences>;

const defaults: EditorPreferences = {
  fontSize: 14,
  wordWrap: false,
  minimap: true,
  indentation: { insertSpaces: true, tabSize: 4 },
  detectIndentation: true,
  languageIndentation: { cpp: { insertSpaces: true, tabSize: 2 } },
  autoSave: true,
  sidebarWidth: 184,
  sidebarView: 'explorer',
};

export const useEditorPreferences = create<
  EditorPreferences & {
    update: (values: Partial<EditorPreferences>) => void;
    reset: () => void;
  }
>()(
  persist(
    (set) => ({
      ...defaults,
      update: (values) => set(values),
      reset: () => set(defaults),
    }),
    {
      name: 'velxio-editor-preferences',
      version: 1,
      partialize: ({ update: _update, reset: _reset, ...values }) => values,
      merge: (stored, current) => {
        const values = preferences.partial().safeParse(stored);
        return values.success ? { ...current, ...values.data } : current;
      },
    },
  ),
);

export function indentationFor(language: string, settings: EditorPreferences): Indentation {
  if (language === 'cpp' || language === 'python') {
    return settings.languageIndentation[language] ?? settings.indentation;
  }
  return settings.indentation;
}

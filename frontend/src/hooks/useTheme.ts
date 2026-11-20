import { useSyncExternalStore } from 'react';
import {
  getMode,
  getResolvedTheme,
  getThemeRevision,
  getActiveWorkspaceTheme,
  getWorkspaceThemes,
  EMPTY_WORKSPACE_THEMES,
  setThemeMode,
  subscribeTheme,
  type ResolvedTheme,
  type ThemeMode,
} from '../lib/theme';

/** Server snapshot: SSR and the pre-hydration render are always dark, which
 *  matches the no-JS baseline in tokens/colors.css. */
const serverMode = (): ThemeMode => 'dark';
const serverResolved = (): ResolvedTheme => 'dark';

/** The user's preference — 'dark' | 'light' | 'system'. Use this for the UI
 *  that SETS the theme (menu checkmarks), so "system" stays visible as a
 *  distinct choice. */
export function useThemeMode(): [ThemeMode, (mode: ThemeMode) => void] {
  const mode = useSyncExternalStore(subscribeTheme, getMode, serverMode);
  return [mode, setThemeMode];
}

/** What the preference currently resolves to — 'dark' | 'light'. Use this for
 *  the code that has to PAINT something outside CSS's reach: Monaco, canvas
 *  2D contexts, the serial terminal. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeTheme, getResolvedTheme, serverResolved);
}

export function useThemeRevision(): number {
  return useSyncExternalStore(subscribeTheme, getThemeRevision, () => 0);
}

export function useActiveWorkspaceTheme() {
  return useSyncExternalStore(subscribeTheme, getActiveWorkspaceTheme, () => null);
}

export function useWorkspaceThemes() {
  return useSyncExternalStore(subscribeTheme, getWorkspaceThemes, () => EMPTY_WORKSPACE_THEMES);
}

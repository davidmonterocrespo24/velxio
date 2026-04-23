/**
 * English shell strings.
 *
 * Keys are namespaced by `area.key` (e.g. `nav.home`, `header.share`).
 * Add a key here when you add a translation slot to the UI; mirror it in
 * every other locale file in this folder. Untranslated keys fall back to
 * the English entry, then to the key itself, so a missing entry shows up
 * as visible debug output rather than empty space.
 *
 * Strings are plain TS — no JSON fetch, no runtime IO. The build inlines
 * them so locale switching is synchronous.
 */

export const en = {
  // Navigation
  'nav.home': 'Home',
  'nav.documentation': 'Documentation',
  'nav.examples': 'Examples',
  'nav.editor': 'Editor',
  'nav.about': 'About',

  // Header buttons
  'header.share': 'Share',
  'header.share.title': 'Share project',
  'header.templates': 'Templates',
  'header.templates.title': 'New from template',
  'header.plugins': 'Plugins',
  'header.plugins.title': 'Installed plugins',
  'header.signIn': 'Sign in',
  'header.signUp': 'Sign up',
  'header.myProjects': 'My projects',
  'header.signOut': 'Sign out',
  'header.toggleMenu': 'Toggle menu',

  // Installed Plugins modal
  'plugins.title': 'Installed Plugins',
  'plugins.refresh': 'Refresh',
  'plugins.marketplace': 'Marketplace →',
  'plugins.close': 'Close',
  'plugins.empty': 'No plugins installed yet — browse the marketplace to add one.',
  'plugins.empty.title': 'No plugins installed',
  'plugins.empty.body': 'Plugins extend Velxio with new components, simulations, templates, and tools.',
  'plugins.empty.cta': 'Browse the marketplace →',
  'plugins.language': 'Language',
  'plugins.uninstall.title': 'Uninstall {name}?',
  'plugins.uninstall.body1': 'This will remove the plugin from this editor session. Components, templates, and other registrations it provided will disappear immediately.',
  'plugins.uninstall.body2': 'Your purchase remains valid — you can reinstall from the marketplace at any time.',
  'plugins.uninstall.confirm': 'Uninstall',
  'plugins.settings.title': '{name} — Settings',
  'plugins.settings.empty': "This plugin hasn't declared any settings yet. Once it calls",
  'plugins.settings.metadata': 'Plugin metadata',

  // Template picker
  'templates.title': 'New from template',
  'templates.empty': 'No templates installed yet — browse the marketplace to add one.',
  'templates.instantiate': 'Use this template',
  'templates.cancel': 'Cancel',
  'templates.preview': 'Preview',

  // Common
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.save': 'Save',
  'common.loading': 'Loading…',
  'common.error': 'Error',
} as const;

export type ShellTranslationKey = keyof typeof en;

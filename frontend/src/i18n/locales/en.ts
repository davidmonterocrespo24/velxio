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

  // File explorer (left sidebar)
  'fileExplorer.workspace': 'WORKSPACE',
  'fileExplorer.saveProject.title': 'Save project (Ctrl+S)',
  'fileExplorer.boardHeader.title': '{board} — click to edit',
  'fileExplorer.collapse': 'Collapse',
  'fileExplorer.expand': 'Expand',
  'fileExplorer.status.running': 'Running',
  'fileExplorer.status.compiled': 'Compiled',
  'fileExplorer.status.idle': 'Idle',
  'fileExplorer.newFile.title': 'New file in this board',
  'fileExplorer.newFile.placeholder': 'filename.ino',
  'fileExplorer.unsaved.suffix': ' (unsaved)',
  'fileExplorer.unsaved.title': 'Unsaved changes',
  'fileExplorer.delete.confirm': 'Delete this file?',
  'fileExplorer.empty': 'Add a board to the canvas to start editing code.',
  'fileExplorer.contextMenu.rename': 'Rename',
  'fileExplorer.contextMenu.delete': 'Delete',

  // Save project modal
  'saveProject.title.create': 'Save project',
  'saveProject.title.update': 'Update project',
  'saveProject.label.name': 'Project name *',
  'saveProject.label.description': 'Description',
  'saveProject.placeholder.name': 'My awesome project',
  'saveProject.placeholder.description': 'Optional',
  'saveProject.visibility.public': 'Public',
  'saveProject.visibility.private': 'Private',
  'saveProject.visibility.publicDescription': 'Anyone with the link can view',
  'saveProject.visibility.privateDescription': 'Only you can see this',
  'saveProject.button.save': 'Save',
  'saveProject.button.update': 'Update',
  'saveProject.button.saving': 'Saving…',
  'saveProject.error.nameRequired': 'Project name is required.',
  'saveProject.error.unreachable': 'Server unreachable. Check your connection and try again.',
  'saveProject.error.notAuthenticated': 'Not authenticated. Please log in and try again.',
  'saveProject.error.saveFailed': 'Save failed ({status}).',

  // Login prompt modal (prompts anon users when they try to save)
  'loginPrompt.title': 'Sign in to save your project',
  'loginPrompt.body': 'Create a free account to save and share your projects.',
  'loginPrompt.createAccount': 'Create account',

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

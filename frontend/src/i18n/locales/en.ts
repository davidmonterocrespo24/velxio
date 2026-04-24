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
  'plugins.toast.title': 'Recent plugin updates',
  'plugins.toast.summary': '{count} plugin updated',
  'plugins.toast.summary.plural': '{count} plugins updated',
  'plugins.toast.entry': '{name} updated to {version}',
  'plugins.toast.entry.permissions': '+ {count} new permission',
  'plugins.toast.entry.permissions.plural': '+ {count} new permissions',
  'plugins.toast.dismiss': 'Dismiss',
  'plugins.toast.dismissAll': 'Dismiss all',
  'plugins.toast.expand': 'Show details',
  'plugins.toast.collapse': 'Hide details',

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
  'templates.close': 'Close',
  'templates.builtIn': 'built-in',
  'templates.viaPlugin': 'via {id}',
  'templates.selectPrompt': 'Select a template to preview.',
  'templates.readme': 'Readme',
  'templates.replaceWarning': 'This replaces the current sketch and canvas.',
  'templates.difficultyLabel': 'Difficulty {level} of 5',
  'templates.empty.title': 'No templates installed yet',
  'templates.empty.body':
    'Install a plugin from the marketplace to add starter projects to this list.',
  'templates.empty.browse': 'Browse marketplace →',
  'templates.category.beginner': 'Beginner',
  'templates.category.intermediate': 'Intermediate',
  'templates.category.advanced': 'Advanced',
  'templates.category.showcase': 'Showcase',

  // Editor toolbar (compile / run / overflow / library hint / status messages)
  'editorToolbar.board.editing': 'Editing: {board}',
  'editorToolbar.board.running': 'Running',
  'editorToolbar.board.languageMode': 'Language mode',
  'editorToolbar.compile.addBoard': 'Add a board to compile',
  'editorToolbar.compile.loading': 'Loading…',
  'editorToolbar.compile.loadMicroPython': 'Load MicroPython',
  'editorToolbar.compile.title': 'Compile (Ctrl+B)',
  'editorToolbar.run.addBoard': 'Add a board to run',
  'editorToolbar.run.runMicroPython': 'Run MicroPython',
  'editorToolbar.run.title': 'Run (auto-compiles if needed)',
  'editorToolbar.stop.title': 'Stop',
  'editorToolbar.reset.title': 'Reset',
  'editorToolbar.compileAll.title': 'Compile all boards',
  'editorToolbar.runAll.title': 'Run all boards',
  'editorToolbar.libraries.title': 'Search and install Arduino libraries',
  'editorToolbar.libraries.label': 'Libraries',
  'editorToolbar.overflow.title': 'Import / Export',
  'editorToolbar.overflow.import': 'Import zip',
  'editorToolbar.overflow.export': 'Export zip',
  'editorToolbar.overflow.uploadFirmware': 'Upload firmware (.hex, .bin, .elf)',
  'editorToolbar.console.title': 'Toggle Output Console',
  'editorToolbar.libHint.text': 'Missing library? Install it from the',
  'editorToolbar.libHint.button': 'Library Manager',
  'editorToolbar.libHint.dismiss': 'Dismiss',
  'editorToolbar.message.ready': 'Ready (no compilation needed)',
  'editorToolbar.message.microPythonReady': 'MicroPython ready',
  'editorToolbar.message.failedMicroPython': 'Failed to load MicroPython',
  'editorToolbar.message.unknownBoard': 'Unknown board',
  'editorToolbar.message.compiled': 'Compiled successfully',
  'editorToolbar.message.compileFailed': 'Compile failed',
  'editorToolbar.message.exportFailed': 'Export failed.',
  'editorToolbar.message.noBoard': 'No board selected',
  'editorToolbar.message.firmwareLoaded': 'Firmware loaded: {name}',
  'editorToolbar.message.failedFirmware': 'Failed to load firmware',
  'editorToolbar.message.imported': 'Imported {name}',
  'editorToolbar.message.importFailed': 'Import failed.',
  'editorToolbar.log.piNoCompile':
    'Raspberry Pi 3B: no compilation needed — run Python scripts directly.',
  'editorToolbar.log.microPythonLoading': 'MicroPython: loading firmware and user files...',
  'editorToolbar.log.microPythonLoaded': 'MicroPython firmware loaded successfully',
  'editorToolbar.log.microPythonLoadedShort': 'MicroPython firmware loaded',
  'editorToolbar.log.startCompile': 'Starting compilation for {board} ({fqbn})...',
  'editorToolbar.log.noFqbn': 'No FQBN for board kind: {kind}',
  'editorToolbar.log.archMismatch':
    'Note: Detected {detected} architecture, but current board is {current}. Loading anyway.',
  'editorToolbar.log.loadingFirmware': 'Loading firmware: {name}...',

  // Common
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.save': 'Save',
  'common.loading': 'Loading…',
  'common.error': 'Error',
} as const;

export type ShellTranslationKey = keyof typeof en;

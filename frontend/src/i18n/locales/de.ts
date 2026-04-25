/**
 * German shell strings.
 *
 * Keys mirror `en.ts`. Missing keys fall back to English, then to the
 * key itself — so a missed entry surfaces as visible debug output.
 *
 * Variant choice: standard German (Hochdeutsch). The locale code stays
 * as `de` (matching the `en`/`es`/`pt`/`fr` base-language convention);
 * region-tagged variants like `de-AT` and `de-CH` collapse back to `de`
 * via `resolveLocale`.
 */

import type { ShellTranslationKey } from './en';

export const de: Partial<Record<ShellTranslationKey, string>> = {
  // Navigation
  'nav.home': 'Startseite',
  'nav.documentation': 'Dokumentation',
  'nav.examples': 'Beispiele',
  'nav.editor': 'Editor',
  'nav.about': 'Über',

  // Header buttons
  'header.share': 'Teilen',
  'header.share.title': 'Projekt teilen',
  'header.templates': 'Vorlagen',
  'header.templates.title': 'Neu aus Vorlage',
  'header.plugins': 'Plugins',
  'header.plugins.title': 'Installierte Plugins',
  'header.signIn': 'Anmelden',
  'header.signUp': 'Registrieren',
  'header.myProjects': 'Meine Projekte',
  'header.signOut': 'Abmelden',
  'header.toggleMenu': 'Menü umschalten',

  // Installed Plugins modal
  'plugins.title': 'Installierte Plugins',
  'plugins.refresh': 'Aktualisieren',
  'plugins.marketplace': 'Marketplace →',
  'plugins.close': 'Schließen',
  'plugins.empty': 'Noch keine Plugins installiert — durchsuchen Sie den Marketplace, um eines hinzuzufügen.',
  'plugins.empty.title': 'Keine Plugins installiert',
  'plugins.empty.body': 'Plugins erweitern Velxio um neue Komponenten, Simulationen, Vorlagen und Werkzeuge.',
  'plugins.empty.cta': 'Marketplace durchsuchen →',
  'plugins.language': 'Sprache',
  'plugins.uninstall.title': '{name} deinstallieren?',
  'plugins.uninstall.body1': 'Dies entfernt das Plugin aus dieser Editor-Sitzung. Komponenten, Vorlagen und andere Registrierungen, die es bereitgestellt hat, verschwinden sofort.',
  'plugins.uninstall.body2': 'Ihr Kauf bleibt gültig — Sie können es jederzeit über den Marketplace neu installieren.',
  'plugins.uninstall.confirm': 'Deinstallieren',
  'plugins.settings.title': '{name} — Einstellungen',
  'plugins.settings.empty': 'Dieses Plugin hat noch keine Einstellungen deklariert. Wenn es aufruft',
  'plugins.settings.metadata': 'Plugin-Metadaten',
  'plugins.toast.title': 'Aktuelle Plugin-Updates',
  'plugins.toast.summary': '{count} Plugin aktualisiert',
  'plugins.toast.summary.plural': '{count} Plugins aktualisiert',
  'plugins.toast.entry': '{name} auf {version} aktualisiert',
  'plugins.toast.entry.permissions': '+ {count} neue Berechtigung',
  'plugins.toast.entry.permissions.plural': '+ {count} neue Berechtigungen',
  'plugins.toast.dismiss': 'Verwerfen',
  'plugins.toast.dismissAll': 'Alle verwerfen',
  'plugins.toast.expand': 'Details anzeigen',
  'plugins.toast.collapse': 'Details ausblenden',

  // File explorer (left sidebar)
  'fileExplorer.workspace': 'ARBEITSBEREICH',
  'fileExplorer.saveProject.title': 'Projekt speichern (Strg+S)',
  'fileExplorer.boardHeader.title': '{board} — zum Bearbeiten klicken',
  'fileExplorer.collapse': 'Einklappen',
  'fileExplorer.expand': 'Ausklappen',
  'fileExplorer.status.running': 'Läuft',
  'fileExplorer.status.compiled': 'Kompiliert',
  'fileExplorer.status.idle': 'Inaktiv',
  'fileExplorer.newFile.title': 'Neue Datei auf diesem Board',
  'fileExplorer.newFile.placeholder': 'datei.ino',
  'fileExplorer.unsaved.suffix': ' (nicht gespeichert)',
  'fileExplorer.unsaved.title': 'Nicht gespeicherte Änderungen',
  'fileExplorer.delete.confirm': 'Diese Datei löschen?',
  'fileExplorer.empty': 'Fügen Sie ein Board zum Canvas hinzu, um mit der Code-Bearbeitung zu beginnen.',
  'fileExplorer.contextMenu.rename': 'Umbenennen',
  'fileExplorer.contextMenu.delete': 'Löschen',

  // Save project modal
  'saveProject.title.create': 'Projekt speichern',
  'saveProject.title.update': 'Projekt aktualisieren',
  'saveProject.label.name': 'Projektname *',
  'saveProject.label.description': 'Beschreibung',
  'saveProject.placeholder.name': 'Mein tolles Projekt',
  'saveProject.placeholder.description': 'Optional',
  'saveProject.visibility.public': 'Öffentlich',
  'saveProject.visibility.private': 'Privat',
  'saveProject.visibility.publicDescription': 'Jeder mit dem Link kann es sehen',
  'saveProject.visibility.privateDescription': 'Nur Sie können es sehen',
  'saveProject.button.save': 'Speichern',
  'saveProject.button.update': 'Aktualisieren',
  'saveProject.button.saving': 'Speichern…',
  'saveProject.error.nameRequired': 'Projektname ist erforderlich.',
  'saveProject.error.unreachable': 'Server nicht erreichbar. Bitte überprüfen Sie Ihre Verbindung und versuchen Sie es erneut.',
  'saveProject.error.notAuthenticated': 'Nicht authentifiziert. Bitte melden Sie sich an und versuchen Sie es erneut.',
  'saveProject.error.saveFailed': 'Speichern fehlgeschlagen ({status}).',

  // Login prompt modal (prompts anon users when they try to save)
  'loginPrompt.title': 'Melden Sie sich an, um Ihr Projekt zu speichern',
  'loginPrompt.body': 'Erstellen Sie ein kostenloses Konto, um Ihre Projekte zu speichern und zu teilen.',
  'loginPrompt.createAccount': 'Konto erstellen',

  // Template picker
  'templates.title': 'Neu aus Vorlage',
  'templates.empty': 'Noch keine Vorlagen installiert — durchsuchen Sie den Marketplace, um eine hinzuzufügen.',
  'templates.instantiate': 'Diese Vorlage verwenden',
  'templates.cancel': 'Abbrechen',
  'templates.preview': 'Vorschau',
  'templates.close': 'Schließen',
  'templates.builtIn': 'integriert',
  'templates.viaPlugin': 'über {id}',
  'templates.selectPrompt': 'Wählen Sie eine Vorlage zur Vorschau aus.',
  'templates.readme': 'Liesmich',
  'templates.replaceWarning': 'Dies ersetzt den aktuellen Sketch und das Canvas.',
  'templates.difficultyLabel': 'Schwierigkeit {level} von 5',
  'templates.empty.title': 'Noch keine Vorlagen installiert',
  'templates.empty.body':
    'Installieren Sie ein Plugin aus dem Marketplace, um Starter-Projekte zu dieser Liste hinzuzufügen.',
  'templates.empty.browse': 'Marketplace durchsuchen →',
  'templates.category.beginner': 'Anfänger',
  'templates.category.intermediate': 'Fortgeschritten',
  'templates.category.advanced': 'Experte',
  'templates.category.showcase': 'Vorzeige',

  // Editor toolbar (compile / run / overflow / library hint / status messages)
  'editorToolbar.board.editing': 'Bearbeitung: {board}',
  'editorToolbar.board.running': 'Läuft',
  'editorToolbar.board.languageMode': 'Sprachmodus',
  'editorToolbar.compile.addBoard': 'Fügen Sie ein Board zum Kompilieren hinzu',
  'editorToolbar.compile.loading': 'Wird geladen…',
  'editorToolbar.compile.loadMicroPython': 'MicroPython laden',
  'editorToolbar.compile.title': 'Kompilieren (Strg+B)',
  'editorToolbar.run.addBoard': 'Fügen Sie ein Board zum Ausführen hinzu',
  'editorToolbar.run.runMicroPython': 'MicroPython ausführen',
  'editorToolbar.run.title': 'Ausführen (kompiliert automatisch falls nötig)',
  'editorToolbar.stop.title': 'Stoppen',
  'editorToolbar.reset.title': 'Zurücksetzen',
  'editorToolbar.compileAll.title': 'Alle Boards kompilieren',
  'editorToolbar.runAll.title': 'Alle Boards ausführen',
  'editorToolbar.libraries.title': 'Arduino-Bibliotheken suchen und installieren',
  'editorToolbar.libraries.label': 'Bibliotheken',
  'editorToolbar.overflow.title': 'Importieren / Exportieren',
  'editorToolbar.overflow.import': 'Zip importieren',
  'editorToolbar.overflow.export': 'Als Zip exportieren',
  'editorToolbar.overflow.uploadFirmware': 'Firmware hochladen (.hex, .bin, .elf)',
  'editorToolbar.console.title': 'Ausgabekonsole umschalten',
  'editorToolbar.libHint.text': 'Fehlt eine Bibliothek? Installieren Sie sie über den',
  'editorToolbar.libHint.button': 'Bibliotheksmanager',
  'editorToolbar.libHint.dismiss': 'Verwerfen',
  'editorToolbar.message.ready': 'Bereit (keine Kompilierung erforderlich)',
  'editorToolbar.message.microPythonReady': 'MicroPython bereit',
  'editorToolbar.message.failedMicroPython': 'MicroPython konnte nicht geladen werden',
  'editorToolbar.message.unknownBoard': 'Unbekanntes Board',
  'editorToolbar.message.compiled': 'Erfolgreich kompiliert',
  'editorToolbar.message.compileFailed': 'Kompilierung fehlgeschlagen',
  'editorToolbar.message.exportFailed': 'Export fehlgeschlagen.',
  'editorToolbar.message.noBoard': 'Kein Board ausgewählt',
  'editorToolbar.message.firmwareLoaded': 'Firmware geladen: {name}',
  'editorToolbar.message.failedFirmware': 'Firmware konnte nicht geladen werden',
  'editorToolbar.message.imported': 'Importiert: {name}',
  'editorToolbar.message.importFailed': 'Import fehlgeschlagen.',
  'editorToolbar.log.piNoCompile':
    'Raspberry Pi 3B: keine Kompilierung erforderlich — führen Sie Python-Skripte direkt aus.',
  'editorToolbar.log.microPythonLoading': 'MicroPython: Firmware und Benutzerdateien werden geladen...',
  'editorToolbar.log.microPythonLoaded': 'MicroPython-Firmware erfolgreich geladen',
  'editorToolbar.log.microPythonLoadedShort': 'MicroPython-Firmware geladen',
  'editorToolbar.log.startCompile': 'Kompilierung wird gestartet für {board} ({fqbn})...',
  'editorToolbar.log.noFqbn': 'Kein FQBN für Board-Typ: {kind}',
  'editorToolbar.log.archMismatch':
    'Hinweis: Architektur {detected} erkannt, aber aktuelles Board ist {current}. Wird trotzdem geladen.',
  'editorToolbar.log.loadingFirmware': 'Firmware wird geladen: {name}...',

  // Common
  'common.cancel': 'Abbrechen',
  'common.confirm': 'Bestätigen',
  'common.save': 'Speichern',
  'common.loading': 'Wird geladen…',
  'common.error': 'Fehler',
};

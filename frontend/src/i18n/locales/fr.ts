/**
 * French shell strings.
 *
 * Keys mirror `en.ts`. Missing keys fall back to English, then to the
 * key itself — so a missed entry surfaces as visible debug output.
 *
 * Variant choice: standard French (Metropolitan). The locale code stays
 * as `fr` (matching the `en`/`es`/`pt` base-language convention);
 * region-tagged variants like `fr-CA` collapse back to `fr` via
 * `resolveLocale`.
 */

import type { ShellTranslationKey } from './en';

export const fr: Partial<Record<ShellTranslationKey, string>> = {
  // Navigation
  'nav.home': 'Accueil',
  'nav.documentation': 'Documentation',
  'nav.examples': 'Exemples',
  'nav.editor': 'Éditeur',
  'nav.about': 'À propos',

  // Header buttons
  'header.share': 'Partager',
  'header.share.title': 'Partager le projet',
  'header.templates': 'Modèles',
  'header.templates.title': 'Nouveau à partir d’un modèle',
  'header.plugins': 'Plugins',
  'header.plugins.title': 'Plugins installés',
  'header.signIn': 'Se connecter',
  'header.signUp': 'S’inscrire',
  'header.myProjects': 'Mes projets',
  'header.signOut': 'Se déconnecter',
  'header.toggleMenu': 'Basculer le menu',

  // Installed Plugins modal
  'plugins.title': 'Plugins installés',
  'plugins.refresh': 'Actualiser',
  'plugins.marketplace': 'Marketplace →',
  'plugins.close': 'Fermer',
  'plugins.empty': 'Aucun plugin installé pour l’instant — explorez le marketplace pour en ajouter un.',
  'plugins.empty.title': 'Aucun plugin installé',
  'plugins.empty.body': 'Les plugins étendent Velxio avec de nouveaux composants, simulations, modèles et outils.',
  'plugins.empty.cta': 'Explorer le marketplace →',
  'plugins.language': 'Langue',
  'plugins.uninstall.title': 'Désinstaller {name} ?',
  'plugins.uninstall.body1': 'Cela supprimera le plugin de cette session de l’éditeur. Les composants, modèles et autres enregistrements qu’il a fournis disparaîtront immédiatement.',
  'plugins.uninstall.body2': 'Votre achat reste valide — vous pouvez le réinstaller depuis le marketplace à tout moment.',
  'plugins.uninstall.confirm': 'Désinstaller',
  'plugins.settings.title': '{name} — Paramètres',
  'plugins.settings.empty': 'Ce plugin n’a pas encore déclaré de paramètres. Quand il appellera',
  'plugins.settings.metadata': 'Métadonnées du plugin',
  'plugins.toast.title': 'Mises à jour récentes des plugins',
  'plugins.toast.summary': '{count} plugin mis à jour',
  'plugins.toast.summary.plural': '{count} plugins mis à jour',
  'plugins.toast.entry': '{name} mis à jour vers {version}',
  'plugins.toast.entry.permissions': '+ {count} nouvelle permission',
  'plugins.toast.entry.permissions.plural': '+ {count} nouvelles permissions',
  'plugins.toast.dismiss': 'Ignorer',
  'plugins.toast.dismissAll': 'Tout ignorer',
  'plugins.toast.expand': 'Afficher les détails',
  'plugins.toast.collapse': 'Masquer les détails',

  // File explorer (left sidebar)
  'fileExplorer.workspace': 'ESPACE DE TRAVAIL',
  'fileExplorer.saveProject.title': 'Enregistrer le projet (Ctrl+S)',
  'fileExplorer.boardHeader.title': '{board} — cliquez pour modifier',
  'fileExplorer.collapse': 'Réduire',
  'fileExplorer.expand': 'Développer',
  'fileExplorer.status.running': 'En cours',
  'fileExplorer.status.compiled': 'Compilé',
  'fileExplorer.status.idle': 'Inactif',
  'fileExplorer.newFile.title': 'Nouveau fichier sur cette carte',
  'fileExplorer.newFile.placeholder': 'fichier.ino',
  'fileExplorer.unsaved.suffix': ' (non enregistré)',
  'fileExplorer.unsaved.title': 'Modifications non enregistrées',
  'fileExplorer.delete.confirm': 'Supprimer ce fichier ?',
  'fileExplorer.empty': 'Ajoutez une carte au canevas pour commencer à modifier le code.',
  'fileExplorer.contextMenu.rename': 'Renommer',
  'fileExplorer.contextMenu.delete': 'Supprimer',

  // Save project modal
  'saveProject.title.create': 'Enregistrer le projet',
  'saveProject.title.update': 'Mettre à jour le projet',
  'saveProject.label.name': 'Nom du projet *',
  'saveProject.label.description': 'Description',
  'saveProject.placeholder.name': 'Mon projet incroyable',
  'saveProject.placeholder.description': 'Optionnel',
  'saveProject.visibility.public': 'Public',
  'saveProject.visibility.private': 'Privé',
  'saveProject.visibility.publicDescription': 'Toute personne disposant du lien peut voir',
  'saveProject.visibility.privateDescription': 'Vous seul pouvez voir',
  'saveProject.button.save': 'Enregistrer',
  'saveProject.button.update': 'Mettre à jour',
  'saveProject.button.saving': 'Enregistrement…',
  'saveProject.error.nameRequired': 'Le nom du projet est obligatoire.',
  'saveProject.error.unreachable': 'Serveur inaccessible. Vérifiez votre connexion et réessayez.',
  'saveProject.error.notAuthenticated': 'Non authentifié. Connectez-vous et réessayez.',
  'saveProject.error.saveFailed': 'Échec de l’enregistrement ({status}).',

  // Login prompt modal (prompts anon users when they try to save)
  'loginPrompt.title': 'Connectez-vous pour enregistrer votre projet',
  'loginPrompt.body': 'Créez un compte gratuit pour enregistrer et partager vos projets.',
  'loginPrompt.createAccount': 'Créer un compte',

  // Template picker
  'templates.title': 'Nouveau à partir d’un modèle',
  'templates.empty': 'Aucun modèle installé pour l’instant — explorez le marketplace pour en ajouter un.',
  'templates.instantiate': 'Utiliser ce modèle',
  'templates.cancel': 'Annuler',
  'templates.preview': 'Aperçu',
  'templates.close': 'Fermer',
  'templates.builtIn': 'intégré',
  'templates.viaPlugin': 'via {id}',
  'templates.selectPrompt': 'Sélectionnez un modèle pour l’aperçu.',
  'templates.readme': 'Lisez-moi',
  'templates.replaceWarning': 'Cela remplace le sketch et le canevas actuels.',
  'templates.difficultyLabel': 'Difficulté {level} sur 5',
  'templates.empty.title': 'Aucun modèle installé pour l’instant',
  'templates.empty.body':
    'Installez un plugin depuis le marketplace pour ajouter des projets de démarrage à cette liste.',
  'templates.empty.browse': 'Explorer le marketplace →',
  'templates.category.beginner': 'Débutant',
  'templates.category.intermediate': 'Intermédiaire',
  'templates.category.advanced': 'Avancé',
  'templates.category.showcase': 'Vitrine',

  // Editor toolbar (compile / run / overflow / library hint / status messages)
  'editorToolbar.board.editing': 'Édition : {board}',
  'editorToolbar.board.running': 'En cours d’exécution',
  'editorToolbar.board.languageMode': 'Mode de langage',
  'editorToolbar.compile.addBoard': 'Ajoutez une carte pour compiler',
  'editorToolbar.compile.loading': 'Chargement…',
  'editorToolbar.compile.loadMicroPython': 'Charger MicroPython',
  'editorToolbar.compile.title': 'Compiler (Ctrl+B)',
  'editorToolbar.run.addBoard': 'Ajoutez une carte pour exécuter',
  'editorToolbar.run.runMicroPython': 'Exécuter MicroPython',
  'editorToolbar.run.title': 'Exécuter (compile automatiquement si nécessaire)',
  'editorToolbar.stop.title': 'Arrêter',
  'editorToolbar.reset.title': 'Réinitialiser',
  'editorToolbar.compileAll.title': 'Compiler toutes les cartes',
  'editorToolbar.runAll.title': 'Exécuter toutes les cartes',
  'editorToolbar.libraries.title': 'Rechercher et installer des bibliothèques Arduino',
  'editorToolbar.libraries.label': 'Bibliothèques',
  'editorToolbar.overflow.title': 'Importer / Exporter',
  'editorToolbar.overflow.import': 'Importer un zip',
  'editorToolbar.overflow.export': 'Exporter en zip',
  'editorToolbar.overflow.uploadFirmware': 'Téléverser le firmware (.hex, .bin, .elf)',
  'editorToolbar.console.title': 'Basculer la console de sortie',
  'editorToolbar.libHint.text': 'Une bibliothèque manque ? Installez-la depuis le',
  'editorToolbar.libHint.button': 'Gestionnaire de bibliothèques',
  'editorToolbar.libHint.dismiss': 'Ignorer',
  'editorToolbar.message.ready': 'Prêt (compilation non requise)',
  'editorToolbar.message.microPythonReady': 'MicroPython prêt',
  'editorToolbar.message.failedMicroPython': 'Échec du chargement de MicroPython',
  'editorToolbar.message.unknownBoard': 'Carte inconnue',
  'editorToolbar.message.compiled': 'Compilation réussie',
  'editorToolbar.message.compileFailed': 'Échec de la compilation',
  'editorToolbar.message.exportFailed': 'Échec de l’exportation.',
  'editorToolbar.message.noBoard': 'Aucune carte sélectionnée',
  'editorToolbar.message.firmwareLoaded': 'Firmware chargé : {name}',
  'editorToolbar.message.failedFirmware': 'Échec du chargement du firmware',
  'editorToolbar.message.imported': 'Importé {name}',
  'editorToolbar.message.importFailed': 'Échec de l’importation.',
  'editorToolbar.log.piNoCompile':
    'Raspberry Pi 3B : compilation non requise — exécutez les scripts Python directement.',
  'editorToolbar.log.microPythonLoading': 'MicroPython : chargement du firmware et des fichiers utilisateur...',
  'editorToolbar.log.microPythonLoaded': 'Firmware MicroPython chargé avec succès',
  'editorToolbar.log.microPythonLoadedShort': 'Firmware MicroPython chargé',
  'editorToolbar.log.startCompile': 'Démarrage de la compilation pour {board} ({fqbn})...',
  'editorToolbar.log.noFqbn': 'Aucun FQBN pour le type de carte : {kind}',
  'editorToolbar.log.archMismatch':
    'Note : architecture {detected} détectée, mais la carte actuelle est {current}. Chargement quand même.',
  'editorToolbar.log.loadingFirmware': 'Chargement du firmware : {name}...',

  // Common
  'common.cancel': 'Annuler',
  'common.confirm': 'Confirmer',
  'common.save': 'Enregistrer',
  'common.loading': 'Chargement…',
  'common.error': 'Erreur',
};

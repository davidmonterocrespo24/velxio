/**
 * Spanish shell strings.
 *
 * Keys mirror `en.ts`. Missing keys fall back to English, then to the
 * key itself — so a missed entry surfaces as visible debug output.
 */

import type { ShellTranslationKey } from './en';

export const es: Partial<Record<ShellTranslationKey, string>> = {
  // Navigation
  'nav.home': 'Inicio',
  'nav.documentation': 'Documentación',
  'nav.examples': 'Ejemplos',
  'nav.editor': 'Editor',
  'nav.about': 'Acerca de',

  // Header buttons
  'header.share': 'Compartir',
  'header.share.title': 'Compartir proyecto',
  'header.templates': 'Plantillas',
  'header.templates.title': 'Nuevo desde plantilla',
  'header.plugins': 'Plugins',
  'header.plugins.title': 'Plugins instalados',
  'header.signIn': 'Iniciar sesión',
  'header.signUp': 'Registrarse',
  'header.myProjects': 'Mis proyectos',
  'header.signOut': 'Cerrar sesión',
  'header.toggleMenu': 'Alternar menú',

  // Installed Plugins modal
  'plugins.title': 'Plugins instalados',
  'plugins.refresh': 'Actualizar',
  'plugins.marketplace': 'Marketplace →',
  'plugins.close': 'Cerrar',
  'plugins.empty': 'Aún no hay plugins instalados — explora el marketplace para añadir uno.',
  'plugins.empty.title': 'Sin plugins instalados',
  'plugins.empty.body': 'Los plugins amplían Velxio con nuevos componentes, simulaciones, plantillas y herramientas.',
  'plugins.empty.cta': 'Explorar el marketplace →',
  'plugins.language': 'Idioma',
  'plugins.uninstall.title': '¿Desinstalar {name}?',
  'plugins.uninstall.body1': 'Esto eliminará el plugin de la sesión actual del editor. Componentes, plantillas y demás registros que aportaba desaparecerán de inmediato.',
  'plugins.uninstall.body2': 'Tu compra sigue siendo válida — puedes reinstalarlo desde el marketplace cuando quieras.',
  'plugins.uninstall.confirm': 'Desinstalar',
  'plugins.settings.title': '{name} — Ajustes',
  'plugins.settings.empty': 'Este plugin todavía no ha declarado ajustes. Cuando llame a',
  'plugins.settings.metadata': 'Metadatos del plugin',

  // File explorer (left sidebar)
  'fileExplorer.workspace': 'ESPACIO DE TRABAJO',
  'fileExplorer.saveProject.title': 'Guardar proyecto (Ctrl+S)',
  'fileExplorer.boardHeader.title': '{board} — haz clic para editar',
  'fileExplorer.collapse': 'Contraer',
  'fileExplorer.expand': 'Expandir',
  'fileExplorer.status.running': 'Ejecutando',
  'fileExplorer.status.compiled': 'Compilado',
  'fileExplorer.status.idle': 'Inactivo',
  'fileExplorer.newFile.title': 'Nuevo archivo en esta placa',
  'fileExplorer.newFile.placeholder': 'nombre.ino',
  'fileExplorer.unsaved.suffix': ' (sin guardar)',
  'fileExplorer.unsaved.title': 'Cambios sin guardar',
  'fileExplorer.delete.confirm': '¿Eliminar este archivo?',
  'fileExplorer.empty': 'Añade una placa al canvas para empezar a editar código.',
  'fileExplorer.contextMenu.rename': 'Renombrar',
  'fileExplorer.contextMenu.delete': 'Eliminar',

  // Save project modal
  'saveProject.title.create': 'Guardar proyecto',
  'saveProject.title.update': 'Actualizar proyecto',
  'saveProject.label.name': 'Nombre del proyecto *',
  'saveProject.label.description': 'Descripción',
  'saveProject.placeholder.name': 'Mi proyecto increíble',
  'saveProject.placeholder.description': 'Opcional',
  'saveProject.visibility.public': 'Público',
  'saveProject.visibility.private': 'Privado',
  'saveProject.visibility.publicDescription': 'Cualquiera con el enlace puede ver',
  'saveProject.visibility.privateDescription': 'Solo tú puedes verlo',
  'saveProject.button.save': 'Guardar',
  'saveProject.button.update': 'Actualizar',
  'saveProject.button.saving': 'Guardando…',
  'saveProject.error.nameRequired': 'El nombre del proyecto es obligatorio.',
  'saveProject.error.unreachable': 'Servidor inaccesible. Comprueba tu conexión e inténtalo de nuevo.',
  'saveProject.error.notAuthenticated': 'Sin autenticar. Inicia sesión e inténtalo de nuevo.',
  'saveProject.error.saveFailed': 'Error al guardar ({status}).',

  // Login prompt modal (prompts anon users when they try to save)
  'loginPrompt.title': 'Inicia sesión para guardar tu proyecto',
  'loginPrompt.body': 'Crea una cuenta gratuita para guardar y compartir tus proyectos.',
  'loginPrompt.createAccount': 'Crear cuenta',

  // Template picker
  'templates.title': 'Nuevo desde plantilla',
  'templates.empty': 'Aún no hay plantillas instaladas — explora el marketplace para añadir una.',
  'templates.instantiate': 'Usar esta plantilla',
  'templates.cancel': 'Cancelar',
  'templates.preview': 'Vista previa',

  // Common
  'common.cancel': 'Cancelar',
  'common.confirm': 'Confirmar',
  'common.save': 'Guardar',
  'common.loading': 'Cargando…',
  'common.error': 'Error',
};

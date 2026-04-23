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

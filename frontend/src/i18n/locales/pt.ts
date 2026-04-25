/**
 * Portuguese (Brazilian) shell strings.
 *
 * Keys mirror `en.ts`. Missing keys fall back to English, then to the
 * key itself — so a missed entry surfaces as visible debug output.
 *
 * Variant choice: Brazilian Portuguese is the most widely-used variant
 * in the developer community. The locale code stays as `pt` (matching
 * the `es`/`en` base-language convention); region-tagged variants like
 * `pt-PT` collapse back to `pt` via `resolveLocale`.
 */

import type { ShellTranslationKey } from './en';

export const pt: Partial<Record<ShellTranslationKey, string>> = {
  // Navigation
  'nav.home': 'Início',
  'nav.documentation': 'Documentação',
  'nav.examples': 'Exemplos',
  'nav.editor': 'Editor',
  'nav.about': 'Sobre',

  // Header buttons
  'header.share': 'Compartilhar',
  'header.share.title': 'Compartilhar projeto',
  'header.templates': 'Modelos',
  'header.templates.title': 'Novo a partir de modelo',
  'header.plugins': 'Plugins',
  'header.plugins.title': 'Plugins instalados',
  'header.signIn': 'Entrar',
  'header.signUp': 'Cadastrar-se',
  'header.myProjects': 'Meus projetos',
  'header.signOut': 'Sair',
  'header.toggleMenu': 'Alternar menu',

  // Installed Plugins modal
  'plugins.title': 'Plugins instalados',
  'plugins.refresh': 'Atualizar',
  'plugins.marketplace': 'Marketplace →',
  'plugins.close': 'Fechar',
  'plugins.empty': 'Nenhum plugin instalado ainda — explore o marketplace para adicionar um.',
  'plugins.empty.title': 'Nenhum plugin instalado',
  'plugins.empty.body': 'Plugins estendem o Velxio com novos componentes, simulações, modelos e ferramentas.',
  'plugins.empty.cta': 'Explorar o marketplace →',
  'plugins.language': 'Idioma',
  'plugins.uninstall.title': 'Desinstalar {name}?',
  'plugins.uninstall.body1': 'Isso removerá o plugin desta sessão do editor. Componentes, modelos e outros registros que ele forneceu desaparecerão imediatamente.',
  'plugins.uninstall.body2': 'Sua compra continua válida — você pode reinstalar pelo marketplace a qualquer momento.',
  'plugins.uninstall.confirm': 'Desinstalar',
  'plugins.settings.title': '{name} — Configurações',
  'plugins.settings.empty': 'Este plugin ainda não declarou configurações. Quando ele chamar',
  'plugins.settings.metadata': 'Metadados do plugin',
  'plugins.toast.title': 'Atualizações recentes de plugins',
  'plugins.toast.summary': '{count} plugin atualizado',
  'plugins.toast.summary.plural': '{count} plugins atualizados',
  'plugins.toast.entry': '{name} atualizado para {version}',
  'plugins.toast.entry.permissions': '+ {count} nova permissão',
  'plugins.toast.entry.permissions.plural': '+ {count} novas permissões',
  'plugins.toast.dismiss': 'Dispensar',
  'plugins.toast.dismissAll': 'Dispensar tudo',
  'plugins.toast.expand': 'Mostrar detalhes',
  'plugins.toast.collapse': 'Ocultar detalhes',

  // File explorer (left sidebar)
  'fileExplorer.workspace': 'ÁREA DE TRABALHO',
  'fileExplorer.saveProject.title': 'Salvar projeto (Ctrl+S)',
  'fileExplorer.boardHeader.title': '{board} — clique para editar',
  'fileExplorer.collapse': 'Recolher',
  'fileExplorer.expand': 'Expandir',
  'fileExplorer.status.running': 'Executando',
  'fileExplorer.status.compiled': 'Compilado',
  'fileExplorer.status.idle': 'Inativo',
  'fileExplorer.newFile.title': 'Novo arquivo nesta placa',
  'fileExplorer.newFile.placeholder': 'arquivo.ino',
  'fileExplorer.unsaved.suffix': ' (não salvo)',
  'fileExplorer.unsaved.title': 'Alterações não salvas',
  'fileExplorer.delete.confirm': 'Excluir este arquivo?',
  'fileExplorer.empty': 'Adicione uma placa ao canvas para começar a editar código.',
  'fileExplorer.contextMenu.rename': 'Renomear',
  'fileExplorer.contextMenu.delete': 'Excluir',

  // Save project modal
  'saveProject.title.create': 'Salvar projeto',
  'saveProject.title.update': 'Atualizar projeto',
  'saveProject.label.name': 'Nome do projeto *',
  'saveProject.label.description': 'Descrição',
  'saveProject.placeholder.name': 'Meu projeto incrível',
  'saveProject.placeholder.description': 'Opcional',
  'saveProject.visibility.public': 'Público',
  'saveProject.visibility.private': 'Privado',
  'saveProject.visibility.publicDescription': 'Qualquer pessoa com o link pode ver',
  'saveProject.visibility.privateDescription': 'Só você pode ver',
  'saveProject.button.save': 'Salvar',
  'saveProject.button.update': 'Atualizar',
  'saveProject.button.saving': 'Salvando…',
  'saveProject.error.nameRequired': 'O nome do projeto é obrigatório.',
  'saveProject.error.unreachable': 'Servidor inacessível. Verifique sua conexão e tente novamente.',
  'saveProject.error.notAuthenticated': 'Não autenticado. Faça login e tente novamente.',
  'saveProject.error.saveFailed': 'Falha ao salvar ({status}).',

  // Login prompt modal (prompts anon users when they try to save)
  'loginPrompt.title': 'Entre para salvar seu projeto',
  'loginPrompt.body': 'Crie uma conta gratuita para salvar e compartilhar seus projetos.',
  'loginPrompt.createAccount': 'Criar conta',

  // Template picker
  'templates.title': 'Novo a partir de modelo',
  'templates.empty': 'Nenhum modelo instalado ainda — explore o marketplace para adicionar um.',
  'templates.instantiate': 'Usar este modelo',
  'templates.cancel': 'Cancelar',
  'templates.preview': 'Visualizar',
  'templates.close': 'Fechar',
  'templates.builtIn': 'integrado',
  'templates.viaPlugin': 'via {id}',
  'templates.selectPrompt': 'Selecione um modelo para visualizar.',
  'templates.readme': 'Leia-me',
  'templates.replaceWarning': 'Isso substitui o sketch e o canvas atuais.',
  'templates.difficultyLabel': 'Dificuldade {level} de 5',
  'templates.empty.title': 'Nenhum modelo instalado ainda',
  'templates.empty.body':
    'Instale um plugin do marketplace para adicionar projetos iniciais a esta lista.',
  'templates.empty.browse': 'Explorar marketplace →',
  'templates.category.beginner': 'Iniciante',
  'templates.category.intermediate': 'Intermediário',
  'templates.category.advanced': 'Avançado',
  'templates.category.showcase': 'Destaques',

  // Editor toolbar (compile / run / overflow / library hint / status messages)
  'editorToolbar.board.editing': 'Editando: {board}',
  'editorToolbar.board.running': 'Executando',
  'editorToolbar.board.languageMode': 'Modo de linguagem',
  'editorToolbar.compile.addBoard': 'Adicione uma placa para compilar',
  'editorToolbar.compile.loading': 'Carregando…',
  'editorToolbar.compile.loadMicroPython': 'Carregar MicroPython',
  'editorToolbar.compile.title': 'Compilar (Ctrl+B)',
  'editorToolbar.run.addBoard': 'Adicione uma placa para executar',
  'editorToolbar.run.runMicroPython': 'Executar MicroPython',
  'editorToolbar.run.title': 'Executar (compila automaticamente se necessário)',
  'editorToolbar.stop.title': 'Parar',
  'editorToolbar.reset.title': 'Reiniciar',
  'editorToolbar.compileAll.title': 'Compilar todas as placas',
  'editorToolbar.runAll.title': 'Executar todas as placas',
  'editorToolbar.libraries.title': 'Buscar e instalar bibliotecas Arduino',
  'editorToolbar.libraries.label': 'Bibliotecas',
  'editorToolbar.overflow.title': 'Importar / Exportar',
  'editorToolbar.overflow.import': 'Importar zip',
  'editorToolbar.overflow.export': 'Exportar zip',
  'editorToolbar.overflow.uploadFirmware': 'Enviar firmware (.hex, .bin, .elf)',
  'editorToolbar.console.title': 'Alternar console de saída',
  'editorToolbar.libHint.text': 'Falta uma biblioteca? Instale-a pelo',
  'editorToolbar.libHint.button': 'Gerenciador de bibliotecas',
  'editorToolbar.libHint.dismiss': 'Dispensar',
  'editorToolbar.message.ready': 'Pronto (não requer compilação)',
  'editorToolbar.message.microPythonReady': 'MicroPython pronto',
  'editorToolbar.message.failedMicroPython': 'Falha ao carregar MicroPython',
  'editorToolbar.message.unknownBoard': 'Placa desconhecida',
  'editorToolbar.message.compiled': 'Compilado com sucesso',
  'editorToolbar.message.compileFailed': 'Falha na compilação',
  'editorToolbar.message.exportFailed': 'Falha na exportação.',
  'editorToolbar.message.noBoard': 'Nenhuma placa selecionada',
  'editorToolbar.message.firmwareLoaded': 'Firmware carregado: {name}',
  'editorToolbar.message.failedFirmware': 'Falha ao carregar firmware',
  'editorToolbar.message.imported': 'Importado {name}',
  'editorToolbar.message.importFailed': 'Falha na importação.',
  'editorToolbar.log.piNoCompile':
    'Raspberry Pi 3B: não requer compilação — execute scripts Python diretamente.',
  'editorToolbar.log.microPythonLoading': 'MicroPython: carregando firmware e arquivos do usuário...',
  'editorToolbar.log.microPythonLoaded': 'Firmware MicroPython carregado com sucesso',
  'editorToolbar.log.microPythonLoadedShort': 'Firmware MicroPython carregado',
  'editorToolbar.log.startCompile': 'Iniciando compilação para {board} ({fqbn})...',
  'editorToolbar.log.noFqbn': 'Sem FQBN para o tipo de placa: {kind}',
  'editorToolbar.log.archMismatch':
    'Nota: Arquitetura {detected} detectada, mas a placa atual é {current}. Carregando mesmo assim.',
  'editorToolbar.log.loadingFirmware': 'Carregando firmware: {name}...',

  // Common
  'common.cancel': 'Cancelar',
  'common.confirm': 'Confirmar',
  'common.save': 'Salvar',
  'common.loading': 'Carregando…',
  'common.error': 'Erro',
};

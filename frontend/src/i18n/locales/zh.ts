/**
 * Simplified Chinese shell strings.
 *
 * Keys mirror `en.ts`. Missing keys fall back to English, then to the
 * key itself — so a missed entry surfaces as visible debug output.
 *
 * Variant choice: Simplified Chinese (Mainland China — zh-CN / zh-Hans)
 * is the most widely-used variant in the developer community. The
 * locale code stays as `zh` (matching the `en`/`es`/`pt`/`fr`/`de`/`ja`
 * base-language convention); region/script-tagged variants like
 * `zh-CN`, `zh-SG`, `zh-Hans` and even `zh-TW` / `zh-Hant` collapse
 * back to `zh` via `resolveLocale`. Traditional Chinese ships when
 * a `zh-TW` / `zh-Hant` locale file is added (separate follow-up).
 *
 * Style notes: terminology follows the established CN dev tooling
 * conventions — 插件 (plugin), 模板 (template), 开发板 (board),
 * 编译 (compile). Punctuation: full-width 「？」 inside translated
 * UI strings, half-width inside code-like contexts.
 */

import type { ShellTranslationKey } from './en';

export const zh: Partial<Record<ShellTranslationKey, string>> = {
  // Navigation
  'nav.home': '主页',
  'nav.documentation': '文档',
  'nav.examples': '示例',
  'nav.editor': '编辑器',
  'nav.about': '关于',

  // Header buttons
  'header.share': '分享',
  'header.share.title': '分享项目',
  'header.templates': '模板',
  'header.templates.title': '从模板新建',
  'header.plugins': '插件',
  'header.plugins.title': '已安装的插件',
  'header.signIn': '登录',
  'header.signUp': '注册',
  'header.myProjects': '我的项目',
  'header.signOut': '退出登录',
  'header.toggleMenu': '切换菜单',

  // Installed Plugins modal
  'plugins.title': '已安装的插件',
  'plugins.refresh': '刷新',
  'plugins.marketplace': '市场 →',
  'plugins.close': '关闭',
  'plugins.empty': '尚未安装任何插件 — 浏览市场以添加。',
  'plugins.empty.title': '尚未安装任何插件',
  'plugins.empty.body': '插件通过新的元件、仿真、模板和工具扩展 Velxio。',
  'plugins.empty.cta': '浏览市场 →',
  'plugins.language': '语言',
  'plugins.uninstall.title': '卸载 {name}？',
  'plugins.uninstall.body1': '这将从此编辑器会话中移除插件。它提供的元件、模板和其他注册项将立即消失。',
  'plugins.uninstall.body2': '您的购买仍然有效 — 您可以随时从市场重新安装。',
  'plugins.uninstall.confirm': '卸载',
  'plugins.settings.title': '{name} — 设置',
  'plugins.settings.empty': '此插件尚未声明设置。当它调用以下方法时',
  'plugins.settings.metadata': '插件元数据',
  'plugins.toast.title': '最近的插件更新',
  'plugins.toast.summary': '已更新 {count} 个插件',
  'plugins.toast.summary.plural': '已更新 {count} 个插件',
  'plugins.toast.entry': '已将 {name} 更新到 {version}',
  'plugins.toast.entry.permissions': '+ {count} 项新权限',
  'plugins.toast.entry.permissions.plural': '+ {count} 项新权限',
  'plugins.toast.dismiss': '关闭',
  'plugins.toast.dismissAll': '全部关闭',
  'plugins.toast.expand': '显示详情',
  'plugins.toast.collapse': '隐藏详情',

  // File explorer (left sidebar)
  'fileExplorer.workspace': '工作区',
  'fileExplorer.saveProject.title': '保存项目 (Ctrl+S)',
  'fileExplorer.boardHeader.title': '{board} — 点击以编辑',
  'fileExplorer.collapse': '折叠',
  'fileExplorer.expand': '展开',
  'fileExplorer.status.running': '运行中',
  'fileExplorer.status.compiled': '已编译',
  'fileExplorer.status.idle': '空闲',
  'fileExplorer.newFile.title': '在此开发板上新建文件',
  'fileExplorer.newFile.placeholder': 'file.ino',
  'fileExplorer.unsaved.suffix': '（未保存）',
  'fileExplorer.unsaved.title': '未保存的更改',
  'fileExplorer.delete.confirm': '删除此文件？',
  'fileExplorer.empty': '将开发板添加到画布以开始编辑代码。',
  'fileExplorer.contextMenu.rename': '重命名',
  'fileExplorer.contextMenu.delete': '删除',

  // Save project modal
  'saveProject.title.create': '保存项目',
  'saveProject.title.update': '更新项目',
  'saveProject.label.name': '项目名称 *',
  'saveProject.label.description': '描述',
  'saveProject.placeholder.name': '我的精彩项目',
  'saveProject.placeholder.description': '可选',
  'saveProject.visibility.public': '公开',
  'saveProject.visibility.private': '私有',
  'saveProject.visibility.publicDescription': '任何拥有链接的人都可以查看',
  'saveProject.visibility.privateDescription': '仅您可以查看',
  'saveProject.button.save': '保存',
  'saveProject.button.update': '更新',
  'saveProject.button.saving': '正在保存…',
  'saveProject.error.nameRequired': '项目名称为必填项。',
  'saveProject.error.unreachable': '服务器无法访问。请检查您的连接并重试。',
  'saveProject.error.notAuthenticated': '未通过身份验证。请登录后重试。',
  'saveProject.error.saveFailed': '保存失败 ({status})。',

  // Login prompt modal (prompts anon users when they try to save)
  'loginPrompt.title': '登录以保存您的项目',
  'loginPrompt.body': '创建免费账户以保存和分享您的项目。',
  'loginPrompt.createAccount': '创建账户',

  // Template picker
  'templates.title': '从模板新建',
  'templates.empty': '尚未安装任何模板 — 浏览市场以添加。',
  'templates.instantiate': '使用此模板',
  'templates.cancel': '取消',
  'templates.preview': '预览',
  'templates.close': '关闭',
  'templates.builtIn': '内置',
  'templates.viaPlugin': '通过 {id}',
  'templates.selectPrompt': '选择一个模板进行预览。',
  'templates.readme': '自述',
  'templates.replaceWarning': '这将替换当前的 sketch 和画布。',
  'templates.difficultyLabel': '难度 {level} / 5',
  'templates.empty.title': '尚未安装任何模板',
  'templates.empty.body':
    '从市场安装插件以将入门项目添加到此列表。',
  'templates.empty.browse': '浏览市场 →',
  'templates.category.beginner': '初级',
  'templates.category.intermediate': '中级',
  'templates.category.advanced': '高级',
  'templates.category.showcase': '精选',

  // Editor toolbar (compile / run / overflow / library hint / status messages)
  'editorToolbar.board.editing': '正在编辑：{board}',
  'editorToolbar.board.running': '运行中',
  'editorToolbar.board.languageMode': '语言模式',
  'editorToolbar.compile.addBoard': '添加开发板以编译',
  'editorToolbar.compile.loading': '加载中…',
  'editorToolbar.compile.loadMicroPython': '加载 MicroPython',
  'editorToolbar.compile.title': '编译 (Ctrl+B)',
  'editorToolbar.run.addBoard': '添加开发板以运行',
  'editorToolbar.run.runMicroPython': '运行 MicroPython',
  'editorToolbar.run.title': '运行（如有需要会自动编译）',
  'editorToolbar.stop.title': '停止',
  'editorToolbar.reset.title': '重置',
  'editorToolbar.compileAll.title': '编译所有开发板',
  'editorToolbar.runAll.title': '运行所有开发板',
  'editorToolbar.libraries.title': '搜索并安装 Arduino 库',
  'editorToolbar.libraries.label': '库',
  'editorToolbar.overflow.title': '导入 / 导出',
  'editorToolbar.overflow.import': '导入 zip',
  'editorToolbar.overflow.export': '导出 zip',
  'editorToolbar.overflow.uploadFirmware': '上传固件 (.hex, .bin, .elf)',
  'editorToolbar.console.title': '切换输出控制台',
  'editorToolbar.libHint.text': '缺少库？请通过以下方式安装',
  'editorToolbar.libHint.button': '库管理器',
  'editorToolbar.libHint.dismiss': '关闭',
  'editorToolbar.message.ready': '就绪（无需编译）',
  'editorToolbar.message.microPythonReady': 'MicroPython 就绪',
  'editorToolbar.message.failedMicroPython': '加载 MicroPython 失败',
  'editorToolbar.message.unknownBoard': '未知开发板',
  'editorToolbar.message.compiled': '编译成功',
  'editorToolbar.message.compileFailed': '编译失败',
  'editorToolbar.message.exportFailed': '导出失败。',
  'editorToolbar.message.noBoard': '未选择开发板',
  'editorToolbar.message.firmwareLoaded': '已加载固件：{name}',
  'editorToolbar.message.failedFirmware': '加载固件失败',
  'editorToolbar.message.imported': '已导入 {name}',
  'editorToolbar.message.importFailed': '导入失败。',
  'editorToolbar.log.piNoCompile':
    'Raspberry Pi 3B：无需编译 — 直接执行 Python 脚本。',
  'editorToolbar.log.microPythonLoading': 'MicroPython：正在加载固件和用户文件…',
  'editorToolbar.log.microPythonLoaded': 'MicroPython 固件加载成功',
  'editorToolbar.log.microPythonLoadedShort': '已加载 MicroPython 固件',
  'editorToolbar.log.startCompile': '正在为 {board} ({fqbn}) 启动编译…',
  'editorToolbar.log.noFqbn': '开发板类型没有 FQBN：{kind}',
  'editorToolbar.log.archMismatch':
    '注意：检测到架构 {detected}，但当前开发板为 {current}。仍将加载。',
  'editorToolbar.log.loadingFirmware': '正在加载固件：{name}…',

  // Common
  'common.cancel': '取消',
  'common.confirm': '确认',
  'common.save': '保存',
  'common.loading': '加载中…',
  'common.error': '错误',
};

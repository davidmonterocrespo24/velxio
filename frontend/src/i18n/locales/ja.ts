/**
 * Japanese shell strings.
 *
 * Keys mirror `en.ts`. Missing keys fall back to English, then to the
 * key itself — so a missed entry surfaces as visible debug output.
 *
 * Variant choice: standard Japanese (no regional variants — Japanese
 * has no widely-used region tags). The locale code stays as `ja`
 * (matching the `en`/`es`/`pt`/`fr`/`de` base-language convention);
 * region-tagged variants like `ja-JP` collapse back to `ja` via
 * `resolveLocale`.
 *
 * Style notes: uses 「ですます」 (polite form) throughout for UI
 * consistency. Loanwords like プラグイン (plugin), マーケットプレイス
 * (marketplace), ボード (board) follow established katakana
 * conventions in the dev tooling space. Punctuation: full-width
 * question mark 「？」 inside translated UI strings, half-width inside
 * code-like contexts.
 */

import type { ShellTranslationKey } from './en';

export const ja: Partial<Record<ShellTranslationKey, string>> = {
  // Navigation
  'nav.home': 'ホーム',
  'nav.documentation': 'ドキュメント',
  'nav.examples': 'サンプル',
  'nav.editor': 'エディタ',
  'nav.about': '概要',

  // Header buttons
  'header.share': '共有',
  'header.share.title': 'プロジェクトを共有',
  'header.templates': 'テンプレート',
  'header.templates.title': 'テンプレートから新規作成',
  'header.plugins': 'プラグイン',
  'header.plugins.title': 'インストール済みプラグイン',
  'header.signIn': 'ログイン',
  'header.signUp': '新規登録',
  'header.myProjects': 'マイプロジェクト',
  'header.signOut': 'ログアウト',
  'header.toggleMenu': 'メニューを切り替え',

  // Installed Plugins modal
  'plugins.title': 'インストール済みプラグイン',
  'plugins.refresh': '更新',
  'plugins.marketplace': 'マーケットプレイス →',
  'plugins.close': '閉じる',
  'plugins.empty': 'まだプラグインがインストールされていません。マーケットプレイスから追加してください。',
  'plugins.empty.title': 'プラグインがインストールされていません',
  'plugins.empty.body': 'プラグインは、新しいコンポーネント、シミュレーション、テンプレート、ツールで Velxio を拡張します。',
  'plugins.empty.cta': 'マーケットプレイスを見る →',
  'plugins.language': '言語',
  'plugins.uninstall.title': '{name} をアンインストールしますか？',
  'plugins.uninstall.body1': 'このエディタセッションからプラグインを削除します。提供されているコンポーネント、テンプレート、その他の登録は直ちに消えます。',
  'plugins.uninstall.body2': 'ご購入は引き続き有効です。マーケットプレイスからいつでも再インストールできます。',
  'plugins.uninstall.confirm': 'アンインストール',
  'plugins.settings.title': '{name} — 設定',
  'plugins.settings.empty': 'このプラグインはまだ設定を宣言していません。次の呼び出し時に表示されます',
  'plugins.settings.metadata': 'プラグインのメタデータ',
  'plugins.toast.title': '最近のプラグイン更新',
  'plugins.toast.summary': '{count} 個のプラグインを更新しました',
  'plugins.toast.summary.plural': '{count} 個のプラグインを更新しました',
  'plugins.toast.entry': '{name} を {version} に更新しました',
  'plugins.toast.entry.permissions': '+ {count} 個の新しい権限',
  'plugins.toast.entry.permissions.plural': '+ {count} 個の新しい権限',
  'plugins.toast.dismiss': '閉じる',
  'plugins.toast.dismissAll': 'すべて閉じる',
  'plugins.toast.expand': '詳細を表示',
  'plugins.toast.collapse': '詳細を非表示',

  // File explorer (left sidebar)
  'fileExplorer.workspace': 'ワークスペース',
  'fileExplorer.saveProject.title': 'プロジェクトを保存 (Ctrl+S)',
  'fileExplorer.boardHeader.title': '{board} — クリックして編集',
  'fileExplorer.collapse': '折りたたむ',
  'fileExplorer.expand': '展開',
  'fileExplorer.status.running': '実行中',
  'fileExplorer.status.compiled': 'コンパイル済み',
  'fileExplorer.status.idle': 'アイドル',
  'fileExplorer.newFile.title': 'このボードに新規ファイル',
  'fileExplorer.newFile.placeholder': 'file.ino',
  'fileExplorer.unsaved.suffix': ' (未保存)',
  'fileExplorer.unsaved.title': '未保存の変更',
  'fileExplorer.delete.confirm': 'このファイルを削除しますか？',
  'fileExplorer.empty': 'コードの編集を開始するには、ボードをキャンバスに追加してください。',
  'fileExplorer.contextMenu.rename': '名前を変更',
  'fileExplorer.contextMenu.delete': '削除',

  // Save project modal
  'saveProject.title.create': 'プロジェクトを保存',
  'saveProject.title.update': 'プロジェクトを更新',
  'saveProject.label.name': 'プロジェクト名 *',
  'saveProject.label.description': '説明',
  'saveProject.placeholder.name': '私の素晴らしいプロジェクト',
  'saveProject.placeholder.description': '任意',
  'saveProject.visibility.public': '公開',
  'saveProject.visibility.private': '非公開',
  'saveProject.visibility.publicDescription': 'リンクを知っている人なら誰でも閲覧可能',
  'saveProject.visibility.privateDescription': '自分のみ閲覧可能',
  'saveProject.button.save': '保存',
  'saveProject.button.update': '更新',
  'saveProject.button.saving': '保存中…',
  'saveProject.error.nameRequired': 'プロジェクト名は必須です。',
  'saveProject.error.unreachable': 'サーバーに接続できません。接続を確認して再試行してください。',
  'saveProject.error.notAuthenticated': '認証されていません。ログインして再試行してください。',
  'saveProject.error.saveFailed': '保存に失敗しました ({status})。',

  // Login prompt modal (prompts anon users when they try to save)
  'loginPrompt.title': 'プロジェクトを保存するにはログインしてください',
  'loginPrompt.body': 'プロジェクトの保存と共有のために無料アカウントを作成してください。',
  'loginPrompt.createAccount': 'アカウントを作成',

  // Template picker
  'templates.title': 'テンプレートから新規作成',
  'templates.empty': 'まだテンプレートがインストールされていません。マーケットプレイスから追加してください。',
  'templates.instantiate': 'このテンプレートを使用',
  'templates.cancel': 'キャンセル',
  'templates.preview': 'プレビュー',
  'templates.close': '閉じる',
  'templates.builtIn': '組み込み',
  'templates.viaPlugin': '{id} 経由',
  'templates.selectPrompt': 'プレビューするテンプレートを選択してください。',
  'templates.readme': 'お読みください',
  'templates.replaceWarning': '現在のスケッチとキャンバスを置き換えます。',
  'templates.difficultyLabel': '難易度 {level} / 5',
  'templates.empty.title': 'まだテンプレートがインストールされていません',
  'templates.empty.body':
    'マーケットプレイスからプラグインをインストールして、このリストにスターター プロジェクトを追加してください。',
  'templates.empty.browse': 'マーケットプレイスを見る →',
  'templates.category.beginner': '初心者',
  'templates.category.intermediate': '中級',
  'templates.category.advanced': '上級',
  'templates.category.showcase': 'ショーケース',

  // Editor toolbar (compile / run / overflow / library hint / status messages)
  'editorToolbar.board.editing': '編集中: {board}',
  'editorToolbar.board.running': '実行中',
  'editorToolbar.board.languageMode': '言語モード',
  'editorToolbar.compile.addBoard': 'コンパイルするにはボードを追加してください',
  'editorToolbar.compile.loading': '読み込み中…',
  'editorToolbar.compile.loadMicroPython': 'MicroPython を読み込む',
  'editorToolbar.compile.title': 'コンパイル (Ctrl+B)',
  'editorToolbar.run.addBoard': '実行するにはボードを追加してください',
  'editorToolbar.run.runMicroPython': 'MicroPython を実行',
  'editorToolbar.run.title': '実行 (必要に応じて自動コンパイル)',
  'editorToolbar.stop.title': '停止',
  'editorToolbar.reset.title': 'リセット',
  'editorToolbar.compileAll.title': 'すべてのボードをコンパイル',
  'editorToolbar.runAll.title': 'すべてのボードを実行',
  'editorToolbar.libraries.title': 'Arduino ライブラリを検索してインストール',
  'editorToolbar.libraries.label': 'ライブラリ',
  'editorToolbar.overflow.title': 'インポート / エクスポート',
  'editorToolbar.overflow.import': 'zip をインポート',
  'editorToolbar.overflow.export': 'zip をエクスポート',
  'editorToolbar.overflow.uploadFirmware': 'ファームウェアをアップロード (.hex, .bin, .elf)',
  'editorToolbar.console.title': '出力コンソールを切り替え',
  'editorToolbar.libHint.text': 'ライブラリが見つかりませんか？以下からインストールしてください',
  'editorToolbar.libHint.button': 'ライブラリマネージャ',
  'editorToolbar.libHint.dismiss': '閉じる',
  'editorToolbar.message.ready': '準備完了 (コンパイル不要)',
  'editorToolbar.message.microPythonReady': 'MicroPython 準備完了',
  'editorToolbar.message.failedMicroPython': 'MicroPython の読み込みに失敗しました',
  'editorToolbar.message.unknownBoard': '不明なボード',
  'editorToolbar.message.compiled': 'コンパイル成功',
  'editorToolbar.message.compileFailed': 'コンパイル失敗',
  'editorToolbar.message.exportFailed': 'エクスポートに失敗しました。',
  'editorToolbar.message.noBoard': 'ボードが選択されていません',
  'editorToolbar.message.firmwareLoaded': 'ファームウェアを読み込みました: {name}',
  'editorToolbar.message.failedFirmware': 'ファームウェアの読み込みに失敗しました',
  'editorToolbar.message.imported': 'インポートしました: {name}',
  'editorToolbar.message.importFailed': 'インポートに失敗しました。',
  'editorToolbar.log.piNoCompile':
    'Raspberry Pi 3B: コンパイル不要 — Python スクリプトを直接実行してください。',
  'editorToolbar.log.microPythonLoading': 'MicroPython: ファームウェアとユーザーファイルを読み込み中...',
  'editorToolbar.log.microPythonLoaded': 'MicroPython ファームウェアの読み込みに成功しました',
  'editorToolbar.log.microPythonLoadedShort': 'MicroPython ファームウェアを読み込みました',
  'editorToolbar.log.startCompile': '{board} ({fqbn}) のコンパイルを開始しています...',
  'editorToolbar.log.noFqbn': 'ボードタイプの FQBN がありません: {kind}',
  'editorToolbar.log.archMismatch':
    '注意: アーキテクチャ {detected} を検出しましたが、現在のボードは {current} です。それでも読み込みます。',
  'editorToolbar.log.loadingFirmware': 'ファームウェアを読み込み中: {name}...',

  // Common
  'common.cancel': 'キャンセル',
  'common.confirm': '確認',
  'common.save': '保存',
  'common.loading': '読み込み中…',
  'common.error': 'エラー',
};

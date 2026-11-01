import { ref, computed } from 'vue'

export type SupportedLanguage = 'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP'

export const currentLanguage = ref<SupportedLanguage>('zh-CN')

const messages: Record<SupportedLanguage, Record<string, string>> = {
  'zh-CN': {
    // 侧边栏与导航
    'nav.newChat': '新对话',
    'nav.cowork': '协同模式',
    'nav.code': '代码模式',
    'nav.settings': '偏好设置',
    'nav.history': '会话历史',

    // 模式与自治
    'mode.auto': '智能模式',
    'mode.wish': '许愿模式',
    'mode.builder': '建造者',
    'mode.chat': '问答模式',
    'autonomy.strict': '严格确认',
    'autonomy.balanced': '智能自治',
    'autonomy.trusted': '完全信任',

    // 上下文窗口
    'context.window': '上下文窗口',
    'context.mcpTools': 'MCP 工具',
    'context.systemTools': '系统工具',
    'context.skills': '技能',
    'context.systemPrompt': '系统提示词',
    'context.memoryFiles': '记忆文件',
    'context.messages': '会话消息',
    'context.freeSpace': '剩余空间',
    'context.seeDetailed': '查看用量详细分析与预算设置',

    // 工作台
    'workbench.title': '工作台',
    'workbench.newTab': '新建标签页',
    'workbench.openBrowser': '打开浏览器',
    'workbench.viewWorkspace': '查看工作空间',
    'workbench.viewChanges': '查看变更',
    'workbench.openTerminal': '打开终端',
    'workbench.artifacts': '产物',
    'workbench.noArtifacts': '当前会话暂无生成产物',
    'workbench.viewAllArtifacts': '查看所有产物',
    'workbench.externalOpen': '外部打开',
    'workbench.close': '关闭',
    'workbench.refresh': '刷新',
    'workbench.gitDiffClean': '当前工作区干净，无未提交变更',

    // 输入区
    'composer.placeholder': '输入消息，或输入 / 唤起快捷指令...',
    'composer.send': '发送',
    'composer.stop': '停止',
    'composer.queue': '排队发送',
    'composer.worktree': '隔离分支',
    'composer.noGit': '未初始化 Git',

    // 设置面板
    'settings.title': '设置',
    'settings.language': '界面语言',
    'settings.languageDesc': '实时切换界面显示语言，无需重启',
    'settings.pluginsTitle': '已安装插件',
    'settings.enabled': '已启用',
    'settings.disabled': '已停用',
    'settings.codeTitle': '尚搏 Code',
    'settings.importExportTitle': '导入与导出',
    'settings.developerTitle': '开发者选项',
    'settings.generalTitle': '常规设置',
    'settings.officialPartners': '来自官方与合作伙伴'
  },
  'zh-TW': {
    'nav.newChat': '新對話',
    'nav.cowork': '協同模式',
    'nav.code': '代碼模式',
    'nav.settings': '偏好設定',
    'nav.history': '對話歷史',

    'mode.auto': '智慧模式',
    'mode.wish': '許願模式',
    'mode.builder': '建造者',
    'mode.chat': '問答模式',
    'autonomy.strict': '嚴格確認',
    'autonomy.balanced': '智慧自治',
    'autonomy.trusted': '完全信任',

    'context.window': '上下文視窗',
    'context.mcpTools': 'MCP 工具',
    'context.systemTools': '系統工具',
    'context.skills': '技能',
    'context.systemPrompt': '系統提示詞',
    'context.memoryFiles': '記憶檔案',
    'context.messages': '對話訊息',
    'context.freeSpace': '剩餘空間',
    'context.seeDetailed': '查看用量詳細分析與預算設定',

    'workbench.title': '工作台',
    'workbench.newTab': '新增分頁',
    'workbench.openBrowser': '開啟瀏覽器',
    'workbench.viewWorkspace': '查看工作空間',
    'workbench.viewChanges': '查看變更',
    'workbench.openTerminal': '開啟終端機',
    'workbench.artifacts': '產物',
    'workbench.noArtifacts': '當前對話暫無生成產物',
    'workbench.viewAllArtifacts': '查看所有產物',
    'workbench.externalOpen': '外部開啟',
    'workbench.close': '關閉',
    'workbench.refresh': '重新整理',
    'workbench.gitDiffClean': '當前工作區乾淨，無未提交變更',

    'composer.placeholder': '輸入訊息，或輸入 / 喚起快捷指令...',
    'composer.send': '發送',
    'composer.stop': '停止',
    'composer.queue': '排隊發送',
    'composer.worktree': '隔離分支',
    'composer.noGit': '未初始化 Git',

    'settings.title': '設定',
    'settings.language': '介面語言',
    'settings.languageDesc': '即時切換介面顯示語言，無需重啟',
    'settings.pluginsTitle': '已安裝外掛',
    'settings.enabled': '已啟用',
    'settings.disabled': '已停用',
    'settings.codeTitle': '尚搏 Code',
    'settings.importExportTitle': '匯入與匯出',
    'settings.developerTitle': '開發者選項',
    'settings.generalTitle': '一般設定',
    'settings.officialPartners': '來自官方與合作夥伴'
  },
  'en-US': {
    'nav.newChat': 'New Chat',
    'nav.cowork': 'Cowork',
    'nav.code': 'Code',
    'nav.settings': 'Settings',
    'nav.history': 'Chat History',

    'mode.auto': 'Auto Mode',
    'mode.wish': 'Wish Mode',
    'mode.builder': 'Builder',
    'mode.chat': 'Chat Mode',
    'autonomy.strict': 'Strict',
    'autonomy.balanced': 'Balanced',
    'autonomy.trusted': 'Full Trust',

    'context.window': 'Context Window',
    'context.mcpTools': 'MCP Tools',
    'context.systemTools': 'System Tools',
    'context.skills': 'Skills',
    'context.systemPrompt': 'System Prompt',
    'context.memoryFiles': 'Memory Files',
    'context.messages': 'Messages',
    'context.freeSpace': 'Free Space',
    'context.seeDetailed': 'See detailed breakdown & budget settings',

    'workbench.title': 'Workbench',
    'workbench.newTab': 'New Tab',
    'workbench.openBrowser': 'Open Browser',
    'workbench.viewWorkspace': 'View Workspace',
    'workbench.viewChanges': 'View Changes',
    'workbench.openTerminal': 'Open Terminal',
    'workbench.artifacts': 'Artifacts',
    'workbench.noArtifacts': 'No generated artifacts in this session',
    'workbench.viewAllArtifacts': 'View all artifacts',
    'workbench.externalOpen': 'Open External',
    'workbench.close': 'Close',
    'workbench.refresh': 'Refresh',
    'workbench.gitDiffClean': 'Working tree clean, no uncommitted changes',

    'composer.placeholder': 'Type a message or / for commands...',
    'composer.send': 'Send',
    'composer.stop': 'Stop',
    'composer.queue': 'Queue Send',
    'composer.worktree': 'Worktree',
    'composer.noGit': 'No Git Repo',

    'settings.title': 'Settings',
    'settings.language': 'Language',
    'settings.languageDesc': 'Switch interface display language instantly without reload',
    'settings.pluginsTitle': 'Installed Plugins',
    'settings.enabled': 'Enabled',
    'settings.disabled': 'Disabled',
    'settings.codeTitle': 'Shangbo Code',
    'settings.importExportTitle': 'Import & Export',
    'settings.developerTitle': 'Developer Options',
    'settings.generalTitle': 'General',
    'settings.officialPartners': 'From Anthropic & Partners'
  },
  'ja-JP': {
    'nav.newChat': '新規チャット',
    'nav.cowork': '協同モード',
    'nav.code': 'コードモード',
    'nav.settings': '設定',
    'nav.history': '履歴',

    'mode.auto': 'スマートモード',
    'mode.wish': 'ウィッシュモード',
    'mode.builder': 'ビルダー',
    'mode.chat': 'Q&Aモード',
    'autonomy.strict': '厳格確認',
    'autonomy.balanced': '自律実行',
    'autonomy.trusted': '完全信頼',

    'context.window': 'コンテキストウィンドウ',
    'context.mcpTools': 'MCP ツール',
    'context.systemTools': 'システムツール',
    'context.skills': 'スキル',
    'context.systemPrompt': 'システムプロンプト',
    'context.memoryFiles': 'メモリファイル',
    'context.messages': 'メッセージ',
    'context.freeSpace': '空き容量',
    'context.seeDetailed': '詳細分析と予算設定を見る',

    'workbench.title': 'ワークベンチ',
    'workbench.newTab': '新しいタブ',
    'workbench.openBrowser': 'ブラウザを開く',
    'workbench.viewWorkspace': 'ワークスペースを表示',
    'workbench.viewChanges': '変更を表示',
    'workbench.openTerminal': 'ターミナルを開く',
    'workbench.artifacts': '成果物',
    'workbench.noArtifacts': 'このセッションには生成された成果物はありません',
    'workbench.viewAllArtifacts': 'すべての成果物を表示',
    'workbench.externalOpen': '外部で開く',
    'workbench.close': '閉じる',
    'workbench.refresh': '更新',
    'workbench.gitDiffClean': '変更はありません。作業ツリーはクリーンです',

    'composer.placeholder': 'メッセージを入力、または / でコマンド呼び出し...',
    'composer.send': '送信',
    'composer.stop': '停止',
    'composer.queue': 'キューに追加',
    'composer.worktree': '隔離ブランチ',
    'composer.noGit': 'Git未初期化',

    'settings.title': '設定',
    'settings.language': '表示言語',
    'settings.languageDesc': '再起動なしでインターフェース言語を即時切り替えます',
    'settings.pluginsTitle': 'インストール済みプラグイン',
    'settings.enabled': '有効',
    'settings.disabled': '無効',
    'settings.codeTitle': 'Shangbo Code',
    'settings.importExportTitle': 'インポート・エクスポート',
    'settings.developerTitle': '開発者向けオプション',
    'settings.generalTitle': '一般設定',
    'settings.officialPartners': '公式およびパートナーから'
  }
}

export function setLanguage(lang: SupportedLanguage): void {
  currentLanguage.value = lang
}

export function t(key: string, params?: Record<string, string | number>): string {
  const lang = currentLanguage.value
  let text = messages[lang]?.[key] ?? messages['zh-CN']?.[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return text
}

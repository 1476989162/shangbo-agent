/** 所有 IPC 通道名的唯一来源，主进程与 preload 必须同时引用此文件。 */
export const IPC = {
  conversationList: 'conversation:list',
  conversationCreate: 'conversation:create',
  conversationRename: 'conversation:rename',
  conversationDelete: 'conversation:delete',
  conversationMessages: 'conversation:messages',
  conversationSetLeaf: 'conversation:setLeaf',
  conversationSetWorkingDir: 'conversation:setWorkingDir',
  conversationSetMode: 'conversation:setMode',
  conversationExport: 'conversation:export',

  chatSend: 'chat:send',
  chatAbort: 'chat:abort',
  chatStopConversation: 'chat:stopConversation',
  chatSteerQueued: 'chat:steerQueued',
  chatApprove: 'chat:approve',
  chatRegenerate: 'chat:regenerate',

  chatEditQueued: 'chat:editQueued',
  chatCancelQueued: 'chat:cancelQueued',
  /** 某会话的实时运行态快照（切回会话时重建运行态用）。 */
  chatRuntimeState: 'chat:runtimeState',

  agentEvent: 'agent:event',

  providerList: 'provider:list',
  providerUpsert: 'provider:upsert',
  providerDelete: 'provider:delete',
  providerTest: 'provider:test',
  providerFetchModels: 'provider:fetchModels',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  appInfo: 'app:info',
  appContextStatics: 'app:contextStatics',
  appGitBranch: 'git:branch',
  appWindowTheme: 'app:windowTheme',
  windowHide: 'window:hide',
  windowQuit: 'window:quit',

  dialogPickFolder: 'dialog:pickFolder',
  usageGetStats: 'usage:getStats',

  /** 右侧查看器：受限读文件（仅当前工程目录内，私有目录禁入）。 */
  fileRead: 'file:read',
  /** 右侧查看器：列目录（默认当前工程目录）。 */
  fileList: 'file:list',
  /** 用系统默认应用打开文件（仅当前工程目录内）。 */
  fileOpen: 'file:open',

  mcpStatus: 'mcp:status',

  updateStatus: 'update:status',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateEvent: 'update:event',

  remoteStatus: 'remote:status',
  remotePair: 'remote:pair',
  remoteDevices: 'remote:devices',
  remoteRevoke: 'remote:revoke',
  remoteDisconnect: 'remote:disconnect',
  /** 本机中转身份指纹：用户据此配置服务器白名单。 */
  remoteIdentity: 'remote:identity',
  remoteEvent: 'remote:event',
  autonomousList: 'autonomous:list',
  autonomousSave: 'autonomous:save',
  autonomousDelete: 'autonomous:delete',
  autonomousSetEnabled: 'autonomous:setEnabled',
  autonomousRunNow: 'autonomous:runNow',
  autonomousRuns: 'autonomous:runs',
  autonomousPause: 'autonomous:pause',
  autonomousResume: 'autonomous:resume',
  autonomousStatus: 'autonomous:status',
  lessonsList: 'lessons:list',
  lessonsSave: 'lessons:save',
  lessonsDelete: 'lessons:delete'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

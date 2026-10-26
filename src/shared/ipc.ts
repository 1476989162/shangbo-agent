/** 所有 IPC 通道名的唯一来源，主进程与 preload 必须同时引用此文件。 */
export const IPC = {
  conversationList: 'conversation:list',
  conversationCreate: 'conversation:create',
  conversationRename: 'conversation:rename',
  conversationDelete: 'conversation:delete',
  conversationMessages: 'conversation:messages',
  conversationSetLeaf: 'conversation:setLeaf',
  conversationSetWorkingDir: 'conversation:setWorkingDir',
  conversationExport: 'conversation:export',

  chatSend: 'chat:send',
  chatAbort: 'chat:abort',
  chatApprove: 'chat:approve',
  chatRegenerate: 'chat:regenerate',

  chatEditQueued: 'chat:editQueued',
  chatCancelQueued: 'chat:cancelQueued',

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
  windowHide: 'window:hide',
  windowQuit: 'window:quit',

  dialogPickFolder: 'dialog:pickFolder',
  usageGetStats: 'usage:getStats',

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
  remoteEvent: 'remote:event'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
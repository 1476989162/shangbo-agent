/** 所有 IPC 通道名的唯一来源，主进程与 preload 必须同时引用此文件。 */
export const IPC = {
  conversationList: 'conversation:list',
  conversationCreate: 'conversation:create',
  conversationRename: 'conversation:rename',
  conversationDelete: 'conversation:delete',
  conversationMessages: 'conversation:messages',
  conversationSetLeaf: 'conversation:setLeaf',

  chatSend: 'chat:send',
  chatAbort: 'chat:abort',
  chatApprove: 'chat:approve',
  chatRegenerate: 'chat:regenerate',

  agentEvent: 'agent:event',

  providerList: 'provider:list',
  providerUpsert: 'provider:upsert',
  providerDelete: 'provider:delete',
  providerTest: 'provider:test',
  providerFetchModels: 'provider:fetchModels',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  appInfo: 'app:info',
  windowHide: 'window:hide',
  windowQuit: 'window:quit'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
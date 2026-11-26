import { FocusLostError, ScreenLaneError, screenLane } from '../computer/screenLane';
import { createGlobFilesTool } from './globFiles';
import { createMultiPatchFileTool } from './multiPatch';
import { createTodoWriteTool } from './todo';
import { claudeAsk, claudeStatus, codexAsk, codexStatus, opencodeAsk, opencodeStatus, qoderAsk, qoderStatus } from './cliBridge';
import {
  getCurrentTime,
  listDirectory,
  patchFileTool,
  readFileTool,
  searchFiles,
  writeFileTool
} from './fsTools';
import { runCommand } from './shellTools';
import {
  computerClick,
  computerPressKey,
  computerScreenshot,
  computerScroll,
  computerType,
  desktopClickRef,
  desktopListApps,
  desktopListWindows,
  desktopSnapshot
} from './computerTools';
import { listSkills, readSkill, taskCancel, taskCreate, taskSend, taskStatus, wikiSearch, wikiUpsert } from './agentTools';
import {
  describeError,
  guardPrivatePath,
  resolveUserPath,
  truncate,
  type ToolDefinition,
  type ToolHost
} from './core';

const toolHost: ToolHost = {
  resolveUserPath,
  guardPrivatePath,
  truncate
};

const globFilesTool = createGlobFilesTool(toolHost);
const multiPatchFileTool = createMultiPatchFileTool(toolHost);
const todoWriteTool = createTodoWriteTool();

/**
 * 把物理键鼠工具包进 Screen Lane：预写 WAL、FIFO 互斥、焦点丢失停手。
 * 执行异常统一转成 isError 工具结果（含 opId 与「先重新快照」指令），不炸主循环。
 */
function withScreenLane(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    async execute(input, context) {
      const raw = (input ?? {}) as Record<string, unknown>;
      const meta = {
        conversationId: context.conversationId,
        toolName: tool.name,
        target: JSON.stringify(raw).slice(0, 200),
        ...(typeof raw.windowId === 'string' ? { expectedWindowId: raw.windowId } : {}),
        ...(typeof raw.app === 'string' ? { expectedApp: raw.app } : {})
      };
      try {
        return await screenLane.runExclusive(meta, () => tool.execute(input, context));
      } catch (error) {
        const content =
          error instanceof FocusLostError || error instanceof ScreenLaneError
            ? error.message
            : `桌面操作失败：${describeError(error)}`;
        return { content, isError: true };
      }
    }
  };
}

const definitions: ToolDefinition[] = [
  getCurrentTime,
  listDirectory,
  readFileTool,
  searchFiles,
  globFilesTool,
  writeFileTool,
  patchFileTool,
  multiPatchFileTool,
  todoWriteTool,
  listSkills,
  readSkill,
  runCommand,  qoderAsk,
  qoderStatus,
  codexAsk,
  codexStatus,
  claudeAsk,
  claudeStatus,
  opencodeAsk,
  opencodeStatus,
  computerScreenshot,
  withScreenLane(computerClick),
  withScreenLane(computerType),
  withScreenLane(computerPressKey),
  withScreenLane(computerScroll),
  desktopListApps,
  desktopListWindows,
  desktopSnapshot,
  withScreenLane(desktopClickRef),
  wikiSearch,
  wikiUpsert,
  taskCreate,
  taskStatus,
  taskSend,
  taskCancel
];

const byName = new Map(definitions.map((tool) => [tool.name, tool]));

/** 只读复查模式下开放的工具：全部免审批，模型看不到写与执行能力。 */
const READ_ONLY_TOOL_NAMES = new Set([
  'get_current_time',
  'list_directory',
  'read_file',
  'search_files',
  'glob_files',
  'list_skills',
  'read_skill',
  'wiki_search',
  'task_status'
]);
export const toolRegistry = {
  all(): ToolDefinition[] {
    return definitions;
  },

  get(name: string): ToolDefinition | undefined {
    return byName.get(name);
  },

  /** 传给模型的工具清单。readOnly 时只给读工具（Codex 式 read-only 沙箱档）。 */
  schemas(options?: { readOnly?: boolean }): { name: string; description: string; parameters: Record<string, unknown> }[] {
    const list = options?.readOnly ? definitions.filter((tool) => READ_ONLY_TOOL_NAMES.has(tool.name)) : definitions;
    return list.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }));
  }
};

export type { ToolContext, ToolDefinition, ToolHost, ToolResult } from './core';
export { describeError, guardPrivatePath, resolveUserPath, truncate } from './core';
export type { SecurityAuditResult } from './shellTools'
export { auditCommandSecurity, commandTouchesPrivateData } from './shellTools';
export type { ResolvedCli } from './cliBridge'
export { parseCmdShim, resolveCliNoShell } from './cliBridge';

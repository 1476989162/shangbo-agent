import { z } from 'zod';
import {
  clickAt,
  pressKey,
  scrollAt,
  supportedKeysHint,
  takeScreenshot,
  typeText,
  type Screenshot
} from '../computer';
import {
  describeFailure,
  renderSnapshot,
  runAgentDesktop,
  type SnapshotData
} from '../computer/agentDesktop';
import { screenLane } from '../computer/screenLane';
import { describeError, truncate, type ToolDefinition, type ToolResult } from './core';

/** 最近一次截图的尺寸：点击坐标按截图像素给，本层换算到物理像素。 */
let lastShot: Screenshot | null = null

export const computerScreenshot: ToolDefinition = {
  name: 'computer_screenshot',
  description: '截取主屏画面并直接展示给你。看清按钮/输入框位置后，用截图像素坐标调用 computer_click。返回含坐标系说明。',
  parameters: { type: 'object', properties: {}, required: [] },
  requiresApproval: false,
  async execute(): Promise<ToolResult> {
    const shot = await takeScreenshot()
    lastShot = shot
    return {
      content: `屏幕 ${shot.realWidth}×${shot.realHeight}（截图 ${shot.shotWidth}×${shot.shotHeight}，坐标按截图尺寸给，左上为原点）。请先描述你看到的关键元素位置，再决定下一步。`,
      isError: false,
      image: { mimeType: shot.mimeType, dataUrl: shot.dataUrl }
    }
  }
}

export const computerClick: ToolDefinition = {
  name: 'computer_click',
  description: '在屏幕指定位置点击。坐标必须是最近一次截图里的像素坐标（左上原点）。',
  parameters: {
    type: 'object',
    properties: {
      x: { type: 'number', description: '截图横坐标' },
      y: { type: 'number', description: '截图纵坐标' },
      button: { type: 'string', description: 'left/right/middle，默认 left', enum: ['left', 'right', 'middle'] }
    },
    required: ['x', 'y']
  },
  requiresApproval: true,
  approvalReason: '将直接操控你的鼠标点击屏幕，可能触发任意按钮，请确认坐标无误。',
  async execute(input) {
    const { x, y, button } = z
      .object({ x: z.number(), y: z.number(), button: z.enum(['left', 'right', 'middle']).optional() })
      .parse(input)
    if (!lastShot) throw new Error('请先调用 computer_screenshot 看清画面再点。')
    return clickAt(x, y, button ?? 'left', lastShot)
  }
}

export const computerType: ToolDefinition = {
  name: 'computer_type',
  description: '向当前聚焦的窗口输入文本。输入前请确认焦点在正确的输入框。',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: '要输入的文本' } },
    required: ['text']
  },
  requiresApproval: true,
  approvalReason: '将向当前窗口输入文本，可能发送消息或填写表单，请确认。',
  async execute(input) {
    const { text } = z.object({ text: z.string().min(1).max(2000) }).parse(input)
    return typeText(text)
  }
}

export const computerPressKey: ToolDefinition = {
  name: 'computer_press_key',
  description: '按一次键盘按键。',
  parameters: {
    type: 'object',
    properties: { key: { type: 'string', description: `按键名，可用：${supportedKeysHint()}` } },
    required: ['key']
  },
  requiresApproval: true,
  approvalReason: '将模拟键盘按键，可能触发快捷键或系统操作，请确认。',
  async execute(input) {
    const { key } = z.object({ key: z.string().min(1) }).parse(input)
    return pressKey(key)
  }
}

export const computerScroll: ToolDefinition = {
  name: 'computer_scroll',
  description: '在鼠标当前位置滚动。',
  parameters: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'integer', description: '格数 1～10，默认 3' }
    },
    required: ['direction']
  },
  requiresApproval: true,
  approvalReason: '将滚动鼠标滚轮改变当前视图，请确认。',
  async execute(input) {
    const { direction, amount } = z
      .object({ direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(10).optional() })
      .parse(input)
    return scrollAt(direction, amount ?? 3)
  }
}

/* ------------------------------------------------------------------ */
/* 桌面适配层：无障碍树优先（agent-desktop），截图 + 像素作为兜底           */
/* ------------------------------------------------------------------ */

/** 最近一次 desktop_snapshot 的元信息，用于校验 ref 是否属于当前快照。 */
let lastDesktopSnapshot: { snapshotId: string; app?: string; windowId?: string } | null = null

export const desktopSnapshot: ToolDefinition = {
  name: 'desktop_snapshot',
  description:
    '读取桌面应用的无障碍树，返回每个可操作元素的稳定 ref（形如 @s8f3k2p9:e12）。' +
    '定位控件优先用它，比截图更稳：不抢焦点、不受窗口位置与缩放影响。' +
    '拿到 ref 后用 desktop_click_ref 操作。看颜色/布局/图表/自绘界面仍需 computer_screenshot。',
  parameters: {
    type: 'object',
    properties: {
      app: { type: 'string', description: '应用名（进程名，如 chrome.exe、notepad++.exe），先用 desktop_list_apps 查' },
      root: { type: 'string', description: '只下钻某个区域：传上一次快照里的 ref（@<snapshot_id>:eN）。密集界面先看骨架再下钻' },
      skeleton: { type: 'boolean', description: '只取骨架（层级结构，省略细节），用于先摸清大界面' },
      interactive: { type: 'boolean', description: '只要可交互元素（按钮/输入框/菜单等），默认 true' },
      windowId: { type: 'string', description: '窗口 id（如 w-1578054），用于多窗口消歧；从 desktop_list_windows 或报错返回的候选中取' }
    },
    required: []
  },
  requiresApproval: false,
  async execute(input): Promise<ToolResult> {
    const { app, root, skeleton, interactive, windowId } = z
      .object({
        app: z.string().min(1).optional(),
        root: z.string().min(1).optional(),
        skeleton: z.boolean().optional(),
        interactive: z.boolean().optional(),
        windowId: z.string().min(1).optional()
      })
      .parse(input)

    const args = ['snapshot', '--compact']
    if (app) args.push('--app', app)
    if (root) args.push('--root', root)
    if (skeleton) args.push('--skeleton')
    if (interactive !== false) args.push('-i')
    // 注意：CLI 只有 --window-id，没有 --window-title（实测 INVALID_ARGS 教训）
    if (windowId) args.push('--window-id', windowId)

    const run = await runAgentDesktop(args)
    if (!run.ok) {
      // 多窗口时 CLI 会返回 AMBIGUOUS_TARGET 并在 details 里列出候选：
      // 直接把候选窗口摊给模型，省一轮往返
      const error = run.envelope?.error
      if (error?.code === 'AMBIGUOUS_TARGET') {
        const candidates = (error.details as { candidates?: { id?: string; title?: string }[] })?.candidates ?? []
        const list = candidates
          .map((c) => `- windowId=${c.id} 标题="${(c.title ?? '').replace(/\s+/g, ' ').slice(0, 60)}"`)
          .join('\n')
        return {
          content: `该应用有多个窗口，请用 windowId 指定其中一个后重试：\n${list || describeFailure(run)}`,
          isError: true
        }
      }
      // 无障碍树拿不到（应用不支持 / 自绘界面 / 未装）时，明确引导回退截图
      return {
        content: `无障碍树读取失败，请改用 computer_screenshot 看屏 + computer_click 按像素点。\n${describeFailure(run)}`,
        isError: true
      }
    }
    const data = (run.envelope?.data ?? {}) as SnapshotData
    if (data.snapshot_id) {
      lastDesktopSnapshot = { snapshotId: data.snapshot_id, app: data.app, windowId: data.window?.id }
    }
    const body = renderSnapshot(data)
    return {
      content: truncate(
        `已取到无障碍树。用 ref 调 desktop_click_ref 操作，ref 与本次快照绑定，界面变化后需重新快照。\n${body}`
      ),
      isError: false
    }
  }
}

export const desktopClickRef: ToolDefinition = {
  name: 'desktop_click_ref',
  description:
    '按 desktop_snapshot 返回的 ref 操作某个元素（默认点击），无需像素坐标、不移动真实鼠标。' +
    '失败会返回 STALE_REF/AMBIGUOUS_TARGET 等明确原因，可安全重新快照后重试。',
  parameters: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: '快照里的 ref，必须是全限定形式 @<snapshot_id>:eN（裸 @e8 会被拒）' },
      action: {
        type: 'string',
        description: '动作，默认 click。set_value 需同时给 value',
        enum: ['click', 'double_click', 'right_click', 'type', 'set_value', 'focus', 'select', 'toggle', 'check', 'uncheck', 'expand', 'collapse', 'scroll_to']
      },
      value: { type: 'string', description: 'action 为 type/set_value 时要写入的文本' },
      app: { type: 'string', description: '目标应用名；有多个窗口时必须给，用于消歧' },
      windowId: { type: 'string', description: '窗口 id（如 w-1578054），多窗口时用它精确指定' }
    },
    required: ['ref']
  },
  requiresApproval: true,
  approvalReason: '将按无障碍树 ref 直接操作目标控件，可能触发按钮或修改输入内容，请确认目标无误。',
  async execute(input) {
    const { ref, action, value, app, windowId } = z
      .object({
        ref: z.string().min(1),
        action: z
          .enum([
            'click',
            'double_click',
            'right_click',
            'type',
            'set_value',
            'focus',
            'select',
            'toggle',
            'check',
            'uncheck',
            'expand',
            'collapse',
            'scroll_to'
          ])
          .optional(),
        value: z.string().optional(),
        app: z.string().min(1).optional(),
        windowId: z.string().min(1).optional()
      })
      .parse(input)

    // 裸 ref 会被 CLI 拒绝（INVALID_ARGS）：提前给人话，省一次往返
    if (!/^@[^:\s]+:e\d+$/.test(ref.trim())) {
      throw new Error(
        `ref 格式不对：${ref}。必须用 desktop_snapshot 返回的全限定形式 @<snapshot_id>:eN，裸 @e8 无效。`
      )
    }
    const chosen = action ?? 'click'
    if ((chosen === 'type' || chosen === 'set_value') && !value) {
      throw new Error(`action=${chosen} 需要同时提供 value 文本。`)
    }

    const args = [chosen.replace(/_/g, '-'), ref.trim()]
    if (value) args.push('--value', value)
    if (app) args.push('--app', app)
    if (windowId) args.push('--window-id', windowId)

    const run = await runAgentDesktop(args)
    if (!run.ok) {
      const code = run.envelope?.error?.code
      const stale = code === 'STALE_REF' || code === 'SNAPSHOT_NOT_FOUND' || code === 'AMBIGUOUS_TARGET'
      return {
        content: `${stale ? '界面已变化或 ref 失效：请重新 desktop_snapshot 后再操作。' : '操作失败。'}\n${describeFailure(run)}`,
        isError: true
      }
    }

    const disposition = (run.envelope?.data?.disposition ?? {}) as { delivery?: string; retry?: string }
    const verified = disposition.delivery === 'delivered_verified'
    const note = verified
      ? '已送达并读回验证。'
      : disposition.delivery
        ? `已送达但未读回验证（${disposition.delivery}）。建议 desktop_snapshot 复查结果。`
        : '已执行。建议 desktop_snapshot 复查结果。'
    return `已对 ${ref.trim()} 执行 ${chosen}。${note}`
  }
}

export const desktopListApps: ToolDefinition = {
  name: 'desktop_list_apps',
  description: '列出当前可被无障碍树访问的桌面应用（含进程名），用于给 desktop_snapshot 的 app 参数取值。',
  parameters: { type: 'object', properties: {}, required: [] },
  requiresApproval: false,
  async execute(): Promise<string> {
    const run = await runAgentDesktop(['list-apps'])
    if (!run.ok) return `获取应用列表失败：\n${describeFailure(run)}`
    const apps = (run.envelope?.data?.apps ?? []) as { name?: string; pid?: number }[]
    if (!apps.length) return '当前没有可访问的桌面应用。'
    return truncate(`可访问的应用（${apps.length} 个）：\n${apps.map((a) => `- ${a.name} (pid ${a.pid})`).join('\n')}`)
  }
}

export const desktopListWindows: ToolDefinition = {
  name: 'desktop_list_windows',
  description: '列出桌面窗口及其 windowId，用于多窗口时给 desktop_snapshot / desktop_click_ref 的 windowId 参数消歧。',
  parameters: {
    type: 'object',
    properties: { app: { type: 'string', description: '只看某个应用的窗口（进程名）' } },
    required: []
  },
  requiresApproval: false,
  async execute(input): Promise<string> {
    const { app } = z.object({ app: z.string().min(1).optional() }).parse(input)
    const args = ['list-windows']
    if (app) args.push('--app', app)
    const run = await runAgentDesktop(args)
    if (!run.ok) return `获取窗口列表失败：\n${describeFailure(run)}`
    // 实测：list-windows 的 data 直接是数组，不是 {windows:[...]}
    const raw = run.envelope?.data
    const windows = (Array.isArray(raw) ? raw : []) as {
      id?: string
      title?: string
      app_name?: string
      is_focused?: boolean
      visible?: boolean
      accessible?: boolean
    }[]
    if (!windows.length) return '当前没有可访问的窗口。'
    return truncate(
      `窗口列表（${windows.length} 个）：\n${windows
        .map(
          (w) =>
            `- windowId=${w.id} app=${w.app_name ?? '?'} 标题="${(w.title ?? '').replace(/\s+/g, ' ').slice(0, 60)}"${w.is_focused ? ' [焦点]' : ''}${w.visible === false ? ' [隐藏]' : ''}${w.accessible === false ? ' [无障碍不可用]' : ''}`
        )
        .join('\n')}`
    )
  }
}

/**
 * 焦点守护：只在模型给了目标窗口（windowId / app）时才探测前台窗口。
 * 探测不到或辅助进程不可用一律返回 null（放行），绝不因为守护本身卡死操作。
 */
screenLane.setFocusProvider(async () => {
  try {
    const run = await runAgentDesktop(['list-windows', '--focused'], { timeoutMs: 1_500 })
    if (!run.ok || !run.envelope?.data) return null
    const data = run.envelope.data
    const nested = (data.window ?? data.focused) as Record<string, unknown> | undefined
    const pickString = (...values: unknown[]): string | undefined =>
      values.find((v): v is string => typeof v === 'string' && v.length > 0)
    const windowId = pickString(data.windowId, data.window_id, data.id, nested?.id, nested?.windowId)
    const app = pickString(data.app, data.process, nested?.app, nested?.process)
    return windowId || app ? { windowId, app } : null
  } catch {
    return null
  }
})

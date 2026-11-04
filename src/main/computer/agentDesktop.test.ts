import { describe, expect, it, vi, beforeEach } from 'vitest'

/* 拦截真实进程：session 注入与信封解析都是纯参数/纯字符串逻辑，
   不该为了测它们去依赖本机是否装了 agent-desktop。 */
const execFileMock = vi.fn()
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args)
}))
vi.mock('node:util', () => ({
  promisify: () => (...args: unknown[]) => execFileMock(...args)
}))

import { describeFailure, renderSnapshot, runAgentDesktop, type SnapshotData } from './agentDesktop'
import { isDesktopTool } from '../../shared/types'

/**
 * 桌面适配层的纯函数测试。
 *
 * 只测不依赖外部进程的部分：无障碍树渲染、错误翻译、工具归属判定。
 * 真实 CLI 往返属于集成行为，靠人工/端到端验证，不在单测里拉起进程
 * （否则测试会依赖本机是否装了 agent-desktop）。
 */

describe('renderSnapshot 无障碍树压缩', () => {
  const data: SnapshotData = {
    app: 'notepad++.exe',
    window: { id: 'w-1', title: 'key.txt - Notepad++' },
    snapshot_id: 's30lfhk55b0b3r',
    ref_count: 3,
    complete: true,
    tree: {
      role: 'window',
      name: 'key.txt - Notepad++',
      children: [
        {
          role: 'menuitem',
          name: '文件(F)',
          ref_id: '@s30lfhk55b0b3r:e6',
          available_actions: ['Expand', 'Collapse', 'SetFocus'],
          states: ['offscreen']
        },
        {
          role: 'textfield',
          name: '地址和搜索栏',
          ref_id: '@s30lfhk55b0b3r:e12',
          value: 'github.com/vercel-labs/agent-desktop',
          available_actions: ['SetValue', 'SetFocus']
        }
      ]
    }
  }

  it('输出头部含 snapshot_id 与窗口信息，元素带全限定 ref', () => {
    const text = renderSnapshot(data)
    expect(text).toContain('snapshot_id=s30lfhk55b0b3r')
    expect(text).toContain('app=notepad++.exe')
    expect(text).toContain('key.txt - Notepad++')
    expect(text).toContain('@s30lfhk55b0b3r:e6')
    expect(text).toContain('@s30lfhk55b0b3r:e12')
  })

  it('保留 value 与可用动作：模型据此决定用 set_value 还是 click', () => {
    const text = renderSnapshot(data)
    expect(text).toContain('value="github.com/vercel-labs/agent-desktop"')
    expect(text).toContain('[SetValue,SetFocus]')
    expect(text).toContain('(offscreen)')
  })

  it('超长 value 被压平并截断，避免撑爆上下文', () => {
    const long: SnapshotData = {
      tree: { role: 'window', name: 'w', children: [{ role: 'text', value: 'x'.repeat(500) }] }
    }
    const text = renderSnapshot(long)
    expect(text).not.toContain('x'.repeat(200))
    expect(text).toContain('…')
  })

  it('complete=false 时明确提示树被截断', () => {
    const text = renderSnapshot({ ...data, complete: false })
    expect(text).toContain('complete=false')
  })

  it('行数超限时截断并提示用 root 下钻', () => {
    const many: SnapshotData = {
      tree: {
        role: 'window',
        children: Array.from({ length: 50 }, (_, i) => ({ role: 'button', name: `b${i}`, ref_id: `@s:e${i}` }))
      }
    }
    const text = renderSnapshot(many, { maxLines: 10 })
    expect(text).toContain('desktop_snapshot 的 root 参数')
    expect(text.split('\n').length).toBeLessThan(20)
  })

  it('空树不抛错', () => {
    expect(() => renderSnapshot({})).not.toThrow()
  })
})

describe('describeFailure 错误翻译', () => {
  it('STALE_REF 带出可否安全重试的结论', () => {
    const text = describeFailure({
      ok: false,
      raw: '',
      envelope: {
        ok: false,
        error: {
          code: 'STALE_REF',
          message: '@s:e7 not found in current RefMap',
          suggestion: 'Re-run a snapshot',
          disposition: { delivery: 'not_delivered', retry: 'safe' }
        }
      }
    })
    expect(text).toContain('STALE_REF')
    expect(text).toContain('可重试：是')
  })

  it('可能已送达的操作标为不可盲目重试', () => {
    const text = describeFailure({
      ok: false,
      raw: '',
      envelope: {
        ok: false,
        error: { code: 'TIMEOUT', message: 'timed out', disposition: { delivery: 'delivery_uncertain', retry: 'unsafe' } }
      }
    })
    expect(text).toContain('可重试：否')
  })

  it('没有信封时回落到原始输出', () => {
    expect(describeFailure({ ok: false, envelope: null, raw: 'boom' })).toBe('boom')
  })
})

describe('runAgentDesktop 命令拼装与信封解析', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  it('自动注入 --session，否则快照产出的 ref 在后续进程查不到', async () => {
    execFileMock.mockResolvedValue({ stdout: '{"ok":true,"data":{}}', stderr: '' })
    await runAgentDesktop(['snapshot', '--app', 'chrome.exe'])
    const args = execFileMock.mock.calls[0][1] as string[]
    expect(args).toContain('--session')
    expect(args[args.indexOf('--session') + 1]).toBe('shangbo-agent')
  })

  it('调用方已显式给 session 时不重复追加', async () => {
    execFileMock.mockResolvedValue({ stdout: '{"ok":true,"data":{}}', stderr: '' })
    await runAgentDesktop(['snapshot', '--session', 'custom'])
    const args = execFileMock.mock.calls[0][1] as string[]
    expect(args.filter((a) => a === '--session')).toHaveLength(1)
    expect(args[args.indexOf('--session') + 1]).toBe('custom')
  })

  it('参数走数组不经 shell：ref 里的 @ 原样保留', async () => {
    execFileMock.mockResolvedValue({ stdout: '{"ok":true,"data":{}}', stderr: '' })
    await runAgentDesktop(['click', '@s1abc:e12'])
    const args = execFileMock.mock.calls[0][1] as string[]
    expect(args).toContain('@s1abc:e12')
  })

  it('退出码为 0 但 ok=false 时判定为失败（CLI 的退出码不可信）', async () => {
    execFileMock.mockResolvedValue({
      stdout: '{"ok":false,"error":{"code":"STALE_REF","message":"gone"}}',
      stderr: ''
    })
    const run = await runAgentDesktop(['click', '@s:e1'])
    expect(run.ok).toBe(false)
    expect(run.envelope?.error?.code).toBe('STALE_REF')
  })

  it('进程抛错但输出里有信封时，仍能解析出结构化错误', async () => {
    execFileMock.mockRejectedValue({
      stdout: '{"ok":false,"error":{"code":"APP_NOT_FOUND","message":"nope"}}',
      stderr: '',
      message: 'exit 1'
    })
    const run = await runAgentDesktop(['snapshot', '--app', 'x.exe'])
    expect(run.ok).toBe(false)
    expect(run.envelope?.error?.code).toBe('APP_NOT_FOUND')
  })

  it('输出前有杂音行时仍能取到最后一条合法信封', async () => {
    execFileMock.mockResolvedValue({
      stdout: 'warn: something\n{"ok":true,"data":{"snapshot_id":"s9"}}\n',
      stderr: ''
    })
    const run = await runAgentDesktop(['snapshot'])
    expect(run.ok).toBe(true)
    expect(run.envelope?.data?.snapshot_id).toBe('s9')
  })
})

describe('真实点击实测发现的回归点', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  it('list-windows 的 data 是数组，不是 {windows:[]}', async () => {
    execFileMock.mockResolvedValue({
      stdout: JSON.stringify({ ok: true, data: [{ id: 'w-1', app_name: 'Notepad.exe', title: '无标题 - Notepad' }] }),
      stderr: ''
    })
    const run = await runAgentDesktop(['list-windows'])
    expect(Array.isArray(run.envelope?.data)).toBe(true)
    expect((run.envelope?.data as unknown as unknown[]).length).toBe(1)
  })

  it('CLI 只认 --window-id：绝不能拼出 --window-title', async () => {
    execFileMock.mockResolvedValue({ stdout: '{"ok":true,"data":{}}', stderr: '' })
    await runAgentDesktop(['snapshot', '--app', 'notepad.exe', '--window-id', 'w-12195030'])
    const args = execFileMock.mock.calls[0][1] as string[]
    expect(args).not.toContain('--window-title')
    expect(args[args.indexOf('--window-id') + 1]).toBe('w-12195030')
  })

  it('AMBIGUOUS_TARGET 的候选窗口能从 details 里取出来', async () => {
    execFileMock.mockResolvedValue({
      stdout: JSON.stringify({
        ok: false,
        error: {
          code: 'AMBIGUOUS_TARGET',
          message: 'More than one window matches the target',
          details: {
            candidates: [
              { id: 'w-1578054', title: '无标题 - Notepad' },
              { id: 'w-10227742', title: '启动TPlus联调服务.bat - Notepad' }
            ]
          }
        }
      }),
      stderr: ''
    })
    const run = await runAgentDesktop(['snapshot', '--app', 'notepad.exe'])
    expect(run.ok).toBe(false)
    const details = run.envelope?.error?.details as { candidates?: { id?: string }[] }
    expect(details.candidates).toHaveLength(2)
    expect(details.candidates?.[0].id).toBe('w-1578054')
  })
})

describe('isDesktopTool 总开关归属', () => {
  it('computer_* 与 desktop_* 都受电脑控制开关约束', () => {
    expect(isDesktopTool('computer_click')).toBe(true)
    expect(isDesktopTool('desktop_snapshot')).toBe(true)
    expect(isDesktopTool('desktop_click_ref')).toBe(true)
  })

  it('普通工具不受影响', () => {
    expect(isDesktopTool('read_file')).toBe(false)
    expect(isDesktopTool('run_command')).toBe(false)
  })
})

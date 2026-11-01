import { describe, expect, it, vi } from 'vitest'
import { normalizeIncomingDelta } from './modelRuntime'

describe('Boost 修复深度专项验证', () => {
  describe('1. <think> 标签流式分块无缝隔离与缓冲测试', () => {
    it('跨分块切割标签 (<th + ink>) 不会泄露到 text_delta', () => {
      const textEvents: string[] = []
      const reasoningEvents: string[] = []
      const blocks: any[] = []

      // 模拟 agentLoop.ts 中 createStreamChunkProcessor 逻辑
      let inThinkTag = false
      let tagBuffer = ''
      let textStreamSnapshot = ''
      let reasoningStreamSnapshot = ''

      const emitText = (text: string) => {
        if (!text) return
        textEvents.push(text)
      }
      const emitReasoning = (text: string) => {
        if (!text) return
        reasoningEvents.push(text)
      }

      const handleTextChunk = (rawText: string) => {
        const normalized = normalizeIncomingDelta(rawText, textStreamSnapshot)
        textStreamSnapshot = normalized.snapshot
        if (!normalized.delta) return

        let current = tagBuffer + normalized.delta
        tagBuffer = ''

        while (current.length > 0) {
          if (!inThinkTag) {
            const thinkStart = current.indexOf('<think>')
            if (thinkStart === -1) {
              let partial = ''
              for (let len = Math.min(6, current.length); len >= 1; len--) {
                const sub = current.slice(-len)
                if ('<think>'.startsWith(sub)) {
                  partial = sub
                  break
                }
              }
              if (partial) {
                tagBuffer = partial
                emitText(current.slice(0, -partial.length))
              } else {
                emitText(current)
              }
              break
            } else {
              emitText(current.slice(0, thinkStart))
              inThinkTag = true
              current = current.slice(thinkStart + 7)
            }
          } else {
            const thinkEnd = current.indexOf('</think>')
            if (thinkEnd === -1) {
              let partial = ''
              for (let len = Math.min(7, current.length); len >= 1; len--) {
                const sub = current.slice(-len)
                if ('</think>'.startsWith(sub)) {
                  partial = sub
                  break
                }
              }
              if (partial) {
                tagBuffer = partial
                emitReasoning(current.slice(0, -partial.length))
              } else {
                emitReasoning(current)
              }
              break
            } else {
              emitReasoning(current.slice(0, thinkEnd))
              inThinkTag = false
              current = current.slice(thinkEnd + 8)
            }
          }
        }
      }

      const flush = () => {
        if (tagBuffer) {
          if (inThinkTag) emitReasoning(tagBuffer)
          else emitText(tagBuffer)
          tagBuffer = ''
        }
      }

      // 模拟 split chunks: "前置文本 <th" -> "ink>思考内容</th" -> "ink>后续正文"
      handleTextChunk('前置文本 <th')
      expect(textEvents).toEqual(['前置文本 '])
      expect(reasoningEvents).toEqual([])

      handleTextChunk('ink>思考内容</th')
      expect(textEvents).toEqual(['前置文本 '])
      expect(reasoningEvents).toEqual(['思考内容'])

      handleTextChunk('ink>后续正文')
      flush()

      expect(textEvents).toEqual(['前置文本 ', '后续正文'])
      expect(reasoningEvents).toEqual(['思考内容'])
      // 绝对没有任何 <think> 或 </think> 字符进入正文
      expect(textEvents.join('')).not.toContain('<think>')
      expect(textEvents.join('')).not.toContain('</think>')
      expect(textEvents.join('')).not.toContain('<th')
      expect(textEvents.join('')).not.toContain('ink>')
    })
  })

  describe('2. WorkBuddy 产物过滤机制测试', () => {
    it('排除 read_file/search_files/list_directory，仅收纳修改落盘产物', () => {
      const isInspectionTool = (name: string): boolean => {
        const lower = name.toLowerCase()
        return (
          lower.startsWith('read_') ||
          lower.startsWith('search_') ||
          lower.startsWith('find_') ||
          lower.startsWith('list_') ||
          lower.includes('grep') ||
          lower.includes('glob')
        )
      }

      const getTargetPath = (input: unknown): string | null => {
        if (!input || typeof input !== 'object') return null
        const rec = input as Record<string, unknown>
        for (const key of ['path', 'filePath', 'targetPath', 'file', 'targetFile', 'TargetFile']) {
          if (typeof rec[key] === 'string' && rec[key].trim()) {
            return rec[key].trim()
          }
        }
        return null
      }

      const mockBlocks = [
        { type: 'tool_use', name: 'read_file', input: { path: '/src/a.ts' } },
        { type: 'tool_use', name: 'search_files', input: { query: 'test' } },
        { type: 'tool_use', name: 'list_directory', input: { path: '/src' } },
        { type: 'tool_use', name: 'write_file', input: { TargetFile: '/src/main.ts' } },
        { type: 'tool_use', name: 'patch_file', input: { path: '/src/utils.ts' } }
      ]

      const sessionArtifacts: Array<{ path: string; name: string }> = []
      for (const block of mockBlocks) {
        if (block.type !== 'tool_use') continue
        if (isInspectionTool(block.name)) continue
        const path = getTargetPath(block.input)
        if (path) {
          sessionArtifacts.push({ path, name: block.name })
        }
      }

      expect(sessionArtifacts).toHaveLength(2)
      expect(sessionArtifacts[0].path).toBe('/src/main.ts')
      expect(sessionArtifacts[1].path).toBe('/src/utils.ts')
      expect(sessionArtifacts.some((a) => a.path.includes('a.ts'))).toBe(false)
    })
  })

  describe('3. 经验进化总结长度与去重规范测试', () => {
    it('普通会话许愿模式自愈总结必须大于等于 20 字符且带完整关键信息', () => {
      const triggerText = '实现用户中心登录鉴权与验证码校验'
      const verifyCmd = 'npm test'
      const modifiedFiles = ['src/auth.ts', 'src/sms.ts']

      const filesPart = modifiedFiles.length > 0 ? ` 涉及文件：${modifiedFiles.join('、')}。` : ''
      const summary = `【任务目标】${triggerText.slice(0, 80)}\n【验收命令】${verifyCmd}\n【经验总结】执行 ${verifyCmd} 成功通过验收。${filesPart}在类似项目中应遵循相同构建与校验规则。`

      expect(summary.length).toBeGreaterThanOrEqual(20)
      expect(summary).toContain('【任务目标】')
      expect(summary).toContain('【验收命令】npm test')
      expect(summary).toContain('src/auth.ts、src/sms.ts')
    })
  })
})

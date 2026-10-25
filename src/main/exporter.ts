import { dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import log from 'electron-log/main'
import * as repo from './db/repo'
import type { ContentBlock, Message } from '../shared/types'

/**
 * 把会话的当前激活分支导出为 Markdown 文件。
 * 主进程侧完成文件对话框与写盘，渲染进程只触发并展示结果。
 */

function renderBlocks(blocks: ContentBlock[]): string[] {
  const lines: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      lines.push(block.text, '')
    } else if (block.type === 'reasoning') {
      lines.push('> 💭 思考过程', ...block.text.split('\n').map((line) => `> ${line}`), '')
    } else if (block.type === 'tool_use') {
      lines.push(`🔧 **${block.name}**`, '', '```json', JSON.stringify(block.input, null, 2), '```', '')
    } else if (block.type === 'tool_result') {
      const tag = block.isError ? '（失败）' : ''
      lines.push(`📄 工具结果${tag}`, '', '```', block.content, '```', '')
      if (block.image) {
        lines.push(
          block.image.dataUrl ? '![工具截图](内联图片)' : `![工具截图](${block.image.mimeType})`,
          ''
        )
      }
    } else if (block.type === 'image') {
      // 图片块直接丢弃等于审计不完整：导出时保留相对路径定位
      lines.push(block.file ? `![图片](${block.file})` : block.dataUrl ? '![图片](内联图片)' : '[图片已丢失]', '')
    }
  }
  return lines
}

function renderMessage(message: Message): string {
  const roleLabel = message.role === 'user' ? '🧑 我' : '🤖 尚搏 Agent'
  const lines: string[] = [`## ${roleLabel}`, '']
  lines.push(...renderBlocks(message.blocks))
  if (message.usage) {
    const usage = message.usage
    lines.push(
      `<sub>输入 ${usage.promptTokens} · 输出 ${usage.completionTokens} tokens${
        message.model ? ` · ${message.model}` : ''
      }</sub>`,
      ''
    )
  }
  return lines.join('\n')
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || '对话'
}

export interface ExportResult {
  ok: boolean
  canceled?: boolean
  path?: string
  message?: string
}

export interface ExportOptions {
  /** 指定叶子消息 id，导出该分支；缺省为当前激活分支 */
  leafId?: string
  /** 是否包含思考过程块，默认包含 */
  includeReasoning?: boolean
}

export async function exportConversation(
  conversationId: string,
  options?: ExportOptions
): Promise<ExportResult> {
  const conversation = repo.getConversation(conversationId)
  if (!conversation) return { ok: false, message: '会话不存在或已被删除' }

  const messages =
    options?.leafId && repo.getMessage(options.leafId)?.conversationId === conversationId
      ? repo.getPathTo(options.leafId)
      : repo.getActivePath(conversationId)
  const includeReasoning = options?.includeReasoning ?? true
  const filtered = includeReasoning
    ? messages
    : messages.map((m) => ({ ...m, blocks: m.blocks.filter((b) => b.type !== 'reasoning') }))

  const header = [
    `# ${conversation.title}`,
    '',
    `<sub>导出于 ${new Date().toLocaleString('zh-CN')} · 尚搏 Agent</sub>`,
    ''
  ]
  const body = filtered.map(renderMessage).join('\n')
  const markdown = `${header.join('\n')}${body}\n`

  try {
    const result = await dialog.showSaveDialog({
      defaultPath: `${sanitizeFileName(conversation.title)}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    await writeFile(result.filePath, markdown, 'utf8')
    log.info(`[export] 已导出会话 ${conversationId} → ${result.filePath}`)
    return { ok: true, path: result.filePath }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('[export] 导出失败', error)
    return { ok: false, message }
  }
}
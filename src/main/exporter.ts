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

export async function exportConversation(conversationId: string): Promise<ExportResult> {
  const conversation = repo.getConversation(conversationId)
  if (!conversation) return { ok: false, message: '会话不存在或已被删除' }

  const messages = repo.getActivePath(conversationId)

  const header = [
    `# ${conversation.title}`,
    '',
    `<sub>导出于 ${new Date().toLocaleString('zh-CN')} · 尚搏 Agent</sub>`,
    ''
  ]
  const body = messages.map(renderMessage).join('\n')
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
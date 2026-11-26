import { createReadStream } from 'node:fs';
import { mkdir, open as openFile, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import {
  guardPrivatePath,
  resolveUserPath,
  truncate,
  type ToolDefinition
} from './core';

export const getCurrentTime: ToolDefinition = {
  name: 'get_current_time',
  description: '获取当前的本地日期与时间。当用户询问「现在几点」「今天几号」或需要计算时间差时使用。',
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA 时区名，例如 Asia/Shanghai。留空则使用本机时区。'
      }
    },
    required: []
  },
  requiresApproval: false,
  async execute(input) {
    const { timezone } = z.object({ timezone: z.string().optional() }).parse(input ?? {})
    const now = new Date()
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'full',
      timeStyle: 'long',
      timeZone: timezone || undefined
    })
    return `${formatter.format(now)}\nISO: ${now.toISOString()}\n时间戳: ${now.getTime()}`
  }
}

export const listDirectory: ToolDefinition = {
  name: 'list_directory',
  description:
    '列出某个目录下的文件与子目录，用于了解项目结构或查找文件位置。支持相对路径（基于当前项目目录）与绝对路径。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径，相对路径基于项目目录解析' }
    },
    required: ['path']
  },
  requiresApproval: false,
  async execute(input, context) {
    const { path } = z.object({ path: z.string().min(1) }).parse(input)
    const target = resolveUserPath(context, path)
    guardPrivatePath(target)
    let entries: Dirent[];
    try {
      entries = await readdir(target, { withFileTypes: true })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/ENOTDIR|not a directory/i.test(msg)) throw new Error(`路径 ${target} 是文件不是目录：要读内容请用 read_file，要列目录请传其父目录。`);
      throw e;
    }

    const lines = await Promise.all(
      entries.slice(0, 500).map(async (entry) => {
        if (entry.isDirectory()) return `[目录] ${entry.name}/`
        try {
          const info = await stat(resolve(target, entry.name))
          return `[文件] ${entry.name}  ${info.size} 字节`
        } catch {
          return `[文件] ${entry.name}`
        }
      })
    )

    const suffix = entries.length > 500 ? `\n…（共 ${entries.length} 项，仅显示前 500 项）` : ''
    return truncate(`${target} 下共 ${entries.length} 项：\n${lines.join('\n')}${suffix}`)
  }
}

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description:
    '读取文本文件的内容。支持相对路径（基于当前项目目录）与绝对路径；可按字节分段，也可按行读取并返回行号。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，相对路径基于项目目录解析' },
      maxBytes: { type: 'integer', description: '最多读取的字节数，默认 262144' },
      offsetBytes: { type: 'integer', description: '从第几个字节开始读，默认 0，用于分段读大文件' },
      startLine: { type: 'integer', description: '起始行号（从 1 开始），与 endLine 配合按行读取' },
      endLine: { type: 'integer', description: '结束行号（含），与 startLine 配合按行读取' }
    },
    required: ['path']
  },
  requiresApproval: false,
  async execute(input, context) {
    const { path, maxBytes, offsetBytes, startLine, endLine } = z
      .object({
        path: z.string().min(1),
        maxBytes: z.number().int().positive().optional(),
        offsetBytes: z.number().int().min(0).optional(),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional()
      })
      .parse(input)

    const target = resolveUserPath(context, path)
    guardPrivatePath(target)
    try {
      const st = await stat(target);
      if (st.isDirectory()) throw new Error(`路径 ${target} 是目录不是文件：要列内容请用 list_directory，要读文件请传具体文件路径。`);
    } catch (e) {
      if (e instanceof Error && /是目录不是文件/.test(e.message)) throw e;
    }
    if (startLine !== undefined || endLine !== undefined) {
      if (offsetBytes !== undefined || maxBytes !== undefined) {
        throw new Error('startLine/endLine 不能与 offsetBytes/maxBytes 同时使用，请选择按行或按字节其中一种方式。')
      }
      const start = startLine ?? 1
      const end = endLine ?? Number.MAX_SAFE_INTEGER
      if (end < start) throw new Error('endLine 必须大于或等于 startLine。')
      const lines: string[] = []
      let currentLine = 0
      let actualEnd = start - 1
      const stream = createReadStream(target, { encoding: 'utf8' })
      const reader = createInterface({ input: stream, crlfDelay: Infinity })
      try {
        // 流式按行扫描：只保留请求范围，超大文件也不会整份读入内存。
        for await (const line of reader) {
          if (context.signal.aborted) throw new Error('操作已取消')
          currentLine++
          if (line.includes('\0')) {
            return `${target}：二进制文件，不提供文本内容。`
          }
          if (currentLine < start) continue
          lines.push(`${currentLine}: ${line}`)
          actualEnd = currentLine
          if (currentLine >= end) break
        }
        if (start > currentLine) {
          throw new Error(`startLine ${start} 超出文件行数 ${currentLine}。`)
        }
        const notice = currentLine < end ? '\n\n…（已返回至文件末尾）' : ''
        return truncate(`${target}（第 ${start}-${actualEnd} 行）：\n\n${lines.join('\n')}${notice}`)
      } finally {
        reader.close()
        stream.destroy()
      }
    }
    const limit = maxBytes ?? 262_144
    const offset = offsetBytes ?? 0
    const info = await stat(target)
    // 流式只读需要的窗口：几 GB 大文件也不会被全量读进内存
    const handle = await openFile(target, 'r')
    try {
      const length = Math.max(0, Math.min(limit, info.size - offset))
      const buffer = Buffer.alloc(length)
      if (length > 0) await handle.read(buffer, 0, length, offset)
      const slice = buffer.subarray(0, length)

      // 二进制内容没有阅读价值，只会变成一大段乱码污染上下文
      let nullByteCount = 0
      for (const byte of slice) if (byte === 0) nullByteCount++
      if (nullByteCount > 0) {
        return `${target}（${info.size} 字节）：二进制文件，不提供文本内容。`
      }

      const end = offset + length
      // offsetBytes 可能切在 UTF-8 多字节字符中间：开头若是一串连续字节
      // （0x80-0xBF，说明上个字符被切走了一半），向后挪到下一个字符边界再解码
      let contentStart = 0
      if (length > 0 && (slice[0] & 0xc0) === 0x80) {
        while (contentStart < length && (slice[contentStart] & 0xc0) === 0x80) contentStart++
      }
      const text = slice.subarray(contentStart).toString('utf8')
      const boundaryNote =
        contentStart > 0
          ? `\n\n（起点切在多字节字符中间，已跳过前 ${contentStart} 字节的残缺字节。）`
          : text.endsWith('\uFFFD')
            ? '\n\n（末尾可能截断了半个多字节字符，续读时把 offsetBytes 回退几个字节可避免乱码。）'
            : ''
      const notice =
        end < info.size
          ? `\n\n…（文件共 ${info.size} 字节，本次返回 ${offset}-${end} 字节，展示截断上限 16000 字符）`
          : ''
      return truncate(`${target}（${info.size} 字节）：\n\n${text}${boundaryNote}${notice}`)
    } finally {
      await handle.close()
    }
  }
}

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    '把内容写入文件，目录不存在时会自动创建，会覆盖同名文件原有内容。支持相对路径（基于当前项目目录）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，相对路径基于项目目录解析' },
      content: { type: 'string', description: '要写入的完整内容' }
    },
    required: ['path', 'content']
  },
  requiresApproval: true,
  approvalReason: '将在你的本机磁盘上写入文件，可能覆盖已有内容。',
  async execute(input, context) {
    const { path, content } = z
      .object({ path: z.string().min(1), content: z.string() })
      .parse(input)

    const target = resolveUserPath(context, path)
    guardPrivatePath(target)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
    return `已写入 ${target}（${Buffer.byteLength(content, 'utf8')} 字节）`
  }
}

/**
 * 局部精确替换工具 (对标 Cursor / Cline / Roo Code 核心代码编辑机制)
 * 避免为了修改几行代码而重写数百行整个文件，节省 90%+ 的 Token，彻底杜绝单次输出溢出截断。
 */
export const patchFileTool: ToolDefinition = {
  name: 'patch_file',
  description:
    '对文本文件进行局部精确替换更新。修改现有代码时强烈优先使用此工具（而非 write_file 全量重写），只需在 targetContent 中提供待替换的一小段原代码（必须与文件中原内容逐字匹配），并在 replacementContent 中提供替换后的新代码。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，相对路径基于项目目录解析' },
      targetContent: { type: 'string', description: '要被替换的原文本内容，必须在原文件中唯一存在且逐字匹配' },
      replacementContent: { type: 'string', description: '替换后的新文本内容' }
    },
    required: ['path', 'targetContent', 'replacementContent']
  },
  requiresApproval: true,
  approvalReason: '将对本地代码文件进行局部精确修改。',
  async execute(input, context) {
    const { path, targetContent, replacementContent } = z
      .object({
        path: z.string().min(1),
        targetContent: z.string(),
        replacementContent: z.string()
      })
      .parse(input)

    const target = resolveUserPath(context, path)
    guardPrivatePath(target)
    const raw = await readFile(target, 'utf8')
    // CRLF/LF归一：调用方按LF传锚点、文件是CRLF时同样命中
    const normRaw = raw.replace(/\r\n/g, '\n');
    const normTarget = targetContent.replace(/\r\n/g, '\n');
    const hitExact = raw.includes(targetContent);
    const hitNorm = normRaw.includes(normTarget);
    if (!hitExact && !hitNorm) {
      throw new Error(`在文件 ${target} 中未找到指定的 targetContent。请先调用 read_file 确认目标文件的精确代码块后再重试。`)
    }
    const count = hitExact ? raw.split(targetContent).length - 1 : normRaw.split(normTarget).length - 1
    if (count > 1) {
      throw new Error(`在文件 ${target} 中匹配到 ${count} 处完全相同的内容，无法唯一定位。请在 targetContent 中包含更多上下文行以保证唯一性。`)
    }
    const mapNormOffsetToRaw = (source: string, normOffset: number): number => {
      let ri = 0
      let ni = 0
      while (ni < normOffset && ri < source.length) {
        if (source[ri] === '\r' && source[ri + 1] === '\n') {
          ri += 2
          ni += 1
        } else {
          ri += 1
          ni += 1
        }
      }
      return ri
    }
    const adaptedReplacement = raw.includes('\r\n')
      ? replacementContent.replace(/\r?\n/g, '\r\n')
      : replacementContent
    const updated = hitExact
      ? raw.replace(targetContent, () => adaptedReplacement)
      : (() => {
          const idx = normRaw.indexOf(normTarget)
          const startRaw = mapNormOffsetToRaw(raw, idx)
          const endRaw = mapNormOffsetToRaw(raw, idx + normTarget.length)
          return raw.slice(0, startRaw) + adaptedReplacement + raw.slice(endRaw)
        })()
    await writeFile(target, updated, 'utf8')
    return `已成功对 ${target} 进行局部精确补丁更新。`
  }
}

export const searchFiles: ToolDefinition = {
  name: 'search_files',
  description:
    '在项目目录内按文件名或文件内容搜索。找文件、定位报错、查某段代码在哪里时优先用它，不要用 list_directory 逐层翻。',
  parameters: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: '文件名关键字或片段，如 approval、runtime.ts。缺省则不限文件名' },
      content: { type: 'string', description: '文件内容关键字，如 approval_required。缺省则只按文件名找' },
      path: { type: 'string', description: '搜索起点目录，缺省为项目目录' },
      maxResults: { type: 'integer', description: '最多返回条数，默认 50，最大 200' }
    },
    required: []
  },
  requiresApproval: false,
  async execute(input, context) {
    const { filename, content, path, maxResults } = z
      .object({
        filename: z.string().optional(),
        content: z.string().optional(),
        path: z.string().optional(),
        maxResults: z.number().int().positive().max(200).optional()
      })
      .parse(input ?? {})
    if (!filename && !content) throw new Error('请至少提供 filename 或 content 其中之一')
    const limit = maxResults ?? 50
    const root = resolveUserPath(context, path ?? '.')
    guardPrivatePath(root)
    const skipDirs = new Set(['node_modules', '.git', 'dist', 'out', 'release', '.vite', 'coverage'])
    const nameNeedle = filename?.toLowerCase() ?? null
    const contentNeedle = content?.toLowerCase() ?? null
    const results: string[] = []
    let scanned = 0
    let completed = true
    const visited = new Set<string>()
    const stack: string[] = [root]
    while (stack.length > 0 && results.length < limit && scanned < 5000) {
      const dir = stack.pop()!
      let entries: Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      // 同目录按名排序：同版本同仓多次搜索结果稳定
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (results.length >= limit || scanned >= 5000) break
        const full = resolve(dir, entry.name)
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          // 软链目录不跟进：防 monorepo 互链/环目录扫描爆炸
          if (entry.isSymbolicLink()) continue
          if (!skipDirs.has(entry.name)) {
            try {
              const st = await stat(full)
              const key = `${st.dev}:${st.ino}`
              if (visited.has(key)) continue
              visited.add(key)
              stack.push(full)
            } catch {
              stack.push(full)
            }
          }
          continue
        }
        scanned++
        if (nameNeedle && !entry.name.toLowerCase().includes(nameNeedle)) {
          continue
        }
        if (!contentNeedle) {
          results.push(full)
          continue
        }
        let buffer: Buffer
        try {
          const info = await stat(full)
          if (info.size > 512_000) continue
          buffer = await readFile(full)
        } catch {
          continue
        }
        if (buffer.includes(0)) continue
        // 逐行匹配：返回 file:line: snippet，模型一次定位无需再 read_file
        const lines = buffer.toString('utf8').split('\n')
        let perFile = 0
        for (let i = 0; i < lines.length && results.length < limit && perFile < 5; i++) {
          if (lines[i].toLowerCase().includes(contentNeedle)) {
            const snippet = lines[i].trim().slice(0, 200)
            results.push(`${full}:${i + 1}: ${snippet}`)
            perFile++
          }
        }
      }
    }
    if (stack.length > 0 && scanned >= 5000) completed = false
    const scopeNote = completed ? '已扫完' : '未扫完（达 5000 上限，建议缩小 path 或加 filename 缩小范围后重试）'
    if (results.length === 0) return `在 ${root} 未找到匹配（已扫描约 ${scanned} 个文件，${scopeNote}）`
    return truncate(`在 ${root} 找到 ${results.length} 个匹配（已扫描约 ${scanned} 个文件，${scopeNote}）：\n${results.join('\n')}`)
  }
}

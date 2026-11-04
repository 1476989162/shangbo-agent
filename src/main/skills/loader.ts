import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import log from 'electron-log/main'
import { getSetting } from '../settings'

/**
 * 外部技能目录加载器（对标 Claude Code 的 SKILL.md 机制）。
 *
 * 约定：每个技能是一个目录，里面必须有 SKILL.md（frontmatter 含 name/description）。
 * 顶层 SKILL.md 是路由器（name=xxx Coder），负责告诉模型"什么问题加载哪个技能"。
 * 子技能目录的 SKILL.md 是具体知识（API/示例/陷阱），references/ 是深度文档。
 *
 * 安全：只读文本，不执行；目录穿越防护；单文件 200KB 上限，超了截断。
 */

export interface SkillMeta {
  /** 目录名，如 DataTable、Excel报表 */
  id: string
  name: string
  description: string
  /** SKILL.md 绝对路径 */
  entry: string
  /** 所在技能包根目录 */
  packRoot: string
}

export interface SkillPack {
  root: string
  name: string
  router: string
  skills: SkillMeta[]
}

const SKILL_FILE_MAX = 200_000
const ROUTER_MAX = 60_000

function parseFrontmatter(text: string): { name: string; description: string } {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return { name: '', description: '' }
  const head = match[1]
  const name = head.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? ''
  const description = head.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? ''
  return { name, description }
}

/** 扫描单个技能包根目录：顶层 SKILL.md + 每个子目录的 SKILL.md。 */
export async function scanSkillPack(root: string): Promise<SkillPack | null> {
  const normRoot = resolve(root)
  let entries
  try {
    entries = await readdir(normRoot, { withFileTypes: true })
  } catch {
    return null
  }
  let router = ''
  try {
    const raw = await readFile(join(normRoot, 'SKILL.md'), 'utf8')
    router = raw.slice(0, ROUTER_MAX)
  } catch {
    return null
  }
  const routerMeta = parseFrontmatter(router)
  const skills: SkillMeta[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillFile = join(normRoot, entry.name, 'SKILL.md')
    try {
      const st = await stat(skillFile)
      if (!st.isFile()) continue
      const raw = await readFile(skillFile, 'utf8')
      const meta = parseFrontmatter(raw)
      skills.push({
        id: entry.name,
        name: meta.name || entry.name,
        description: meta.description || '',
        entry: skillFile,
        packRoot: normRoot
      })
    } catch {
      continue
    }
  }
  skills.sort((a, b) => a.id.localeCompare(b.id, 'zh-CN'))
  return { root: normRoot, name: routerMeta.name || basename(normRoot), router, skills }
}

/** 所有已配置技能包目录（设置 agent.skillDirs，最多 10 个）。 */
export function skillDirs(): string[] {
  const dirs = getSetting<string[]>('agent.skillDirs', [])
  return Array.isArray(dirs) ? dirs.filter((d) => typeof d === 'string' && d.trim()).slice(0, 10) : []
}

/** 扫描全部技能包：失败的包跳过，不炸轮。 */
export async function scanAllSkillPacks(): Promise<SkillPack[]> {
  const cached = getCachedSkillPacksSync()
  if (cached) return cached
  const out: SkillPack[] = []
  for (const dir of skillDirs()) {
    try {
      const pack = await scanSkillPack(dir)
      if (pack) out.push(pack)
    } catch (error) {
      log.warn(`[skills] 扫描技能包失败：${dir}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  setCachedSkillPacks(out)
  return out
}

/* ------------------------------------------------------------------ */
/* 进程级缓存：技能包目录扫描是纯磁盘 IO，每轮 runAgentLoop 都扫一次   */
/* 是首字延迟的主因之一。按 skillDirs 指纹缓存 60s，新增技能最多延迟   */
/* 60s 生效，后台可调 read_skill 直读不受影响。                        */
/* ------------------------------------------------------------------ */

let skillPacksCache: { key: string; at: number; packs: SkillPack[]; router: string } | null = null
const SKILL_PACKS_CACHE_TTL_MS = 60_000

function skillDirsKey(): string {
  try {
    return JSON.stringify(skillDirs())
  } catch {
    return ''
  }
}

function getCachedSkillPacksSync(): SkillPack[] | null {
  if (!skillPacksCache) return null
  if (Date.now() - skillPacksCache.at > SKILL_PACKS_CACHE_TTL_MS) {
    skillPacksCache = null
    return null
  }
  if (skillPacksCache.key !== skillDirsKey()) {
    skillPacksCache = null
    return null
  }
  return skillPacksCache.packs
}

function setCachedSkillPacks(packs: SkillPack[]): void {
  try {
    skillPacksCache = {
      key: skillDirsKey(),
      at: Date.now(),
      packs,
      router: buildSkillRouterPromptUncached(packs)
    }
  } catch {
    skillPacksCache = null
  }
}

/** 带缓存的路由提示词：热路径直接命中内存，不扫盘。 */
export function getCachedSkillRouterPrompt(): string | null {
  const packs = getCachedSkillPacksSync()
  if (!packs || !skillPacksCache) return null
  return skillPacksCache.router || null
}

/** 写技能/改 skillDirs 后调用，立即失效，下轮重扫。 */
export function invalidateSkillPacksCache(): void {
  skillPacksCache = null
}

/**
 * 拼进系统提示的技能路由：只放包名+路由器全文（路由器本身就是索引），
 * 不放 48 个子技能全文，避免上下文爆炸。模型按需调 read_skill 读子技能。
 */
function buildSkillRouterPromptUncached(packs: SkillPack[]): string {
  if (packs.length === 0) return ''
  return packs
    .map((pack) => `【外部技能包：${pack.name}】\n目录：${pack.root}\n${pack.router}`)
    .join('\n\n')
    .slice(0, 30_000)
}

export function buildSkillRouterPrompt(packs: SkillPack[]): string {
  return buildSkillRouterPromptUncached(packs)
}

/** 读单个技能全文（含 references 索引，不含 references 正文，按需再读）。 */
export async function readSkillEntry(entryPath: string, packRoot: string): Promise<string> {
  const normEntry = resolve(entryPath)
  const normRoot = resolve(packRoot)
  if (normEntry !== normRoot && !normEntry.startsWith(`${normRoot}\\`) && !normEntry.startsWith(`${normRoot}/`)) {
    throw new Error('越界：只能读取技能包目录内的 SKILL.md。')
  }
  const raw = await readFile(normEntry, 'utf8')
  return raw.slice(0, SKILL_FILE_MAX)
}

/** 读技能包内任意 references 文档（深度细节按需读）。 */
export async function readSkillDoc(packRoot: string, relPath: string): Promise<string> {
  const normRoot = resolve(packRoot)
  const abs = resolve(normRoot, relPath)
  if (abs !== normRoot && !abs.startsWith(`${normRoot}\\`) && !abs.startsWith(`${normRoot}/`)) {
    throw new Error('越界：只能读取技能包目录内的文档。')
  }
  const raw = await readFile(abs, 'utf8')
  return raw.slice(0, SKILL_FILE_MAX)
}

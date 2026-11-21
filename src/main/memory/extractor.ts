import type { WikiPageKind } from './wiki'

/**
 * 后台 Wiki / 记忆提取器（纯函数、零 LLM 调用、零磁盘 IO）。
 *
 * 关键路径纪律：用户发消息 → 模型首字响应之间不允许插入同步模型调用或扫盘，
 * 因此每 5 次成功回合后的提取走本地确定性规则的 Fast Path（结构化字段输出），
 * 由 agentLoop 在 message_done 之后用 setImmediate 异步触发。
 *
 * 这里是「候选提取」而不是「直接落库」：落库由 wikiRepo.applyWikiCandidates 负责，
 * Change Log 的时间戳与摘要始终由 wiki.ts 生成，模型无法伪造历史。
 */
export interface WikiCandidate {
  kind: WikiPageKind
  title: string
  section: string
  body: string
  reason?: string
}

interface Rule {
  kind: WikiPageKind
  section: string
  re: RegExp
  /** 捕获组里是实体名还是整段决策正文 */
  titleFrom?: 'capture' | 'fixed'
  fixedTitle?: string
  reason: string
}

const RULES: Rule[] = [
  {
    kind: 'contact',
    section: '身份',
    re: /(?:我叫|我的名字是|本人是|this is|my name is)\s*([^\s，。,.!！?？:：]{2,20})/i,
    titleFrom: 'capture',
    reason: '用户自述身份'
  },
  {
    kind: 'client',
    section: '客户信息',
    re: /(?:客户|甲方|client)\s*(?:是|叫|为|:|：)?\s*([^\s，。,.!！?？:：]{2,30})/i,
    titleFrom: 'capture',
    reason: '对话中提到的客户/甲方'
  },
  {
    kind: 'project',
    section: '项目概况',
    re: /(?:项目(?:名|名称|叫)?(?:是|叫|为)?|project\s*(?:name)?\s*(?:is|:)?)\s*[:：]?\s*([^\s，。,.!！?？:：]{2,40})/i,
    titleFrom: 'capture',
    reason: '对话中提到的项目'
  },
  {
    kind: 'topic',
    section: '决策',
    fixedTitle: '决策记录',
    titleFrom: 'fixed',
    re: /(?:我们决定|最终决定|已确认|拍板|we decided|decision is)\s*[:：]?\s*([^\n。！？.!?]{4,160})/i,
    reason: '对话中确认的决策'
  },
  {
    kind: 'topic',
    section: '偏好',
    fixedTitle: '用户偏好',
    titleFrom: 'fixed',
    re: /(?:我(?:更)?喜欢|我偏好|请以后|prefer(?:red)?\s+to)\s*([^\n。！？.!?]{2,120})/i,
    reason: '用户表达的长期偏好'
  }
]

const MAX_CANDIDATES = 8
const MAX_BODY_CHARS = 300

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/^[:：,，.\s]+|[:：,，.\s]+$/g, '')
}

/** 从一段对话文本里提取结构化实体候选；无命中时返回空数组，绝不制造噪声记忆。 */
export function extractWikiCandidates(text: string): WikiCandidate[] {
  const source = (text || '').slice(0, 20_000)
  if (!source.trim()) return []
  const out: WikiCandidate[] = []
  const seen = new Set<string>()

  for (const rule of RULES) {
    // 每条规则只取首个命中，避免一段长文本刷出几十个同名页
    const match = rule.re.exec(source)
    if (!match) continue
    const capture = clean(match[1] ?? '')
    if (!capture) continue
    const title = rule.titleFrom === 'fixed' ? (rule.fixedTitle ?? '记录') : capture
    const body = rule.titleFrom === 'fixed' ? capture : `与「${title}」相关的对话记录：${capture}`
    const key = `${rule.kind}:${title.toLowerCase()}:${rule.section}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      kind: rule.kind,
      title,
      section: rule.section,
      body: body.slice(0, MAX_BODY_CHARS),
      reason: rule.reason
    })
    if (out.length >= MAX_CANDIDATES) break
  }
  return out
}

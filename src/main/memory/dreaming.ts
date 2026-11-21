/**
 * Dreaming / Proactive（lite）：受 linger Another Me + Dreaming 启发。
 *
 * linger 语义（docs/proactive.md）：
 * - 每个事件三选一：Tell now（立即提醒）/ Follow up later（记下来稍后查）/ Stay silent（静默）
 * - 22:00–08:00 为 quiet hours：只记录不打扰；每天最多 5 条提醒；同一事项一天只判一次
 * - 每晚 Dreaming：读每条主动消息之后的 20 条回复，"早点告诉我"×2 → 成规则 "这类→立即告诉"；
 *   "没必要"×2 → "这类→静默"。规则是短列表，不是重训。
 *
 * 本模块纯函数实现决策 + 反馈分类 + 线索晋升，可被 scheduler/后台任务调用，也可单测。
 */

export type ProactiveAction = 'tell-now' | 'follow-up' | 'stay-silent'

export interface ProactiveEvent {
  /** 去重键：同一事项一天只判一次 */
  itemKey: string
  /** 事件种类，如 vendor-invoice / delivery / meeting-change / client-reply */
  kind: string
  /** 可选：事件发生时间的小时（0-23），默认用当前时间 */
  hour?: number
}

export interface ProactiveContext {
  /** 当天已提醒条数（由调用方传入计数） */
  remindersToday: number
  /** 今天已判定过的 itemKey 集合 */
  judgedToday: string[]
  /** 用户已学到的规则 kind → action */
  rules: Record<string, ProactiveAction>
  /** 待跟进事项（follow-up 的检查点） */
  followUps?: string[]
}

export interface ProactiveDecision {
  action: ProactiveAction
  reason: string
}

const MAX_REMINDERS_PER_DAY = 5

/** 长期指令词 + 告知动作词同时出现才算「一步成规」，普通吐槽仍走两次线索晋升。 */
const LONG_TERM_RE = /以后|今后|从今以后|每次|凡是|这类都|所有这类|always|from now on|whenever|every time|going forward/i
const NOTIFY_RE = /告诉|提醒|通知|推送|推给|发我|打扰|tell me|notify me|let me know|ping me|remind me/i
// 英文否定词必须带词边界：否则 "whenever" 里的 never 会把「立刻告诉我」误判成「别提醒」。
const NEGATE_RE = /别再|别推|别发|别打扰|不要|不用|不必|\bstop\b|\bdon'?t\b|\bnever\b|\bno need\b/i
const NIGHT_RE = /太晚|深夜|半夜|晚上|夜里|at night|night|evening/i

function currentHour(): number {
  const h = new Date().getHours()
  return Number.isFinite(h) ? h : 12
}

/**
 * 结构化决策原因：调用方按 bucket 分支，不要靠匹配自然语言 reason 驱动状态流转
 * （Linger AGENTS.md 的工程纪律）。
 */
export type ProactiveBucket = 'already-judged' | 'rule' | 'quiet-hours' | 'daily-cap' | 'default'

export interface ProactiveDecisionDetailed extends ProactiveDecision {
  bucket: ProactiveBucket
}

/**
 * 主动提醒决策（纯函数，顺序即优先级）：
 * 1. 同一事项今天已判过 → 静默（一天一次）
 * 2. 已学规则命中 → 按规则
 * 3. quiet hours（22–08）→ 只记录（follow-up），绝不直达 silent（linger 语义）
 * 4. 当天已满 5 条 → 只记录
 * 5. 默认：跟进口（follow-up），由后续检查决定是否 tell-now；调用方可按 kind 覆盖
 */
export function decideProactiveDetailed(
  event: ProactiveEvent,
  ctx: ProactiveContext
): ProactiveDecisionDetailed {
  if (ctx.judgedToday.includes(event.itemKey)) {
    return { action: 'stay-silent', reason: '同一事项今天已判定过，一天只判一次', bucket: 'already-judged' }
  }
  const learned = ctx.rules[event.kind]
  if (learned) {
    return { action: learned, reason: `命中已学规则：${event.kind} → ${learned}`, bucket: 'rule' }
  }
  const hour = event.hour ?? currentHour()
  const quiet = hour >= 22 || hour < 8
  if (quiet) {
    return { action: 'follow-up', reason: 'quiet hours（22–08）只记录不打扰', bucket: 'quiet-hours' }
  }
  if (ctx.remindersToday >= MAX_REMINDERS_PER_DAY) {
    return { action: 'follow-up', reason: '今日提醒已满 5 条，转为跟进', bucket: 'daily-cap' }
  }
  return { action: 'follow-up', reason: '默认跟进：等安静 3 分钟或下次检查再定', bucket: 'default' }
}

/** 旧签名保持不变，既有单测与调用方零改动。 */
export function decideProactive(event: ProactiveEvent, ctx: ProactiveContext): ProactiveDecision {
  const { action, reason } = decideProactiveDetailed(event, ctx)
  return { action, reason }
}

export type FeedbackClass = ProactiveAction | 'none'

export interface FeedbackClassification {
  action: FeedbackClass
  kindHint?: string
  /** 命中「以后这类都…」等直接指令：一步成规，无需等第二次线索。 */
  direct?: boolean
}

/**
 * 用户回复 → 线索分类（中英关键词，linger 表格的本地化）：
 * - 「以后这类/每次有…都立刻告诉我」「from now on / whenever…tell me right away」
 *   → Direct Rule：一步成规，不再等第二条线索
 * - "早点/直接/立刻告诉我" → tell-now
 * - "没必要/不用推/别再提醒" → stay-silent
 * - "稍后/先记下/改天再说" → follow-up
 * - 深夜/太晚 → follow-up（时段规则，绝不直达 stay-silent）
 * - 点赞/收到/无回复 → none（不学）
 */
export function classifyFeedback(text: string): FeedbackClassification {
  const t = (text || '').toLowerCase()
  if (!t.trim()) return { action: 'none' }

  // Direct Response：长期指令词 + 告知/禁止动作词同时出现
  if (LONG_TERM_RE.test(t) && (NOTIFY_RE.test(t) || NEGATE_RE.test(t))) {
    if (NIGHT_RE.test(t)) {
      return { action: 'follow-up', kindHint: 'quiet-hours', direct: true }
    }
    if (NEGATE_RE.test(t)) return { action: 'stay-silent', direct: true }
    if (/稍后|later|先记下/.test(t)) return { action: 'follow-up', direct: true }
    return { action: 'tell-now', direct: true }
  }

  if (/早点|直接告诉|立刻|马上告诉|tell me (right away|directly)|sooner|immediately/.test(t)) {
    return { action: 'tell-now' }
  }
  if (/没必要|不用推|别再提醒|不要再说|stay silent|don'?t (need|remind|push)/.test(t)) {
    return { action: 'stay-silent' }
  }
  if (/稍后|稍晚|先记下|改天|明天再说|follow up|later|keep track/.test(t)) {
    return { action: 'follow-up' }
  }
  if (/太晚|深夜|半夜|too late|at night/.test(t)) {
    // linger 语义：深夜打扰 → 该时段 follow-up，绝不直达 silent
    return { action: 'follow-up', kindHint: 'quiet-hours' }
  }
  return { action: 'none' }
}

export interface Clue {
  kind: string
  action: ProactiveAction
  seen: number
}

export interface LearnedRule {
  kind: string
  action: ProactiveAction
}

/**
 * 线索晋升：同学 kind + 同 action 出现 2 次 → 晋升为规则，清空该 kind 线索。
 * 返回新增规则（0 或 1 条）与更新后的线索表。纯函数，调用方负责持久化。
 */
export function accumulateClues(
  clues: Clue[],
  kind: string,
  action: ProactiveAction
): { clues: Clue[]; promoted: LearnedRule | null } {
  const next = clues.map((c) => ({ ...c }))
  const hit = next.find((c) => c.kind === kind && c.action === action)
  if (hit) {
    hit.seen += 1
  } else {
    next.push({ kind, action, seen: 1 })
  }
  const cur = next.find((c) => c.kind === kind && c.action === action)!
  if (cur.seen >= 2) {
    return {
      clues: next.filter((c) => c.kind !== kind),
      promoted: { kind, action }
    }
  }
  return { clues: next, promoted: null }
}

/**
 * 时段规则：21:00 之后 / 08:00 之前，反馈不得直接落成 stay-silent，
 * 一律降级为 follow-up（只记录、次日再跟进），绝不因为一句深夜吐槽永久闭嘴。
 */
export function applyTimeWindow(action: ProactiveAction, hour = currentHour()): ProactiveAction {
  if ((hour >= 21 || hour < 8) && action === 'stay-silent') return 'follow-up'
  return action
}

/** 直接指令提取：命中即返回可持久化的 LearnedRule，否则 null。 */
export function extractDirectRule(
  text: string,
  kind: string,
  hour = currentHour()
): LearnedRule | null {
  const classified = classifyFeedback(text)
  if (!classified.direct || classified.action === 'none' || classified.action === 'follow-up') {
    return null
  }
  return { kind, action: applyTimeWindow(classified.action, hour) }
}

export interface LearningOutcome {
  clues: Clue[]
  rule: LearnedRule | null
  direct: boolean
}

/**
 * 反馈闭环（纯函数）：Direct Rule 一步成规；普通反馈走线索累加，满 2 次晋升。
 * 调用方（proactiveRepo）只负责把返回的 clues / rule 落库。
 */
export function learnFromFeedback(
  clues: Clue[],
  text: string,
  kind: string,
  hour = currentHour()
): LearningOutcome {
  const direct = extractDirectRule(text, kind, hour)
  if (direct) {
    return { clues: clues.filter((c) => c.kind !== kind), rule: direct, direct: true }
  }
  const classified = classifyFeedback(text)
  if (classified.action === 'none') return { clues, rule: null, direct: false }
  const action = applyTimeWindow(classified.action, hour)
  const next = accumulateClues(clues, kind, action)
  return { clues: next.clues, rule: next.promoted, direct: false }
}

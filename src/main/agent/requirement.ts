/**
 * 输入要求预整理：在发给大模型之前，把用户一句话整理成结构化需求。
 *
 * 刻意不做模型调用——与 intent.ts 同哲学：零延迟、零成本、可单测。
 * 作用是把"目标/约束/验收/不做/缺口默认/执行顺序"先摆出来，
 * 让模型不用自己猜，直接按整理后的结构执行。
 * 若整理与用户原话冲突，一律以原话为准（提示词里已声明）。
 */

import type { IntentMode } from './intent'

export interface RequirementBriefOptions {
  workingDirectory?: string | null
}

const SENT_SPLIT = /[。！？!?\n;；]+/

const ACCEPT_PATTERNS: RegExp[] = [
  /验收/,
  /跑通/,
  /跑起来/,
  /测试通过/,
  /构建通过/,
  /类型检查/,
  /不报错/,
  /端到端/,
  /\be2e\b/i,
  /交付/,
]

const CONSTRAINT_PATTERNS: RegExp[] = [
  /只改[\s\S]{0,12}(?:当前|本|工作区|项目|这个|src|目录)/,
  /只改[\s\S]{0,20}(?:文件|模块|目录|包)/,
  /(?:不要|别|勿|禁止|不能)[\s\S]{0,12}(?:改|动|删|重构|升级|联网|发布|上线|格式化)/,
  /仅[\s\S]{0,12}(?:读|看|复查|分析|定位)/,
  /只读/,
  /不[\s\S]{0,6}(?:联网|发布|上线|改库|删库)/,
]

const NON_GOAL_PATTERNS: RegExp[] = [
  /(?:不要|别|不用|无需|暂时不)[\s\S]{0,20}(?:重构|大改|升级依赖|发布|上线|改样式|动配置)/,
]

const RISK_PATTERNS: RegExp[] = [
  /删库|清表|清掉|清空|清数据|删表|drop|delete\s+from|rm\s+-rf|格式化|删\s*\.git|强制推送|硬重置|密钥|凭据|生产|线上|发布|上线|删文件|删除数据库/,
]

const VERIFY_HINT = /(npm (?:test|run [a-z0-9_-]+)|pytest|cargo test|go test|make test|tsc|vite build)/i

function firstSentences(text: string, maxChars: number): string {
  const parts = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(SENT_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length === 0) return text.replace(/\s+/g, ' ').trim().slice(0, maxChars)
  // 目标取首句 + 次句（若首句过短），避免只剩半句话
  let goal = parts[0]
  if (goal.length < 24 && parts.length > 1) goal += '；' + parts[1]
  return goal.slice(0, maxChars)
}

function pickMatches(text: string, patterns: RegExp[], cap = 4): string[] {
  const out: string[] = []
  for (const p of patterns) {
    // 全局匹配找所有命中片段
    const g = new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g')
    let m: RegExpExecArray | null
    let guard = 0
    while ((m = g.exec(text)) !== null && guard++ < 8) {
      const hit = m[0].trim()
      if (hit && !out.includes(hit)) out.push(hit)
      if (out.length >= cap) break
    }
    if (out.length >= cap) break
  }
  return out
}

/** 是否值得做预整理：寒暄/极短问答跳过，避免每句"你好"都背一段。 */
export function shouldPreorganize(raw: string, mode: IntentMode): boolean {
  const text = raw.trim()
  if (!text) return false
  if (/^(?:你好|您好|hi|hello|hey|谢谢|多谢|在吗)\b/i.test(text) && text.length < 20) return false
  // 与 agentLoop 的 substantive 门槛对齐：builder/wish 本身就是"要动手"，
  // 短句也不该跳过整理；chat 才需要长度门槛防打扰。
  if ((mode === 'builder' || mode === 'wish') && text.length >= 4) return true
  if (text.length < 8) return false
  if (mode === 'chat' && text.length < 24 && !/[。；;\n]/.test(text)) return false
  return true
}

export function buildRequirementBrief(
  raw: string,
  mode: IntentMode,
  options?: RequirementBriefOptions
): string {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (!shouldPreorganize(raw, mode)) return ''

  const goal = firstSentences(text, 300)
  const acceptHits = pickMatches(text, ACCEPT_PATTERNS)
  const constraintHits = pickMatches(text, CONSTRAINT_PATTERNS)
  const nonGoalHits = pickMatches(text, NON_GOAL_PATTERNS)
  const riskHits = pickMatches(text, RISK_PATTERNS)
  const verifyMatch = text.match(VERIFY_HINT)?.[1] ?? ''

  const acceptance =
    mode === 'wish'
      ? acceptHits.length > 0
        ? acceptHits.join('、') + '；无真实验证证据不得宣布完成'
        : '自己改完、自己运行验证；无真实验证证据不得宣布完成'
      : mode === 'builder'
        ? acceptHits.length > 0
          ? acceptHits.join('、') + '；改动落盘 + 最小可行验证'
          : '改动落盘 + 最小可行验证（有测试跑测试）'
        : '给出结论与可执行建议，不修改文件'

  const defaults: string[] = []
  if ((mode === 'builder' || mode === 'wish') && !/(src\/|文件|模块|目录|src\\|[A-Za-z]:\\|\.\w{2,4})/.test(text)) {
    defaults.push('未指明文件范围→默认先全工作区 search_files/glob_files 定位，再收窄到最小改动集')
  }
  if ((mode === 'builder' || mode === 'wish') && !verifyMatch) {
    defaults.push('未指明验证命令→默认用仓库现有 test/typecheck/build（npm test 优先），跑最相关的一项')
  }
  if (text.length >= 60 && mode === 'chat') {
    defaults.push('长描述按任务背景理解，若只是提问请忽略执行顺序')
  }
  if (defaults.length === 0 && mode !== 'chat') {
    defaults.push('无明显缺口，按字面执行；不确定处取最保守默认值并在「假设」中交代')
  }

  const steps =
    mode === 'chat'
      ? '先结论→再理由/机制→必要时给最小例子'
      : '先定位(search/glob)→读(read_file)→小步改(patch_file一次一文件)→跑验证→读错自愈→收尾给交付四件套'

  const lines = [
    '【需求预整理】（本地规则整理，非模型生成；与原话冲突以原话为准）',
    `- 原始需求：${text.slice(0, 400)}`,
    `- 目标：${goal}`,
    `- 背景/约束：${constraintHits.length > 0 ? constraintHits.join('、') : options?.workingDirectory ? `工作区 ${options.workingDirectory} 内，默认只改这里` : '无显式约束，按默认安全边界执行'}`,
    `- 验收标准：${acceptance}`,
    `- 明确不做：${nonGoalHits.length > 0 ? nonGoalHits.join('、') : '无（不要扩大范围）'}`,
  ]
  if (riskHits.length > 0) {
    lines.push(`- 风险信号：${riskHits.join('、')}→命中安全红线必须停下确认`)
  }
  if (verifyMatch) {
    lines.push(`- 用户指定的验证线索：${verifyMatch}`)
  }
  lines.push(`- 缺口与默认解释：${defaults.join('；')}`)
  if (mode !== 'chat') {
    lines.push(`- 建议执行顺序：${steps}`)
  }
  return lines.join('\n')
}

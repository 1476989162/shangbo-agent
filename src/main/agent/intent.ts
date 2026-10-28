/**
 * 自然语言意图理解：把用户一句话转成「本轮该怎么干」。
 *
 * 这里不做模型调用——分类只用于决定系统提示、步数预算与工具放行策略，
 * 必须零延迟、零成本、可单测。模型仍然拥有最终判断权：分类结果只是
 * 默认值，系统提示里明确允许模型在证据充分时自行改变打法。
 */

export type IntentMode = 'chat' | 'builder' | 'wish'

export interface IntentResult {
  mode: IntentMode
  /** 0-1，仅用于日志与调试，不参与安全判定。 */
  confidence: number
  wantsAction: boolean
  wantsDelivery: boolean
  reason: string
}

/** 明确表达「要交付、要自己跑通、不要来回问」的说法。 */
const DELIVERY_PATTERNS: RegExp[] = [
  /验收/,
  /交付/,
  /跑通/,
  /跑起来/,
  /自己(?:跑|改|修|验|搞定|完成)/,
  /直到[\s\S]{0,16}(?:通过|成功|跑通|完成)/,
  /搞定/,
  /做(?:完|好|出来)/,
  /修好/,
  /端到端/,
  /\be2e\b/i,
  /全自动/,
  /不(?:用|要)问/,
  /别问/,
  /自行(?:判断|决定|完成|处理)/,
  /\bverify\b/i,
  /\bacceptance\b/i,
  /make it work/i,
  /fix it and test/i,
  /end[- ]to[- ]end/i
]

/** 动作动词：出现即说明用户想要「做事」，而不是只想聊天。 */
const ACTION_PATTERN =
  /(?:帮我|给我|替我)?(?:改|修改|修复|修|新增|添加|删除|删掉|创建|新建|生成|写|重构|优化|实现|部署|安装|运行|跑|执行|检查|排查|分析|整理|导出|升级|迁移|测试|接入|替换|调整|清理|补全|提交|联调|排查|定位|复现)/

/** 代码/工程对象：与动作动词同时出现时，几乎可以确定是建造任务。 */
const CODE_OBJECT_PATTERN =
  /(文件|代码|项目|工程|目录|仓库|分支|接口|页面|组件|脚本|配置|数据库|数据表|表结构|字段|日志|报错|异常|bug|测试|依赖|路由|样式|文档|函数|方法|类|模块|服务|前端|后端|部署|环境)/i

/** 纯提问信号：没有动作动词时按问答处理。 */
const QUESTION_PATTERN =
  /[?？]|(?:是什么|为什么|为啥|怎么|如何|区别|解释|讲讲|介绍|能不能|可不可以|是否|多少|哪里|哪个|什么意思)/

/** 明确是寒暄/身份询问，避免被长句规则误判成任务。 */
const SMALL_TALK_PATTERN = /^(?:你好|您好|hi|hello|hey|在吗|谢谢|多谢|你是谁|你叫什么)/i

/** 路径或文件名特征：出现即大概率要动工作区。 */
const PATH_PATTERN = /(?:[A-Za-z]:\\|\.{1,2}\/|src\/|[\w.-]+\.(?:ts|tsx|js|jsx|vue|py|json|md|cs|sql|yml|yaml|css|html))/i

function hits(patterns: RegExp[], text: string): number {
  return patterns.reduce((count, pattern) => (pattern.test(text) ? count + 1 : count), 0)
}

/**
 * 分类本轮意图。
 *
 * 优先级：交付型任务 > 动作型任务 > 纯提问 > 寒暄/兜底。
 * 宁可把「提问」判成「建造者」（多读几个文件），也不要把「动手任务」
 * 判成「问答」——后者会让 Agent 只说不做，正是用户最反感的失败方式。
 */
export function classifyIntent(raw: string): IntentResult {
  const text = raw.trim()
  if (!text) {
    return { mode: 'chat', confidence: 0.5, wantsAction: false, wantsDelivery: false, reason: '空消息' }
  }

  const deliveryHits = hits(DELIVERY_PATTERNS, text)
  const hasAction = ACTION_PATTERN.test(text)
  const hasObject = CODE_OBJECT_PATTERN.test(text)
  const hasPath = PATH_PATTERN.test(text)
  const isQuestion = QUESTION_PATTERN.test(text)
  const isSmallTalk = SMALL_TALK_PATTERN.test(text)

  if (isSmallTalk) {
    return { mode: 'chat', confidence: 0.9, wantsAction: false, wantsDelivery: false, reason: '寒暄' }
  }

  if (deliveryHits > 0 && (hasAction || hasObject || hasPath)) {
    return {
      mode: 'wish',
      confidence: Math.min(0.95, 0.72 + deliveryHits * 0.06),
      wantsAction: true,
      wantsDelivery: true,
      reason: `命中交付信号 ${deliveryHits} 处`
    }
  }

  if (hasAction && (hasObject || hasPath)) {
    return {
      mode: 'builder',
      confidence: 0.78,
      wantsAction: true,
      wantsDelivery: false,
      reason: '动作 + 工程对象'
    }
  }

  if (hasAction && !isQuestion) {
    return {
      mode: 'builder',
      confidence: 0.64,
      wantsAction: true,
      wantsDelivery: false,
      reason: '动作指令'
    }
  }

  if (isQuestion) {
    return { mode: 'chat', confidence: 0.8, wantsAction: false, wantsDelivery: false, reason: '提问句式' }
  }

  // 长描述即使没有明显动词，也更可能是任务背景说明；短句则按问答处理。
  if (text.length >= 60) {
    return { mode: 'builder', confidence: 0.55, wantsAction: false, wantsDelivery: false, reason: '长任务描述' }
  }

  return { mode: 'chat', confidence: 0.5, wantsAction: false, wantsDelivery: false, reason: '默认问答' }
}

/**
 * 任务契约：把自然语言压成模型每轮都能看到的目标/验收/提问边界。
 *
 * 这是「少问多做」的核心手段——不是求模型少问，而是把「什么情况下才允许问」
 * 写成可执行的判据，并允许模型对不确定处先取默认值、最后集中交代假设。
 */
export function buildTaskContract(
  raw: string,
  mode: IntentMode,
  options?: { workingDirectory?: string | null }
): string {
  const goal = raw.replace(/\s+/g, ' ').trim().slice(0, 400)
  if (!goal) return ''

  const completion =
    mode === 'wish'
      ? '自己改完、自己运行验证；没有真实验证证据不得宣布完成'
      : mode === 'builder'
        ? '改动必须落盘，并做最小可行验证（有测试就跑测试）'
        : '给出结论与可执行建议，不修改文件'

  const lines = [
    '【任务契约】',
    `- 目标：${goal}`,
    `- 完成判定：${completion}`,
    '- 决策方式：能推断的直接按最合理默认值执行，不请求许可；不确定处在最终回复的「假设」中集中列出。',
    '- 只有三种情况才提问：① 不可逆破坏性操作；② 对外发送/发布等外部副作用；③ 缺少必要凭据或目标对象无法定位。',
    '- 必须提问时：一次问全、给出默认选项，不要连续追问。'
  ]
  if (options?.workingDirectory) {
    lines.push(`- 工作区：${options.workingDirectory}（默认只改这里）`)
  }
  return lines.join('\n')
}

const FIX_PLAYBOOK = `
【排障打法】先复现或拿到真实报错 → 用 search_files 定位入口与调用链 → 找最小改动点 → 改完立刻重跑同一验证 → 通过再收尾。不要先大范围重构，不要凭猜测改代码。`

const BUILD_PLAYBOOK = `
【建造打法】先看现有结构与约定（README/入口/同类模块）→ 明确要改的文件清单 → 逐个文件 patch → 跑构建或测试 → 有报错先读栈再改。不要一次重写整个模块。`

const EXPLAIN_PLAYBOOK = `
【解释打法】先一句话结论 → 再给关键理由或机制 → 必要时给一个最小例子。不要堆背景，不要复述问题。`

/**
 * 按任务类型注入一段短打法。只注入一段，避免系统提示膨胀。
 */
export function matchTaskPlaybook(raw: string, mode: IntentMode): string {
  if (mode === 'chat') return EXPLAIN_PLAYBOOK
  const text = raw.toLowerCase()
  if (/(报错|异常|失败|崩溃|不工作|无法|修|bug|error|fail|crash|fix)/i.test(text)) return FIX_PLAYBOOK
  if (/(新增|实现|开发|创建|搭建|接入|重构|迁移|做一|build|implement|create|refactor)/i.test(text)) {
    return BUILD_PLAYBOOK
  }
  return ''
}

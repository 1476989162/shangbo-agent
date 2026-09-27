/**
 * 任务方法论（真能力，不是口号）：特定任务配特定打法。
 *
 * review 意图命中时，把"建地图 → 定点打击 → 分级输出 → 见好就收"的方法论
 * 注入本轮系统提示。平时不注入，避免污染日常问答。
 * 停止条件写进方法论本身——防"逛街"靠"知道何时停"，不靠数步数。
 */

const REVIEW_KEYWORDS = ['review', '复查', '审查', '巡检', '走查', '审计', 'audit', '代码质量']

/** 本轮用户消息是否在要求代码复查。 */
export function matchReviewIntent(text: string): boolean {
  const lowered = text.toLowerCase()
  return REVIEW_KEYWORDS.some((kw) => lowered.includes(kw.toLowerCase()))
}

export const REVIEW_PLAYBOOK = `
【代码复查方法】本轮是复查任务，按此执行：
1. 建地图：先读 AGENTS.md / CLAUDE.md / README / 项目文件（sln、csproj、package.json），明确入口、分层与数据流。不许逐层翻目录。
2. 定点打击：入口（启动与中间件顺序）→ 鉴权（控制器/路由）→ 数据（SQL 拼接、ORM 用法、事务）→ 密钥与配置；用 search_files 按特征搜（SQL 拼接、空 catch、硬编码密码、TODO），不靠肉眼扫全仓。
3. 分级输出：按严重/建议分级，每条写清文件位置、问题一句话、改法一句话，不铺垫。
4. 见好就收：覆盖完指定模块即输出；没指定模块时先给全仓风险面概览，再问用户深入哪块，不要地毯式遍历。
5. 只查不修：除非用户明确说修，否则不写文件。`

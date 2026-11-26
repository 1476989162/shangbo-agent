import { z } from 'zod';
import { truncate, type ToolDefinition } from './core';

export const listSkills: ToolDefinition = {
  name: 'list_skills',
  description:
    '列出已配置外部技能包里的全部技能（id/名称/简介）。当用户问题涉及外部技能领域、或不确定该加载哪个技能时先调它。',
  parameters: { type: 'object', properties: {}, required: [] },
  requiresApproval: false,
  async execute() {
    const { scanAllSkillPacks } = await import('../skills/loader')
    const packs = await scanAllSkillPacks()
    if (packs.length === 0) return '尚未配置外部技能目录：请到 设置 → 技能中心 添加（如 D:\\foxtable\\foxtablecoderv7）。'
    return packs
      .map((pack) => `【${pack.name}】${pack.root}\n${pack.skills.map((s) => `- ${s.id}：${s.name}——${s.description}`).join('\n')}`)
      .join('\n\n')
  }
}

export const readSkill: ToolDefinition = {
  name: 'read_skill',
  description:
    '读取指定外部技能的 SKILL.md 全文（含 references 索引）。按路由器指引命中某个技能后调它拿 API、示例与陷阱；深度细节再用 skillDoc 参数读 references 文档。',
  parameters: {
    type: 'object',
    properties: {
      skillId: { type: 'string', description: '技能目录名，如 DataTable、Excel报表' },
      doc: { type: 'string', description: 'references 下的相对路径，如 references/01-DataTable概述.md；不填则只读 SKILL.md' }
    },
    required: ['skillId']
  },
  requiresApproval: false,
  async execute(input) {
    const { skillId, doc } = z
      .object({ skillId: z.string().min(1), doc: z.string().optional() })
      .parse(input)
    const { scanAllSkillPacks, readSkillEntry, readSkillDoc } = await import('../skills/loader')
    const packs = await scanAllSkillPacks()
    for (const pack of packs) {
      const hit = pack.skills.find((s) => s.id === skillId || s.name === skillId)
      if (!hit) continue
      if (doc) return readSkillDoc(pack.root, doc)
      return readSkillEntry(hit.entry, pack.root)
    }
    return `未找到技能：${skillId}。请先调 list_skills 看可用技能 id。`
  }
}
/**
 * Personal Wiki 双榜检索（linger Wiki-and-memory）：
 * 概览榜给实体全貌，精确榜给历史原话；最多 6 个中英别名参与 RRF 融合。
 * 只读、免审批，动态 import 避免工具注册表顶层带上 DB 依赖。
 */
export const wikiSearch: ToolDefinition = {
  name: 'wiki_search',
  description:
    '检索个人记忆库：返回「Wiki 实体概览榜」（人物/客户/项目/主题的结构化页面）与「原始对话精确榜」（命中关键词的历史消息片段）。需要查以前聊过的人、项目、决策、报价时用。可传最多 6 个中英同义词/别名提高召回率。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '主查询词，如「Acme 报价」' },
      alternateQueries: {
        type: 'array',
        items: { type: 'string' },
        description: '最多 6 个同义词 / 英文名 / 别名，各自成榜做 RRF 融合',
        maxItems: 6
      },
      kind: {
        type: 'string',
        enum: ['client', 'contact', 'project', 'topic', 'session'],
        description: '只查某一类实体页'
      },
      limit: { type: 'number', description: '每榜返回条数，默认 5' }
    },
    required: ['query']
  },
  requiresApproval: false,
  async execute(input) {
    const params = z
      .object({
        query: z.string().min(1).max(300),
        alternateQueries: z.array(z.string().min(1).max(300)).max(6).optional(),
        kind: z.enum(['client', 'contact', 'project', 'topic', 'session']).optional(),
        limit: z.number().int().min(1).max(20).optional()
      })
      .parse(input)
    const { searchKnowledge } = await import('../memory/wikiRepo')
    return truncate(JSON.stringify(searchKnowledge(params), null, 2))
  }
}

/** Section 级记忆写入：Change Log 的时间戳与摘要由代码生成，模型不可伪造。 */
export const wikiUpsert: ToolDefinition = {
  name: 'wiki_upsert',
  description:
    '把一条事实写入个人记忆库（Personal Wiki）。按「实体页 + Section」组织：同名 Section 覆盖并记改写理由，页面有自动 Change Log。用于记住客户、联系人、项目、决策、偏好等跨会话要复用的信息；不要用来存临时输出或大段日志。',
  parameters: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['client', 'contact', 'project', 'topic', 'session'],
        description: '实体类型'
      },
      title: { type: 'string', description: '实体名，如「Acme」「李总」「尚搏 Agent」' },
      section: { type: 'string', description: '页内小节名，如「报价」「决策」「偏好」' },
      body: { type: 'string', description: '该小节的正文，上限 3000 字符' },
      reason: { type: 'string', description: '本次改写理由（可选，会写入 Change Log）' },
      links: { type: 'array', items: { type: 'string' }, description: '关联的其他实体页 id（可选）' }
    },
    required: ['kind', 'title', 'section', 'body']
  },
  requiresApproval: false,
  async execute(input) {
    const params = z
      .object({
        kind: z.enum(['client', 'contact', 'project', 'topic', 'session']),
        title: z.string().min(1).max(120),
        section: z.string().min(1).max(120),
        body: z.string().min(1).max(3_000),
        reason: z.string().max(200).optional(),
        links: z.array(z.string().max(200)).max(20).optional()
      })
      .parse(input)
    const { upsertWikiPage } = await import('../memory/wikiRepo')
    const page = upsertWikiPage(params)
    return `已写入记忆库：${page.title} / ${params.section}（页面 id：${page.id}，Change Log ${page.changes.length} 条）。`
  }
}

/**
 * Meta / AlterEgo 异步分身工具集（非阻塞）：
 * 动态 import 避免 tools → taskDelegation → runtime → tools 的循环依赖。
 */
export const taskCreate: ToolDefinition = {
  name: 'task_create',
  description:
    '把一个耗时较长、可独立推进的任务派给后台分身（AlterEgo），立即返回 taskId，不阻塞当前对话。分身有独立隐藏会话与 .shangbo-tasks/<taskId>/ 产出目录，完成后用 task_status 查结果。同一会话最多 10 个并发分身。复杂多角色任务可传 team 生成 team.md 协作协议。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '任务标题' },
      brief: { type: 'string', description: '任务目标、范围与交付要求，尽量具体' },
      team: {
        type: 'object',
        description: '可选：多角色协作协议，会写成 team.md',
        properties: {
          goal: { type: 'string' },
          coordinator: { type: 'string' },
          members: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                role: { type: 'string' },
                receivesFrom: { type: 'array', items: { type: 'string' } },
                deliverable: { type: 'string' }
              },
              required: ['id', 'role', 'deliverable']
            }
          }
        },
        required: ['goal', 'members']
      }
    },
    required: ['title', 'brief']
  },
  requiresApproval: false,
  async execute(input, context) {
    const params = z
      .object({
        title: z.string().min(1).max(200),
        brief: z.string().min(1).max(8_000),
        team: z
          .object({
            goal: z.string().min(1).max(2_000),
            coordinator: z.string().max(100).optional(),
            members: z
              .array(
                z.object({
                  id: z.string().min(1).max(100),
                  role: z.string().min(1).max(200),
                  receivesFrom: z.array(z.string().max(100)).max(10).optional(),
                  deliverable: z.string().min(1).max(500)
                })
              )
              .max(10)
          })
          .optional()
      })
      .parse(input)
    const delegation = await import('../agent/taskDelegation')
    if (delegation.isDelegatedChildConversation(context.conversationId)) {
      throw new Error('分身不允许再创建分身（禁止无限套娃）')
    }
    const result = delegation.startTask({
      parentConversationId: context.conversationId,
      title: params.title,
      brief: params.brief,
      workingDirectory: context.workingDirectory,
      team: params.team
    })
    return truncate(JSON.stringify(result, null, 2))
  }
}

export const taskStatus: ToolDefinition = {
  name: 'task_status',
  description:
    '查询本会话派出的后台分身状态（running / waiting_for_approval / idle / failed / canceled）、最新汇报与产出目录。不传 taskId 时列出全部。',
  parameters: {
    type: 'object',
    properties: { taskId: { type: 'string', description: '可选：只查指定分身' } },
    required: []
  },
  requiresApproval: false,
  async execute(input, context) {
    const params = z.object({ taskId: z.string().min(1).optional() }).parse(input ?? {})
    const delegation = await import('../agent/taskDelegation')
    const tasks = delegation.listDelegatedTasks(context.conversationId, params.taskId)
    return truncate(JSON.stringify({ tasks }, null, 2))
  }
}

export const taskSend: ToolDefinition = {
  name: 'task_send',
  description: '给正在运行或已 idle / canceled 的后台分身追加补充指令，并重新唤醒它的子循环。',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string' },
      instruction: { type: 'string', description: '补充指令，如「顺便把新 Logo 也加上」' }
    },
    required: ['taskId', 'instruction']
  },
  requiresApproval: false,
  async execute(input) {
    const params = z
      .object({ taskId: z.string().min(1), instruction: z.string().min(1).max(8_000) })
      .parse(input)
    const delegation = await import('../agent/taskDelegation')
    const task = delegation.sendInstruction(params.taskId, params.instruction)
    return truncate(
      JSON.stringify({ taskId: task.id, state: task.state, workspaceDir: task.workspaceDir }, null, 2)
    )
  }
}

export const taskCancel: ToolDefinition = {
  name: 'task_cancel',
  description: '暂停 / 取消后台分身（保留已生成文件与子会话历史，之后仍可用 task_send 恢复）。',
  parameters: {
    type: 'object',
    properties: { taskId: { type: 'string' } },
    required: ['taskId']
  },
  requiresApproval: false,
  async execute(input) {
    const params = z.object({ taskId: z.string().min(1) }).parse(input)
    const delegation = await import('../agent/taskDelegation')
    const task = delegation.cancelTask(params.taskId)
    return truncate(JSON.stringify({ taskId: task.id, state: task.state }, null, 2))
  }
}

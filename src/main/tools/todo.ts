import { z } from 'zod'
import type { TodoItem } from '../../shared/types'
import type { ToolDefinition } from './index'

const todoItems = new Map<string, TodoItem[]>()

export function getTodoItems(runId: string): TodoItem[] {
  return todoItems.get(runId) ?? []
}

export function clearTodoItems(runId: string): void {
  todoItems.delete(runId)
}

export function createTodoWriteTool(): ToolDefinition {
  return {
    name: 'todo_write',
    description:
      '维护当前任务清单。每次传入完整清单覆盖旧值，适合长任务中记录已完成、进行中和待办事项。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '完整任务清单',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '稳定标识，例如 task-1' },
              content: { type: 'string', description: '任务内容' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: '任务状态'
              }
            },
            required: ['id', 'content', 'status']
          }
        }
      },
      required: ['todos']
    },
    requiresApproval: false,
    async execute(input, context) {
      const { todos } = z
        .object({
          todos: z
            .array(
              z.object({
                id: z.string().min(1),
                content: z.string().min(1),
                status: z.enum(['pending', 'in_progress', 'completed'])
              })
            )
            .max(100)
        })
        .parse(input)

      const snapshot = todos.map((todo) => ({ ...todo }))
      todoItems.set(context.runId, snapshot)
      const done = snapshot.filter((todo) => todo.status === 'completed').length
      return `已更新任务清单：${done}/${snapshot.length} 项完成。`
    }
  }
}

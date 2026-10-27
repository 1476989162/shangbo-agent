import type { AgentEvent } from '../../shared/types'

export type EventSubscriber = (event: AgentEvent) => void

/**
 * 阶段1：进程内事件总线。
 * 之前事件只通过 `window.webContents.send(IPC.agentEvent)` 发给桌面窗口，
 * 手机收不到桌面发起的会话事件。改成总线后：
 * - AgentRuntime 每次 emit 都同时 publish 到总线（见 runtime.ts 的 withBus 包装）
 * - 桌面窗口订阅总线（行为不变）
 * - 远程模块订阅总线并转发给手机
 */
class EventBus {
  private subscribers = new Set<EventSubscriber>()

  subscribe(fn: EventSubscriber): () => void {
    this.subscribers.add(fn)
    return () => {
      this.subscribers.delete(fn)
    }
  }

  publish(event: AgentEvent): void {
    for (const fn of [...this.subscribers]) {
      try {
        fn(event)
      } catch {
        // 单个订阅者异常不能影响其他订阅者
      }
    }
  }

  subscriberCount(): number {
    return this.subscribers.size
  }

  clear(): void {
    this.subscribers.clear()
  }
}

export const eventBus = new EventBus()

/**
 * 桌面窗口的事件投递入口：订阅总线，把每个事件原样交给 deliver。
 *
 * 约定：AgentRuntime 的 emit 闭包必须是空操作（见 withBus），
 * 投递只走这里。若 emit 也直接投递，同一事件会到达窗口两次，
 * 界面的流式文本就会重复（「你好你好」）。
 */
export function bridgeEventsToWindow(deliver: EventSubscriber): () => void {
  return eventBus.subscribe((event) => deliver(event))
}

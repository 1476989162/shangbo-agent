/**
 * 渲染层显示落盘图片的 URL 拼装。
 * 单独成文件而不是塞进 shared/types.ts——后者是纯类型模块，
 * 放运行时函数会让 `import type { ... } from '@shared/types'` 的用法变得含糊。
 *
 * 与 main/storage/images.ts 里的协议注册必须保持同名。
 */

/** 渲染层显示图片用的自定义协议。 */
export const IMAGE_PROTOCOL = 'shangbo-image'

/**
 * 把落盘的相对路径（如 `<conversationId>/<uuid>.png`）转成 <img> 可用的 URL。
 * 页面因此永远接触不到真实文件系统路径——协议处理器还会做一次根目录校验。
 *
 * 这里对 `.` / `..` 段直接抛错而不是照拼：路径来自 DB，虽由内部生成，
 * 但一旦有脏数据，渲染层就不该负责构造一个注定越界的 URL。
 * 抛错会让图片静默不显示（img 加载失败），好过让请求带着穿越语义发出去。
 */
export function imageFileUrl(file: string): string {
  const segments = file.split('/').filter((segment) => segment.length > 0)
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new Error(`非法的图片路径：${file}`)
    }
  }
  return `${IMAGE_PROTOCOL}://img/${segments.map(encodeURIComponent).join('/')}`
}

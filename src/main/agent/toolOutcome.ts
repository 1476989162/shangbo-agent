/** 单次工具执行结果：截图类工具额外带图回传给模型。 */
export interface ToolOutcome {
  content: string
  isError: boolean
  image?: { mimeType: string; dataUrl: string }
}

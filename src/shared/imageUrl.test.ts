import { describe, expect, it } from 'vitest'
import { imageFileUrl } from './imageUrl'
import type { ContentBlock } from './types'

describe('imageFileUrl', () => {
  it('把相对路径拼成自定义协议 URL', () => {
    expect(imageFileUrl('conv-1/abc.png')).toBe('shangbo-image://img/conv-1/abc.png')
  })

  it('逐段编码，防止文件名里的特殊字符破坏 URL 结构', () => {
    // 会话 id 与文件名都来自外部输入，必须编码后再拼接
    expect(imageFileUrl('a b/c#d.png')).toBe('shangbo-image://img/a%20b/c%23d.png')
  })

  it('拒绝带路径穿越语义的输入', () => {
    expect(() => imageFileUrl('../../secret.png')).toThrow(/非法/)
    expect(() => imageFileUrl('c/../../secret.png')).toThrow(/非法/)
    expect(() => imageFileUrl('c/./x.png')).toThrow(/非法/)
  })

  it('容忍空段，不会产生双斜杠', () => {
    expect(imageFileUrl('/conv//x.png')).toBe('shangbo-image://img/conv/x.png')
  })
})

describe('图片块的持久化形态', () => {
  it('image 块可以只带 file 而不带 dataUrl', () => {
    const block: ContentBlock = { type: 'image', mimeType: 'image/png', file: 'c/1.png' }
    expect(block.file).toBe('c/1.png')
    expect(block.dataUrl).toBeUndefined()
  })

  it('textOf 之类的纯文本提取会自然跳过图片块', () => {
    // 降级路径依赖这一点：图片缺失时不至于让整条消息变成空串
    const blocks: ContentBlock[] = [
      { type: 'image', mimeType: 'image/png', file: 'c/1.png' },
      { type: 'text', text: '看下这个报错' }
    ]
    const text = blocks
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
    expect(text).toBe('看下这个报错')
  })
})

import { describe, expect, it } from 'vitest'
import { resolveKey, supportedKeysHint, toPhysical } from './index'

const fakeNut = { Key: { Enter: 1, Escape: 2, A: 3, F5: 4, Up: 5 } } as never

describe('Computer Use 纯逻辑', () => {
  it('截图像素按比例换算并钳制', () => {
    const shot = { shotWidth: 1280, shotHeight: 720, realWidth: 2560, realHeight: 1440 }
    expect(toPhysical(640, 360, shot)).toEqual({ x: 1280, y: 720 })
    expect(toPhysical(-10, 9999, shot)).toEqual({ x: 0, y: 1439 })
  })

  it('按键名解析：别名/F键/单字符，未知返回 null', async () => {
    await expect(resolveKey(fakeNut, 'enter')).resolves.toBe(1)
    await expect(resolveKey(fakeNut, 'esc')).resolves.toBe(2)
    await expect(resolveKey(fakeNut, 'a')).resolves.toBe(3)
    await expect(resolveKey(fakeNut, 'F5')).resolves.toBe(4)
    await expect(resolveKey(fakeNut, 'F99')).resolves.toBeNull()
    await expect(resolveKey(fakeNut, '随便')).resolves.toBeNull()
    expect(supportedKeysHint()).toContain('Enter')
  })
})

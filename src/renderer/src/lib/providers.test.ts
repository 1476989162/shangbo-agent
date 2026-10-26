import { describe, expect, it } from 'vitest'
import {
  countVisibleModels,
  filterModels,
  getModelKey,
  isFreeModel,
  isModelHiddenByKeys,
  parseHeaders,
  parseModels,
  providerHost,
  providerInitial
} from './providers'

describe('供应商页纯函数 (providers lib)', () => {
  it('parseModels 按换行/逗号/中文逗号切分并去空', () => {
    expect(parseModels('a\nb,c，d\n  \n')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('parseHeaders 忽略注释与非法行', () => {
    expect(parseHeaders('# c\nx-opencode: 1\nbadline\na : b')).toEqual({
      'x-opencode': '1',
      a: 'b'
    })
  })

  it('providerHost 取 host，非法地址原样返回', () => {
    expect(providerHost('https://opencode.ai/zen/go/v1')).toBe('opencode.ai')
    expect(providerHost('not-a-url')).toBe('not-a-url')
  })

  it('providerInitial 取前两字符大写', () => {
    expect(providerInitial('OpenCode Go')).toBe('OP')
    expect(providerInitial('')).toBe('?')
  })

  it('显隐 key 兼容新老格式', () => {
    const pid = 'opencode-go'
    expect(getModelKey(pid, 'm')).toBe('opencode-go::m')
    expect(isModelHiddenByKeys(['opencode-go::m'], pid, 'm')).toBe(true)
    expect(isModelHiddenByKeys(['m'], pid, 'm')).toBe(true)
    expect(isModelHiddenByKeys([], pid, 'm')).toBe(false)
    expect(countVisibleModels(['opencode-go::m'], pid, ['m', 'n'])).toBe(1)
  })

  it('filterModels 支持筛选与仅所选', () => {
    const models = ['DeepSeek V4.1 Flash', 'GLM-5.1', 'Muse Free']
    expect(filterModels(models, 'deepseek', false, [], 'p')).toEqual(['DeepSeek V4.1 Flash'])
    expect(filterModels(models, '', true, ['p::GLM-5.1'], 'p')).toEqual([
      'DeepSeek V4.1 Flash',
      'Muse Free'
    ])
  })

  it('isFreeModel 按 free 子串判定', () => {
    expect(isFreeModel('cline-free/solar-mini')).toBe(true)
    expect(isFreeModel('DeepSeek V4.1 Flash')).toBe(false)
  })
})

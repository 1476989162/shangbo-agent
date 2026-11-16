import { spawnSync } from 'node:child_process'

/**
 * 任何测试、构建或写文件之前的只读发版门禁。
 * 不能复用已有版本标签，也不能让未提交源码混进同名安装包。
 */
export function assertReleasePreflight(version, options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const run = options.run ?? spawnSync
  const git = (args, encoding) => run('git', args, { cwd, encoding, stdio: encoding ? undefined : 'ignore' })
  const status = git(['status', '--porcelain', '-z', '--untracked-files=all'], 'utf8')
  if (status.error || status.status !== 0) {
    throw new Error(`无法读取 Git 工作区状态：${status.error?.message ?? status.stderr ?? 'git status 失败'}`)
  }
  const dirty = status.stdout.split('\0').filter(Boolean).filter((entry) => {
    if (!entry.startsWith('?? ')) return !entry.slice(3).startsWith('release/')
    const path = entry.slice(3)
    // 每条路径都用 argv 传递，避免路径中的空格/引号被当成 shell 代码。
    return git(['check-ignore', '-q', '--', path]).status !== 0
  })
  if (dirty.length) {
    throw new Error(`发版前必须提交源码改动：\n${dirty.slice(0, 30).join('\n')}`)
  }
  const tag = git(['rev-parse', '--verify', '--quiet', `refs/tags/v${version}`])
  if (tag.error) throw new Error(`无法检查目标标签：${tag.error.message}`)
  if (tag.status === 0) {
    throw new Error(`v${version} 已存在，禁止复用旧标签或覆盖同版本 Release；请先递增版本号。`)
  }
}

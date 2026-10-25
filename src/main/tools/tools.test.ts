import { describe, expect, it, vi } from 'vitest'
import { auditCommandSecurity, commandTouchesPrivateData, toolRegistry } from './index'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/* A-3 的绕过场景依赖 userData 目录判断：mock 一个固定的 userData 路径，
   无 Electron 环境下这些目录级检查无法触发。 */
vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\UserData\\shangbo-agent' }
}))

describe('Freebuff 安全护栏审计 (auditCommandSecurity)', () => {
  it('应准确拦截高危全盘删除指令', () => {
    const res1 = auditCommandSecurity('rm -rf /')
    expect(res1.isDangerous).toBe(true)
    expect(res1.severity).toBe('CRITICAL')

    const res2 = auditCommandSecurity('rmdir /s /q c:\\')
    expect(res2.isDangerous).toBe(true)
    expect(res2.severity).toBe('CRITICAL')
  })

  it('应准确拦截磁盘格式化与删库命令', () => {
    const res1 = auditCommandSecurity('format c:')
    expect(res1.isDangerous).toBe(true)

    const res2 = auditCommandSecurity('DROP DATABASE production_db;')
    expect(res2.isDangerous).toBe(true)
    expect(res2.severity).toBe('HIGH')
  })

  it('对普通命令应正常放行', () => {
    const res1 = auditCommandSecurity('git status')
    expect(res1.isDangerous).toBe(false)

    const res2 = auditCommandSecurity('npm test')
    expect(res2.isDangerous).toBe(false)
  })

  it('补充审计：家目录/通配/PS 变体/引导破坏/注册表', () => {
    const critical: string[] = [
      'rm -rf ~',
      'rm -rf $HOME',
      'rm -rf .',
      'rm -rf *',
      'Remove-Item -Recurse -Force C:\\',
      'rd /s /q C:\\',
      'rd /s C:\\',
      'del /s /q C:\\*',
      'bcdedit /delete {current}',
      'vssadmin delete shadows /all',
      'cipher /w:C',
      'reg delete HKLM\\Software\\Test /f'
    ]
    for (const cmd of critical) {
      const res = auditCommandSecurity(cmd)
      expect(res.isDangerous, cmd).toBe(true)
    }
    // mkfs 空格形式同样拦截
    expect(auditCommandSecurity('mkfs -t ext4 /dev/sda').isDangerous).toBe(true)
  })

  it('A-2 反例：日常开发命令不命中擦盘规则', () => {
    const benign = [
      'rm -rf ./dist',
      'rm -rf .vite',
      'rm -rf node_modules',
      'rm -rf *.log',
      'del /q *.tmp',
      'Remove-Item -Recurse .\\out',
      'rd /s /q build'
    ]
    for (const cmd of benign) {
      const res = auditCommandSecurity(cmd)
      expect(res.isDangerous, cmd).toBe(false)
    }
  })

  it('A-2 正例：整个根/家/盘符根/裸通配才命中 CRITICAL', () => {
    const critical = [
      'rm -rf /',
      'rm -rf ~',
      'rm -rf .',
      'rm -rf *',
      'rm -r /',
      'rm -f -r /',
      'rm -rf ~/*',
      'rm -rf $HOME/*',
      'rm -rf "/"',
      'Remove-Item -Recurse -Force C:\\',
      'Remove-Item C:\\ -Recurse -Force',
      'rd /s /q C:\\',
      'rd /s /q D:\\',
      'del /f /s /q C:\\*'
    ]
    for (const cmd of critical) {
      const res = auditCommandSecurity(cmd)
      expect(res.isDangerous, cmd).toBe(true)
      expect(res.severity, cmd).toBe('CRITICAL')
    }
  })

  it('A-2 反例补充：根下的子路径与子目录仍然放行', () => {
    const benign = ['rm -rf ~/docs', 'Remove-Item C:\\projects -Recurse -Force', 'rd /s /q E:\\temp']
    for (const cmd of benign) {
      expect(auditCommandSecurity(cmd).isDangerous, cmd).toBe(false)
    }
  })

  it('run_command 触碰私有数据时直接抛错且不执行', async () => {
    const tool = toolRegistry.get('run_command')!
    const ctx = { conversationId: 't', workingDirectory: null, signal: new AbortController().signal }
    await expect(tool.execute({ command: 'type secrets.json' }, ctx)).rejects.toThrow('禁止访问应用私有数据')
  })

  it('A-3 绕过一：cwd 设为 userData 本身 + 通配符读密钥，被拦', async () => {
    const tool = toolRegistry.get('run_command')!
    const ctx = { conversationId: 't', workingDirectory: null, signal: new AbortController().signal }
    await expect(
      tool.execute({ command: 'type secret*', cwd: 'C:\\UserData\\shangbo-agent' }, ctx)
    ).rejects.toThrow('禁止访问应用私有数据')
    // userData 的子目录同样拒绝
    await expect(
      tool.execute({ command: 'Get-Content secrets.js?n', cwd: 'C:\\UserData\\shangbo-agent\\sub' }, ctx)
    ).rejects.toThrow('禁止访问应用私有数据')
  })

  it('A-3 绕过二：命令里用环境变量/通配符拼私有路径，被拦', async () => {
    const tool = toolRegistry.get('run_command')!
    const ctx = { conversationId: 't', workingDirectory: null, signal: new AbortController().signal }
    await expect(
      tool.execute({ command: 'type %APPDATA%\\shangbo-agent\\secr*' }, ctx)
    ).rejects.toThrow('禁止访问应用私有数据')
    await expect(
      tool.execute({ command: 'gc $env:APPDATA\\shangbo-agent\\*.json' }, ctx)
    ).rejects.toThrow('禁止访问应用私有数据')
    // 目录名被通配符打断的旁路：靠「env 特征 + 私有文件通配形态」组合拦住
    await expect(
      tool.execute({ command: 'type %APPDATA%\\shangbo*\\secr*' }, ctx)
    ).rejects.toThrow('禁止访问应用私有数据')
    expect(commandTouchesPrivateData('type %APPDATA%\\shangbo*\\secr*')).toBe(true)
  })

  it('A-3 误伤检查：裸的同名参数与单纯的环境变量引用不拦', () => {
    // 用户开发本应用时，参数里出现 shangbo-agent 这个词不代表触碰私有目录
    expect(commandTouchesPrivateData('npm test -- shangbo-agent')).toBe(false)
    expect(commandTouchesPrivateData('git clone git@github.com:me/shangbo-agent.git')).toBe(false)
    // 只出现 %APPDATA% 本身、没有私有文件通配形态的普通命令
    expect(commandTouchesPrivateData('echo %APPDATA%')).toBe(false)
    expect(commandTouchesPrivateData('dir %APPDATA%\\npm')).toBe(false)
  })

  it('A-1 工具层：CRITICAL 硬拦截兜底，HIGH 不在工具层拦（交给审批）', async () => {
    const tool = toolRegistry.get('run_command')!
    const ctx = { conversationId: 't', workingDirectory: null, signal: new AbortController().signal }
    // CRITICAL：无论调用方是否审计过，工具层自保直接拦
    await expect(tool.execute({ command: 'rm -rf /' }, ctx)).rejects.toThrow('Freebuff')
    // HIGH：工具层放行（会真正走到 exec，本机没有 DROP 命令而失败，但不是被安全规则拦下）
    const res = (await tool.execute({ command: 'DROP DATABASE production_db;' }, ctx)) as string
    expect(res).toContain('执行失败')
    expect(res).not.toContain('Freebuff')
  })
})

describe('guardPrivatePath 私有目录保护', () => {
  it('拦截 SECRETS.JSON 大小写变体与 .tmp/.bak 后缀', async () => {
    const tool = toolRegistry.get('read_file')!
    const ctx = { conversationId: 't', workingDirectory: null, signal: new AbortController().signal }
    await expect(tool.execute({ path: 'C:/x/SECRETS.JSON' }, ctx)).rejects.toThrow('禁止访问应用私有数据')
    await expect(tool.execute({ path: '/tmp/secrets.json.tmp' }, ctx)).rejects.toThrow('禁止访问应用私有数据')
    await expect(tool.execute({ path: '/tmp/shangbo-agent.db-wal' }, ctx)).rejects.toThrow('禁止访问应用私有数据')
  })
})

describe('read_file 分段读的多字节字符边界', () => {
  it('offsetBytes 切在多字节字符中间时跳到下一个字符边界并提示', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shangbo-utf8-test-'))
    try {
      const file = join(dir, 'utf8.txt')
      // 每个汉字 3 字节：你(E4BDA0) 好(E5A5BD) 世(E4B896) 界(E7958C)
      await writeFile(file, '你好世界', 'utf8')
      const tool = toolRegistry.get('read_file')!
      const res = (await tool.execute(
        { path: file, offsetBytes: 1, maxBytes: 11 },
        { conversationId: 't', workingDirectory: dir, signal: new AbortController().signal }
      )) as string
      expect(res).toContain('好世界')
      expect(res).toContain('残缺字节')
      expect(res).not.toContain('你')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('Cursor / Cline 级代码补丁工具 (patch_file)', () => {
  it('应注册 patch_file 工具', () => {
    const tool = toolRegistry.get('patch_file')
    expect(tool).toBeDefined()
    expect(tool?.name).toBe('patch_file')
  })

  it('能够进行局部精确替换', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shangbo-patch-test-'))
    const testFile = join(dir, 'example.txt')
    try {
      await writeFile(testFile, 'line 1\nline 2: old content\nline 3', 'utf8')
      const tool = toolRegistry.get('patch_file')!
      const res = await tool.execute(
        {
          path: testFile,
          targetContent: 'line 2: old content',
          replacementContent: 'line 2: newly patched'
        },
        {
          conversationId: 'test',
          workingDirectory: dir,
          signal: new AbortController().signal
        }
      )

      expect(res).toContain('局部精确补丁更新')
      const updated = await readFile(testFile, 'utf8')
      expect(updated).toBe('line 1\nline 2: newly patched\nline 3')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('替换内容含 $ 特殊符时原样写入不转义', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shangbo-patch-dollar-'))
    const testFile = join(dir, 'dollar.txt')
    // $&、$1、$$ 在 String.replace 字符串替换中会被转义，必须用函数式替换
    const replacement = 'a $& b $$ c $1 d'
    try {
      await writeFile(testFile, 'before\nTARGET\nlate', 'utf8')
      const tool = toolRegistry.get('patch_file')!
      await tool.execute(
        { path: testFile, targetContent: 'TARGET', replacementContent: replacement },
        { conversationId: 'test', workingDirectory: dir, signal: new AbortController().signal }
      )
      const updated = await readFile(testFile, 'utf8')
      expect(updated).toBe(`before\n${replacement}\nlate`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('search_files 行号与截断标记', () => {
  it('内容命中返回 file:line: snippet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shangbo-search-test-'))
    try {
      await writeFile(dir + '/a.txt', '第一行\n关键词在这里\n第三行', 'utf8')
      const tool = toolRegistry.get('search_files')!
      const res = (await tool.execute(
        { content: '关键词', path: dir },
        { conversationId: 't', workingDirectory: null, signal: new AbortController().signal }
      )) as string
      expect(res).toContain('a.txt:2:')
      expect(res).toContain('关键词')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

#!/usr/bin/env node
/**
 * 一键发版：校验 → 打包到工作区外 → 验 sha → 拷回 release/ → 打 tag → gh 传三件套。
 * 解决历史痛点：release/win-unpacked EBUSY 锁死、中文包名文档过时、latest.yml 漏传。
 * 用法：npm run release -- 0.3.1
 *   版本号不传则直接读 package.json 当前 version。
 */
import { execSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function sh(cmd, opts = {}) {
  console.log(`$ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', ...opts })
}

function fail(msg) {
  console.error(`[release] ${msg}`)
  process.exit(1)
}

const argVersion = process.argv[2]?.trim()
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const version = argVersion || pkg.version
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`版本号不合法: ${version}`)

if (argVersion && argVersion !== pkg.version) {
  fail(`传入版本 ${argVersion} 与 package.json ${pkg.version} 不一致，先改 package.json 再发`)
}

console.log(`[release] 版本 v${version} 开始`)

// 1. 发布前校验
sh('npm run typecheck')
sh('npm test -- --run')

// 2. 重新生成 out/ 后再打包。electron-builder 只消费现成构建产物，
// 不跑 build 会把上一次开发或旧版本的 out/ 原样打进安装包。
sh('npm run build')

// 3. 打包到工作区外（避开 release/win-unpacked 被索引器锁死）
// 某些 Windows 环境下 electron-builder 解压官方 Electron zip 会长时间卡住；
// 可用 ELECTRON_DIST 指向已解压的 Electron 分发目录绕开这一步。
const outDir = join(tmpdir(), `shangbo-rel-${version.replaceAll('.', '')}-${Date.now()}`)
mkdirSync(outDir, { recursive: true })
const electronDist = process.env.ELECTRON_DIST?.trim()
const electronDistArg = electronDist ? ` --config.electronDist="${electronDist}"` : ''
sh(`npx electron-builder --win${electronDistArg} --config.directories.output=${outDir}`)

// 4. 验三件套
const exe = `shangbo-agent-setup-${version}.exe`
const blockmap = `${exe}.blockmap`
for (const f of [exe, blockmap, 'latest.yml']) {
  const p = join(outDir, f)
  if (!existsSync(p)) fail(`产物缺失: ${p}`)
  console.log(`[release] ok ${f} ${(statSync(p).size / 1024 / 1024).toFixed(1)}MB`)
}
const latest = readFileSync(join(outDir, 'latest.yml'), 'utf8')
if (!latest.includes(`version: ${version}`) || !latest.includes(`path: ${exe}`)) {
  fail('latest.yml 版本/文件名与目标不一致')
}

// 5. 拷回 release/
mkdirSync('release', { recursive: true })
copyFileSync(join(outDir, exe), join('release', exe))
copyFileSync(join(outDir, blockmap), join('release', blockmap))
copyFileSync(join(outDir, 'latest.yml'), join('release', 'latest.yml'))
copyFileSync(join(outDir, 'latest.yml'), join('release', `latest-${version}.yml`))
console.log('[release] 已拷回 release/')

// 6. git 提交检查：工作区必须干净（构建产物/忽略目录除外）
const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim()
const dirty = status
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  // ?? 未跟踪：只看是否被 gitignore 忽略（release/、dist-mobile/、outputs/ 等构建/本地产物跳过）
  // M 已跟踪：示例文档的行尾空格类改动也视为脏，必须先提交
  .filter((l) => {
    if (l.startsWith('??')) {
      const p = l.slice(3).trim()
      try {
        execSync(`git check-ignore -q "${p}"`, { stdio: 'ignore' })
        return false
      } catch {
        return true
      }
    }
    return !l.includes('release/')
  })
if (dirty.length) {
  console.log('[release] 工作区还有未提交改动（已忽略 release/）：\n' + dirty.join('\n'))
  fail('先提交代码再打 tag，避免 tag 与代码错位')
}

// 7. 打 tag
const tag = `v${version}`
const tagExists = spawnSync('git', ['rev-parse', tag], { stdio: 'ignore' }).status === 0
if (!tagExists) {
  sh(`git tag -a ${tag} -m "shangbo-agent v${version}"`)
} else {
  console.log(`[release] tag ${tag} 已存在，跳过建 tag`)
}
sh(`git push origin ${tag}`)

// 8. gh 发布（三件套一起传，缺 latest.yml 自动更新 404）
const notesFile = existsSync(`outputs/release-${tag}.md`) ? `outputs/release-${tag}.md` : `CHANGELOG.md`
const relExists = spawnSync('gh', ['release', 'view', tag], { stdio: 'ignore' }).status === 0
if (relExists) {
  console.log(`[release] Release ${tag} 已存在，跳过 create（需手动传资产）`)
} else {
  sh(
    `gh release create ${tag} --title "尚搏 Agent v${version}" --notes-file ${notesFile} "release/${exe}" "release/${blockmap}" release/latest.yml`
  )
}

console.log(`[release] 完成：https://github.com/1476989162/shangbo-agent/releases/tag/${tag}`)

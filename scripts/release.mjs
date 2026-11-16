#!/usr/bin/env node
/**
 * 一键发版：校验 → 打包到工作区外 → 验 sha → 拷回 release/ → 打 tag → gh 传三件套。
 * 解决历史痛点：release/win-unpacked EBUSY 锁死、中文包名文档过时、latest.yml 漏传。
 * 用法：npm run release -- 0.3.1
 *   版本号不传则直接读 package.json 当前 version。
 */
import { execSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { assertReleasePreflight } from './release-preflight.mjs'
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

// 必须在构建和写产物之前完成：失败时不产生任何发布文件。
try {
  assertReleasePreflight(version)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

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
const actualSha512 = createHash('sha512').update(readFileSync(join(outDir, exe))).digest('base64')
const match = latest.match(/^sha512:\s*(\S+)$/m)
if (!match || match[1] !== actualSha512) {
  fail('latest.yml 的 SHA-512 与刚生成的安装包不一致，禁止发布')
}

// 5. 拷回 release/
mkdirSync('release', { recursive: true })
copyFileSync(join(outDir, exe), join('release', exe))
copyFileSync(join(outDir, blockmap), join('release', blockmap))
copyFileSync(join(outDir, 'latest.yml'), join('release', 'latest.yml'))
copyFileSync(join(outDir, 'latest.yml'), join('release', `latest-${version}.yml`))
console.log('[release] 已拷回 release/')

// 6. 打 tag（前置门禁已保证它不存在）
const tag = `v${version}`
sh(`git tag -a ${tag} -m "shangbo-agent v${version}"`)
sh(`git push origin ${tag}`)

// 8. gh 发布（三件套一起传，缺 latest.yml 自动更新 404）
const notesFile = existsSync(`outputs/release-${tag}.md`) ? `outputs/release-${tag}.md` : `CHANGELOG.md`
const relExists = spawnSync('gh', ['release', 'view', tag], { stdio: 'ignore' }).status === 0
if (relExists) {
  fail(`Release ${tag} 已存在，禁止静默跳过资产上传；请递增版本或人工核验后另行处理。`)
} else {
  sh(
    `gh release create ${tag} --title "尚搏 Agent v${version}" --notes-file ${notesFile} "release/${exe}" "release/${blockmap}" release/latest.yml`
  )
}

console.log(`[release] 完成：https://github.com/1476989162/shangbo-agent/releases/tag/${tag}`)

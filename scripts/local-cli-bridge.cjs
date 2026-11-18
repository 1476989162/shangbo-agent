#!/usr/bin/env node
/**
 * 本地 CLI 可靠桥：codex / claude / qoder / opencode 以后固定走这里，不走 MCP 的 *_status/*_ask。
 * 根因：MCP 桥用 Node spawn 直接起 `codex`，Windows 下 `.cmd` 解析 + PATH 透传失败，
 *   全报 `spawn xxx ENOENT`；而 cmd.exe（run_command 同通道）走 PATHEXT + 全 PATH，能通。
 * 用法（cwd 固定工作区根）：
 *   node scripts/local-cli-bridge.cjs check                    # 四家版本+登录态全检
 *   node scripts/local-cli-bridge.cjs versions                  # 只查版本（最轻）
 *   node scripts/local-cli-bridge.cjs codex-read [relPath]     # Codex 直读真实路径证明（只读沙箱）
 *   node scripts/local-cli-bridge.cjs codex-exec "任务..."     # 通用只读 Codex 调用
 */
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

const WORKSPACE = resolve(dirname(__filename), '..');

// 绝对路径优先：命中率最高的两处安装位；最后兜底靠 PATH 裸名（cmd.exe 会解析）。
const CANDIDATES = {
  codex: [
    'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\codex.cmd',
    'codex',
  ],
  claude: [
    'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\claude.cmd',
    'claude',
  ],
  qoder: [
    'C:\\Program Files\\Qoder IDE\\bin\\qoder.cmd',
    'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\qoder.cmd',
    'qoder',
  ],
  opencode: [
    // 2026-11-17 修过：postinstall 未跑时 bin 下是 479 字节占位脚本，会报“与 Windows 版本不兼容”。
    // 修法：cd npm/node_modules/opencode-ai && node postinstall.mjs（需联网下真二进制）。
    'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\opencode.cmd',
    'opencode',
  ],
};

function pick(name) {
  for (const c of CANDIDATES[name]) {
    if (c.includes(':\\') || c.includes('\\\\')) {
      if (existsSync(c)) return `"${c}"`;
    } else {
      return c; // 裸名交给 cmd.exe 的 PATH 解析
    }
  }
  return name;
}

// 与本机 run_command 同通道（cmd.exe），保证 .cmd + 中文路径可用。
// 注意：不要用 spawnSync('cmd.exe', ['/c', cmdline]) 再包一层引号，
// Windows 下 Node 会对含空格参数二次加引号，导致 '"C:\...cmd"' 无法识别。
// 实测可用：整条 cmdline + shell:'cmd.exe'（见 M1/M2 验证）。
function viaCmd(cmdline, { timeoutMs = 60000 } = {}) {
  const r = spawnSync(cmdline, {
    cwd: WORKSPACE,
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: 'cmd.exe',
  });
  return {
    ok: r.status === 0,
    code: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error ? String(r.error) : '',
  };
}

function versions() {
  const out = {};
  out.codex = viaCmd(`${pick('codex')} --version`);
  out.claude = viaCmd(`${pick('claude')} --version`);
  out.qoder = viaCmd(`${pick('qoder')} --version`);
  out.opencode = viaCmd(`${pick('opencode')} --version`);
  return out;
}

function logins() {
  // 与之前人工验证通过的命令保持一致：只查态，不发烧钱请求。
  const out = {};
  out.codex = viaCmd(`${pick('codex')} login status`, { timeoutMs: 60000 });
  out.qoder = viaCmd(`${pick('qoder')} status`, { timeoutMs: 60000 });
  out.claude = viaCmd(`${pick('claude')} auth status`, { timeoutMs: 60000 });
  return out;
}

function printResult(title, r) {
  const flag = r.ok ? 'OK  ' : 'FAIL';
  console.log(`[${flag}] ${title} (exit=${r.code})`);
  if (r.stdout) console.log(r.stdout.split('\n').slice(0, 12).join('\n'));
  if (!r.ok) {
    if (r.stderr) console.log(`stderr: ${r.stderr.slice(0, 800)}`);
    if (r.error) console.log(`error: ${r.error.slice(0, 400)}`);
  }
  console.log('---');
}

function cmdCheck() {
  console.log(`workspace: ${WORKSPACE}`);
  const v = versions();
  printResult('codex --version', v.codex);
  printResult('claude --version', v.claude);
  printResult('qoder --version', v.qoder);
  printResult('opencode --version', v.opencode);
  const l = logins();
  printResult('codex login status', l.codex);
  printResult('qoder status', l.qoder);
  printResult('claude auth status', l.claude);

  const versionsOk = v.codex.ok && v.claude.ok && v.qoder.ok && v.opencode.ok;
  // 登录态做宽松判定：关键字命中即算通，避免各家文案漂移误杀。
  const codexLoginOk = l.codex.ok && /API key configured|logged|Login|success/i.test(`${l.codex.stdout} ${l.codex.stderr}`);
  const qoderLoginOk = l.qoder.ok && /Username|Email|Login Method/i.test(l.qoder.stdout);
  const claudeLoginOk = l.claude.ok && /"loggedIn":\s*true|logged.?in/i.test(`${l.claude.stdout} ${l.claude.stderr}`);
  console.log(`[SUMMARY] versions=${versionsOk ? 'OK' : 'FAIL'} logins(codex=${codexLoginOk ? 'OK' : 'FAIL'},qoder=${qoderLoginOk ? 'OK' : 'FAIL'},claude=${claudeLoginOk ? 'OK' : 'FAIL'})`);
  if (!versionsOk) process.exit(1);
  if (!(codexLoginOk && qoderLoginOk && claudeLoginOk)) process.exit(2);
}

function cmdVersions() {
  const v = versions();
  printResult('codex --version', v.codex);
  printResult('claude --version', v.claude);
  printResult('qoder --version', v.qoder);
  printResult('opencode --version', v.opencode);
  if (!(v.codex.ok && v.claude.ok && v.qoder.ok && v.opencode.ok)) process.exit(1);
}

function codexExec(prompt, timeoutMs = 120000) {
  // 只读沙箱 + 跳过 git 检查：子任务沙箱拿不到文件时，直读真实路径的标准姿势。
  const cmdline = `${pick('codex')} exec -C "${WORKSPACE}" --sandbox read-only --skip-git-repo-check "${prompt.replace(/"/g, "'")}"`;
  console.log(`$ ${cmdline}`);
  return viaCmd(cmdline, { timeoutMs });
}

function cmdCodexRead(rel = 'package.json') {
  const abs = resolve(WORKSPACE, rel);
  if (!existsSync(abs)) {
    console.error(`[FAIL] 文件不存在: ${abs}`);
    process.exit(1);
  }
  let expected = '';
  try {
    if (rel.endsWith('package.json')) {
      expected = JSON.parse(readFileSync(abs, 'utf8')).name || '';
    }
  } catch { /* 忽略，交给 Codex 实读 */ }
  const prompt = `读 ${rel} 的 name 字段，只输出 name，一句话`;
  const r = codexExec(prompt);
  console.log(r.stdout.split('\n').slice(-8).join('\n'));
  if (!r.ok) {
    if (r.stderr) console.log(`stderr: ${r.stderr.slice(0, 1000)}`);
    process.exit(1);
  }
  // 交叉核对：Codex 输出里必须含 package.json 真实 name，否则判失败。
  if (expected && !r.stdout.includes(expected)) {
    console.error(`[FAIL] Codex 输出未含期望值 ${expected}，视为直读失败`);
    process.exit(1);
  }
  console.log(`[OK] Codex 直读真实路径成功，期望值=${expected || '(未做交叉核对)'}`);
}

const sub = (process.argv[2] || 'check').toLowerCase();
if (sub === 'check') cmdCheck();
else if (sub === 'versions') cmdVersions();
else if (sub === 'codex-read') cmdCodexRead(process.argv[3] || 'package.json');
else if (sub === 'codex-exec') {
  const prompt = process.argv.slice(3).join(' ').trim();
  if (!prompt) {
    console.error('用法：node scripts/local-cli-bridge.cjs codex-exec "任务描述（只读）"');
    process.exit(1);
  }
  const r = codexExec(prompt);
  console.log(r.stdout);
  if (!r.ok) {
    if (r.stderr) console.error(r.stderr.slice(0, 1000));
    process.exit(r.code ?? 1);
  }
} else {
  console.error(`未知子命令: ${sub}，可用: check | versions | codex-read [rel] | codex-exec "prompt"`);
  process.exit(1);
}

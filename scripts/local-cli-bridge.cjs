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
// Ticket 3：不再硬编码用户目录（C:\Users\Administrator\...），统一取 process.env.APPDATA；
// Windows 无 shell 启动：解析 .cmd shim 拿真实 node.exe + 入口 .js 后 execFile 直调。
const NPM_DIR = process.env.APPDATA ? `${process.env.APPDATA}\\npm` : null;

// 各 CLI 的真实启动体（2026-06 shim 实读）：
//  codex → node 入口 .js；claude → 真实 .exe；qoder → .cjs dispatcher；opencode → 真实 .exe。
const ENTRY_JS = {
  codex: 'node_modules\\@openai\\codex\\bin\\codex.js',
  qoder: 'node_modules\\@qoder-ai\\qodercli\\bundle\\qoder-npm-dispatcher.cjs',
};
const ENTRY_EXE = {
  claude: 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
  opencode: 'node_modules\\opencode-ai\\bin\\opencode.exe',
};

const CANDIDATES = {
  codex: NPM_DIR ? [`${NPM_DIR}\\codex.cmd`] : [],
  claude: NPM_DIR ? [`${NPM_DIR}\\claude.cmd`] : [],
  qoder: ['C:\\Program Files\\Qoder IDE\\bin\\qoder.cmd', NPM_DIR ? `${NPM_DIR}\\qoder.cmd` : null].filter(Boolean),
  opencode: NPM_DIR ? [`${NPM_DIR}\\opencode.cmd`] : [],
};

/** Ticket 3：无 shell 解析。
 * 优先级：① NPM_DIR 下 shim 存在 → node.exe + ENTRY_JS[name] 直调；
 *        ② shim 缺失但 ENTRY_JS 存在 → 同样 node + js；
 *        ③ 都没有 → 返回 { file: name } 交给 execFile 的 OS PATH 解析（仍无 shell，找不到如实 ENOENT）。 */
function resolveNoShell(name) {
  if (process.platform !== 'win32') return { file: name, entryArg: null };
  if (NPM_DIR) {
    // 真实 .exe（claude / opencode）：直接 execFile，无需 node 载体
    const exe = ENTRY_EXE[name];
    if (exe && existsSync(`${NPM_DIR}\\${exe}`)) {
      return { file: `${NPM_DIR}\\${exe}`, entryArg: null };
    }
    // node 入口（codex .js / qoder .cjs）：node.exe + 脚本
    const entry = ENTRY_JS[name];
    if (entry && existsSync(`${NPM_DIR}\\${entry}`)) {
      const localNode = `${NPM_DIR}\\node.exe`;
      return { file: existsSync(localNode) ? localNode : 'node', entryArg: `${NPM_DIR}\\${entry}` };
    }
  }
  // qoder 独立安装位（IDE 自带真二进制）
  if (name === 'qoder') {
    const qoderExe = 'C:\\Program Files\\Qoder IDE\\bin\\qoder.exe';
    if (existsSync(qoderExe)) return { file: qoderExe, entryArg: null };
  }
  // 兜底：OS PATH 解析（仍无 shell），找不到如实 ENOENT
  return { file: name, entryArg: null };
}

// Ticket 3：无 shell 执行。execFile(file, [entryArg?, ...args], { shell: false })，
// 参数永远走 argv 数组，cmd.exe 退出调用链——不再有任何 quoting 依赖。
function viaNoShell(name, args, { timeoutMs = 60000, cwd = WORKSPACE } = {}) {
  const resolved = resolveNoShell(name);
  const finalArgs = resolved.entryArg ? [resolved.entryArg, ...args] : args;
  const r = spawnSync(resolved.file, finalArgs, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: false,
    windowsHide: true,
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
  out.codex = viaNoShell('codex', ['--version']);
  out.claude = viaNoShell('claude', ['--version']);
  out.qoder = viaNoShell('qoder', ['--version']);
  out.opencode = viaNoShell('opencode', ['--version']);
  return out;
}

function logins() {
  // 与之前人工验证通过的命令保持一致：只查态，不发烧钱请求。
  const out = {};
  out.codex = viaNoShell('codex', ['login', 'status'], { timeoutMs: 60000 });
  out.qoder = viaNoShell('qoder', ['status'], { timeoutMs: 60000 });
  out.claude = viaNoShell('claude', ['auth', 'status'], { timeoutMs: 60000 });
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
  // Ticket 3：无 shell 调用。prompt 是单个 argv 元素，不做任何 cmd 字符串转义
  // （旧版 replace(/"/g,"'") 是掩盖性补丁；多行/引号/元字符 prompt 现在原样直传）。
  // 只读沙箱 + 跳过 git 检查：子任务沙箱拿不到文件时，直读真实路径的标准姿势。
  const argv = ['exec', '-C', WORKSPACE, '--sandbox', 'read-only', '--skip-git-repo-check', prompt];
  console.log(`$ codex ${argv.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);
  return viaNoShell('codex', argv, { timeoutMs, cwd: WORKSPACE });
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

# 本地 CLI 可靠调用（codex / claude / qoder / opencode）

> 以后调用这三家，固定走本桥，不再赌 MCP 的 `*_status` / `*_ask`。
> 它们用 Node spawn 直接起裸名，Windows 下 `.cmd` 解析 + PATH 透传失败，
> 现象统一为 `spawn codex/claude/qoder ENOENT`。本桥走 `cmd.exe` 同通道，已验证必通。

## 以后怎么调（默认）

```cmd
node scripts\local-cli-bridge.cjs check
node scripts\local-cli-bridge.cjs versions
node scripts\local-cli-bridge.cjs codex-read package.json
node scripts\local-cli-bridge.cjs codex-exec "只读任务描述"
```

或 npm 快捷方式：

```cmd
npm run cli:check
npm run cli:versions
```

- `check`：四家版本 + 三家登录态（codex login status / qoder status / claude auth status；opencode 只查版本，无登录态概念）。
  版本全通 exit 0；版本通但登录有问题 exit 2；版本不通 exit 1。
- `codex-read [rel]`：Codex 只读沙箱直读工作区真实路径，并与本地文件交叉核对。
  标准姿势：`codex exec -C "G:\尚搏Agent" --sandbox read-only --skip-git-repo-check`。
- `codex-exec "…"`：通用只读调用。要写文件时再人工把 `--sandbox` 换成 `workspace-write`。

## 为什么 MCP 那三个会失败

- `where codex/claude/qoder` 在 cmd.exe 下都能找到（npm 全局 + Qoder IDE bin 都在 PATH）。
- 但 MCP 桥进程的 PATH 与 cmd.exe 不一致，且 spawn 不走 shell，`.cmd` 落不到 PATHEXT 解析。
- 同一台机：`run_command(cmd.exe)` 全通，`codex_status/claude_status/qoder_status` 全 `ENOENT`。
  这是桥的环境 bug，不是没装、不是没登录。

## 已验证基线（2026-11-17，本机）

- codex-cli 0.169.0（API key 已配）、Claude Code 2.1.322（oauth 已登录）、Qoder 1.1.78（browser 已登录）。
- opencode-ai 1.19.5（2026-11-17 已修：postinstall 未跑导致 bin 下是占位脚本，补跑 `node postinstall.mjs` 后真二进制恢复）。
- `codex exec -C "G:\尚搏Agent" --sandbox read-only` 实读 `package.json` 得 `shangbo-agent`，
  与本地文件一致。

## 已知限制：qoder -p 非交互模式在本机坏了（2026-11-17 实测）

- `qoder --list-models` / `qoder status` 正常（登录和网络没问题）。
- 但 `qoder -p ...` 接控制台直接崩溃（exit=3221226505，libuv `UV_HANDLE_CLOSING` 断言），
  重定向到文件则 exit=0 但零字节输出，加 `-m Fast` 也一样。
- 结论：qoder 暂时只能在 IDE 里用，不能像另外三家那样被本机桥调用干活。
  等 Qoder 发新版再用 `npm run cli:versions` 复查。

## 子任务拿不到文件时

不要在沙箱里绕；切到本机桥：

```cmd
node scripts\local-cli-bridge.cjs codex-read package.json
```

`-C` 指向真实工作区根，沙箱只读先行，证伪/证真都以此为准。

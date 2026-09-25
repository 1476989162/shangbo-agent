# 尚搏 Agent

运行在本机的个人 Agent 桌面应用：多模型接入、工具调用、会话以树形存储（支持分支与重新生成）。

## 环境要求

- Node.js 20 以上（开发时使用 24）
- Python 3.10 以上（可选，仅用于预留的 Python 边车通道，不装也能正常跑）

## 运行

```bash
npm install
npm run dev
```

打包 Windows 安装包：

```bash
npm run dist
```

其他脚本：`npm run build`（构建）、`npm run typecheck`（主进程与渲染进程类型检查）。

## 配置模型 Key

应用不内置任何密钥，首次启动必须自己配一个供应商才能对话。

1. 启动后点左下角「设置」，切到「模型供应商」
2. 列表里预置了 DeepSeek / 通义千问 / 智谱 GLM / Claude / Ollama 五个模板，默认都是停用状态
3. 选一个点「编辑」，填入 **API Key**，再点「拉取模型列表」（也可以手动逐行填模型名）
4. 勾上「启用该供应商」并保存
5. 回到对话页，输入框左下角会出现可用的供应商与模型下拉

几个约定：

- **Base URL**：OpenAI 兼容协议（DeepSeek、通义、GLM、Ollama、vLLM 等）要带版本前缀，例如 `https://api.deepseek.com/v1`；Anthropic 填 `https://api.anthropic.com`，不要带 `/v1`。
- **降级行为**：把多个供应商都启用并设置不同的优先级（数值越小越先使用），它们会互为备份。但只有网络错误、首字节超时（连接后 30 秒未返回任何数据）、408、429、5xx 才会自动降级；401 / 400 这类配置错误会直接报错，不会静默切到下一个供应商——否则真正的问题会被掩盖。
- **本地 Ollama**：Base URL 用 `http://localhost:11434/v1`，API Key 随便填一个非空值即可。

## 数据与密钥存放位置

| 内容 | 位置 |
| --- | --- |
| API Key | `<用户数据目录>/secrets.json`，经系统密钥环加密（Windows 为 DPAPI），不落明文 |
| 会话与消息 | `<用户数据目录>/shangbo-agent.db`（SQLite） |
| 运行日志 | `<用户数据目录>/logs/main.log` |

Windows 下用户数据目录通常为 `%APPDATA%\shangbo-agent`。确切路径可以在「设置 → 通用 → 系统信息」里看到。

## 安全设计

本应用把模型输出视为不可信内容，安全设计围绕一个威胁模型展开：**页面能渲染的任何文本（包括工具结果里夹带的提示注入）都不应能触达密钥或本机敏感数据**。以下是已落地的各层防护：

### 进程隔离

- **沙箱**：渲染进程开启 `sandbox: true`，配合 `contextIsolation: true` 与 `nodeIntegration: false`，渲染层没有 Node 能力，与系统的全部交互都收敛到 preload 暴露的窄接口。即使 Markdown 渲染被绕过，攻击面也被进程级隔离兜住。
- **IPC 白名单**：preload 只暴露显式声明的通道（`src/shared/ipc.ts`），主进程对渲染进程传入的所有数据做 zod 校验，内部代码不再重复防御。

### 内容安全策略（CSP）

- `script-src 'self' 'wasm-unsafe-eval'`：只允许本源脚本；`'wasm-unsafe-eval'` 是专用窄指令，仅为代码高亮（Shiki/oniguruma）放行 WebAssembly 编译，不放开 JS `eval`。
- `connect-src` 限制为本源与本地 WebSocket（开发态 HMR），页面无法向任意远端发起请求——模型即便被诱导生成外联代码也无法生效。
- 生产态由 `index.html` 的 meta 标签下发，开发态由主进程在响应头层面再下发一份，双保险。
- 导航防护：渲染层任何导航尝试只允许当前加载源，其余一律拦截并转交系统浏览器，防止注入内容诱导页面跳转。
- Markdown 渲染先过 DOMPurify 消毒再插入 DOM，模型输出里的 HTML/脚本一律视为数据。

### 密钥保护

- **加密存储**：API Key 经系统密钥环加密（Windows 为 DPAPI）后写入 `secrets.json`，数据库中只记录「是否已配置」，不落明文。个别不支持加密的 Linux 环境降级为带 `plain:` 标记的明文并在日志明确告警。
- **原子写入**：密钥文件先写临时文件再原子替换，避免进程在写入中途崩溃留下半个损坏的 JSON（那会导致密钥被容错逻辑静默清空）。非 Windows 平台权限收紧为 `0600`。
- **私有目录防护**：`read_file` / `write_file` / `list_directory` 工具硬编码拒绝访问 userData 下的 `secrets.json` 与 `shangbo-agent.db`（含 `-wal` / `-shm` 伴生文件）。这条防线针对的是提示注入：工具结果里的恶意指令可能诱导模型去「读」密钥文件——审批能拦住「写」，拦不住「读」，所以读取路径直接封死，密钥不会进入对话上下文发往任何供应商。

### 工具审批

- 写文件、执行命令等修改本机的操作必须经用户确认，可选择「始终允许」将某个工具加入永久放行列表（可在设置中一键清空）。
- 确认弹窗展示工具名、风险说明与完整参数；确认有 5 分钟超时，超时按拒绝处理；中断生成会连带取消待确认的请求。
- 命令执行有超时上限（5 分钟）与输出截断，防止单个工具调用撑爆上下文或永久挂起。

### 数据边界

- 外部链接一律交给系统浏览器打开，应用内不承载第三方页面。
- 会话数据存于本地 SQLite，除你配置的模型供应商外不向任何远端发送数据；发送的内容就是对话上下文本体，没有额外的遥测。

## 镜像源

仓库里的 `.npmrc` 指向 `registry.npmmirror.com`，并让 Electron 二进制从国内镜像下载，用于加速中国大陆的安装。

海外环境请直接删除 `.npmrc`，或改回官方源：

```ini
registry=https://registry.npmjs.org/
```

（`electron_mirror` 这一项会让 npm 打印一条 `Unknown project config` 警告，不影响安装，忽略即可。）

## 许可

MIT，见 [LICENSE](./LICENSE)。
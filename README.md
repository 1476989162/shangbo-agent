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
- **降级行为**：把多个供应商都启用并设置不同的优先级（数值越小越先使用），它们会互为备份。但只有网络错误、408、429、5xx 才会自动降级；401 / 400 这类配置错误会直接报错，不会静默切到下一个供应商——否则真正的问题会被掩盖。
- **本地 Ollama**：Base URL 用 `http://localhost:11434/v1`，API Key 随便填一个非空值即可。

## 数据与密钥存放位置

| 内容 | 位置 |
| --- | --- |
| API Key | `<用户数据目录>/secrets.json`，经系统密钥环加密（Windows 为 DPAPI），不落明文 |
| 会话与消息 | `<用户数据目录>/shangbo-agent.db`（SQLite） |
| 运行日志 | `<用户数据目录>/logs/main.log` |

Windows 下用户数据目录通常为 `%APPDATA%\shangbo-agent`。确切路径可以在「设置 → 通用 → 系统信息」里看到。

## 镜像源

仓库里的 `.npmrc` 指向 `registry.npmmirror.com`，并让 Electron 二进制从国内镜像下载，用于加速中国大陆的安装。

海外环境请直接删除 `.npmrc`，或改回官方源：

```ini
registry=https://registry.npmjs.org/
```

（`electron_mirror` 这一项会让 npm 打印一条 `Unknown project config` 警告，不影响安装，忽略即可。）

## 许可

MIT，见 [LICENSE](./LICENSE)。
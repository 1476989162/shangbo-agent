# 中转服务（relay）

只转发密文的中转：桌面主动外连、手机也连它，两边都不用开放端口。
房间模型：一个桌面设备 = 一个 `roomId`；桌面用 `deviceToken` 注册，
手机用配对码换 `phoneToken` 后加入。

## 这个中转会被别人用掉吗

**默认不会。** 桌面端的「手机远程」默认关闭、中转地址默认留空，地址为空时桌面
根本不建立任何外连。中转地址由每台桌面各自在设置里填写，代码里没有任何硬编码
指向某个公共中转。别人下载安装后，只有他自己手动填了你的地址才会连上来。

**但"知道地址"不等于"能用"，要分三层看：**

| 防线 | 挡住谁 | 挡不住谁 |
|---|---|---|
| 默认关闭 + 地址留空 | 不填地址的普通用户 | 手动填了地址的人 |
| `RELAY_ACCESS_KEY` 准入密钥 | 不知道密钥的人 | 知道密钥的人（密钥可能泄露） |
| `RELAY_ALLOWED_DESKTOPS` 身份白名单 | **除你之外的任何人** | 拿到你本机私钥的人 |

要做到**"除了我，谁都不许用"**，必须用身份白名单：服务器只存你的**公钥**，
进门时要求用**私钥签名**。公钥是公开信息（抄走也没用），私钥只在你本机的
safeStorage 里。服务器被看光也伪造不出签名。

## 配置"只有我能用"（推荐）

1. 桌面「设置 → 手机远程」查看 **本机身份指纹**，形如 `3652-AC6F-1A8E-5B97`。
2. 在中转服务器上设置该指纹，重启容器：

```bash
RELAY_ALLOWED_DESKTOPS='3652-AC6F-1A8E-5B97' docker compose up -d
```

也可以用完整公钥（43 字符 base64url），多个身份用逗号分隔。指纹和公钥两种写法
等价，大小写、分隔符都不影响。

3. 之后**任何不在名单里的桌面**连注册都会被拒（`desktop not allowed`）；
   抄走你的公钥但没私钥的，会卡在签名校验（`bad signature`）。

验证脚本（本机直接跑，会真起一个中转并模拟陌生人）：

```bash
cd relay && node scripts/verify-only-me.mjs
```

线上中转自检（不修改任何数据，只读探测）：

```bash
# 探测线上是否仍接受匿名注册
node relay/scripts/probe-online.mjs

# 验证准入密钥：正确密钥能注册、错误/无密钥被拒
# 密钥从环境变量读取，不要写在命令行里（会被 shell 历史记录）
RELAY_KEY='你的密钥' node relay/scripts/verify-access-key.mjs

# 验证资源上限
node relay/scripts/probe-limits.mjs
```

预期输出：

```
[我的桌面]   注册结果：✅ 成功
[陌生人桌面] 注册结果：✅ 被拒 desktop not allowed
[抄我公钥伪造] 注册结果：✅ 被拒 bad signature
✅ 结论：只有我能用这个中转
```

## 设计原则

- **不解析、不存储消息内容**：二进制帧按 `roomId` 原样转发，只记录连接时间与字节数。
- **身份白名单**：Ed25519 挑战-响应。公钥须在名单内，且必须用对应私钥签名；挑战一次性防重放。
- **准入密钥**：设 `RELAY_ACCESS_KEY` 后，桌面注册必须带对同一个密钥（常量时间比较）。
  白名单启用时默认不再强制准入密钥（白名单本身更严格）；要两者并存设 `RELAY_REQUIRE_ACCESS_KEY=1`。
- **配对码一次性**：5 分钟有效、只能用一次，过期/重复使用都失败。
- **吊销即断**：桌面吊销手机后，其中转连接立即断开，token 记入黑名单。
- **限流与心跳**：每连接每 10 秒最多 30 条，超限断开；30 秒心跳，超时断开。
- **单帧上限 1MB**，超限由 `ws.maxPayload` 直接断开。
- **强制 TLS**：生产必须经 Caddy/Nginx 反代（见 `deploy/TLS.md`），只接受 `wss://`。
- **资源有界**：房间数上限 `RELAY_MAX_ROOMS`（默认 5000），空闲空房间 7 天回收，
  吊销黑名单上限 2 万条，同时在线连接上限 `RELAY_MAX_CONNECTIONS`（默认 2000）。
  这些上限是为了防止公网上有人循环注册把进程内存吃光。

## 本地运行

```bash
cd relay
npm install
npm start          # 默认 127.0.0.1:8787
npm test           # 状态机 + 身份鉴权 + 进程级准入测试（node --test）
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `RELAY_PORT` | 8787 | 监听端口 |
| `RELAY_HOST` | 127.0.0.1 | 监听地址（容器内用 0.0.0.0） |
| `RELAY_ALLOWED_DESKTOPS` | 空 | **身份白名单。设置后只服务名单内的桌面（推荐）** |
| `RELAY_ACCESS_KEY` | 空 | 准入密钥。留空且无白名单 = 对公网开放 |
| `RELAY_REQUIRE_ACCESS_KEY` | 空 | 设为 `1` 时白名单与准入密钥都要满足 |
| `RELAY_MAX_ROOMS` | 5000 | 房间数上限 |
| `RELAY_ROOM_IDLE_MS` | 7 天 | 空闲空房间回收时长 |
| `RELAY_MAX_CONNECTIONS` | 2000 | 同时在线连接上限 |

## 自建（Docker）

```bash
cd relay && RELAY_ALLOWED_DESKTOPS='你的指纹' docker compose up -d --build
```

桌面设置里的中转地址填你自己的 `wss://relay.example.com`。若同时用了准入密钥，
把同一个值填到「设置 → 手机远程 → 中转准入密钥」。

## 控制协议（JSON，明文只在 TLS 内）

| op | 发起方 | 说明 |
|---|---|---|
| `register-desktop` | 桌面 | 首次带 `pubKey`（白名单模式下另需 `challenge`+`signature`）；重连带 `deviceToken` |
| `join-phone` | 手机 | 带 `phoneToken` 加入；首次配对同时带 `phonePub`，中转把公钥转交桌面 |
| `pair-issue` | 桌面 | 申请一次性配对码（覆盖旧码） |
| `pair-redeem` | 手机 | 提交配对码换取 `phoneToken` |
| `pair-ack` | 桌面 | 桌面完成 X25519 派生后通知手机 |
| `revoke-phone` | 桌面 | 吊销手机，连接立即断开 |
| `list-phones` | 桌面 | 已配对手机列表 |

业务帧一律为二进制（端到端密文），中转不解析。

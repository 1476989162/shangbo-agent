# 中转服务（relay）

只转发密文的中转：桌面主动外连、手机也连它，两边都不用开放端口。
房间模型：一个桌面设备 = 一个 `roomId`；桌面用 `deviceToken` 注册，
手机用配对码换 `phoneToken` 后加入。

## 设计原则

- **不解析、不存储消息内容**：二进制帧按 `roomId` 原样转发，只记录连接时间与字节数。
- **配对码一次性**：5 分钟有效、只能用一次，过期/重复使用都失败。
- **吊销即断**：桌面吊销手机后，其中转连接立即断开，token 记入黑名单。
- **限流与心跳**：每连接每 10 秒最多 30 条，超限断开；30 秒心跳，超时断开。
- **单帧上限 1MB**，超限由 `ws.maxPayload` 直接断开。
- **强制 TLS**：生产必须经 Caddy/Nginx 反代（见 `deploy/TLS.md`），只接受 `wss://`。

## 本地运行

```bash
cd relay
npm install
npm start          # 默认 127.0.0.1:8787
npm test           # 状态机单测（node --test）
```

环境变量：`RELAY_PORT`（默认 8787）、`RELAY_HOST`（默认 127.0.0.1）。

## 自建（Docker）

```bash
cd relay && docker compose up -d --build
```

桌面设置里的中转地址改成你自己的 `wss://relay.example.com` 即可。

## 控制协议（JSON，明文只在 TLS 内）

| op | 发起方 | 说明 |
|---|---|---|
| `register-desktop` | 桌面 | 首次不带 token（创建 room），重连带 `deviceToken` 认领 |
| `join-phone` | 手机 | 带 `phoneToken` 加入；首次配对同时带 `phonePub`，中转把公钥转交桌面 |
| `pair-issue` | 桌面 | 申请一次性配对码（覆盖旧码） |
| `pair-redeem` | 手机 | 提交配对码换取 `phoneToken` |
| `pair-ack` | 桌面 | 桌面完成 X25519 派生后通知手机 |
| `revoke-phone` | 桌面 | 吊销手机，连接立即断开 |
| `list-phones` | 桌面 | 已配对手机列表 |

业务帧一律为二进制（端到端密文），中转不解析。

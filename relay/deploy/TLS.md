# 中转服务部署（TLS 必需）

中转只转发密文，但**必须经 TLS 反代对外**，拒绝明文 `ws://`。
下面给出 Caddy（推荐，一行自动证书）与 Nginx 示例。

## Caddy

```caddy
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy 默认自动申请并续期证书，反代会带上 `X-Forwarded-Proto: https`，
中转据此放行；明文直连会被 403 拒绝。

## Nginx

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 86400;
    }
}

server {
    listen 80;
    server_name relay.example.com;
    return 301 https://$host$request_uri;
}
```

关键：`X-Forwarded-Proto https` 必须透传，否则中转拒绝握手。

## 自建启动

```bash
cd relay && docker compose up -d --build
# 健康检查
curl http://127.0.0.1:8787/healthz
```

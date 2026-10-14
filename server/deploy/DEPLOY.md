# Mareo 网关部署手册（阿里云 · Docker）

> 本文把网关部署到一台阿里云大陆 ECS，用 `api.mareo.cn`（或你选的子域）提供 HTTPS 服务。
> 适用前提：`mareo.cn` 已在阿里云完成 ICP 备案接入（若备案在他处，需先在阿里云做"接入备案"）。
> 数据库默认 SQLite（单文件，挂载 volume），后续如需 Supabase/Postgres 再迁移（表结构已对齐）。

## 部署拓扑

```text
用户 Mareo ──HTTPS──> api.mareo.cn:443 ──nginx/Caddy──> 127.0.0.1:3000 ──> gateway 容器
                                                              ├── ./data     (SQLite)
                                                              └── ./backups  (每日备份)
gateway 容器内持有 DEEPSEEK_API_KEY，转发到 api.deepseek.com
```

## 0. 前置（阿里云控制台）

- **备案接入**：确认 `mareo.cn` 已备案且接入商为阿里云（ICP 备案控制台可查）。不是的话先做接入备案。
- **ECS**：建议 2 核 2G+，系统 Ubuntu 24.04（或 Alibaba Cloud Linux 3）。大陆地域（如杭州/上海/北京）。
- **安全组**：放行 `22`、`80`、`443`。**不要**放行 `3000`（只绑定 127.0.0.1）。

## 1. DNS

在阿里云云解析里把子域指向服务器：

```
api.mareo.cn  A  <ECS 公网 IP>
```

## 2. 服务器安装 Docker

Ubuntu：

```sh
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
```

阿里云镜像加速（可选，大陆拉镜像更快）：容器镜像服务控制台获取加速地址后写入 `/etc/docker/daemon.json` 并重启 docker。

## 3. 准备代码与配置

把仓库的 `server/` 目录放到服务器（任选）：

```sh
git clone git@github.com:mareo-ai/mareo-0.git /srv/mareo   # 或 scp 仅 server/
cd /srv/mareo/server/deploy
cp .env.example .env
chmod 600 .env
vim .env   # 填 DOMAIN、DEEPSEEK_API_KEY（你自己的真实 key）、DAILY_LIMIT
```

## 4. 数据目录与首次启动

```sh
cd /srv/mareo/server/deploy
mkdir -p data backups
# 容器以 uid 1000(node) 运行，需可写 data/backups：
sudo chown -R 1000:1000 data backups

docker compose up -d --build
docker compose ps                  # gateway 应为 running (healthy)
curl http://127.0.0.1:3000/health # {"ok":true}
docker compose logs -f gateway    # 观察启动日志
```

## 5. 签发用户 token

```sh
cd /srv/mareo/server/deploy
docker compose exec gateway node dist/src/issue-token.js "Alice"
# 输出一行 token（只显示这一次），分发给用户粘进 Mareo 登录窗
```

## 6. HTTPS

**方式 A（推荐 · 阿里云免费证书 + nginx）**
1. 阿里云「数字证书管理服务」申请免费 SSL 证书，绑定 `api.mareo.cn`，下载 **nginx** 格式。
2. 上传证书文件到服务器 `/etc/nginx/certs/`。
3. 安装 nginx（`apt install nginx` 或 Alibaba Cloud Linux `dnf install nginx`）。
4. 复制示例并改域名/证书路径：
   ```sh
   cp nginx-gateway.conf.example /etc/nginx/conf.d/mareo-gateway.conf
   vim /etc/nginx/conf.d/mareo-gateway.conf
   nginx -t && systemctl enable --now nginx
   ```
5. 外网验证：`curl https://api.mareo.cn/health` 应返回 `{"ok":true}`。

**方式 B（备选 · Caddy 自动证书）**
```sh
# Caddyfile
api.mareo.cn {
    reverse_proxy 127.0.0.1:3000
}
```
> 大陆网络下 Let's Encrypt 签发偶有不稳；不稳时切回方式 A 的阿里云证书。

## 7. 备份与恢复

每日自动备份（在线、一致性）：

```sh
crontab -e
# 17 3 * * * cd /srv/mareo/server/deploy && ./backup.sh >> backups/backup.log 2>&1
```

恢复（服务器）：

```sh
cd /srv/mareo/server/deploy
docker compose stop gateway
cp backups/mareo-20260101-030000.db data/mareo.db   # 换成目标备份
sudo chown 1000:1000 data/mareo.db
docker compose start gateway
```

## 8. 升级网关

```sh
cd /srv/mareo
git pull            # 或重新 scp server/
cd server/deploy
docker compose up -d --build   # .env 与 data/ 不动，数据保留
```

## 9. 日常运维速查

```sh
docker compose ps                       # 状态/健康
docker compose logs -f gateway          # 日志
docker compose exec gateway node dist/src/issue-token.js "新用户"
docker compose exec gateway node -e "
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(process.env.DB_PATH ?? 'data/mareo.db')
  // 近 14 天每日调用量
  console.log(db.prepare(\"SELECT substr(ts,1,10) AS day, COUNT(*) AS calls FROM usage GROUP BY day ORDER BY day DESC LIMIT 14\").all())
  // 用户用量排行
  console.log(db.prepare(\`SELECT u.displayName, COUNT(*) AS calls,
      SUM(g.promptChars + g.completionChars) AS chars
      FROM usage g JOIN users u ON u.id = g.userId
      GROUP BY u.id ORDER BY calls DESC LIMIT 20\`).all())
  db.close()
"
```

> `node:sqlite` 在容器里可直接查询；`VACUUM INTO` 备份产物与在线库同 schema。

## 10. 安全与合规备忘

- `.env` 权限 600、绝不进 Git、不进 Docker 镜像层（用 `env_file` 注入）。
- 公网只开 `22/80/443`；`3000` 保持 loopback。
- DeepSeek key 只存在于这台服务器；用户机器上只有网关 token。
- 面向公众提供生成式 AI 服务前：完成生成式 AI/算法备案、隐私政策与用户协议；与 DeepSeek 确认代理商用边界。
- 若日后启用微信登录：`/auth/wechat/callback` 的回调域名即本域名（需备案），网关侧按 `server/docs/wechat-login-design.md` 实现。

## 支付宝充值密钥

放到 `server/deploy/secrets/`（`.gitignore` 已排除，只存在于服务器）：

```
secrets/alipay_app_private.pem   # 应用私钥（chi 600），绝不外传
secrets/alipay_public.pem        # 支付宝公钥
```

`docker-compose.yml` 把该目录以只读方式挂进容器；`.env` 里用相对路径引用：

```
ALIPAY_APP_ID=<开放平台 应用 ID>
ALIPAY_PRIVATE_KEY_PATH=secrets/alipay_app_private.pem
ALIPAY_PUBLIC_KEY_PATH=secrets/alipay_public.pem
```

密钥可以是 PEM，也可以是开放平台密钥工具给出的**不带 PEM 头的一行 base64**（服务端会自己补头）。


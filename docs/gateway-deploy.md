# 网关部署与运维

面向"把网关装到一台阿里云 ECS 并长期跑着"的人。架构与接口见 [gateway.md](gateway.md)。

> 前提：`mareo.cn` 已在阿里云完成 ICP 备案接入。数据库默认 SQLite（单文件挂载卷），
> 表结构已按将来可迁移到 Postgres 的形状设计。

## 部署拓扑

```text
用户 Mareo ──HTTPS──> api.svc.mareo.cn:443 ──nginx──> 127.0.0.1:3000 ──> gateway 容器
                                                          ├── ./data     (SQLite)
                                                          └── ./backups  (每日备份)
容器内持有 DEEPSEEK_API_KEY；OpenAI 请求另经宿主上的加密隧道出网
```

## 0. 前置（阿里云控制台）

- **备案**：确认 `mareo.cn` 已备案且接入商为阿里云。
- **ECS**：建议 2 核 2G+，Ubuntu 24.04（或 Alibaba Cloud Linux 3），大陆地域。
- **安全组**：放行 `22`、`80`、`443`。**不要**放行 `3000`（只绑 loopback）。

## 1. DNS

```text
api.svc.mareo.cn  A  <ECS 公网 IP>
```

## 2. 安装 Docker

```sh
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
```

## 3. 代码与配置

```sh
git clone git@github.com:mareo-ai/mareo-0.git /srv/mareo
cd /srv/mareo/server/deploy
cp .env.example .env && chmod 600 .env
vim .env    # DOMAIN、DEEPSEEK_API_KEY（真实 key）、DAILY_LIMIT、PAYMENT_* 等
```

### 环境变量分组

| 组 | 变量 | 说明 |
|---|---|---|
| 基础 | `DOMAIN` `HOST` `PORT` `DB_PATH` `DAILY_LIMIT` `DAILY_WARN_LIMIT` | `DAILY_LIMIT=0` 表示关闭请求数护栏（生产现状） |
| DeepSeek | `DEEPSEEK_API_KEY` `UPSTREAM_BASE_URL` | 厂商 key 只在这一台机器上 |
| OpenAI | `OPENAI_API_KEY` `OPENAI_BASE_URL` `OPENAI_PROXY_URL` `PRICING_FX_RATE` | 没有 key 时 `/openai/` 返回 503；`PRICING_FX_RATE` 默认 7 |
| 邮件 | `SMTP_*` | 验证码登录 |
| 支付 | `PAYMENT_MODE` `PAYMENT_PUBLIC_BASE_URL` `ALIPAY_*` | 见下方「支付宝密钥」 |

## 4. 首次启动

```sh
cd /srv/mareo/server/deploy
mkdir -p data backups
sudo chown -R 1000:1000 data backups     # 容器内以 uid 1000 运行
docker compose up -d --build
docker compose ps                        # healthy
curl http://127.0.0.1:3000/health        # {"ok":true}
```

## 5. 签发用户 token

```sh
docker compose exec gateway node dist/src/issue-token.js "Alice"
# 输出一行 token（只显示一次），分发给用户粘进 Mareo 登录窗
```

## 6. HTTPS

**方式 A（推荐 · 阿里云免费证书 + nginx）**：申请证书 → 上传到 `/etc/nginx/certs/` →
`cp nginx-gateway.conf.example /etc/nginx/conf.d/mareo-gateway.conf` → 改域名与证书路径 →
`nginx -t && systemctl enable --now nginx` → `curl https://api.svc.mareo.cn/health`。

**方式 B（Caddy 自动证书）**：`reverse_proxy 127.0.0.1:3000`。大陆网络下 Let's Encrypt 偶有不稳，不稳时切回方式 A。

## 7. 备份与恢复

```sh
crontab -e
# 17 3 * * * cd /srv/mareo/server/deploy && ./backup.sh >> backups/backup.log 2>&1
```

恢复：

```sh
docker compose stop gateway
cp backups/mareo-20260101-030000.db data/mareo.db
sudo chown 1000:1000 data/mareo.db
docker compose start gateway
```

## 8. 升级（必须预演）

**不要**直接 `docker compose up -d --build`。用脚本，它会在切换前用生产库的副本验证迁移：

```sh
cd /srv/mareo/server && rsync -az <本机>/server/src/ . && cd deploy
./deploy-gateway.sh
```

脚本做的六件事，顺序不可改：

| 步 | 动作 | 失败时 |
|---|---|---|
| 1 | 备份数据库（`backups/deploy-<时间>.db`）与源码（`src.bak-<时间>`） | 中止 |
| 2 | 构建镜像 | 中止 |
| 3 | **用生产库副本**在隔离容器里跑一次迁移 | 中止，**线上零影响** |
| 4 | 在 3001 端口起新实例（接生产库），等 healthy 并读真实数据 | 停新实例，**线上零影响** |
| 5 | 切 nginx 到 3001，`reload`，从外网验证 | 切回 3000 |
| 6 | 停旧实例 | — |

**只有加表/加列这类向后兼容的迁移能走这个流程**。删列、改类型必须停机窗口，并先公告。

### 回滚

脚本失败会自动回滚；手工回滚：

```sh
cp /etc/nginx/conf.d/mareo-gateway.conf.bak-<时间> /etc/nginx/conf.d/mareo-gateway.conf
nginx -s reload
docker compose --profile next stop gateway-next
docker compose start gateway
```

### 为什么这么严

2026-10-24：一次迁移先建索引、后加列，容器启动即崩、重启 15 次、API 502 十分钟。**部署它的智能体自己也失去了模型访问**——它的调用走的就是这个网关。最后靠外部工具修复。

> 改了 `.env` 之后同样用脚本部署：`docker compose restart` 不会重读 `.env`。

## 9. 日常运维速查

```sh
docker compose ps
docker compose logs -f gateway
docker compose exec gateway node dist/src/issue-token.js "新用户"
docker compose exec gateway node -e "
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(process.env.DB_PATH ?? 'data/mareo.db')
  console.log(db.prepare(\"SELECT substr(ts,1,10) AS day, COUNT(*) AS calls FROM usage GROUP BY day ORDER BY day DESC LIMIT 14\").all())
  db.close()
"
```

`node:sqlite` 在容器里可直接查询；`VACUUM INTO` 备份产物与在线库同 schema。

## 10. 安全与合规

- `.env` 权限 600，绝不进 Git、不进镜像层（用 `env_file` 注入）。
- 公网只开 `22/80/443`；`3000` 保持 loopback。
- 厂商 key 只存在于这台服务器；用户机器上只有网关令牌。
- 面向公众提供生成式 AI 服务前：完成生成式 AI/算法备案、隐私政策与用户协议；与上游确认代理商用边界。
- 用户内容出境：`Mareo-O-*` 的请求会经东京中继发往 OpenAI，隐私说明必须如实写明。

## 支付宝密钥

密钥放 `server/deploy/secrets/`（已 gitignore），只存在于服务器：

```
secrets/alipay_app_private.pem   # 应用私钥
secrets/alipay_public.pem        # 支付宝公钥
```

`docker-compose.yml` 以只读方式挂进容器，`.env` 用相对路径引用。可以是 PEM，也可以是密钥工具给出的**不带 PEM 头的一行 base64**（服务端会补头）。

**属主必须是 uid 1000**，否则容器 `EACCES`：

```sh
chown -R 1000:1000 secrets && chmod 700 secrets && chmod 600 secrets/*.pem
```

## 境外出口（OpenAI 上游）

阿里云杭州的这台机器**连不上 `api.openai.com`**（DNS 被投毒 + TCP 不通）；DeepSeek 可达，Anthropic 也可达。

**明文代理不行。** 实测：从杭州连境外主机的 HTTP CONNECT 代理，`CONNECT api.openai.com:443`
会在代理回话之前被重置——连错误密码都拿不到 407。目标域名在明文 CONNECT 里可见，TLS 握手的
SNI 同样可见，两者都会被拦。**所以必须让流量先进加密隧道**，代理放在隧道远端：

```
gateway 容器 → 172.18.0.1:3129（宿主上的 SSH 隧道）
             → [加密] → 境外中继 127.0.0.1:3128 (tinyproxy) → api.openai.com
```

**中继侧**（`server/deploy/egress-proxy/relay-setup.sh`，在境外主机上跑一次）

- 装 tinyproxy（约 6 MB 常驻），独立配置 `/etc/tinyproxy/mareo.conf` 与独立日志
- `Allow <网关公网 IP>` + `Allow 127.0.0.1`（隧道流量从环回进来）+ 用户名密码
- 把 `gai.conf` 调成优先 IPv4：那台机器**没有 IPv6 路由**，而 `api.openai.com` 是双栈，
  代理按 getaddrinfo 顺序挑到 IPv6 就会让客户端看到连接重置（这一条排查了很久，别再踩）

**网关侧**（`server/deploy/egress-proxy/tunnel-setup.sh`，在杭州跑一次）

- 生成密钥 → 手动加到中继机 `authorized_keys` → 再次运行脚本
- 用 autossh 起 systemd 单元 `mareo-egress-tunnel`，开机自启、断线自动重连
- 隧道绑在 **Docker 网桥地址**（不是 `127.0.0.1`），否则容器里访问不到
- `.env` 写 `OPENAI_PROXY_URL=http://<user>:<pass>@172.18.0.1:3129`

**启动日志**应出现 `OpenAI upstream: https://api.openai.com/v1 at /openai/, via http://172.18.0.1:3129`
（只打印地址，凭据从不出现在日志里）。

**实测记录**（2026-10-21）

| 项 | 结果 |
|---|---|
| 中继机 → `api.openai.com`（IPv4） | 401，0.2s |
| 杭州 → 中继 `CONNECT`（明文） | 连接被重置 |
| 杭州 → SSH 隧道 → 中继 | 401，0.6s |
| 容器内经隧道调 `gpt-6-sol` | 200，2.8–3.2s |
| 计费核对（11 输入 / 5 输出，汇率 7） | `actualMicro` 504、`billableMicro` 656，与手工复算一致 |
| 停掉隧道 | 502 `upstream unreachable`，`actualMicro` 为 NULL（不计费） |

**行为与边界**

- 代理**只作用于 OpenAI 上游**；DeepSeek 仍直连、不跨境（这是这条路线的全部意义）。
- 代理挂掉时客户端收到 **502**，usage 记为失败、`actualMicro` 为 NULL——**不计费，也不回退直连**（直连本就不通，静默回退只会掩盖故障）。
- 凭据只存在服务器 `.env`（600），不进客户端、不进日志、不进报表。
- 出口是单点：隧道挂了只有 OpenAI 模型不可用，用户可以切回 `Mareo-D-*` 继续工作。

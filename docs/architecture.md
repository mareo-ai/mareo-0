# 系统架构

Mareo 是 **DeepSeek Harness（DSH）的桌面薄壳** + **自建网关**。两句话：

- 客户端不 fork DSH，只通过环境变量、`--patch` overlay 和插件注入定制它。
- 用户不需要任何厂商 API key；厂商 key 只在网关的服务器上。

## 一张图

```
┌──────────────────────── 用户机器 ────────────────────────┐
│  Mareo.app (Electron 主进程)                              │
│    ├─ 登录页 / 启动页 / 账号令牌（safeStorage 加密）        │
│    ├─ 打包进应用的 Node 24                                │
│    │    └─ DSH CLI（@deepseek-ai/dsh，钉版 0.2.1-rc.2）    │
│    │         ├─ DSH_HOME = <userData>/dsh/accounts/<账号>  │
│    │         ├─ --patch mareo-brand.patch.json（禁用+注入） │
│    │         └─ web UI on 127.0.0.1:<随机端口>             │
│    └─ 受保护的 BrowserWindow 显示该本地页面                │
│         └─ 品牌插件（brand/）：额度条、充值面板、推荐位      │
└───────────────────────────┬──────────────────────────────┘
                            │ 只带 Mareo 账号令牌
                            ▼
┌──────────────────────── 网关（阿里云杭州）────────────────┐
│  node + node:sqlite，容器仅监听 127.0.0.1:3000，nginx 前置   │
│    ├─ 账号 / 令牌（只存 SHA-256）/ 邮箱验证码              │
│    ├─ 额度：每日免费额度 + Wallet（账本）                  │
│    ├─ 计费：pricing.ts 是唯一算钱入口                      │
│    ├─ 支付：支付宝（fake 渠道用于联调）                    │
│    └─ 模型代理（两个上游）                                 │
│         ├─ /anthropic/* 或其它路径 → api.deepseek.com      │
│         └─ /openai/*            → api.openai.com/v1        │
└───────────────┬───────────────────────────┬───────────────┘
                │ 直连（境内）               │ 加密隧道
                ▼                            ▼
        api.deepseek.com            东京中继 tinyproxy → api.openai.com
```

## 数据流：一次模型请求

1. 用户在 DSH 里提问，DSH 带着**账号令牌**发请求（`DEEPSEEK_API_KEY` 环境变量注入的就是它）。
2. 网关鉴权 → 读当日额度/余额 → 转发上游（把账号令牌换成**厂商 key**）→ 流式回传。
3. 结束时从响应尾部解析 `usage` → `pricing.ts` 算 `actualMicro` → 乘倍率得 `billableMicro` → 与写 `usage` 行**同一事务**里扣免费额度、必要时扣 Wallet。
4. 拿不到 `usage` 的请求记为 `missing`，**不计费也不当成 0**。

## 四条不能碰的接缝

| 接缝 | 现状 | 为什么不能随便动 |
|---|---|---|
| `--patch` overlay | 6 条禁用 + 1 条注入（见 `src/dsh-runtime.ts`） | 禁用项是商业模式与安全的边界：DeepSeek 账号面、Models 设置页、以及会绕过计费的 `web-deepseek-api` |
| 模型目录 | 写在账号 `settings.yaml`（`src/model-catalog.ts`） | 展示名可以改，**model id 不能改**——计费、历史、已保存选择都挂在 id 上 |
| 会话日志 | DSH 追加写 `session.v4.jsonl.zstd`，读时 fail-closed | 内置 DSH 回退会让新会话打不开，见 [session-log-downgrade.md](session-log-downgrade.md) |
| 计费入口 | 仅 `server/src/pricing.ts` | 其它地方自算单价会导致对账失败 |

## 两个上游为什么形状不同

| 路由 | 协议 | 原因 |
|---|---|---|
| DeepSeek | Anthropic Messages（`/anthropic`） | DSH 的 DeepSeek 适配器说 Messages，客户端会把 base URL 拼成 `/v1/messages` |
| OpenAI | Responses API（`openai-responses`） | gpt-6 系列在 Chat Completions 上**开 reasoning 时不支持工具调用**，而 DSH 重度依赖工具 |

OpenAI 上游必须经过加密隧道：杭州到 `api.openai.com` 的明文 CONNECT 与 TLS SNI 都会被重置。细节与实测见 [gateway-deploy.md](gateway-deploy.md#境外出口openai-上游)。

## 进程与端口

| 东西 | 位置 |
|---|---|
| Electron 主进程 | 用户机器 |
| DSH 引擎 | 用户机器，`127.0.0.1:<随机端口>`，仅主进程可访问 |
| 网关容器 | 服务器 `127.0.0.1:3000`，nginx 在 443 终止 TLS |
| 运营页面 | 静态 HTML，`/var/www/mareo-site/stats/`，nginx Basic Auth 之后 |

## 目录职责

| 目录 | 职责 |
|---|---|
| `src/` | Electron 主进程：启动编排、登录、DSH 生命周期、更新检查、模型目录、品牌 patch |
| `brand/` | 注入 DSH 的客户端插件：额度条、充值面板、推荐位 |
| `runtime/` | DSH 与 Node 的**钉版**（`package.json`） |
| `server/` | 网关：路由、代理、计费、额度、账本、支付、报表 |
| `website/` | 官网（静态），由发布流程同步；见 [website.md](website.md) |
| `docs/` | 本目录 |
| `scripts/` | 构建、发布、部署、OSS 工具 |

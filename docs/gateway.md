# 网关

一句话：**用户只持有 Mareo 令牌，厂商 key 只在服务器上**。网关负责鉴权、额度、计费、支付，并把模型请求转发给上游。

部署与运维见 [gateway-deploy.md](gateway-deploy.md)；钱的口径以 [`money/standard.md`](money/standard.md) 为唯一权威。

## 路由一览

| 路由 | 鉴权 | 作用 |
|---|---|---|
| `GET /health` | 无 | 存活探针 |
| `GET /me` | 令牌 | 客户端启动时校验令牌 |
| `POST /events` | 可选 | 客户端诊断事件（未登录也要能上报失败） |
| `POST /site-view` | 无 | 官网浏览计数（只计数，不存每次访问） |
| `GET /quota` | 令牌 | 额度条数据（今日免费剩余、Wallet 余额） |
| `POST /reward/start`、`/reward/complete` | 令牌 | 奖励任务 |
| `POST /auth/email/send`、`/auth/email/verify` | 无 | 邮箱验证码登录 |
| `GET /payment/config`、`POST /payment/orders`、`GET /payment/orders[/:id]` | 令牌 | 充值 |
| `POST /payment/callback/:provider` | 验签 | 支付回调（**唯一入账依据**） |
| `GET /sponsored-ad`、`POST /sponsored-ad/events` | 令牌 | 推荐位与曝光/点击事件 |
| `POST /openai/v1/responses` | 令牌 | OpenAI 上游（经隧道） |
| **其它所有路径** | 令牌 | 转发到 DeepSeek 上游（见下方"已知边界"） |

## 模型代理

代理做四件事：把账号令牌换成厂商 key、按路径选上游、流式转发、从响应尾部解析 `usage`。

| 路径 | 上游 | 鉴权头 |
|---|---|---|
| `/openai/` 前缀 | `OPENAI_BASE_URL`（默认 `https://api.openai.com/v1`） | `Authorization: Bearer <OPENAI_API_KEY>` |
| 其它 | `UPSTREAM_BASE_URL`（默认 `https://api.deepseek.com`） | `Authorization: Bearer <DEEPSEEK_API_KEY>` |

- `/openai/` 会剥掉前缀，并**在转发前校验模型是否可售**（不可售返回 400 `unpriced-model`，不产生上游调用）。
- 环境变量没有 `OPENAI_API_KEY` 时，`/openai/` 返回 503，不会掉到另一个上游。
- 会话标识：Messages 路由读请求头 `x-deepseek-harness-session-id`；Responses 路由读请求体 `prompt_cache_key`。两者都会落到 `usage.sessionId`。

### 已知边界（待修，评审中）

**其它所有路径都被转发**，并带上我们的上游 key。这意味着普通用户令牌可以让网关代调上游的非模型接口（例如 DeepSeek 的 `/user/balance`、`/files`）。修法是把代理收敛到白名单路径与模型，**不要再把它当特性描述**。

## 计费

| 项 | 规则 |
|---|---|
| 唯一入口 | `server/src/pricing.ts` 的 `costOf` / `settleMicro`；别处不得自算单价 |
| 输入 | 上游返回的 `usage` token（缓存命中 / 未命中 / 输出 / reasoning） |
| 真实成本 | token × 单价（DeepSeek 按北京时间峰谷翻倍；OpenAI 按 USD 单价 × `PRICING_FX_RATE`，默认 7） |
| 长上下文 | OpenAI 模型输入 > **272,000** token 时**整单**按输入 2 倍、输出 1.5 倍 |
| 销售倍率 | `billable = ceil(actual × rate)`，默认 1.3，可按模型覆盖 |
| 缺 usage | 记 `usageSource='missing'`，**不计费、不当作 0** |

## 额度

| 桶 | 是否重置 | 来源 |
|---|---|---|
| 每日免费额度 | 北京日 0 点重置（默认 ¥10/天） | 配置 `quota.dailyFreeMicro` |
| Mareo Wallet | 不清零、不过期 | 只能由 `grantCredit` 入账 |

扣减顺序：先免费额度、后 Wallet，一笔可跨桶。两桶都空才拒绝（`429 credit-exhausted`）。**允许最后一笔透支**，所以边界不是悬崖。

> 已知问题：准入判断在等待上游**之前**读取余额，多个并发请求会各自看到同一份额度（评审中）。

## 数据表（schema 11）

| 表 | 作用 |
|---|---|
| `users` / `identities` / `tokens` | 账号、登录方式、令牌（只存 SHA-256） |
| `usage` | 每条模型请求一行：模型、上游、token 明细、真实成本、结算、毛利、是否来自免费额度、会话 |
| `wallet_ledger` | 追加型账本：充值/赠送/消耗；余额 = 最后一条的 `balanceAfterMicro` |
| `payment_orders` | 充值订单，状态机与幂等键 |
| `settings` | 运行期配置（`quota.*`、`billing.*` 等） |
| `events` / `site_views` | 客户端诊断事件、官网计数 |
| `session_titles` | 会话标题（可能含用户首条消息的少量文字） |
| `reward_tasks` / `ad_events` | 奖励任务、推荐位事件 |
| `auth_codes` / `auth_sends` | 邮箱验证码与发送记录 |

## 支付

- 只有**服务端验签通过的支付回调**或**服务端主动查单得到的已支付**才能把订单置为 `paid` 并调用 `grantCredit`；客户端显示的"支付成功"不产生任何账务影响。
- 金额 1:1 入账（1 分 = 10,000 微元）；订单状态机与账本唯一索引 `(source, externalRef)` 双层幂等。
- 支付宝走公钥模式：请求签名**包含** `sign_type`，回调验签**排除** `sign` 与 `sign_type`——这两条都踩过坑。
- 已知问题：每日充值上限只校验"已入账 + 单笔新单"，不校验同时在途的多笔（评审中）。

## 运营入口

```sh
cd /srv/mareo/server/deploy
docker compose exec -T gateway node dist/src/cost-report.js < /dev/null        # 成本报表
docker compose exec -T gateway node dist/src/credit-cli.js balance --account <id> < /dev/null
docker compose exec -T gateway node dist/src/config-cli.js list < /dev/null    # 列出可配置项
docker compose exec -T gateway node dist/src/payment-cli.js list --account <id> < /dev/null
```

本机的等价写法是 `npm --prefix server run cost`（**不是** `npm run cost`，根目录没有这个脚本）。

# 运营数据（看什么、怎么算、多久看一次）

面向"小范围运营"阶段的指标定义与节奏。数据来源只有三处：

| 来源 | 内容 | 在哪 |
|---|---|---|
| gateway 数据库 | `usage`（模型请求）、`events`（客户端事件）、`site_views`（官网浏览计数）、`users`/`identities` | ECS `/srv/mareo/server/deploy/data/mareo.db` |
| OSS 访问日志 | 真实下载完成（`GetObject` 200） | `npm run downloads:oss` |
| nginx 访问日志 | 下载点击（302）、API 拒绝（429）等 | ECS `/var/log/nginx/` |

> **样本小的时候不要看百分比。** 用户数是个位数时，百分比只是噪声；要逐个看新用户"下载 → 安装 → 登录 → 首次任务"是否走通，卡在哪一步。

## 运营页面（nginx 密码门之后）

两个页面，两个读者：

| 页面 | 读者 | 回答的问题 |
|---|---|---|
| <https://mareo.cn/stats/> | 负责人 | 今天多少人在用、增长卡在哪、钱回没回本、用户拿它做什么 |
| <https://mareo.cn/stats/users/> | 产品 | 留存有没有变好、用得多深、谁是用得最重的那些账号 |
| <https://mareo.cn/stats/health/> | 工程 | 系统是否正常：启动率、异常退出、模型成功率、延迟、版本分布 |

访问需要 Basic Auth（`auth_basic` + `/etc/nginx/.htpasswd-stats`，见 `server/deploy/mareo-site.conf` 的 `location ^~ /stats/`）。

页面的取向、配色与版式规范见 [`design/product-design-principles.md`](design/product-design-principles.md)
和 [`design/themes/ink-and-paper.md`](design/themes/ink-and-paper.md)；工程规则见
[`design/web-interface-guidelines.md`](design/web-interface-guidelines.md)。

四个页面都由 `server/deploy/stats-page.sh` 从数据库生成**静态 HTML**（每 15 分钟一次；`--page ceo|health` 分开生成）：

```sh
# ECS 上安装一次
crontab -e
*/15 * * * * cd /srv/mareo/server/deploy && ./stats-page.sh >> backups/stats.log 2>&1
```

设计取舍：

- **静态文件而非公开 API**：数据库永远不暴露在公网，页面也没有可注入的输入面；生成失败时旧页面继续可用（先写临时文件再 `mv`）。
- **只有聚合值**：没有任何账号、邮箱、昵称、账户 ID 或单条记录。版本号/平台是客户端上报的字符串，渲染时统一转义。
- 页面带 `noindex`，不会被搜索引擎收录；且**不含任何外部请求**（无字体、无脚本、无统计代码）。
- **注意**：页面不再公开，已加 nginx 密码门；撤掉门就回到"任何人可见"的状态。

### 首页指标的算法与已知缺口

| 指标 | 定义 | 数据来源 |
|---|---|---|
| DAU | 今天有模型调用的账号数 | `usage` |
| 新增激活 | 今天第一次调用成功的账号数 | `usage` 首次 200 |
| 回访 | DAU − 新增激活 | 同上 |
| D7 留存 | 七天前首次调用成功的账号里，今天有活动的比例（cohort < 5 时标注"样本过小"） | `usage` |
| 今日 Session | 今天不同的会话标识数；**只覆盖携带会话头的请求**，页面会标注覆盖率 | `usage.sessionId` |
| 增长（流量） | 官网访问次数、下载请求次数——**是次数不是人数**，只给占比 | `site_views`、nginx 日志 |
| 增长（账号） | 近 7 天新注册账号为分母：首次调用成功、首次充值 | `users`、`usage`、`wallet_ledger` |
| 真实模型成本 | 当天请求按官方单价算出的成本 | `usage.actualMicro` |
| 用户结算消耗 | 当天计入用户额度/钱包的金额（含倍率） | `usage.billableMicro` |
| 毛利（钱包口径） | 结算消耗 − 真实成本 | 同上 |
| 今日充值 | 当天已支付订单金额（**不是收入**，先成为 Wallet 余额） | `payment_orders` |
| 现金净额 | 今日充值 − 今日真实成本 | 同上 |
| Cost Recovery | 今日充值 ÷ 今日真实成本（倍率固定 1.3，用结算消耗算会恒为 130%，没有信息量） | 同上 |
| Wallet 未消耗余额 | 全站 Wallet 余额合计，负数表示已透支 | `wallet_ledger` |
| 用途分类 | 会话标题的关键词规则分类，按会话数统计，并标注标题覆盖率 | `session_titles` |

### 用户与留存页的口径

| 指标 | 定义 |
|---|---|
| DAU / WAU / MAU | 今天 / 近 7 天 / 近 30 天有模型调用的账号数 |
| 留存 cohort | 以「首次调用成功的那一天」分组；D1/D3/D7 = 第 n 天是否还有模型调用。**日期未到期时显示 —，不显示 0**；cohort < 5 标注"样本小" |
| 每用户每周活跃天数 | 本周有活动的账号，平均有几天有调用 |
| 每活跃用户每周 Session | 本周 Session 数 ÷ 本周活跃账号；Session 只统计带会话标识的请求，页面标注覆盖率 |
| 每 DAU Session | 今日 Session 数 ÷ DAU |
| 每 Session / 每用户每日真实成本 | 本周真实成本 ÷ Session 数 / ÷（各账号活跃天数之和） |
| 用户周成本 P50/P90/P99 | 本周每个账号真实成本的分位 |
| 重度用户 | 近 7 天请求数 ≥ 1000 的账号；按真实成本排序，展示活跃天数、Session、请求、成本、主线任务、Wallet 余额、是否付费、最近活跃 |

**已知缺口（页面已明确标注，不做假数）**：`install_confirmed` 只有部分客户端上报（首启漏斗不可靠）；客户端还没有"看到充值入口 / 点击充值"事件（充值漏斗前两步无法计算）；活跃时长目前只有进程存活时长。

## 时间口径

**所有"今日/近 7 天"都按北京时间自然日切分**（`server/src/clock.ts`）：

- "今日" = 北京时间当天 00:00 起；
- "近 7 天" = 今天 + 前 6 天（自然日，不是滚动的 7×24 小时）；
- 每日请求上限也按同一口径，**在北京时间 00:00 重置**（此前按 UTC 日，等于北京时间早上 8 点重置）；
- 容器内设置 `TZ=Asia/Shanghai`，与宿主机、日志时间一致。中国标准时间是固定 UTC+8、无夏令时，所以计算与容器时区无关。

## 成本核算（以 token 为准，不以字节为准）

### 四条硬规则

1. **金额只在与权威账单对账后才允许报出。** `npm run cost` 必须带 `--bill <北京日>=<元>`，报表会把"我们算的 / 你的账单 / 偏差"并列打印；偏差 >1% 时先查代码 bug，不向业务方给结论。
2. **只用权威数据源计价。** 计费只认上游返回的 usage token；`promptChars`/`completionChars` 是**字节数**，仅用于趋势与异常检测，**不允许进入任何金额计算**。
3. **先盘点已有数据，再提方案。** 说"我们不知道 X"之前，必须确认：上游有没有给、库里有没有存、客户端有没有。（2026-09 的教训：网关一直在收到 usage 却只数了字节，成本只能靠猜。）
4. **每个测量口径都要有可控实验或生产数据验证**，并在代码注释里写明出处。
5. **凡是保存用户内容的字段，交付前必须抽查"实际入库的值"**，而不是只看写入成功、接口 200、表已建。2026-09-15 的教训：标题识别用全文匹配，把一条回复正文当成"标题"存了进去——只有去读那条实际写入的记录才发现（表建好了、接口返回 200，看起来一切正常）。

### 为什么字节不能当钱用

流式响应是**一个 token 一帧**，每帧带约 315 字节的固定 JSON 外框（`id`/`object`/`created`/`model`/`choices`…）。生产实测：

```
输出：306–314 字节 / token     输入：约 3.74 字节 / token
```

也就是响应字节数会把输出 token **高估约 300 倍**。早期用字节估算成本得出的数字全部作废。

### 采集了什么（网关侧，2026-09-15 起）

`usage` 表按请求记录：`inputTokens`、`cacheHitTokens`、`cacheMissTokens`、`outputTokens`、`reasoningTokens`、`sessionId`（来自 `x-deepseek-harness-session-id` 头）、`usageSource`、`requestKind`。

- `usageSource='provider'`：usage 已采集（正常情况）；
- `usageSource='missing'`：200 但没拿到 usage（流被中断等）——**记为缺失而不是 0**，绝不能让它看起来免费；
- `usageSource IS NULL`：2026-09-15 之前的历史行，**无法计价**，报表会单独标注且不对账。
- `requestKind='search'`：客户端内置的联网搜索。它走 Anthropic 兼容端点（`/anthropic/v1/messages`），响应里的 `input_tokens` **不含**缓存计数——网关按 `input + cache_read + cache_creation` 还原总提示，否则每次搜索都会按未命中计价。搜索与对话同一本账、同一个每日额度，报表在每个北京日下用一行 `↳ 其中搜索 N 次 ¥X` 单列（一次搜索约 ¥0.007 低峰 / ¥0.013 高峰，量级与一次普通对话相当）。

### 单价与时段

官方人民币价（[来源](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)）：`deepseek-flash`（含旧名 `deepseek-v4-flash`）命中 ¥0.02 / 未命中 ¥1 / 输出 ¥4 每百万 token；**高峰时段（北京时间周一至周五 9–12、14–18 点）翻倍**，由 `ts` 自动判断。价目表在 `server/src/pricing.ts`，是唯一的算钱入口。

### 跑报表与对账

```sh
# 在服务器上跑（数据库在容器里）
ssh root@114.55.15.112 'cd /srv/mareo/server/deploy && docker compose exec -T gateway node dist/src/cost-report.js \
  --bill 2026-09-16=12.34'

# 本地跑（用数据库副本）
DB_PATH=/path/to/mareo.db npm run --prefix server cost -- --bill 2026-09-16=12.34
```

输出包含：每日请求数 / 已计价数 / 缺 usage / 历史行 / 输出与思考 token / 输入 token / 命中率 / 成本 / 账单 / 偏差；以及指定日期的**每用户成本**（人均、P50/P90/P99、Top 10）与**每 session 成本**。

> 对账还有一个更严格的用法：把**当日 token 总量**与控制台的 token 数对比。这能把"采集准确性"和"价格表正确性"分开验证。

## 会话标签（了解"用户在做什么"）

每个会话的**标题**就是它的标签，粒度是"一会话一次"，不随轮次增长。两个来源：

| 来源 | 说明 |
|---|---|
| 网关 | 引擎为生成标题会调用一次模型（提示词 `Generate the session title from this JSON array of human messages`），这个调用经过网关，因此标题是**顺带拿到**的——不额外花钱、不额外发请求 |
| 客户端 | 模型不可用时引擎会退回到"首条消息截断"作为标题，这种不产生模型调用，所以客户端会读本地会话记录（`storages/session_projcache/sessions/*.json` 的 `rows.title.val`）并**每会话上报一次**（已上报的记在 `<userData>/reported-session-titles.json`，标题变化会再报一次） |

只保存标题文本（≤120 字符），**不保存对话正文、文件路径、文件内容**。报表按规则把标题归入「编码/调试、写作/文档、表格/数据、演示/PPT、调研/检索、文件整理、其它」，规则在 `server/src/session-labels.ts`（透明、免费，将来可换模型分类）。

`npm run cost` 的每 session 区块会列出：任务类型分布 + 每个会话的标题、请求数、成本。

## 指标定义

### 获客漏斗

| 指标 | 算法 | 说明 |
|---|---|---|
| 官网浏览 | `site_views` 按天求和 | 只有执行 JS 的真实浏览器会计入（爬虫不执行 JS），这是它比 nginx 日志可信的原因 |
| 下载请求 | nginx 中 `GET /downloads/*` 的条数 | 302 到 OSS 的点击；**不等于下载完成** |
| 真实下载完成 | OSS 访问日志里 `GetObject` 且对象是安装包、状态 200 | `npm run downloads:oss`；日志按小时投递，最近一小时还没有 |
| 累计安装 | `events` 中 `install_confirmed` 去重账户数 | **口径**：装好后成功启动**并登录**过；装好但登不进去的人看不见（已知盲点） |
| 注册账号 | `users` 行数 | |
| 用上模型 | `usage` 中不同 `userId` 数 | |
| 首次任务成功 | 每个 `userId` 的首个 `status=200` 存在即计入 | 代理指标，不等于"用户满意" |

转化率要看的是：下载/浏览、安装/下载、登录/安装、首次任务/安装。

### 留存与参与

| 指标 | 算法 |
|---|---|
| 日活 / 周活 | `events.launch` 按天/周去重账户（比 `usage` 更早发现"打开了但没提问"） |
| 留存 | 每账户首次出现日期做同期群，看第 2 天、第 7 天是否再次出现 |
| 人均请求 | `usage` 按账户聚合 |

### 稳定性

| 指标 | 算法 | 关注阈值（建议） |
|---|---|---|
| 启动成功率 | `launch.detail.ok=true` ÷ launch 总数 | < 95% 立刻查 |
| 引擎异常退出率 | `harness_exit` ÷ launch 成功数 × 1000 | > 20 次/千次启动要查 |
| 模型调用成功率 | `usage.status=200` 占比 | < 98% 查上游或网关 |
| 延迟 | `usage.latencyMs` 的 p50 / p95 | p95 明显恶化要查 |
| **额度用尽（429）** | `usage.status=429`（网关会记录被拒请求） | 出现即关注（见下方"两道线"） |
| 用量异常账户 | 今日请求数 ≥ `DAILY_WARN_LIMIT`（默认 500）的账户 | 只告警、不拦截；页面上单列一行 |
| 登录结果 | `events.signin.detail.result` 分布 | 出现 `wrong-code`/`unreachable` 集中要查 |

### 用量与成本

| 指标 | 算法 | 说明 |
|---|---|---|
| 字符消耗 | `usage.promptChars + completionChars` 按天 | 成本的代理指标 |
| 单账户用量 / Top 账户占比 | `usage` 按账户聚合 | 成本集中度、异常用量排查 |
| 精确 token 与费用 | `usage` 的 token 列（含缓存命中/未命中/思考），按官方价目表换算 | ✅ 2026-09-15 上线，见上文「成本核算」；`npm run cost` 直接出结果 |

### 版本与更新

| 指标 | 算法 |
|---|---|
| 版本/平台分布 | `events.launch` 按 `version`/`platform` 分组 |
| 更新落地 | 旧版本占比是否随时间下降；配合 nginx 中 `/updates/latest.json` 的请求量 |
| 更新提示曝光/点击 | ❌ 尚未采集（已列入待补埋点） |

## 两道线：护栏与告警

限额是**防失控的护栏，不是产品配额**；产品配额是下面的额度线。三个数各管一段：

| | 变量 | 生产现状 | 行为 |
|---|---|---|---|
| 请求数上限 | `DAILY_LIMIT` | **0（已关闭）** | 代码默认 2000。>0 时超过即拒绝（记一条 `usage.status=429`）并返回中文说明。**2026-09-21 起设为 0**：成本已由额度线按钱管住，这条护栏反而会挡住合法的重度使用者——当时 `lch` 一天 2000+ 次请求、只花 ¥11，却因为撞到请求数被拒了 385 次 |
| 告警线 | `DAILY_WARN_LIMIT` | 500 | **只**在网关日志打一条 `[usage] <accountId> reached N requests today`，并在运营页"用量异常"一行列出该账户。不拦截任何请求 |
| 产品配额 | `quota.*`（见下节） | `enforce`，¥10/天 + Wallet | 按**结算成本**扣（先免费额度、后 Wallet），两桶都空才拒绝（`error=credit-exhausted`） |

改 `.env` 里的值后**必须 `docker compose up -d`**：`docker compose restart` 不会重读 `.env`，改了等于没改（重建容器会断掉当时进行中的流式响应，挑低峰做）。

> 关掉请求数上限后成本依然有上限——额度线按钱扣，"每天最多花多少"由额度决定，而不是由请求数间接决定。将来若重新启用这条护栏（例如额度线临时关掉时），注意它的拒绝文案里原本写着"如需提高额度请联系我们"，有了额度机制后那句话会误导。

> 现实提醒：客户端每轮请求体会携带 1–3MB 上下文（`usage.promptChars` 实测中位数约 130 万字符），所以"不限量"并不是零成本。每次请求的真实花费按 token 计（见上文成本核算），额度线就是据此设的。

## 每日免费额度与 Mareo Wallet

额度是**产品线**（用完了今天就不能再用），与上面的护栏是两件事，两条都保留。v9 起额度分成**两个桶**：每日免费额度（会重置）与 Mareo Wallet（不清零、不过期）。完整口径见 [`money/standard.md`](money/standard.md)——本节只讲怎么操作。

**口径（定了就别改，改之前先想清楚）**

- 两个桶都按**结算成本**扣（真实成本 × 该模型销售倍率，向上取整到微元），单位是元（内部用微元，1 元 = 1000000）。不是按请求次数：一次长上下文请求和一次问候成本差几十倍。
- **先扣每日免费额度，后扣 Wallet**，一笔请求可以跨桶（免费部分付不完的由 Wallet 付）。
- **每日免费额度北京时间 0 点重置**；Wallet 不重置、不过期，唯一来源是账本（`grantCredit`），**充值 ≠ 收入**。
- **允许最后一次透支**：只要两桶还有一分钱就放行，这一笔可以把 Wallet 扣成负数；之后再请求才拒绝。所以边界不是悬崖。
- 计入额度的是**一切产生成本的模型调用**（含会话标题那种系统自带调用，以及联网搜索）。上游没返回 usage 的请求不计（成本未知，不能按 0 计，也不该因此拦人）。
- 用户只看到人民币金额；token 数、上游单价、销售倍率、毛利都不出现在客户端。

**三种模式**

| `quota.mode` | 谁看到额度条 | 谁会被拦 | 用途 |
|---|---|---|---|
| `off`（默认） | 没人 | 没人 | 网关行为与上线前一致（但仍如实记账） |
| `shadow` | 只有 `quota.rewardAccounts` 里的账号 | 没人 | 观察期：只让内部账号看到额度条 |
| `enforce` | 所有人 | 两桶都空的人 | 正式生效；任务入口仍只对白名单开放 |

**服务端可配置（改完免重启）**

```sh
cd /srv/mareo/server/deploy
docker compose exec -T gateway node dist/src/config-cli.js < /dev/null            # 列出全部键与当前值
docker compose exec -T gateway node dist/src/config-cli.js set quota.mode shadow < /dev/null
docker compose exec -T gateway node dist/src/config-cli.js set quota.dailyFreeMicro 10000000 < /dev/null
docker compose exec -T gateway node dist/src/config-cli.js set quota.rewardAccounts <账号id> < /dev/null
docker compose exec -T gateway node dist/src/config-cli.js set billing.settlementRate 1.3 < /dev/null
docker compose exec -T gateway node dist/src/config-cli.js set billing.modelRates deepseek-v4-pro:1.5 < /dev/null
```

键：`quota.mode`、`quota.dailyFreeMicro`、`quota.rewardAmountMicro`、`quota.dailyRewardCapMicro`、`quota.rewardMinSeconds`、`quota.rewardDailyLimit`、`quota.rewardAccounts`、`quota.rewardProvider`、`billing.settlementRate`（默认销售倍率，当前 `1.3`）、`billing.modelRates`（按模型覆盖倍率，格式 `模型名:倍率`，逗号分隔，键必须在价目表里，写错会被拒绝）。金额一律微元（¥10 = `10000000`）。配置存在 `settings` 表里，下一个请求立即生效。**值写错会回落到默认值**（不会变成 0 把所有账号锁死）。

**给账号加钱（唯一的入账入口）**

```sh
docker compose exec -T gateway node dist/src/credit-cli.js --account 1305d9ac --amount-yuan 100 --source manual --ref TICKET-123 < /dev/null
docker compose exec -T gateway node dist/src/credit-cli.js balance --account 1305d9ac < /dev/null
docker compose exec -T gateway node dist/src/credit-cli.js list --account 1305d9ac --limit 20 < /dev/null
```

`--source` 取 `purchase / invite / reward_ad / promotion / affiliate / manual`；带 `--ref` 时同一来源同一引用只会入账一次（幂等），充值务必带订单号（`--ref`）与渠道（`--channel`）。账号可以用 id 前缀或昵称。**不提供改余额的命令**：余额永远等于账本最后一条，冲正就再写一笔 `manual` 入账（或按需新增负向来源）。

> v9 起 `quota.accountAllowances`（按账号覆盖每日额度）已删除：给特殊账号放宽额度**改为给它入账 Wallet**，这样既不用改全站默认值，也不会每天被重置。

> 容器内一律直接调 `node dist/src/<脚本>.js`（`config-cli`、`credit-cli`、`cost-report`、`metrics`）：镜像只装了构建产物，`npm prune --omit=dev` 已经删掉 `tsc`，所以 `npm run config` / `cost` / `metrics` 这些会先 `npm run build` 的脚本在容器里**必然失败**——它们是给本地开发用的。
>
> 注意：容器里跑命令一定要带 `< /dev/null`，否则 `docker compose exec` 会吃掉脚本自己的 stdin。

**充值（微信支付 / 支付宝）**

用户用真钱给 Wallet 充值。口径见 `money/standard.md` 第 8 节，设计与实现见 `money/designs/2026-10-13-recharge.md`。

开关与密钥都在 `.env`（改完要 `docker compose up -d`）：

| 变量 | 说明 |
|---|---|
| `PAYMENT_MODE` | `off`（默认，用户看不到入口）/ `fake`（模拟通道，只给内部测试）/ `live`（真实收钱） |
| `PAYMENT_PUBLIC_BASE_URL` | 回调前缀，必须公网 HTTPS；回调地址是 `<它>/payment/notify/alipay` |
| `ALIPAY_APP_ID` | 开放平台应用 ID |
| `ALIPAY_PRIVATE_KEY_PATH` / `ALIPAY_PUBLIC_KEY_PATH` | 应用私钥与支付宝公钥（也可以直接写内容，路径方式更稳）。私钥权限 600 |
| `ALIPAY_GATEWAY` | 留空即生产网关；沙箱联调时指向沙箱地址 |

> `PAYMENT_MODE=live` 但缺任一配置时，该渠道会被当成"不可用"：客户端拿到的 `enabled=false`，入口不显示。所以**配置没写好不会出现一个点了没反应的按钮**。

日常操作（容器内，注意 `< /dev/null`）：

```sh
docker compose exec -T gateway node dist/src/payment-cli.js list --status pending < /dev/null
docker compose exec -T gateway node dist/src/payment-cli.js list --account <账号id或昵称> < /dev/null
docker compose exec -T gateway node dist/src/payment-cli.js show <订单号> < /dev/null
docker compose exec -T gateway node dist/src/payment-cli.js cancel <订单号> < /dev/null
```

**客服流程：用户说"我付了但没到账"**

1. `payment-cli list --account <账号>` 找到订单号（或让用户提供订单号，客户端充值记录里有）。
2. `show <订单号>`：若 `status=paid`，钱已到账，问题在别处；若仍 `pending`，去支付宝商户后台按**商户订单号**查这笔是否已收款。
3. 平台已收款而订单仍 `pending`（回调丢了）：`payment-cli pay <订单号> --transaction <支付宝流水号> --amount-fen <分>`。这条走的是**和回调完全相同**的入账路径，重复执行不会重复加钱。
4. 平台确认未收款：让用户重新扫码下单即可（旧单会自己过期）。

**必须守住的两条**：金额一律由服务端按档位决定（客户端传金额无效）；只有验签通过的回调、或主动查单、或人工补单能让订单变成 `paid`，三者都经过 `confirmPayment`，幂等与一致性只在那里实现。

**影子观察怎么读**

成本报表的「额度影响」区块直接给出结论，不需要额外埋点——它用当天真实的**结算成本**重算"如果当时就限量会怎样"，与真实拦截同一口径：

```
阈值        会被挡账号   会被挡请求   占总请求   超出阈值的成本
¥3.00         6/24            1234      45.2%          ¥28.10
¥5.00 …
¥10.00 …                                                  ← 当前配置
```

看三件事：**会被挡的账号数**（决定会不会得罪人）、**会被挡的请求占比**（决定拦住多少使用）、**超出阈值的成本**（决定省了多少钱）。跑几天再定免费额度。

报表还会打「钱包与毛利」分节（充值/奖励/已消耗/余额/真实成本/结算成本/毛利/免费额度真实成本），以及按模型的毛利拆分——**充值不是收入，毛利只按已消耗口径算**，详见 `money/standard.md` 第 7 节。

**任务（奖励）机制：有接口，暂时没有界面**

服务端已经能通过"完成任务"给账号的 **Wallet** 入账（`grantCredit(..., source='reward_ad')`，同一任务幂等），provider 抽象把"广告"和"额度"解耦了；假 provider `fake-ad` 只校验"任务开始后过了足够时间"，用来跑通链路。**界面上目前完全不出现**——两桶都用完时客户端只提示"额度已用完 · 获取更多额度"，不做引导。接真实供给（激励视频 / 电商佣金 / 问卷）时只换 provider 实现，账本与额度逻辑不动。

没有界面时怎么验证（在服务器上，替换 `<token>`）：

```sh
docker compose exec -T gateway sh -c '
  curl -s -H "authorization: Bearer <token>" http://127.0.0.1:3000/quota
  curl -s -X POST -H "authorization: Bearer <token>" http://127.0.0.1:3000/reward/start
' < /dev/null
# 用返回的 taskId 提交完成（minSeconds 未到会被拒，这正是要验证的）
```

演练时的收尾（做完必做）：`quota.dailyFreeMicro` 调回真实值 → `quota.rewardAccounts` 清空 → `quota.mode` 回到 `shadow` 或 `off`。

**上线顺序**：`off` → `shadow`（观察真实分布，决定额度数值）→ 白名单内 `enforce` 验证 → 全量 `enforce`。v9（钱包与结算）上线时先跑迁移、再看影子期的对账（每人每日 `SUM(billableMicro)` 与真实成本、余额 = 入账 − 消耗、结算 − 真实 = 毛利），内部账号 `enforce` 无误后再全量。

> 删除账号时要一并删除 `wallet_ledger`、`reward_tasks`（和广告的 `ad_events`）——这三张表都以 `users(id)` 为外键，漏删会删不掉账号本身。（`reward_grants` 已在 v9 删除，账本取而代之。）

> 已知取舍：每次模型请求都会当天重算一遍该账号已花费的成本（几毫秒，几千行以内）。这样"已花多少"永远等于 `usage` 的结算列，不需要额外维护一个可能算错的计数器。Wallet 余额同理，永远是账本最后一条。真实用量涨到明显影响延迟时再考虑加缓存。

## 节奏

- **每天**：在容器里跑 `node dist/src/metrics.js`（完整形式见 [`metrics.md`](metrics.md)）看五个数——今日活跃、模型成功率与 429、**今日新增账户/安装**、下载次数、字符消耗。
- **每周**：漏斗转化、同期群留存、成本 Top 账户、版本分布；并逐个新用户核对启动/登录/首次任务。
- **每月**：成本与定价、Windows 签名决策、是否推进 Phase 2 自动更新。

## 待补埋点（优先级）

| 优先级 | 补什么 | 为什么 |
|---|---|---|
| ✅ 已完成 | token 入库（含缓存命中/未命中/思考）| 2026-09-15 上线，精确算钱 |
| P1 | 更新提示曝光 + 点击下载 | 判断更新提示是否有效 |
| P1 | `install_confirmed` 改匿名上报 | 修掉"装好但登不进去看不见"的盲点 |
| P2 | 客户端一键导出诊断日志 | 日志都在用户本地，排障拿不到 |

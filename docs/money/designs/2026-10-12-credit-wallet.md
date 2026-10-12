# Credit Wallet（统一余额系统）

| | |
|---|---|
| 日期 | 2026-10-12 |
| 状态 | **已确认，待实现**（口径已与负责人逐条确认；实现须以本文为基线） |
| 关联口径 | [`../standard.md`](../standard.md)（金额单位、销售倍率、扣减顺序、来源枚举、报表定义） |
| 影响范围 | 网关计费与额度（schema v8 → v9）、运营 CLI、客户端额度展示、成本报表、线上配置 |
| 是否用户可见 | 是（客户端额度展示需要发版） |

> 本文先于代码存在。实现过程中若必须偏离本文，先改本文并在「变更记录」留痕，再改代码。

## 1. 目标与范围

**目标**：把现有的"每日 ¥ 额度 + 任务入账"改造成**两个桶 + 一本账**——每日免费额度（重置）与 Mareo Wallet（不清零、不过期）并存；所有模型调用按 `真实成本 × 1.3` 结算；所有赠予/充值统一走 `grantCredit` 并留下可追溯账本；后台能分别统计充值、奖励、消耗、余额、真实成本、结算成本、毛利。

**本次不做**：支付下单/支付回调/发票、邀请系统本身、真实广告平台接入、退款与冲正流程。这些将来只作为 `grantCredit` 的调用方接入，不改变本文的数据结构。

## 2. 口径

口径全部收敛在 [`../standard.md`](../standard.md)，本文不重复定义。实现时只需注意三个可测边界：

| 场景 | 免费剩余 | Wallet | 本次 billable | 期望结果 |
|---|---|---|---|---|
| 跨桶 | ¥0.003 | ¥23.50 | ¥0.05 | 免费付 3000 微元，Wallet 付 47000 微元 |
| 允许透支 | ¥0 | ¥0.01 | ¥0.05 | Wallet 付 50000，`balanceAfter = −40000`；**下一笔被拒** |
| 向上取整 | — | — | actual = 1 微元 | billable = `ceil(1.3)` = **2 微元** |

## 3. 数据模型（schema v8 → v9）

**新增表 `wallet_ledger`**（字段语义见 standard 第 6 节）

```sql
CREATE TABLE wallet_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,               -- credit | debit
  amountMicro INTEGER NOT NULL,     -- 恒为正
  source TEXT NOT NULL,             -- purchase|invite|reward_ad|promotion|affiliate|manual|model_usage
  balanceAfterMicro INTEGER NOT NULL,
  relatedRequestId INTEGER,         -- 消耗时 = usage.id
  externalRef TEXT,                 -- 幂等键
  channel TEXT,                     -- 支付渠道
  createdAt TEXT NOT NULL
);
CREATE INDEX wallet_ledger_user ON wallet_ledger(userId, id);
CREATE UNIQUE INDEX wallet_ledger_ref ON wallet_ledger(source, externalRef) WHERE externalRef IS NOT NULL;
```

**`usage` 新增四列**：`actualMicro`、`billableMicro`、`marginMicro`、`paidFromFreeMicro`。
- Wallet 支付部分 = `billableMicro − paidFromFreeMicro`（不额外存列）。
- 历史行为 NULL，表示"早于计费上线"，沿用现有 `usageSource IS NULL` 的处理方式；**不回溯造账**。

**删除的旧结构**（避免双轨）：
- 设置项 `quota.accountAllowances` 与 `parseAccountAllowances`（线上面值 `1305d9ac=¥100`、`f9086e44=¥200` 一并取消，两者回到 ¥10/天；以后要给某人更多额度用 `grantCredit`）。
- `reward_grants` 表：不迁移历史（那些是"当天额度"而非余额，且线上奖励白名单为空、界面未上线，无用户受影响），建账本后删表。
- `quota.ts` 的 `grantedMicroToday`（奖励不再折进每日桶）。

## 4. 关键流程

**调用前（仅 `enforce`）**：`freeRemaining = max(0, dailyFree − 今日 paidFromFree 之和)`；`wallet = 账本最后一条的 balanceAfterMicro`。两者都 ≤ 0 → 429，错误码 `credit-exhausted`，文案「**Mareo 余额不足，获取更多额度后即可继续。**」。旧码 `daily-limit-reached` 保留给 `DAILY_LIMIT` 那条基础设施保险丝。

**调用后（所有模式）**，单事务内：

```
rate       = billing.modelRates[该模型] ?? billing.settlementRate
actual     = pricing 计算 → 微元
billable   = ceil(actual × rate)
margin     = billable − actual
freePart   = min(freeRemaining, billable)
walletPart = billable − freePart
→ 写 usage（含四列）并取回 usage.id
→ walletPart > 0 时追加账本 debit（source=model_usage, relatedRequestId=usage.id）
```

**入账**：`grantCredit(db, { userId, amountMicro, source, externalRef?, channel? })` —— 校验来源与金额、`externalRef` 幂等、单事务读余额→写 credit。调用方：运营 CLI（`promotion/manual`）、广告任务完成（`reward_ad`）、后续邀请与充值。

**免费额度重置**：不写任何数据，跨北京日 0 点后"今日 paidFromFree 之和"自然归零。

## 5. 接口与配置

- **`/quota` 响应**：现有字段（`limitMicro/spentMicro/remainingMicro/usedPercent/exhausted/resetAt/visible`）语义**保持不变**（= 免费桶），老客户端（≤0.1.9）继续可用；新增：
  ```json
  "free":   { "limitMicro": 10000000, "usedMicro": 3200000, "remainingMicro": 6800000, "resetAt": "…" },
  "wallet": { "balanceMicro": 23500000 },
  "total":  { "remainingMicro": 30300000 }
  ```
- **运营 CLI**（容器内执行，不新增公网入口）：
  `node dist/src/credit-cli.js grant --account <id|昵称> --amount-yuan 10 --source promotion --ref <单号> --channel wechat`
  另有 `balance`（查余额）、`list`（最近账本）。
- **设置项**：新增 `billing.settlementRate`（默认倍率，`1.3`）与 `billing.modelRates`（按模型的覆盖表，格式 `模型名:倍率`，逗号分隔，当前为空）；`quota.dailyFreeMicro` 保持 `10000000`；reward 系列设置保留（任务机制不变，只是入账改成写钱包）。
  - 倍率解析顺序：`billing.modelRates` 命中该模型 → 否则用 `billing.settlementRate`。
  - 覆盖表的键必须存在于 `pricing.ts` 的价目表（`knownModels()`），**拼错即拒绝**，避免静默回落。
  - 同名不同价的别名（如 `deepseek-flash` 与 `deepseek-v4-flash`）按各自键分别配置；实现时先核对 `pricing.ts` 是否有别名归一化入口，若有则统一走它。
  - 逐笔落库的 `actualMicro / billableMicro` 让"事后反推当时倍率"成为可能，因此**不需要额外存倍率列**。

## 6. 客户端

`brand/client.cjs` 的额度条从"一条百分比"改为三层信息，免费与 Wallet 视觉区分：

```
今日免费   ¥6.80 / ¥10.00      ← 细进度条（弱化）
Mareo 余额 ¥23.50              ← 独立一行，样式不同
```

- 展示"整体可用"（免费剩余 + 余额）总数。
- 两桶皆空：`额度已用完 · 获取更多额度`（**只提示，不做购买入口**）。
- 用户界面不出现 token、单价、倍率。
- `assets/account-bridge-preload.js` 无需新增方法（payload 直通），只改渲染。**需要一次客户端发版。**

## 7. 报表

新增「钱包与毛利」分节，输出 standard 第 7 节定义的八个数字，并固定打印三句口径说明（充值≠收入 / 毛利按已消耗 / 免费消耗是获客成本）。因为 `marginMicro` 逐笔落库，**毛利可按模型拆分**（倍率按模型可配之后，这一点是必要的：某天毛利变了要能看出是哪个模型、哪次调价造成的）。现有「真实成本 vs 供应商账单」对账保持不变。

## 8. 落地顺序与灰度

1. 数据层：v9 迁移（建表、加列、删 `reward_grants`、清 allowance 设置）。
2. 结算与闸门：`pricing` 增加结算函数；`quota.ts` 改两桶；`server.ts` 接入前后钩子；`credit-cli`。
3. 报表分节。
4. 测试（见第 9 节）。
5. 上线：`quota.mode=shadow`（全量记录、不拦任何人）→ 核对账本与 `usage` 自洽、与旧口径日花费对比 → 内部账号 `enforce` → 全量 `enforce`。
6. 客户端发版。

> 因为上线时**所有人的 Wallet 都是 0**，老客户端显示的"已用完"与新逻辑一致，所以先实行后发版不会误导用户。

## 9. 验证

- **单测**：账本链（余额=最后一条）、幂等、向上取整、跨桶拆分、透支与"下一笔被拒"、来源校验、北京日边界、报表八个数与免费成本归属。
- **集成**：起真实网关 + 临时账号，走"免费花完 → Wallet 入账 → 花完 → 429"全链路，核对 `usage` 四列与账本一一对应；临时账号按现行纪律清理。
- **影子期**：真实流量下核对（a）每人每日 `SUM(billableMicro)` 与旧实现重算值一致；（b）余额 = 入账 − 消耗；（c）结算 − 真实 = 毛利。
- **上线后**：抽一个活跃账号用 CLI 对账。

## 10. 风险与取舍

1. **并发小幅透支**：闸门只判断"还有没有额度"，同用户并发可能同时通过，由"允许最后一笔透支"兜住，账本如实记负。
2. **账本从上线日开始**，不回溯。
3. **1.3 的隐含缺口**：毛利占收入 23.08%；扣支付通道费（约 0.6%）后约 22.5%；若拿不到 DeepSeek 增值税专用发票（进项不可抵）再扣 6%，净贡献约 16.5%。**建议向财务确认进项抵扣**，这决定 1.3 是否够。
4. **新老客户端并存**：老客户端看不到 Wallet，在免费额度用完而 Wallet 仍有余额时会显示"已用完"（服务端继续服务）——显示不一致但不阻断，新版本发布后消失。
5. **同价别名可能被配成不同倍率**：`deepseek-flash` 与 `deepseek-v4-flash` 是同一底层模型的旧新名，若只给其中一个配了覆盖倍率，就会出现"同一个模型两种价"。缓解：键必须通过价目表校验；报表按模型拆毛利；上线后核对一次别名是否成对配置。

## 11. 开工前先核对的代码点

`server.ts` 的 `quotaPayload` 形状与 429 分支、`recordUsage` 签名与返回、`rewards.ts` 的 `creditReward`、`pricing.ts`（价目表键集合 `knownModels()` 与是否存在别名归一化入口）、`clock.ts` 的日期边界、`brand/client.cjs` 现有额度条结构、`account-bridge-preload.js` 是否直通 payload。若与本文假设不符，先回到本文修订再实现。

## 12. 变更记录

| 日期 | 改动 | 原因 |
|---|---|---|
| 2026-10-12 | 初版：确立两桶 + 一本账、销售倍率 1.3、允许最后一笔透支、向上取整、`title`/`search` 计入、取消按账号额度覆盖、奖励账本合并、充值带订单号与渠道 | 负责人逐条确认后的基线 |
| 2026-10-12 | 销售倍率改为**按模型可配**（默认 `billing.settlementRate=1.3` + `billing.modelRates` 覆盖，当前全为 1.3），报表毛利支持按模型拆分 | 负责人补充：后续可能针对某个模型单独调整倍率 |

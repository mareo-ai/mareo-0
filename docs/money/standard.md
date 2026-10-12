# Mareo 金额口径规范

> 这是 Mareo 一切与钱有关的口径的**唯一权威来源**。代码、报表、文案、后台配置与本文冲突时以本文为准。
> 要改口径：先改这里 → 在文末「变更记录」留痕 → 再改依赖它的代码。**不允许悄悄改已上线的口径。**

## 1. 单位

| 场景 | 单位 |
|---|---|
| 面向用户（界面、提示、账单） | 人民币**元**，显示两位小数 |
| 存储与计算 | **微元**（1 元 = 1_000_000 微元），整数运算 |
| 换算 | 只允许出现在边界（渲染文案、读运营报表）；**禁止用浮点累加金额** |

## 2. 真实成本 actual_model_cost

- 定义：我们向 DeepSeek 支付的成本，按**上游返回的 usage token** 计算（不按字节、不按次数）。
- 唯一实现：`server/src/pricing.ts`（含高峰时段翻倍、缓存命中/未命中/输出三档单价）。**任何其它地方不得自算单价。**
- 只有 `status = 200` 且拿到 provider usage 的调用才产生真实成本；失败/中断的请求不计价（缺 usage 的行如实记为缺失）。

## 3. 销售结算 billable_cost

- `billable_cost = ceil(actual_model_cost × 销售倍率)`，**按微元向上取整**。
- **销售倍率 = 1.3**，配置项 `billing.settlementRate`，服务端可调。
- `margin = billable − actual`。
- 用户侧**不得出现** token 数、上游单价、销售倍率、毛利。用户只看到人民币金额。

## 4. 两个桶与扣减顺序

| 桶 | 是否重置 | 是否进账本 | 来源 |
|---|---|---|---|
| 每日免费额度 | 北京日 0 点重置 | 否 | 配置 `quota.dailyFreeMicro`（当前 ¥10/天） |
| Mareo Wallet | 不清零、不过期 | 是 | 唯一来源是账本（`grantCredit`） |

- 扣减顺序：**先每日免费额度，后 Wallet**。一笔请求可以跨桶（免费部分付不完的由 Wallet 付）。
- 闸门：**免费剩余 > 0 或 Wallet 余额 > 0** 即放行；两者都耗尽才拒绝。
- **允许最后一笔透支**：放行的那一笔可能把 Wallet 扣成负数；余额 ≤ 0 且免费已用完时拒绝新的调用。
- 计费范围：`chat`、`title`、`search` 三类调用**全部计入**用户结算。

## 5. 入账 grantCredit

- 唯一入口：`grantCredit(userId, amountMicro, source, { externalRef, channel })`。
- 来源枚举（封闭集合，新增须改本节并留痕）：

| source | 含义 | externalRef | channel |
|---|---|---|---|
| `purchase` | 用户充值 | 订单号 | 支付渠道 |
| `invite` | 邀请奖励 | 邀请记录 id | — |
| `reward_ad` | 看广告奖励 | 任务 id | — |
| `promotion` | 运营赠送 | 运营单号 | — |
| `affiliate` | 联盟/渠道分成 | 渠道单号 | — |
| `manual` | 人工调整 | 可选 | — |

- 入账**必须幂等**：`(source, externalRef)` 唯一，重复调用返回已有条目、不重复加钱。
- **充值金额是负债（用户未来可消费的余额），不是收入。**

## 6. 账本 wallet_ledger

追加型，只写不改。字段语义：

| 列 | 语义 |
|---|---|
| `userId` | 账号 |
| `type` | `credit`（入账）/ `debit`（消耗） |
| `amountMicro` | 恒为正，方向由 `type` 决定 |
| `source` | 入账用第 5 节的枚举；消耗固定为 `model_usage` |
| `balanceAfterMicro` | 写这条之后的余额，**可为负**（透支） |
| `relatedRequestId` | 消耗时 = `usage.id`，用于逐笔追溯 |
| `externalRef` / `channel` | 幂等键与渠道（见第 5 节） |
| `createdAt` | ISO 时间 |

- **余额 = 该用户最后一条的 `balanceAfterMicro`**；不维护可变计数器。
- 读+写必须在同一事务内完成（单进程单写者，天然串行）。

## 7. 报表定义（唯一口径）

| 数字 | 定义 |
|---|---|
| 充值金额 | `SUM(amountMicro) WHERE source='purchase'`（附笔数） |
| 奖励额度 | 按 `invite / reward_ad / promotion / affiliate / manual` 细分 |
| 已消耗额度 | `SUM(amountMicro) WHERE source='model_usage'`，即**用户结算成本** |
| Wallet 余额 | 全站 `balanceAfterMicro` 之和（= 负债） |
| 真实模型成本 | `SUM(usage.actualMicro)` |
| 结算成本 | `SUM(usage.billableMicro)` |
| 毛利 | 结算成本 − 真实模型成本 |
| 免费额度真实成本 | `SUM(actual × paidFromFree / billable)`，单列为**获客成本**，不计入 COGS |

报表固定打印三句口径说明：

1. **充值 ≠ 收入**：充值是可消费余额（负债），只有被消耗才形成收入。
2. **毛利只按已消耗口径计算**，不按充值口径。
3. **免费额度消耗不产生收入，但产生成本**（获客成本）。

- 与上游账单对账只用于校验**真实模型成本**；结算侧没有外部账单，以内部账本为准。

## 8. 变更记录

| 日期 | 改动 | 原因 / 关联文档 |
|---|---|---|
| 2026-10-12 | 建立本规范；销售倍率定为 **1.3**；免费额度维持 **¥10/天**；取消按账号的每日额度覆盖；入账统一走 `grantCredit`；消耗与入账合并进一本账 | Credit Wallet 上线，见 [`designs/2026-10-12-credit-wallet.md`](designs/2026-10-12-credit-wallet.md) |

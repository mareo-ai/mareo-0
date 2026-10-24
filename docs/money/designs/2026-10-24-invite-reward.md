# 邀请奖励：送 ¥5，每人最多 3 次

| 项 | 值 |
|---|---|
| 日期 | 2026-10-24 |
| 状态 | **shipped**（2026-10-24 实现，网关测试 155/155；客户端入口待发版） |
| 依赖 | [`standard.md`](../standard.md) 第 5 节（入账来源 `invite` 已在枚举内） |
| 影响 | 新表 `invites`、`users.inviteCode`、注册接口、模型请求成功后的钩子、客户端邀请入口 |

## 1. 目标与范围

**目标**：让现有真实用户带来新用户，双方都得到可消费的额度。这是当前唯一成本可控的拉新渠道——现有 8 个真实活跃用户每天都在用，推荐比任何投放可信。

**范围外**

- 不做邀请排行榜、不做多级分佣（A 邀请 B、B 邀请 C 时 A 不获益）。
- 不改现有 `grantCredit` 的幂等语义与账本结构。
- 不做分享到微信/微博的 SDK 集成，只给一个可复制的码。

## 2. 规则

| 项 | 值 |
|---|---|
| 邀请人奖励 | **¥5**（5,000,000 微元） |
| 每人最多获得 | **3 次**（累计 ¥15） |
| 被邀请人奖励 | **本期不做**（你已确认：暂时不送） |
| 发放时机 | 被邀请人**首次成功模型调用**，且距其注册 **≥ 24 小时** |
| 入账来源 | `invite`（`standard.md` 第 5 节已有） |
| 幂等键 | `externalRef = invite:<inviteId>` |

### 发放条件为什么是「首次成功调用 + 24 小时」

「注册即发」等于给批量注册的人送钱。加两道门槛后：

- **首次成功调用**过滤掉「注册了不用」的账号（现有 66 个账号里有 24 个从未调用）
- **注册满 24 小时**让「当天批量注册、当天互相邀请」无法立刻变现

## 3. worked examples

**E1 — 正常邀请**

用户 A 邀请 B。B 于 10-24 10:00 注册，当天 10:05 就产生了成功调用——**不发**。10-25 10:00 之后 B 再有一次成功调用 → A 得 ¥5。

**E2 — 上限**

A 已成功邀请 3 人。第 4 个被邀请人 C 注册并调用：关系照常记录，但**不发放**，`invites.status = 'capped'`。

**E3 — 自己邀请自己**

A 用另一个邮箱注册 B 并填自己的码：**拒绝**。判定依据是注册时的登录账号，不是邮箱——同一账号无法自己邀请自己。

**E4 — 被邀请人已经注册过**

B 是老用户（已有账号），填入 A 的码：不接受。邀请码只在**账号首次创建**时生效。

**E5 — 重复使用同一码**

C 用 A 的码注册后，D 也用 A 的码注册：都有效，各计一次（上限 3 次内）。

## 4. 数据模型

```sql
ALTER TABLE users ADD COLUMN inviteCode TEXT;          -- 唯一，惰性生成
CREATE UNIQUE INDEX idx_users_inviteCode ON users(inviteCode) WHERE inviteCode IS NOT NULL;

CREATE TABLE invites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  inviterId   TEXT NOT NULL REFERENCES users(id),
  inviteeId   TEXT NOT NULL UNIQUE REFERENCES users(id),  -- 一个人只能被邀请一次
  code        TEXT NOT NULL,                              -- 使用时的码，便于审计
  status      TEXT NOT NULL,                              -- pending | granted | capped
  createdAt   TEXT NOT NULL,
  grantedAt   TEXT
);
CREATE INDEX idx_invites_inviter ON invites(inviterId, status);
```

**历史行**：无。新表从零开始，老账号的 `inviteCode` 为空，第一次请求邀请码时生成。

**`users.createdAt`**：已存在，用于 24 小时判定。

## 5. 流程

**邀请人查看自己的码**（`GET /invite`，需登录）

1. `users.inviteCode` 为空 → 生成 8 位 base32（去掉易混字符），写入。
2. 返回 `{ code, invited: 已发放次数, remaining: 3 − 已发放, earnedMicro }`。

**被邀请人注册**（`POST /auth/email/verify` 增加可选 `inviteCode`）

1. 账号是**新建**且带 `inviteCode` 时：
2. 按码查邀请人；码不存在 → 忽略（**不报错**，避免枚举探测）。
3. 邀请人 = 新账号 → 拒绝（自己邀请自己）。
4. 写入 `invites` 行，`status = 'pending'`。

**发放**（模型请求成功、写入 usage 之后）

1. 该账号作为 `inviteeId` 的 `pending` 邀请存在？
2. 该账号注册时间 ≥ 24 小时？
3. 邀请人已发放次数 < 3？
4. 三条都成立 → `grantCredit(inviter, 5_000_000, 'invite', { externalRef: 'invite:<id>' })`，`status='granted'`。
5. 第三条不成立 → `status='capped'`，不再重试。

**为什么在请求成功后**：那一天他确实用上了产品，而不是注册完就走。

## 6. 接口与配置

| 接口 | 变化 |
|---|---|
| `GET /invite` | **新增**，返回码与统计 |
| `POST /auth/email/verify` | 请求体新增可选 `inviteCode` |

| 配置 | 默认 | 说明 |
|---|---|---|
| `invite.rewardMicro` | `5000000` | 单次奖励（¥5） |
| `invite.maxPerInviter` | `3` | 每人最多获得次数 |
| `invite.minAccountAgeHours` | `24` | 被邀请人注册满多少小时才发放 |

## 7. 客户端影响

充值面板底部或额度条下方加一行「邀请朋友，各得 ¥5」→ 点开显示可复制的码 + 已邀请人数 + 已获得额度。

**需要发版**。网关先上不影响老客户端（老客户端没有入口，但注册时仍可用码——届时通过链接带入）。

## 8. 报表

`wallet_ledger` 里 `source='invite'` 的行数即为发放笔数，金额即发放总额。运营页新增一行「邀请发放」即可，不需要新口径。

## 9. 上线顺序

1. 建表与迁移（schema v12）。
2. 接口与发放逻辑，配置默认值生效。
3. 客户端入口（发版）。
4. 观察一周：发放笔数、被邀请人的 7 日留存。

## 10. 验证

- 单元：码生成唯一；自己邀请自己被拒；老账号填码无效；24 小时内不发放；第 4 次变 `capped`；同一被邀请人只发一次。
- 集成：两个临时账号走完整流程（注册 → 24 小时后模拟调用 → 查 `wallet_ledger` 有 `source='invite'` 且金额 ¥5）。
- 报表：`SUM(amountMicro) WHERE source='invite'` 与 `invites.status='granted'` 条数一致。

## 11. 风险与取舍

| 风险 | 说明 |
|---|---|
| **被邀请人可能是薅羊毛号** | 24 小时 + 首次成功调用两道门槛已过滤大部分；上限 3 次把单账号损失限制在 ¥15 |
| **互相邀请**（A 邀请 B，B 邀请 A） | 双方各得 ¥5，成本 ¥10/对。可接受，不额外处理 |
| 邀请码可被公开分享 | 这是期望行为；上限 3 次防止单人被刷爆 |
| 被邀请人奖励暂不送 | 只有邀请人有激励，被邀请人靠产品本身说服——转化率会低于双向奖励，先观察 |

## 12. 变更记录

| 日期 | 改动 |
|---|---|
| 2026-10-24 | 建立本设计：¥5 × 3 次、延迟到被邀请人首次成功调用且注册满 24 小时、被邀请人无奖励 |
| 2026-10-24 | 实现完成：schema v12（`users.inviteCode` + `invites` 表）、`GET /invite`、注册可选 `inviteCode`、成功后结算 |

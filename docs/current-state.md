# 当前状态

> **最后核对：2026-10-22**（这份文档只记"现在是什么"，变更时由改动者更新并改日期）
>
> 会变的具体数量（测试数、账号数）不写死在这里，写的是**去哪查**——写死必然过期。

## 版本与依赖

| 项 | 值 |
|---|---|
| 客户端版本（`package.json`） | **0.2.3** |
| 用户实际在用的已发布版本 | **v0.2.1**（v0.2.2 与 v0.2.3 的 macOS 构建都因签名步骤失败，未产出安装包） |
| 内置 DSH 钉版（`runtime/package.json`） | **`@deepseek-ai/dsh 0.2.1-rc.2`** |
| 内置 Node | **24.20.0**（macOS arm64 与 Windows x64 各一份 SHA-256） |
| 线上 schema 版本 | **12**（2026-10-24 13:12 北京时间完成迁移；见 `server/src/db.ts` 的 `SCHEMA_VERSION`） |

**已上架的模型**（展示名 → model id）：

| 展示名 | model id | 上游 |
|---|---|---|
| `Mareo-D-V41-Flash` | `deepseek-flash` | DeepSeek（直连） |
| `Mareo-D-V4-Pro` | `deepseek-v4-pro` | DeepSeek（直连） |
| `Mareo-O-6-Sol` | `gpt-6-sol` | OpenAI（东京隧道） |
| `Mareo-O-6-Astra` | `gpt-6-astra` | OpenAI（东京隧道） |

## 怎么查实时数字

```sh
# 测试数量
npm test                                # 客户端
npm --prefix server test                # 网关

# 线上账号数、当日用量、余额（只读）
ssh -i ~/.ssh/mareo-0.pem root@114.55.15.112 \
  'cd /srv/mareo/server/deploy && docker compose exec -T gateway node dist/src/cost-report.js < /dev/null'

# 某个账号的余额与流水
... node dist/src/credit-cli.js balance --account <id|昵称> < /dev/null
... node dist/src/credit-cli.js list    --account <id|昵称> --limit 20 < /dev/null
```

## 线上跑着什么

| 组件 | 状态 |
|---|---|
| 网关容器 | 阿里云杭州，`127.0.0.1:3000`，nginx 在 `api.svc.mareo.cn` 终止 TLS |
| 模型上游 | DeepSeek 直连；OpenAI 经东京中继的 SSH 隧道（systemd `mareo-egress-tunnel`） |
| 运营页面 | `/stats/`、`/stats/users/`、`/stats/health/`，nginx Basic Auth，cron 每 15 分钟重生成 |
| 支付 | 支付宝已接通（公钥模式）；微信未申请商户号，未上线 |

## 正在进行 / 已知问题

| 事项 | 状态 | 影响 |
|---|---|---|
| **邀请迁移导致网关启动失败** | 已于 2026-10-24 13:12 修复上线 | v11 升级先加 `users.inviteCode` 再建索引；公网健康检查恢复 200，数据库检查通过，容器 healthy 且重启次数为 0。备份与验证见 `money/designs/2026-10-24-invite-reward.md` |
| **macOS 发布构建 EMFILE** | 修复已合并（提高 `kern.maxfilesperproc` + 不再打包类型声明），**待 CI 验证** | v0.2.2 / v0.2.3 都没产出安装包，用户仍停在 v0.2.1 |
| **OpenAI 费用未与官方账单对账** | 待办 | 价目表来自第三方镜像，内部复算自洽但没有外部账单校验 |
| **Search/Fetch 计费未记录** | 只有设计文档（`money/designs/2026-10-21-search-billing.md`，draft） | 2026-11-01 起上游按次收费，我们目前不记也不收 |
| **网关代理是 catch-all** | 待修（评审中） | 普通用户令牌可让网关代调上游非模型接口（如 `/user/balance`、`/files`） |
| **并发准入无原子性** | 待修（评审中） | 多个并发请求可各自看到同一份免费额度 |
| 引擎日志跨启动保留 | 已合并，**需新构建生效** | 目前每次启动会截断 `mareo.log` |

## 稳定性方面值得盯的数

- 启动成功率、引擎异常退出率、模型成功率、429 数量：`/stats/health/`
- 成本与额度：`/stats/`（商业区块）
- 每个模型的功能取证明细见 [gateway.md](gateway.md) 与 [operations.md](operations.md)

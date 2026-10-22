# 智能体接手说明

给**并行接手 Mareo 的智能体**。读完 `AGENTS.md`（协作与质量红线）+ 本文，就能在不踩生产的前提下独立干活。

项目是什么、怎么组成：[architecture.md](architecture.md)。现在是什么状态：[current-state.md](current-state.md)。本文只讲**权限、验证方式和踩过的坑**。

## 动手前

1. `AGENTS.md` — 协作规则，最高优先级
2. [architecture.md](architecture.md) — 四条不能碰的接缝
3. [current-state.md](current-state.md) — 版本、已知问题

## 怎么跑

```sh
npm ci && npm --prefix server ci
npm test && npm --prefix server test
npm run typecheck
npm run stage:runtime      # 把 DSH + Node 装进 .staging（gitignore）
npm run verify:runtime     # 钉版是否如预期
npm run verify:brand       # 插件组成 + 鉴权 Web 能否启动
npm start                  # 本地起 Electron
```

改客户端或改运行时钉版时，**前两条 verify 至少都要跑**。

## 怎么验证（项目规矩：看存储值，不看 HTTP 200）

- 功能类改动 → 补 `node:test`；涉及真实进程的用**真实 spawn 一个假 DSH**，不要 mock 掉主流程（参考 `tests/dsh-runtime.test.ts`）。
- 网关上线的改动 → 用**临时账号**打真实请求 → **查数据库里那一行** → 把临时账号删干净。
- 报表类改动 → 用真实数据渲染一次，确认数字彼此自洽（例：分项之和等于当日总额）。

## 怎么碰生产（只读默认，写入需人类明确批准）

```sh
SSH="ssh -i ~/.ssh/mareo-0.pem -o StrictHostKeyChecking=no root@114.55.15.112"
# 容器内命令一律用 dist 入口，且必须带 < /dev/null
$SSH "cd /srv/mareo/server/deploy && docker compose exec -T gateway node dist/src/cost-report.js < /dev/null"
$SSH "cd /srv/mareo/server/deploy && docker compose exec -T gateway node dist/src/config-cli.js list < /dev/null"
# 长脚本：本地写文件，用 stdin 喂进去
$SSH "cd /srv/mareo/server/deploy && docker compose exec -T gateway node -" < /tmp/script.js
```

- **部署网关代码**：服务器上**没有 git**。`rsync server/src/` → `docker compose build gateway` → 成功后 `docker compose up -d gateway`（会重建容器、掐断进行中的流式响应，挑低峰）。改前先 `cp -a src src.bak-<时间戳>`。
- **运行时配置**：`config-cli.js list|set|unset`，写在 `settings` 表，下一个请求生效；金额单位**微元**（1 元 = 1,000,000）。
- **数据位置**：ECS `/srv/mareo/server/deploy/data/mareo.db`。
- **删临时账号的外键顺序**：`usage` → `wallet_ledger` → `tokens` → `identities` → `ad_events` → `reward_tasks` → `users`。
- **不要用 `ORDER BY id DESC` 猜账号**：`users.id` 是 UUID，排序无意义。

## 已经踩过的坑（别重复踩）

1. 容器里 `npm run config|cost|metrics` **必然失败**——镜像 `npm prune --omit=dev` 删了 `tsc`，这些脚本第一步是 `npm run build`。容器内一律 `node dist/src/<脚本>.js`。
2. 本机跑成本报表要用 `npm --prefix server run cost`；**根目录没有 `npm run cost`**。
3. `costOf()` 返回**元**；`settings`/额度是**微元**，两者不能混。
4. 日界线是**北京时间**（`server/src/clock.ts`）；高峰时段（周一至周五 9–12、14–18）DeepSeek 单价翻倍。
5. `usage.model` 为空 = 失败/被拒请求；`usageSource IS NULL` 且 `status=200` 是 2026-09-15 之前的历史行，**不可计价**。
6. `events.launch` 只在启动时上报一次，用户一直开着就没有事件——"某天没事件"不等于"没人用"，看 `usage`。
7. nginx 日志里模型请求是 `POST /chat/completions`（不是 `/v1/...`）；`206` 是正常的分段下载。
8. `docker compose exec -T` 会吃掉脚本自己的 stdin，必须 `< /dev/null`。
9. 始终 `set -o pipefail`：`npm: command not found` 曾被 `| tail` 吞成成功。
10. `git add -A` 会带上 `dist/`、`.staging/` 等产物；只暂存明确路径。
11. **打包必须带 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`**：这台机器直连 GitHub 超时。
12. macOS 本地能签名 ≠ CI 能签名：`ulimit` 之外还有 `kern.maxfilesperproc`，见 `.github/workflows/release.yml`。

## 红线（违反会被回退）

- **不在 `main` 上开发**：每个任务从 `main` 开分支（`feat/` `fix/` `refactor/` `chore/` `docs/`），**不合并、不推 `main`**。
- **不 bump 版本、不打 tag、不推 tag、不触发发布工作流**。
- **生产写入必须事先获得人类明确批准**，且同一时间只允许一个智能体操作。
- 用户可见文案用**中文**；代码注释与提交信息用**英文**。
- **不加投机式兼容层**：没有明确兼容需求时不留双轨实现。
- **钱的事文档先行**：任何触及计价、结算、入账、账本、报表的改动，先在 `docs/money/designs/<日期>-<slug>.md` 写设计、经评审，再写代码；口径只写在 `docs/money/standard.md`。
- 结论必须来自**存储值或真实数据**，不能只凭 HTTP 200。

## 接触面分工

> 这张表由人类维护；变动直接改这里。

| 线 | 负责方向 | 主要文件 | 生产权限 |
|---|---|---|---|
| **A** | 客户端发布工程：启动体验、签名、发版准备 | `src/main.ts`、`src/dsh-runtime.ts`、`assets/startup.html`、`forge.config.cjs`、`.github/workflows/release.yml`、`docs/signing.md`、`docs/release.md` | 可写（每次经批准） |
| **B** | 额度与增长：额度形状、奖励、BYOK 调研 | `server/src/quota.ts`、`server/src/rewards.ts`、`server/src/settings.ts`、`server/src/server.ts`、`brand/client.cjs`、`website/` | **只读** |

交叉约定：

- `docs/operations.md` 与 `brand/client.cjs` 归 **B**；A 若必须改，在 PR 写明原因。
- `runtime/package.json`（DSH 钉版）是全局风险，改动前双方知会。
- **每个智能体用独立 clone 或 `git worktree`**，绝不共用同一工作目录（`git checkout`、`.staging/`、`dist/` 会互相踩）。

汇报格式：

```text
分支：<branch>
改动：<一句话>
验证：<跑了哪些测试/报表，看到什么>
生产影响：<无 / 需要批准的动作>
建议 PR 标题：<title>
```

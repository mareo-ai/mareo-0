# 智能体接手说明（Agents Landing）

这份文档给**并行接手 Mareo 的智能体**看。目标是：读完它 + `AGENTS.md`，你就能在不问人、不踩生产的前提下独立干活。

阅读顺序：`AGENTS.md`（协作与代码质量红线）→ **本文**（项目地图、怎么跑、怎么验、生产怎么碰、当前状态）→ `docs/operations.md`（运营口径与报表）→ 需要动发布时再看 `docs/release.md` / `docs/signing.md`。

---

## 1. 项目地图

Mareo 是 **DeepSeek Harness（DSH）的桌面薄壳**：DSH 始终是第三方依赖，我们不 fork、不改它的源码，只通过环境变量、`--patch` overlay 和插件注入来定制；另有一个自建网关负责账号、计费与额度。

| 目录 | 职责 | 关键文件 |
|---|---|---|
| `src/` | Electron 主进程（TypeScript） | `main.ts`（启动编排、窗口、登录）、`dsh-runtime.ts`（起/停 DSH 进程）、`account.ts`（账号与网关地址）、`telemetry.ts`（事件上报）、`quota.ts`（额度条）、`model-default.ts`（默认模型迁移） |
| `brand/` | 注入 DSH 的品牌插件（宿主半 + 客户端半） | `client.cjs`（侧边栏额度条 `sidebar.footer.action`、赞助位） |
| `assets/` | 启动页 / 登录页 / preload | `startup.html`、`signin.html`、`account-bridge-preload.js` |
| `runtime/` | DSH 运行时依赖**钉版** | `package.json`（`@deepseek-ai/dsh: 0.1.5-rc.2`）、`package-lock.json` |
| `server/` | 自建网关：零框架 Node + TS + `node:sqlite` | `src/server.ts`（路由）、`proxy.ts`（转发 + 用量解析）、`quota.ts`（免费额度 + 钱包两桶）、`wallet.ts`（唯一入账/扣减入口，见 `docs/money/standard.md`）、`rewards.ts`（奖励任务）、`pricing.ts`（唯一算钱入口）、`cost-report.ts`（含「钱包与毛利」分节）、`settings.ts`、`db.ts`（schema） |
| `website/` | 官网（纯静态） | `index.html`、`app.js`、`privacy*.html` |
| `docs/` | 运维/发布/合规文档 | `operations.md`（最常查）、`release.md`、`signing.md`、`metrics.md`、`updates.md`、`privacy.md`、`dsh-upgrade.md`（DSH 升级评估与计划） |
| `docs/money/` | **一切与钱有关的口径与设计文档**（唯一去处） | `standard.md`（权威口径）、`designs/<日期>-<slug>.md`（每次改动一份，先于代码） |
| `scripts/` | 构建、发布、站点、OSS 脚本 | `stage-runtime.mjs`、`release.mjs`、`publish-oss.mjs`、`deploy-site.mjs`、`sign-macos.mjs` |
| `tests/` / `server/test/` | 客户端 84 个 / 服务端 84 个测试 | 全部 `node:test`，无 mock 框架 |

### DSH 的几个"缝"（改客户端前必须知道）

- 启动 DSH：`node --expose-internals <dsh bin> web --host 127.0.0.1 --port 0 --no-open`，客户端等它在 **stdout 或 stderr** 打出带 token 的本地 URL（预算 90 秒，超时自动重试一次，见 `src/dsh-runtime.ts`）。
- 注入的环境变量：`DEEPSEEK_API_KEY=<用户自己的 Mareo 令牌>`、`DEEPSEEK_BASE_URL=<网关>`、`DEEPSEEK_SEARCH_BASE_URL=<网关>/anthropic/v1`。**凭据永远来自账号，不由用户填写。**
- 每个账号独立 `DSH_HOME`（`<userData>/dsh/accounts/<accountId>`），所以配置、会话、附件都按账号隔离。
- 品牌通过 `--patch <mareo-brand.patch.json>`：禁用官方 UI 插件，插入 `mareo-brand`。
- 能不能读图、能不能联网搜索，取决于 DSH 模型目录里条目的 `inputModalities` 与 provider 声明，不在我们代码里硬编码。

---

## 2. 怎么跑

```sh
npm ci                                  # 客户端依赖
npm --prefix server ci                  # 网关依赖
npm test                                # 客户端测试（先 build，再跑 dist/tests/*.test.js）
npm --prefix server test                # 网关测试
npm run typecheck

npm run stage:runtime                   # 把 DSH + Node 运行时装进 .staging（gitignore）
npm run verify:runtime                  # 校验 Node 24 + DSH 版本是否如钉版
npm run verify:brand                    # 校验插件组成 + 登录后 Web 能起来
npm start                               # 本地起 Electron（会 stage 运行时）
npm run make                            # macOS 打包（本地需要可用的签名环境）
npm run make:win                        # Windows 打包（CI 上跑）
```

三套验证各有用途：`verify:runtime` 管"运行时对不对"，`verify:brand` 管"界面/插件装配对不对"，`verify:package` 管"打包产物里有没有运行时"。**改客户端或改运行时钉版，这三条至少要跑前两条。**

---

## 3. 怎么验证（项目规矩：看存储值，不看 HTTP 200）

- 功能类改动 → 补 `node:test` 用例；涉及真实进程的（如 DSH 启动）就用**真实 spawn 一个假 DSH**的集成测试，不要 mock 掉主流程（参考 `tests/dsh-runtime.test.ts`）。
- 网关上线的改动 → 用**临时账号**打真实请求，然后**查数据库里那一行**，最后把临时账号删干净。
- 报表类改动 → 用真实数据渲染一次，确认数字彼此自洽（例如"其中搜索 N 次"之和必须等于当日总额里那部分）。

---

## 4. 怎么碰生产（只读默认，写入需人类明确批准）

```sh
SSH="ssh -i ~/.ssh/mareo-0.pem -o StrictHostKeyChecking=no root@114.55.15.112"
# 容器内命令一律用 dist 里的入口，并且必须带 < /dev/null
$SSH "cd /srv/mareo/server/deploy && docker compose exec -T gateway node dist/src/config-cli.js list < /dev/null"
$SSH "cd /srv/mareo/server/deploy && docker compose exec -T gateway node dist/src/cost-report.js < /dev/null"
# 长脚本：本地写文件，用 stdin 喂进去
$SSH "cd /srv/mareo/server/deploy && docker compose exec -T gateway node -" < /tmp/script.js
```

- **部署网关代码**：服务器上**没有 git**。流程是 `rsync server/src/` → `docker compose build gateway` → 构建成功后再 `docker compose up -d gateway`（会重建容器，掐断进行中的流式响应，挑低峰做）。改完先备份：`cp -a src src.bak-<时间戳>`。
- **运行时配置**：`config-cli.js list|set|unset`，值写在 `settings` 表，下一个请求生效。金额单位**微元**（1 元 = 1_000_000）。
- **数据位置**：ECS `/srv/mareo/server/deploy/data/mareo.db`（compose 目录 `/srv/mareo/server/deploy`）。
- **临时账号探针的清理顺序**（有外键，顺序错了删不掉）：`usage` → `wallet_ledger` → `tokens` → `identities` → `ad_events` → `reward_tasks` → `users`。（`reward_grants` 已在 schema v9 删除。）
- **绝不要 `ORDER BY id DESC` 去猜账号**：`users.id` 是 UUID，排序没有意义。账号 id 从 `issue-token` 的 stderr 里解析。

### 已经踩过的坑（别重复踩）

1. 容器里 `npm run config|cost|metrics` **必然失败**——镜像 `npm prune --omit=dev` 删掉了 `tsc`，这些脚本第一步是 `npm run build`。容器内一律 `node dist/src/<脚本>.js`。
2. `costOf()` 返回**元**；`settings`/额度是**微元**。两者不能混。
3. 日界线是**北京时间**（`server/src/clock.ts`）；高峰时段（周一至周五 9–12、14–18）单价翻倍，由 `ts` 自动判断。
4. `usage` 里 `model` 为空的行是**失败/被拒**请求；`usageSource IS NULL` 且 `status=200` 是 2026-09-15 之前的历史行，**不可计价**，报表会单独标注且不对账。
5. `events.launch` **只在 App 启动时上报一次**。用户一直开着客户端就没有事件——"某天没有事件"不等于"没人用"，要看 `usage`。
6. 0.1.4 的客户端**不上报** `x-deepseek-harness-session-id`，这类账号在报表里会话数会缺失，别当成 bug。
7. nginx `access.log` 里模型请求路径是 `POST /chat/completions`（不是 `/v1/...`）；`206` 是**正常的分段/续传下载**，不是失败。
8. `docker compose exec -T` 会吃掉脚本自己的 stdin，必须 `< /dev/null`。
9. shell 里 `npm: command not found` 这类失败曾被 `| tail` 吞进成功里——始终 `set -o pipefail`，必要时显式用 `$HOME/.nvm/versions/node/v22.22.1/bin`。
10. `git add -A` 会带上 `dist/`、`.staging/` 等产物；只暂存明确路径。

---

## 5. 当前状态快照（截至 2026-10-09）

| 项 | 值 |
|---|---|
| 已发布版本 | **0.1.9**（2026-10-13 上线，含 Windows 启动修复与安装包签名） |
| main 上**未发布**的内容 | Credit Wallet 的**客户端部分**（`brand/client.cjs` 两行额度条 + `src/quota.ts`）；服务端已于 2026-10-13 02:05 上线（schema v9、`enforce`），设计与上线记录见 `docs/money/designs/2026-10-12-credit-wallet.md` |
| 线上额度配置 | `quota.mode=enforce`、默认 **¥10/天**；`quota.accountAllowances` 已随 v9 迁移删除（`1305d9ac`、`f9086e44` 都回到 ¥10/天）。要给某账号放宽额度就给它入账 Wallet（`credit-cli`） |
| 线上请求闸门 | `DAILY_LIMIT=0`（已关闭请求次数上限）、`DAILY_WARN_LIMIT=500` |
| 数据库 | 线上 schema **9**（45 个账号，约 6.7 万行 usage）；迁移前的备份 `deploy/backups/mareo-20261013-020427.db`，旧代码 `deploy/src.bak-20261013-020426` |
| 运行时钉版 | `@deepseek-ai/dsh 0.2.0-rc.2`（在分支 `feat/dsh-0.2.0` / PR #5，**未合并、未发版**；线上 0.1.9 里带的仍是 `0.1.5-rc.2`）。前提、改动与全部验证见 `docs/dsh-upgrade.md` |

### 已知问题（按影响排序）

1. **DeepSeek 余额中断**：历史上发生 4 次 `status=402`（09-14、09-15、09-20、09-28），最近一次让全部用户 15:13–21:12 请求失败。建议做余额告警。
2. **Windows 启动超时**：修复已随 **0.1.9** 发出（90s 预算 + 自动重试一次 + 从 stderr 找地址）；仍要盯发版后 24 小时的启动失败率与版本分布，确认脱离之前的 26%。
3. **Windows 签名覆盖有限**：**0.1.9 起 `Mareo.exe` 与 `MareoSetup.exe` 已签名**（锐安信云签名，2 次/构建，额度 1000 次/年）；Electron DLL 与 DSH 原生模块仍未签（不影响安装，`pty.node` 曾报 `UnknownError`）。SmartScreen 信誉仍需时间积累。
4. **免费额度卡住最活跃用户**：¥10/天硬顶被重度用户反复撞到（单日上百次 429），是最黏用户的主要摩擦点。Credit Wallet 就是为此准备的下一步（钱包可入账、可透支最后一笔）。
5. **更新推不动**：仍有用户停留在 0.1.4（不带 session 头）。

### 进行中的事

- **Credit Wallet 上线**：服务端已在 2026-10-13 02:05 上线（v9、`enforce`，见状态快照）；**客户端两行额度条还没发版**。设计文档见 `docs/money/designs/2026-10-12-credit-wallet.md`。
- **DSH 升级（0.1.5-rc.2 → 0.2.0-rc.2）**：一个 PR（#5，分支 `feat/dsh-0.2.0`）= 网关 + 客户端 + 方案文档。**网关部分已上线**（接受 `x-api-key`、按内容判别搜索、Messages 形态的标题解析）；客户端待发版，发版前还差 Windows 真机烟测。前提、改动与验证见 [`docs/dsh-upgrade.md`](dsh-upgrade.md)。
- **充值（微信/支付宝）**：设计文档在 PR #4（分支 `docs/recharge-design`），待评审；商户号与支付宝企业应用还在申请，代码可先用模拟 provider 跑通。
- 下一步产品方向已定：**当前阶段优先拉新**（高于收钱），"可承受的成本结构"是拉新前提；Wallet 之后是**邀请送额度**（`grantCredit` 已就位，只差入口）。

---

## 6. 红线（违反会被回退）

- **不在 `main` 上开发**。每个任务从 `main` 开分支，`feat/` `fix/` `refactor/` `chore/` `docs/` 前缀；**不合并、不推 `main`**，人类负责 review 与合并。
- **不 bump 版本、不打 tag、不推 tag、不触发发布工作流**。发版由人类手动执行。
- **生产写入必须事先获得人类明确批准，且同一时间只允许一个智能体操作**（网关、数据库、OSS、官网、发布管线都只有一份）。
- 用户可见文案用**中文**（登录/错误/更新提示等），代码注释与提交信息用**英文**。
- **不加投机式兼容层**：没有明确兼容需求时，不留双轨实现、不为假想的未来做抽象。
- **钱的事文档先行**：任何触及计价、结算、入账、账本、报表的改动，先在 `docs/money/designs/<日期>-<slug>.md` 写设计文档（经评审）再写代码；口径只写在 `docs/money/standard.md`，改口径先改它并留变更记录。细则见 `AGENTS.md` 的 "Money changes: documentation first"。
- 结论必须来自**存储值或真实数据**（数据库、日志、报表），不能只凭 HTTP 200 或"看起来对了"。

---

## 7. 分工与接触面

> 下面这张表是**当前安排**，由人类维护；变动请直接改这里。

| 线 | 负责方向 | 主要文件（接触面） | 生产权限 |
|---|---|---|---|
| **A** | 客户端发布工程：启动体验、签名接入、发版准备 | `src/main.ts`、`src/dsh-runtime.ts`、`assets/startup.html`、`forge.config.cjs`、`.github/workflows/release.yml`、`docs/signing.md`、`docs/release.md` | 可写（每次经人类批准） |
| **B** | 额度与增长：额度形状、邀请送额度、BYOK 前置调研 | `server/src/quota.ts`、`server/src/rewards.ts`、`server/src/settings.ts`、`server/src/server.ts`、`brand/client.cjs`、`website/` | **只读**（可查库、跑报表，不改配置/不部署/不发版） |

交叉与协调：

- `docs/operations.md` 与 `brand/client.cjs` 归 **B**；A 若必须改，在 PR 里写明原因。
- `runtime/package.json`（DSH 钉版）属于全局风险，改动前双方知会。
- `docs/agents-landing.md` 本文档由**双方共同维护**：状态快照、已知问题、分工表变了就改。
- **每个智能体用独立 clone 或 `git worktree`**，绝不共用同一个工作目录（`git checkout`、`.staging/`、`dist/` 会互相踩）。

汇报格式（给人类）：

```text
分支：<branch>
改动：<一句话>
验证：<跑了哪些测试/报表，看到什么>
生产影响：<无 / 需要批准的动作>
建议 PR 标题：<title>
```

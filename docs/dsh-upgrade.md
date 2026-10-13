# DSH 升级评估与计划（0.1.5-rc.2 → 0.2.0-rc.2）

> **状态：执行中 —— 代码与静态验证已完成（分支 `feat/dsh-0.2.0`），待在 macOS / Windows 真机烟测后随客户端发版。**
> 负责人 2026-10-13 决定：**先做 DSH 升级，再做充值客户端界面**——充值界面长在 DSH 宿主上（Account 设置页 / `settings.section` slot / preload 桥），先换宿主只需写一遍、验一遍。
> 本文记录的是"照着做"的前提：要禁用的插件、验收标准、回滚方式。结论都来自实测，不是读文档。
>
> 调研方式：在 `/tmp` 里独立安装目标版本，用**与 Mareo 完全相同的启动方式**跑起来核对，不碰仓库、不碰线上。

## 1. 结论摘要

- 有更新：我们钉在 **0.1.5-rc.2（09-10）**，当前 `latest` 是 **0.2.0-rc.2（09-29）**，另有 0.2.1-alpha.2（10-09）。上游没有稳定版，`latest` 本身就是 rc。
- **我们的接缝在 0.2.0-rc.2 上全部可用**（启动、`--patch` overlay、品牌注入、客户端 slot、会话头、标题提示词、搜索端点）。第 4 节是逐条证据。
- **不能"顺手升"**：0.1.5 → 0.2.0 默认 web profile 从 152 个插件涨到 183 个，其中三个面直接碰 Mareo 的商业模式（DeepSeek 账号、插件管理器/配置编辑器、搜索端点设置页），必须先在 patch 里关掉。第 5 节。
- 中间的 **0.1.7-rc.2（09-24）已经包含几乎全部新增面**（182 个插件），所以"只想小步升"并不存在——要么留在 0.1.5 线，要么接受一次大跳。
- 唯一的小步选项是 **0.1.5-rc.3（09-22）**：同线纯补丁，72 个依赖一个没变、profile 完全一致，只是内部包版本号从 rc.2 → rc.3。

## 2. 版本线（npm registry 实测）

| 版本 | 发布 | 默认 web profile 插件数 | 性质 |
|---|---|---|---|
| **0.1.5-rc.2（在用）** | 2026-09-10 | 152 | 现网版本 |
| 0.1.5-rc.3 | 2026-09-22 | 同线 | 纯补丁：依赖集合不变，仅版本号与范围 |
| 0.1.6-alpha.1/2 | 09-15 / 09-17 | — | alpha |
| 0.1.7-rc.1/2 | 09-23 / 09-24 | 182 | 大功能波（账号、插件管理器、侧边栏终端/浏览器…） |
| **0.2.0-rc.1/2（`latest`）** | 09-28 / 09-29 | 183 | 当前 latest/next |
| 0.2.1-alpha.1/2 | 10-03 / 10-09 | — | 最新 alpha |

查版本：

```sh
npm view @deepseek-ai/dsh dist-tags --registry=https://registry.npmjs.org
npm view @deepseek-ai/dsh time --json --registry=https://registry.npmjs.org
```

## 3. 0.1.5 → 0.2.0 默认 web profile 的差异

`--dump-default-config` 出来的真实组成（**权威**，不是猜的）：

```sh
DSH_HOME=$(mktemp -d) node --expose-internals <dsh>/lib/bin.js web --dump-default-config
```

**新增的 id（相对 0.1.5）**：`account-controller`、`agent-preset-registry`、`authorization`、`config-editor`、`cordis-inspect-providers`、`deepseek-account`、`desktop-product-telemetry`、`image-offload`、`job-controller`、`llm-deepseek-account`、`mcp-resources`、`office-to-pdf`、`otel`、`plugin-manager`、`preset-cordis|minimal|ptc|standard`、`product-analytics`、`ptc-runtime`、`shortcuts`、`terminal-controller`、`tool-plugin-manager`、`ui-plugin-manager`、`ui-settings-account`、`ui-settings-agent-loop`、`ui-settings-session-log`、`ui-settings-shell`、`ui-settings-subagent`、`ui-settings-web-search`、`ui-shortcuts`、`ui-sidebar-browser`、`ui-sidebar-terminal`、`workflow-ptc`、`workspace-changes`。

**消失的 id**：`agent-presets`（改名为 `agent-preset` + `agent-preset-registry`）、`code-runtime`、`workflow-worker-thread`、`ui-schedule`。

**用户能拿到的新能力**：插件管理器、配置编辑器、侧边栏终端与浏览器、Office/PDF 技能、MCP 资源、更多设置页（agent-loop / session-log / shell / subagent）、快捷键、图片卸载、workspace 变更视图、preset 体系，以及实验性的语音输入与 Agent Team。

## 4. 已验证的接缝（0.2.0-rc.2 实测通过）

用我们的启动参数在临时目录真起了一遍：

```sh
node24 --expose-internals <dsh020>/lib/bin.js web \
  --patch <我们的 mareo-brand.patch.json> --host 127.0.0.1 --port 0 --no-open
```

| 接缝 | 结果 |
|---|---|
| 启动并打印 `http://127.0.0.1:<port>/?token=…`（stdout/stderr） | ✓ |
| 带 token 换会话（303）→ 鉴权首页（200） | ✓ |
| `--patch` overlay：注入 `mareo-brand`、禁用 `ui-brand-official`、禁用 `ui-settings-models` | ✓ 与 `scripts/verify-brand.mjs` 的断言一致 |
| `dsh-client-ui-model-selection` 仍在 boot graph | ✓ |
| 我们客户端插件 inject 的 4 个包（renderer / sidebar / conversation / layout） | ✓ 都存在 |
| slot 名 `sidebar.footer.action`、`sidebar.brand.mark`、`sidebar.brand.name` | ✓ 都在 |
| `dsh.client.inject` + `platform` manifest 格式、`__ModuleLoader__` 契约 | ✓ 未变 |
| 会话头 `x-deepseek-harness-session-id`（`dsh-llm-deepseek`） | ✓ 仍上报 |
| 标题提示词原文 `Generate the session title from this JSON array of human messages` | ✓ 未变（网关的 `title` 计费识别不受影响） |
| `DEEPSEEK_SEARCH_BASE_URL` + Anthropic `/messages`、`web-search-deepseek.apiKeyEnv=DEEPSEEK_API_KEY` | ✓ 未变 |
| node 版本要求 | 仍需 **node 24**（在 node 23 上 DSH 会**静默什么都不做**，不报错） |

**未验证**：品牌 UI 与额度条在浏览器里真的渲染。上面只证明了 host 侧注入与契约，渲染要真机烟测（第 6 节第 4 步）。

## 5. 升级前必须处理的面（否则漏钱或漏支持）

0.2.0 默认把下面这些打开，而我们**不能让用户看到**：

| 面 | 为什么必须关 | 在 patch 里禁用 |
|---|---|---|
| DeepSeek 账号 / 凭据 | 用户可以登录自己的 DeepSeek 账号并选到走账号的模型，**绕过 Mareo 网关：不计费、不限额度**。它不是覆盖我们注入的 env 凭据，而是新增的独立 provider（`PROVIDER = "deepseek-account"`，未登录时报 `ACCOUNT_SIGN_IN_REQUIRED`） | `deepseek-account`、`llm-deepseek-account`、`ui-settings-account` |

**总原则（负责人 2026-10-13 定）**：这个 overlay **只写我们真正有主张的条目**（品牌、账户体系、模型入口），其余一律跟随 DSH 默认；覆盖上游默认值等于在每次升级时悄悄偏离上游，不做。当前 overlay 一共只有 5 条禁用 + 1 条注入。

**故意保留给用户的（负责人 2026-10-13 看过真实界面后定）**：

| 面 | 保留的理由 |
|---|---|
| 插件管理器（`ui-plugin-manager` 界面 + `plugin-manager` 后端） | 用户可以在「插件」页里启用官方组合包（语音输入等），也可以停用不想要的。**它翻不掉我们的禁令**：我们的 `--patch` 在 profile 层之后应用；实测在 profile 里写 `mareo-brand: disabled` 与 `ui-settings-account: disabled: false`，最终生效仍是「品牌启用、账号禁用」。 |
| 搜索端点设置页（`ui-settings-web-search`） | 它长在插件页里（`plugins.item` slot）。用户填**自己的 key 与端点**时，那次搜索不经过我们、也不花我们的钱，因此**不需要入账**；代价只是我们失去这部分可见性（近 7 天搜索占请求 8.4%、占成本 12%，高峰日 25%）。 |
| `tool-plugin-manager` | **不干预，跟随 DSH 默认**（当前官方默认是关的）。它把「装插件」做成给模型调用的工具；负责人 2026-10-13 定：*「如果默认就是 disabled，那就保持，我们尽可能和 DSH 保持一致」*——所以这里**不写任何条目**，将来上游改了我们也跟着。 |

> **有意接受的取舍**：插件页的「+ 添加插件」允许用户按 spec 安装任意组合包，带来供应链面，以及「装一个自带 key 的 provider 插件」从而绕开网关的可能。我们接受，因为①这些用户本来就能自己装 DSH；②常规路径下模型调用仍由我们注入的 base URL 与令牌决定。

> ⚠️ **不要禁用 `config-editor`**（初版方案写错了，真机烟测才发现）：它的名字像"给用户改配置的编辑器"，实际是**设置服务的地基**——`dsh-settings` 的 `inject = ["configEditor", "profileContext"]`，设置值就是经它持久化的。禁掉它会让 `settings` 服务永远 pending，**连我们自己的 Account 设置区（以及将来的充值界面）一起挂掉**。烟测日志里那句 `settings … pending (waiting for service: configEditor)` 就是它。
>
> 另外：禁掉 `deepseek-account` 之后，日志会出现一条 `account-controller … pending (waiting for service: deepseekAccount)`——这是**预期内**的（那是我们不想要的账号 API），不是故障。

保留（对我们有利、且不碰计费）：`ui-sidebar-browser`、`ui-sidebar-terminal`、`office-to-pdf`、`mcp-resources`、`ui-shortcuts`、各 `ui-settings-*`（agent-loop / session-log / shell / subagent）、preset 体系、实验性的语音输入与 Agent Team。
**不要动** `authorization`：审批/权限流程要用它。

天然对我们关闭（不必处理）：`desktop-product-telemetry` 与 `product-analytics` 的启用条件是 `profileContext?.name === 'desktop'`，而我们跑的是 `web` profile。

落地后要断言：`--dump-config` 里上面每个 id 都是 `disabled: true`，`config-editor` **没有**被禁用，且模型列表里不再出现走账号的模型。

## 6. 升级步骤与验收

1. **试分支**：`runtime/package.json` 钉到目标版本 → `npm --prefix runtime install` → `npm run stage:runtime`。
2. **扩展 patch**：按第 5 节加禁用项（`src/dsh-runtime.ts` 里那段 patch，保持"id + disabled"的既有写法）。
3. **静态验收**：`node --expose-internals <dsh>/lib/bin.js web --dump-config --patch <我们的 patch>` → 第 5 节每个 id 都是 `disabled: true`；`npm run verify:brand` 通过。
4. **真机烟测（macOS + Windows 各一次）**：
   - 品牌元素与侧边栏额度条正常渲染（这是第 4 节没覆盖的部分）；
   - 发一条对话 → 网关 `usage` 行出现且 `actualMicro/billableMicro` 正确（说明模型请求仍走 Mareo 网关）；
   - 触发一次联网搜索 → `requestKind='search'` 且计入账本；
   - 会话标题 → `requestKind='title'` 正常记账；
   - 设置里看不到 DeepSeek 账号入口、插件管理器、搜索端点页。
5. **发版观察**：客户端发版后看 24 小时启动失败率与版本分布（对齐 0.1.9 的启动修复效果）。

**回滚**：`runtime/package.json` 与 patch 都是纯代码改动，回滚就是把这两处改回去重新打包。**但注意本地会话数据格式**：0.2.0 新增了 `dsh-session-format-v3-to-v4`，新写入的会话是 v4 代际；迁移本身是**非破坏性**的（包说明写明"在不改写已存储代际的前提下"读取时转换，所以历史会话文件仍是 v3，回滚后照样能读），**回滚的代价是升级后新建的会话在旧客户端里可能读不了**。发版说明里要写清这一点。

## 7. 打包注意（升级会碰到原生模块）

DSH 带原生模块（`node-addon-require-builtin`、`sharp`、`koffi`、`pty.node`、`rg.exe`…）。实测：

- npm 下载下来的 `.node` 是 **ad-hoc 的 linker-signed**（`TeamIdentifier=not set`），直接在我们签名过的 node 进程里 `dlopen` 会失败：`mapping process and mapped file (non-platform) have different Team IDs`。
- App 包里那份是**我们 Developer ID（`Q85U66X3JF`）签名**的，所以线上正常——说明现有打包流程会自动重签，**升级必须走正常的签名构建，不能只替换 node_modules**。
- 旧代码备份在服务器 `deploy/src.bak-*`、数据库备份在 `deploy/backups/`（见 `agents-landing.md` 状态快照）。

## 8. 已完成的验证（2026-10-13，分支 `feat/dsh-0.2.0`）

| 项 | 结果 |
|---|---|
| `npm run stage:runtime` | ✓ `Verified Node 24.20.0 and DSH 0.2.0-rc.2` |
| `npm run verify:brand` | ✓ `Verified official plugin composition and authenticated Web boot`（新版本上品牌宿主正常起来） |
| 5 个禁用项是否真的生效 | ✓ 用 `--dump-config --patch` 逐条断言，全部 `disabled: true`；`mareo-brand` 已注入且启用；插件管理器与搜索设置页**未被禁用**（测试里也钉住了这两条，防止以后被顺手关掉） |
| 用户改 profile 层能否覆盖我们的 patch | ✓ 实测：profile 里写 `mareo-brand: disabled` 与 `ui-settings-account: disabled: false`，composed 结果仍是「品牌启用、账号禁用」——我们的 overlay 最后应用 |
| 客户端 slot 契约 | ✓ `sidebar.brand.mark` / `sidebar.brand.name` / `sidebar.footer.action` / `conversation.hero.brand.mark` / `shell.overlay` / `settings.section` 全部仍在（0.2.0 还多了 `sidebar.toggle.badge`） |
| 我们 inject 的 4 个包 | ✓ renderer / sidebar / conversation / layout 都在 |
| 测试 | ✓ `runtime/package.json` 的钉版与 patch 断言已写进 `tests/dsh-runtime.test.ts`，客户端测试 84/84 |
| 会话格式 | ⚠ 见第 6 节回滚说明（v3 → v4，非破坏性） |
| 真机烟测（macOS） | ✓ 已跑（2026-10-13）：品牌渲染正常；**两行额度条正常渲染**（`今日免费 ¥7.87 / ¥10.00` + 细进度条 + `Mareo 余额` + `可用合计`）——证明客户端插件 → preload 桥 → 主进程 → 网关 `/quota` 这条链路在新宿主上通。烟测同时抓到下面两个真问题 |
| 修好之后重跑（GUI） | ✓ 发一条消息成功返回；网关侧该 session 落 `chat`（`12537 → 16299`）与 `title`（`244 → 318`）两行，**标题「问候与自我介绍」正确入库**（`source=gateway`）——Messages 形态的标题识别与提取端到端可用 |
| 真实 0.2.0 流量的三类调用（headless profile，不开界面） | ✓ 13 笔请求**全部 200**：`chat` 6 / `title` 1 / **`search` 6**，分类与计费全部自洽（如 `18034 → 23445 = ceil(18034×1.3)`）；搜索真的取回三个来源并给出结论——证明 0.2.0 搜索插件的认证（`x-api-key` + Bearer）与内容判别在该路径上成立 |
| 真机烟测（Windows） | ⬜ 待做（发版前用 Windows 构建流程验一次） |

## 8.1 烟测抓到的两个真问题（都只有真机能发现）

**① 禁错了 `config-editor`**（已修，见第 5 节的警告框）：它名字像"配置编辑器"，实际是设置服务的地基，禁掉会让 `settings` 永久 pending，连带我们自己的 Account 区一起挂。

**② DSH 0.2 换了调用协议**（这才是本次升级的主要工作量）：

| | 0.1.5（线上在用） | 0.2.0 |
|---|---|---|
| 端点 | `POST /chat/completions`（OpenAI 形态） | `POST ${base}/v1/messages`（**只支持 Messages API**，代码里写死 `protocol is not configurable`） |
| 默认 base | `https://api.deepseek.com` | `https://api.deepseek.com/anthropic` |
| 认证头 | `Authorization: Bearer` | **`x-api-key`**（新的 `dsh-llm-deepseek-api-key` 只发这个头） |
| 对话/标题路径 | `/chat/completions` | 与搜索同为 `/anthropic/v1/messages` |

第一次烟测就是因此失败的：nginx 里留下 `POST /v1/messages 401 25 bytes deepseek-harness/0.2.0-rc.2`（25 字节正是我们网关的 `{"error":"invalid token"}`）。

**由此产生的三处改动**：

1. **网关认证**：接受 `x-api-key: <令牌>` 等同 `Authorization: Bearer <令牌>`（加法，对 0.1.5 无影响）。
2. **网关分类**：搜索改按**请求体内容**判别（`tools[].type === "web_search_20250305"`，两版一致），因为 0.2.0 把对话与标题也放到同一路径——否则每轮对话都会被记成"搜索"。
3. **客户端 `src/main.ts`**：`DEEPSEEK_BASE_URL` 由 `${GATEWAY_URL}` 改为 **`${GATEWAY_URL}/anthropic`**（provider 自己会追加 `/v1/messages`）。搜索端不变。
4. **网关的标题解析**（同一形态带来的第二处）：Messages 形态把消息文本放在 `content` 块数组里、流式回答用 `delta.text`，而 `isTitleRequest` 只认字符串、`textFromResponseTail` 只解析 `choices[]` —— 结果是标题调用被记成 `chat`、标题文本提不出来（计费不受影响，但报表的标题与分类会悄悄空掉）。两种形态现在都处理。

**已验证无需改动**：流式用量解析（真实 Messages 流最后一帧 `message_delta` 带**完整** usage，不是官方 Anthropic 那种只给 output）、价目表（0.2.0 只发 `deepseek-flash` / `deepseek-v4-pro`，都在表内）、客户端 slot、inject 目标、会话头、标题提示词。

**状态**：网关改动已实现并**已上线**（PR #6，2026-10-13 03:07 与 03:12 两次；备份 `src.bak-20261013-030735`、`src.bak-20261013-031221`，数据库 `backups/mareo-20261013-030738.db`、`mareo-20261013-031223.db`）。**生产实测**：`x-api-key` + Messages 路径的对话体 → 200 且记 `chat`（`99 → 129`）；带搜索工具体 → 200 且记 `search`（`11807 → 15350`）；Messages 形态的标题调用 → 200 且记 `title`，标题文本正确落库（「撰写本周项目周报」，`source=gateway`）。两次上线后老客户端流量分别 47 笔 / 58 笔请求**全部 200**，nginx 无 4xx/5xx。客户端那处改动在 `feat/dsh-0.2.0`（commit `a305cf7`），**待随客户端发版**。

## 9. 待决策（与升级无关，属既有事项）

`session-telemetry-otel` 在 **0.1.5 里就已存在**：`mode` 默认 `FEEDBACK_ONLY`，导出到 `https://harness-telemetry.deepseeksvc.com/v1/logs`（0.2.0 改成 `dsh-otel-collector.deepseeksvc.com`），环境变量 `DSH_TELEMETRY_MODE` / `DSH_TELEMETRY_OTLP_URL` 可覆盖。也就是说：用户提交"反馈"时，会话内容会发往 DeepSeek 的采集端点。

这是**既有行为**，不是升级带来的回归，但目前 `docs/privacy.md` 没有提到它。两选一：在隐私政策里写清楚，或者用 `DSH_TELEMETRY_MODE` 关掉。建议在做 0.2.0 升级时一并定。

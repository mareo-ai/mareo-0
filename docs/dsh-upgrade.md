# DSH 升级评估与计划（0.1.5-rc.2 → 0.2.0-rc.2）

> **状态：调研完成，待执行。** 负责人 2026-10-13 决定：**等 Credit Wallet 客户端发版之后再做**，现在不动。
> 本文记录的是"到时候照着做"的前提：要禁用的插件、验收标准、回滚方式。结论都来自实测，不是读文档。
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

| 面 | 为什么必须关 | 建议在 patch 里禁用 |
|---|---|---|
| DeepSeek 账号 / 凭据 | 用户可以登录自己的 DeepSeek 账号并选到走账号的模型，**绕过 Mareo 网关：不计费、不限额度**。它不是覆盖我们注入的 env 凭据，而是新增的独立 provider（`PROVIDER = "deepseek-account"`，未登录时报 `ACCOUNT_SIGN_IN_REQUIRED`） | `deepseek-account`、`llm-deepseek-account`、`ui-settings-account` |
| 插件管理器 + 配置编辑器 | 用户可装插件、改配置：我们的计费链路、品牌界面、额度条都变成用户可改的东西，支持面失控 | `plugin-manager`、`tool-plugin-manager`、`ui-plugin-manager`、`config-editor` |
| 搜索端点设置页 | 用户能把联网搜索指向别处，这部分调用跑出账本（现在搜索经网关计费） | `ui-settings-web-search` |

保留（对我们有利、且不碰计费）：`ui-sidebar-browser`、`ui-sidebar-terminal`、`office-to-pdf`、`mcp-resources`、`ui-shortcuts`、各 `ui-settings-*`（agent-loop / session-log / shell / subagent）、preset 体系、实验性的语音输入与 Agent Team。
**不要动** `authorization`：审批/权限流程要用它。

天然对我们关闭（不必处理）：`desktop-product-telemetry` 与 `product-analytics` 的启用条件是 `profileContext?.name === 'desktop'`，而我们跑的是 `web` profile。

落地后要断言：`--dump-config` 里上面每个 id 都是 `disabled: true`，且模型列表里不再出现走账号的模型。

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

**回滚**：`runtime/package.json` 与 patch 都是纯代码改动，回滚就是把这两处改回去重新打包；运行时不写数据库，不涉及数据迁移。

## 7. 打包注意（升级会碰到原生模块）

DSH 带原生模块（`node-addon-require-builtin`、`sharp`、`koffi`、`pty.node`、`rg.exe`…）。实测：

- npm 下载下来的 `.node` 是 **ad-hoc 的 linker-signed**（`TeamIdentifier=not set`），直接在我们签名过的 node 进程里 `dlopen` 会失败：`mapping process and mapped file (non-platform) have different Team IDs`。
- App 包里那份是**我们 Developer ID（`Q85U66X3JF`）签名**的，所以线上正常——说明现有打包流程会自动重签，**升级必须走正常的签名构建，不能只替换 node_modules**。
- 旧代码备份在服务器 `deploy/src.bak-*`、数据库备份在 `deploy/backups/`（见 `agents-landing.md` 状态快照）。

## 8. 待决策（与升级无关，属既有事项）

`session-telemetry-otel` 在 **0.1.5 里就已存在**：`mode` 默认 `FEEDBACK_ONLY`，导出到 `https://harness-telemetry.deepseeksvc.com/v1/logs`（0.2.0 改成 `dsh-otel-collector.deepseeksvc.com`），环境变量 `DSH_TELEMETRY_MODE` / `DSH_TELEMETRY_OTLP_URL` 可覆盖。也就是说：用户提交"反馈"时，会话内容会发往 DeepSeek 的采集端点。

这是**既有行为**，不是升级带来的回归，但目前 `docs/privacy.md` 没有提到它。两选一：在隐私政策里写清楚，或者用 `DSH_TELEMETRY_MODE` 关掉。建议在做 0.2.0 升级时一并定。

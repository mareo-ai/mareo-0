# 排查手册

按**症状**查，不按模块查。每条只说四件事：看到什么、为什么、怎么确认、怎么修。

> 规则：修完一个非平凡问题，**在同一个分支**里往这里加一条。只写在 PR 描述里等于没写——PR 不会有人回头翻。

---

## 构建与发布

### macOS CI 报 `EMFILE: too many open files`，而且 `ulimit -n` 已经调过了

**根因**：macOS 有**两层**文件句柄上限。`ulimit -n` 只改 shell 那层，内核另有一道
`kern.maxfilesperproc`（默认 runner 约 10240）。shell 报 65536，内核照样在 10240 处拒绝。

**怎么确认**：看构建日志里打印的 `open files` 值是否远大于失败位置的文件序号；
在本机对比 `sysctl kern.maxfilesperproc` 与 `ulimit -n`（本机是 61440 / 1048575，所以本地能过、CI 不能）。

**修法**：CI 里先 `sudo sysctl -w kern.maxfilesperproc=65536` 再 `ulimit -n 65536`（见 `.github/workflows/release.yml`）。
同时减少签名器要遍历的文件数——见下一条。

### 打包出来的应用有 6 万个文件

**根因**：DSH 的依赖树没做去重（`node_modules` 嵌套最深 6 层，`zod` 被装了 51 份），
每个包还带"编译产物 + 类型声明 + source map + 文档"四件套。签名器会**遍历并逐个打开**每个文件。

**怎么确认**：

```sh
find .staging/dsh-runtime -type f | wc -l
find .staging/dsh-runtime -name '*.d.*' | wc -l     # 类型声明，运行时用不到
```

**修法**：`scripts/stage-runtime.mjs` 在 `npm ci` 之后删掉 `.d.ts/.d.cts/.d.mts`（Node 从不读它们，
但曾占 63,603 个文件里的 19,046 个）。**不要**顺手删 `.map`——崩溃堆栈会失去意义，我们正需要它。

### 本地能签名，CI 就是不行

除了上面两层句柄限制，还要注意：CI 的 runner 是**干净环境**，同一份代码在本地过不代表在 runner 过。
判断方法：在本地用**同样的限制**跑一遍。

```sh
bash -c 'ulimit -n 65536; npx electron-forge package --arch=arm64'
```

### `gh workflow run` 返回 404，但仓库和 workflow 都在

**根因**：`gh` 的 token 缺 `workflow` scope。它不会报权限错误，只会静默 404。

**怎么确认**：`gh auth status` 看 scopes 里有没有 `workflow`。

**修法**：`gh auth refresh -s workflow`。

### `npm run make` 卡在下载 Electron / 报 `ETIMEDOUT 20.205.243.166:443`

**根因**：这台机器直连 GitHub 会超时。

**修法**：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run make`。

---

## 网关与计费

### OpenAI 请求的 `sessionId` 全是 NULL

**根因**：客户端**两条路由把会话标识放在不同位置**——Messages 路由放请求头
`x-deepseek-harness-session-id`，Responses 路由放请求体 `prompt_cache_key`。网关一开始只读请求头，
于是 Sol 的请求全部没有会话（当时 158 条全是 NULL，DeepSeek 是 375/375）。

**怎么确认**：

```sql
SELECT model, COUNT(*), SUM(CASE WHEN sessionId IS NOT NULL THEN 1 ELSE 0 END)
FROM usage WHERE status = 200 GROUP BY model;
```

**修法**：`server/src/proxy.ts` 在请求头缺失时从请求体读 `prompt_cache_key`（定位后只解码紧邻的值，
不要为 5MB 的提示词做整包 JSON 解析）。

### 用户在 Sol 上花得比预期多很多

**根因**：通常不是计价 bug，而是三件事叠加：

1. **上下文很长**——每轮都把整段历史重发；
2. 输入超过 **272,000** token 时，上游对整个请求按 2 倍输入、1.5 倍输出计费；
3. **缓存是冷的**——隔夜或换模型后首次调用，缓存价（$0.2/1M）变全价（$2/1M），差 10 倍。

**怎么确认**：按输入区间分组看真实成本：

```sql
SELECT CASE WHEN inputTokens > 272000 THEN '>272K'
            WHEN inputTokens >= 200000 THEN '200-272K'
            ELSE '<200K' END grp,
       COUNT(*), SUM(inputTokens), SUM(actualMicro), SUM(billableMicro)
FROM usage WHERE model = 'gpt-6-sol' AND status = 200
  AND ts >= '<起始>' GROUP BY grp;
```

实测样例：52 个越线请求贡献了 81% 的结算额；单轮 48.5 万 token 的冷缓存请求 ≈ ¥17.76。

**修法**：让上下文留在阈值以下（新开会话比"继续长会话"便宜一个量级）；隔夜后首轮留意；
`compaction-basic` 的阈值要按**实测比例**调，不能凭感觉往下压——见下一条。

### 明明配了压缩策略，上下文还是涨到 40 万

**根因**：引擎的压缩判断用**它自己的 token 估算器**，与上游实际计费的提示词不是同一口径
（系统提示词、工具定义、不可压缩的大块工具输出会撑大真实提示词）。阈值可能永远达不到。

**怎么确认**：数会话日志里的压缩事件与时间——如果最近的压缩都在很久以前，说明这次根本没触发。

**修法**：先改**可观测性**（引擎日志跨启动保留、`prompt_cache_key` 落库），
再根据"估算值 vs 真实 token"的比例调阈值。**不要**直接把 `thresholdRatio` 压到很低——那会用上下文质量换账单。

### 容器里跑 `npm run cost` / `config` / `metrics` 失败

**根因**：镜像 `npm prune --omit=dev` 删掉了 `tsc`，而这些脚本第一步是 `npm run build`。

**修法**：容器内一律 `node dist/src/<脚本>.js`。本机用 `npm --prefix server run cost`——
注意**根目录没有 `npm run cost`**。

### 支付回调验签失败（`isv.invalid-signature`）

**根因**：支付宝签名规则在两个方向上是**不对称**的——请求签名要**包含** `sign_type`，
回调验签要**排除** `sign` 与 `sign_type`。

**修法**：见 `server/src/payment/alipay.ts`；两处都有回归测试，改签名拼装时别只跑一边。

---

## 客户端与引擎

### 历史会话打不开，报 `contains event type ... unknown to this harness`

**根因**：DSH 的会话日志只增不减，读取是 fail-closed。用新版运行时写过的会话，旧版读不了。

**修法**：见 [session-log-downgrade.md](session-log-downgrade.md)——它有启动守卫、发版禁止降级、恢复工具三层。

### 用户说"我什么都没做，额度就没了"

先分清**一条消息**和**一个回合**：一次提问会触发多次模型调用（每次工具调用后都要再问模型），
每次都带着完整上下文重新计费。用下面的查询把账摆出来，再判断是不是异常：

```sql
SELECT model, COUNT(*), SUM(inputTokens), SUM(actualMicro), SUM(billableMicro), SUM(paidFromFreeMicro)
FROM usage WHERE userId = '<id>' AND substr(ts,1,10) = '<北京日>' AND status = 200
GROUP BY model;
```

---

## 官网

### 下载按钮指向旧版本 / 某平台显示"待开放"

**根因**：官网不在页面里写死链接，而是读同域的 `updates/latest.json`；该清单由发布流程写入。

**怎么确认**：`curl -s https://mareo.cn/updates/latest.json` 看版本与下载地址是否是最新。

**修法**：见 [release.md](release.md)——先修发布，再修清单；**不要**直接改 `index.html` 里的按钮。

### 官网同步把 `updates/` 或 `downloads/` 删了

**根因**：`rsync --delete` 会删除源目录里不存在的东西，而这两个目录由发布流程独占。

**修法**：`scripts/deploy-site.mjs` 已排除它们；改同步参数时必须保留这两个 `--exclude`。

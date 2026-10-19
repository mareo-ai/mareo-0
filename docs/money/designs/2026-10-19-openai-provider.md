# OpenAI 作为第二个上游（Mareo 转售）

| | |
|---|---|
| 日期 | 2026-10-19 |
| 状态 | **draft，待评审**（价格表、汇率、首批模型待确认） |
| 依赖 | [`../standard.md`](../standard.md)（单位、入账来源、账本语义、报表定义） |
| 影响 | 网关新增一个上游与一张价目表、`usage` 增列、报表按 provider 分账、客户端模型目录 |
| 是否用户可见 | 是（模型选择器里出现 `gpt-5`，需要一次客户端发版） |

> 本文先于代码存在。实现中若必须偏离，先改本文并在「变更记录」留痕。

## 1. 目标与边界

**目标**：让用户在 Mareo 里选到 OpenAI 的模型，**计费方式与 DeepSeek 完全一致**——优先扣今日免费额度，再扣 Mareo 余额，结算仍按 `billable = ceil(actual × rate)`。

**不做**（本阶段）：
- 用户自带 key（BYOK）；供应商设置页保持关闭，路由由我们的 patch 注入
- Azure OpenAI（第二个 OpenAI 兼容上游，等接入摩擦解决后按配置切换）
- 退款、赠送、按 provider 差异化的免费额度

**为什么从直连开始**：你已有账号与 key，链路当天能验证。**生产建议切 Azure**（合同/DPA/区域驻留/延迟/配额都更稳），因此上游必须写成**可配置**（见 §5.2），切换只改配置不改代码。

## 2. 计价算术

沿用 `standard.md`：`actualMicro = 官方价 × token 数`，`billableMicro = ceil(actualMicro × rate)`，`marginMicro = billable − actual`。

**新增两件事**：

1. **美元 → 人民币**：OpenAI 官方价是 USD/1M tokens。表里存 USD，运行时乘**汇率**：
   - 汇率**可配置**（`PRICING_FX_RATE` 环境变量，默认 **7.0**），改汇率不需要发版
   - **只影响之后的请求**：`usage.actualMicro` 在请求结束时算好并落库，换汇率**不回算历史**
   - 每行 `usage` 记录 `priceVersion`（如 `2026-10-19#fx7.0`），任何一笔都能追溯到用了哪张价目表、哪个汇率
   - 以后改成每日自动更新（取中间价）时，只需替换这个值的来源，计价逻辑不变
2. **缓存计价三档不同**（与 DeepSeek 对齐但数值不同）：
   - OpenAI：`cached input` 约为 `input` 的 **10%**（具体以官方价目为准）
   - Anthropic（后续）：`cache read` 0.1×、`cache write` 1.25×
   - 因此 `usage` 需要区分 **cacheWrite**（见 §4）

**长上下文档位**：这批模型对**超过 272K input tokens** 的请求，整单按 **2× input、1.5× output** 计价。必须在价目表里表达成可测的规则，否则一次大上下文请求就会亏。

**边界（必须测试）**：
- `cacheWrite + cacheMiss + cacheHit = inputTokens` 恒等；任一列缺失按 0 计并告警
- `reasoning_tokens` 按 **output 价**计（OpenAI 的 reasoning 计入 completion）
- 一轮请求跨零点的按**请求开始时刻**计价（与 `standard.md` 一致）
- 定价缺失的模型 → **拒绝请求**（fail-closed），不猜价

**worked example（只演示算术，括号里的单价是占位，不是官方价）**：输入 12,000（其中 cache hit 10,000）、输出 800、汇率 7.3、rate 1.3
- 实际成本 USD = 10,000/1e6×(cached) + 2,000/1e6×(input) + 800/1e6×(output)
- 代入占位价 input=$1.25、cached=$0.125、output=$10：0.00125 + 0.0025 + 0.008 = **$0.01175**
- 折人民币 = **¥0.0858** → `actualMicro = 85 780`（微元取整）
- `billableMicro = ceil(85 780 × 1.3) = 111 514`
- **真实单价待负责人从 OpenAI 后台抄录后替换**（见 §5.4）

## 3. 数据模型（schema v10 → v11）

`usage` 增两列（不动其他表）：

```sql
ALTER TABLE usage ADD COLUMN provider TEXT;            -- deepseek | openai（未来 azure、anthropic）
ALTER TABLE usage ADD COLUMN cacheWriteTokens INTEGER; -- Anthropic 用；OpenAI 恒为 0
```

- 历史行 `provider = NULL`，报表把 NULL 视为 `deepseek`（当时只有这一个上游）
- 新写入必须带 `provider`；读侧兼容 NULL（避免历史报表崩）
- 索引：`idx_usage_provider_ts ON usage(provider, ts)`，供按 provider 分账查询

## 4. 流程

### 4.1 请求链路

```
客户端（OpenAI 路由）→ POST /openai/v1/chat/completions  → 我们的网关
  → 鉴权（Mareo token，Bearer）
  → 读 body 里的 model
  → model → provider（价目表）
      · 不在表里 → 400 unpriced-model（不转发、不产生成本）
  → 选上游（§5.2 配置）：baseURL / path 模板 / 鉴权头
  → 注入 stream_options.include_usage（流式时，否则拿不到 usage）
  → 转发，流式原样透传
  → 从响应尾部提取 usage → 归一化 → 记 usage(provider) → 结算
```

### 4.2 usage 归一化

Responses API 与 Chat Completions 的字段名不同，网关按上游类型取对应字段（下表以 Responses 为准，括号内为 Chat Completions 等价字段）：

| 我们的列 | OpenAI 字段 |
|---|---|
| inputTokens | `usage.input_tokens`（Chat: `usage.prompt_tokens`） |
| cacheHitTokens | `usage.input_tokens_details.cached_tokens`（Chat: `prompt_tokens_details.cached_tokens`） |
| cacheMissTokens | `input_tokens − cached_tokens` |
| outputTokens | `usage.output_tokens`（Chat: `completion_tokens`） |
| reasoningTokens | `usage.output_tokens_details.reasoning_tokens`（Chat: `completion_tokens_details.reasoning_tokens`） |
| cacheWriteTokens | 0（OpenAI 无此概念） |

取不到 usage 的流（被中断）→ 记 `status` 且 `usageSource = null`，**不计费**，报表计入"缺 usage"（沿用现有口径）。

## 5. 接口与配置

### 5.1 网关新增路由

> **关键约束**（第三方镜像的模型说明，实现前必须用一个真实请求验证）：gpt-6 系列在
> **Chat Completions 上只在关闭 reasoning 时支持 function calling**；开启 reasoning 时的
> 内置工具与函数调用**要求走 Responses API**。而 DSH 是重度使用工具调用的编程 agent，
> 因此**首批路由应走 `openai-responses`**，而不是 Chat Completions。这也决定了下面的路径与 usage 字段。

- `POST /openai/v1/responses` → OpenAI Responses API 上游（新增，**首选**）
- `POST /openai/v1/chat/completions` → 仅用于关闭 reasoning 的简单调用（可后置）
- `POST /anthropic/v1/messages` → 现有路径；**改为按 model 选上游**（DeepSeek / 未来的 Claude）

### 5.2 上游配置（一次改，两种上游都支持）

```ts
// 每个上游就是一组参数，切换只改这里
interface Upstream {
  id: 'deepseek' | 'openai' | 'azure-openai'
  baseUrl: string                 // https://api.openai.com/v1
  pathTemplate: string            // /chat/completions
                                  // azure: /openai/deployments/{deployment}/chat/completions?api-version=…
  auth: (key: string) => Record<string, string>   // Bearer 或 api-key
  modelMap?: (model: string) => string            // azure: 模型名 → 部署名
}
```

### 5.3 环境变量（只放服务器）

```
OPENAI_API_KEY=...            # 你的 key，绝不出现在仓库与客户端
OPENAI_BASE_URL=              # 可选；留空用 https://api.openai.com/v1
```

### 5.4 首批模型（待你确认）

当前 GPT-6 系列（USD / 1M tokens，来源：第三方镜像 `vxcontrol/pentagi` 的 `models.yml`，**需在 OpenAI 后台核对后再落库**）：

| 模型 | 定位 | input | cached | output | 首批 |
|---|---|---|---|---|---|
| `gpt-6-sol` | **复杂编程与 agentic 工作流** | 2.0 | 0.2 | 10.0 | ✅ 主力 |
| `gpt-6-astra` | 最强，端到端推理/文档 | 10.0 | 1.0 | 50.0 | ✅ 旗舰 |
| `gpt-6-luna` | 高并发、轻任务 | 0.1 | 0.01 | 0.5 | ⛔ 暂不上架，见下 |

**Luna 暂不上架的理由（实测）**：它的单价看起来更低，但我们 96.5% 的输入 token 是缓存命中，而缓存价 DeepSeek 是 ¥0.02/1M、Luna 是 $0.01≈¥0.07/1M（3.5 倍）。用近 7 天真实 token 复算：

| 同一批真实 token（7 天） | 成本 |
|---|---|
| DeepSeek flash（含峰谷） | ¥204.31 |
| gpt-6-luna | **¥355.00（贵 74%）** |
| gpt-6-sol | ¥7,099.93（flash 的 34.8 倍） |

盈亏平衡点在缓存命中率 **≈85.7%**：高于它，DeepSeek 更便宜；低于它，Luna 更便宜。我们目前 96.5%，远离平衡点。Luna 的能力是否强于 4.1 Flash，需用我们自己的任务集实测后再定。

对比参照：`deepseek-flash` 输出 ¥4/1M（≈$0.55），`gpt-6-sol` 输出 $10/1M，**约 18 倍**；`gpt-6-luna` 与 flash 同量级。三档都上架：倍率统一 1.3×，**模型越贵只是用户付得越多，单位毛利率不变，绝对毛利更高**。

### 5.5 单请求输出上限（防透支的制度）

`standard.md` 第 43 条：闸门放行后**允许最后一笔透支**。透支上限 = 一笔请求的成本，而一笔请求的成本随模型单价放大：

| 模型 | 128K 输出的一笔成本 | 一个 0 余额新账号的最大敞口（¥10 免费 + 一笔透支） |
|---|---|---|
| `gpt-6-luna` | ¥0.45 | ≈ ¥10.5 |
| `gpt-6-sol` | ¥9.0 | ≈ ¥19 |
| `gpt-6-astra` | ¥44.8 | **≈ ¥52.8** |

**决定：不设输出上限**。负责人明确不接受"本来能多输出的被限制"，能力优先于敞口控制。因此上表的敞口（¥19 / ¥52.8）作为**已知并接受的风险**保留在本文，而不是用截断去消除。

若日后出现按账号薅免费额度的行为，可用的兜底是**限制新账号的行为**而不是所有人的输出长度，例如：新账号 24 小时内只能使用 Lite 档。这条留作预案，不在本阶段实现。

## 6. 客户端影响

**展示名**：产品里**不出现 OpenAI / ChatGPT**（商标与地域可用性都不适合直接写）。模型以能力档位命名，厂商与具体型号只写在文档和报表里：

| 展示名 | 实际模型 | 定位一句话 |
|---|---|---|
| `Mareo Max` | `gpt-6-astra` | 最强推理，最贵 |
| `Mareo Prime` | `gpt-6-sol` | 复杂编程与多步任务 |
| `Mareo Lite` | `deepseek-flash`（4.1 Flash） | 快、便宜，日常够用 |

这样换上游（Azure → 其他）也不用改名；且**不宣称自研**，设置里注明"由第三方模型服务商提供"。


- 模型目录由我们的 patch（`src/dsh-runtime.ts`）注入，因此**需要一次客户端发版**才能在选择器里看到 `gpt-5`
- 供应商设置页保持关闭（不开放 BYOK），三条路由全部由我们声明
- 目录里的每个模型**必须**在价目表里存在：加一条测试断言这一点，防止"选得到但没价"

## 7. 报表

- `cost-report` 增加**按 provider 分账**：请求数、真实成本、结算成本、毛利、免费额度成本
- 「钱包与毛利」分节按 provider 拆一行；口径不变（充值≠收入等）
- 汇率与价目表的版本写进报表页脚（"价目表 2026-10-19 · 汇率 7.3"），便于回溯

## 8. 上线顺序

1. 本文评审通过
2. 网关实现 + 单测（价目表、归一化、fail-closed）
3. 用**你的 key** 在预发环境跑一笔真实请求（1 次 `gpt-5`，确认成本与账单一致）
4. 客户端 patch 加模型 → 发版
5. 切生产；观察一周的 429/错误率/成本

## 9. 验证清单

- 单测：cache 三档恒等式、reasoning 计入 output、未定价模型拒绝、固定汇率与 ceil 取整
- 集成：假上游返回带 `usage` 的 SSE，断言 `usage` 行与结算金额
- 真实：一笔 `gpt-5` 请求 → OpenAI 后台用量 vs 我们 `actualMicro` 误差 < 1%
- 回归：DeepSeek 路由完全不受影响（现有 133 条测试全绿）

## 10. 风险

| 风险 | 处置 |
|---|---|
| 直连 OpenAI 的地域/条款风险，账号可能被封 | 生产切 Azure；网关保留 DeepSeek 作为可切换模型，封号时用户仍能用 |
| 速率限制（按我们账号的 tier） | 监控 429；必要时申请提升或走 Azure 配额 |
| 延迟与抖动（国内直连） | 用 Azure 日本东部/新加坡区域；界面上不承诺 SLA |
| 数据出境 | 隐私说明补一条；首次选择境外模型时提示一次 |
| 内容策略（拒答/过滤） | 前端把 OpenAI 的错误码翻译成可读提示 |
| 汇率误差 | 固定汇率、季度复核，偏差记入文档而非临时改价 |

## 11. 变更记录

| 日期 | 改动 | 原因 |
|---|---|---|
| 2026-10-19 | 初版：OpenAI 作为第二上游，Mareo 转售计价；上游参数化以便切 Azure | 负责人决定只做 B（转售），不做 BYOK |

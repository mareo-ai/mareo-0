/**
 * The one place money is calculated.
 *
 * Prices are the official DeepSeek CNY list price per 1M tokens, taken from
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing (read 2026-09-15):
 *
 *   deepseek-flash        cache hit ¥0.02 | cache miss ¥1   | output ¥4
 *   deepseek-v4-pro       cache hit ¥0.15 | cache miss ¥4.5 | output ¥13.5
 *
 * Off-peak prices are half of peak. Peak hours are Beijing time 09:00-12:00 and
 * 14:00-18:00, Monday to Friday, which is 01:00-04:00 and 06:00-10:00 UTC.
 *
 * `deepseek-v4-flash` is the legacy name for deepseek-flash: the model was
 * retired, requests are served by DeepSeek-V4.1-Flash and billed at Flash
 * prices, so both names map to the same row.
 *
 * OpenAI is priced in USD per 1M tokens and converted with a configurable rate
 * (`PRICING_FX_RATE`, default 7.0). It has no peak/off-peak tiers, but prompts
 * over 272K input tokens bill the whole request at 2x input and 1.5x output:
 *
 *   gpt-6.1-terra cached $0.05 | input $1  | output $5
 *   gpt-6-sol     cached $0.2  | input $2  | output $10
 *   gpt-6-astra   cached $1    | input $10 | output $50
 *
 * Byte counts must never be used to price anything — a streaming response is one
 * JSON frame per token, so response bytes overstate tokens by roughly 300x.
 */

export interface ModelPrice {
  /** CNY per 1M input tokens served from cache. */
  cacheHit: number
  /** CNY per 1M input tokens not served from cache. */
  cacheMiss: number
  /** CNY per 1M output tokens (reasoning tokens are billed here). */
  output: number
}

export type Provider = 'deepseek' | 'openai'

/** USD per 1M tokens, as the vendor lists them. */
const OPENAI_USD_PRICES: Record<string, ModelPrice> = {
  // Terra is half the price of Sol, and the existing 2x/1.5x long-context rule
  // reproduces the vendor's step exactly ($0.05 -> $0.10, $5 -> $7.50).
  'gpt-6.1-terra': { cacheHit: 0.05, cacheMiss: 1, output: 5 },
  'gpt-6-sol': { cacheHit: 0.2, cacheMiss: 2, output: 10 },
  'gpt-6-astra': { cacheHit: 1, cacheMiss: 10, output: 50 },
}

/** Above this many input tokens the vendor bills the whole request at a higher tier. */
export const LONG_CONTEXT_TOKENS = 272_000
const LONG_CONTEXT_INPUT_FACTOR = 2
const LONG_CONTEXT_OUTPUT_FACTOR = 1.5

/** Default rate used when the operator has not set one. */
const DEFAULT_FX_RATE = 7

/**
 * CNY per dollar. Configurable so the rate can move without a release; it only
 * ever affects requests priced after the change, because a request's cost is
 * computed and stored when the request finishes.
 */
export function fxRate(): number {
  const configured = Number(process.env.PRICING_FX_RATE)
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_FX_RATE
}

/** Which upstream serves a model, or undefined for a model we do not sell. */
export function providerForModel(model: string | null | undefined): Provider | undefined {
  if (model === null || model === undefined) return undefined
  if (model in OPENAI_USD_PRICES) return 'openai'
  if (model in OFF_PEAK_PRICES) return 'deepseek'
  return undefined
}

const OFF_PEAK_PRICES: Record<string, ModelPrice> = {
  'deepseek-flash': { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  'deepseek-v4-flash': { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  'deepseek-v4-flash-vision-exp': { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  'deepseek-v4-pro': { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
}

/** Peak windows in UTC: Beijing 09:00-12:00 and 14:00-18:00, Mon-Fri. */
export function isPeakHour(at: Date): boolean {
  const weekday = at.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const hour = at.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

/** Price for a model at a moment in CNY, or undefined for a model we have no price for. */
export function priceFor(model: string | null | undefined, at: Date): ModelPrice | undefined {
  if (model === null || model === undefined) return undefined
  const usd = OPENAI_USD_PRICES[model]
  if (usd !== undefined) {
    const rate = fxRate()
    return { cacheHit: usd.cacheHit * rate, cacheMiss: usd.cacheMiss * rate, output: usd.output * rate }
  }
  const base = OFF_PEAK_PRICES[model]
  if (base === undefined) return undefined
  if (!isPeakHour(at)) return base
  return { cacheHit: base.cacheHit * 2, cacheMiss: base.cacheMiss * 2, output: base.output * 2 }
}

export interface TokenUsage {
  /** Prompt tokens, i.e. cacheHit + cacheMiss. */
  inputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  outputTokens: number
  reasoningTokens: number
}

/** CNY for one request, or undefined when the model has no known price. */
export function costOf(usage: TokenUsage, model: string | null | undefined, at: Date): number | undefined {
  const price = priceFor(model, at)
  if (price === undefined) return undefined
  // A prompt above the long-context threshold reprices the whole request, not
  // just the excess: that is how the vendor bills it, so it is how we bill it.
  const longContext = providerForModel(model) === 'openai' && usage.inputTokens > LONG_CONTEXT_TOKENS
  const inputFactor = longContext ? LONG_CONTEXT_INPUT_FACTOR : 1
  const outputFactor = longContext ? LONG_CONTEXT_OUTPUT_FACTOR : 1
  return (
    (usage.cacheHitTokens / 1e6) * price.cacheHit * inputFactor +
    (usage.cacheMissTokens / 1e6) * price.cacheMiss * inputFactor +
    (usage.outputTokens / 1e6) * price.output * outputFactor
  )
}

/** Share of input tokens served from cache, or undefined without input tokens. */
export function cacheHitRate(usage: TokenUsage): number | undefined {
  if (usage.inputTokens <= 0) return undefined
  return usage.cacheHitTokens / usage.inputTokens
}

/**
 * What the user is charged for one request: the real cost plus Mareo's margin.
 * Both sides are kept so the ledger can show `margin = billable - actual`, and
 * the billable side rounds *up* to a whole micro-yuan so the split between the
 * free allowance and the wallet always adds up to what was charged.
 */
export function settleMicro(
  actualYuan: number,
  rate: number,
): { actualMicro: number; billableMicro: number; marginMicro: number } {
  const actualMicro = Math.round(actualYuan * 1_000_000)
  const billableMicro = Math.ceil(actualMicro * rate)
  return { actualMicro, billableMicro, marginMicro: billableMicro - actualMicro }
}

export function knownModels(): string[] {
  return [...Object.keys(OFF_PEAK_PRICES), ...Object.keys(OPENAI_USD_PRICES)]
}

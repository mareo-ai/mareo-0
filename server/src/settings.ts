/**
 * Operator-tunable numbers, read from the `settings` table on every use.
 *
 * Quota amounts are in micro-yuan (1 元 = 1,000,000), the same unit the cost
 * accounting uses, so a daily allowance and a measured request cost can be
 * compared without any rounding in between.
 *
 * A missing or unparseable value falls back to the default below: an operator
 * typo must never turn into a quota of zero (which would block everyone) or an
 * unlimited one (which would spend without a ceiling).
 */
import type { GatewayDatabase } from './db.js'
import { knownModels } from './pricing.js'

export type QuotaMode = 'off' | 'shadow' | 'enforce'

export interface Settings {
  /** off: no quota logic at all. shadow: measure only, never block. enforce: block. */
  quotaMode: QuotaMode
  /** Free allowance per Beijing day. */
  dailyFreeMicro: number
  /** Quota credited by one completed task. */
  rewardAmountMicro: number
  /** Ceiling on reward credits per Beijing day. */
  dailyRewardCapMicro: number
  /** Shortest believable completion, in seconds from task start. */
  rewardMinSeconds: number
  /** How many tasks one account may complete per Beijing day. */
  rewardDailyLimit: number
  /** Accounts that may see and use rewards; empty means nobody may. */
  rewardAccounts: string[]
  /** Which task provider issues rewards: `fake-ad` today, an ad network later. */
  rewardProvider: string
  /**
   * Markup applied to the real model cost when charging a user: 1.3 charges 30%
   * above cost. It is the fallback for every model without an override below.
   */
  settlementRate: number
  /** Per-model markup overrides, keyed by a name the price table knows. */
  modelRates: Map<string, number>
  /**
   * The daily free allowance shrinks as an account consumes it over its whole
   * life: heavy users fall to the floor quickly, occasional users keep the top
   * allowance for months. Sorted by `atMicro` ascending.
   */
  freeTiers: FreeTier[]
  /** Domains that only exist to receive one confirmation email and then vanish. */
  blockedEmailDomains: string[]
}

export interface FreeTier {
  /** Lifetime free-allowance consumption (micro-yuan) at which this tier applies. */
  atMicro: number
  /** The whole day's allowance once this tier applies. */
  allowanceMicro: number
}

/** 1.3 charges the user 30% above what the model call really cost us. */
export const DEFAULT_SETTLEMENT_RATE = 1.3

const SETTING_DEFAULTS: Record<string, string> = {
  'quota.mode': 'off',
  'quota.dailyFreeMicro': '10000000',
  // ¥30 -> ¥6, ¥60 -> ¥4, ¥100 -> ¥3. All micro-yuan: 1 元 = 1,000,000.
  'quota.freeTiers': '30000000:6000000,60000000:4000000,100000000:3000000',
  // Found in production: twelve accounts signed up through these and consumed
  // most of a month's free allowance. The rest are well-known services.
  'auth.blockedEmailDomains':
    'deepyinc.com,inctart.com,swagpapa.com,123mails.org,besttempmail.com,mowan666.com,' +
    'mailinator.com,guerrillamail.com,10minutemail.com,temp-mail.org,yopmail.com,sharklasers.com,' +
    'trashmail.com,fakeinbox.com,throwawaymail.com,getnada.com,maildrop.cc,dispostable.com',
  'quota.rewardAmountMicro': '1000000',
  'quota.dailyRewardCapMicro': '3000000',
  'quota.rewardMinSeconds': '15',
  'quota.rewardDailyLimit': '3',
  'quota.rewardAccounts': '',
  'quota.rewardProvider': 'fake-ad',
  'billing.settlementRate': String(DEFAULT_SETTLEMENT_RATE),
  'billing.modelRates': '',
}

/** What an operator may set, with the reason it exists. Used by the CLI's help. */
export const SETTING_KEYS: { key: string; meaning: string }[] = [
  { key: 'quota.mode', meaning: 'off | shadow | enforce（shadow 只统计不拦截）' },
  { key: 'quota.dailyFreeMicro', meaning: '每日免费额度（累计消耗未达任何档位时），微元（1 元 = 1000000）' },
  { key: 'quota.freeTiers', meaning: '按累计消耗分档：累计:额度,累计:额度，微元，逗号分隔，升序' },
  { key: 'quota.rewardAmountMicro', meaning: '单次任务入账额度，微元' },
  { key: 'quota.dailyRewardCapMicro', meaning: '每日任务入账上限，微元' },
  { key: 'quota.rewardMinSeconds', meaning: '任务最短完成时长（秒）' },
  { key: 'quota.rewardDailyLimit', meaning: '每日任务次数上限' },
  { key: 'quota.rewardAccounts', meaning: '可用奖励的账号 id，逗号分隔；空=无人可用' },
  { key: 'quota.rewardProvider', meaning: '任务来源：fake-ad（模拟）或将来接入的真实平台' },
  { key: 'billing.settlementRate', meaning: '默认销售倍率（1.3 = 按真实成本的 1.3 倍结算）' },
  { key: 'billing.modelRates', meaning: '按模型覆盖倍率，格式 模型名:倍率，逗号分隔；空=全部用默认倍率' },
  { key: 'auth.blockedEmailDomains', meaning: '禁止注册的一次性邮箱域名，逗号分隔；子域名同样拦截' },
]

export function readRawSettings(db: GatewayDatabase): Map<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  return new Map(rows.map((row) => [row.key, row.value]))
}

function wholeNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) return fallback
  return value
}

/** A markup rate: a positive decimal. Zero or nonsense falls back, never to free usage. */
function positiveRate(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return value
}

/**
 * `模型名:倍率` pairs. A pair naming a model the price table does not know is
 * dropped: keeping it would be dead configuration, and applying it to the
 * default rate instead would be a price change nobody can see.
 */
export function parseModelRates(raw: string | undefined): Map<string, number> {
  const rates = new Map<string, number>()
  const known = new Set(knownModels())
  for (const entry of (raw ?? '').split(',')) {
    const [model, rate] = entry.split(':').map((part) => part.trim())
    if (model === undefined || rate === undefined || !known.has(model)) continue
    const value = positiveRate(rate, -1)
    if (value <= 0) continue
    rates.set(model, value)
  }
  return rates
}

/**
 * Parses `累计:额度,累计:额度` into ascending tiers. A malformed entry is dropped
 * rather than guessed at, and `validateSetting` refuses to store one at all, so
 * an operator cannot silently shift the allowance of every account.
 */
export function parseFreeTiers(raw: string | undefined): FreeTier[] {
  const tiers: FreeTier[] = []
  for (const entry of (raw ?? '').split(',')) {
    const [at, allowance] = entry.split(':').map((part) => part.trim())
    if (at === undefined || allowance === undefined) continue
    const atMicro = Number(at)
    const allowanceMicro = Number(allowance)
    if (!Number.isInteger(atMicro) || atMicro <= 0) continue
    if (!Number.isInteger(allowanceMicro) || allowanceMicro < 0) continue
    tiers.push({ atMicro, allowanceMicro })
  }
  return tiers.sort((left, right) => left.atMicro - right.atMicro)
}

export function readSettings(db: GatewayDatabase): Settings {
  const stored = readRawSettings(db)
  const value = (key: string): string | undefined => stored.get(key) ?? SETTING_DEFAULTS[key]
  const mode = value('quota.mode')
  return {
    quotaMode: mode === 'shadow' || mode === 'enforce' ? mode : 'off',
    dailyFreeMicro: wholeNumber(value('quota.dailyFreeMicro'), 10_000_000),
    rewardAmountMicro: wholeNumber(value('quota.rewardAmountMicro'), 1_000_000),
    dailyRewardCapMicro: wholeNumber(value('quota.dailyRewardCapMicro'), 3_000_000),
    rewardMinSeconds: wholeNumber(value('quota.rewardMinSeconds'), 15),
    rewardDailyLimit: wholeNumber(value('quota.rewardDailyLimit'), 3),
    rewardAccounts: (value('quota.rewardAccounts') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
    rewardProvider: (value('quota.rewardProvider') ?? 'fake-ad').trim() || 'fake-ad',
    settlementRate: positiveRate(value('billing.settlementRate'), DEFAULT_SETTLEMENT_RATE),
    modelRates: parseModelRates(value('billing.modelRates')),
    freeTiers: parseFreeTiers(value('quota.freeTiers')),
    blockedEmailDomains: (value('auth.blockedEmailDomains') ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== ''),
  }
}

/** The markup for one model: its own rate when configured, else the default. */
export function settlementRateFor(settings: Settings, model: string | null | undefined): number {
  if (model === null || model === undefined) return settings.settlementRate
  return settings.modelRates.get(model) ?? settings.settlementRate
}

/** Rejects an unknown key or an unusable value instead of storing it silently. */
function validateSetting(key: string, raw: string): string {
  if (!(key in SETTING_DEFAULTS)) {
    throw new Error(`未知配置项 ${key}；可用：${Object.keys(SETTING_DEFAULTS).join(', ')}`)
  }
  const value = raw.trim()
  if (key === 'quota.mode') {
    if (value !== 'off' && value !== 'shadow' && value !== 'enforce') {
      throw new Error('quota.mode 只能是 off、shadow 或 enforce')
    }
  } else if (key === 'quota.rewardAccounts') {
    const accounts = value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
    for (const account of accounts) {
      if (!/^[\w-]{1,64}$/.test(account)) throw new Error(`账号 id 格式不对：${account}`)
    }
  } else if (key === 'quota.rewardProvider') {
    if (!/^[\w-]{1,32}$/.test(value)) throw new Error(`任务来源标识格式不对：${raw}`)
  } else if (key === 'billing.settlementRate') {
    if (positiveRate(value, -1) <= 0) throw new Error(`${key} 需要大于 0 的数，收到 ${raw}`)
  } else if (key === 'auth.blockedEmailDomains') {
    for (const domain of value.split(',').map((part) => part.trim()).filter((part) => part !== '')) {
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) throw new Error(`域名格式不对：${domain}`)
    }
  } else if (key === 'quota.freeTiers') {
    let previous = 0
    for (const entry of value.split(',').map((part) => part.trim()).filter((part) => part !== '')) {
      const [at, allowance] = entry.split(':').map((part) => part.trim())
      const atMicro = Number(at)
      const allowanceMicro = Number(allowance)
      if (!Number.isInteger(atMicro) || atMicro <= 0) throw new Error(`${entry} 的累计阈值需要正整数（微元）`)
      if (!Number.isInteger(allowanceMicro) || allowanceMicro < 0) throw new Error(`${entry} 的额度需要非负整数（微元）`)
      if (atMicro <= previous) throw new Error('档位阈值必须严格递增')
      previous = atMicro
    }
  } else if (key === 'billing.modelRates') {
    const known = knownModels()
    for (const entry of value.split(',').map((part) => part.trim()).filter((part) => part !== '')) {
      const [model, rate] = entry.split(':').map((part) => part.trim())
      if (model === undefined || rate === undefined) throw new Error(`格式应为 模型名:倍率，收到 ${entry}`)
      if (!known.includes(model)) throw new Error(`未知模型 ${model}；可用：${known.join(', ')}`)
      if (positiveRate(rate, -1) <= 0) throw new Error(`${entry} 的倍率需要大于 0`)
    }
  } else if (wholeNumber(value, -1) < 0) {
    throw new Error(`${key} 需要非负整数，收到 ${raw}`)
  }
  return value
}

export function writeSetting(db: GatewayDatabase, key: string, raw: string): void {
  const value = validateSetting(key, raw)
  db.prepare(
    'INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt',
  ).run(key, value, new Date().toISOString())
}

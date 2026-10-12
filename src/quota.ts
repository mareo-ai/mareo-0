/**
 * The gateway's quota meter, fetched in the main process (which holds the
 * token) and handed to the UI as plain numbers.
 *
 * The user sees money, in yuan: today's free allowance and the Mareo Wallet
 * behind it. Token counts, model prices and the settlement rate never leave the
 * gateway — the client is given the two buckets it has to draw, and nothing
 * else.
 */
export interface QuotaMeter {
  limitMicro: number
  spentMicro: number
  remainingMicro: number
  usedPercent: number
  exhausted: boolean
  /** Next 00:00 Beijing, when the allowance resets. */
  resetAt: string
  /** False when the gateway is not running a quota, or not for this account. */
  visible: boolean
}

export interface QuotaSnapshot {
  /** Kept for the older shape: the free allowance, as the meter used to show it. */
  quota: QuotaMeter
  /** Today's free allowance, which refills at 00:00 Beijing. */
  free: { limitMicro: number; usedMicro: number; remainingMicro: number; resetAt: string }
  /** The wallet, which never expires and can be negative after an overdraft. */
  wallet: { balanceMicro: number }
  /** Free remaining plus wallet: what the user could still spend today. */
  total: { remainingMicro: number }
}

const REQUEST_TIMEOUT_MS = 5_000

export class QuotaClient {
  private cached: { at: number; value: QuotaSnapshot | null } | undefined

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** One fetch per `maxAgeMs`: several UI surfaces ask, the gateway is asked once. */
  async load(maxAgeMs = 10_000): Promise<QuotaSnapshot | null> {
    const now = Date.now()
    if (this.cached !== undefined && now - this.cached.at < maxAgeMs) return this.cached.value
    const value = await this.get('/quota')
    this.cached = { at: now, value }
    return value
  }

  private async get(path: string): Promise<QuotaSnapshot | null> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      })
      if (!response.ok) return null
      return readSnapshot(await response.json())
    } catch {
      return null
    }
  }
}

/** Anything the UI will render is checked first; the gateway is ours but the shape still matters. */
export function readSnapshot(raw: unknown): QuotaSnapshot | null {
  if (raw === null || typeof raw !== 'object') return null
  const body = raw as Record<string, unknown>
  const quota = numbersOf(body.quota, ['limitMicro', 'spentMicro', 'remainingMicro', 'usedPercent'])
  const free = numbersOf(body.free, ['limitMicro', 'usedMicro', 'remainingMicro'])
  const wallet = numbersOf(body.wallet, ['balanceMicro'])
  const total = numbersOf(body.total, ['remainingMicro'])
  if (quota === undefined || free === undefined || wallet === undefined || total === undefined) return null
  const meter = body.quota as Record<string, unknown>
  const freeBucket = body.free as Record<string, unknown>
  if (typeof meter.exhausted !== 'boolean' || typeof meter.visible !== 'boolean') return null
  if (typeof meter.resetAt !== 'string' || typeof freeBucket.resetAt !== 'string') return null
  return {
    quota: {
      limitMicro: quota.limitMicro,
      spentMicro: quota.spentMicro,
      remainingMicro: quota.remainingMicro,
      usedPercent: Math.min(100, Math.max(0, quota.usedPercent)),
      exhausted: meter.exhausted,
      resetAt: meter.resetAt,
      visible: meter.visible,
    },
    free: {
      limitMicro: free.limitMicro,
      usedMicro: free.usedMicro,
      remainingMicro: free.remainingMicro,
      resetAt: freeBucket.resetAt,
    },
    wallet: { balanceMicro: wallet.balanceMicro },
    total: { remainingMicro: total.remainingMicro },
  }
}

/** The named fields as finite numbers, or undefined when any of them is unusable. */
function numbersOf(source: unknown, fields: readonly string[]): Record<string, number> | undefined {
  if (source === null || typeof source !== 'object') return undefined
  const record = source as Record<string, unknown>
  const values: Record<string, number> = {}
  for (const field of fields) {
    const value = record[field]
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    values[field] = value
  }
  return values
}

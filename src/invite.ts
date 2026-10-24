/**
 * The account's invite code, fetched in the main process where the token lives.
 *
 * The renderer only ever sees the code and three counts. Nothing here decides
 * whether a reward is owed — the gateway pays it, and pays it long after the
 * invitation, when the invited account has actually been used.
 */
export interface InviteSummary {
  /** The code to share, e.g. `ABCD2345`. */
  code: string
  /** Rewards this account has already received. */
  granted: number
  /** Rewards it can still receive. */
  remaining: number
  /** Total credit earned from invites, in micro-yuan. */
  earnedMicro: number
  /** What one reward is worth, in micro-yuan. */
  rewardMicro: number
}

const REQUEST_TIMEOUT_MS = 5_000

export class InviteClient {
  private cached: { at: number; value: InviteSummary | null } | undefined

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Cached for a minute: a code does not change, only the counts do. */
  async load(maxAgeMs = 60_000): Promise<InviteSummary | null> {
    const now = Date.now()
    if (this.cached !== undefined && now - this.cached.at < maxAgeMs) return this.cached.value
    let value: InviteSummary | null = null
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/invite`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      })
      if (response.ok) value = readInvite(await response.json())
    } catch {
      value = null
    }
    this.cached = { at: now, value }
    return value
  }
}

/** Anything the UI renders is checked first; the gateway is ours but so is the shape. */
export function readInvite(raw: unknown): InviteSummary | null {
  if (raw === null || typeof raw !== 'object') return null
  const body = raw as Record<string, unknown>
  const code = typeof body.code === 'string' ? body.code.trim() : ''
  if (code === '') return null
  const granted = wholeNumber(body.granted)
  const remaining = wholeNumber(body.remaining)
  const earnedMicro = wholeNumber(body.earnedMicro)
  const rewardMicro = wholeNumber(body.rewardMicro)
  if (granted === undefined || remaining === undefined || earnedMicro === undefined) return null
  if (rewardMicro === undefined) return null
  return { code, granted, remaining, earnedMicro, rewardMicro }
}

function wholeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

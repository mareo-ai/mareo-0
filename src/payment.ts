/**
 * Recharge, from the client's side: what may be bought, starting an order, and
 * following it until the gateway says the money arrived.
 *
 * It lives in the main process for the same reason the quota meter does — the
 * account token never reaches the renderer — and it draws the same line on what
 * crosses into the UI: amounts in micro-yuan, the channel that is available, and
 * the QR code as the SVG the gateway rendered. The renderer never computes a
 * price and never talks to a payment platform.
 */
export type RechargeChannel = 'wechat' | 'alipay'

export interface RechargeConfig {
  /** False when the gateway has no live channel: the entry stays hidden. */
  enabled: boolean
  tiers: { tier: string; amountMicro: number }[]
  channels: RechargeChannel[]
}

export type RechargeStatus = 'pending' | 'paid' | 'failed' | 'cancelled' | 'refunded'

export interface RechargeOrder {
  orderId: string
  status: RechargeStatus
  channel: RechargeChannel
  amountMicro: number
  createdAt: string
  expiresAt: string
  paidAt: string | null
  /** Only on a freshly created order: what the user scans. */
  qrSvg?: string
}

export type RechargeStart =
  | { ok: true; order: RechargeOrder }
  | { ok: false; error: string }

const REQUEST_TIMEOUT_MS = 10_000
const REQUEST_ATTEMPTS = 2
const CHANNELS: readonly RechargeChannel[] = ['wechat', 'alipay']
const STATUSES: readonly RechargeStatus[] = ['pending', 'paid', 'failed', 'cancelled', 'refunded']

export class PaymentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async config(): Promise<RechargeConfig | null> {
    return this.read('/payment/config', (body) => readConfig(body))
  }

  async createOrder(tier: string, channel: RechargeChannel): Promise<RechargeStart> {
    for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/payment/orders`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ tier, channel }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          redirect: 'error',
        })
        const body = await response.json().catch(() => undefined)
        if (!response.ok) return { ok: false, error: errorOf(body, response.status) }
        const order = readOrder(body)
        if (order === undefined) return { ok: false, error: '网关返回的订单无法识别' }
        return { ok: true, order }
      } catch (error) {
        // One retry covers a transient failure; a second means it is not transient.
        if (attempt + 1 === REQUEST_ATTEMPTS) return { ok: false, error: messageOf(error) }
      }
    }
    return { ok: false, error: '无法发起支付' }
  }

  async order(orderId: string): Promise<RechargeOrder | null> {
    return this.read(`/payment/orders/${encodeURIComponent(orderId)}`, (body) => readOrder(body))
  }

  async orders(limit = 5): Promise<RechargeOrder[]> {
    const body = await this.read(`/payment/orders?limit=${limit}`, (value) => {
      const list = (value as { orders?: unknown }).orders
      if (!Array.isArray(list)) return undefined
      const orders = list.map((entry) => readOrder(entry)).filter((entry): entry is RechargeOrder => entry !== undefined)
      return orders.length === list.length ? orders : undefined
    })
    return body ?? []
  }

  private async read<T>(path: string, parse: (body: unknown) => T | undefined): Promise<T | null> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      })
      if (!response.ok) return null
      return parse(await response.json()) ?? null
    } catch {
      return null
    }
  }
}

export function readConfig(raw: unknown): RechargeConfig | null {
  if (raw === null || typeof raw !== 'object') return null
  const body = raw as Record<string, unknown>
  if (typeof body.enabled !== 'boolean' || !Array.isArray(body.tiers) || !Array.isArray(body.channels)) return null
  const tiers: RechargeConfig['tiers'] = []
  for (const entry of body.tiers) {
    if (entry === null || typeof entry !== 'object') continue
    const { tier, amountMicro } = entry as Record<string, unknown>
    if (typeof tier !== 'string' || typeof amountMicro !== 'number' || !Number.isFinite(amountMicro) || amountMicro <= 0) continue
    tiers.push({ tier, amountMicro })
  }
  if (tiers.length === 0) return null
  const channels = body.channels.filter((channel): channel is RechargeChannel =>
    CHANNELS.includes(channel as RechargeChannel),
  )
  return { enabled: body.enabled, tiers, channels }
}

export function readOrder(raw: unknown): RechargeOrder | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const body = raw as Record<string, unknown>
  const status = body.status
  if (typeof body.orderId !== 'string' || body.orderId === '') return undefined
  if (typeof status !== 'string' || !STATUSES.includes(status as RechargeStatus)) return undefined
  if (!CHANNELS.includes(body.channel as RechargeChannel)) return undefined
  if (typeof body.amountMicro !== 'number' || !Number.isFinite(body.amountMicro)) return undefined
  if (typeof body.createdAt !== 'string' || typeof body.expiresAt !== 'string') return undefined
  const order: RechargeOrder = {
    orderId: body.orderId,
    status: status as RechargeStatus,
    channel: body.channel as RechargeChannel,
    amountMicro: body.amountMicro,
    createdAt: body.createdAt,
    expiresAt: body.expiresAt,
    paidAt: typeof body.paidAt === 'string' ? body.paidAt : null,
  }
  if (typeof body.qrSvg === 'string' && body.qrSvg.startsWith('<svg')) order.qrSvg = body.qrSvg
  return order
}

/** The gateway's own wording when it has one; something the user can read otherwise. */
function errorOf(body: unknown, status: number): string {
  const error = body !== null && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  switch (error) {
    case 'too-many-pending':
      return '还有没完成的充值单，请先完成或稍等它过期'
    case 'daily-limit':
      return '今天的充值额度已达上限，明天再试'
    case 'payment-unavailable':
      return '支付暂未开放'
    case 'invalid-tier':
    case 'invalid-channel':
      return '这个充值选项暂不可用'
    default:
      return status >= 500 ? '暂时无法发起支付，请稍后重试' : '无法发起支付'
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.name === 'TimeoutError' ? '请求超时，请稍后重试' : '网络异常，请稍后重试'
}

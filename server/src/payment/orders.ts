/**
 * Recharge orders: what a top-up is, and the single door through which a
 * payment becomes wallet credit.
 *
 * Everything that reports a payment — the platform's callback, our own query to
 * the platform, an operator's manual fix — ends up in `confirmPayment`. That is
 * deliberate: the state machine and the idempotency live in one place, so no
 * caller can credit twice, and the whole money movement happens in one
 * transaction with `grantCredit`.
 */
import { readFileSync } from 'node:fs'
import QRCode from 'qrcode'
import { startOfDay } from '../clock.js'
import type { GatewayDatabase } from '../db.js'
import { grantCredit, walletTotals } from '../wallet.js'
import {
  MAX_DAY_MICRO,
  MAX_PENDING_ORDERS,
  ORDER_TTL_MS,
  microToFen,
  newOrderId,
  tierAmountMicro,
} from './amount.js'
import { alipayProvider, type AlipayConfig } from './alipay.js'
import { fakeProvider } from './fake.js'
import { PAYMENT_CHANNELS, isPaymentChannel, type PaymentChannel, type PaymentOrderRow, type PaymentProvider } from './provider.js'

export interface PaymentEnv {
  /** `off` hides the entry point; `fake` is for tests; `live` takes real money. */
  mode: 'off' | 'fake' | 'live'
  publicBaseUrl?: string
  fakeToken?: string
  alipay?: AlipayConfig
}

export function paymentEnvFromProcess(env: NodeJS.ProcessEnv = process.env): PaymentEnv {
  const mode = env.PAYMENT_MODE === 'live' ? 'live' : env.PAYMENT_MODE === 'fake' ? 'fake' : 'off'
  return {
    mode,
    publicBaseUrl: env.PAYMENT_PUBLIC_BASE_URL,
    fakeToken: env.PAYMENT_FAKE_TOKEN,
    alipay: readAlipayConfig(env),
  }
}

function readAlipayConfig(env: NodeJS.ProcessEnv): AlipayConfig | undefined {
  const appId = env.ALIPAY_APP_ID
  const privateKey = readKey(env.ALIPAY_PRIVATE_KEY_PATH, env.ALIPAY_PRIVATE_KEY)
  const publicKey = readKey(env.ALIPAY_PUBLIC_KEY_PATH, env.ALIPAY_PUBLIC_KEY)
  if (!appId || !privateKey || !publicKey) return undefined
  return { appId, privateKey, publicKey, gateway: env.ALIPAY_GATEWAY }
}

function readKey(path: string | undefined, inline: string | undefined): string | undefined {
  if (path !== undefined && path !== '') {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  }
  return inline !== undefined && inline !== '' ? inline : undefined
}

/**
 * The implementation behind a channel, or undefined when it is not usable. A
 * live channel without a public address to receive notifications on is not
 * usable — the platform would have nowhere to tell us that money arrived —
 * so that check lives here with the rest of the configuration.
 */
export function providerFor(env: PaymentEnv, channel: PaymentChannel): PaymentProvider | undefined {
  if (env.mode === 'fake' && env.fakeToken !== undefined && env.fakeToken !== '') return fakeProvider(channel, env.fakeToken)
  if (env.mode === 'live' && channel === 'alipay' && env.alipay !== undefined && notifyUrlFor(env, channel) !== undefined) {
    return alipayProvider(env.alipay)
  }
  return undefined
}

/** Whether users may see a top-up entry at all: only a live channel counts. */
export function paymentsEnabled(env: PaymentEnv): boolean {
  return env.mode === 'live' && PAYMENT_CHANNELS.some((channel) => providerFor(env, channel) !== undefined)
}

export function notifyUrlFor(env: PaymentEnv, channel: PaymentChannel): string | undefined {
  return env.publicBaseUrl === undefined ? undefined : `${env.publicBaseUrl.replace(/\/+$/, '')}/payment/notify/${channel}`
}

export function paymentOrder(db: GatewayDatabase, orderId: string): PaymentOrderRow | undefined {
  return db.prepare('SELECT * FROM payment_orders WHERE orderId = ?').get(orderId) as unknown as PaymentOrderRow | undefined
}

export function recentPaymentOrders(db: GatewayDatabase, accountId: string, limit = 20): PaymentOrderRow[] {
  return db
    .prepare('SELECT * FROM payment_orders WHERE userId = ? ORDER BY createdAt DESC LIMIT ?')
    .all(accountId, Math.min(Math.max(limit, 1), 50)) as unknown as PaymentOrderRow[]
}

export function pendingOrderCount(db: GatewayDatabase, accountId: string, now: Date): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM payment_orders WHERE userId = ? AND status = 'pending' AND expiresAt > ?")
    .get(accountId, now.toISOString()) as { n: number }
  return row.n
}

/** Credit this account bought today, from the ledger — the money's own record. */
export function dayRechargeMicro(db: GatewayDatabase, accountId: string, now = new Date()): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amountMicro), 0) AS total FROM wallet_ledger
       WHERE userId = ? AND type = 'credit' AND source = 'purchase' AND createdAt >= ?`,
    )
    .get(accountId, startOfDay(now)) as { total: number }
  return row.total
}

export type CreateOrderResult =
  | { ok: true; order: PaymentOrderRow; qrSvg: string }
  | { ok: false; status: number; error: string; message?: string }

export async function createPaymentOrder(
  db: GatewayDatabase,
  options: { accountId: string; tier: unknown; channel: unknown; env: PaymentEnv; now?: Date },
): Promise<CreateOrderResult> {
  const now = options.now ?? new Date()
  const amountMicro = tierAmountMicro(options.tier)
  if (amountMicro === undefined) return { ok: false, status: 400, error: 'invalid-tier' }
  if (!isPaymentChannel(options.channel)) return { ok: false, status: 400, error: 'invalid-channel' }
  const channel = options.channel
  const provider = providerFor(options.env, channel)
  if (provider === undefined) return { ok: false, status: 503, error: 'payment-unavailable' }
  if (dayRechargeMicro(db, options.accountId, now) + amountMicro > MAX_DAY_MICRO) {
    return { ok: false, status: 429, error: 'daily-limit' }
  }
  if (pendingOrderCount(db, options.accountId, now) >= MAX_PENDING_ORDERS) {
    return { ok: false, status: 429, error: 'too-many-pending' }
  }

  const order: PaymentOrderRow = {
    orderId: newOrderId(now),
    userId: options.accountId,
    provider: channel,
    amountMicro,
    amountFen: microToFen(amountMicro),
    status: 'pending',
    transactionId: null,
    codeUrl: null,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ORDER_TTL_MS).toISOString(),
    paidAt: null,
    refundedAt: null,
    rawCallback: null,
    updatedAt: now.toISOString(),
  }

  // Ask the platform first: a row that exists without a QR code would count
  // against the pending limit while being useless to the user.
  let codeUrl: string
  try {
    codeUrl = (await provider.createOrder(order, notifyUrlFor(options.env, channel) ?? '')).codeUrl
  } catch (error) {
    return { ok: false, status: 502, error: 'provider-error', message: error instanceof Error ? error.message : String(error) }
  }
  order.codeUrl = codeUrl
  db.prepare(
    `INSERT INTO payment_orders
       (orderId, userId, provider, amountMicro, amountFen, status, transactionId, codeUrl, createdAt, expiresAt, paidAt, refundedAt, rawCallback, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, ?)`,
  ).run(
    order.orderId,
    order.userId,
    order.provider,
    order.amountMicro,
    order.amountFen,
    order.status,
    order.codeUrl,
    order.createdAt,
    order.expiresAt,
    order.updatedAt,
  )
  // The QR itself is generated here so the client needs no library of its own.
  return { ok: true, order, qrSvg: await QRCode.toString(codeUrl, { type: 'svg', margin: 1, width: 240 }) }
}

export interface ConfirmDetails {
  transactionId: string
  amountFen: number
  rawCallback?: string
  now?: Date
}

export type ConfirmResult =
  | { ok: true; duplicated: boolean; order: PaymentOrderRow }
  | { ok: false; error: 'unknown-order' | 'amount-mismatch' | 'transaction-reused' }

/**
 * The only place a payment becomes credit. A callback that arrives twice, a
 * query that finds what the callback already told us, an operator fixing a
 * missed notification — all of them land here, and the second one through is a
 * no-op.
 */
export function confirmPayment(db: GatewayDatabase, orderId: string, details: ConfirmDetails): ConfirmResult {
  const now = details.now ?? new Date()
  const existing = paymentOrder(db, orderId)
  if (existing === undefined) return { ok: false, error: 'unknown-order' }
  if (existing.amountFen !== details.amountFen) return { ok: false, error: 'amount-mismatch' }

  db.exec('BEGIN')
  try {
    // `cancelled` and `failed` are included on purpose: an expired QR code can
    // still be paid, and money that arrived has to be honoured. `paid` and
    // `refunded` are not, which is what makes a repeated callback harmless.
    const updated = db
      .prepare(
        `UPDATE payment_orders
            SET status = 'paid', transactionId = ?, paidAt = ?, rawCallback = ?, updatedAt = ?
          WHERE orderId = ? AND status IN ('pending', 'cancelled', 'failed')`,
      )
      .run(details.transactionId, now.toISOString(), details.rawCallback ?? null, now.toISOString(), orderId)
    if (updated.changes === 0) {
      db.exec('COMMIT')
      return { ok: true, duplicated: true, order: paymentOrder(db, orderId) ?? existing }
    }
    grantCredit(db, {
      accountId: existing.userId,
      amountMicro: existing.amountMicro,
      source: 'purchase',
      externalRef: orderId,
      channel: existing.provider,
      now,
    })
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    // The unique index on (provider, transactionId) refuses a payment id that is
    // already attached to another order; that is a replay, not a new payment.
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('idx_payment_orders_txn') || message.includes('UNIQUE')) {
      return { ok: false, error: 'transaction-reused' }
    }
    throw error
  }
  return { ok: true, duplicated: false, order: paymentOrder(db, orderId) ?? existing }
}

/** QRs that were never paid stop being payable; money already sent is still honoured. */
export function expirePendingOrders(db: GatewayDatabase, now = new Date()): number {
  const result = db
    .prepare("UPDATE payment_orders SET status = 'cancelled', updatedAt = ? WHERE status = 'pending' AND expiresAt < ?")
    .run(now.toISOString(), now.toISOString())
  return Number(result.changes)
}

/**
 * Asking the platform is rate limited per order in this process: the client
 * polls every couple of seconds, the platform does not need to hear about it.
 */
const lastQueryAt = new Map<string, number>()
const QUERY_INTERVAL_MS = 5_000
/** How long an unpaid order waits before we stop trusting the callback alone. */
export const QUERY_AFTER_MS = 10_000

export function shouldQuery(order: PaymentOrderRow, now = new Date()): boolean {
  if (order.status !== 'pending') return false
  if (now.getTime() - Date.parse(order.createdAt) < QUERY_AFTER_MS) return false
  const last = lastQueryAt.get(order.orderId)
  if (last !== undefined && now.getTime() - last < QUERY_INTERVAL_MS) return false
  lastQueryAt.set(order.orderId, now.getTime())
  return true
}

/** Narrows the query throttle map so a long-running process does not grow one. */
export function forgetQueryThrottle(): void {
  lastQueryAt.clear()
}

/** Total credited from purchases, for the operator report. */
export function purchaseTotals(db: GatewayDatabase, fromIso?: string, toIso?: string): { micro: number; count: number } {
  const totals = walletTotals(db, fromIso, toIso)
  return { micro: totals.creditedBySource.get('purchase') ?? 0, count: totals.creditedCountBySource.get('purchase') ?? 0 }
}

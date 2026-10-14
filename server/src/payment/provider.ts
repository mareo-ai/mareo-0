/**
 * What a payment channel has to be able to do. Both platforms differ in every
 * detail — signing, encoding, how they answer — but the order lifecycle only
 * needs these three answers: start an order, tell me whether this callback is
 * really a payment, and ask the platform directly when no callback arrived.
 *
 * `confirmPayment` (see `orders.ts`) is the only place that turns any of these
 * into money in a wallet, so a new channel cannot invent its own accounting.
 */
import type { IncomingHttpHeaders } from 'node:http'

export type PaymentChannel = 'wechat' | 'alipay'

export const PAYMENT_CHANNELS: readonly PaymentChannel[] = ['wechat', 'alipay']

export function isPaymentChannel(value: unknown): value is PaymentChannel {
  return value === 'wechat' || value === 'alipay'
}

export interface PaymentOrderRow {
  orderId: string
  userId: string
  provider: PaymentChannel
  amountMicro: number
  amountFen: number
  status: PaymentStatus
  transactionId: string | null
  codeUrl: string | null
  createdAt: string
  expiresAt: string
  paidAt: string | null
  refundedAt: string | null
  rawCallback: string | null
  updatedAt: string
}

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'cancelled' | 'refunded'

/** What the platform said about a payment it is telling us about. */
export interface CallbackResult {
  orderId: string
  transactionId: string
  amountFen: number
  succeeded: boolean
}

/** What the platform says when we ask it ourselves. */
export interface QueryResult {
  status: 'pending' | 'paid' | 'closed' | 'failed'
  transactionId?: string
  amountFen?: number
}

export interface PaymentProvider {
  readonly channel: PaymentChannel
  /** Starts an order with the platform and returns what the QR code must show. */
  createOrder(order: PaymentOrderRow, notifyUrl: string): Promise<{ codeUrl: string }>
  /** Undefined means "not a genuine callback" — the caller must not credit it. */
  verifyCallback(headers: IncomingHttpHeaders, rawBody: Buffer): Promise<CallbackResult | undefined>
  queryOrder(order: PaymentOrderRow): Promise<QueryResult>
}

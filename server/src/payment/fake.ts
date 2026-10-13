/**
 * A payment channel that never moves money. It exists so the whole recharge
 * path — order, QR code, callback, idempotency, query fallback, expiry — can be
 * built and tested before a real merchant account is approved, and so the
 * WeChat half can be exercised while only Alipay is live.
 *
 * It is only ever reachable with `PAYMENT_MODE=fake`, and its callback is the
 * same route a real platform calls: the code under test is the production path,
 * not a special one.
 */
import { microToFen } from './amount.js'
import type { CallbackResult, PaymentChannel, PaymentOrderRow, PaymentProvider, QueryResult } from './provider.js'

export function fakeProvider(channel: PaymentChannel, token: string): PaymentProvider {
  return {
    channel,

    async createOrder(order: PaymentOrderRow): Promise<{ codeUrl: string }> {
      // A real, scannable QR code pointing at a scheme that resolves nowhere:
      // the client renders it exactly as it renders a real one.
      return { codeUrl: `mareo-fake://pay/${order.orderId}` }
    },

    async verifyCallback(headers, rawBody: Buffer): Promise<CallbackResult | undefined> {
      const presented = headers['x-mareo-fake-token']
      const secret = Array.isArray(presented) ? presented[0] : presented
      if (secret !== token) return undefined
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>
      } catch {
        return undefined
      }
      const orderId = parsed.orderId
      if (typeof orderId !== 'string' || orderId === '') return undefined
      return {
        orderId,
        transactionId: typeof parsed.transactionId === 'string' ? parsed.transactionId : `fake-${orderId}`,
        amountFen: typeof parsed.amountMicro === 'number' ? microToFen(parsed.amountMicro) : 0,
        succeeded: parsed.succeeded !== false,
      }
    },

    async queryOrder(): Promise<QueryResult> {
      // The fake channel never completes on its own: completion is an explicit
      // callback, which is what the tests drive.
      return { status: 'pending' }
    },
  }
}

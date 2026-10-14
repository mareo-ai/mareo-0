/**
 * Alipay, over its OpenAPI gateway: precreate (a QR code the user scans), the
 * asynchronous notify that says a payment really happened, and a query we can
 * run when no notify arrived.
 *
 * Two rules shape this file. Signing and verification are done with
 * `node:crypto` directly rather than through a third-party SDK, because this is
 * the code that decides whether money arrived and we would rather own it than
 * trust a dependency. And nothing here decides what a payment means: it reports
 * facts, and `confirmPayment` turns them into a wallet balance.
 *
 * `total_amount` is parsed as a string into whole fen. A float round trip here
 * would be the classic way to credit 0.29 for a 0.30 payment.
 */
import { createPrivateKey, createSign, createVerify } from 'node:crypto'
import { CHINA_OFFSET_MS } from '../clock.js'
import { microToYuan } from './amount.js'
import type { CallbackResult, PaymentOrderRow, PaymentProvider, QueryResult } from './provider.js'

export interface AlipayConfig {
  appId: string
  /** The application's private key, PEM or bare base64. */
  privateKey: string
  /** Alipay's public key from the open platform, PEM or bare base64. */
  publicKey: string
  gateway?: string
}

const DEFAULT_GATEWAY = 'https://openapi.alipay.com/gateway.do'
const REQUEST_TIMEOUT_MS = 10_000
/** What a payment looks like once it is final. */
const PAID_STATUSES = new Set(['TRADE_SUCCESS', 'TRADE_FINISHED'])

export function alipayProvider(config: AlipayConfig): PaymentProvider {
  const gateway = config.gateway ?? DEFAULT_GATEWAY
  const privateKey = normalizeKey(config.privateKey, 'RSA PRIVATE KEY')
  const publicKey = normalizeKey(config.publicKey, 'PUBLIC KEY')

  /** `k=v&…` over the non-empty parameters, sorted, `sign`/`sign_type` left out. */
  function signingContent(params: Record<string, string>): string {
    return Object.keys(params)
      .filter((key) => key !== 'sign' && key !== 'sign_type' && params[key] !== '' && params[key] !== undefined)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('&')
  }

  async function call(method: string, bizContent: Record<string, unknown>, notifyUrl?: string): Promise<Record<string, unknown>> {
    const params: Record<string, string> = {
      app_id: config.appId,
      method,
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: beijingTimestamp(),
      version: '1.0',
      biz_content: JSON.stringify(bizContent),
    }
    if (notifyUrl !== undefined) params.notify_url = notifyUrl
    params.sign = createSign('RSA-SHA256').update(signingContent(params), 'utf8').sign(privateKey, 'base64')

    const response = await fetch(gateway, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`支付宝网关返回 HTTP ${response.status}`)
    const body = (await response.json()) as Record<string, unknown>
    const node = body[`${method.replaceAll('.', '_')}_response`]
    if (node === null || typeof node !== 'object') throw new Error('支付宝网关返回了无法识别的响应')
    const result = node as Record<string, unknown>
    if (result.code !== '10000') {
      const detail = [result.sub_code, result.sub_msg, result.msg].filter((part) => typeof part === 'string').join(' / ')
      // ACQ.TRADE_NOT_EXIST is a normal answer to "has this order been paid yet".
      if (result.sub_code === 'ACQ.TRADE_NOT_EXIST') return { code: 'ACQ.TRADE_NOT_EXIST' }
      throw new Error(`支付宝 ${method} 失败：${detail || String(result.code)}`)
    }
    return result
  }

  return {
    channel: 'alipay',

    async createOrder(order: PaymentOrderRow, notifyUrl: string): Promise<{ codeUrl: string }> {
      const result = await call(
        'alipay.trade.precreate',
        { out_trade_no: order.orderId, total_amount: microToYuan(order.amountMicro), subject: 'Mareo 余额充值' },
        notifyUrl,
      )
      const codeUrl = result.qr_code
      if (typeof codeUrl !== 'string' || codeUrl === '') throw new Error('支付宝没有返回二维码内容')
      return { codeUrl }
    },

    async verifyCallback(_headers, rawBody: Buffer): Promise<CallbackResult | undefined> {
      const params = Object.fromEntries(new URLSearchParams(rawBody.toString('utf8')))
      const sign = params.sign
      if (typeof sign !== 'string' || sign === '') return undefined
      const verified = createVerify('RSA-SHA256').update(signingContent(params), 'utf8').verify(publicKey, sign, 'base64')
      if (!verified) return undefined

      const orderId = params.out_trade_no
      const transactionId = params.trade_no
      const amountFen = yuanToFen(params.total_amount ?? '')
      if (orderId === undefined || orderId === '' || transactionId === undefined || amountFen === undefined) return undefined
      return { orderId, transactionId, amountFen, succeeded: PAID_STATUSES.has(params.trade_status ?? '') }
    },

    async queryOrder(order: PaymentOrderRow): Promise<QueryResult> {
      const result = await call('alipay.trade.query', { out_trade_no: order.orderId })
      if (result.code === 'ACQ.TRADE_NOT_EXIST') return { status: 'pending' }
      const status = typeof result.trade_status === 'string' ? result.trade_status : ''
      const amountFen = yuanToFen(typeof result.total_amount === 'string' ? result.total_amount : '')
      if (PAID_STATUSES.has(status)) {
        return {
          status: 'paid',
          transactionId: typeof result.trade_no === 'string' ? result.trade_no : undefined,
          amountFen,
        }
      }
      if (status === 'TRADE_CLOSED') return { status: 'closed' }
      return { status: 'pending' }
    },
  }
}

/** Beijing time, the format every Alipay request wants. */
function beijingTimestamp(now = new Date()): string {
  const local = new Date(now.getTime() + CHINA_OFFSET_MS)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`
  )
}

/** Whole fen from a platform amount string, never through a float. */
export function yuanToFen(value: string): number | undefined {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (match === null) return undefined
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
}

/**
 * Accepts the PEM the open platform shows most of the time and the bare base64
 * it shows the rest of the time, and says what to do when neither parses —
 * a key format problem should not look like a signing bug.
 */
function normalizeKey(key: string, kind: 'RSA PRIVATE KEY' | 'PUBLIC KEY'): string {
  const trimmed = key.trim()
  const candidates = trimmed.includes('BEGIN')
    ? [trimmed]
    : [`-----BEGIN ${kind}-----\n${wrap(trimmed)}\n-----END ${kind}-----`]
  for (const candidate of candidates) {
    try {
      if (kind === 'RSA PRIVATE KEY') createPrivateKey(candidate)
      return candidate
    } catch {
      // Try the next shape.
    }
  }
  throw new Error(`支付宝密钥无法解析（${kind}）：请检查是否复制完整，或改用 PEM 格式`)
}

function wrap(base64: string): string {
  return base64.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').trim()
}

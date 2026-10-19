import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { generateTokenSecret, hashToken } from './auth.js'
import { findAccountEmail, renameAccount, revokeToken, findOrCreateAccountForIdentity, findTokenOwner, storeToken, type GatewayDatabase, type TokenOwner } from './db.js'
import { createAnonymousEventLimiter, parseEvents, recordEvents } from './events.js'
import { beginEmailCode, isValidEmail, normalizeEmail, verifyEmailCode } from './email-auth.js'
import { createEmailMailer, type Mailer } from './mailer.js'
import { proxyRequest, type ProxyConfig, type ProxyOutcome } from './proxy.js'
import { parseSessionTitleDetail, recordSessionTitle } from './session-titles.js'
import { parseSiteView, recordSiteView } from './site-views.js'
import { startOfDay } from './clock.js'
import { costOf, settleMicro } from './pricing.js'
import { recordUsage, countRequestsSince, type UsageBilling } from './usage.js'
import { readSponsoredAd, recordAdEvent } from './sponsored-ad.js'
import { readSettings, settlementRateFor, type Settings } from './settings.js'
import { creditState, type CreditState } from './quota.js'
import { chargeWallet } from './wallet.js'
import {
  confirmPayment,
  createPaymentOrder,
  paymentEnvFromProcess,
  paymentOrder,
  paymentsEnabled,
  providerFor,
  recentPaymentOrders,
  shouldQuery,
  type PaymentEnv,
} from './payment/orders.js'
import { RECHARGE_TIERS, tierAmountMicro } from './payment/amount.js'
import { PAYMENT_CHANNELS, isPaymentChannel } from './payment/provider.js'
import { completeRewardTask, rewardOfferFor, startRewardTask } from './rewards.js'

export interface GatewayOptions extends ProxyConfig {
  db: GatewayDatabase
  /** Per-user daily request cap; 0 disables the check. */
  dailyLimit: number
  sponsoredAdFile?: string
  /**
   * Requests in one day above which an account deserves a look. This only warns
   * (log line + the operations page); it never blocks, which is what keeps the
   * hard cap a runaway guard rather than a product quota. 0 disables it.
   */
  dailyWarnLimit?: number
  /** Verification-code delivery; defaults to SMTP from the environment. */
  mailer?: Mailer
  /** Anonymous-event rate limiter; defaults to a per-process limiter. */
  anonymousEventLimiter?: (address: string, now?: number) => boolean
  /** Recharge channels and credentials; defaults to what the environment says. */
  payments?: PaymentEnv
}

export function createGatewayServer(options: GatewayOptions) {
  const mailer = options.mailer ?? createEmailMailer()
  const gatewayOptions: GatewayOptions = {
    ...options,
    anonymousEventLimiter: options.anonymousEventLimiter ?? createAnonymousEventLimiter(),
    payments: options.payments ?? paymentEnvFromProcess(),
  }
  return createServer((request, response) => {
    handleRequest(gatewayOptions, request, response, mailer).catch((error) => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: messageFrom(error) })
      } else {
        response.destroy()
      }
    })
  })
}

async function handleRequest(
  options: GatewayOptions,
  request: IncomingMessage,
  response: ServerResponse,
  mailer: Mailer,
): Promise<void> {
  const pathname = new URL(request.url ?? '/', 'http://gateway.local').pathname

  if (request.method === 'GET' && pathname === '/health') {
    sendJson(response, 200, { ok: true })
    return
  }

  // Keep this namespace out of the catch-all model proxy and its daily quota.
  if (pathname === '/sponsored-ad' || pathname.startsWith('/sponsored-ad/')) {
    response.setHeader('cache-control', 'no-store')
    const owner = authenticate(request, options.db)
    if (!owner) {
      sendJson(response, 401, { error: 'invalid token' })
      return
    }
    if (pathname === '/sponsored-ad' && request.method === 'GET') {
      sendJson(response, 200, { ad: await readSponsoredAd(options.sponsoredAdFile ?? 'data/sponsored-ad.json') })
    } else if (pathname === '/sponsored-ad/events' && request.method === 'POST') {
      const body = await readJsonBody(request, 2048)
      const ad = await readSponsoredAd(options.sponsoredAdFile ?? 'data/sponsored-ad.json')
      const status = recordAdEvent(options.db, owner.userId, body, ad)
      sendJson(response, status, { ok: status === 200 })
    } else {
      sendJson(response, 404, { error: 'not found' })
    }
    return
  }

  if (request.method === 'POST' && pathname === '/events') {
    await handleEvents(options, request, response)
    return
  }

  if (request.method === 'POST' && pathname === '/site-view') {
    await handleSiteView(options, request, response)
    return
  }

  if (request.method === 'GET' && pathname === '/me') {
    const owner = authenticate(request, options.db)
    if (!owner) {
      sendJson(response, 401, { error: 'invalid token' })
      return
    }
    sendJson(response, 200, {
      displayName: owner.displayName,
      accountId: owner.userId,
      email: findAccountEmail(options.db, owner.userId) ?? null,
    })
    return
  }

  if (request.method === 'POST' && pathname === '/account/name') {
    const owner = authenticate(request, options.db)
    if (!owner) {
      sendJson(response, 401, { error: 'invalid token' })
      return
    }
    const body = await readJsonBody(request)
    const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : ''
    if (displayName.length === 0 || displayName.length > 32) {
      sendJson(response, 400, { error: 'invalid-name' })
      return
    }
    renameAccount(options.db, owner.userId, displayName)
    sendJson(response, 200, { ok: true, displayName })
    return
  }

  if (request.method === 'POST' && pathname === '/account/sign-out') {
    const header = request.headers.authorization
    const tokenHash = header?.startsWith('Bearer ') ? hashToken(header.slice('Bearer '.length).trim()) : ''
    const owner = tokenHash ? findTokenOwner(options.db, tokenHash) : undefined
    if (!owner) {
      sendJson(response, 401, { error: 'invalid token' })
      return
    }
    revokeToken(options.db, tokenHash)
    sendJson(response, 200, { ok: true })
    return
  }

  // Quota meter and reward tasks. Their own namespace, so asking about today's
  // allowance never touches the model proxy or costs anything.
  if (pathname === '/quota' || pathname.startsWith('/reward/')) {
    response.setHeader('cache-control', 'no-store')
    const owner = authenticate(request, options.db)
    if (!owner) {
      sendJson(response, 401, { error: 'invalid token' })
      return
    }
    const settings = readSettings(options.db)

    if (request.method === 'GET' && pathname === '/quota') {
      sendJson(response, 200, quotaPayload(options.db, owner.userId, settings))
      return
    }

    if (request.method === 'POST' && pathname === '/reward/start') {
      const task = startRewardTask(options.db, owner.userId, settings)
      // No offer is a normal answer: rewards may simply not be open to this
      // account, or today's ceiling is already reached.
      sendJson(response, task === null ? 429 : 200, task === null ? { error: 'reward-unavailable' } : { task })
      return
    }

    if (request.method === 'POST' && pathname === '/reward/complete') {
      const body = await readJsonBody(request, 1024)
      const result = completeRewardTask(options.db, owner.userId, body?.taskId, settings)
      if (!result.ok) {
        const malformed = result.reason === 'unknown-task' || result.reason === 'provider-mismatch'
        sendJson(response, malformed ? 400 : 409, { error: result.reason })
        return
      }
      // The answer carries the refreshed meter so the client does not need a
      // second round trip to redraw it.
      sendJson(response, 200, { ok: true, amountMicro: result.amountMicro, duplicated: result.duplicated, ...quotaPayload(options.db, owner.userId, settings) })
      return
    }

    sendJson(response, 404, { error: 'not found' })
    return
  }

  if (pathname === '/auth/providers') {
    sendJson(response, 200, { providers: ['email'] })
    return
  }

  // Payment notifications carry no account token: the platform signs them, and
  // that signature is the authentication. This has to sit before the gate below.
  if (request.method === 'POST' && pathname.startsWith('/payment/notify/')) {
    await handlePaymentNotify(options, request, response, pathname.slice('/payment/notify/'.length))
    return
  }

  if (pathname === '/payment' || pathname.startsWith('/payment/')) {
    response.setHeader('cache-control', 'no-store')
    const owner = authenticate(request, options.db)
    if (!owner) {
      sendJson(response, 401, { error: 'invalid token' })
      return
    }
    await handlePayment(options, request, response, owner.userId, pathname)
    return
  }

  if (pathname === '/auth/email/send') {
    await handleEmailSend(options, request, response, mailer)
    return
  }

  if (pathname === '/auth/email/verify') {
    await handleEmailVerify(options, request, response)
    return
  }

  if (pathname.startsWith('/auth/')) {
    sendJson(response, 404, { error: 'not found' })
    return
  }

  // Every other path (the model API and anything else DeepSeek serves) is proxied.
  const owner = authenticate(request, options.db)
  if (!owner) {
    sendJson(response, 401, { error: 'invalid token' })
    return
  }

  const usedToday = countRequestsSince(options.db, owner.userId, startOfDay())
  if (options.dailyWarnLimit !== undefined && options.dailyWarnLimit > 0 && usedToday === options.dailyWarnLimit) {
    // Exactly on the crossing, so this warns once per account per day instead of
    // on every request past the line.
    console.warn(`[usage] ${owner.userId} reached ${options.dailyWarnLimit} requests today`)
  }

  if (options.dailyLimit > 0 && usedToday >= options.dailyLimit) {
    try {
      // A rejected request is recorded too: without it the cap is invisible in
      // the metrics, and hitting the cap is exactly what we need to see.
      recordUsage(options.db, {
        userId: owner.userId,
        model: null,
        promptChars: 0,
        completionChars: 0,
        status: 429,
        latencyMs: 0,
      })
    } catch {
      // Recording the rejection must not change the rejection itself.
    }
    // The client shows this text to the user, so it says what happened and when
    // it resets, in the language they are using. It deliberately does not
    // mention allowances: this is the runaway guard, and the product's daily
    // allowance has its own message.
    sendJson(response, 429, {
      error: 'daily-limit-reached',
      message: `今天的请求次数已达到上限，北京时间 0 点后自动恢复。`,
    })
    return
  }

  // What the account has left: today's free allowance, then its wallet. Read
  // before the call, because which bucket pays is decided by what was left when
  // the request started. In `off` mode nothing is refused, but what the request
  // cost and how it was split is still recorded.
  const settings = readSettings(options.db)
  const credit = creditState(options.db, owner.userId, settings)
  if (settings.quotaMode === 'enforce' && credit.exhausted) {
    try {
      recordUsage(options.db, {
        userId: owner.userId,
        model: null,
        promptChars: 0,
        completionChars: 0,
        status: 429,
        latencyMs: 0,
      })
    } catch {
      // Recording the rejection must not change the rejection itself.
    }
    sendJson(response, 429, {
      error: 'credit-exhausted',
      message: 'Mareo 余额不足，获取更多额度后即可继续。',
      ...quotaPayload(options.db, owner.userId, settings),
    })
    return
  }

  const outcome = await proxyRequest(request, response, options)
  try {
    // The row and the wallet debit it may cause are one movement of money, so
    // they land together or not at all.
    const billing = billingFor(outcome, credit, settings)
    options.db.exec('BEGIN')
    try {
      const usageId = recordUsage(options.db, {
        userId: owner.userId,
        model: outcome.model,
        promptChars: outcome.promptChars,
        completionChars: outcome.completionChars,
        status: outcome.status,
        latencyMs: outcome.latencyMs,
        tokens: outcome.tokens,
        sessionId: outcome.sessionId,
        // A 200 whose usage we did not capture is recorded as missing, never as
        // zero: an unaccounted request must not look free.
        usageSource: outcome.status === 200 ? (outcome.tokens === undefined ? 'missing' : 'provider') : undefined,
        requestKind: outcome.requestKind,
        billing,
      })
      const walletPart = (billing?.billableMicro ?? 0) - (billing?.paidFromFreeMicro ?? 0)
      if (walletPart > 0) {
        chargeWallet(options.db, { accountId: owner.userId, amountMicro: walletPart, relatedRequestId: usageId })
      }
      options.db.exec('COMMIT')
    } catch (error) {
      options.db.exec('ROLLBACK')
      throw error
    }
    // The session-title call carries the title the user sees in their own list;
    // recording it is what makes "what was this session about" answerable.
    if (outcome.requestKind === 'title' && outcome.titleText !== undefined) {
      recordSessionTitle(options.db, owner.userId, outcome.sessionId ?? null, outcome.titleText, 'gateway')
    }
  } catch (error) {
    // Usage accounting must never break a successful proxy exchange — but a
    // failure here means usage we cannot explain later, so it must be visible.
    console.error(`[billing] ${owner.userId}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * What one finished request cost and what the user is charged for it, with the
 * free allowance covering what it can. Undefined when the provider reported no
 * usage or the model has no price: an unpriced request is recorded as such and
 * never billed at zero.
 */
function billingFor(outcome: ProxyOutcome, credit: CreditState, settings: Settings): UsageBilling | undefined {
  if (outcome.status !== 200 || outcome.tokens === undefined) return undefined
  const cost = costOf(outcome.tokens, outcome.model, new Date())
  if (cost === undefined) return undefined
  const { actualMicro, billableMicro, marginMicro } = settleMicro(cost, settlementRateFor(settings, outcome.model))
  return {
    actualMicro,
    billableMicro,
    marginMicro,
    paidFromFreeMicro: Math.min(Math.max(credit.freeRemainingMicro, 0), billableMicro),
  }
}

/**
 * Client events. Authentication is optional: a client that cannot sign in has no
 * token, and those failures are exactly what we need to count. Telemetry never
 * fails a client visibly — anything unusable is simply dropped.
 */
async function handleEvents(
  options: GatewayOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const events = parseEvents(await readJsonBody(request, 64 * 1024))
  if (events === undefined) {
    sendJson(response, 400, { error: 'invalid-events' })
    return
  }
  const owner = authenticate(request, options.db)
  if (owner === undefined && options.anonymousEventLimiter?.(clientAddress(request)) === false) {
    sendJson(response, 429, { error: 'too-many-events' })
    return
  }
  try {
    // Session titles arrive as an event but belong in their own table: one row
    // per session, not one row per report.
    for (const event of events.filter((entry) => entry.name === 'session_title')) {
      const detail = parseSessionTitleDetail(event.detail)
      if (detail !== undefined) {
        recordSessionTitle(options.db, owner?.userId ?? null, detail.sessionId, detail.title, 'client')
      }
    }
    recordEvents(options.db, owner?.userId ?? null, events.filter((entry) => entry.name !== 'session_title'))
  } catch {
    // Telemetry must never surface as a client-visible failure.
  }
  sendJson(response, 200, { ok: true })
}

/**
 * Website page-view beacon. Only the counted paths are accepted, the counter is
 * per day and page (never per visitor), and the same anonymous limiter as client
 * events keeps the endpoint from being used to inflate or to flood the table.
 */
async function handleSiteView(
  options: GatewayOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const view = parseSiteView(await readJsonBody(request))
  if (view === undefined) {
    sendJson(response, 400, { error: 'invalid-view' })
    return
  }
  if (options.anonymousEventLimiter?.(clientAddress(request)) === false) {
    sendJson(response, 429, { error: 'too-many-views' })
    return
  }
  try {
    recordSiteView(options.db, view.path)
  } catch {
    // A lost page view is never worth failing a request over.
  }
  sendJson(response, 200, { ok: true })
}

/** nginx in front of the gateway sets these; the gateway itself is loopback-only. */
function clientAddress(request: IncomingMessage): string {
  const real = request.headers['x-real-ip']
  if (typeof real === 'string' && real !== '') return real
  const forwarded = request.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded !== '') return forwarded.split(',')[0].trim()
  return request.socket.remoteAddress ?? 'unknown'
}

async function handleEmailSend(
  options: GatewayOptions,
  request: IncomingMessage,
  response: ServerResponse,
  mailer: Mailer,
): Promise<void> {
  const body = await readJsonBody(request)
  if (!body || typeof body.email !== 'string' || !isValidEmail(body.email)) {
    sendJson(response, 400, { error: 'invalid-email' })
    return
  }
  const email = normalizeEmail(body.email)
  const outcome = beginEmailCode(options.db, email)
  if (!outcome.ok) {
    sendJson(response, 429, { error: outcome.reason })
    return
  }
  try {
    await mailer.sendCode(email, outcome.code)
  } catch (error) {
    console.error('[email] delivery failed:', messageFrom(error))
    sendJson(response, 503, { error: 'delivery-failed' })
    return
  }
  sendJson(response, 200, { ok: true })
}

async function handleEmailVerify(options: GatewayOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJsonBody(request)
  if (!body || typeof body.email !== 'string' || typeof body.code !== 'string' || !isValidEmail(body.email)) {
    sendJson(response, 400, { error: 'invalid-request' })
    return
  }
  const email = normalizeEmail(body.email)
  const check = verifyEmailCode(options.db, email, body.code)
  if (!check.ok) {
    sendJson(response, 400, { error: check.reason })
    return
  }
  const account = findOrCreateAccountForIdentity(options.db, 'email', email, displayNameForEmail(email))
  const secret = generateTokenSecret()
  storeToken(options.db, { userId: account.id, label: 'email-login', tokenHash: hashToken(secret) })
  sendJson(response, 200, { token: secret, displayName: account.displayName, accountId: account.id })
}

function displayNameForEmail(email: string): string {
  return email.split('@')[0].slice(0, 32) || 'Mareo 用户'
}

/**
 * What the client draws. `quota` keeps its original meaning — the free bucket,
 * which is what a client that predates the wallet knows how to show — and the
 * wallet arrives beside it for clients that display both.
 *
 * `exhausted` has always meant "the next request would be refused", so it stays
 * that: a wallet with credit in it means the account is not exhausted even when
 * the free allowance is gone.
 */
function quotaPayload(db: GatewayDatabase, accountId: string, settings: Settings): {
  quota: {
    limitMicro: number
    spentMicro: number
    remainingMicro: number
    usedPercent: number
    exhausted: boolean
    resetAt: string
    visible: boolean
  }
  free: {
    limitMicro: number
    usedMicro: number
    remainingMicro: number
    resetAt: string
  }
  wallet: { balanceMicro: number }
  total: { remainingMicro: number }
  reward: ReturnType<typeof rewardOfferFor>
} {
  const state = creditState(db, accountId, settings)
  return {
    quota: {
      limitMicro: state.freeLimitMicro,
      spentMicro: state.freeUsedMicro,
      remainingMicro: state.freeRemainingMicro,
      usedPercent:
        state.freeLimitMicro > 0 ? Math.min(100, Math.round((state.freeUsedMicro / state.freeLimitMicro) * 100)) : 100,
      exhausted: state.exhausted,
      resetAt: state.resetAt,
      visible: state.visible,
    },
    free: {
      limitMicro: state.freeLimitMicro,
      usedMicro: state.freeUsedMicro,
      remainingMicro: state.freeRemainingMicro,
      resetAt: state.resetAt,
    },
    wallet: { balanceMicro: state.walletMicro },
    total: { remainingMicro: state.totalRemainingMicro },
    reward: rewardOfferFor(db, accountId, settings),
  }
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > maxBytes) return undefined
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJsonBody(request: IncomingMessage, maxBytes = 16 * 1024): Promise<Record<string, unknown> | undefined> {
  const body = await readBody(request, maxBytes)
  if (body === undefined) return undefined
  try {
    return JSON.parse(body.toString('utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * A payment notification, straight from the platform. The body is kept raw
 * because its signature covers the exact bytes the platform sent — a decoded
 * and re-encoded body would no longer verify.
 */
async function handlePaymentNotify(
  options: GatewayOptions,
  request: IncomingMessage,
  response: ServerResponse,
  channel: string,
): Promise<void> {
  const payments = options.payments ?? paymentEnvFromProcess()
  const provider = isPaymentChannel(channel) ? providerFor(payments, channel) : undefined
  if (provider === undefined) {
    sendJson(response, 404, { error: 'not found' })
    return
  }
  const body = await readBody(request, 64 * 1024)
  if (body === undefined) {
    sendPaymentNotifyFailure(response, channel)
    return
  }

  let result: Awaited<ReturnType<typeof provider.verifyCallback>>
  try {
    result = await provider.verifyCallback(request.headers, body)
  } catch (error) {
    console.error(`[payment] ${channel} 回调校验异常：${messageFrom(error)}`)
    sendPaymentNotifyFailure(response, channel)
    return
  }
  if (result === undefined || !result.succeeded) {
    // A real platform retries a failure answer, which is what we want when a
    // notification arrives before its order is visible.
    console.warn(`[payment] ${channel} 回调未通过校验，已拒绝`)
    sendPaymentNotifyFailure(response, channel)
    return
  }

  const order = paymentOrder(options.db, result.orderId)
  if (order === undefined) {
    console.warn(`[payment] ${channel} 回调指向未知订单 ${result.orderId}`)
    sendPaymentNotifyFailure(response, channel)
    return
  }
  if (order.amountFen !== result.amountFen) {
    // Never adjust the order to match: an amount we did not ask for is a
    // situation for a person, not for an automatic credit.
    console.error(`[payment] 订单 ${result.orderId} 金额不符：订单 ${order.amountFen} 分，回调 ${result.amountFen} 分`)
    sendPaymentNotifyFailure(response, channel)
    return
  }

  const confirmed = confirmPayment(options.db, result.orderId, {
    transactionId: result.transactionId,
    amountFen: result.amountFen,
    rawCallback: body.toString('utf8').slice(0, 4096),
  })
  if (!confirmed.ok) {
    console.error(`[payment] 订单 ${result.orderId} 入账失败：${confirmed.error}`)
    sendPaymentNotifyFailure(response, channel)
    return
  }
  if (!confirmed.duplicated) {
    console.log(`[payment] 订单 ${result.orderId} 已到账 ¥${(order.amountMicro / 1_000_000).toFixed(2)}（${order.provider}）`)
  }
  // Success has to look like success to the platform, or it keeps retrying.
  if (channel === 'alipay') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('success')
    return
  }
  sendJson(response, 200, { code: 'SUCCESS', message: '成功' })
}

function sendPaymentNotifyFailure(response: ServerResponse, channel: string): void {
  if (channel === 'alipay') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('failure')
    return
  }
  sendJson(response, 400, { code: 'FAIL', message: '校验失败' })
}

/**
 * The recharge endpoints a signed-in client uses: what it may buy, starting an
 * order, following it, and its own history. Amounts come from the tier table
 * here, never from the request body.
 */
async function handlePayment(
  options: GatewayOptions,
  request: IncomingMessage,
  response: ServerResponse,
  accountId: string,
  pathname: string,
): Promise<void> {
  const payments = options.payments ?? paymentEnvFromProcess()

  if (request.method === 'GET' && pathname === '/payment/config') {
    const channels = PAYMENT_CHANNELS.filter((channel) => providerFor(payments, channel) !== undefined)
    sendJson(response, 200, {
      enabled: paymentsEnabled(payments),
      tiers: Object.keys(RECHARGE_TIERS).map((tier) => ({ tier, amountMicro: tierAmountMicro(tier) ?? 0 })),
      channels,
    })
    return
  }

  if (request.method === 'POST' && pathname === '/payment/orders') {
    const body = await readJsonBody(request, 4096)
    const created = await createPaymentOrder(options.db, {
      accountId,
      tier: body?.tier,
      channel: body?.channel,
      env: payments,
    })
    if (!created.ok) {
      sendJson(response, created.status, { error: created.error, ...(created.message === undefined ? {} : { message: created.message }) })
      return
    }
    // The same shape the two read endpoints return, plus the QR code: one order
    // contract, so a client parses a new order exactly like an existing one.
    sendJson(response, 200, { ...publicOrder(created.order), qrSvg: created.qrSvg })
    return
  }

  if (request.method === 'GET' && pathname === '/payment/orders') {
    const limit = Number(new URL(request.url ?? '/', 'http://gateway.local').searchParams.get('limit') ?? '20')
    const orders = recentPaymentOrders(options.db, accountId, Number.isFinite(limit) ? limit : 20)
    sendJson(response, 200, { orders: orders.map(publicOrder) })
    return
  }

  const orderMatch = /^\/payment\/orders\/([A-Za-z0-9_-]{1,64})$/.exec(pathname)
  if (request.method === 'GET' && orderMatch !== null) {
    const order = paymentOrder(options.db, orderMatch[1])
    if (order === undefined || order.userId !== accountId) {
      sendJson(response, 404, { error: 'not-found' })
      return
    }
    // A callback can be lost; when one seems to be, ask the platform ourselves.
    if (shouldQuery(order)) {
      const provider = providerFor(payments, order.provider)
      try {
        const remote = await provider?.queryOrder(order)
        if (remote?.status === 'paid' && remote.transactionId !== undefined && remote.amountFen !== undefined) {
          confirmPayment(options.db, order.orderId, { transactionId: remote.transactionId, amountFen: remote.amountFen })
        }
      } catch (error) {
        console.error(`[payment] 订单 ${order.orderId} 查单失败：${messageFrom(error)}`)
      }
    }
    sendJson(response, 200, publicOrder(paymentOrder(options.db, order.orderId) ?? order))
    return
  }

  sendJson(response, 404, { error: 'not found' })
}

/** What a user may see about their own order: never a platform secret. */
function publicOrder(order: {
  orderId: string
  status: string
  provider: string
  amountMicro: number
  amountFen: number
  createdAt: string
  expiresAt: string
  paidAt: string | null
}): Record<string, unknown> {
  return {
    orderId: order.orderId,
    status: order.status,
    channel: order.provider,
    amountMicro: order.amountMicro,
    amountFen: order.amountFen,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    paidAt: order.paidAt,
  }
}

/**
 * The account token a request carries. Our own client sends the `Bearer` header;
 * the harness's Messages-shaped providers send the same token as `x-api-key`, and
 * refusing that would turn every model call into an auth error.
 */
function authenticate(request: IncomingMessage, db: GatewayDatabase): TokenOwner | undefined {
  const header = request.headers.authorization
  const bearer = header?.startsWith('Bearer ') === true ? header.slice('Bearer '.length).trim() : undefined
  const apiKey = request.headers['x-api-key']
  const token = bearer ?? (Array.isArray(apiKey) ? apiKey[0] : apiKey)
  if (token === undefined || token === '') return undefined
  return findTokenOwner(db, hashToken(token))
}

export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(payload))
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

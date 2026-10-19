// The recharge path is money arriving from outside, so these tests pin the two
// things that decide whether it is credited: that a callback really came from
// the platform, and that the same payment can never be credited twice.
import assert from 'node:assert/strict'
import { generateKeyPairSync, createSign, createVerify } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createTokenAccount, openDatabase, type GatewayDatabase } from '../src/db.js'
import { alipayProvider, yuanToFen } from '../src/payment/alipay.js'
import { RECHARGE_TIERS, microToFen, newOrderId, tierAmountMicro } from '../src/payment/amount.js'
import { rechargeReport } from '../src/cost-report.js'
import {
  confirmPayment,
  createPaymentOrder,
  dayRechargeMicro,
  expirePendingOrders,
  forgetQueryThrottle,
  paymentOrder,
  paymentsEnabled,
  providerFor,
  recentPaymentOrders,
  shouldQuery,
  type PaymentEnv,
} from '../src/payment/orders.js'
import { walletBalanceMicro, walletTotals } from '../src/wallet.js'

const directory = mkdtempSync(path.join(tmpdir(), 'mareo-payment-'))
const db: GatewayDatabase = openDatabase(path.join(directory, 'payment.db'))

test.after(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

let accounts = 0
function newAccount(): string {
  accounts += 1
  return createTokenAccount(db, `充值测试${accounts}`)
}

const FAKE_ENV: PaymentEnv = { mode: 'fake', fakeToken: 'test-token' }

function fakeEnv(): PaymentEnv {
  return { ...FAKE_ENV }
}

test('tiers decide the amount, and micro to fen is exact', () => {
  assert.equal(tierAmountMicro('t10'), 10_000_000)
  assert.equal(tierAmountMicro('t100'), 100_000_000)
  // The client cannot invent a tier, and an amount is never taken from a request.
  assert.equal(tierAmountMicro('t999'), undefined)
  assert.equal(tierAmountMicro(30_000_000), undefined)
  assert.equal(tierAmountMicro(undefined), undefined)

  for (const micro of Object.values(RECHARGE_TIERS)) {
    assert.ok(Number.isInteger(microToFen(micro)), '每一档都必须是整分')
    assert.equal(microToFen(micro) * 10_000, micro)
  }
  assert.equal(microToFen(10_000_000), 1000)
})

test('a platform amount string becomes whole fen, without a float round trip', () => {
  assert.equal(yuanToFen('30.00'), 3000)
  assert.equal(yuanToFen('30'), 3000)
  assert.equal(yuanToFen('0.01'), 1)
  assert.equal(yuanToFen('100.5'), 10050)
  assert.equal(yuanToFen('0.29'), 29)
  assert.equal(yuanToFen('30.001'), undefined, '多过两位小数不是合法金额')
  assert.equal(yuanToFen('abc'), undefined)
  assert.equal(yuanToFen(''), undefined)
  assert.equal(yuanToFen('-1'), undefined)
})

test('order ids are unique, alphanumeric and within the platforms limit', () => {
  const ids = new Set<string>()
  for (let index = 0; index < 500; index += 1) ids.add(newOrderId())
  assert.equal(ids.size, 500, '订单号不能重复')
  for (const id of ids) {
    assert.match(id, /^MR\d{14}[A-Z0-9]{6}$/)
    assert.ok(id.length >= 6 && id.length <= 32)
  }
})

test('an order is created for the tier amount, and limits are refused', async () => {
  const account = newAccount()
  const created = await createPaymentOrder(db, { accountId: account, tier: 't30', channel: 'alipay', env: fakeEnv() })
  assert.ok(created.ok)
  assert.equal(created.order.amountMicro, 30_000_000)
  assert.equal(created.order.amountFen, 3000)
  assert.equal(created.order.status, 'pending')
  assert.ok(created.qrSvg.includes('<svg'), '二维码由服务端生成')
  assert.equal(walletBalanceMicro(db, account), 0, '下单不加钱')

  // Unknown tier / channel / a channel that has no implementation.
  const badTier = await createPaymentOrder(db, { accountId: account, tier: 't1', channel: 'alipay', env: fakeEnv() })
  assert.deepEqual(badTier, { ok: false, status: 400, error: 'invalid-tier' })
  const badChannel = await createPaymentOrder(db, { accountId: account, tier: 't10', channel: 'paypal', env: fakeEnv() })
  assert.deepEqual(badChannel, { ok: false, status: 400, error: 'invalid-channel' })
  const off = await createPaymentOrder(db, { accountId: account, tier: 't10', channel: 'alipay', env: { mode: 'off' } })
  assert.equal(off.ok, false)

  // Pending orders are capped so one account cannot fill the table.
  for (let index = 0; index < 2; index += 1) {
    await createPaymentOrder(db, { accountId: account, tier: 't10', channel: 'alipay', env: fakeEnv() })
  }
  const tooMany = await createPaymentOrder(db, { accountId: account, tier: 't10', channel: 'alipay', env: fakeEnv() })
  assert.deepEqual(tooMany, { ok: false, status: 429, error: 'too-many-pending' })
})

test('a payment is credited once, however many times it is reported', async () => {
  const account = newAccount()
  const created = await createPaymentOrder(db, { accountId: account, tier: 't30', channel: 'alipay', env: fakeEnv() })
  assert.ok(created.ok)
  const order = created.order

  // A wrong amount is never accepted, and never changes the order.
  const mismatch = confirmPayment(db, order.orderId, { transactionId: 'tx-1', amountFen: 1 })
  assert.deepEqual(mismatch, { ok: false, error: 'amount-mismatch' })
  assert.equal(paymentOrder(db, order.orderId)?.status, 'pending')
  assert.equal(walletBalanceMicro(db, account), 0)

  const unknown = confirmPayment(db, 'MR20260101000000ABCDEF', { transactionId: 'tx-x', amountFen: 3000 })
  assert.deepEqual(unknown, { ok: false, error: 'unknown-order' })

  const first = confirmPayment(db, order.orderId, { transactionId: 'tx-1', amountFen: 3000 })
  assert.ok(first.ok)
  assert.equal(first.duplicated, false)
  assert.equal(walletBalanceMicro(db, account), 30_000_000)
  const paid = paymentOrder(db, order.orderId)
  assert.equal(paid?.status, 'paid')
  assert.equal(paid?.transactionId, 'tx-1')
  assert.ok(paid?.paidAt !== null)

  // Three more deliveries of the same news.
  for (let index = 0; index < 3; index += 1) {
    const again = confirmPayment(db, order.orderId, { transactionId: 'tx-1', amountFen: 3000 })
    assert.equal(again.ok, true)
    assert.equal(again.duplicated, true, '重复回调必须是空操作')
  }
  assert.equal(walletBalanceMicro(db, account), 30_000_000, '余额只能加一次')
  const credits = db
    .prepare("SELECT COUNT(*) AS n FROM wallet_ledger WHERE userId = ? AND source = 'purchase'")
    .get(account) as { n: number }
  assert.equal(credits.n, 1, '账本只能有一条入账')
})

test('money that arrives after the QR code expired is still honoured', async () => {
  const account = newAccount()
  const created = await createPaymentOrder(db, { accountId: account, tier: 't10', channel: 'alipay', env: fakeEnv() })
  assert.ok(created.ok)
  const order = created.order

  // Expire it, then let the payment land.
  const later = new Date(Date.parse(order.expiresAt) + 60_000)
  // The sweep is global — other tests' orders expire with it — so the assertion
  // is about this order, not about the count.
  assert.ok(expirePendingOrders(db, later) >= 1)
  assert.equal(paymentOrder(db, order.orderId)?.status, 'cancelled')

  const confirmed = confirmPayment(db, order.orderId, { transactionId: 'tx-late', amountFen: 1000, now: later })
  assert.ok(confirmed.ok)
  assert.equal(confirmed.duplicated, false)
  assert.equal(walletBalanceMicro(db, account), 10_000_000)

  // ...but an order already paid or refunded is not a fresh payment.
  db.prepare("UPDATE payment_orders SET status = 'refunded' WHERE orderId = ?").run(order.orderId)
  const afterRefund = confirmPayment(db, order.orderId, { transactionId: 'tx-late', amountFen: 1000 })
  assert.ok(afterRefund.ok)
  assert.equal(afterRefund.duplicated, true, '已冲正的订单不能再入账')
  assert.equal(walletBalanceMicro(db, account), 10_000_000)
})

test('one platform payment cannot be credited to two orders', async () => {
  const account = newAccount()
  const first = await createPaymentOrder(db, { accountId: account, tier: 't10', channel: 'alipay', env: fakeEnv() })
  const second = await createPaymentOrder(db, { accountId: account, tier: 't10', channel: 'alipay', env: fakeEnv() })
  assert.ok(first.ok && second.ok)

  assert.equal(confirmPayment(db, first.order.orderId, { transactionId: 'tx-shared', amountFen: 1000 }).ok, true)
  const reused = confirmPayment(db, second.order.orderId, { transactionId: 'tx-shared', amountFen: 1000 })
  assert.deepEqual(reused, { ok: false, error: 'transaction-reused' })
  assert.equal(paymentOrder(db, second.order.orderId)?.status, 'pending', '第二单不能被标记为已支付')
  assert.equal(walletBalanceMicro(db, account), 10_000_000, '只应该到账一次')
})

test('the daily ceiling counts credit already bought today', async () => {
  const account = newAccount()
  // 20 successful ¥100 orders would exceed ¥2000/day; drive the ceiling through
  // the ledger, which is what the check reads.
  db.prepare(
    `INSERT INTO wallet_ledger (userId, type, amountMicro, source, balanceAfterMicro, relatedRequestId, externalRef, channel, createdAt)
     VALUES (?, 'credit', ?, 'purchase', ?, NULL, 'seed', 'alipay', ?)`,
  ).run(account, 1_950_000_000, 1_950_000_000, new Date().toISOString())
  assert.equal(dayRechargeMicro(db, account), 1_950_000_000)

  const refused = await createPaymentOrder(db, { accountId: account, tier: 't100', channel: 'alipay', env: fakeEnv() })
  assert.deepEqual(refused, { ok: false, status: 429, error: 'daily-limit' })
  const allowed = await createPaymentOrder(db, { accountId: account, tier: 't30', channel: 'alipay', env: fakeEnv() })
  assert.equal(allowed.ok, true, '没超过上限的仍然可以下单')
})

test('orders are listed newest first and only for their own account', async () => {
  const account = newAccount()
  const other = newAccount()
  for (const tier of ['t10', 't30'] as const) {
    await createPaymentOrder(db, { accountId: account, tier, channel: 'alipay', env: fakeEnv() })
  }
  await createPaymentOrder(db, { accountId: other, tier: 't10', channel: 'alipay', env: fakeEnv() })
  const orders = recentPaymentOrders(db, account)
  assert.equal(orders.length, 2)
  assert.equal(orders[0].amountMicro, 30_000_000, '新的在前')
  assert.ok(orders.every((order) => order.userId === account))
})

test('querying the platform is throttled, and only for orders that need it', async () => {
  forgetQueryThrottle()
  const account = newAccount()
  const created = await createPaymentOrder(db, { accountId: account, tier: 't10', channel: 'alipay', env: fakeEnv() })
  assert.ok(created.ok)
  const order = created.order

  const justNow = new Date(Date.parse(order.createdAt) + 1_000)
  assert.equal(shouldQuery(order, justNow), false, '刚下单不必查')
  const later = new Date(Date.parse(order.createdAt) + 11_000)
  assert.equal(shouldQuery(order, later), true, '超过 10 秒没有回调就该主动查')
  assert.equal(shouldQuery(order, later), false, '同一订单 5 秒内只查一次')
  assert.equal(shouldQuery(order, new Date(later.getTime() + 6_000)), true)
  assert.equal(shouldQuery({ ...order, status: 'paid' }, new Date(later.getTime() + 20_000)), false, '已支付不必再查')
})

test('only a configured live channel shows the entry point to users', () => {
  assert.equal(paymentsEnabled({ mode: 'off' }), false)
  assert.equal(paymentsEnabled({ mode: 'fake', fakeToken: 'x' }), false, '模拟通道不给用户看')
  assert.equal(paymentsEnabled({ mode: 'live' }), false, '没配置任何渠道时也不显示')
  const live: PaymentEnv = { mode: 'live', alipay: alipayConfig(), publicBaseUrl: 'https://api.example.com' }
  assert.equal(paymentsEnabled(live), true)
  // A live channel with nowhere to receive notifications is not usable either:
  // the platform has no address to call.
  assert.equal(paymentsEnabled({ mode: 'live', alipay: alipayConfig() }), false)
  assert.equal(providerFor({ mode: 'fake', fakeToken: '' }, 'alipay'), undefined)
})

test('the report sees purchases as the ledger records them', async () => {
  const account = newAccount()
  const created = await createPaymentOrder(db, { accountId: account, tier: 't100', channel: 'alipay', env: fakeEnv() })
  assert.ok(created.ok)
  confirmPayment(db, created.order.orderId, { transactionId: 'tx-report', amountFen: 10_000 })
  const before = walletTotals(db)
  assert.ok(before.creditedBySource.get('purchase') !== undefined)
  assert.ok(before.creditedCountBySource.get('purchase') !== undefined)
})

test('the report counts the day: how many were opened, how many were paid', async () => {
  const payer = newAccount()
  const browsers = newAccount()
  // A fixed Beijing day, so the assertions do not depend on when this runs.
  const day = new Date('2026-10-05T05:00:00.000Z')
  const paidOrders: string[] = []
  for (const tier of ['t10', 't30'] as const) {
    const created = await createPaymentOrder(db, { accountId: payer, tier, channel: 'alipay', env: fakeEnv(), now: day })
    assert.ok(created.ok)
    paidOrders.push(created.order.orderId)
  }
  // The same account twice, then a second account with a failure and a
  // still-waiting order: the pending cap is per account, not per day.
  const failed = await createPaymentOrder(db, { accountId: browsers, tier: 't10', channel: 'wechat', env: fakeEnv(), now: day })
  const waiting = await createPaymentOrder(db, { accountId: browsers, tier: 't10', channel: 'alipay', env: fakeEnv(), now: day })
  assert.ok(failed.ok && waiting.ok)

  confirmPayment(db, paidOrders[0], { transactionId: 'tx-day-1', amountFen: 1000, now: day })
  confirmPayment(db, paidOrders[1], { transactionId: 'tx-day-2', amountFen: 3000, now: day })
  db.prepare("UPDATE payment_orders SET status = 'failed' WHERE orderId = ?").run(failed.order.orderId)

  const section = rechargeReport(db, '2026-10-05')
  assert.equal(section.orders, 4)
  assert.equal(section.paid, 2)
  assert.equal(section.failed, 1)
  assert.equal(section.pending, 1)
  assert.equal(section.cancelled, 0)
  assert.equal(section.successRate, 2 / 3, '待支付的订单不进成功率分母')
  assert.equal(section.topUpUsers, 1, '只有真正付过款的人算充值人数')
  assert.deepEqual(section.byChannel, [
    { channel: 'alipay', paid: 2, paidMicro: 40_000_000, orders: 3 },
    { channel: 'wechat', paid: 0, paidMicro: 0, orders: 1 },
  ])
  // Both paid orders were confirmed at the same instant they were opened.
  assert.equal(section.medianSeconds, 0)
  assert.equal(rechargeReport(db, '2026-10-04').orders, 0, '别的日子是空的')
})

// --- Alipay itself -------------------------------------------------------

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PRIVATE_PEM = keys.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const PUBLIC_PEM = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()

function alipayConfig(): { appId: string; privateKey: string; publicKey: string; gateway: string } {
  return { appId: '2026000000000000', privateKey: PRIVATE_PEM, publicKey: PUBLIC_PEM, gateway: 'https://example.invalid/gateway.do' }
}

/** A notification signed the way Alipay signs one: RSA2 over the sorted form. */
function signedCallback(fields: Record<string, string>): Buffer {
  const content = Object.keys(fields)
    .filter((key) => key !== 'sign' && key !== 'sign_type' && fields[key] !== '')
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('&')
  const sign = createSign('RSA-SHA256').update(content, 'utf8').sign(PRIVATE_PEM, 'base64')
  return Buffer.from(new URLSearchParams({ ...fields, sign }).toString())
}

function callbackFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    app_id: '2026000000000000',
    out_trade_no: 'MR20260101000000ABCDEF',
    trade_no: '2026010122001400000000000001',
    trade_status: 'TRADE_SUCCESS',
    total_amount: '30.00',
    sign_type: 'RSA2',
    charset: 'utf-8',
    ...overrides,
  }
}

test('an Alipay notification is only believed when its signature checks out', async () => {
  const provider = alipayProvider(alipayConfig())
  const good = await provider.verifyCallback({}, signedCallback(callbackFields()))
  assert.deepEqual(good, {
    orderId: 'MR20260101000000ABCDEF',
    transactionId: '2026010122001400000000000001',
    amountFen: 3000,
    succeeded: true,
  })

  // Signed for ¥30, then rewritten to claim ¥99.99: the signature no longer
  // covers the body it arrives with.
  const signedThirty = signedCallback(callbackFields()).toString()
  const tampered = await provider.verifyCallback({}, Buffer.from(signedThirty.replace('total_amount=30.00', 'total_amount=99.99')))
  assert.equal(tampered, undefined, '改过金额的回调必须被拒绝')

  const unsigned = await provider.verifyCallback({}, Buffer.from(new URLSearchParams(callbackFields()).toString()))
  assert.equal(unsigned, undefined, '没有签名的回调必须被拒绝')

  const wrongKey = alipayProvider({ ...alipayConfig(), publicKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString() })
  assert.equal(await wrongKey.verifyCallback({}, signedCallback(callbackFields())), undefined, '换了公钥就验不过')

  // A signed notification for a payment that did not succeed is trusted but not
  // a reason to credit.
  const waiting = await provider.verifyCallback({}, signedCallback(callbackFields({ trade_status: 'WAIT_BUYER_PAY' })))
  assert.equal(waiting?.succeeded, false)
  const closed = await provider.verifyCallback({}, signedCallback(callbackFields({ trade_status: 'TRADE_CLOSED' })))
  assert.equal(closed?.succeeded, false)
})

test('a request is signed over every parameter except sign, sign_type included', async () => {
  // The gateway rejects the other convention with `isv.invalid-signature`, which
  // reads like a key problem. This pins the convention that actually works.
  const originalFetch = globalThis.fetch
  let sent = ''
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent = String(init?.body ?? '')
    return new Response(
      JSON.stringify({ alipay_trade_query_response: { code: '40004', sub_code: 'ACQ.TRADE_NOT_EXIST', sub_msg: '交易不存在' } }),
      {
      status: 200,
        headers: { 'content-type': 'application/json' },
      },
    )
  }) as typeof fetch
  try {
    await alipayProvider(alipayConfig()).queryOrder({ orderId: 'MR20260101000000ABCDEF' } as never)
  } finally {
    globalThis.fetch = originalFetch
  }

  const params = Object.fromEntries(new URLSearchParams(sent)) as Record<string, string>
  const content = Object.keys(params)
    .filter((key) => key !== 'sign')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&')
  assert.ok(content.includes('sign_type=RSA2'), 'sign_type 必须被签名覆盖')
  assert.equal(
    createVerify('RSA-SHA256').update(content, 'utf8').verify(PUBLIC_PEM, params.sign, 'base64'),
    true,
  )
})

test('Alipay keys are accepted as PEM or as the bare base64 the platform shows', () => {
  const bare = PRIVATE_PEM.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')
  assert.doesNotThrow(() => alipayProvider({ ...alipayConfig(), privateKey: bare }))
  assert.throws(
    () => alipayProvider({ ...alipayConfig(), privateKey: 'not-a-key' }),
    /无法解析/,
    '密钥格式错误要说清楚，而不是等到签名时报错',
  )
})

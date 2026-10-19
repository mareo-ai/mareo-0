// The recharge path as a client and a payment platform actually meet it: a
// signed-in client starts an order, the platform's notification arrives on a
// route of its own, and the wallet ends up with the money exactly once.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { hashToken } from '../src/auth.js'
import { createTokenAccount, openDatabase, storeToken, type GatewayDatabase } from '../src/db.js'
import type { PaymentEnv } from '../src/payment/orders.js'
import { createGatewayServer } from '../src/server.js'
import { walletBalanceMicro } from '../src/wallet.js'

const FAKE_TOKEN = 'fake-callback-token'
let directory: string
let gateway: Server
let db: GatewayDatabase
let gatewayUrl: string
let accountId: string
let otherAccountId: string
const token = 'recharge-http-token'
const otherToken = 'recharge-http-other'

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('did not bind a port')
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

async function createOrder(body: unknown, bearer = token): Promise<Response> {
  return fetch(`${gatewayUrl}/payment/orders`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function notify(body: unknown, secret = FAKE_TOKEN, channel = 'alipay'): Promise<Response> {
  return fetch(`${gatewayUrl}/payment/notify/${channel}`, {
    method: 'POST',
    headers: { 'x-mareo-fake-token': secret, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function ledgerCredits(): { n: number; total: number } {
  // Copied into a plain object: rows come back from SQLite with a null
  // prototype, which strict deep-equality refuses.
  const row = db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amountMicro), 0) AS total FROM wallet_ledger WHERE userId = ? AND source = 'purchase'")
    .get(accountId) as { n: number; total: number }
  return { n: row.n, total: row.total }
}

before(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'mareo-payment-http-'))
  db = openDatabase(path.join(directory, 'payment-http.db'))
  // A gateway whose only channel is the fake one: the routes under test are the
  // production ones, the platform is not.
  const payments: PaymentEnv = { mode: 'fake', fakeToken: FAKE_TOKEN, publicBaseUrl: 'https://api.example.com' }
  gateway = createGatewayServer({ db, upstreamBaseUrl: 'http://127.0.0.1:1', apiKey: 'sk-test', dailyLimit: 0, payments })
  gatewayUrl = await listen(gateway)
  accountId = createTokenAccount(db, '充值 HTTP 测试')
  storeToken(db, { userId: accountId, label: 'test', tokenHash: hashToken(token) })
  otherAccountId = createTokenAccount(db, '另一个账号')
  storeToken(db, { userId: otherAccountId, label: 'other', tokenHash: hashToken(otherToken) })
})

after(async () => {
  await close(gateway)
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

test('the recharge endpoints require the account token', async () => {
  assert.equal((await fetch(`${gatewayUrl}/payment/config`)).status, 401)
  assert.equal((await createOrder({ tier: 't10', channel: 'alipay' }, 'nonsense')).status, 401)
})

test('the config tells a client what it may buy, and hides the entry until live', async () => {
  const response = await fetch(`${gatewayUrl}/payment/config`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(response.status, 200)
  const body = (await response.json()) as { enabled: boolean; tiers: { tier: string; amountMicro: number }[]; channels: string[] }
  // The fake channel exists for us, not for users: no entry point is offered.
  assert.equal(body.enabled, false)
  assert.deepEqual(body.channels, ['wechat', 'alipay'])
  assert.deepEqual(
    body.tiers.map((tier) => [tier.tier, tier.amountMicro]),
    [
      ['t10', 10_000_000],
      ['t30', 30_000_000],
      ['t100', 100_000_000],
    ],
  )
})

test('an order carries a server-rendered QR code and no money yet', async () => {
  const response = await createOrder({ tier: 't30', channel: 'alipay' })
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    orderId: string; status: string; amountMicro: number; createdAt: string; expiresAt: string
    paidAt: string | null; channel: string; qrSvg: string
  }
  assert.match(body.orderId, /^MR\d{14}[A-Z0-9]{6}$/)
  assert.equal(body.status, 'pending')
  assert.equal(body.amountMicro, 30_000_000)
  assert.ok(body.qrSvg.includes('<svg'), '客户端不需要自带二维码库')
  assert.ok(Date.parse(body.expiresAt) > Date.now())
  // A freshly created order must be readable by the same parser as a fetched one:
  // the client requires these fields, and a missing `createdAt` is what made the
  // recharge panel say "无法识别".
  assert.equal(body.channel, 'alipay')
  assert.equal(typeof body.createdAt, 'string')
  assert.equal(body.paidAt, null)
  assert.ok(Date.parse(body.createdAt) <= Date.now())
  assert.equal(walletBalanceMicro(db, accountId), 0, '下单不入账')

  // A client cannot ask for an amount, only for a tier.
  assert.equal((await createOrder({ tier: 't10', channel: 'alipay', amountMicro: 999_000_000 })).status, 200)
  const rows = db.prepare('SELECT amountMicro FROM payment_orders WHERE userId = ? ORDER BY createdAt').all(accountId) as { amountMicro: number }[]
  assert.deepEqual(rows.map((row) => row.amountMicro), [30_000_000, 10_000_000])
})

test('the notification is the only thing that credits, and only once', async () => {
  const created = (await (await createOrder({ tier: 't30', channel: 'alipay' })).json()) as { orderId: string }

  const before = ledgerCredits()
  // A wrong secret is not a notification.
  assert.equal((await notify({ orderId: created.orderId, amountMicro: 30_000_000 }, 'wrong-secret')).status, 200)
  assert.equal(await (await notify({ orderId: created.orderId, amountMicro: 30_000_000 }, 'wrong-secret')).text(), 'failure')
  assert.deepEqual(ledgerCredits(), before, '校验失败不能入账')

  // An unknown order is not credited either.
  assert.equal(await (await notify({ orderId: 'MR20260101000000AAAAAA', amountMicro: 30_000_000 })).text(), 'failure')

  // The real thing.
  const paid = await notify({ orderId: created.orderId, amountMicro: 30_000_000, transactionId: 'txn-http-1' })
  assert.equal(paid.status, 200)
  assert.equal(await paid.text(), 'success', '支付宝要看到 success 才停止重试')
  assert.equal(walletBalanceMicro(db, accountId), 30_000_000)
  assert.deepEqual(ledgerCredits(), { n: before.n + 1, total: before.total + 30_000_000 })

  const order = (await (await fetch(`${gatewayUrl}/payment/orders/${created.orderId}`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
    status: string
    paidAt: string | null
  }
  assert.equal(order.status, 'paid')
  assert.ok(order.paidAt !== null)

  // The platform retries anyway, four more times.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal(await (await notify({ orderId: created.orderId, amountMicro: 30_000_000, transactionId: 'txn-http-1' })).text(), 'success')
  }
  assert.equal(walletBalanceMicro(db, accountId), 30_000_000, '重复回调不能重复加钱')
  assert.deepEqual(ledgerCredits(), { n: before.n + 1, total: before.total + 30_000_000 })

  // And the meter the client shows agrees with the ledger.
  const quota = (await (await fetch(`${gatewayUrl}/quota`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
    wallet: { balanceMicro: number }
    total: { remainingMicro: number }
  }
  assert.equal(quota.wallet.balanceMicro, 30_000_000)
  assert.equal(quota.total.remainingMicro, quota.wallet.balanceMicro + 10_000_000)
})

test('an amount that does not match the order is never credited', async () => {
  const created = (await (await createOrder({ tier: 't100', channel: 'alipay' })).json()) as { orderId: string }
  const before = ledgerCredits()
  // Signed for ¥100, claiming ¥1: refused, and the order is left for a person.
  assert.equal(await (await notify({ orderId: created.orderId, amountMicro: 1_000_000 })).text(), 'failure')
  assert.deepEqual(ledgerCredits(), before)
  const order = (await (await fetch(`${gatewayUrl}/payment/orders/${created.orderId}`, { headers: { authorization: `Bearer ${token}` } })).json()) as { status: string }
  assert.equal(order.status, 'pending')
})

test('orders are visible only to their owner, and history is newest first', async () => {
  const created = (await (await createOrder({ tier: 't10', channel: 'alipay' })).json()) as { orderId: string }
  const stranger = await fetch(`${gatewayUrl}/payment/orders/${created.orderId}`, { headers: { authorization: `Bearer ${otherToken}` } })
  assert.equal(stranger.status, 404, '别人的订单不能看')

  const history = (await (await fetch(`${gatewayUrl}/payment/orders?limit=5`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
    orders: { orderId: string; createdAt: string; amountMicro: number }[]
  }
  assert.ok(history.orders.length > 0)
  const mine = history.orders.every((order) => db.prepare('SELECT userId FROM payment_orders WHERE orderId = ?').get(order.orderId)?.userId === accountId)
  assert.ok(mine, '只能看到自己的订单')
  const times = history.orders.map((order) => Date.parse(order.createdAt))
  assert.deepEqual(times, [...times].sort((left, right) => right - left), '新的在前')
})

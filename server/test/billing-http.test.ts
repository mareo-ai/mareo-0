// The money chain as a real request meets it: a model call through the gateway is
// priced, split between the free allowance and the wallet, and the usage row and
// the ledger agree afterwards. The unit tests pin the arithmetic; this pins that
// the request path actually writes it.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { hashToken } from '../src/auth.js'
import { createTokenAccount, openDatabase, storeToken, type GatewayDatabase } from '../src/db.js'
import { costOf, settleMicro, type TokenUsage } from '../src/pricing.js'
import { freeUsedMicroToday } from '../src/quota.js'
import { createGatewayServer } from '../src/server.js'
import { DEFAULT_SETTLEMENT_RATE, writeSetting } from '../src/settings.js'
import { grantCredit, recentLedger, walletBalanceMicro, walletTotals } from '../src/wallet.js'

// ¥0.05 of cache hits at the off-peak Flash price, so one request is a round
// number the test can state rather than read back from the code under test.
const TOKENS: TokenUsage = {
  inputTokens: 2_500_000,
  cacheHitTokens: 2_500_000,
  cacheMissTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
}
const TOP_UP_MICRO = 500_000

/** What the upstream says it served: the gateway must price exactly this. */
const CHAT_RESPONSE = JSON.stringify({
  id: 'chat-e2e',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: TOKENS.inputTokens,
    completion_tokens: TOKENS.outputTokens,
    prompt_cache_hit_tokens: TOKENS.cacheHitTokens,
    prompt_cache_miss_tokens: TOKENS.cacheMissTokens,
  },
})

let directory: string
let upstream: Server
let gateway: Server
let db: GatewayDatabase
let gatewayUrl: string
let accountId: string
const token = 'billing-http-token'

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

function chat(): Promise<Response> {
  return fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] }),
  })
}

interface UsageRow {
  id: number
  status: number
  actualMicro: number | null
  billableMicro: number | null
  marginMicro: number | null
  paidFromFreeMicro: number | null
}

function usageRows(): UsageRow[] {
  return db
    .prepare('SELECT id, status, actualMicro, billableMicro, marginMicro, paidFromFreeMicro FROM usage ORDER BY id')
    .all() as unknown as UsageRow[]
}

before(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'mareo-billing-http-'))
  db = openDatabase(path.join(directory, 'billing-http.db'))
  upstream = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(CHAT_RESPONSE)
  })
  await listen(upstream)
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
  gateway = createGatewayServer({ db, upstreamBaseUrl: upstreamUrl, apiKey: 'sk-test', dailyLimit: 0 })
  gatewayUrl = await listen(gateway)
  accountId = createTokenAccount(db, '结算链路测试')
  storeToken(db, { userId: accountId, label: 'test', tokenHash: hashToken(token) })
  writeSetting(db, 'quota.mode', 'enforce')
})

after(async () => {
  await close(gateway)
  await close(upstream)
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

test('the free allowance pays first, the wallet covers the rest, and a debit carries the overdraft', async () => {
  const cost = costOf(TOKENS, 'deepseek-flash', new Date())
  assert.ok(cost !== undefined, 'the sample request must be priceable')
  const { actualMicro, billableMicro, marginMicro } = settleMicro(cost, DEFAULT_SETTLEMENT_RATE)
  // One free allowance that covers a request and then leaves a stub of it, so the
  // second request has to reach into the wallet.
  const leftover = 10_000
  writeSetting(db, 'quota.dailyFreeMicro', String(billableMicro + leftover))

  // 1. The free allowance pays for the whole first request.
  assert.equal((await chat()).status, 200)
  let rows = usageRows()
  // Spread into a plain object: rows come back from SQLite with a null prototype,
  // which strict deep-equality refuses.
  assert.deepEqual({ ...rows[0] }, {
    id: rows[0].id,
    status: 200,
    actualMicro,
    billableMicro,
    marginMicro,
    paidFromFreeMicro: billableMicro,
  })
  assert.equal(recentLedger(db, accountId).length, 0, 'a request the free allowance covered touches no wallet')

  // 2. The second one starts with a stub of free allowance left and overdraws the
  //    empty wallet by the rest: allowed, and recorded as a negative balance.
  assert.equal((await chat()).status, 200)
  rows = usageRows()
  assert.equal(rows[1].paidFromFreeMicro, leftover, 'the free allowance pays only what it has left')
  const overdraft = billableMicro - leftover
  assert.deepEqual(
    recentLedger(db, accountId).map((entry) => [entry.type, entry.source, entry.amountMicro, entry.balanceAfterMicro, entry.relatedRequestId]),
    [['debit', 'model_usage', overdraft, -overdraft, rows[1].id]],
  )

  // 3. Now both buckets are empty, so the next call is refused — and the refusal
  //    is recorded without inventing a price for a request that never ran.
  const refused = await chat()
  assert.equal(refused.status, 429)
  assert.equal(((await refused.json()) as { error: string }).error, 'credit-exhausted')
  rows = usageRows()
  assert.deepEqual({ ...rows[2] }, {
    id: rows[2].id,
    status: 429,
    actualMicro: null,
    billableMicro: null,
    marginMicro: null,
    paidFromFreeMicro: null,
  })
  assert.equal(walletBalanceMicro(db, accountId), -overdraft)

  // 4. A top-up settles the debt and reopens the model path, which now spends the
  //    wallet alone.
  grantCredit(db, { accountId, amountMicro: TOP_UP_MICRO, source: 'purchase', externalRef: 'ORDER-E2E', channel: 'alipay' })
  assert.equal((await chat()).status, 200)
  rows = usageRows()
  assert.equal(rows[3].paidFromFreeMicro, 0, 'the free allowance is spent for the day')
  assert.equal(walletBalanceMicro(db, accountId), TOP_UP_MICRO - overdraft - billableMicro)

  // 5. The ledger explains every number the usage rows carry.
  const ledger = recentLedger(db, accountId)
  assert.equal(ledger.length, 3)
  assert.deepEqual(
    ledger.map((entry) => [entry.type, entry.amountMicro, entry.balanceAfterMicro]),
    [
      ['debit', billableMicro, TOP_UP_MICRO - overdraft - billableMicro],
      ['credit', TOP_UP_MICRO, TOP_UP_MICRO - overdraft],
      ['debit', overdraft, -overdraft],
    ],
  )
  const totals = walletTotals(db)
  assert.equal(totals.creditedMicro, TOP_UP_MICRO)
  assert.equal(totals.consumedMicro, overdraft + billableMicro)
  assert.equal(totals.balanceMicro, walletBalanceMicro(db, accountId))
  assert.equal(totals.creditedBySource.get('purchase'), TOP_UP_MICRO)

  // 6. What the client shows: the free bucket is spent and the wallet carries the
  //    rest, which is exactly what the rows above add up to.
  const meter = (await (await fetch(`${gatewayUrl}/quota`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
    quota: { limitMicro: number; usedMicro: number; exhausted: boolean }
    free: { usedMicro: number }
    wallet: { balanceMicro: number }
    total: { remainingMicro: number }
  }
  assert.equal(meter.free.usedMicro, billableMicro + leftover)
  assert.equal(meter.free.usedMicro, freeUsedMicroToday(db, accountId))
  assert.equal(meter.wallet.balanceMicro, walletBalanceMicro(db, accountId))
  assert.equal(meter.total.remainingMicro, walletBalanceMicro(db, accountId))
  assert.equal(meter.quota.exhausted, false)
})

// The quota as the client and the model path meet it: the meter endpoint, the
// refusal, and — most importantly — that `off` changes nothing at all.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { hashToken } from '../src/auth.js'
import { createTokenAccount, openDatabase, storeToken, type GatewayDatabase } from '../src/db.js'
import { createGatewayServer } from '../src/server.js'
import { writeSetting } from '../src/settings.js'

let directory: string
let stub: Server
let gateway: Server
let db: GatewayDatabase
let gatewayUrl: string
const token = 'quota-http-token'
let accountId: string

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

/** A chat call that only ever needs to be answered by the gateway itself. */
function chat(): Promise<Response> {
  return fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] }),
  })
}

function rejections(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM usage WHERE status = 429').get() as { n: number }).n
}

before(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'mareo-quota-http-'))
  db = openDatabase(path.join(directory, 'quota-http.db'))
  stub = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  })
  await listen(stub)
  // The model path is never reached in the blocked cases; point it somewhere
  // harmless so an unblocked request cannot leave the machine either.
  gateway = createGatewayServer({ db, upstreamBaseUrl: 'http://127.0.0.1:1', apiKey: 'sk-test', dailyLimit: 0 })
  gatewayUrl = await listen(gateway)
  accountId = createTokenAccount(db, '额度 HTTP 测试')
  storeToken(db, { userId: accountId, label: 'test', tokenHash: hashToken(token) })
})

after(async () => {
  await close(gateway)
  await close(stub)
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

test('the meter endpoint requires the account token', async () => {
  assert.equal((await fetch(`${gatewayUrl}/quota`)).status, 401)
  assert.equal((await fetch(`${gatewayUrl}/reward/start`, { method: 'POST' })).status, 401)
  assert.equal((await fetch(`${gatewayUrl}/reward/complete`, { method: 'POST' })).status, 401)
})

test('with the quota off the meter is invisible and no request is refused', async () => {
  writeSetting(db, 'quota.mode', 'off')
  // Even with a free allowance of zero: off means off.
  writeSetting(db, 'quota.dailyFreeMicro', '0')

  const meter = await fetch(`${gatewayUrl}/quota`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(meter.status, 200)
  const body = (await meter.json()) as { quota: { visible: boolean; exhausted: boolean }; reward: unknown }
  assert.equal(body.quota.visible, false)
  assert.equal(body.reward, null)

  const response = await chat()
  assert.notEqual(response.status, 429, 'off must not refuse anything')
  assert.equal(rejections(), 0)
})

test('showing the meter to one allowlisted account does not refuse anyone', async () => {
  writeSetting(db, 'quota.mode', 'shadow')
  writeSetting(db, 'quota.rewardAccounts', accountId)
  const body = (await (await fetch(`${gatewayUrl}/quota`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
    quota: { visible: boolean; exhausted: boolean; usedPercent: number }
  }
  assert.equal(body.quota.visible, true)
  assert.equal(body.quota.exhausted, true)
  assert.equal(body.quota.usedPercent, 100)

  // Shadow measures; it never blocks.
  const response = await chat()
  assert.notEqual(response.status, 429)
  assert.equal(rejections(), 0)
})

test('enforce refuses with the quota in the payload and records the refusal', async () => {
  writeSetting(db, 'quota.mode', 'enforce')
  const response = await chat()
  assert.equal(response.status, 429)
  const body = (await response.json()) as { error: string; message: string; quota: { limitMicro: number; exhausted: boolean } }
  assert.equal(body.error, 'credit-exhausted')
  assert.match(body.message, /余额不足/)
  assert.equal(body.quota.exhausted, true)
  assert.equal(body.quota.limitMicro, 0)
  assert.equal(rejections(), 1)
})

test('the reward endpoints issue a task, refuse an early claim, then credit it', async () => {
  writeSetting(db, 'quota.rewardAmountMicro', '2000000')
  // A zero-second task keeps the test fast; the gateway still owns the clock.
  writeSetting(db, 'quota.rewardMinSeconds', '0')
  writeSetting(db, 'quota.rewardAccounts', accountId)

  const started = await fetch(`${gatewayUrl}/reward/start`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  assert.equal(started.status, 200)
  const task = ((await started.json()) as { task: { taskId: string; amountMicro: number } }).task
  assert.equal(task.amountMicro, 2_000_000)

  const done = await fetch(`${gatewayUrl}/reward/complete`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: task.taskId }),
  })
  assert.equal(done.status, 200)
  const credited = (await done.json()) as {
    ok: boolean
    amountMicro: number
    quota: { exhausted: boolean }
    free: { limitMicro: number; remainingMicro: number }
    wallet: { balanceMicro: number }
    total: { remainingMicro: number }
  }
  assert.equal(credited.ok, true)
  assert.equal(credited.amountMicro, 2_000_000)
  // A reward is wallet credit, not a bigger free allowance.
  assert.equal(credited.free.limitMicro, 0)
  assert.equal(credited.wallet.balanceMicro, 2_000_000, 'the credit joins the wallet')
  assert.equal(credited.total.remainingMicro, 2_000_000)
  assert.equal(credited.quota.exhausted, false, 'and it unblocks the account')

  // A second claim for the same task is a no-op, not a second credit.
  const again = await fetch(`${gatewayUrl}/reward/complete`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: task.taskId }),
  })
  assert.equal(again.status, 200)
  assert.equal(((await again.json()) as { duplicated: boolean }).duplicated, true)

  // And the model path is open again.
  const response = await chat()
  assert.notEqual(response.status, 429)
})

test('an account the operator did not open has no task and gets no offer', async () => {
  writeSetting(db, 'quota.rewardAccounts', '')
  const started = await fetch(`${gatewayUrl}/reward/start`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  assert.equal(started.status, 429)
  assert.deepEqual(await started.json(), { error: 'reward-unavailable' })
  const meter = (await (await fetch(`${gatewayUrl}/quota`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
    reward: unknown
  }
  assert.equal(meter.reward, null)
})

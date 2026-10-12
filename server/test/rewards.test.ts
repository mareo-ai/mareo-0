// The reward mechanism, exercised through the server-side path only: a
// completion is accepted because the gateway verified it, never because a client
// said so.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createTokenAccount, openDatabase, type GatewayDatabase } from '../src/db.js'
import { completeRewardTask, creditReward, rewardOfferFor, startRewardTask } from '../src/rewards.js'
import { readSettings, type Settings } from '../src/settings.js'
import { walletBalanceMicro } from '../src/wallet.js'

const directory = mkdtempSync(path.join(tmpdir(), 'mareo-rewards-'))
const db: GatewayDatabase = openDatabase(path.join(directory, 'rewards.db'))

test.after(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

let accounts = 0
function newAccount(): string {
  accounts += 1
  return createTokenAccount(db, `奖励测试${accounts}`)
}

function settingsFor(account: string, overrides: Partial<Settings> = {}): Settings {
  // Start from the real defaults so a new setting cannot silently fall out of
  // this fixture; only what a test cares about is spelled out.
  return { ...readSettings(db), quotaMode: 'enforce', rewardAccounts: [account], ...overrides }
}

const start = new Date('2026-09-16T02:00:00.000Z')

test('only an account the operator opened rewards for is offered a task', () => {
  const account = newAccount()
  const other = newAccount()
  assert.equal(rewardOfferFor(db, account, settingsFor(account, { rewardAccounts: [] }), start), null)
  assert.equal(rewardOfferFor(db, account, settingsFor(account, { rewardAccounts: [other] }), start), null)
  assert.equal(rewardOfferFor(db, account, settingsFor(account, { quotaMode: 'off' }), start), null)
  assert.equal(rewardOfferFor(db, account, settingsFor(account, { rewardProvider: 'not-a-provider' }), start), null)
  const offer = rewardOfferFor(db, account, settingsFor(account), start)
  assert.equal(offer?.amountMicro, 1_000_000)
  assert.equal(offer?.remainingTasks, 3)
  assert.equal(startRewardTask(db, account, settingsFor(account, { rewardAccounts: [] }), start), null)
})

test('a completion is accepted only after the time the gateway itself requires', () => {
  const account = newAccount()
  const settings = settingsFor(account)
  const task = startRewardTask(db, account, settings, start)
  assert.ok(task !== null)
  assert.equal(task.minSeconds, 15)

  const tooSoon = completeRewardTask(db, account, task.taskId, settings, new Date(start.getTime() + 14_000))
  assert.deepEqual(tooSoon, { ok: false, reason: 'not-verified' })
  assert.equal(walletBalanceMicro(db, account), 0)

  const onTime = completeRewardTask(db, account, task.taskId, settings, new Date(start.getTime() + 15_000))
  assert.deepEqual(onTime, { ok: true, amountMicro: 1_000_000, duplicated: false })
  assert.equal(walletBalanceMicro(db, account), 1_000_000)

  // The client may retry a response it never saw; the ledger still holds one row.
  const retry = completeRewardTask(db, account, task.taskId, settings, new Date(start.getTime() + 60_000))
  assert.deepEqual(retry, { ok: true, amountMicro: 1_000_000, duplicated: true })
  assert.equal(walletBalanceMicro(db, account), 1_000_000)
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM wallet_ledger WHERE userId = ? AND source = 'reward_ad'").get(account) as { n: number }).n,
    1,
  )
})

test('a task cannot be completed by another account, or twice under a new id', () => {
  const account = newAccount()
  const other = newAccount()
  const settings = settingsFor(account, { rewardAccounts: [account, other] })
  const task = startRewardTask(db, account, settings, start)
  assert.ok(task !== null)
  const later = new Date(start.getTime() + 60_000)
  assert.deepEqual(completeRewardTask(db, other, task.taskId, settings, later), { ok: false, reason: 'unknown-task' })
  assert.deepEqual(completeRewardTask(db, account, 'no-such-task', settings, later), { ok: false, reason: 'unknown-task' })
  assert.deepEqual(completeRewardTask(db, account, 42, settings, later), { ok: false, reason: 'unknown-task' })
  assert.equal(completeRewardTask(db, account, task.taskId, settings, later).ok, true)
})

test('a reloaded client gets its open task back instead of a new one', () => {
  const account = newAccount()
  const settings = settingsFor(account)
  const first = startRewardTask(db, account, settings, start)
  const again = startRewardTask(db, account, settings, new Date(start.getTime() + 30_000))
  assert.equal(again?.taskId, first?.taskId)
  // After the reuse window a genuinely new task is issued.
  const muchLater = startRewardTask(db, account, settings, new Date(start.getTime() + 11 * 60_000))
  assert.notEqual(muchLater?.taskId, first?.taskId)
})

test('the daily count and the daily amount both cap rewards', () => {
  const account = newAccount()
  const settings = settingsFor(account, { rewardDailyLimit: 2, dailyRewardCapMicro: 5_000_000 })
  for (let index = 0; index < 2; index += 1) {
    const at = new Date(start.getTime() + index * 3600_000)
    const task = startRewardTask(db, account, settings, at)
    assert.ok(task !== null, `task ${index} should be offered`)
    const done = completeRewardTask(db, account, task.taskId, settings, new Date(at.getTime() + 20_000))
    assert.equal(done.ok, true)
  }
  assert.equal(walletBalanceMicro(db, account), 2_000_000)
  const third = startRewardTask(db, account, settings, new Date(start.getTime() + 3 * 3600_000))
  assert.equal(third, null, 'the daily count is exhausted')
  assert.equal(rewardOfferFor(db, account, settings, new Date(start.getTime() + 3 * 3600_000)), null)
})

test('the daily amount ceiling stops a reward even when the count allows it', () => {
  const account = newAccount()
  const settings = settingsFor(account, { rewardDailyLimit: 10, dailyRewardCapMicro: 1_500_000 })
  const first = startRewardTask(db, account, settings, start)
  assert.ok(first !== null)
  assert.equal(completeRewardTask(db, account, first.taskId, settings, new Date(start.getTime() + 20_000)).ok, true)
  assert.equal(walletBalanceMicro(db, account), 1_000_000)
  // A second reward could not be paid in full, so it is not offered at all.
  assert.equal(startRewardTask(db, account, settings, new Date(start.getTime() + 60_000)), null)

  // Tightening the ceiling while a task is open is still enforced at completion.
  const account2 = newAccount()
  const open = settingsFor(account2, { rewardDailyLimit: 10, dailyRewardCapMicro: 1_500_000 })
  const task = startRewardTask(db, account2, open, start)
  assert.ok(task !== null)
  const tightened = { ...open, dailyRewardCapMicro: 500_000 }
  assert.deepEqual(completeRewardTask(db, account2, task.taskId, tightened, new Date(start.getTime() + 20_000)), {
    ok: false,
    reason: 'daily-limit',
  })
  assert.equal(walletBalanceMicro(db, account2), 0)
})

test('yesterday\'s completions do not consume today\'s allowance', () => {
  const account = newAccount()
  const settings = settingsFor(account, { rewardDailyLimit: 1 })
  const yesterday = new Date('2026-09-15T02:00:00.000Z')
  const task = startRewardTask(db, account, settings, yesterday)
  assert.ok(task !== null)
  assert.equal(completeRewardTask(db, account, task.taskId, settings, new Date(yesterday.getTime() + 20_000)).ok, true)
  assert.equal(startRewardTask(db, account, settings, yesterday), null)
  const today = startRewardTask(db, account, settings, new Date('2026-09-16T02:00:00.000Z'))
  assert.ok(today !== null, 'a new Beijing day offers a new task')
})

test('a task is verified by the provider that issued it, not by whatever is configured now', () => {
  const account = newAccount()
  const settings = settingsFor(account)
  const task = startRewardTask(db, account, settings, start)
  assert.ok(task !== null)
  // Switching the configured provider mid-task must not invalidate a task that
  // was already handed out.
  const renamed = { ...settings, rewardProvider: 'some-other-network' }
  const done = completeRewardTask(db, account, task.taskId, renamed, new Date(start.getTime() + 60_000))
  assert.equal(done.ok, true)

  // A task whose provider the server cannot resolve is refused rather than
  // trusted, which is what a forged row would look like.
  const orphan = newAccount()
  db.prepare(
    'INSERT INTO reward_tasks (taskId, accountId, provider, amountMicro, minSeconds, createdAt, completedAt) VALUES (?, ?, ?, ?, ?, ?, NULL)',
  ).run('orphan-task', orphan, 'unknown-provider', 1_000_000, 0, start.toISOString())
  assert.deepEqual(
    completeRewardTask(db, orphan, 'orphan-task', settingsFor(orphan), new Date(start.getTime() + 60_000)),
    { ok: false, reason: 'provider-mismatch' },
  )
  assert.equal(walletBalanceMicro(db, orphan), 0)
})

test('creditReward reports whether it actually wrote a row', () => {
  const account = newAccount()
  assert.equal(creditReward(db, account, 'commerce', 'order-1', 500_000, start), true)
  assert.equal(creditReward(db, account, 'commerce', 'order-1', 500_000, start), false)
  // The same id under a different provider is a different grant.
  assert.equal(creditReward(db, account, 'campaign', 'order-1', 500_000, start), true)
  assert.equal(walletBalanceMicro(db, account), 1_000_000)
})

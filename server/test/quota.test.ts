// What an account may still spend: today's free allowance first, then the
// wallet. These tests pin the arithmetic, the reset boundary, and who sees it.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createTokenAccount, openDatabase, type GatewayDatabase } from '../src/db.js'
import { recordUsage } from '../src/usage.js'
import { costOf, settleMicro, type TokenUsage } from '../src/pricing.js'
import { creditState, dailyAllowanceMicro, freeUsedMicroToday, quotaVisible } from '../src/quota.js'
import { chargeWallet, grantCredit, walletBalanceMicro } from '../src/wallet.js'
import { DEFAULT_SETTLEMENT_RATE, parseFreeTiers, parseModelRates, readSettings, settlementRateFor, writeSetting } from '../src/settings.js'
import { dayStamp, startOfDay } from '../src/clock.js'
import { quotaImpact, type Row } from '../src/cost-report.js'

const directory = mkdtempSync(path.join(tmpdir(), 'mareo-quota-'))
const db: GatewayDatabase = openDatabase(path.join(directory, 'quota.db'))

test.after(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

let accounts = 0
function newAccount(): string {
  accounts += 1
  return createTokenAccount(db, `额度测试${accounts}`)
}

const sample: TokenUsage = { inputTokens: 1_000_000, cacheHitTokens: 1_000_000, cacheMissTokens: 0, outputTokens: 0, reasoningTokens: 0 }

/**
 * One request row exactly as the gateway now writes it: priced, split between the
 * buckets, and — when the wallet paid — with the matching debit.
 */
function addUsage(
  userId: string,
  options: { when?: string; model?: string; paidFromWallet?: boolean } = {},
): number {
  const model = options.model ?? 'deepseek-flash'
  const at = new Date(options.when ?? Date.now())
  const cost = costOf(sample, model, at)
  assert.ok(cost !== undefined, 'the sample request must be priceable')
  const { actualMicro, billableMicro, marginMicro } = settleMicro(cost, DEFAULT_SETTLEMENT_RATE)
  const paidFromFreeMicro = options.paidFromWallet === true ? 0 : billableMicro
  const id = recordUsage(db, {
    userId,
    model,
    promptChars: 0,
    completionChars: 0,
    status: 200,
    latencyMs: 0,
    tokens: sample,
    usageSource: 'provider',
    billing: { actualMicro, billableMicro, marginMicro, paidFromFreeMicro },
  })
  if (options.when !== undefined) db.prepare('UPDATE usage SET ts = ? WHERE id = ?').run(options.when, id)
  if (options.paidFromWallet === true) {
    chargeWallet(db, { accountId: userId, amountMicro: billableMicro, relatedRequestId: id, now: at })
  }
  return billableMicro
}

function settingsFor(overrides: Partial<ReturnType<typeof readSettings>> = {}): ReturnType<typeof readSettings> {
  return { ...readSettings(db), quotaMode: 'enforce', dailyFreeMicro: 10_000_000, ...overrides }
}

test('the free allowance counts what today\'s requests drew from it, and only that', () => {
  const account = newAccount()
  assert.equal(freeUsedMicroToday(db, account), 0)

  const first = addUsage(account)
  assert.ok(first > 0, 'the sample request must be charged something')
  assert.equal(freeUsedMicroToday(db, account), first)
  assert.equal(creditState(db, account, settingsFor()).freeRemainingMicro, 10_000_000 - first)

  // A request the wallet paid does not touch today's allowance.
  addUsage(account, { paidFromWallet: true })
  assert.equal(freeUsedMicroToday(db, account), first)

  // A request whose usage the provider never reported has no known cost: it must
  // not be charged as zero, and it must not consume the allowance either.
  recordUsage(db, {
    userId: account, model: 'deepseek-flash', promptChars: 0, completionChars: 0,
    status: 200, latencyMs: 0, usageSource: 'missing',
  })
  // A model with no price row cannot be charged either.
  recordUsage(db, {
    userId: account, model: 'deepseek-unknown', promptChars: 0, completionChars: 0,
    status: 200, latencyMs: 0, tokens: sample, usageSource: 'provider',
  })
  assert.equal(freeUsedMicroToday(db, account), first)
})

test('a new Beijing day refills the allowance; the wallet keeps its balance', () => {
  const account = newAccount()
  const yesterday = new Date(Date.parse(startOfDay()) - 60_000)
  addUsage(account, { when: yesterday.toISOString() })
  grantCredit(db, { accountId: account, amountMicro: 3_000_000, source: 'purchase', externalRef: 'ORDER-Y', now: yesterday })

  assert.equal(freeUsedMicroToday(db, account), 0, 'yesterday does not count against today')
  const state = creditState(db, account, settingsFor())
  assert.equal(state.freeRemainingMicro, 10_000_000, 'the free allowance is whole again')
  assert.equal(walletBalanceMicro(db, account), 3_000_000, 'the wallet is not a daily bucket')
})

test('the wallet starts paying exactly when the free allowance runs out', () => {
  const account = newAccount()
  const charged = addUsage(account)
  grantCredit(db, { accountId: account, amountMicro: 5_000_000, source: 'promotion', externalRef: 'GIFT-1' })

  const tight = creditState(db, account, settingsFor({ dailyFreeMicro: charged }))
  assert.equal(tight.freeRemainingMicro, 0)
  assert.equal(tight.walletMicro, 5_000_000)
  assert.equal(tight.totalRemainingMicro, 5_000_000, 'what is left is the wallet')
  assert.equal(tight.exhausted, false, 'a funded wallet means the account can still work')

  const comfortable = creditState(db, account, settingsFor({ dailyFreeMicro: charged + 1_000_000 }))
  assert.equal(comfortable.totalRemainingMicro, 6_000_000, 'free and wallet add up')
})

test('only both buckets being empty blocks an account, and an overdraft counts', () => {
  const account = newAccount()
  const charged = addUsage(account)
  const broke = settingsFor({ dailyFreeMicro: 0 })
  assert.equal(creditState(db, account, broke).exhausted, true)

  grantCredit(db, { accountId: account, amountMicro: charged, source: 'manual' })
  assert.equal(creditState(db, account, broke).exhausted, false)

  // One request that costs more than the balance: allowed, because it began with
  // credit, and it is what makes the next one impossible.
  addUsage(account, { paidFromWallet: true })
  const after = creditState(db, account, broke)
  assert.equal(after.walletMicro, charged - charged, 'the sample costs exactly the balance')
  assert.equal(after.exhausted, true)
})

test('an overdrawn wallet is carried as a negative balance', () => {
  const account = newAccount()
  const charged = addUsage(account)
  const state = creditState(db, account, settingsFor({ dailyFreeMicro: 0 }))
  assert.equal(state.walletMicro, 0)
  assert.equal(state.exhausted, true)

  grantCredit(db, { accountId: account, amountMicro: 1_000, source: 'manual' })
  chargeWallet(db, { accountId: account, amountMicro: 5_000, relatedRequestId: 1 })
  const over = creditState(db, account, settingsFor({ dailyFreeMicro: 0 }))
  assert.equal(over.walletMicro, -4_000)
  assert.equal(over.totalRemainingMicro, 0, 'a debt is not spendable credit')
  assert.equal(over.exhausted, true)
  assert.ok(charged > 0)
})

test('the free allowance never goes below zero, however far a day overshoots', () => {
  const account = newAccount()
  addUsage(account)
  addUsage(account)
  const state = creditState(db, account, settingsFor({ dailyFreeMicro: 1 }))
  assert.equal(state.freeRemainingMicro, 0)
  assert.equal(state.freeUsedMicro > state.freeLimitMicro, true, 'the overshoot stays visible in the usage figure')
})

test('off hides the meter from everyone; shadow only from the allowlist; enforce from nobody', () => {
  const account = newAccount()
  const other = newAccount()
  const base = readSettings(db)
  assert.equal(quotaVisible({ ...base, quotaMode: 'off', rewardAccounts: [account] }, account), false)
  assert.equal(quotaVisible({ ...base, quotaMode: 'shadow', rewardAccounts: [] }, account), false)
  assert.equal(quotaVisible({ ...base, quotaMode: 'shadow', rewardAccounts: [account] }, account), true)
  assert.equal(quotaVisible({ ...base, quotaMode: 'shadow', rewardAccounts: [other] }, account), false)
  assert.equal(quotaVisible({ ...base, quotaMode: 'enforce', rewardAccounts: [] }, account), true)
  assert.equal(quotaVisible({ ...base, quotaMode: 'enforce', rewardAccounts: [other] }, account), true)
})

test('a broken setting falls back to the default instead of to zero', () => {
  writeSetting(db, 'quota.dailyFreeMicro', '2500000')
  assert.equal(readSettings(db).dailyFreeMicro, 2_500_000)
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updatedAt) VALUES ('quota.dailyFreeMicro', 'not-a-number', 'x')").run()
  // Zero would block every account; the default is the safe direction.
  assert.equal(readSettings(db).dailyFreeMicro, 10_000_000)
  db.prepare("DELETE FROM settings WHERE key = 'quota.dailyFreeMicro'").run()
  assert.equal(readSettings(db).dailyFreeMicro, 10_000_000)
  assert.throws(() => writeSetting(db, 'quota.mode', 'sometimes'), /off/)
  assert.throws(() => writeSetting(db, 'quota.unknown', '1'), /未知配置项/)
})

test('the settlement rate has a default and per-model overrides', () => {
  assert.equal(readSettings(db).settlementRate, DEFAULT_SETTLEMENT_RATE)
  assert.equal(settlementRateFor(readSettings(db), 'deepseek-v4-pro'), DEFAULT_SETTLEMENT_RATE)

  writeSetting(db, 'billing.modelRates', 'deepseek-v4-pro:1.5')
  const settings = readSettings(db)
  assert.equal(settings.settlementRate, DEFAULT_SETTLEMENT_RATE)
  assert.equal(settlementRateFor(settings, 'deepseek-v4-pro'), 1.5, 'the override wins for that model')
  assert.equal(settlementRateFor(settings, 'deepseek-flash'), DEFAULT_SETTLEMENT_RATE, 'everyone else keeps the default')
  assert.equal(settlementRateFor(settings, null), DEFAULT_SETTLEMENT_RATE)

  // A typo must be refused: silently falling back would be an invisible price cut.
  assert.throws(() => writeSetting(db, 'billing.modelRates', 'deepseek-v5-pro:1.5'), /未知模型/)
  assert.throws(() => writeSetting(db, 'billing.modelRates', 'no-colon'), /模型名:倍率/)
  assert.throws(() => writeSetting(db, 'billing.modelRates', 'deepseek-v4-pro:0'), /大于 0/)
  assert.throws(() => writeSetting(db, 'billing.settlementRate', '0'), /大于 0/)
  assert.throws(() => writeSetting(db, 'billing.settlementRate', 'free'), /大于 0/)

  // Reading is defensive too: a model that left the price table is dropped, the
  // rest of the table still applies.
  assert.deepEqual([...parseModelRates('deepseek-v4-pro:1.5, gone-model:2, deepseek-flash:1.25')], [
    ['deepseek-v4-pro', 1.5],
    ['deepseek-flash', 1.25],
  ])
  assert.equal(parseModelRates(undefined).size, 0)
  db.prepare("DELETE FROM settings WHERE key = 'billing.modelRates'").run()
})

test('shadow analysis counts the accounts and requests a threshold would stop', () => {
  const account = newAccount()
  const first = addUsage(account)
  const second = addUsage(account)
  const third = addUsage(account)
  const rows = db
    .prepare(
      `SELECT userId, ts, model, status, inputTokens, cacheHitTokens, cacheMissTokens,
              outputTokens, reasoningTokens, sessionId, usageSource, actualMicro, billableMicro
       FROM usage WHERE userId = ? ORDER BY id`,
    )
    .all(account) as unknown as Row[]

  // The line falls inside the second request: it is allowed to overrun (it began
  // with quota left), and the third is the first one the user cannot make.
  // `quotaImpact` takes a Beijing calendar day, which is `dayStamp`, not the
  // UTC-shaped instant `startOfDay` returns.
  const day = dayStamp()
  const tight = quotaImpact(rows, day, first + second / 2)
  assert.equal(tight.accounts, 1)
  assert.equal(tight.requests, 3)
  assert.equal(tight.blockedAccounts, 1)
  assert.equal(tight.blockedRequests, 1)
  // The estimate counts what the free allowance is drawn down by — the settlement
  // cost, not the real cost behind it.
  assert.equal(tight.costBeyondMicro, third)

  const generous = quotaImpact(rows, day, (first + second + third) * 100)
  assert.equal(generous.blockedAccounts, 0)
  assert.equal(generous.blockedRequests, 0)
  assert.equal(generous.costBeyondMicro, 0)
})

test('the daily allowance falls in steps as an account consumes it over its life', () => {
  const settings = {
    quotaMode: 'enforce' as const,
    dailyFreeMicro: 10_000_000,
    freeTiers: parseFreeTiers('30000000:6000000,60000000:4000000,100000000:3000000'),
    rewardAmountMicro: 0,
    dailyRewardCapMicro: 0,
    rewardMinSeconds: 0,
    rewardDailyLimit: 0,
    rewardAccounts: [],
    rewardProvider: 'fake-ad',
    settlementRate: 1.3,
    modelRates: new Map<string, number>(),
    blockedEmailDomains: [],
  }
  // Below the first threshold the full allowance applies.
  assert.equal(dailyAllowanceMicro(settings, 0), 10_000_000)
  assert.equal(dailyAllowanceMicro(settings, 29_999_999), 10_000_000)
  // Each boundary switches the whole day's allowance.
  assert.equal(dailyAllowanceMicro(settings, 30_000_000), 6_000_000)
  assert.equal(dailyAllowanceMicro(settings, 59_999_999), 6_000_000)
  assert.equal(dailyAllowanceMicro(settings, 60_000_000), 4_000_000)
  assert.equal(dailyAllowanceMicro(settings, 100_000_000), 3_000_000)
  // The floor holds no matter how much is consumed.
  assert.equal(dailyAllowanceMicro(settings, 900_000_000), 3_000_000)
})

test('consumption today does not shrink today\'s allowance, only tomorrow\'s', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mareo-tier-'))
  const db = openDatabase(path.join(directory, 'gateway.db'))
  const accountId = createTokenAccount(db, '分档测试')
  writeSetting(db, 'quota.mode', 'enforce')
  try {
    const settings = readSettings(db)
    // Yesterday's consumption puts the account at ¥29.9: still the top tier.
    db.prepare(`INSERT INTO usage (userId, ts, model, promptChars, completionChars, status, latencyMs, paidFromFreeMicro, billableMicro)
      VALUES (?, ?, 'deepseek-flash', 0, 0, 200, 0, ?, ?)`).run(
      accountId,
      new Date(Date.now() - 26 * 3600 * 1000).toISOString(),
      29_900_000,
      29_900_000,
    )
    const before = creditState(db, accountId, settings)
    assert.equal(before.freeLimitMicro, 10_000_000, '今天的额度仍是 ¥10')
    // Spending ¥12 today crosses the threshold, but not for today.
    db.prepare(`INSERT INTO usage (userId, ts, model, promptChars, completionChars, status, latencyMs, paidFromFreeMicro, billableMicro)
      VALUES (?, ?, 'deepseek-flash', 0, 0, 200, 0, ?, ?)`).run(
      accountId,
      new Date().toISOString(),
      12_000_000,
      12_000_000,
    )
    const after = creditState(db, accountId, settings)
    assert.equal(after.freeLimitMicro, 10_000_000, '当天跨档不缩水')
    assert.equal(after.freeRemainingMicro, 0, '当日额度用尽')
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

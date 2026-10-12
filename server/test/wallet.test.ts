// The wallet is the money: these tests pin the ledger arithmetic — what a
// balance is, that credit can only land once, and that an overdraft is visible.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createTokenAccount, openDatabase, type GatewayDatabase } from '../src/db.js'
import { chargeWallet, grantCredit, recentLedger, walletBalanceMicro, walletTotals } from '../src/wallet.js'

const directory = mkdtempSync(path.join(tmpdir(), 'mareo-wallet-'))
const db: GatewayDatabase = openDatabase(path.join(directory, 'wallet.db'))

test.after(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

let accounts = 0
function newAccount(): string {
  accounts += 1
  return createTokenAccount(db, `钱包测试${accounts}`)
}

test('the balance is the ledger, and every entry carries the balance after it', () => {
  const account = newAccount()
  assert.equal(walletBalanceMicro(db, account), 0, 'an account with no entries has nothing')

  grantCredit(db, { accountId: account, amountMicro: 10_000_000, source: 'purchase', externalRef: 'ORDER-1', channel: 'wechat' })
  assert.equal(walletBalanceMicro(db, account), 10_000_000)
  grantCredit(db, { accountId: account, amountMicro: 2_000_000, source: 'invite', externalRef: 'INVITE-1' })
  assert.equal(walletBalanceMicro(db, account), 12_000_000)

  const entries = recentLedger(db, account)
  assert.equal(entries.length, 2)
  // Newest first, and each row records where the balance stood after it.
  assert.deepEqual(
    entries.map((entry) => [entry.source, entry.amountMicro, entry.balanceAfterMicro]),
    [
      ['invite', 2_000_000, 12_000_000],
      ['purchase', 10_000_000, 10_000_000],
    ],
  )
  assert.equal(entries[1]!.channel, 'wechat')
  assert.equal(entries[1]!.externalRef, 'ORDER-1')
})

test('the same source reference credits once, however often it arrives', () => {
  const account = newAccount()
  const first = grantCredit(db, { accountId: account, amountMicro: 5_000_000, source: 'purchase', externalRef: 'ORDER-2' })
  assert.equal(first.duplicated, false)

  // A retried payment callback: same order, same amount.
  const again = grantCredit(db, { accountId: account, amountMicro: 5_000_000, source: 'purchase', externalRef: 'ORDER-2' })
  assert.equal(again.duplicated, true)
  assert.equal(again.entry.id, first.entry.id)
  assert.equal(walletBalanceMicro(db, account), 5_000_000, 'a replay must not double the balance')

  // A different source may reuse the same reference without colliding.
  grantCredit(db, { accountId: account, amountMicro: 1_000_000, source: 'invite', externalRef: 'ORDER-2' })
  assert.equal(walletBalanceMicro(db, account), 6_000_000)

  // Without a reference there is nothing to deduplicate on: each grant counts.
  grantCredit(db, { accountId: account, amountMicro: 1_000_000, source: 'manual' })
  grantCredit(db, { accountId: account, amountMicro: 1_000_000, source: 'manual' })
  assert.equal(walletBalanceMicro(db, account), 8_000_000)
})

test('amounts and sources are checked rather than trusted', () => {
  const account = newAccount()
  assert.throws(() => grantCredit(db, { accountId: account, amountMicro: 0, source: 'manual' }), /正整数微元/)
  assert.throws(() => grantCredit(db, { accountId: account, amountMicro: 1.5, source: 'manual' }), /正整数微元/)
  assert.throws(
    () => grantCredit(db, { accountId: account, amountMicro: 1, source: 'bribe' as unknown as 'manual' }),
    /未知的额度来源/,
  )
  assert.equal(walletBalanceMicro(db, account), 0, 'a rejected grant must not move money')
})

test('spending may overdraw the wallet, and the next spend is what notices', () => {
  const account = newAccount()
  grantCredit(db, { accountId: account, amountMicro: 10_000, source: 'manual' })
  const debit = chargeWallet(db, { accountId: account, amountMicro: 50_000, relatedRequestId: 1 })
  assert.equal(debit.type, 'debit')
  assert.equal(debit.source, 'model_usage')
  assert.equal(debit.balanceAfterMicro, -40_000, 'the overdraft is carried, not clamped')
  assert.equal(walletBalanceMicro(db, account), -40_000)
  assert.throws(() => chargeWallet(db, { accountId: account, amountMicro: 0, relatedRequestId: 2 }), /正整数微元/)
})

test('a top-up after an overdraft starts from the negative balance', () => {
  const account = newAccount()
  grantCredit(db, { accountId: account, amountMicro: 1_000, source: 'manual' })
  chargeWallet(db, { accountId: account, amountMicro: 5_000, relatedRequestId: 1 })
  grantCredit(db, { accountId: account, amountMicro: 10_000, source: 'purchase', externalRef: 'ORDER-3' })
  assert.equal(walletBalanceMicro(db, account), 6_000, 'the debt is settled by the top-up, not forgiven')
})

test('totals separate money taken in, money granted, and money spent', () => {
  // The totals are a whole-database figure, so this test gets its own database
  // instead of inheriting the money the tests above moved.
  const isolated = openDatabase(path.join(directory, 'totals.db'))
  try {
    const account = createTokenAccount(isolated, '钱包汇总')
    grantCredit(isolated, { accountId: account, amountMicro: 10_000_000, source: 'purchase', externalRef: 'ORDER-4', channel: 'alipay' })
    grantCredit(isolated, { accountId: account, amountMicro: 2_000_000, source: 'invite', externalRef: 'INVITE-4' })
    grantCredit(isolated, { accountId: account, amountMicro: 500_000, source: 'reward_ad', externalRef: 'fake-ad:task-4' })
    chargeWallet(isolated, { accountId: account, amountMicro: 3_000_000, relatedRequestId: 1 })

    const totals = walletTotals(isolated)
    assert.equal(totals.balanceMicro, 9_500_000, 'balance is credits minus spending')
    assert.equal(totals.creditedMicro, 12_500_000)
    assert.equal(totals.consumedMicro, 3_000_000)
    assert.equal(totals.creditedBySource.get('purchase'), 10_000_000)
    assert.equal(totals.creditedBySource.get('invite'), 2_000_000)
    assert.equal(totals.creditedBySource.get('reward_ad'), 500_000)
  } finally {
    isolated.close()
  }
})

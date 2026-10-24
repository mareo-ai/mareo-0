import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createTokenAccount, openDatabase, type GatewayDatabase } from '../src/db.js'
import { ensureInviteCode, inviteSummary, recordInvite, settleInviteForUser } from '../src/invites.js'
import { readSettings, writeSetting } from '../src/settings.js'
import { walletBalanceMicro } from '../src/wallet.js'

function harness() {
  const directory = mkdtempSync(path.join(tmpdir(), 'mareo-invite-'))
  const db = openDatabase(path.join(directory, 'gateway.db'))
  return { db, directory }
}

/** Backdates an account so the 24-hour condition is satisfied. */
function age(db: GatewayDatabase, accountId: string, hours: number): void {
  db.prepare('UPDATE users SET createdAt = ? WHERE id = ?').run(new Date(Date.now() - hours * 3_600_000).toISOString(), accountId)
}

test('an invite code is created on demand and stays stable', () => {
  const { db, directory } = harness()
  try {
    const accountId = createTokenAccount(db, '邀请码')
    const first = ensureInviteCode(db, accountId)
    assert.match(first, /^[2-9A-HJ-NP-Z]{8}$/)
    assert.equal(ensureInviteCode(db, accountId), first, '第二次取到同一个码')
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a reward waits for the invited account to age, then pays once', () => {
  const { db, directory } = harness()
  try {
    const settings = readSettings(db)
    const inviter = createTokenAccount(db, '邀请人')
    const invitee = createTokenAccount(db, '被邀请人')
    const code = ensureInviteCode(db, inviter)
    assert.equal(recordInvite(db, invitee, code), true)

    // Still brand new: nothing is paid, however many requests succeed.
    settleInviteForUser(db, invitee, settings)
    settleInviteForUser(db, invitee, settings)
    assert.equal(walletBalanceMicro(db, inviter), 0)

    age(db, invitee, 25)
    settleInviteForUser(db, invitee, settings)
    assert.equal(walletBalanceMicro(db, inviter), 5_000_000, '¥5 到账')

    // Idempotent: the row is no longer pending.
    settleInviteForUser(db, invitee, settings)
    assert.equal(walletBalanceMicro(db, inviter), 5_000_000)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an account cannot invite itself, and an unknown code is ignored', () => {
  const { db, directory } = harness()
  try {
    const accountId = createTokenAccount(db, '自己')
    const code = ensureInviteCode(db, accountId)
    assert.equal(recordInvite(db, accountId, code), false, '自己邀请自己被拒')
    assert.equal(recordInvite(db, accountId, 'ZZZZZZZZ'), false, '不存在的码被忽略而不是报错')
    assert.equal(recordInvite(db, accountId, code.toLowerCase()), false, '仍是自己')
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the fourth invitation stops earning', () => {
  const { db, directory } = harness()
  try {
    writeSetting(db, 'invite.maxPerInviter', '1')
    const settings = readSettings(db)
    const inviter = createTokenAccount(db, '上限')
    const code = ensureInviteCode(db, inviter)

    const first = createTokenAccount(db, '被邀请1')
    recordInvite(db, first, code)
    age(db, first, 25)
    settleInviteForUser(db, first, settings)
    assert.equal(walletBalanceMicro(db, inviter), 5_000_000)

    const second = createTokenAccount(db, '被邀请2')
    recordInvite(db, second, code)
    age(db, second, 25)
    settleInviteForUser(db, second, settings)
    assert.equal(walletBalanceMicro(db, inviter), 5_000_000, '达到上限后不再增加')
    assert.equal(inviteSummary(db, inviter, settings).remaining, 0)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  beginEmailCode,
  EMAIL_CODE_COOLDOWN_MS,
  EMAIL_DAILY_LIMIT,
  isBlockedEmail,
  normalizeEmail,
  verifyEmailCode,
} from '../src/email-auth.js'
import { findAccountByIdentity, findOrCreateAccountForIdentity, openDatabase, type GatewayDatabase } from '../src/db.js'

let directory: string
let db: GatewayDatabase

test.before(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'mareo-email-'))
  db = openDatabase(path.join(directory, 'email.db'))
})

test.after(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

test('sends a code that logs the account in once and is then consumed', () => {
  const email = 'alice@mareo.cn'
  const issued = beginEmailCode(db, email)
  assert.equal(issued.ok, true)
  assert.ok(issued.code && /^\d{6}$/.test(issued.code))

  assert.deepEqual(verifyEmailCode(db, email, '000000'), { ok: false, reason: 'wrong-code' })
  assert.deepEqual(verifyEmailCode(db, email, issued.code!), { ok: true })
  // Consumed: a second attempt has nothing to check against.
  assert.deepEqual(verifyEmailCode(db, email, issued.code!), { ok: false, reason: 'no-code' })
})

test('rejects after the attempt limit and when expired', () => {
  const email = 'bob@mareo.cn'
  const issued = beginEmailCode(db, email)
  assert.equal(issued.ok, true)
  // Five wrong guesses are allowed; the sixth is rejected as too-many.
  for (let i = 0; i < 5; i++) verifyEmailCode(db, email, '000000')
  assert.deepEqual(verifyEmailCode(db, email, '000000'), { ok: false, reason: 'too-many-attempts' })
  assert.deepEqual(verifyEmailCode(db, email, '000000'), { ok: false, reason: 'no-code' })

  const second = beginEmailCode(db, 'carol@mareo.cn')
  assert.equal(second.ok, true)
  db.prepare("UPDATE auth_codes SET expiresAt = '2000-01-01T00:00:00.000Z' WHERE channel = 'email' AND target = ?").run('carol@mareo.cn')
  assert.deepEqual(verifyEmailCode(db, 'carol@mareo.cn', second.code!), { ok: false, reason: 'expired' })
})

test('enforces cooldown and the daily per-address cap', () => {
  const email = 'dave@mareo.cn'
  assert.equal(beginEmailCode(db, email).ok, true)
  assert.deepEqual(beginEmailCode(db, email), { ok: false, reason: 'cooldown' })

  const capped = 'erin@mareo.cn'
  const nowIso = new Date().toISOString()
  for (let i = 0; i < EMAIL_DAILY_LIMIT; i++) {
    db.prepare('INSERT INTO auth_sends (channel, target, sentAt) VALUES (?, ?, ?)').run('email', capped, nowIso)
  }
  assert.deepEqual(beginEmailCode(db, capped), { ok: false, reason: 'daily-limit' })
})

test('verification mails normalize the address and auto-register an email identity', () => {
  const email = '  Frank@Mareo.cn '
  const normalized = normalizeEmail(email)
  assert.equal(normalized, 'frank@mareo.cn')

  const issued = beginEmailCode(db, email)
  assert.equal(issued.ok, true)
  assert.deepEqual(verifyEmailCode(db, email, issued.code!), { ok: true })

  // Signing in once auto-registers (the same step the HTTP handler performs).
  const account = findOrCreateAccountForIdentity(db, 'email', normalized, 'frank')
  assert.equal(account.displayName, 'frank')
  assert.deepEqual(findAccountByIdentity(db, 'email', normalized), account)
  // A second sign-in returns the same account.
  const again = findOrCreateAccountForIdentity(db, 'email', normalized, 'frank')
  assert.equal(again.id, account.id)
})

test('a plus tag or a Gmail dot is the same mailbox, not a second account', () => {
  // Otherwise one mailbox holds a separate account per alias, each with its own
  // daily allowance.
  assert.equal(normalizeEmail('Alice+work@Example.com'), 'alice@example.com')
  assert.equal(normalizeEmail('a.b.c@gmail.com'), 'abc@gmail.com')
  assert.equal(normalizeEmail('a.b.c@googlemail.com'), 'abc@googlemail.com')
  // Dots are meaningful at other providers and must survive.
  assert.equal(normalizeEmail('first.last@163.com'), 'first.last@163.com')
  assert.equal(normalizeEmail('  Mixed@QQ.com '), 'mixed@qq.com')
})

test('disposable domains are refused, including their subdomains', () => {
  const blocked = ['deepyinc.com', 'mailinator.com']
  assert.equal(isBlockedEmail('someone@deepyinc.com', blocked), true)
  assert.equal(isBlockedEmail('someone@mail.deepyinc.com', blocked), true)
  assert.equal(isBlockedEmail('someone@163.com', blocked), false)
  assert.equal(isBlockedEmail('not-deepyinc.com@163.com', blocked), false)
  assert.equal(isBlockedEmail('no-at-sign', blocked), false)
})

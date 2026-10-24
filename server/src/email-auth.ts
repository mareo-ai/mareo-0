import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import type { GatewayDatabase } from './db.js'

export const EMAIL_CODE_TTL_MS = 5 * 60 * 1000
export const EMAIL_CODE_COOLDOWN_MS = 60 * 1000
export const EMAIL_CODE_MAX_ATTEMPTS = 5
export const EMAIL_DAILY_LIMIT = 20

/**
 * The form two addresses are compared in. `+tag` and, for Gmail, dots are
 * delivery details rather than different people, so they are dropped: otherwise
 * one mailbox can hold as many accounts as it likes, each with its own daily
 * allowance. The original address is still what we send to.
 */
export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase()
  const at = trimmed.lastIndexOf('@')
  if (at <= 0) return trimmed
  const domain = trimmed.slice(at + 1)
  let local = trimmed.slice(0, at)
  const plus = local.indexOf('+')
  if (plus > 0) local = local.slice(0, plus)
  if (domain === 'gmail.com' || domain === 'googlemail.com') local = local.replace(/\./g, '')
  return `${local}@${domain}`
}

/** The part after `@`, or an empty string when there is none. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@')
  return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase()
}

/**
 * Whether this address belongs to a disposable-mail provider. The list is an
 * operator setting because the services rotate faster than a release: the first
 * batch was found in production, not predicted.
 */
export function isBlockedEmail(email: string, blockedDomains: string[]): boolean {
  const domain = emailDomain(email)
  if (domain === '') return false
  return blockedDomains.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`))
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

function secureEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function nowIso(): string {
  return new Date().toISOString()
}

export type SendOutcome =
  | { ok: true; code: string }
  | { ok: false; reason: 'cooldown' | 'daily-limit' }

/**
 * Issues and persists a fresh 6-digit code for an email address, subject to a
 * per-address cooldown and a daily cap. Returns whether sending is allowed.
 */
export function beginEmailCode(db: GatewayDatabase, email: string): SendOutcome {
  const target = normalizeEmail(email)
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const now = Date.now()

  const row = db.prepare('SELECT sentAt, attempts FROM auth_codes WHERE channel = ? AND target = ?').get('email', target) as
    | { sentAt: string; attempts: number }
    | undefined
  if (row !== undefined && now - Date.parse(row.sentAt) < EMAIL_CODE_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown' }
  }

  const nowDate = new Date(now)
  const dayStart = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate())).toISOString()
  const sentToday = db
    .prepare('SELECT COUNT(*) AS n FROM auth_sends WHERE channel = ? AND target = ? AND sentAt >= ?')
    .get('email', target, dayStart) as { n: number }
  if (sentToday.n >= EMAIL_DAILY_LIMIT) {
    return { ok: false, reason: 'daily-limit' }
  }

  db.prepare(
    `INSERT INTO auth_codes (channel, target, codeHash, attempts, expiresAt, sentAt)
     VALUES ('email', ?, ?, 0, ?, ?)
     ON CONFLICT (channel, target)
     DO UPDATE SET codeHash = excluded.codeHash, attempts = 0,
                   expiresAt = excluded.expiresAt, sentAt = excluded.sentAt`,
  ).run(target, hashCode(code), new Date(now + EMAIL_CODE_TTL_MS).toISOString(), nowIso())
  db.prepare('INSERT INTO auth_sends (channel, target, sentAt) VALUES (?, ?, ?)').run('email', target, nowIso())
  db.prepare('DELETE FROM auth_sends WHERE sentAt < ?').run(new Date(now - 2 * 24 * 3600 * 1000).toISOString())

  return { ok: true, code }
}

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; reason: 'no-code' | 'expired' | 'too-many-attempts' | 'wrong-code' }

/** Checks a submitted code against the latest stored one; succeeds consume it. */
export function verifyEmailCode(db: GatewayDatabase, email: string, submittedCode: string): VerifyOutcome {
  const target = normalizeEmail(email)
  const row = db
    .prepare('SELECT codeHash, attempts, expiresAt FROM auth_codes WHERE channel = ? AND target = ?')
    .get('email', target) as { codeHash: string; attempts: number; expiresAt: string } | undefined
  if (row === undefined) return { ok: false, reason: 'no-code' }
  if (Date.now() > Date.parse(row.expiresAt)) {
    db.prepare('DELETE FROM auth_codes WHERE channel = ? AND target = ?').run('email', target)
    return { ok: false, reason: 'expired' }
  }
  if (row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
    db.prepare('DELETE FROM auth_codes WHERE channel = ? AND target = ?').run('email', target)
    return { ok: false, reason: 'too-many-attempts' }
  }
  if (!secureEqual(hashCode(submittedCode.trim()), row.codeHash)) {
    db.prepare('UPDATE auth_codes SET attempts = attempts + 1 WHERE channel = ? AND target = ?').run('email', target)
    return { ok: false, reason: 'wrong-code' }
  }
  db.prepare('DELETE FROM auth_codes WHERE channel = ? AND target = ?').run('email', target)
  return { ok: true }
}

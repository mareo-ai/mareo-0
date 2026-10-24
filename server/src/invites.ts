/**
 * Invite links: an account's own code, who used it, and when the reward is due.
 *
 * The reward is not paid at sign-up. It is paid when the invited account makes
 * its first successful model call *and* has existed for a day — a fresh mailbox
 * costs nothing, so paying on registration would just fund bulk sign-ups.
 */
import { randomBytes } from 'node:crypto'
import type { GatewayDatabase } from './db.js'
import type { Settings } from './settings.js'
import { grantCredit } from './wallet.js'

/** Alphabet without look-alikes, so a code can be read out loud or typed. */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const CODE_LENGTH = 8

export interface InviteSummary {
  code: string
  /** How many rewards this account has already received. */
  granted: number
  /** How many more it can still receive. */
  remaining: number
  /** Total credit earned from invites, micro-yuan. */
  earnedMicro: number
}

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH)
  let code = ''
  for (let index = 0; index < CODE_LENGTH; index += 1) code += ALPHABET[bytes[index]! % ALPHABET.length]
  return code
}

/**
 * The account's code, created on first use. Uniqueness is enforced by an index,
 * so a collision retries rather than silently handing out someone else's code.
 */
export function ensureInviteCode(db: GatewayDatabase, accountId: string): string {
  const row = db.prepare('SELECT inviteCode FROM users WHERE id = ?').get(accountId) as { inviteCode: string | null } | undefined
  if (row?.inviteCode) return row.inviteCode
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateCode()
    try {
      db.prepare('UPDATE users SET inviteCode = ? WHERE id = ?').run(code, accountId)
      return code
    } catch {
      // Unique index rejected this candidate; try another.
    }
  }
  throw new Error('无法生成邀请码')
}

export function inviteSummary(db: GatewayDatabase, accountId: string, settings: Settings): InviteSummary {
  const code = ensureInviteCode(db, accountId)
  const granted = db
    .prepare("SELECT COUNT(*) AS n FROM invites WHERE inviterId = ? AND status = 'granted'")
    .get(accountId) as { n: number }
  return {
    code,
    granted: granted.n,
    remaining: Math.max(0, settings.inviteMaxPerInviter - granted.n),
    earnedMicro: granted.n * settings.inviteRewardMicro,
  }
}

/**
 * Records that `inviteeId` was invited by whoever owns `code`. Returns whether a
 * row was written. An unknown code is ignored rather than rejected, so a wrong
 * guess tells an attacker nothing.
 */
export function recordInvite(db: GatewayDatabase, inviteeId: string, code: string): boolean {
  const trimmed = code.trim().toUpperCase()
  if (trimmed === '') return false
  const inviter = db.prepare('SELECT id FROM users WHERE inviteCode = ?').get(trimmed) as { id: string } | undefined
  if (inviter === undefined || inviter.id === inviteeId) return false
  try {
    db.prepare('INSERT INTO invites (inviterId, inviteeId, code, status, createdAt) VALUES (?, ?, ?, ?, ?)').run(
      inviter.id,
      inviteeId,
      trimmed,
      'pending',
      new Date().toISOString(),
    )
    return true
  } catch {
    // inviteeId is unique: this account was already invited by someone.
    return false
  }
}

/**
 * Pays the inviter once the invited account qualifies. Called after a request
 * that succeeded, which is the evidence that the account is actually used.
 */
export function settleInviteForUser(db: GatewayDatabase, inviteeId: string, settings: Settings): void {
  const invite = db
    .prepare("SELECT id, inviterId FROM invites WHERE inviteeId = ? AND status = 'pending'")
    .get(inviteeId) as { id: number; inviterId: string } | undefined
  if (invite === undefined) return

  const account = db.prepare('SELECT createdAt FROM users WHERE id = ?').get(inviteeId) as { createdAt: string } | undefined
  if (account === undefined) return
  const ageHours = (Date.now() - Date.parse(account.createdAt)) / 3_600_000
  if (ageHours < settings.inviteMinAccountAgeHours) return

  const granted = db
    .prepare("SELECT COUNT(*) AS n FROM invites WHERE inviterId = ? AND status = 'granted'")
    .get(invite.inviterId) as { n: number }
  if (granted.n >= settings.inviteMaxPerInviter) {
    db.prepare("UPDATE invites SET status = 'capped' WHERE id = ?").run(invite.id)
    return
  }

  grantCredit(db, {
    accountId: invite.inviterId,
    amountMicro: settings.inviteRewardMicro,
    source: 'invite',
    externalRef: `invite:${invite.id}`,
  })
  db.prepare("UPDATE invites SET status = 'granted', grantedAt = ? WHERE id = ?").run(new Date().toISOString(), invite.id)
}

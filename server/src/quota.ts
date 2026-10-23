/**
 * What an account may still spend: today's free allowance first, then the
 * Mareo Wallet. Both sides are micro-yuan, the unit the accounting uses, so
 * "remaining" is real money rather than a request count.
 *
 * Neither side is a counter we maintain. The free side is the sum of what today's
 * requests drew from it, and the wallet side is the last ledger row — so a
 * number in the UI can always be traced back to the rows that produced it.
 */
import type { GatewayDatabase } from './db.js'
import { startOfDay } from './clock.js'
import type { Settings } from './settings.js'
import { walletBalanceMicro } from './wallet.js'

export interface CreditState {
  /** Today's free allowance. */
  freeLimitMicro: number
  /** How much of today's free allowance is spent. */
  freeUsedMicro: number
  /** Never negative: the free bucket stops at zero. */
  freeRemainingMicro: number
  /** Wallet balance, which an allowed overdraft can leave below zero. */
  walletMicro: number
  /** Free plus wallet, which is what the user could still spend. */
  totalRemainingMicro: number
  /** Whether a new request would be refused: both buckets are empty. */
  exhausted: boolean
  /** Next 00:00 Beijing, when the free allowance resets. */
  resetAt: string
  /** Whether this account is meant to see the meter at all. */
  visible: boolean
}

/**
 * How much free allowance this account has consumed over its whole life, before
 * today. This is what decides today's allowance: a heavy user drops a tier after
 * a few days, an occasional one keeps the top allowance for months.
 */
export function lifetimeFreeUsedMicro(db: GatewayDatabase, accountId: string, now = new Date()): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(paidFromFreeMicro), 0) AS total FROM usage WHERE userId = ? AND ts < ?')
    .get(accountId, startOfDay(now)) as { total: number }
  return row.total
}

/**
 * Today's allowance for an account whose lifetime consumption is `lifetime`.
 * The tiers are ordered ascending, so the last one that applies wins; below the
 * first threshold the full `quota.dailyFreeMicro` applies.
 */
export function dailyAllowanceMicro(settings: Settings, lifetime: number): number {
  let allowance = settings.dailyFreeMicro
  for (const tier of settings.freeTiers) {
    if (lifetime < tier.atMicro) break
    allowance = tier.allowanceMicro
  }
  return allowance
}

/**
 * What today's free allowance has covered. Requests recorded before billing
 * existed carry no figure and the day they were written is the day we deployed,
 * so the free bucket reads as refilled once — a one-day, one-off difference.
 */
export function freeUsedMicroToday(db: GatewayDatabase, accountId: string, now = new Date()): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(paidFromFreeMicro), 0) AS total FROM usage WHERE userId = ? AND ts >= ?')
    .get(accountId, startOfDay(now)) as { total: number }
  return row.total
}

/** The next 00:00 Beijing as an instant. China has no daylight saving. */
export function nextResetAt(now = new Date()): string {
  return new Date(Date.parse(startOfDay(now)) + 24 * 3600 * 1000).toISOString()
}

/**
 * Whether this account should see the meter. In `enforce` every account does;
 * in `shadow` only the reward allowlist does, so an unreleased mechanism stays
 * invisible to ordinary users while it is being measured.
 */
export function quotaVisible(settings: Settings, accountId: string): boolean {
  if (settings.quotaMode === 'off') return false
  return settings.quotaMode === 'enforce' || settings.rewardAccounts.includes(accountId)
}

export function creditState(
  db: GatewayDatabase,
  accountId: string,
  settings: Settings,
  now = new Date(),
): CreditState {
  const freeUsedMicro = freeUsedMicroToday(db, accountId, now)
  // Judged once per day from what was consumed before today, so a request that
  // crosses a tier boundary does not shrink the allowance it is being spent from.
  const freeLimitMicro = dailyAllowanceMicro(settings, lifetimeFreeUsedMicro(db, accountId, now))
  const freeRemainingMicro = Math.max(0, freeLimitMicro - freeUsedMicro)
  const walletMicro = walletBalanceMicro(db, accountId)
  return {
    freeLimitMicro,
    freeUsedMicro,
    freeRemainingMicro,
    walletMicro,
    totalRemainingMicro: freeRemainingMicro + Math.max(0, walletMicro),
    // Blocked only once both buckets are empty: a request that starts with
    // credit left is allowed to overrun it, so the boundary is not a cliff the
    // user cannot see coming.
    exhausted: freeRemainingMicro <= 0 && walletMicro <= 0,
    resetAt: nextResetAt(now),
    visible: quotaVisible(settings, accountId),
  }
}

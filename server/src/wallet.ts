/**
 * The Mareo Wallet: one persistent balance per account, fed by every kind of
 * credit (a purchase, an invite, an ad reward, a promotion) and spent on model
 * calls once the daily free allowance is gone.
 *
 * Two rules shape this module:
 *
 *   - The ledger is the truth. The balance is the last row's `balanceAfterMicro`,
 *     not a counter kept somewhere else, so it cannot drift from the rows and
 *     every number can be explained by reading them.
 *   - Credit enters through `grantCredit` only. Callers say where the money came
 *     from and what the source calls it; a repeated call with the same reference
 *     credits once.
 *
 * A debit may push the balance below zero: a request that starts with credit
 * left is allowed to finish even when it costs more than what is left, and the
 * negative balance is what blocks the next one.
 */
import type { GatewayDatabase } from './db.js'

/** Where credit came from. Adding one is a change to `docs/money/standard.md`. */
export const CREDIT_SOURCES = ['purchase', 'invite', 'reward_ad', 'promotion', 'affiliate', 'manual'] as const
export type CreditSource = (typeof CREDIT_SOURCES)[number]

export type LedgerType = 'credit' | 'debit'

export interface LedgerEntry {
  id: number
  userId: string
  type: LedgerType
  amountMicro: number
  source: string
  balanceAfterMicro: number
  relatedRequestId: number | null
  externalRef: string | null
  channel: string | null
  createdAt: string
}

export interface GrantCreditOptions {
  accountId: string
  /** Always positive; `grantCredit` decides the direction. */
  amountMicro: number
  source: CreditSource
  /** What the source calls this credit: an order number, a task id, an invite id. */
  externalRef?: string | null
  /** Payment channel, for purchases. */
  channel?: string | null
  now?: Date
}

export interface ChargeWalletOptions {
  accountId: string
  amountMicro: number
  /** The usage row this payment settles. */
  relatedRequestId: number
  now?: Date
}

/** Balance from the last ledger entry: what the account can still spend. */
export function walletBalanceMicro(db: GatewayDatabase, accountId: string): number {
  const row = db
    .prepare('SELECT balanceAfterMicro FROM wallet_ledger WHERE userId = ? ORDER BY id DESC LIMIT 1')
    .get(accountId) as { balanceAfterMicro: number } | undefined
  return row?.balanceAfterMicro ?? 0
}

/** Balance as of an instant, for a report that looks back at a finished day. */
export function walletBalanceAt(db: GatewayDatabase, accountId: string, untilIso: string): number {
  const row = db
    .prepare('SELECT balanceAfterMicro FROM wallet_ledger WHERE userId = ? AND createdAt < ? ORDER BY id DESC LIMIT 1')
    .get(accountId, untilIso) as { balanceAfterMicro: number } | undefined
  return row?.balanceAfterMicro ?? 0
}

function append(
  db: GatewayDatabase,
  entry: Omit<LedgerEntry, 'id'>,
): LedgerEntry {
  const result = db
    .prepare(
      `INSERT INTO wallet_ledger
         (userId, type, amountMicro, source, balanceAfterMicro, relatedRequestId, externalRef, channel, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.userId,
      entry.type,
      entry.amountMicro,
      entry.source,
      entry.balanceAfterMicro,
      entry.relatedRequestId,
      entry.externalRef,
      entry.channel,
      entry.createdAt,
    )
  return { id: Number(result.lastInsertRowid), ...entry }
}

/**
 * The one way credit enters a wallet. Returns the existing entry when the same
 * source reference was already credited, so a retried callback or a client that
 * retries a completion cannot pay twice.
 */
export function grantCredit(
  db: GatewayDatabase,
  options: GrantCreditOptions,
): { entry: LedgerEntry; duplicated: boolean } {
  const { accountId, amountMicro, source, externalRef = null, channel = null, now = new Date() } = options
  if (!Number.isInteger(amountMicro) || amountMicro <= 0) {
    throw new Error(`额度金额需要是正整数微元，收到 ${amountMicro}`)
  }
  if (!CREDIT_SOURCES.includes(source)) {
    throw new Error(`未知的额度来源 ${source}；可用：${CREDIT_SOURCES.join(', ')}`)
  }
  if (externalRef !== null) {
    const existing = db
      .prepare('SELECT * FROM wallet_ledger WHERE source = ? AND externalRef = ?')
      .get(source, externalRef) as LedgerEntry | undefined
    if (existing !== undefined) return { entry: existing, duplicated: true }
  }
  const balance = walletBalanceMicro(db, accountId) + amountMicro
  return {
    entry: append(db, {
      userId: accountId,
      type: 'credit',
      amountMicro,
      source,
      balanceAfterMicro: balance,
      relatedRequestId: null,
      externalRef,
      channel,
      createdAt: now.toISOString(),
    }),
    duplicated: false,
  }
}

/**
 * Spends wallet credit on a settled request. The caller has already decided how
 * much the free allowance covered, so this only records the rest — which may be
 * more than the balance, leaving it negative until the next top-up.
 */
export function chargeWallet(db: GatewayDatabase, options: ChargeWalletOptions): LedgerEntry {
  const { accountId, amountMicro, relatedRequestId, now = new Date() } = options
  if (!Number.isInteger(amountMicro) || amountMicro <= 0) {
    throw new Error(`扣减金额需要是正整数微元，收到 ${amountMicro}`)
  }
  const balance = walletBalanceMicro(db, accountId) - amountMicro
  return append(db, {
    userId: accountId,
    type: 'debit',
    amountMicro,
    source: 'model_usage',
    balanceAfterMicro: balance,
    relatedRequestId,
    externalRef: null,
    channel: null,
    createdAt: now.toISOString(),
  })
}

export interface WalletTotals {
  /** All-time balance: what Mareo currently owes its users. */
  balanceMicro: number
  /** Credit granted inside the window, by source. */
  creditedBySource: Map<string, number>
  /** How many entries each source credited inside the window. */
  creditedCountBySource: Map<string, number>
  creditedMicro: number
  /** Credit spent inside the window. */
  consumedMicro: number
}

/**
 * The numbers the report prints. `fromIso`/`toIso` bound the credits and the
 * spending; the balance is always the all-time figure, because a liability
 * cannot be windowed.
 */
export function walletTotals(db: GatewayDatabase, fromIso?: string, toIso?: string): WalletTotals {
  const conditions: string[] = []
  const params: string[] = []
  if (fromIso !== undefined) {
    conditions.push('createdAt >= ?')
    params.push(fromIso)
  }
  if (toIso !== undefined) {
    conditions.push('createdAt < ?')
    params.push(toIso)
  }
  const window = conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : ''

  const creditedBySource = new Map<string, number>()
  const creditedCountBySource = new Map<string, number>()
  const rows = db
    .prepare(
      `SELECT source, COALESCE(SUM(amountMicro), 0) AS total, COUNT(*) AS entries
       FROM wallet_ledger WHERE type = 'credit'${window} GROUP BY source`,
    )
    .all(...params) as { source: string; total: number; entries: number }[]
  for (const row of rows) {
    creditedBySource.set(row.source, row.total)
    creditedCountBySource.set(row.source, row.entries)
  }

  const consumed = db
    .prepare(`SELECT COALESCE(SUM(amountMicro), 0) AS total FROM wallet_ledger WHERE type = 'debit'${window}`)
    .get(...params) as { total: number }
  const balance = db
    .prepare("SELECT COALESCE(SUM(amountMicro), 0) AS total FROM wallet_ledger WHERE type = 'credit'")
    .get() as { total: number }
  const spent = db
    .prepare("SELECT COALESCE(SUM(amountMicro), 0) AS total FROM wallet_ledger WHERE type = 'debit'")
    .get() as { total: number }

  return {
    balanceMicro: balance.total - spent.total,
    creditedBySource,
    creditedCountBySource,
    creditedMicro: [...creditedBySource.values()].reduce((sum, value) => sum + value, 0),
    consumedMicro: consumed.total,
  }
}

/** Recent entries for one account, newest first. Used by the operator CLI. */
export function recentLedger(db: GatewayDatabase, accountId: string, limit = 20): LedgerEntry[] {
  return db
    .prepare('SELECT * FROM wallet_ledger WHERE userId = ? ORDER BY id DESC LIMIT ?')
    .all(accountId, limit) as unknown as LedgerEntry[]
}

/** Credit granted from tasks/rewards today: what the daily reward ceiling counts. */
export function rewardCreditMicroToday(db: GatewayDatabase, accountId: string, sinceIso: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amountMicro), 0) AS total FROM wallet_ledger
       WHERE userId = ? AND type = 'credit' AND source = 'reward_ad' AND createdAt >= ?`,
    )
    .get(accountId, sinceIso) as { total: number }
  return row.total
}

/**
 * Earning wallet credit by finishing a task.
 *
 * The wallet knows nothing about ads, surveys or commissions: it records that a
 * task finished and how much it was worth. A provider decides what a task is
 * and, crucially, how completion is verified — which is why `complete` is
 * server-side only. A real ad network proves completion with a signed
 * server-to-server callback; the fake provider below accepts a task that has
 * simply been open long enough. Swapping one for the other replaces a single
 * implementation, not the ledger.
 */
import { randomUUID } from 'node:crypto'
import type { GatewayDatabase } from './db.js'
import { dayStamp, startOfDay } from './clock.js'
import { grantCredit, rewardCreditMicroToday } from './wallet.js'
import type { Settings } from './settings.js'

export interface RewardOffer {
  provider: string
  label: string
  amountMicro: number
  minSeconds: number
  /** Tasks this account can still complete today. */
  remainingTasks: number
}

export interface RewardTaskRow {
  taskId: string
  accountId: string
  provider: string
  amountMicro: number
  minSeconds: number
  createdAt: string
  completedAt: string | null
}

export interface RewardProvider {
  id: string
  label: string
  /** Worth of one completion. */
  amountMicro(settings: Settings): number
  /** Shortest believable completion, measured from task start. */
  minSeconds(settings: Settings): number
  /**
   * Server-side check that the task really was completed. The fake provider has
   * nothing to check beyond the clock, which is exactly what makes it a
   * rehearsal for a provider that can verify more.
   */
  verify(task: RewardTaskRow, now: Date): boolean
}

const FAKE_AD_PROVIDER: RewardProvider = {
  id: 'fake-ad',
  label: '模拟任务（内部测试）',
  amountMicro: (settings) => settings.rewardAmountMicro,
  minSeconds: (settings) => settings.rewardMinSeconds,
  verify: (task, now) => now.getTime() - Date.parse(task.createdAt) >= task.minSeconds * 1000,
}

const PROVIDERS: Record<string, RewardProvider> = { [FAKE_AD_PROVIDER.id]: FAKE_AD_PROVIDER }

function providerFor(id: string): RewardProvider | undefined {
  return PROVIDERS[id]
}

function completedTasksToday(db: GatewayDatabase, accountId: string, now: Date): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM reward_tasks WHERE accountId = ? AND completedAt >= ?')
    .get(accountId, startOfDay(now)) as { n: number }
  return row.n
}

/**
 * The task on offer for this account, or null when there is nothing it may do:
 * rewards not open to it, unknown provider, or today's count/amount ceiling
 * already reached.
 */
export function rewardOfferFor(
  db: GatewayDatabase,
  accountId: string,
  settings: Settings,
  now = new Date(),
): RewardOffer | null {
  if (settings.quotaMode === 'off') return null
  // Rewards are opt-in per account: an account with everything else gets a
  // plain "try again tomorrow" instead of a task it is not allowed to finish.
  if (!settings.rewardAccounts.includes(accountId)) return null
  const provider = providerFor(settings.rewardProvider)
  if (provider === undefined) return null

  const amountMicro = provider.amountMicro(settings)
  if (amountMicro <= 0) return null
  const remainingTasks = settings.rewardDailyLimit - completedTasksToday(db, accountId, now)
  if (remainingTasks <= 0) return null
  if (rewardCreditMicroToday(db, accountId, startOfDay(now)) + amountMicro > settings.dailyRewardCapMicro) return null

  return {
    provider: provider.id,
    label: provider.label,
    amountMicro,
    minSeconds: provider.minSeconds(settings),
    remainingTasks,
  }
}

const OPEN_TASK_REUSE_MS = 10 * 60 * 1000

export interface AwardedTask {
  taskId: string
  provider: string
  label: string
  amountMicro: number
  minSeconds: number
  /** When the client may submit a completion. */
  completesAfter: string
}

/** Starts a task, reusing one the client abandoned a moment ago. */
export function startRewardTask(
  db: GatewayDatabase,
  accountId: string,
  settings: Settings,
  now = new Date(),
): AwardedTask | null {
  const offer = rewardOfferFor(db, accountId, settings, now)
  if (offer === null) return null

  const open = db
    .prepare('SELECT * FROM reward_tasks WHERE accountId = ? AND completedAt IS NULL ORDER BY createdAt DESC LIMIT 1')
    .get(accountId) as RewardTaskRow | undefined
  // A client that reloads mid-task gets the same task back instead of piling up
  // rows it will never finish.
  if (open !== undefined && now.getTime() - Date.parse(open.createdAt) < OPEN_TASK_REUSE_MS) {
    return {
      taskId: open.taskId,
      provider: open.provider,
      label: offer.label,
      amountMicro: open.amountMicro,
      minSeconds: open.minSeconds,
      completesAfter: new Date(Date.parse(open.createdAt) + open.minSeconds * 1000).toISOString(),
    }
  }

  const task: RewardTaskRow = {
    taskId: randomUUID(),
    accountId,
    provider: offer.provider,
    amountMicro: offer.amountMicro,
    minSeconds: offer.minSeconds,
    createdAt: now.toISOString(),
    completedAt: null,
  }
  db.prepare(
    'INSERT INTO reward_tasks (taskId, accountId, provider, amountMicro, minSeconds, createdAt, completedAt) VALUES (?, ?, ?, ?, ?, ?, NULL)',
  ).run(task.taskId, task.accountId, task.provider, task.amountMicro, task.minSeconds, task.createdAt)

  return {
    taskId: task.taskId,
    provider: task.provider,
    label: offer.label,
    amountMicro: task.amountMicro,
    minSeconds: task.minSeconds,
    completesAfter: new Date(now.getTime() + task.minSeconds * 1000).toISOString(),
  }
}

/**
 * Credits one finished task into the wallet. `externalId` is the provider's
 * identifier, and the wallet's unique reference makes the same completion credit
 * once, no matter how often the client retries.
 */
export function creditReward(
  db: GatewayDatabase,
  accountId: string,
  provider: string,
  externalId: string,
  amountMicro: number,
  now = new Date(),
): boolean {
  const { duplicated } = grantCredit(db, {
    accountId,
    amountMicro,
    source: 'reward_ad',
    externalRef: `${provider}:${externalId}`,
    now,
  })
  return !duplicated
}

export type CompletionResult =
  | { ok: true; amountMicro: number; duplicated: boolean }
  | { ok: false; reason: 'unknown-task' | 'not-verified' | 'daily-limit' | 'provider-mismatch' }

/**
 * The one place a completion turns into quota. A real provider's server
 * callback calls this with its own verified identifier; the client never
 * supplies an amount.
 */
export function completeRewardTask(
  db: GatewayDatabase,
  accountId: string,
  taskId: unknown,
  settings: Settings,
  now = new Date(),
): CompletionResult {
  if (typeof taskId !== 'string' || taskId === '') return { ok: false, reason: 'unknown-task' }
  const task = db
    .prepare('SELECT * FROM reward_tasks WHERE taskId = ? AND accountId = ?')
    .get(taskId, accountId) as RewardTaskRow | undefined
  if (task === undefined) return { ok: false, reason: 'unknown-task' }
  if (task.completedAt !== null) {
    // The client may retry a completion whose response it never saw; the ledger
    // row already exists, so report the same amount instead of crediting again.
    return { ok: true, amountMicro: task.amountMicro, duplicated: true }
  }
  const provider = providerFor(task.provider)
  if (provider === undefined) return { ok: false, reason: 'provider-mismatch' }
  if (!provider.verify(task, now)) return { ok: false, reason: 'not-verified' }

  const capReached =
    completedTasksToday(db, accountId, now) >= settings.rewardDailyLimit ||
    rewardCreditMicroToday(db, accountId, startOfDay(now)) + task.amountMicro > settings.dailyRewardCapMicro
  if (capReached) return { ok: false, reason: 'daily-limit' }

  db.exec('BEGIN')
  try {
    creditReward(db, accountId, task.provider, task.taskId, task.amountMicro, now)
    db.prepare('UPDATE reward_tasks SET completedAt = ? WHERE taskId = ?').run(now.toISOString(), task.taskId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { ok: true, amountMicro: task.amountMicro, duplicated: false }
}

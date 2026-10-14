// The cost report. Every number here comes from token counts the provider
// reported; byte counts are never used to price anything.
//
//   npm run cost                          # 按北京日的每日报表
//   npm run cost -- --bill 2026-09-16=57.69   # 与账单对账（可重复传入）
//
// Reconciliation is not optional decoration: when a bill is given, the report
// prints our total next to it and flags the deviation, so a wrong number is
// visible instead of plausible.
import { openDatabase, type GatewayDatabase } from './db.js'
import { costOf, type TokenUsage } from './pricing.js'
import { CATEGORY_LABELS, classifyTitle, type WorkCategory } from './session-labels.js'
import { readSettings } from './settings.js'
import { walletTotals } from './wallet.js'

const dbPath = process.env.DB_PATH ?? 'data/mareo.db'
const BEIJING_OFFSET_MS = 8 * 3600 * 1000

export interface Row {
  userId: string
  ts: string
  model: string | null
  status: number
  inputTokens: number | null
  cacheHitTokens: number | null
  cacheMissTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  sessionId: string | null
  usageSource: string | null
  requestKind: string | null
  /** What the request really cost and what the user was charged (v9). */
  actualMicro: number | null
  billableMicro: number | null
  marginMicro: number | null
  paidFromFreeMicro: number | null
}

/** The Beijing calendar day a timestamp belongs to. */
export function dayOf(ts: string): string {
  return new Date(new Date(ts).getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}

/** The instant a Beijing calendar day began, as ISO. */
export function beijingDayStart(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - BEIJING_OFFSET_MS).toISOString()
}

export function tokensOf(row: Row): TokenUsage | undefined {
  if (row.usageSource !== 'provider' || row.outputTokens === null) return undefined
  return {
    inputTokens: row.inputTokens ?? 0,
    cacheHitTokens: row.cacheHitTokens ?? 0,
    cacheMissTokens: row.cacheMissTokens ?? 0,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens ?? 0,
  }
}

export interface DaySummary {
  day: string
  requests: number
  pricedRequests: number
  /** 200s whose usage we failed to capture — a real accounting gap. */
  missingUsage: number
  /** Rows recorded before token capture existed: not a failure, just unpriceable. */
  legacyRequests: number
  cost: number
  unknownModelCost: number
  outputTokens: number
  reasoningTokens: number
  inputTokens: number
  cacheHitTokens: number
  /** Of the day's requests, the web searches — billed on the same table, but a
   *  different shape of traffic, so it is worth seeing on its own. */
  searchRequests: number
  searchCost: number
  unpricedModels: string[]
}

export function summarizeDays(rows: Row[]): Map<string, DaySummary> {
  const days = new Map<string, DaySummary>()
  for (const row of rows) {
    const day = dayOf(row.ts)
    if (!days.has(day)) {
      days.set(day, {
        day,
        requests: 0,
        pricedRequests: 0,
        missingUsage: 0,
        legacyRequests: 0,
        cost: 0,
        unknownModelCost: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        inputTokens: 0,
        cacheHitTokens: 0,
        searchRequests: 0,
        searchCost: 0,
        unpricedModels: [],
      })
    }
    const summary = days.get(day)!
    summary.requests += 1
    const isSearch = row.requestKind === 'search'
    if (isSearch) summary.searchRequests += 1
    if (row.status !== 200) continue
    const tokens = tokensOf(row)
    if (tokens === undefined) {
      // Distinguish "we failed to capture this" from "recorded before capture
      // existed": the first is a defect, the second is history.
      if (row.usageSource === 'missing') summary.missingUsage += 1
      else summary.legacyRequests += 1
      continue
    }
    const at = new Date(row.ts)
    const cost = costOf(tokens, row.model, at)
    if (cost === undefined) {
      // Unknown model: count it separately so it cannot silently look free.
      if (row.model !== null && !summary.unpricedModels.includes(row.model)) summary.unpricedModels.push(row.model)
      continue
    }
    summary.pricedRequests += 1
    summary.cost += cost
    if (isSearch) summary.searchCost += cost
    summary.outputTokens += tokens.outputTokens
    summary.reasoningTokens += tokens.reasoningTokens
    summary.inputTokens += tokens.inputTokens
    summary.cacheHitTokens += tokens.cacheHitTokens
  }
  return days
}

/** Per-user cost for one day, highest first. */
export function perUserCost(rows: Row[], day: string): { userId: string; requests: number; cost: number; hitRate: number | undefined }[] {
  const users = new Map<string, { requests: number; cost: number; input: number; hit: number }>()
  for (const row of rows) {
    if (dayOf(row.ts) !== day || row.status !== 200) continue
    const tokens = tokensOf(row)
    if (tokens === undefined) continue
    const cost = costOf(tokens, row.model, new Date(row.ts))
    if (cost === undefined) continue
    if (!users.has(row.userId)) users.set(row.userId, { requests: 0, cost: 0, input: 0, hit: 0 })
    const entry = users.get(row.userId)!
    entry.requests += 1
    entry.cost += cost
    entry.input += tokens.inputTokens
    entry.hit += tokens.cacheHitTokens
  }
  return [...users]
    .map(([userId, entry]) => ({
      userId,
      requests: entry.requests,
      cost: entry.cost,
      hitRate: entry.input === 0 ? undefined : entry.hit / entry.input,
    }))
    .sort((left, right) => right.cost - left.cost)
}

/** Cost per harness session for one day, highest first. */
export function perSessionCost(rows: Row[], day: string): { sessionId: string; requests: number; cost: number }[] {
  const sessions = new Map<string, { requests: number; cost: number }>()
  for (const row of rows) {
    if (dayOf(row.ts) !== day || row.status !== 200) continue
    const tokens = tokensOf(row)
    if (tokens === undefined) continue
    const cost = costOf(tokens, row.model, new Date(row.ts))
    if (cost === undefined) continue
    const key = row.sessionId ?? '(无 session)'
    if (!sessions.has(key)) sessions.set(key, { requests: 0, cost: 0 })
    const entry = sessions.get(key)!
    entry.requests += 1
    entry.cost += cost
  }
  return [...sessions].map(([sessionId, entry]) => ({ sessionId, ...entry })).sort((left, right) => right.cost - left.cost)
}

/** Percentile of a sorted-ascending list, using nearest-rank. */
export function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)
  return sorted[Math.max(0, index)]
}

export function parseBillArguments(argv: string[]): Map<string, number> {
  const bills = new Map<string, number>()
  for (const [index, argument] of argv.entries()) {
    if (argument !== '--bill') continue
    const value = argv[index + 1]
    const match = /^(\d{4}-\d{2}-\d{2})=([0-9.]+)$/.exec(value ?? '')
    if (match === null) {
      throw new Error(`--bill 需要 <北京日>=<元> 形式，例如 --bill 2026-09-14=57.69（收到 ${value ?? ''}）`)
    }
    bills.set(match[1], Number.parseFloat(match[2]))
  }
  return bills
}

function money(value: number): string {
  return `¥${value.toFixed(2)}`
}

function moneyMicro(micro: number): string {
  return money(micro / 1_000_000)
}

export interface SessionTitleRow {
  sessionId: string
  title: string
  source: string
}

/** Titles we could not attach to a session, newest first — the "what are they doing" feed. */
export function loadTitleFeed(db: GatewayDatabase, limit = 15): { accountId: string; title: string; source: string; updatedAt: string }[] {
  return db
    .prepare("SELECT accountId, title, source, updatedAt FROM session_titles WHERE sessionId LIKE 'unattributed:%' ORDER BY updatedAt DESC LIMIT ?")
    .all(limit) as unknown as { accountId: string; title: string; source: string; updatedAt: string }[]
}

export function loadSessionTitles(db: GatewayDatabase): Map<string, SessionTitleRow> {
  const rows = db
    .prepare('SELECT sessionId, title, source FROM session_titles')
    .all() as unknown as SessionTitleRow[]
  return new Map(rows.map((row) => [row.sessionId, row]))
}

/** Sessions grouped by the coarse category of their title. */
export function categoryBreakdown(titles: Map<string, SessionTitleRow>, sessionIds: string[]): [WorkCategory, number][] {
  const counts = new Map<WorkCategory, number>()
  for (const sessionId of sessionIds) {
    const title = titles.get(sessionId)?.title
    const category: WorkCategory = title === undefined ? 'other' : classifyTitle(title)
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  return [...counts].sort((left, right) => right[1] - left[1])
}

export function loadRows(db: GatewayDatabase): Row[] {
  return db
    .prepare(
      `SELECT userId, ts, model, status, inputTokens, cacheHitTokens, cacheMissTokens,
              outputTokens, reasoningTokens, sessionId, usageSource, requestKind,
              actualMicro, billableMicro, marginMicro, paidFromFreeMicro
       FROM usage ORDER BY id`,
    )
    .all() as unknown as Row[]
}

/**
 * What a daily quota of `thresholdMicro` would have done on that day: how many
 * accounts it would have stopped, and how much of the day's traffic sits beyond
 * the line. Counted in settlement cost, which is what the free allowance is
 * actually drawn down by, so these are the numbers enforcement would produce.
 * Rows recorded before billing existed carry no settlement figure and are
 * counted at their real cost — the deploy day, and only that day.
 */
export function quotaImpact(
  rows: Row[],
  day: string,
  thresholdMicro: number,
): { accounts: number; blockedAccounts: number; blockedRequests: number; requests: number; costBeyondMicro: number } {
  const perAccount = new Map<string, number[]>()
  for (const row of rows) {
    if (dayOf(row.ts) !== day) continue
    const tokens = tokensOf(row)
    if (tokens === undefined) continue
    const cost = costOf(tokens, row.model, new Date(row.ts))
    if (cost === undefined) continue
    const costs = perAccount.get(row.userId) ?? []
    costs.push(row.billableMicro ?? Math.round(cost * 1_000_000))
    perAccount.set(row.userId, costs)
  }

  let blockedAccounts = 0
  let blockedRequests = 0
  let requests = 0
  let costBeyondMicro = 0
  for (const costs of perAccount.values()) {
    requests += costs.length
    let cumulative = 0
    for (const micro of costs) {
      // The request that starts with quota left is allowed to overrun it; the
      // next one is the first the user cannot make.
      if (cumulative >= thresholdMicro) {
        blockedRequests += 1
        costBeyondMicro += micro
      }
      cumulative += micro
    }
    if (cumulative > thresholdMicro) blockedAccounts += 1
  }
  return { accounts: perAccount.size, blockedAccounts, blockedRequests, requests, costBeyondMicro }
}

export interface WalletAndMargin {
  day: string
  /** Money that came in as purchases — a liability, not revenue. */
  purchasedMicro: number
  purchaseCount: number
  /** Rewards and grants of the day, by source (purchases excluded). */
  grantedBySource: [string, number][]
  /** What users actually spent: the settlement side of the day. */
  consumedMicro: number
  /** All-time wallet balance: what Mareo owes its users right now. */
  balanceMicro: number
  actualMicro: number
  billableMicro: number
  marginMicro: number
  /** The real cost the free allowance covered: acquisition cost, not COGS. */
  freeCostMicro: number
  settledRequests: number
  /** 200s of the day with no billing figures: before billing existed, or no usage. */
  unbilledRequests: number
  /** The same day recomputed from its tokens, so a drift is visible. */
  recomputedMicro: number
  byModel: { model: string; requests: number; actualMicro: number; billableMicro: number; marginMicro: number }[]
}

/**
 * The day's money as `docs/money/standard.md` defines it: what came in, what was
 * granted, what was spent, and what was earned. Every figure is either a sum over
 * the ledger or a sum over the day's settled rows — nothing is estimated except
 * the free allowance's share of the real cost, which is apportioned per row.
 */
export function walletAndMargin(db: GatewayDatabase, rows: Row[], day: string): WalletAndMargin {
  const from = beijingDayStart(day)
  const to = new Date(Date.parse(from) + 24 * 3600 * 1000).toISOString()
  const totals = walletTotals(db, from, to)

  const byModel = new Map<string, { model: string; requests: number; actualMicro: number; billableMicro: number }>()
  let actualMicro = 0
  let billableMicro = 0
  let freeCostMicro = 0
  let settledRequests = 0
  let unbilledRequests = 0
  let recomputedMicro = 0
  for (const row of rows) {
    if (dayOf(row.ts) !== day || row.status !== 200) continue
    const tokens = tokensOf(row)
    if (tokens !== undefined) {
      const cost = costOf(tokens, row.model, new Date(row.ts))
      if (cost !== undefined) recomputedMicro += Math.round(cost * 1_000_000)
    }
    if (row.actualMicro === null || row.billableMicro === null) {
      unbilledRequests += 1
      continue
    }
    settledRequests += 1
    actualMicro += row.actualMicro
    billableMicro += row.billableMicro
    // The free allowance covered part of this request, so that share of its real
    // cost never earned anything. Attributed per row, not as a daily average.
    if (row.billableMicro > 0) {
      freeCostMicro += Math.round((row.actualMicro * (row.paidFromFreeMicro ?? 0)) / row.billableMicro)
    }
    const key = row.model ?? '(未知模型)'
    const entry = byModel.get(key) ?? { model: key, requests: 0, actualMicro: 0, billableMicro: 0 }
    entry.requests += 1
    entry.actualMicro += row.actualMicro
    entry.billableMicro += row.billableMicro
    byModel.set(key, entry)
  }

  return {
    day,
    purchasedMicro: totals.creditedBySource.get('purchase') ?? 0,
    purchaseCount: totals.creditedCountBySource.get('purchase') ?? 0,
    grantedBySource: [...totals.creditedBySource].filter(([source]) => source !== 'purchase').sort((left, right) => right[1] - left[1]),
    consumedMicro: totals.consumedMicro,
    balanceMicro: totals.balanceMicro,
    actualMicro,
    billableMicro,
    marginMicro: billableMicro - actualMicro,
    freeCostMicro,
    settledRequests,
    unbilledRequests,
    recomputedMicro,
    byModel: [...byModel.values()]
      .map((entry) => ({ ...entry, marginMicro: entry.billableMicro - entry.actualMicro }))
      .sort((left, right) => right.billableMicro - left.billableMicro),
  }
}

export interface RechargeSection {
  day: string
  /** Orders opened that day, whatever became of them. */
  orders: number
  byChannel: { channel: string; paid: number; paidMicro: number; orders: number }[]
  paid: number
  failed: number
  cancelled: number
  pending: number
  /** paid / (paid + failed + cancelled), with still-pending orders left out. */
  successRate: number | undefined
  topUpUsers: number
  /** Mean and P90 of paidAt − createdAt over the day's paid orders. */
  medianSeconds: number
  p90Seconds: number
  /** Orders still pending and unexpired right now, from any day. */
  stuckPending: number
}

/**
 * The day's recharge, as `docs/money/standard.md` §7 defines it. Orders are
 * counted on the Beijing day they were created; a payment that arrives after
 * midnight belongs to the day it was started, which is what an operator
 * reconciling a settlement file expects.
 */
export function rechargeReport(db: GatewayDatabase, day: string): RechargeSection {
  const from = beijingDayStart(day)
  const to = new Date(Date.parse(from) + 24 * 3600 * 1000).toISOString()
  const orders = db
    .prepare('SELECT provider, status, amountMicro, createdAt, paidAt FROM payment_orders WHERE createdAt >= ? AND createdAt < ?')
    .all(from, to) as unknown as { provider: string; status: string; amountMicro: number; createdAt: string; paidAt: string | null }[]

  const byChannel = new Map<string, { channel: string; paid: number; paidMicro: number; orders: number }>()
  const users = new Set<string>()
  const latencies: number[] = []
  let paid = 0
  let failed = 0
  let cancelled = 0
  let pending = 0
  for (const order of orders) {
    const entry = byChannel.get(order.provider) ?? { channel: order.provider, paid: 0, paidMicro: 0, orders: 0 }
    entry.orders += 1
    if (order.status === 'paid') {
      paid += 1
      entry.paid += 1
      entry.paidMicro += order.amountMicro
      if (order.paidAt !== null) latencies.push(Math.max(0, (Date.parse(order.paidAt) - Date.parse(order.createdAt)) / 1000))
    } else if (order.status === 'failed') failed += 1
    else if (order.status === 'cancelled') cancelled += 1
    else pending += 1
    byChannel.set(order.provider, entry)
  }
  for (const account of db
    .prepare("SELECT DISTINCT userId FROM payment_orders WHERE createdAt >= ? AND createdAt < ? AND status = 'paid'")
    .all(from, to) as unknown as { userId: string }[]) {
    users.add(account.userId)
  }

  latencies.sort((left, right) => left - right)
  const finished = paid + failed + cancelled
  const stuck = db
    .prepare("SELECT COUNT(*) AS n FROM payment_orders WHERE status = 'pending' AND expiresAt > ?")
    .get(new Date().toISOString()) as { n: number }
  return {
    day,
    orders: orders.length,
    byChannel: [...byChannel.values()].sort((left, right) => right.paidMicro - left.paidMicro),
    paid,
    failed,
    cancelled,
    pending,
    successRate: finished === 0 ? undefined : paid / finished,
    topUpUsers: users.size,
    medianSeconds: percentile(latencies, 0.5),
    p90Seconds: percentile(latencies, 0.9),
    stuckPending: stuck.n,
  }
}

function printRecharge(section: RechargeSection): void {
  const rate = section.successRate === undefined ? '—' : `${(section.successRate * 100).toFixed(1)}%`
  console.log(`  充值订单          ${String(section.orders).padStart(6)} 笔  成功 ${section.paid} · 失败 ${section.failed} · 取消 ${section.cancelled} · 待支付 ${section.pending}   成功率 ${rate}`)
  if (section.paid > 0) {
    console.log(`  充值人数          ${String(section.topUpUsers).padStart(6)} 人`)
    console.log(`  到账用时          中位 ${section.medianSeconds.toFixed(0)}s · P90 ${section.p90Seconds.toFixed(0)}s`)
  }
  for (const channel of section.byChannel) {
    console.log(`    ${channel.channel.padEnd(7)} ${String(channel.orders).padStart(5)} 笔下单 · ${channel.paid} 笔成功 · ${moneyMicro(channel.paidMicro)}`)
  }
  if (section.stuckPending > 0) {
    console.log(`  ⚠ 当前有 ${section.stuckPending} 笔待支付订单未过期（正常，但持续增长要看）`)
  }
}

function printWalletAndMargin(section: WalletAndMargin): void {
  const rate = section.billableMicro === 0 ? '—' : `${((section.marginMicro / section.billableMicro) * 100).toFixed(1)}%`
  console.log(`\n## ${section.day} 钱包与毛利（口径见 docs/money/standard.md）`)
  console.log(`  充值金额          ${moneyMicro(section.purchasedMicro).padStart(12)}   ${section.purchaseCount} 笔`)
  const granted =
    section.grantedBySource.length === 0
      ? '—'
      : section.grantedBySource.map(([source, micro]) => `${source} ${moneyMicro(micro)}`).join(' · ')
  console.log(`  奖励额度          ${granted}`)
  console.log(`  已消耗额度        ${moneyMicro(section.consumedMicro).padStart(12)}`)
  console.log(`  Wallet 余额       ${moneyMicro(section.balanceMicro).padStart(12)}   ← 截至现在的全站负债`)
  console.log(`  真实模型成本      ${moneyMicro(section.actualMicro).padStart(12)}`)
  console.log(`  结算成本          ${moneyMicro(section.billableMicro).padStart(12)}   ${section.settledRequests} 笔已结算请求`)
  console.log(`  毛利              ${moneyMicro(section.marginMicro).padStart(12)}   毛利率 ${rate}`)
  console.log(`  免费额度真实成本  ${moneyMicro(section.freeCostMicro).padStart(12)}   ← 获客成本，不计入 COGS`)
  console.log('  口径：1) 充值 ≠ 收入：充值是可消费余额（负债），只有被消耗才形成收入；')
  console.log('        2) 毛利只按已消耗口径计算，不按充值口径；')
  console.log('        3) 免费额度消耗不产生收入，但产生成本（获客成本）。')

  if (section.unbilledRequests > 0) {
    console.log(`  ℹ 该日 ${section.unbilledRequests} 笔 200 没有结算记录（计费上线前写入或缺 usage），未计入上面三项`)
  }
  // The day table prices the day from tokens; the section above reads the figures
  // written when the request was served. They must agree, or one of them is wrong.
  if (section.recomputedMicro !== section.actualMicro) {
    console.log(
      `  ⚠ 库内真实成本 ${moneyMicro(section.actualMicro)} 与按 token 重算 ${moneyMicro(section.recomputedMicro)} 不一致，需查因`,
    )
  }
  if (section.byModel.length > 0) {
    console.log('  按模型毛利（当日已结算请求）')
    console.log('    模型                          请求      真实成本      结算成本        毛利     毛利率')
    for (const entry of section.byModel) {
      const marginRate = entry.billableMicro === 0 ? '—' : `${((entry.marginMicro / entry.billableMicro) * 100).toFixed(1)}%`
      console.log(
        `    ${entry.model.padEnd(28)}${String(entry.requests).padStart(5)}` +
          moneyMicro(entry.actualMicro).padStart(14) +
          moneyMicro(entry.billableMicro).padStart(14) +
          moneyMicro(entry.marginMicro).padStart(12) +
          marginRate.padStart(11),
      )
    }
  }
}

function main(): void {
  const argv = process.argv.slice(2)
  const bills = parseBillArguments(argv)
  const dayArgument = argv.find((argument) => /^\d{4}-\d{2}-\d{2}$/.test(argument))
  const db = openDatabase(dbPath)
  const rows = loadRows(db)
  const days = summarizeDays(rows)

  // The report is about a day, and a day can hold money without holding model
  // traffic — a top-up whose owner has not sent a request yet. So the day to
  // report on is the newest one either source knows about.
  const orderDays = new Set(
    (db.prepare('SELECT createdAt FROM payment_orders').all() as unknown as { createdAt: string }[]).map((row) =>
      dayOf(row.createdAt),
    ),
  )
  const target = dayArgument ?? [...days.keys(), ...orderDays].sort().at(-1)
  if (target === undefined) {
    console.log('暂无数据。')
    return
  }

  console.log('# Mareo 成本报表（数据源：上游返回的 usage token，单价为官方人民币价）\n')

  console.log('日期(北京)   请求  有token  缺usage   历史   输出tok   思考tok   输入tok  命中率   成本      账单      偏差')
  for (const day of [...days.keys()].sort()) {
    const summary = days.get(day)!
    const hitRate = summary.inputTokens === 0 ? '—' : `${((summary.cacheHitTokens / summary.inputTokens) * 100).toFixed(1)}%`
    const bill = bills.get(day)
    const billText = bill === undefined ? '—' : money(bill)
    // A day that still holds pre-capture rows cannot be reconciled: its cost is
    // partial, so a deviation would be a lie.
    const partial = summary.legacyRequests > 0
    const deviation =
      bill === undefined || summary.cost === 0 || partial ? '—' : `${(((summary.cost - bill) / bill) * 100).toFixed(1)}%`
    console.log(
      day.padEnd(13) +
        String(summary.requests).padStart(5) +
        String(summary.pricedRequests).padStart(9) +
        String(summary.missingUsage).padStart(9) +
        String(summary.legacyRequests).padStart(7) +
        String(summary.outputTokens.toLocaleString('en-US')).padStart(11) +
        String(summary.reasoningTokens.toLocaleString('en-US')).padStart(11) +
        String(summary.inputTokens.toLocaleString('en-US')).padStart(10) +
        hitRate.padStart(8) +
        money(summary.cost).padStart(10) +
        billText.padStart(10) +
        deviation.padStart(9),
    )
    if (summary.searchRequests > 0) {
      console.log(`              ↳ 其中搜索 ${summary.searchRequests} 次 ${money(summary.searchCost)}`)
    }
    if (summary.unpricedModels.length > 0) {
      console.log(`              ⚠ 无价目表的模型（成本未计入）：${summary.unpricedModels.join(', ')}`)
    }
    if (summary.missingUsage > 0) {
      console.log(`              ⚠ ${summary.missingUsage} 次请求未拿到 usage（流被中断等），其成本未计入`)
    }
    if (partial) {
      console.log(`              ℹ ${summary.legacyRequests} 次请求早于 token 采集，无法计价——该日成本不完整，故不对账`)
    }
  }

  printWalletAndMargin(walletAndMargin(db, rows, target))
  printRecharge(rechargeReport(db, target))
  const users = perUserCost(rows, target)
  if (users.length > 0) {
    const costs = users.map((entry) => entry.cost).sort((left, right) => left - right)
    const total = users.reduce((sum, entry) => sum + entry.cost, 0)
    console.log(`\n## ${target} 每用户成本（当日有请求的账户 ${users.length} 个）`)
    console.log(`  人均 ${money(total / users.length)} | P50 ${money(percentile(costs, 0.5))} | P90 ${money(percentile(costs, 0.9))} | P99 ${money(percentile(costs, 0.99))} | 最高 ${money(costs.at(-1) ?? 0)}`)
    for (const entry of users.slice(0, 10)) {
      const hit = entry.hitRate === undefined ? '—' : `${(entry.hitRate * 100).toFixed(1)}%`
      console.log(`    ${entry.userId.slice(0, 8)}  ${String(entry.requests).padStart(5)} 次  命中率 ${hit.padStart(6)}  ${money(entry.cost)}`)
    }

    // Shadow mode has no runtime state: what a quota would have done is derived
    // from the same rows that priced the day, so the numbers below are exactly
    // the ones enforcement would later apply.
    const settings = readSettings(db)
    const thresholds = [...new Set([settings.dailyFreeMicro, 3_000_000, 5_000_000, 10_000_000])].sort((left, right) => left - right)
    console.log(`\n## ${target} 额度影响（影子估算，0 点重置；当前每日免费额度 ${money(settings.dailyFreeMicro / 1_000_000)}，模式 ${settings.quotaMode}）`)
    console.log('  阈值        会被挡账号   会被挡请求   占总请求   超出阈值的成本')
    for (const threshold of thresholds) {
      const impact = quotaImpact(rows, target, threshold)
      const share = impact.requests === 0 ? '—' : `${((impact.blockedRequests / impact.requests) * 100).toFixed(1)}%`
      const current = threshold === settings.dailyFreeMicro ? '  ← 当前配置' : ''
      console.log(
        money(threshold / 1_000_000).padStart(8) +
          `${impact.blockedAccounts}/${impact.accounts}`.padStart(13) +
          String(impact.blockedRequests).padStart(13) +
          share.padStart(11) +
          money(impact.costBeyondMicro / 1_000_000).padStart(15) +
          current,
      )
    }

    const sessions = perSessionCost(rows, target).filter((entry) => entry.sessionId !== '(无 session)')
    if (sessions.length > 0) {
      const sessionCosts = sessions.map((entry) => entry.cost).sort((left, right) => left - right)
      console.log(`\n## ${target} 每 session 成本（${sessions.length} 个会话）`)
      console.log(`  P50 ${money(percentile(sessionCosts, 0.5))} | P90 ${money(percentile(sessionCosts, 0.9))} | 最高 ${money(sessionCosts.at(-1) ?? 0)}`)
      for (const entry of sessions.slice(0, 5)) {
        console.log(`    ${entry.sessionId.slice(0, 12)}  ${String(entry.requests).padStart(5)} 次  ${money(entry.cost)}`)
      }
    } else {
      console.log('\n## 每 session 成本：暂无数据（客户端未上报 session 头）')
    }

    const feed = loadTitleFeed(db)
    if (feed.length > 0) {
      console.log(`\n## 会话标题流（未绑定到具体会话，最近 ${feed.length} 条）`)
      for (const entry of feed) {
        console.log(`    ${entry.updatedAt.slice(5, 16)}  ${entry.accountId.slice(0, 8)}  ${entry.title}  [${CATEGORY_LABELS[classifyTitle(entry.title)]}]`)
      }
    }

    const titles = loadSessionTitles(db)
    const sessionIds = [...new Set(rows.filter((row) => dayOf(row.ts) === target && row.sessionId !== null).map((row) => row.sessionId as string))]
    const bySession = new Map(perSessionCost(rows, target).map((entry) => [entry.sessionId, entry]))
    if (sessionIds.length > 0) {
      const labels = sessionIds.filter((sessionId) => titles.has(sessionId)).length
      console.log(`\n## ${target} 会话标签（${labels}/${sessionIds.length} 个会话有标题）`)
      const breakdown = categoryBreakdown(titles, sessionIds)
      console.log('  任务类型分布：' + breakdown.map(([category, count]) => `${CATEGORY_LABELS[category]} ${count}`).join(' · '))
      const rows_ = sessionIds
        .map((sessionId) => ({ sessionId, title: titles.get(sessionId)?.title, cost: bySession.get(sessionId)?.cost ?? 0, requests: bySession.get(sessionId)?.requests ?? 0 }))
        .sort((left, right) => right.cost - left.cost)
      for (const entry of rows_.slice(0, 12)) {
        const label = entry.title === undefined ? '（无标题）' : `${entry.title}  [${CATEGORY_LABELS[classifyTitle(entry.title)]}]`
        console.log(`    ${String(entry.requests).padStart(5)} 次  ${money(entry.cost).padStart(8)}  ${label}`)
      }
    }
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main()
}

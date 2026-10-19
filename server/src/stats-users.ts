/**
 * Who the users are and how deep they go: the week's shape, not the week's news.
 *
 * Everything here comes from rows that already exist — `usage` carries the
 * account, the timestamp, the session id and the real cost; `session_titles`
 * says what a session was about; `wallet_ledger` says whether someone paid. No
 * new instrumentation is needed for any of it.
 *
 * Two limits are stated on the page rather than hidden: a session can only be
 * counted when the client sent a session id (older builds do not), and a cohort
 * smaller than five is marked as too small to read as a rate.
 */
import type { GatewayDatabase } from './db.js'
import { dayStamp, dayStampDaysAgo } from './clock.js'
import { categorizeTask } from './stats-tasks.js'
import { escapeHtml, kpi, money, page, percent, stat, tableCaption } from './stats-html.js'
import { walletBalanceMicro } from './wallet.js'

/** Requests in the last seven days at or above this mark count as a heavy user. */
export const HEAVY_WEEKLY_REQUESTS = 1000
/** How far back a cohort is shown. D7 needs a week of room, plus a few days to read. */
const COHORT_DAYS = 14
/** Active days are read from a wider window so an old cohort's D7 is still visible. */
const WINDOW_DAYS = 31

export interface CohortRow {
  day: string
  size: number
  /** Undefined until the day is far enough in the past to read it. */
  d1: number | undefined
  d3: number | undefined
  d7: number | undefined
}

export interface HeavyUser {
  accountId: string
  displayName: string
  activeDays: number
  sessions: number
  requests: number
  actualMicro: number
  /** The category most of this account's titled sessions fall into. */
  category: string
  walletMicro: number
  paid: boolean
  lastActive: string
}

export interface UserMetrics {
  dau: number
  wau: number
  mau: number
  /** Mean distinct active days per account active this week. */
  activeDaysPerUserWeek: number
  /** Sessions per weekly active account. */
  sessionsPerActiveWeek: number
  /** Sessions per daily active account, today. */
  sessionsPerDau: number
  costPerSessionMicro: number
  costPerUserDayMicro: number
  costPercentiles: { p50Micro: number; p90Micro: number; p99Micro: number }
  heavyCount: number
  heavyThreshold: number
  heavy: HeavyUser[]
  cohorts: CohortRow[]
  /** Share of weekly requests that carried a session id. */
  sessionCoverage: number
}

interface UsageRow {
  userId: string
  ts: string
  sessionId: string | null
  actualMicro: number | null
  status: number
}

export function collectUsers(db: GatewayDatabase, now = new Date()): UserMetrics {
  const days = Array.from({ length: WINDOW_DAYS }, (_, index) => dayStampDaysAgo(WINDOW_DAYS - 1 - index, now))
  const dayIndex = new Map(days.map((day, index) => [day, index]))
  const todayIndex = days.length - 1
  const since = new Date(now.getTime() - WINDOW_DAYS * 864e5).toISOString()
  const rows = db
    .prepare('SELECT userId, ts, sessionId, actualMicro, status FROM usage WHERE ts >= ?')
    .all(since) as unknown as UsageRow[]

  const activeDays = new Map<string, Set<number>>()
  const sessions = new Map<string, Set<string>>()
  const requests = new Map<string, number>()
  // The heavy threshold is stated per week, so it must count the week, not the whole window.
  const weekRequests = new Map<string, number>()
  const cost = new Map<string, number>()
  const lastActive = new Map<string, string>()
  let sessionRows = 0
  let totalRows = 0

  for (const row of rows) {
    const index = dayIndex.get(dayStamp(new Date(row.ts)))
    if (index === undefined) continue
    totalRows += 1
    if (row.sessionId !== null) sessionRows += 1
    const set = activeDays.get(row.userId) ?? new Set<number>()
    set.add(index)
    activeDays.set(row.userId, set)
    if (row.sessionId !== null) {
      const sessionsFor = sessions.get(row.userId) ?? new Set<string>()
      sessionsFor.add(row.sessionId)
      sessions.set(row.userId, sessionsFor)
    }
    requests.set(row.userId, (requests.get(row.userId) ?? 0) + 1)
    if (index >= todayIndex - 6) weekRequests.set(row.userId, (weekRequests.get(row.userId) ?? 0) + 1)
    if (row.actualMicro !== null) cost.set(row.userId, (cost.get(row.userId) ?? 0) + row.actualMicro)
    const previous = lastActive.get(row.userId)
    if (previous === undefined || row.ts > previous) lastActive.set(row.userId, row.ts)
  }

  const dau = countActiveOn(activeDays, new Set([todayIndex]))
  const wau = countActiveOn(activeDays, new Set(days.map((_, index) => index).slice(-7)))
  const mau = countActiveOn(activeDays, new Set(days.map((_, index) => index)))
  const weekStart = todayIndex - 6
  const weeklyUsers = [...activeDays.keys()].filter((account) =>
    [...(activeDays.get(account) ?? [])].some((index) => index >= weekStart),
  )
  const activeDaysTotal = weeklyUsers.reduce(
    (sum, account) => sum + [...(activeDays.get(account) ?? [])].filter((index) => index >= weekStart).length,
    0,
  )
  const weeklySessions = weeklyUsers.reduce((sum, account) => sum + (sessions.get(account)?.size ?? 0), 0)
  const weeklyCost = [...cost.values()].reduce((sum, value) => sum + value, 0)
  const todaySessions = [...sessions.entries()]
    .filter(([account]) => (activeDays.get(account) ?? new Set()).has(todayIndex))
    .reduce((sum, [, set]) => sum + set.size, 0)

  const costs = [...cost.values()].sort((left, right) => left - right)
  const heavy = [...weekRequests.entries()]
    .filter(([, count]) => count >= HEAVY_WEEKLY_REQUESTS)
    .sort((left, right) => (cost.get(right[0]) ?? 0) - (cost.get(left[0]) ?? 0))
    .slice(0, 10)
    .map(([accountId, count]) => heavyUser(db, {
      accountId,
      requests: count,
      activeDays: [...(activeDays.get(accountId) ?? [])].filter((index) => index >= weekStart).length,
      sessions: sessions.get(accountId)?.size ?? 0,
      actualMicro: cost.get(accountId) ?? 0,
      lastActive: lastActive.get(accountId) ?? '',
    }))

  return {
    dau,
    wau,
    mau,
    activeDaysPerUserWeek: weeklyUsers.length === 0 ? 0 : activeDaysTotal / weeklyUsers.length,
    sessionsPerActiveWeek: weeklyUsers.length === 0 ? 0 : weeklySessions / weeklyUsers.length,
    sessionsPerDau: dau === 0 ? 0 : todaySessions / dau,
    costPerSessionMicro: weeklySessions === 0 ? 0 : weeklyCost / weeklySessions,
    costPerUserDayMicro: activeDaysTotal === 0 ? 0 : weeklyCost / activeDaysTotal,
    costPercentiles: {
      p50Micro: percentile(costs, 0.5),
      p90Micro: percentile(costs, 0.9),
      p99Micro: percentile(costs, 0.99),
    },
    heavyCount: [...weekRequests.values()].filter((count) => count >= HEAVY_WEEKLY_REQUESTS).length,
    heavyThreshold: HEAVY_WEEKLY_REQUESTS,
    heavy,
    cohorts: buildCohorts(db, days, dayIndex, activeDays, todayIndex, now),
    sessionCoverage: totalRows === 0 ? 0 : sessionRows / totalRows,
  }
}

/** Accounts active on any of `indices`. */
function countActiveOn(activeDays: Map<string, Set<number>>, indices: Set<number>): number {
  let count = 0
  for (const days of activeDays.values()) {
    if ([...days].some((index) => indices.has(index))) count += 1
  }
  return count
}

/**
 * A cohort is everyone whose first successful call landed on that day; D1/D3/D7
 * is whether they came back on day+n. Only days that have already happened can
 * be read, so a fresh cohort shows dashes instead of a zero.
 */
function buildCohorts(
  db: GatewayDatabase,
  days: string[],
  dayIndex: Map<string, number>,
  activeDays: Map<string, Set<number>>,
  todayIndex: number,
  now: Date,
): CohortRow[] {
  const firsts = db
    .prepare(
      `SELECT userId, min(ts) first FROM usage WHERE status = 200 GROUP BY userId`,
    )
    .all() as unknown as { userId: string; first: string }[]

  const cohorts = new Map<number, string[]>()
  for (const row of firsts) {
    const index = dayIndex.get(dayStamp(new Date(row.first)))
    if (index === undefined) continue
    if (index < todayIndex - COHORT_DAYS + 1) continue
    const list = cohorts.get(index) ?? []
    list.push(row.userId)
    cohorts.set(index, list)
  }

  const result: CohortRow[] = []
  for (let index = todayIndex; index > todayIndex - COHORT_DAYS; index -= 1) {
    const members = cohorts.get(index) ?? []
    const retained = (offset: number): number | undefined => {
      const target = index + offset
      if (target > todayIndex) return undefined
      return members.filter((account) => (activeDays.get(account) ?? new Set()).has(target)).length
    }
    result.push({ day: days[index], size: members.length, d1: retained(1), d3: retained(3), d7: retained(7) })
  }
  void now
  return result
}

function heavyUser(
  db: GatewayDatabase,
  base: { accountId: string; requests: number; activeDays: number; sessions: number; actualMicro: number; lastActive: string },
): HeavyUser {
  const account = db.prepare('SELECT displayName FROM users WHERE id = ?').get(base.accountId) as
    | { displayName: string }
    | undefined
  const titles = db
    .prepare('SELECT title FROM session_titles WHERE accountId = ?')
    .all(base.accountId) as unknown as { title: string }[]
  const counts = new Map<string, number>()
  for (const row of titles) {
    const category = categorizeTask(row.title)
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  const category = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? 'other'
  const paid = db
    .prepare("SELECT count(*) n FROM wallet_ledger WHERE userId = ? AND source = 'purchase'")
    .get(base.accountId) as { n: number }
  return {
    accountId: base.accountId,
    displayName: account?.displayName ?? base.accountId.slice(0, 8),
    activeDays: base.activeDays,
    sessions: base.sessions,
    requests: base.requests,
    actualMicro: base.actualMicro,
    category,
    walletMicro: walletBalanceMicro(db, base.accountId),
    paid: paid.n > 0,
    lastActive: base.lastActive,
  }
}

/** Last activity as a local date and time, not a slice of an ISO string. */
const lastActiveFormat = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai',
})

function lastActiveLabel(iso: string): string {
  return iso === '' ? '—' : lastActiveFormat.format(new Date(iso))
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

/** Short labels for a table cell; the long ones would crowd eight columns. */
function categoryShort(category: string): string {
  const labels: Record<string, string> = {
    coding: 'Coding', data: 'Data', system: 'System', files: 'Files', writing: 'Writing', research: 'Research', other: 'Other',
  }
  return labels[category] ?? category
}

function categoryLabel(category: string): string {
  const labels: Record<string, string> = {
    coding: 'Coding / Debugging',
    data: 'Spreadsheet / Data',
    system: 'System / IT',
    files: 'File Operations',
    writing: 'Writing',
    research: 'Research',
    other: 'Other',
  }
  return labels[category] ?? category
}

export function renderUsersPage(metrics: UserMetrics, options: { generatedAt: Date }): string {
  const retention = (part: number | undefined, size: number): string =>
    part === undefined ? '—' : size === 0 ? '—' : percent(part, size)

  const body = `
  <h2>活跃规模</h2>
  <div class="kpis">
    ${kpi('DAU', String(metrics.dau), '今天有模型调用')}
    ${kpi('WAU', String(metrics.wau), '近 7 天')}
    ${kpi('MAU', String(metrics.mau), '近 30 天')}
  </div>
  <div class="stats">
    ${stat('每用户每周活跃天数', metrics.activeDaysPerUserWeek.toFixed(1))}
    ${stat('每活跃用户每周 Session', metrics.sessionsPerActiveWeek.toFixed(1))}
  </div>
  <p class="note">Session 只统计携带会话标识的请求，本周覆盖 ${percent(metrics.sessionCoverage * 100, 100)}，因此 Session 相关指标是下限。</p>

  <h2>留存（按首次调用成功分 cohort）</h2>
  <table>
    ${tableCaption('按首次调用成功日分组的留存')}
    <tr><th scope="col">首次使用</th><th scope="col">新增</th><th scope="col">D1</th><th scope="col">D3</th><th scope="col">D7</th></tr>
    ${metrics.cohorts.filter((row) => row.size > 0).length === 0
      ? '<tr><th scope="row">近两周没有新的首次成功调用</th><td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td></tr>'
      : metrics.cohorts
          .filter((row) => row.size > 0)
          .map((row) => `<tr><th scope="row">${escapeHtml(row.day)}${row.size < 5 ? ' · 样本小' : ''}</th>` +
            `<td class="num">${row.size}</td><td class="num">${retention(row.d1, row.size)}</td>` +
            `<td class="num">${retention(row.d3, row.size)}</td><td class="num">${retention(row.d7, row.size)}</td></tr>`)
          .join('')}
  </table>
  <p class="note">只统计首次成功调用落在该日、且有会话活动的账号；尚未到期的 D1/D3/D7 显示为 —。</p>

  <h2>使用深度</h2>
  <div class="stats">
    ${stat('每 DAU Session', metrics.sessionsPerDau.toFixed(2))}
    ${stat('每 Session 真实成本', money(metrics.costPerSessionMicro))}
    ${stat('每用户每日真实成本', money(metrics.costPerUserDayMicro))}
    ${stat('用户周成本 P50', money(metrics.costPercentiles.p50Micro))}
    ${stat('用户周成本 P90', money(metrics.costPercentiles.p90Micro))}
    ${stat('用户周成本 P99', money(metrics.costPercentiles.p99Micro))}
    ${stat('重度用户', String(metrics.heavyCount), '近 7 天请求 ≥ ' + metrics.heavyThreshold)}
  </div>

  <h2>重度用户（按真实成本排序）</h2>
  ${metrics.heavy.length === 0
    ? '<p class="note">暂无达到阈值的账号。</p>'
    : `<table>
    ${tableCaption('按真实成本排序的重度账号')}
    <tr><th scope="col">用户</th><th scope="col">活跃天数</th><th scope="col">Session</th><th scope="col">真实成本</th><th scope="col">主线任务</th><th scope="col">Wallet</th><th scope="col">付费</th><th scope="col">最近活跃</th></tr>
    ${metrics.heavy
      .map((user) => `<tr><th scope="row">${escapeHtml(user.displayName)}</th>` +
        `<td class="num">${user.activeDays}</td><td class="num">${user.sessions}</td>` +
        `<td class="num">${money(user.actualMicro)}</td><td>${escapeHtml(categoryShort(user.category))}</td>` +
        `<td class="num">${money(user.walletMicro)}</td><td>${user.paid ? '是' : '否'}</td>` +
        `<td>${escapeHtml(lastActiveLabel(user.lastActive))}</td></tr>`)
      .join('')}
  </table>`}
  <p class="note">不含任何对话内容：主线任务来自会话标题的关键词分类，钱包余额与是否付费来自账本。</p>
`
  return page(
    'Mareo 用户与留存',
    [{ href: '/stats/', label: '经营看板' }, { href: '/stats/health/', label: '工程健康' }],
    '近 7 天 · 北京日',
    options.generatedAt,
    body,
  )
}

// Renders the public statistics page from the gateway database.
//
//   npm run stats:page                 # prints the page on stdout
//   npm run stats:page -- --downloads 12
//
// It is written to a file by deploy/stats-page.sh and served as a static page, so
// the database is never reachable from the internet and the page cannot leak a
// per-account value: every number here is an aggregate. Definitions live in
// docs/operations.md.
import { openDatabase, type GatewayDatabase } from './db.js'
import { dayStamp, dayStampDaysAgo, startOfDay, startOfDayDaysAgo } from './clock.js'
import { siteViewsSince } from './site-views.js'
import { categorizeTask } from './stats-tasks.js'
import { collectUsers, renderUsersPage } from './stats-users.js'
import { walletTotals } from './wallet.js'
import { escapeHtml, kpi, money, page, percent, scroll, stat, table } from './stats-html.js'

const dbPath = process.env.DB_PATH ?? 'data/mareo.db'

export interface Metrics {
  installs: number
  installsToday: number
  accountsToday: number
  activeToday: number
  activeWeek: number
  launchesWeek: { total: number; ok: number }
  harnessExitsWeek: number
  requestsToday: number
  requestsWeek: number
  okWeek: number
  limitedWeek: number
  /** Accounts above the attention threshold today, with their request counts. */
  heavyToday: { accountId: string; requests: number }[]
  latency: { p50: number; p95: number } | undefined
  charsWeek: number
  firstTryOk: number
  accountsWithUsage: number
  accounts: number
  signinWeek: { result: string; n: number }[]
  versions: { version: string; platform: string; n: number }[]
  platforms: { platform: string; n: number }[]
  siteWeek: { total: number; byPath: { path: string; count: number }[] }
  /** The same seven days, one row each: trends need days, not totals. */
  series: { day: string; installs: number; active: number; requests: number }[]
  /** Today, as the CEO page asks it: who was here, who was new, who came back. */
  today: {
    dau: number
    activated: number
    returning: number
    /** Users whose first successful call was exactly seven days ago. */
    d7Cohort: number
    /** ...and of those, how many were here today. */
    d7Retained: number
    sessions: number
    /** Share of today's requests that carried a session id: sessions are a floor, not a total. */
    sessionCoverage: number
  }
  /** Money for today, in micro-yuan. Recharge is cash; billing is wallet spend. */
  money: {
    actualMicro: number
    billableMicro: number
    marginMicro: number
    rechargeMicro: number
    cashNetMicro: number
    /** Recharge divided by real cost: undefined when nothing was spent. */
    costRecovery: number | undefined
    /** Wallet credit not yet consumed, across every account. */
    walletBalanceMicro: number
  }
  /** What the week's sessions were about, from the titles the agent wrote. */
  taskMix: {
    category: string
    sessions: number
    share: number
  }[]
  /** Sessions with a title, over sessions that made a request: the mix is a sample. */
  taskCoverage: number
  /** Request status distribution over the week, for the health page. */
  statusWeek: { status: number; n: number }[]
  /** One line for the home page: is anything off. */
  health: { ok: boolean; issues: string[] }
  /**
   * The funnel, all four steps in one window. Mixing accumulated installs with a
   * weekly view (which this page used to do) makes every conversion rate wrong.
   */
  funnelWeek: {
    /** Traffic counts, not people: visits are page views and downloads are requests. */
    views: number
    /** The cohort every conversion below is measured in: accounts created this week. */
    signups: number
    launched: number
    firstSuccess: number
    firstPurchase: number
  }
}

export function collect(db: GatewayDatabase, now = new Date(), heavyLimit = 500): Metrics {
  // Every window is a Beijing calendar day: today for "今日", today plus the
  // previous six days for "近 7 天".
  const day = dayStamp(now)
  const isoDay = startOfDay(now)
  const week = startOfDayDaysAgo(6, now)
  const one = <T>(sql: string, ...params: (string | number)[]): T => db.prepare(sql).get(...params) as T
  const all = <T>(sql: string, ...params: (string | number)[]): T[] => db.prepare(sql).all(...params) as T[]

  const usageWeek = one<{ total: number; ok: number }>(
    `SELECT count(*) total, sum(CASE WHEN status = 200 THEN 1 ELSE 0 END) ok FROM usage WHERE ts >= ?`,
    week,
  )
  const latencyRows = all<{ latencyMs: number }>(
    'SELECT latencyMs FROM usage WHERE status = 200 AND ts >= ? ORDER BY latencyMs',
    week,
  )
  const at = (fraction: number) =>
    latencyRows.length === 0 ? 0 : latencyRows[Math.min(latencyRows.length - 1, Math.floor(latencyRows.length * fraction))].latencyMs

  const metrics: Metrics = {
    installs: one<{ n: number }>(
      "SELECT count(DISTINCT accountId) n FROM events WHERE name = 'install_confirmed' AND accountId IS NOT NULL",
    ).n,
    installsToday: one<{ n: number }>(
      `SELECT count(DISTINCT accountId) n FROM events
       WHERE name = 'install_confirmed' AND accountId IS NOT NULL AND ts >= ?`,
      isoDay,
    ).n,
    accountsToday: one<{ n: number }>('SELECT count(*) n FROM users WHERE createdAt >= ?', day).n,
    activeToday: one<{ n: number }>(
      "SELECT count(DISTINCT accountId) n FROM events WHERE name = 'launch' AND accountId IS NOT NULL AND ts >= ?",
      isoDay,
    ).n,
    activeWeek: one<{ n: number }>(
      "SELECT count(DISTINCT accountId) n FROM events WHERE name = 'launch' AND accountId IS NOT NULL AND ts >= ?",
      week,
    ).n,
    launchesWeek: (() => {
      const rows = all<{ ok: number | null; n: number }>(
        `SELECT json_extract(detail, '$.ok') ok, count(*) n FROM events WHERE name = 'launch' AND ts >= ? GROUP BY ok`,
        week,
      )
      const total = rows.reduce((sum, row) => sum + row.n, 0)
      const ok = rows.filter((row) => row.ok === 1).reduce((sum, row) => sum + row.n, 0)
      return { total, ok }
    })(),
    harnessExitsWeek: one<{ n: number }>(
      "SELECT count(*) n FROM events WHERE name = 'harness_exit' AND ts >= ?",
      week,
    ).n,
    requestsToday: one<{ n: number }>('SELECT count(*) n FROM usage WHERE ts >= ?', isoDay).n,
    requestsWeek: usageWeek.total,
    okWeek: usageWeek.ok ?? 0,
    limitedWeek: one<{ n: number }>('SELECT count(*) n FROM usage WHERE status = 429 AND ts >= ?', week).n,
    heavyToday: all<{ userId: string; n: number }>(
      'SELECT userId, count(*) n FROM usage WHERE ts >= ? GROUP BY userId HAVING n >= ? ORDER BY n DESC',
      isoDay,
      heavyLimit,
    ).map((row) => ({ accountId: row.userId, requests: row.n })),
    latency: latencyRows.length === 0 ? undefined : { p50: at(0.5), p95: at(0.95) },
    charsWeek: one<{ n: number | null }>(
      'SELECT sum(promptChars + completionChars) n FROM usage WHERE ts >= ?',
      week,
    ).n ?? 0,
    firstTryOk: one<{ n: number }>(
      `SELECT count(*) n FROM (
         SELECT userId, min(CASE WHEN status = 200 THEN ts END) firstOk FROM usage GROUP BY userId HAVING firstOk IS NOT NULL
       )`,
    ).n,
    accountsWithUsage: one<{ n: number }>('SELECT count(DISTINCT userId) n FROM usage').n,
    accounts: one<{ n: number }>('SELECT count(*) n FROM users').n,
    signinWeek: all<{ result: string; n: number }>(
      `SELECT json_extract(detail, '$.result') result, count(*) n FROM events
       WHERE name = 'signin' AND ts >= ? GROUP BY result ORDER BY n DESC`,
      week,
    ).map((row) => ({ result: row.result ?? '未知', n: row.n })),
    versions: all<{ version: string; platform: string; n: number }>(
      `SELECT version, platform, count(*) n FROM events
       WHERE name = 'launch' AND ts >= ? GROUP BY version, platform ORDER BY n DESC`,
      week,
    ).map((row) => ({ version: row.version ?? '未知', platform: row.platform ?? '未知', n: row.n })),
    platforms: all<{ platform: string; n: number }>(
      `SELECT platform, count(*) n FROM events WHERE name = 'launch' AND ts >= ? GROUP BY platform ORDER BY n DESC`,
      week,
    ).map((row) => ({ platform: row.platform ?? '未知', n: row.n })),
    siteWeek: siteViewsSince(db, dayStampDaysAgo(6, now)),
    series: dailySeries(db, now, week),
    funnelWeek: signupFunnel(db, now, week),
    today: todayMetrics(db, now, isoDay),
    money: moneyMetrics(db, now, isoDay),
    ...taskMix(db, week),
    statusWeek: all<{ status: number; n: number }>(
      'SELECT status, count(*) n FROM usage WHERE ts >= ? GROUP BY status ORDER BY n DESC',
      week,
    ),
    health: { ok: true, issues: [] },
  }
  metrics.health = healthOf(metrics)
  return metrics
}

/**
 * One line for the home page, from rules a person can check: a crash is always
 * worth naming, and a rate below its floor means the product is not working for
 * someone even though the dashboard might otherwise look fine.
 */
function healthOf(metrics: Metrics): Metrics['health'] {
  const issues: string[] = []
  if (metrics.requestsWeek > 0 && metrics.okWeek / metrics.requestsWeek < 0.95) {
    issues.push(`模型成功率 ${percent(metrics.okWeek, metrics.requestsWeek)}`)
  }
  if (metrics.launchesWeek.total > 0 && metrics.launchesWeek.ok / metrics.launchesWeek.total < 0.9) {
    issues.push(`启动成功率 ${percent(metrics.launchesWeek.ok, metrics.launchesWeek.total)}`)
  }
  if (metrics.harnessExitsWeek > 0) issues.push(`引擎异常退出 ${metrics.harnessExitsWeek} 次`)
  if (metrics.heavyToday.length > 0) issues.push(`用量异常 ${metrics.heavyToday.length} 个账号`)
  return { ok: issues.length === 0, issues }
}

/**
 * The week's new accounts, and how far each of them got. Every conversion here
 * has the same denominator — the accounts created in this window — because mixing
 * a weekly count with an all-time one is how a funnel starts lying.
 */
function signupFunnel(db: GatewayDatabase, now: Date, weekIso: string): Metrics['funnelWeek'] {
  const one = <T>(sql: string, ...params: (string | number)[]): T => db.prepare(sql).get(...params) as T
  // Same window as every step below, or the conversions would not be comparable.
  const signups = one<{ n: number }>('SELECT count(*) n FROM users WHERE createdAt >= ?', weekIso).n
  // The cohort is small, so three joins are cheaper to read than clever SQL.
  const cohort = `SELECT id FROM users WHERE createdAt >= ?`
  return {
    views: siteViewsSince(db, dayStampDaysAgo(6, now)).total,
    signups,
    launched: one<{ n: number }>(
      `SELECT count(DISTINCT accountId) n FROM events
       WHERE name = 'install_confirmed' AND accountId IN (${cohort})`,
      weekIso,
    ).n,
    firstSuccess: one<{ n: number }>(
      `SELECT count(DISTINCT userId) n FROM usage
       WHERE status = 200 AND userId IN (${cohort})`,
      weekIso,
    ).n,
    firstPurchase: one<{ n: number }>(
      `SELECT count(DISTINCT userId) n FROM wallet_ledger
       WHERE source = 'purchase' AND type = 'credit' AND userId IN (${cohort})`,
      weekIso,
    ).n,
  }
}

/** Who was here today, and how that compares with the cohort that first arrived seven days ago. */
function todayMetrics(db: GatewayDatabase, now: Date, isoDay: string): Metrics['today'] {
  const one = <T>(sql: string, ...params: (string | number)[]): T => db.prepare(sql).get(...params) as T
  const sevenDaysAgo = startOfDayDaysAgo(7, now)
  const sixDaysAgo = startOfDayDaysAgo(6, now)
  const dau = one<{ n: number }>('SELECT count(DISTINCT userId) n FROM usage WHERE ts >= ?', isoDay).n
  const activated = one<{ n: number }>(
    `SELECT count(*) n FROM (
       SELECT userId, min(ts) first FROM usage WHERE status = 200 GROUP BY userId
     ) WHERE first >= ?`,
    isoDay,
  ).n
  return {
    dau,
    activated,
    // Everyone active today who was not activated today: the ones who came back.
    returning: Math.max(0, dau - activated),
    d7Cohort: one<{ n: number }>(
      `SELECT count(*) n FROM (
         SELECT userId, min(ts) first FROM usage WHERE status = 200 GROUP BY userId
       ) WHERE first >= ? AND first < ?`,
      sevenDaysAgo,
      sixDaysAgo,
    ).n,
    d7Retained: one<{ n: number }>(
      `SELECT count(*) n FROM (
         SELECT userId, min(ts) first FROM usage WHERE status = 200 GROUP BY userId
       ) firsts
       WHERE firsts.first >= ? AND firsts.first < ?
         AND EXISTS (SELECT 1 FROM usage u WHERE u.userId = firsts.userId AND u.ts >= ?)`,
      sevenDaysAgo,
      sixDaysAgo,
      isoDay,
    ).n,
    sessions: one<{ n: number }>(
      'SELECT count(DISTINCT sessionId) n FROM usage WHERE ts >= ? AND sessionId IS NOT NULL',
      isoDay,
    ).n,
    sessionCoverage: (() => {
      const row = one<{ total: number; withSid: number }>(
        `SELECT count(*) total, sum(CASE WHEN sessionId IS NOT NULL THEN 1 ELSE 0 END) withSid
         FROM usage WHERE ts >= ?`,
        isoDay,
      )
      return row.total === 0 ? 0 : (row.withSid ?? 0) / row.total
    })(),
  }
}

/** Today's money: what the models cost, what users were charged, what came in as cash. */
function moneyMetrics(db: GatewayDatabase, now: Date, isoDay: string): Metrics['money'] {
  const one = <T>(sql: string, ...params: (string | number)[]): T => db.prepare(sql).get(...params) as T
  const spend = one<{ actual: number | null; billable: number | null }>(
    'SELECT sum(actualMicro) actual, sum(billableMicro) billable FROM usage WHERE ts >= ?',
    isoDay,
  )
  const recharge = one<{ total: number | null }>(
    "SELECT sum(amountMicro) total FROM payment_orders WHERE status = 'paid' AND paidAt >= ?",
    isoDay,
  )
  const actualMicro = spend.actual ?? 0
  const billableMicro = spend.billable ?? 0
  const rechargeMicro = recharge.total ?? 0
  return {
    actualMicro,
    billableMicro,
    marginMicro: billableMicro - actualMicro,
    rechargeMicro,
    cashNetMicro: rechargeMicro - actualMicro,
    costRecovery: actualMicro === 0 ? undefined : rechargeMicro / actualMicro,
    walletBalanceMicro: walletTotals(db).balanceMicro ?? 0,
  }
}

/**
 * The week's work, by category. Sessions are the unit because a title is per
 * session; the share is over titled sessions only, and the coverage says how
 * many sessions that is.
 */
function taskMix(db: GatewayDatabase, weekIso: string): { taskMix: Metrics['taskMix']; taskCoverage: number } {
  const rows = db
    .prepare('SELECT title FROM session_titles WHERE updatedAt >= ?')
    .all(weekIso) as unknown as { title: string }[]
  const counts = new Map<string, number>()
  for (const row of rows) {
    const category = categorizeTask(row.title)
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  const total = rows.length
  const sessions = db
    .prepare('SELECT count(DISTINCT sessionId) n FROM usage WHERE ts >= ? AND sessionId IS NOT NULL')
    .get(weekIso) as { n: number }
  return {
    taskMix: [...counts.entries()]
      .map(([category, n]) => ({ category, sessions: n, share: total === 0 ? 0 : n / total }))
      .sort((left, right) => right.sessions - left.sessions),
    taskCoverage: sessions.n === 0 ? 0 : Math.min(1, total / sessions.n),
  }
}

/**
 * Seven rows, oldest first. Bucketed in JS rather than in SQL: the timestamps are
 * ISO strings in UTC and every other window in this file is a Beijing day, so one
 * definition of "day" keeps the trend and the funnel from disagreeing.
 */
function dailySeries(db: GatewayDatabase, now: Date, weekIso: string): Metrics['series'] {
  const days = Array.from({ length: 7 }, (_, index) => dayStampDaysAgo(6 - index, now))
  const rows = new Map(days.map((day) => [day, { day, installs: 0, active: 0, requests: 0 }]))
  const seen = new Map(days.map((day) => [day, { installs: new Set<string>(), active: new Set<string>() }]))
  const bucket = (of: (value: string) => void) => (row: { ts: string }) => {
    const day = dayStamp(new Date(row.ts))
    if (rows.has(day)) of(day)
  }

  for (const row of db
    .prepare("SELECT ts, accountId FROM events WHERE name = 'install_confirmed' AND accountId IS NOT NULL AND ts >= ?")
    .all(weekIso) as unknown as { ts: string; accountId: string }[]) {
    bucket((day) => seen.get(day)!.installs.add(row.accountId))(row)
  }
  for (const row of db
    .prepare("SELECT ts, accountId FROM events WHERE name = 'launch' AND accountId IS NOT NULL AND ts >= ?")
    .all(weekIso) as unknown as { ts: string; accountId: string }[]) {
    bucket((day) => seen.get(day)!.active.add(row.accountId))(row)
  }
  for (const row of db
    .prepare('SELECT ts FROM usage WHERE ts >= ?')
    .all(weekIso) as unknown as { ts: string }[]) {
    bucket((day) => (rows.get(day)!.requests += 1))(row)
  }
  for (const day of days) {
    rows.get(day)!.installs = seen.get(day)!.installs.size
    rows.get(day)!.active = seen.get(day)!.active.size
  }
  return [...rows.values()]
}

/** A seven-point line, drawn inline: the page stays a single file with no requests. */
function spark(series: { day: string; value: number }[]): string {
  const width = 120
  const height = 34
  const max = Math.max(1, ...series.map((point) => point.value))
  const step = series.length > 1 ? width / (series.length - 1) : width
  const points = series.map((point, index) => {
    const x = (index * step).toFixed(1)
    const y = (height - (point.value / max) * (height - 4) - 2).toFixed(1)
    return `${x},${y}`
  })
  const last = (points.at(-1) ?? '0,0').split(',')
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" aria-hidden="true">` +
    `<polygon points="0,${height} ${points.join(' ')} ${width},${height}" fill="var(--accent-soft)"></polygon>` +
    `<polyline points="${points.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"></polyline>` +
    `<circle cx="${last[0]}" cy="${last[1]}" r="2.2" fill="var(--accent)"></circle></svg>`
}

/** A short, locale-formatted day label for the sparkline ends. */
const shortDay = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Shanghai' })

function labelOfDay(day: string | undefined): string {
  return day === undefined ? '' : shortDay.format(new Date(`${day}T12:00:00+08:00`))
}

function trend(label: string, series: { day: string; value: number }[], total: string): string {
  return `<div class="trend"><div class="trend-head"><span class="kpi-label">${escapeHtml(label)}</span>` +
    `<span class="trend-total">${escapeHtml(total)}</span></div>${spark(series)}` +
    `<div class="trend-days"><span>${escapeHtml(labelOfDay(series[0]?.day))}</span>` +
    `<span>${escapeHtml(labelOfDay(series.at(-1)?.day))}</span></div></div>`
}

/** One row of the growth funnel: the count, and how much survived from the step above. */
function funnelStep(label: string, value: number | string, previous: number | undefined, note: string): string {
  const shown = typeof value === 'number' ? value.toLocaleString('en-US') : value
  const conversion = previous === undefined || typeof value !== 'number' ? '' : `上一环节 ${percent(value, previous)}`
  return `<div class="step"><div class="step-head"><span class="step-label">${escapeHtml(label)}</span>` +
    `<span class="step-value">${escapeHtml(shown)}</span></div>` +
    `<div class="step-note">${escapeHtml(note)}${conversion === '' ? '' : ' · ' + escapeHtml(conversion)}</div></div>`
}

/**
 * The head of the business: what happened today, whether growth moved, whether
 * the money works, and what people actually bring to Mareo. The engineering
 * numbers live one click away so they cannot bury these.
 */
export function renderCeoPage(metrics: Metrics, options: { downloads?: number; generatedAt: Date }): string {
  const today = metrics.today
  const finance = metrics.money
  const funnel = metrics.funnelWeek
  const d7 = today.d7Cohort === 0 ? '—' : percent(today.d7Retained, today.d7Cohort)
  const coverage = today.sessionCoverage === 0 ? '—' : percent(today.sessionCoverage * 100, 100)
  const recovery = finance.costRecovery === undefined ? '—' : percent(finance.costRecovery * 100, 100)
  // Unknown is not zero: the shell script passes the count, a preview does not.
  const downloads = options.downloads
  const status = metrics.health.ok
    ? `<p class="status ok">系统正常<span class="note" style="margin:0">模型成功率 ${percent(metrics.okWeek, metrics.requestsWeek)} · 启动成功率 ${percent(metrics.launchesWeek.ok, metrics.launchesWeek.total)}</span></p>`
    : `<p class="status warn">⚠ ${escapeHtml(metrics.health.issues.join(' · '))} <a href="/stats/health/">查看工程健康 →</a></p>`

  const body = `
  ${status}

  <h2>今日</h2>
  <div class="kpis">
    ${kpi('DAU', String(today.dau), '今天有模型调用的账号')}
    ${kpi('新增激活', String(today.activated), '今天第一次调用成功')}
    ${kpi('回访', String(today.returning), '今天活跃、且不是今天首次')}
    ${kpi('D7 留存', d7, today.d7Cohort === 0 ? '七天的 cohort 为 0' : `七天前首次使用 ${today.d7Cohort} 人${today.d7Cohort < 5 ? ' · 样本过小' : ''}`)}
  </div>
  <div class="stats">
    ${stat('今日 Session', String(today.sessions))}
    ${stat('今日请求', metrics.requestsToday.toLocaleString('en-US'))}
  </div>
  <p class="note">Session 数按请求携带的会话标识统计，今日覆盖 ${coverage} 的请求（老客户端不上报，因此这是下限）。</p>

  <h2>增长</h2>
  <div class="steps">
    ${funnelStep('官网访问', funnel.views, undefined, '近 7 天 · 执行了 JavaScript 的真实浏览器')}
    ${funnelStep('安装包下载', downloads ?? '—', downloads === undefined ? undefined : funnel.views, downloads === undefined ? '近 7 天 · 本次生成未统计下载数' : '近 7 天 · 访问日志计数')}
  </div>
  <p class="note">以上两步是<b>次数</b>，不是去重人数，所以只给占比、不参与下面的账号转化。</p>
  <div class="steps" style="margin-top:12px">
    ${funnelStep('近 7 天新注册账号', funnel.signups, undefined, '这一批人就是下面每一步的分母')}
    ${funnelStep('其中完成首次调用成功', funnel.firstSuccess, funnel.signups, '至少一次模型调用成功')}
    ${funnelStep('其中完成首次充值', funnel.firstPurchase, funnel.firstSuccess, '至少一笔已支付订单')}
  </div>

  <h2>商业（今日）</h2>
  <div class="stats">
    ${stat('真实模型成本', money(finance.actualMicro))}
    ${stat('用户结算消耗', money(finance.billableMicro))}
    ${stat('毛利（钱包口径）', money(finance.marginMicro))}
    ${stat('今日充值', money(finance.rechargeMicro))}
    ${stat('现金净额', money(finance.cashNetMicro), finance.cashNetMicro < 0 ? 'warn' : '')}
    ${stat('Cost Recovery', recovery, finance.costRecovery !== undefined && finance.costRecovery < 1 ? 'warn' : '')}
    ${stat('Wallet 未消耗余额', money(finance.walletBalanceMicro), finance.walletBalanceMicro < 0 ? 'warn' : '')}
  </div>
  <p class="note">
    充值不是收入：它先成为 Wallet 余额，被消费时才形成收入。毛利按已消耗口径（结算消耗 − 真实成本）；现金净额是充值减去今天的真实成本；Cost Recovery = 今日充值 ÷ 今日真实成本。
  </p>

  <p class="note">
    这一段缺三个环节的数据，先不展示：<b>首次启动</b>（<code>install_confirmed</code> 只有部分客户端上报）、
<b>看到充值入口 / 点击充值</b>（客户端还没有这两个事件）、<b>活跃时长</b>（现在只有进程存活时长）。
  </p>

  <h2>用户拿 Mareo 做什么（近 7 天）</h2>
  <div class="mix">
    ${metrics.taskMix.length === 0
      ? '<div class="mix-row"><span class="mix-label">暂无带标题的会话</span></div>'
      : metrics.taskMix
          .map((row) => `<div class="mix-row"><span class="mix-label">${escapeHtml(taskLabel(row.category))}</span>` +
            `<span class="mix-value">${row.sessions} 个会话 · ${percent(row.sessions, metrics.taskMix.reduce((sum, item) => sum + item.sessions, 0))}</span>` +
            `<div class="bar" aria-hidden="true"><span style="width:${Math.max(2, Math.round(row.share * 100))}%"></span></div></div>`)
          .join('')}
  </div>
  <p class="note">
    分类来自会话标题（关键词规则，确定性、不调用模型），按会话数统计；本周有标题的会话占请求会话的 ${percent(metrics.taskCoverage * 100, 100)}。
  </p>
`
  return page('ceo', '近 7 天 · 北京日', options.generatedAt, body)
}

/** Everything that answers "is it working", kept off the business page. */
export function renderHealthPage(metrics: Metrics, options: { generatedAt: Date }): string {
  const launchRate = percent(metrics.launchesWeek.ok, metrics.launchesWeek.total)
  const modelRate = percent(metrics.okWeek, metrics.requestsWeek)
  const perThousand = metrics.launchesWeek.ok === 0
    ? '—'
    : ((metrics.harnessExitsWeek / metrics.launchesWeek.ok) * 1000).toFixed(1)
  const platformTotal = metrics.platforms.reduce((sum, row) => sum + row.n, 0)
  const signinText = metrics.signinWeek.length === 0
    ? '暂无数据'
    : metrics.signinWeek.map((row) => `${row.result} ${row.n}`).join(' · ')

  const body = `
  <p class="status ${metrics.health.ok ? 'ok' : 'warn'}">${metrics.health.ok ? '系统正常' : '⚠ ' + escapeHtml(metrics.health.issues.join(' · '))}</p>

  <h2>稳定性（近 7 天）</h2>
  <div class="health">
    <div>
      <div class="row"><span>启动成功率</span><span>${launchRate}</span></div>
      <div class="row"><span>引擎异常退出</span><span>${metrics.harnessExitsWeek} 次 · 每千次启动 ${perThousand}</span></div>
      <div class="row"><span>模型调用成功率</span><span>${modelRate}</span></div>
      <div class="row"><span>成功率延迟</span><span>p50 ${metrics.latency?.p50 ?? '—'}ms · p95 ${metrics.latency?.p95 ?? '—'}ms</span></div>
    </div>
    <div>
      <div class="row"><span>额度用尽的请求</span><span>${metrics.limitedWeek}</span></div>
      <div class="row"><span>登录结果</span><span>${escapeHtml(signinText)}</span></div>
      <div class="row"><span>字符量（提示 + 回复）</span><span>${metrics.charsWeek.toLocaleString('en-US')}</span></div>
      <div class="row"><span>首次调用即成功</span><span>${metrics.firstTryOk} / ${metrics.accountsWithUsage}</span></div>
    </div>
    <div>
      <div class="row"><span>启动次数</span><span>${metrics.launchesWeek.total}</span></div>
      <div class="row"><span>用量异常（今日超过 500 次）</span><span>${metrics.heavyToday.length === 0 ? '无' : metrics.heavyToday.length + ' 个账号'}</span></div>
    </div>
  </div>

  <h2>请求结果（近 7 天）</h2>
  ${scroll(`<table>
    <caption class="sr-only">近 7 天的请求结果分布</caption>
    <tr><th scope="col">状态</th><th scope="col">请求数</th></tr>
    ${metrics.statusWeek.length === 0
    ? '<tr><th scope="row">暂无数据</th><td class="num">—</td></tr>'
    : metrics.statusWeek.map((row) => `<tr><th scope="row">HTTP ${row.status}</th><td class="num">${row.n.toLocaleString('en-US')}</td></tr>`).join('')}</table>`)}

  <h2>每日请求（近 7 天）</h2>
  <div class="trends">
    ${trend('模型请求', metrics.series.map((row) => ({ day: row.day, value: row.requests })), metrics.requestsWeek.toLocaleString('en-US'))}
    ${trend('活跃账号', metrics.series.map((row) => ({ day: row.day, value: row.active })), String(metrics.activeWeek))}
    ${trend('新增安装', metrics.series.map((row) => ({ day: row.day, value: row.installs })), String(metrics.funnelWeek.launched))}
  </div>

  <h2>版本与平台（近 7 天启动）</h2>
  ${scroll(`<table>
    <caption class="sr-only">近 7 天启动的版本与平台分布</caption>
    <tr><th scope="col">版本 · 平台</th><th scope="col">启动次数</th></tr>
    ${metrics.versions.length === 0
      ? '<tr><th scope="row">版本分布</th><td class="num">暂无数据</td></tr>'
      : metrics.versions.map((row) => `<tr><th scope="row">${escapeHtml(row.version)} · ${escapeHtml(row.platform)}</th><td class="num">${row.n}</td></tr>`).join('')}</table>`)}
  <div class="stats">
    ${metrics.platforms.map((row) => stat(row.platform, `${row.n} · ${percent(row.n, platformTotal)}`)).join('')}
  </div>
`
  return page('health', '近 7 天 · 工程口径', options.generatedAt, body)
}

/** Category ids are stable keys; the label is what a reader sees. */
function taskLabel(category: string): string {
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

function main(): void {
  // `--page ceo|health`: the shell script writes each page to its own file.
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const downloads = Number.parseInt(flag('--downloads') ?? '', 10)
  const pageName = flag('--page') ?? 'ceo'
  const db = openDatabase(dbPath)
  const metrics = collect(db)
  const generatedAt = new Date()
  const options = { downloads: Number.isFinite(downloads) ? downloads : undefined, generatedAt }
  const html = pageName === 'health'
    ? renderHealthPage(metrics, options)
    : pageName === 'users'
      ? renderUsersPage(collectUsers(db), options)
      : renderCeoPage(metrics, options)
  process.stdout.write(html)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main()
}

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

const dbPath = process.env.DB_PATH ?? 'data/mareo.db'

/** Escapes every interpolated value: version and platform come from clients. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

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
  /**
   * The funnel, all four steps in one window. Mixing accumulated installs with a
   * weekly view (which this page used to do) makes every conversion rate wrong.
   */
  funnelWeek: { views: number; installs: number; accounts: number; withUsage: number }
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

  return {
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
    funnelWeek: {
      views: siteViewsSince(db, dayStampDaysAgo(6, now)).total,
      installs: one<{ n: number }>(
        `SELECT count(DISTINCT accountId) n FROM events
         WHERE name = 'install_confirmed' AND accountId IS NOT NULL AND ts >= ?`,
        week,
      ).n,
      accounts: one<{ n: number }>('SELECT count(*) n FROM users WHERE createdAt >= ?', day).n,
      withUsage: one<{ n: number }>('SELECT count(DISTINCT userId) n FROM usage WHERE ts >= ?', week).n,
    },
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

/** Micro-helpers for the page: every number is escaped, every section is plain HTML. */
function percent(part: number, whole: number): string {
  return whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`
}

function kpi(label: string, value: string, note: string): string {
  return `<div class="kpi"><span class="kpi-label">${escapeHtml(label)}</span>` +
    `<strong class="kpi-value">${escapeHtml(value)}</strong>` +
    `<span class="kpi-note">${escapeHtml(note)}</span></div>`
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
  const last = points.at(-1) ?? '0,0'
  const area = `0,${height} ${points.join(' ')} ${width},${height}`
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" aria-hidden="true">` +
    `<polygon points="${area}" fill="var(--accent-soft)"></polygon>` +
    `<polyline points="${points.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"></polyline>` +
    `<circle cx="${last.split(',')[0]}" cy="${last.split(',')[1]}" r="2.2" fill="var(--accent)"></circle>` +
    `</svg>`
}

function trend(label: string, series: { day: string; value: number }[], total: string): string {
  return `<div class="trend"><div class="trend-head"><span class="kpi-label">${escapeHtml(label)}</span>` +
    `<span class="trend-total">${escapeHtml(total)}</span></div>${spark(series)}` +
    `<div class="trend-days"><span>${escapeHtml(series[0]?.day.slice(5) ?? '')}</span><span>${escapeHtml(series.at(-1)?.day.slice(5) ?? '')}</span></div></div>`
}

/**
 * One stage of the journey. These are *not* a funnel: an account can make calls
 * after registering long ago, so the numbers do not nest and a bar pretending
 * they do would be a lie. Each row states its own window instead.
 */
function stage(label: string, value: number, note: string): string {
  return `<div class="stage"><span class="stage-label">${escapeHtml(label)}</span>` +
    `<span class="stage-value">${value.toLocaleString('en-US')}</span>` +
    `<span class="stage-note">${escapeHtml(note)}</span></div>`
}

/** One sentence answering "what happened this week", without inventing a cause. */
function verdict(metrics: Metrics): { text: string; tone: 'ok' | 'warn' } {
  const funnel = metrics.funnelWeek
  if (funnel.views > 0 && funnel.installs === 0) {
    return { text: `本周官网有 ${funnel.views} 次访问，没有新增安装：断点在「访问 → 安装」。`, tone: 'warn' }
  }
  if (metrics.accounts > 0 && metrics.requestsWeek === 0) {
    return { text: `本周没有模型调用，${metrics.accounts} 个账号都还没有真正用起来。`, tone: 'warn' }
  }
  if (funnel.views === 0 && funnel.installs === 0) {
    return { text: '本周没有访问也没有安装记录，数据可能还没开始采集。', tone: 'ok' }
  }
  return {
    text: `本周新增 ${funnel.installs} 次安装、${metrics.activeWeek} 个账号活跃、${metrics.requestsWeek.toLocaleString('en-US')} 次模型调用。`,
    tone: 'ok',
  }
}

function table(items: [string, string][]): string {
  return `<table>${items
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join('')}</table>`
}

export function renderStatsPage(metrics: Metrics, options: { downloads?: number; generatedAt: Date }): string {
  const funnel = metrics.funnelWeek
  const summary = verdict(metrics)
  const launchRate = metrics.launchesWeek.total === 0 ? '—' : percent(metrics.launchesWeek.ok, metrics.launchesWeek.total)
  const modelRate = metrics.requestsWeek === 0 ? '—' : percent(metrics.okWeek, metrics.requestsWeek)
  const perThousand = metrics.launchesWeek.ok === 0
    ? '—'
    : ((metrics.harnessExitsWeek / metrics.launchesWeek.ok) * 1000).toFixed(1)
  const seriesOf = (pick: (row: Metrics['series'][number]) => number) =>
    metrics.series.map((row) => ({ day: row.day, value: pick(row) }))
  const platformTotal = metrics.platforms.reduce((sum, row) => sum + row.n, 0)
  const signinText = metrics.signinWeek.length === 0
    ? '暂无数据'
    : metrics.signinWeek.map((row) => `${row.result} ${row.n}`).join(' · ')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Mareo 运营数据</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #fcfcfd; --panel: #fff; --border: #e6e8ee; --border-soft: #f1f2f6;
  --text: #16181d; --muted: #6b7280; --faint: #9aa1ac;
  --accent: #2f5bea; --accent-soft: rgba(47, 91, 234, 0.12);
  --warn: #a86400; --warn-soft: rgba(168, 100, 0, 0.10);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1014; --panel: #15181e; --border: #262b34; --border-soft: #1e232b;
    --text: #edeff3; --muted: #98a0ad; --faint: #6f7885;
    --accent: #7c96ff; --accent-soft: rgba(124, 150, 255, 0.16);
    --warn: #e0a44a; --warn-soft: rgba(224, 164, 74, 0.12);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 40px 24px 72px; background: var(--bg); color: var(--text);
  font: 14px/1.65 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-variant-numeric: tabular-nums;
}
.wrap { max-width: 1000px; margin: 0 auto; }
header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; justify-content: space-between; }
h1 { font-size: 21px; font-weight: 600; letter-spacing: -0.01em; margin: 0; }
.window { font-size: 12px; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 1px 10px; }
.meta { color: var(--faint); font-size: 12px; margin: 6px 0 0; }
.verdict { margin: 20px 0 0; padding: 10px 14px; border-radius: 8px; font-size: 14px;
  border: 1px solid var(--border); background: var(--panel); }
.verdict.warn { border-color: color-mix(in srgb, var(--warn) 40%, var(--border)); background: var(--warn-soft); color: var(--warn); }
h2 { font-size: 12px; font-weight: 600; letter-spacing: 0.06em; color: var(--muted); margin: 40px 0 12px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: 12px; margin-top: 16px; }
.kpi { border: 1px solid var(--border); border-radius: 10px; background: var(--panel); padding: 14px 16px; display: grid; gap: 2px; }
.kpi-label { font-size: 12px; color: var(--muted); }
.kpi-value { font-size: 27px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.25; }
.kpi-note { font-size: 12px; color: var(--faint); }
.trends { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 12px; }
.trend { border: 1px solid var(--border); border-radius: 10px; background: var(--panel); padding: 12px 14px 8px; }
.trend-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
.trend-total { font-size: 15px; font-weight: 600; }
.trend-days { display: flex; justify-content: space-between; font-size: 11px; color: var(--faint); margin-top: -4px; }
.spark { display: block; overflow: visible; }
.stages { border: 1px solid var(--border); border-radius: 10px; background: var(--panel); overflow: hidden; }
.stage { display: grid; grid-template-columns: 1fr auto; gap: 2px 16px; padding: 11px 16px; border-bottom: 1px solid var(--border-soft); align-items: baseline; }
.stage:last-child { border-bottom: 0; }
.stage-label { font-size: 13px; }
.stage-value { font-size: 16px; font-weight: 600; text-align: right; }
.stage-note { grid-column: 1 / -1; font-size: 12px; color: var(--faint); }
.step-note { font-size: 12px; color: var(--faint); margin: 10px 0 0; }
.bars .step-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; font-size: 13px; }
.bars .step-value { font-weight: 600; }
.bars .bar { height: 6px; border-radius: 3px; background: var(--border-soft); margin: 5px 0 3px; overflow: hidden; }
.bars .bar span { display: block; height: 100%; border-radius: 3px; background: var(--accent); }
.bars { display: grid; gap: 10px; }
.bars .step-head span:first-child { color: var(--muted); }
details { margin-top: 40px; border-top: 1px solid var(--border); padding-top: 12px; }
summary { cursor: pointer; font-size: 12px; font-weight: 600; letter-spacing: 0.06em; color: var(--muted); }
summary::marker { color: var(--faint); }
.summary-hint { float: right; font-weight: 400; letter-spacing: 0; color: var(--faint); }
.health { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr)); gap: 12px 24px; margin: 14px 0 0; }
.health .row { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; padding: 5px 0; border-bottom: 1px solid var(--border-soft); }
.health .row span:first-child { color: var(--muted); }
.health .row span:last-child { font-weight: 500; }
.health table { margin-top: 14px; }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
th, td { text-align: left; padding: 8px 14px; border-bottom: 1px solid var(--border-soft); font-size: 13px; }
tr:last-child th, tr:last-child td { border-bottom: 0; }
th { font-weight: 400; color: var(--muted); }
td { text-align: right; }
footer { margin-top: 44px; color: var(--faint); font-size: 12px; }
footer a { color: inherit; }
@media (max-width: 720px) {
  body { padding: 24px 16px 48px; }
  .kpi-value { font-size: 24px; }
  .trends, .health { grid-template-columns: 1fr; }
  .kpi, .trend, .stage { min-width: 0; }
}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Mareo 运营数据</h1>
    <span class="window">近 7 天 · 北京日</span>
  </header>
  <p class="meta">生成于 ${escapeHtml(options.generatedAt.toISOString())}（UTC）· 全部为聚合值，不含任何账号信息</p>

  <p class="verdict ${summary.tone}">${escapeHtml(summary.text)}</p>

  <div class="kpis">
    ${kpi('新增安装', String(funnel.installs), `今日 ${metrics.installsToday} · 累计 ${metrics.installs}`)}
    ${kpi('活跃账号', String(metrics.activeWeek), `今日 ${metrics.activeToday}`)}
    ${kpi('模型请求', metrics.requestsWeek.toLocaleString('en-US'), `今日 ${metrics.requestsToday.toLocaleString('en-US')}`)}
    ${kpi('注册账号', String(metrics.accounts), `今日 ${metrics.accountsToday} · 用过模型 ${metrics.accountsWithUsage}`)}
  </div>

  <h2>趋势</h2>
  <div class="trends">
    ${trend('新增安装', seriesOf((row) => row.installs), String(funnel.installs))}
    ${trend('活跃账号', seriesOf((row) => row.active), String(metrics.activeWeek))}
    ${trend('模型请求', seriesOf((row) => row.requests), metrics.requestsWeek.toLocaleString('en-US'))}
  </div>

  <h2>关键环节</h2>
  <div class="stages">
    ${stage('官网访问', funnel.views, '近 7 天 · 执行 JS 的真实浏览器')}
    ${stage('完成安装', funnel.installs, `近 7 天 · 累计 ${metrics.installs}`)}
    ${stage('注册账号', funnel.accounts, `近 7 天 · 累计 ${metrics.accounts}`)}
    ${stage('用过模型', funnel.withUsage, `近 7 天 · 累计 ${metrics.accountsWithUsage}`)}
  </div>
  <p class="step-note">
    本周访问 → 安装 ${percent(funnel.installs, funnel.views)}（${funnel.installs} / ${funnel.views}）；安装包下载（访问日志计数）${options.downloads === undefined ? '—' : options.downloads}。
    各环节人群不同，不能相互换算。
  </p>

  <h2>平台分布</h2>
  <div class="bars">
    ${metrics.platforms.length === 0
      ? '<div class="step-note">暂无数据</div>'
      : metrics.platforms
          .map((row) => `<div class="step"><div class="step-head"><span>${escapeHtml(row.platform)}</span>` +
            `<span class="step-value">${row.n}</span></div>` +
            `<div class="bar"><span style="width:${platformTotal === 0 ? 0 : Math.max(2, Math.round((row.n / platformTotal) * 100))}%"></span></div>` +
            `<div class="step-note">${percent(row.n, platformTotal)}</div></div>`)
          .join('')}
  </div>

  <details>
    <summary>工程健康<span class="summary-hint">启动成功率 ${launchRate} · 异常退出 ${metrics.harnessExitsWeek} 次 · 模型成功率 ${modelRate}</span></summary>
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
        <div class="row"><span>用量异常（今日超过 500 次）</span><span>${metrics.heavyToday.length === 0 ? '无' : metrics.heavyToday.length + ' 个账号'}</span></div>
        <div class="row"><span>启动次数</span><span>${metrics.launchesWeek.total}</span></div>
      </div>
    </div>
    <table>${
      metrics.versions.length === 0
        ? `<tr><th>版本分布</th><td>暂无数据</td></tr>`
        : metrics.versions
            .map((row) => `<tr><th>${escapeHtml(row.version)} · ${escapeHtml(row.platform)}</th><td>${row.n}</td></tr>`)
            .join('')
    }</table>
  </details>

  <footer>
    数据来源：Mareo 网关的聚合统计。<a href="/">返回首页</a> · <a href="/privacy.html">隐私说明</a>
  </footer>
</div>
</body>
</html>
`
}

function main(): void {
  const args = process.argv.slice(2)
  const downloadsIndex = args.indexOf('--downloads')
  const downloads = downloadsIndex >= 0 ? Number.parseInt(args[downloadsIndex + 1] ?? '', 10) : undefined
  const db = openDatabase(dbPath)
  const metrics = collect(db)
  process.stdout.write(
    renderStatsPage(metrics, {
      downloads: Number.isFinite(downloads) ? downloads : undefined,
      generatedAt: new Date(),
    }),
  )
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main()
}

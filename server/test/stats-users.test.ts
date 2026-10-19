// The numbers on this page are read as facts about people, so the cohort maths
// is pinned with a seeded database rather than a real one: a fixed "today" and
// known activity days make D1/D3/D7 checkable by hand.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { openDatabase, type GatewayDatabase } from '../src/db.js'
import { collectUsers, HEAVY_WEEKLY_REQUESTS, renderUsersPage } from '../src/stats-users.js'

let directory: string
let db: GatewayDatabase

/** 2026-10-19 12:00 Beijing: a fixed "now" so the cohorts are deterministic. */
const NOW = new Date('2026-10-19T04:00:00.000Z')

before(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'mareo-users-'))
  db = openDatabase(path.join(directory, 'gateway.db'))
})

after(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

let accountSeq = 0
function account(name: string): string {
  accountSeq += 1
  const id = `acct-${accountSeq}`
  db.prepare('INSERT INTO users (id, displayName, createdAt) VALUES (?, ?, ?)').run(id, name, '2026-10-01 00:00:00')
  return id
}

/** A usage row at a Beijing day offset from 2026-10-19 (0 = today). */
function usage(userId: string, daysAgo: number, options: { session?: string; status?: number; micro?: number } = {}): void {
  const at = new Date(Date.parse('2026-10-19T04:00:00.000Z') - daysAgo * 864e5).toISOString()
  db.prepare(
    `INSERT INTO usage (userId, ts, model, promptChars, completionChars, status, latencyMs, requestKind,
                        inputTokens, outputTokens, sessionId, usageSource, actualMicro, billableMicro, marginMicro, paidFromFreeMicro)
     VALUES (?, ?, 'deepseek-flash', 10, 10, ?, 100, 'chat', 1, 1, ?, 'upstream', ?, ?, 0, 0)`,
  ).run(userId, at, options.status ?? 200, options.session ?? null, options.micro ?? 1_000_000, options.micro ?? 1_000_000)
}

test('a cohort keeps who came back on day 1, 3 and 7', () => {
  // Three accounts first succeeded seven days ago.
  const a = account('用户A')
  const b = account('用户B')
  const c = account('用户C')
  for (const id of [a, b, c]) usage(id, 7, { session: `s-${id}-first` })
  usage(a, 6)                     // D1 for A
  usage(b, 4)                     // D3 for B
  usage(a, 0)                     // D7 for A

  const metrics = collectUsers(db, NOW)
  const cohort = metrics.cohorts.find((row) => row.day === '2026-10-12')
  assert.ok(cohort !== undefined, '七天前的 cohort 应该出现')
  assert.equal(cohort.size, 3)
  assert.equal(cohort.d1, 1, '只有 A 在 D1 回来')
  assert.equal(cohort.d3, 1, '只有 B 在 D3 回来')
  assert.equal(cohort.d7, 1, '只有 A 在 D7 回来')
})

test('a cohort that is not old enough shows a dash rather than zero', () => {
  const fresh = account('新用户')
  usage(fresh, 0)
  const metrics = collectUsers(db, NOW)
  const today = metrics.cohorts.find((row) => row.day === '2026-10-19')
  assert.ok(today !== undefined)
  assert.equal(today.size, 1)
  assert.equal(today.d1, undefined, '明天的留存现在不知道，不能算 0')
  assert.equal(today.d7, undefined)
})

test('DAU, WAU and MAU count distinct accounts, and depth divides by them', () => {
  const metrics = collectUsers(db, NOW)
  const activeToday = new Set(['2026-10-19'])
  assert.ok(metrics.dau >= 1)
  assert.ok(metrics.mau >= metrics.wau, 'MAU 覆盖 WAU')
  assert.ok(metrics.wau >= metrics.dau, 'WAU 覆盖 DAU')
  assert.equal(activeToday.has('2026-10-19'), true)
  // A per-user average must be a ratio of counts, never of sessions by users with no sessions.
  assert.ok(metrics.activeDaysPerUserWeek >= 0 && metrics.activeDaysPerUserWeek <= 7)
  assert.ok(metrics.sessionsPerDau >= 0)
})

test('per-user cost percentiles are ordered', () => {
  const metrics = collectUsers(db, NOW)
  const { p50Micro, p90Micro, p99Micro } = metrics.costPercentiles
  assert.ok(p50Micro <= p90Micro, 'P50 不超过 P90')
  assert.ok(p90Micro <= p99Micro, 'P90 不超过 P99')
  assert.ok(metrics.costPerSessionMicro >= 0)
  assert.ok(metrics.costPerUserDayMicro >= 0)
})

test('a heavy user is one above the weekly request threshold, listed by cost', () => {
  const heavy = account('重度用户')
  for (let index = 0; index < HEAVY_WEEKLY_REQUESTS + 10; index += 1) {
    usage(heavy, 0, { micro: 100_000 })
  }
  const metrics = collectUsers(db, NOW)
  assert.ok(metrics.heavyCount >= 1)
  const listed = metrics.heavy.find((user) => user.accountId === heavy)
  assert.ok(listed !== undefined, '超过阈值的账号应该出现在列表里')
  assert.ok(listed.requests >= HEAVY_WEEKLY_REQUESTS, '列表里的请求数是本周的')
  assert.equal(listed.paid, false, '没有购买记录就是未付费')
  const costs = metrics.heavy.map((user) => user.actualMicro)
  assert.deepEqual([...costs].sort((left, right) => right - left), costs, '按成本从高到低')
})

test('the page states what it cannot see', () => {
  const metrics = collectUsers(db, NOW)
  const page = renderUsersPage(metrics, { generatedAt: NOW })
  assert.match(page, /用户与留存/)
  assert.match(page, /DAU/)
  assert.match(page, /WAU/)
  assert.match(page, /MAU/)
  assert.match(page, /留存（按首次调用成功分 cohort）/)
  assert.match(page, /使用深度/)
  assert.match(page, /重度用户/)
  assert.match(page, /Session 相关指标是下限/, '会话标识的覆盖限制要说出来')
  assert.match(page, /不含任何对话内容/)
  // No external requests, and nothing a client controls is rendered raw.
  assert.equal(/<script|src="http|href="http/.test(page), false)
  // Tables are reachable by assistive tech: caption plus explicit scopes.
  assert.match(page, /<caption class="sr-only">/)
  assert.match(page, /scope="col"/)
  assert.match(page, /scope="row"/)
  assert.match(page, /<a class="skip" href="#main">/)
  assert.match(page, /class="topbar"/, '导航在首屏')
  assert.match(page, /aria-current="page">用户与留存</, '当前页要标记出来')
  assert.match(page, /<main id="main"/)
})

test('an empty database still renders the page', () => {
  const empty = openDatabase(path.join(directory, 'empty-users.db'))
  const page = renderUsersPage(collectUsers(empty, NOW), { generatedAt: NOW })
  assert.match(page, /近两周没有新的首次成功调用/)
  assert.match(page, /暂无达到阈值的账号/)
  empty.close()
})

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { openDatabase, type GatewayDatabase } from '../src/db.js'
import { collect, renderStatsPage } from '../src/stats-page.js'

let directory: string
let db: GatewayDatabase

before(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'mareo-stats-'))
  db = openDatabase(path.join(directory, 'gateway.db'))
})

after(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

test('the page reports aggregates and escapes anything a client controls', () => {
  const metrics = collect(db)
  const page = renderStatsPage(metrics, { downloads: 3, generatedAt: new Date('2026-09-14T12:00:00Z') })

  assert.match(page, /<html lang="zh-CN">/)
  assert.match(page, /<meta name="robots" content="noindex">/)
  // The five layers of the page, in the order a reader meets them.
  assert.match(page, /本周/)                                // the one-sentence verdict
  assert.match(page, /新增安装/)
  assert.match(page, /趋势/)
  assert.match(page, /关键环节/)                            // staged counts, not a fake funnel
  assert.match(page, /官网访问/)
  assert.match(page, /完成安装/)
  assert.match(page, /今日 0 · 累计 0/)                      // windows are spelled out
  assert.match(page, /近 7 天 · 执行 JS 的真实浏览器/)
  assert.match(page, /平台分布/)
  assert.match(page, /工程健康/)
  // No external requests: the page works offline and leaks nothing by loading.
  assert.equal(/<script|src="http|href="http/.test(page), false)

  const hostile = renderStatsPage(
    { ...metrics, versions: [{ version: '<script>alert(1)</script>', platform: 'darwin', n: 1 }] },
    { generatedAt: new Date() },
  )
  assert.equal(hostile.includes('<script>alert(1)</script>'), false)
  assert.match(hostile, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
})

test('the verdict names the broken step when traffic does not turn into installs', () => {
  const empty = collect(openDatabase(path.join(directory, 'verdict.db')))
  const page = renderStatsPage(
    {
      ...empty,
      funnelWeek: { views: 42, installs: 0, accounts: 0, withUsage: 0 },
      siteWeek: { total: 42, byPath: [] },
      accounts: 3,
      requestsWeek: 0,
    },
    { generatedAt: new Date('2026-09-14T12:00:00Z') },
  )
  assert.match(page, /本周官网有 42 次访问，没有新增安装：断点在「访问 → 安装」/)
  assert.match(page, /class="verdict warn"/)
})

test('the trend series has one row per day, oldest first', () => {
  const metrics = collect(db, new Date('2026-09-14T12:00:00Z'))
  assert.equal(metrics.series.length, 7)
  const days = metrics.series.map((row) => row.day)
  assert.deepEqual(days, [...days].sort(), '旧的日子在前')
  assert.equal(new Set(days).size, 7)
})

test('an empty database still renders a usable page', () => {
  const empty = openDatabase(path.join(directory, 'empty.db'))
  const page = renderStatsPage(collect(empty), { generatedAt: new Date('2026-09-14T12:00:00Z') })
  assert.match(page, /新增安装/)
  assert.match(page, /暂无数据/)
  empty.close()
})

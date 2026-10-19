// Two pages, two audiences: the business page answers "did the week work", the
// health page answers "is it running". Mixing them was the problem this rewrite
// set out to fix, so the tests check what each page does and does not say.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { openDatabase, type GatewayDatabase } from '../src/db.js'
import { collect, renderCeoPage, renderHealthPage, type Metrics } from '../src/stats-page.js'

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

const GENERATED = new Date('2026-09-14T12:00:00Z')

function withMetrics(overrides: Partial<Metrics>): Metrics {
  return { ...collect(db, GENERATED), ...overrides }
}

test('the business page leads with the four questions of the day', () => {
  const page = renderCeoPage(
    withMetrics({
      today: { dau: 12, activated: 3, returning: 9, d7Cohort: 4, d7Retained: 2, sessions: 21, sessionCoverage: 0.31 },
      money: {
        actualMicro: 12_340_000,
        billableMicro: 16_042_000,
        marginMicro: 3_702_000,
        rechargeMicro: 10_000_000,
        cashNetMicro: -2_340_000,
        costRecovery: 0.81,
        walletBalanceMicro: 9_960_000,
      },
    }),
    { downloads: 4, generatedAt: GENERATED },
  )

  assert.match(page, /<h1>Mareo 经营看板<\/h1>/)
  // The four numbers, in order, with their definitions beside them.
  assert.match(page, /DAU/)
  assert.match(page, /新增激活/)
  assert.match(page, /回访/)
  assert.match(page, /D7 留存/)
  assert.match(page, /50\.0%/)                                  // 2 of 4 retained
  assert.match(page, /样本过小/, '小 cohort 必须标注')
  assert.match(page, /31\.0%/)                                  // session coverage is stated, not hidden
  // The four blocks, in the order a reader needs them.
  const order = ['<h2>今日</h2>', '<h2>增长</h2>', '<h2>商业（今日）</h2>', '<h2>用户拿 Mareo 做什么（近 7 天）</h2>'].map(
    (heading) => page.indexOf(heading),
  )
  assert.ok(!order.includes(-1), '四个板块都要出现')
  assert.deepEqual([...order].sort((left, right) => left - right), order, '四个板块按顺序出现')
})

test('growth separates traffic counts from one cohort of new accounts', () => {
  const page = renderCeoPage(
    withMetrics({ funnelWeek: { views: 100, signups: 20, launched: 0, firstSuccess: 8, firstPurchase: 2 } }),
    { downloads: 30, generatedAt: GENERATED },
  )
  // Traffic: counts, and said so.
  assert.match(page, /官网访问/)
  assert.match(page, /安装包下载/)
  assert.match(page, /以上两步是<b>次数<\/b>，不是去重人数/)
  assert.match(page, /上一环节 30\.0%/)                          // downloads / views
  // Conversion: every step is a subset of this week's new accounts.
  for (const label of ['近 7 天新注册账号', '其中完成首次调用成功', '其中完成首次充值']) {
    assert.match(page, new RegExp(label), `漏斗缺少 ${label}`)
  }
  assert.match(page, /上一环节 40\.0%/)                          // firstSuccess / signups
  assert.match(page, /上一环节 25\.0%/)                          // firstPurchase / firstSuccess
  assert.doesNotMatch(page, /首次启动[^<]*<\/span><span class="step-value">/, '首启数据缺失，不画成 0')
})

test('the money block refuses to call a recharge revenue', () => {
  const page = renderCeoPage(
    withMetrics({
      money: {
        actualMicro: 10_000_000,
        billableMicro: 13_000_000,
        marginMicro: 3_000_000,
        rechargeMicro: 10_000_000,
        cashNetMicro: 0,
        costRecovery: 1,
        walletBalanceMicro: 9_960_000,
      },
    }),
    { generatedAt: GENERATED },
  )
  assert.match(page, /真实模型成本/)
  assert.match(page, /用户结算消耗/)
  assert.match(page, /毛利（钱包口径）/)
  assert.match(page, /今日充值/)
  assert.match(page, /现金净额/)
  assert.match(page, /Cost Recovery/)
  assert.match(page, /Wallet 未消耗余额/)
  assert.match(page, /充值不是收入/)
  // With nothing spent, recovery is undefined rather than infinite.
  const empty = renderCeoPage(withMetrics({ money: { ...collect(db).money, actualMicro: 0, costRecovery: undefined } }), {
    generatedAt: GENERATED,
  })
  assert.match(empty, /Cost Recovery/)
  assert.doesNotMatch(empty, /Infinity|NaN/)
})

test('the task mix is drawn from titles, and says how much of the week it covers', () => {
  const page = renderCeoPage(
    withMetrics({
      taskMix: [
        { category: 'coding', sessions: 60, share: 0.6 },
        { category: 'writing', sessions: 40, share: 0.4 },
      ],
      taskCoverage: 0.25,
    }),
    { generatedAt: GENERATED },
  )
  assert.match(page, /Coding \/ Debugging/)
  assert.match(page, /Writing/)
  assert.match(page, /60\.0%/)
  assert.match(page, /25\.0%/, '覆盖率必须说出来')
  assert.match(page, /关键词规则/, '分类方式要可核对')
})

test('an empty database renders both pages', () => {
  const ceo = renderCeoPage(collect(db, GENERATED), { generatedAt: GENERATED })
  const health = renderHealthPage(collect(db, GENERATED), { generatedAt: GENERATED })
  assert.match(ceo, /Mareo 经营看板/)
  assert.match(health, /Mareo 工程健康/)
  assert.match(ceo, /暂无带标题的会话/)
  assert.match(health, /暂无数据/)
})

test('the health page keeps the engineering detail off the business page', () => {
  const health = renderHealthPage(withMetrics({}), { generatedAt: GENERATED })
  for (const label of ['启动成功率', '引擎异常退出', '模型调用成功率', '成功率延迟', '额度用尽的请求', '请求结果', '版本与平台', '登录结果']) {
    assert.match(health, new RegExp(label), `Health 页缺少 ${label}`)
  }
  const ceo = renderCeoPage(withMetrics({}), { generatedAt: GENERATED })
  assert.doesNotMatch(ceo, /p50|p95/, '延迟不出现在经营页')
  assert.doesNotMatch(ceo, /版本分布/, '版本分布不出现在经营页')
  assert.doesNotMatch(ceo, /HTTP 200/, '状态码分布不出现在经营页')
})

test('the health line on the business page names what is off and links to the detail', () => {
  const healthy = renderCeoPage(withMetrics({ health: { ok: true, issues: [] } }), { generatedAt: GENERATED })
  const broken = renderCeoPage(
    withMetrics({ health: { ok: false, issues: ['模型成功率 91.0%', '引擎异常退出 2 次'] } }),
    { generatedAt: GENERATED },
  )
  assert.match(healthy, /系统正常/)
  assert.match(broken, /⚠ 模型成功率 91\.0% · 引擎异常退出 2 次/)
  assert.match(broken, /href="\/stats\/health\/"/)
})

test('neither page loads anything from outside', () => {
  const ceo = renderCeoPage(withMetrics({}), { generatedAt: GENERATED })
  const health = renderHealthPage(withMetrics({}), { generatedAt: GENERATED })
  for (const page of [ceo, health]) {
    assert.equal(/<script|src="http|href="http/.test(page), false)
    assert.match(page, /<meta name="robots" content="noindex">/)
  }
})

test('anything a client controls is escaped where it is rendered', () => {
  const metrics = withMetrics({
    versions: [{ version: '<script>alert(1)</script>', platform: 'darwin', n: 1 }],
  })
  const health = renderHealthPage(metrics, { generatedAt: GENERATED })
  assert.equal(health.includes('<script>alert(1)</script>'), false)
  assert.match(health, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
})

test('the health rules fire on the numbers that mean trouble', () => {
  const clean = withMetrics({
    requestsWeek: 100,
    okWeek: 100,
    launchesWeek: { total: 10, ok: 10 },
    harnessExitsWeek: 0,
    heavyToday: [],
    health: { ok: true, issues: [] },
  })
  assert.equal(renderCeoPage(clean, { generatedAt: GENERATED }).includes('⚠'), false, '都正常时不报警')

  const modelOff = withMetrics({ health: { ok: false, issues: ['模型成功率 90.0%'] } })
  assert.match(renderCeoPage(modelOff, { generatedAt: GENERATED }), /⚠/)

  const crashes = withMetrics({ health: { ok: false, issues: ['引擎异常退出 1 次'] } })
  assert.match(renderCeoPage(crashes, { generatedAt: GENERATED }), /引擎异常退出 1 次/)
})

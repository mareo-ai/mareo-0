// The meter is the only part of the quota a user sees. It shows money — today's
// free allowance and the wallet behind it — and never a token count, a model
// price or the settlement rate. What it renders, and what it refuses to render,
// is worth pinning down.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { readSnapshot } from '../src/quota.js'

interface Snapshot {
  quota: { limitMicro: number; spentMicro: number; remainingMicro: number; usedPercent: number; exhausted: boolean; resetAt: string; visible: boolean }
  free: { limitMicro: number; usedMicro: number; remainingMicro: number; resetAt: string }
  wallet: { balanceMicro: number }
  total: { remainingMicro: number }
}

function meterHarness(snapshot: Snapshot | null) {
  // The plugin builds plain element descriptions; a component is `tag` and its
  // props are `props`, which is all this harness needs to walk.
  type Element = {
    tag?: ((props: { wide: boolean }) => unknown) & { name?: string }
    props?: { wide: boolean }
    children?: Element[]
  }
  const hooks: Record<number, unknown> = {}
  const effects: (() => void)[] = []
  const intervals: (() => void)[] = []
  let cursor = 0
  let renderFooter: (props: { wide: boolean }) => Element

  const react = {
    useState(initial: unknown) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = initial
      return [hooks[index], (value: unknown) => { hooks[index] = value }]
    },
    useEffect(effect: () => (() => void) | undefined) {
      cursor++
      effects.push(() => effect())
    },
    createElement(tag: unknown, props: unknown, ...children: unknown[]) {
      return { tag, props, children }
    },
  }

  const plugin: { apply?: (ctx: unknown) => void } = {}
  vm.runInNewContext(readFileSync('brand/client.cjs', 'utf8'), {
    exports: plugin,
    logoUrl: 'test',
    require: () => react,
    document: { visibilityState: 'visible', hasFocus: () => true, addEventListener: () => {}, removeEventListener: () => {} },
    window: {
      __mareoQuota: { get: async () => snapshot },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    setInterval: (callback: () => void) => { intervals.push(callback); return intervals.length },
    clearInterval: () => {},
  })
  plugin.apply!({
    slots: {
      inject: (_name: string, callback: () => void) => callback(),
      register: (options: { name: string }, render: typeof renderFooter) => {
        if (options.name === 'sidebar.footer.action') renderFooter = render
      },
    },
  })

  return {
    async render(wide = true) {
      cursor = 0
      const footer = renderFooter({ wide })
      const meter = (footer.children ?? []).find(
        (child) => typeof child?.tag === 'function' && child.tag.name === 'QuotaMeter',
      )
      if (meter === undefined) return null
      // Reset the hook cursor per draw: the stub resolves hooks by call order.
      const draw = () => {
        cursor = 0
        return (meter.tag as (props: { wide: boolean }) => Element)({ wide })
      }
      // First draw registers the hooks, then the effect starts the fetch, then
      // the resolved snapshot is drawn.
      draw()
      effects.splice(0).forEach((effect) => effect())
      await new Promise((resolve) => setImmediate(resolve))
      return draw()
    },
  }
}

const RESET_AT = '2026-09-17T16:00:00.000Z'

function full(overrides: Partial<Snapshot> = {}): Snapshot {
  const base: Snapshot = {
    quota: {
      limitMicro: 10_000_000,
      spentMicro: 6_200_000,
      remainingMicro: 3_800_000,
      usedPercent: 62,
      exhausted: false,
      resetAt: RESET_AT,
      visible: true,
    },
    free: { limitMicro: 10_000_000, usedMicro: 6_200_000, remainingMicro: 3_800_000, resetAt: RESET_AT },
    wallet: { balanceMicro: 23_500_000 },
    total: { remainingMicro: 27_300_000 },
  }
  return { ...base, ...overrides }
}

test('the meter shows both buckets in yuan and nothing else', async () => {
  const node = await meterHarness(full()).render()
  assert.ok(node !== null)
  const text = JSON.stringify(node)
  assert.match(text, /今日免费剩余/)
  assert.match(text, /38%/, '免费额度只呈现剩余比例')
  assert.match(text, /Mareo 余额/)
  assert.match(text, /¥23\.50/, '钱包余额是用户自己的钱，如实显示')
  assert.match(text, /每日 0 点重置/)
  assert.match(text, /充值余额 →/)
  // 免费额度的金额不能出现在任何地方：显示 ¥4/¥10 等于把可调的运营参数告诉用户，
  // 显示「可用合计」则能用 合计−余额 反推出来。
  assert.doesNotMatch(text, /¥3\.80/)
  assert.doesNotMatch(text, /¥10\.00/)
  assert.doesNotMatch(text, /可用合计/)

  const walletOnly = await meterHarness(
    full({ wallet: { balanceMicro: 0 }, free: { limitMicro: 2_000_000, usedMicro: 1_200_000, remainingMicro: 800_000, resetAt: RESET_AT } }),
  ).render()
  const reduced = JSON.stringify(walletOnly)
  assert.match(reduced, /40%/, '额度从 ¥10 调到 ¥2 时，界面仍是同一个比例口径')
  assert.doesNotMatch(reduced, /¥2\.00|¥0\.80/)
  // The card is wrapped in a fragment now: the first child is the recharge action,
  // the second is the invite entry, and both are reachable by keyboard.
  const parts = (node.children ?? []) as unknown[]
  const rechargeCard = parts[0] as { tag?: unknown; props?: { onClick?: unknown } }
  assert.equal(node.tag, undefined, 'the wrapper is a fragment, not a button')
  assert.equal(rechargeCard?.tag, 'button', 'the card itself is a keyboard-accessible recharge action')
  assert.equal(typeof rechargeCard?.props?.onClick, 'function')
  assert.match(text, /progressbar/)
  assert.match(text, /"aria-valuenow":38/, 'the bar represents the remaining free allowance')
  // Micro-yuan stops at the gateway: every amount on screen is in yuan.
  assert.doesNotMatch(text, /[0-9]{7}/)
  assert.doesNotMatch(text, /已用 62%/, 'the percentage is replaced by the amount')
  assert.doesNotMatch(text, /token/i)
})

test('an exhausted account is told it is out and offered a top-up', async () => {
  const spent = { limitMicro: 10_000_000, usedMicro: 10_000_000, remainingMicro: 0, resetAt: RESET_AT }
  const harness = meterHarness(
    full({
      quota: { ...full().quota, spentMicro: 10_000_000, remainingMicro: 0, usedPercent: 100, exhausted: true },
      free: spent,
      wallet: { balanceMicro: 0 },
      total: { remainingMicro: 0 },
    }),
  )
  const text = JSON.stringify(await harness.render())
  assert.match(text, /额度已用完 · 充值后继续使用/)
  assert.match(text, /免费额度北京时间 0 点后恢复/)
  assert.match(text, /充值余额 →/)
  assert.match(text, /"tag":"button"/)
  // No task, no ad, no simulated earning: the only way on is paying.
  assert.doesNotMatch(text, /模拟/)
})

test('a wallet pushed negative by an allowed overdraft reads as a debt', async () => {
  const harness = meterHarness(
    full({
      free: { limitMicro: 10_000_000, usedMicro: 9_000_000, remainingMicro: 1_000_000, resetAt: RESET_AT },
      wallet: { balanceMicro: -200_000 },
      total: { remainingMicro: 1_000_000 },
    }),
  )
  const text = JSON.stringify(await harness.render())
  assert.match(text, /-¥0\.20/, '透支后的余额显示为负，用户看得见自己欠了多少')
  assert.match(text, /10%/, '免费额度只给比例')
})

test('nothing renders when the gateway is not running a quota for this account', async () => {
  const hidden = await meterHarness(full({ quota: { ...full().quota, visible: false } })).render()
  assert.equal(hidden, null)
  const missing = await meterHarness(null).render()
  assert.equal(missing, null)
})

test('a collapsed sidebar renders nothing', async () => {
  assert.equal(await meterHarness(full()).render(false), null)
})

test('a meter that cannot be read is refused rather than half-rendered', () => {
  const good = full()
  const parsed = readSnapshot(JSON.parse(JSON.stringify(good)) as unknown)
  assert.equal(parsed?.wallet.balanceMicro, 23_500_000)
  assert.equal(parsed?.free.remainingMicro, 3_800_000)
  assert.equal(parsed?.total.remainingMicro, 27_300_000)

  // A gateway that predates the wallet sends no free/wallet/total: the meter
  // hides instead of showing a balance it does not have.
  assert.equal(readSnapshot({ quota: good.quota }), null)
  assert.equal(readSnapshot({ ...good, wallet: undefined }), null)
  assert.equal(readSnapshot({ ...good, total: { remainingMicro: 'lots' } }), null)
  assert.equal(readSnapshot(null), null)
  assert.equal(readSnapshot({ ...good, quota: { ...good.quota, resetAt: 17 } }), null)

  // An overdraft is a real state, and a percentage out of range is clamped.
  assert.equal(readSnapshot({ ...good, wallet: { balanceMicro: -200_000 } })?.wallet.balanceMicro, -200_000)
  assert.equal(readSnapshot({ ...good, quota: { ...good.quota, usedPercent: 130 } })?.quota.usedPercent, 100)
  assert.equal(readSnapshot({ ...good, quota: { ...good.quota, usedPercent: -5 } })?.quota.usedPercent, 0)
})

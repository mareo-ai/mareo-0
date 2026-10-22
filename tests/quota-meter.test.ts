// The sidebar shows whether the user can continue and which source is available,
// without exposing the free amount or the Wallet balance. Actual money remains
// visible in the account and payment screens.
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

test('the status strip shows two available sources without amounts or percentages', async () => {
  const node = await meterHarness(full()).render()
  assert.ok(node !== null)
  const text = JSON.stringify(node)
  assert.match(text, /可以继续使用/)
  assert.match(text, /每日都有免费额度/)
  assert.match(text, /今日免费 · 可用/)
  assert.match(text, /Mareo 余额 · 可用/)
  assert.match(text, /充值余额 →/)
  assert.equal(node.tag, 'button', 'the whole card is a keyboard-accessible recharge action')
  assert.equal(typeof (node.props as { onClick?: unknown }).onClick, 'function')
  assert.match(text, /"aria-hidden":true/, 'the two colored segments are decorative; text names each state')
  assert.doesNotMatch(text, /¥|progressbar|可用合计|token/i)
  assert.doesNotMatch(text, /10\.00|23\.50|27\.30/, 'the daily allowance and wallet amounts stay out of the sidebar')
})

test('used-up free allowance still allows use when the Wallet has credit', async () => {
  const snapshot = full({
    free: { limitMicro: 10_000_000, usedMicro: 10_000_000, remainingMicro: 0, resetAt: RESET_AT },
    wallet: { balanceMicro: 23_500_000 },
  })
  const text = JSON.stringify(await meterHarness(snapshot).render())
  assert.match(text, /可以继续使用/)
  assert.match(text, /今日免费已用完 · 明日恢复/)
  assert.match(text, /今日免费 · 已用完/)
  assert.match(text, /Mareo 余额 · 可用/)
  assert.doesNotMatch(text, /¥|暂时无法继续使用/)
})

test('an exhausted account is offered recharge and told free use returns tomorrow', async () => {
  const snapshot = full({
    quota: { ...full().quota, spentMicro: 10_000_000, remainingMicro: 0, usedPercent: 100, exhausted: true },
    free: { limitMicro: 10_000_000, usedMicro: 10_000_000, remainingMicro: 0, resetAt: RESET_AT },
    wallet: { balanceMicro: 0 },
    total: { remainingMicro: 0 },
  })
  const text = JSON.stringify(await meterHarness(snapshot).render())
  assert.match(text, /暂时无法继续使用/)
  assert.match(text, /今日免费已用完 · 明日恢复/)
  assert.match(text, /Mareo 余额 · 暂无/)
  assert.match(text, /充值后继续 →/)
  assert.doesNotMatch(text, /¥|模拟/)
})

test('an overdrawn Wallet does not block daily free use or show a negative amount', async () => {
  const snapshot = full({
    free: { limitMicro: 10_000_000, usedMicro: 9_000_000, remainingMicro: 1_000_000, resetAt: RESET_AT },
    wallet: { balanceMicro: -200_000 },
    total: { remainingMicro: 1_000_000 },
  })
  const text = JSON.stringify(await meterHarness(snapshot).render())
  assert.match(text, /可以继续使用/)
  assert.match(text, /今日免费 · 可用/)
  assert.match(text, /Mareo 余额 · 暂无/)
  assert.doesNotMatch(text, /¥|暂时无法继续使用/)
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

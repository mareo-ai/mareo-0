// The recharge panel is where money is asked for, so what it shows at each step
// and what it refuses to do matters: it never prices anything itself, it stops
// polling when it is not in use, and it holds no payment credential. It is
// opened from the Account section, which is the entry this test drives.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { readConfig, readOrder } from '../src/payment.js'

type Element = { tag?: unknown; props?: Record<string, unknown>; children?: unknown[] }
type Component = (props: Record<string, unknown>) => Element

interface Options {
  config?: unknown
  created?: unknown
  fetchedOrder?: unknown
  invite?: unknown
}

function harness(options: Options = {}) {
  const hooks: Record<string, Record<number, unknown>> = {}
  const effects: Record<string, { run: () => (() => void) | undefined; cleanup?: () => void; deps?: unknown[]; pending?: boolean }[]> = {}
  const intervals: { callback: () => void; cleared: boolean }[] = []
  const calls = { createdWith: [] as unknown[], order: 0 }
  let current = ''
  let cursor = 0

  const react = {
    useState(initial: unknown) {
      const name = current
      const index = cursor++
      hooks[name] ??= {}
      if (!(index in hooks[name])) hooks[name][index] = initial
      return [hooks[name][index], (value: unknown) => {
        hooks[name][index] = typeof value === 'function'
          ? (value as (previous: unknown) => unknown)(hooks[name][index])
          : value
      }]
    },
    useEffect(effect: () => (() => void) | undefined, deps?: unknown[]) {
      const name = current
      const index = cursor++
      effects[name] ??= []
      const previous = effects[name][index]
      const changed = previous === undefined || deps === undefined || previous.deps === undefined ||
        deps.length !== previous.deps.length || deps.some((dep, i) => dep !== (previous.deps as unknown[])[i])
      if (changed) {
        // React runs the previous cleanup before applying changed dependencies.
        const previousCleanup = previous?.cleanup
        if (typeof previousCleanup === 'function') previousCleanup()
        // Only a changed effect runs, as React would; marking it pending here
        // keeps `settle` from re-running an unchanged one every round.
        effects[name][index] = { run: effect, deps, pending: true }
      }
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
    document: {},
    window: {
      __mareoAccount: {
        getProfile: async () => ({ ok: true, displayName: '测试', email: 'a@example.com' }),
        updateName: async () => ({ ok: true, displayName: '测试' }),
        signOut: async () => {},
      },
      __mareoPayment: {
        config: async () => options.config ?? null,
        createOrder: async (tier: string, channel: string) => {
          calls.createdWith.push([tier, channel])
          return options.created ?? { ok: true, order: pendingOrder() }
        },
        order: async () => {
          calls.order += 1
          return options.fetchedOrder ?? pendingOrder()
        },
        orders: async () => [],
      },
      __mareoQuota: { get: async () => null },
      __mareoInvite: { get: async () => options.invite ?? null },
      navigator: { clipboard: { writeText: async () => {} } },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    setInterval: (callback: () => void) => {
      intervals.push({ callback, cleared: false })
      return intervals.length
    },
    clearInterval: (id: number) => {
      const entry = intervals[(id as number) - 1]
      if (entry) entry.cleared = true
    },
  })

  let overlay: Component | undefined
  let account: Component | undefined
  plugin.apply!({
    slots: {
      inject: (_name: string, callback: () => void) => callback(),
      register: (registration: { name: string }, render: Component) => {
        if (registration.name === 'shell.overlay' && render.name === 'RechargeOverlay') overlay = render
        if (registration.name === 'settings.section' && render.name === 'AccountSection') account = render
      },
    },
  })

  function draw(which: 'overlay' | 'account'): Element | null {
    const component = which === 'overlay' ? overlay : account
    if (component === undefined) return null
    current = which
    cursor = 0
    const tree = component({})
    // The overlay only wraps the panel; render the panel itself so `null` means
    // what it says (the panel is closed).
    if (which === 'overlay' && typeof tree.tag === 'function') {
      current = 'panel'
      cursor = 0
      return (tree.tag as Component)({})
    }
    return tree
  }

  /**
   * One render/effect cycle per round: a state change only registers its effect
   * on the next draw, so settling has to draw first and flush promises after.
   */
  async function settle(): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
      draw('overlay')
      draw('account')
      for (const [name, list] of Object.entries(effects)) {
        for (const entry of list) {
          if (entry === undefined || entry.pending !== true) continue
          entry.pending = false
          current = name
          const cleanup = entry.run()
          entry.cleanup = typeof cleanup === 'function' ? cleanup : undefined
        }
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  async function open(): Promise<void> {
    draw('account')
    await settle()
    assert.equal(clickText(draw('account')!, '充值'), true, '账户区有充值入口')
    await settle()
  }

  return { draw, settle, open, intervals, calls }
}

const CONFIG = {
  enabled: true,
  tiers: [
    { tier: 't10', amountMicro: 10_000_000 },
    { tier: 't30', amountMicro: 30_000_000 },
    { tier: 't100', amountMicro: 100_000_000 },
  ],
  channels: ['alipay'],
}

function pendingOrder(overrides: Record<string, unknown> = {}) {
  return {
    orderId: 'MR20260101000000ABCDEF',
    status: 'pending',
    channel: 'alipay',
    amountMicro: 30_000_000,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
    paidAt: null,
    qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    ...overrides,
  }
}

/** Finds the element whose text is `label` and clicks it. */
function clickText(node: Element, label: string): boolean {
  let found = false
  const walk = (current: Element): void => {
    if (found) return
    const children = current.children ?? []
    if (children.includes(label) && typeof current.props?.onClick === 'function') {
      ;(current.props.onClick as () => void)()
      found = true
      return
    }
    for (const child of children) if (child && typeof child === 'object') walk(child as Element)
  }
  walk(node)
  return found
}

const text = (node: Element | null): string => JSON.stringify(node)

test('nothing is shown before the panel is opened', async () => {
  const tested = harness({ config: CONFIG })
  await tested.settle()
  assert.equal(tested.draw('overlay'), null)
})

test('the gateway decides the amounts and the channels', async () => {
  const tested = harness({ config: CONFIG })
  await tested.settle()
  await tested.open()
  const panel = text(tested.draw('overlay'))
  assert.match(panel, /充值 Mareo 余额/)
  assert.match(panel, /¥10\.00/)
  assert.match(panel, /¥30\.00/)
  assert.match(panel, /¥100\.00/)
  assert.match(panel, /支付方式/)
  assert.match(panel, /支付宝/)
  assert.doesNotMatch(panel, /微信支付/, '只有支付宝渠道时不出现微信')
  assert.match(panel, /使用支付宝支付 ¥30\.00/)
  assert.match(panel, /"aria-pressed":true/, 'selected amount is discernible')
  assert.match(panel, /先扣今日免费额度/)
  // 免费额度不覆盖 OpenAI 上游：额度条显示 100% 时，选 Mareo-O 仍会被拒，
  // 这一句是唯一能在界面上解释它的地方。
  assert.match(panel, /Mareo-O 系列不占免费额度/)
})

test('paying sends the tier and shows the QR the gateway rendered', async () => {
  const tested = harness({ config: CONFIG })
  await tested.settle()
  await tested.open()
  assert.equal(clickText(tested.draw('overlay')!, '使用支付宝支付 ¥30.00'), true)
  await tested.settle()
  const panel = text(tested.draw('overlay'))
  assert.deepEqual(tested.calls.createdWith, [['t30', 'alipay']], '默认 ¥30 与支付宝')
  assert.match(panel, /请用支付宝扫码支付/)
  assert.match(panel, /¥30\.00/, 'the amount comes from the created order')
  assert.match(panel, /"width":266/, 'the QR has room for the upstream 240px SVG')
  assert.match(panel, /svg/, '二维码来自网关，客户端不自带二维码库')
  assert.match(panel, /等待支付确认/)
  assert.match(panel, /二维码剩余有效时间/)
})

test('multiple channels stay selectable and the button names the chosen channel', async () => {
  const tested = harness({ config: { ...CONFIG, channels: ['alipay', 'wechat'] } })
  await tested.settle()
  await tested.open()
  assert.equal(clickText(tested.draw('overlay')!, '微信支付'), true)
  await tested.settle()
  assert.match(text(tested.draw('overlay')), /使用微信支付 ¥30\.00/)
  assert.equal(clickText(tested.draw('overlay')!, '使用微信支付 ¥30.00'), true)
  await tested.settle()
  assert.deepEqual(tested.calls.createdWith, [['t30', 'wechat']])
})

test('the QR screen shows the amount on the created order, not the chosen tier', async () => {
  const tested = harness({ config: CONFIG, created: { ok: true, order: pendingOrder({ amountMicro: 10_000_000 }) } })
  await tested.settle()
  await tested.open()
  clickText(tested.draw('overlay')!, '使用支付宝支付 ¥30.00')
  await tested.settle()
  const panel = text(tested.draw('overlay'))
  assert.match(panel, /¥10\.00/)
  assert.doesNotMatch(panel, /¥30\.00/)
})

test('a paid order announces the arrival and stops polling', async () => {
  const tested = harness({ config: CONFIG, fetchedOrder: pendingOrder({ status: 'paid', paidAt: '2026-01-01T00:02:00.000Z' }) })
  await tested.settle()
  await tested.open()
  clickText(tested.draw('overlay')!, '使用支付宝支付 ¥30.00')
  await tested.settle()
  const poll = tested.intervals.find((entry) => !entry.cleared)
  assert.ok(poll !== undefined, '待支付订单会开始轮询')
  poll.callback()
  await tested.settle()
  assert.match(text(tested.draw('overlay')), /已到账 ¥30\.00/)
  assert.ok(tested.intervals.every((entry) => entry.cleared), '成功后停止轮询')
})

test('an expired order asks for a new one', async () => {
  const tested = harness({ config: CONFIG, fetchedOrder: pendingOrder({ status: 'cancelled' }) })
  await tested.settle()
  await tested.open()
  clickText(tested.draw('overlay')!, '使用支付宝支付 ¥30.00')
  await tested.settle()
  tested.intervals.find((entry) => !entry.cleared)?.callback()
  await tested.settle()
  const panel = text(tested.draw('overlay'))
  assert.match(panel, /二维码已过期/)
  assert.match(panel, /使用支付宝支付 ¥30\.00/)
})

test('a gateway refusal is shown as a sentence', async () => {
  const tested = harness({ config: CONFIG, created: { ok: false, error: '今天的充值额度已达上限，明天再试' } })
  await tested.settle()
  await tested.open()
  clickText(tested.draw('overlay')!, '使用支付宝支付 ¥30.00')
  await tested.settle()
  const panel = text(tested.draw('overlay'))
  assert.match(panel, /今天的充值额度已达上限，明天再试/)
  assert.doesNotMatch(panel, /daily-limit/, '错误码不直接给用户看')
})

// --- the boundary those screens depend on -------------------------------

test('only a usable config reaches the panel', () => {
  assert.deepEqual(readConfig(CONFIG), CONFIG)
  assert.equal(readConfig({ enabled: false, tiers: [], channels: [] }), null, '没有档位就是不可用')
  assert.equal(readConfig({ enabled: true, tiers: [{ tier: 't10', amountMicro: 0 }], channels: [] }), null)
  assert.equal(readConfig({ enabled: true, tiers: [{ tier: 't10', amountMicro: 10_000_000 }] }), null, '缺 channels')
  assert.deepEqual(readConfig({ ...CONFIG, channels: ['alipay', 'paypal'] })?.channels, ['alipay'])
})

test('only a well-formed order reaches the panel', () => {
  const parsed = readOrder(pendingOrder())
  assert.equal(parsed?.orderId, 'MR20260101000000ABCDEF')
  assert.equal(parsed?.amountMicro, 30_000_000)
  assert.equal(parsed?.qrSvg?.startsWith('<svg'), true)

  assert.equal(readOrder(pendingOrder({ orderId: '' })), undefined)
  assert.equal(readOrder(pendingOrder({ status: 'unknown' })), undefined)
  assert.equal(readOrder(pendingOrder({ channel: 'paypal' })), undefined)
  assert.equal(readOrder(pendingOrder({ amountMicro: '30' })), undefined)
  // Anything that is not an SVG is dropped rather than injected into the page.
  assert.equal(readOrder(pendingOrder({ qrSvg: '<img onerror=alert(1)>' }))?.qrSvg, undefined)
})

test('the invite block shows the code, the counts, and when a reward lands', async () => {
  const tested = harness({
    config: CONFIG,
    invite: { code: 'ABCD2345', granted: 2, remaining: 1, earnedMicro: 10_000_000, rewardMicro: 5_000_000 },
  })
  await tested.settle()
  await tested.open()
  const panel = text(tested.draw('overlay'))
  assert.match(panel, /邀请朋友，你得 ¥5\.00/)
  assert.match(panel, /ABCD2345/, '邀请码本身要能被看到并复制')
  assert.match(panel, /已邀请 2 人/)
  assert.match(panel, /¥10\.00/)
  assert.match(panel, /还可获得 1 次/)
  assert.match(panel, /复制/)
})

test('before anyone joins, the block says when the reward actually arrives', async () => {
  const tested = harness({
    config: CONFIG,
    invite: { code: 'WXYZ6789', granted: 0, remaining: 3, earnedMicro: 0, rewardMicro: 5_000_000 },
  })
  await tested.settle()
  await tested.open()
  const panel = text(tested.draw('overlay'))
  assert.match(panel, /还没有人用你的邀请码/)
  // Paying at sign-up would be a lie: the gateway waits for use plus a day.
  assert.match(panel, /注册满一天并开始使用后/)
  assert.doesNotMatch(panel, /¥0\.00/, '没有收益时不显示 0 元')
})

test('a gateway that returns no invite renders no invite block', async () => {
  const tested = harness({ config: CONFIG })
  await tested.settle()
  await tested.open()
  const panel = text(tested.draw('overlay'))
  assert.doesNotMatch(panel, /邀请朋友/)
})

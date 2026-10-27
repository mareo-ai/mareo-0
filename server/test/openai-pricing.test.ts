// What one OpenAI request costs, and what the gateway refuses to sell.
//
// The DeepSeek arithmetic is pinned in billing-http.test.ts. These are the rules
// that only exist because a second upstream is priced in dollars: the exchange
// rate, the cached-input price, the long-context tier, and the refusal to serve
// a model that has no price at all.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { hashToken } from '../src/auth.js'
import { createTokenAccount, openDatabase, storeToken, type GatewayDatabase } from '../src/db.js'
import { costOf, fxRate, isPeakHour, providerForModel, settleMicro, type TokenUsage } from '../src/pricing.js'
import { usageFromResponseText } from '../src/proxy.js'
import { createGatewayServer } from '../src/server.js'
import { writeSetting } from '../src/settings.js'

/** 100K cached + 100K miss: input stays under the long-context threshold. */
const SAMPLE: TokenUsage = {
  inputTokens: 200_000,
  cacheHitTokens: 100_000,
  cacheMissTokens: 100_000,
  outputTokens: 100_000,
  reasoningTokens: 0,
}

/** sol at $0.2 / $2 / $10 per 1M on SAMPLE: 0.02 + 0.2 + 1 = $1.22. */
const SOL_USD = 1.22

const at = (iso: string): Date => new Date(iso)

test('a model belongs to exactly one upstream', () => {
  assert.equal(providerForModel('deepseek-flash'), 'deepseek')
  assert.equal(providerForModel('gpt-6-sol'), 'openai')
  assert.equal(providerForModel('gpt-6-astra'), 'openai')
  assert.equal(providerForModel('gpt-5'), undefined, '未定价的模型必须没有归属')
  assert.equal(providerForModel(null), undefined)
})

test('dollar prices become yuan at the configured rate', () => {
  const previous = process.env.PRICING_FX_RATE
  try {
    process.env.PRICING_FX_RATE = '7'
    assert.equal(fxRate(), 7)
    assert.equal(costOf(SAMPLE, 'gpt-6-sol', at('2026-10-19T04:00:00Z')), SOL_USD * 7)

    // The rate is configuration, not a constant: the same tokens cost more.
    process.env.PRICING_FX_RATE = '7.5'
    assert.equal(costOf(SAMPLE, 'gpt-6-sol', at('2026-10-19T04:00:00Z')), SOL_USD * 7.5)
  } finally {
    if (previous === undefined) delete process.env.PRICING_FX_RATE
    else process.env.PRICING_FX_RATE = previous
  }
})

test('an unset or nonsense rate falls back to seven', () => {
  const previous = process.env.PRICING_FX_RATE
  try {
    for (const value of ['', '0', '-1', 'abc']) {
      process.env.PRICING_FX_RATE = value
      assert.equal(fxRate(), 7, `rate "${value}" 应回落到默认值`)
    }
  } finally {
    if (previous === undefined) delete process.env.PRICING_FX_RATE
    else process.env.PRICING_FX_RATE = previous
  }
})

test('OpenAI has no peak tier, DeepSeek still does', () => {
  const peakMonday = at('2026-10-19T02:00:00Z')
  const offPeakMonday = at('2026-10-19T12:00:00Z')
  assert.equal(isPeakHour(peakMonday), true)
  assert.equal(
    costOf(SAMPLE, 'gpt-6-sol', peakMonday),
    costOf(SAMPLE, 'gpt-6-sol', offPeakMonday),
    'OpenAI 不区分峰谷',
  )
  const deepseekPeak = costOf(SAMPLE, 'deepseek-flash', peakMonday)!
  const deepseekOff = costOf(SAMPLE, 'deepseek-flash', offPeakMonday)!
  assert.equal(deepseekPeak, deepseekOff * 2, 'DeepSeek 峰值是谷值的两倍')
})

test('a prompt over the long-context threshold reprices the whole request', () => {
  const big: TokenUsage = {
    inputTokens: 300_000,
    cacheHitTokens: 0,
    cacheMissTokens: 300_000,
    outputTokens: 1_000,
    reasoningTokens: 0,
  }
  const small: TokenUsage = { ...big, inputTokens: 272_000, cacheMissTokens: 272_000 }
  const previous = process.env.PRICING_FX_RATE
  try {
    process.env.PRICING_FX_RATE = '7'
    const peakFree = at('2026-10-19T04:00:00Z')
    const repriced = (300_000 / 1e6) * 2 * 7 * 2 + (1_000 / 1e6) * 10 * 7 * 1.5
    assert.equal(costOf(big, 'gpt-6-sol', peakFree), repriced, '整单重定价：输入 ×2、输出 ×1.5')
    // At exactly the threshold nothing is repriced.
    assert.equal(costOf(small, 'gpt-6-sol', at('2026-10-19T04:00:00Z')), (272_000 / 1e6) * 2 * 7 + (1_000 / 1e6) * 10 * 7)
  } finally {
    if (previous === undefined) delete process.env.PRICING_FX_RATE
    else process.env.PRICING_FX_RATE = previous
  }
})

test('settlement still rounds the charge up, per the standing rule', () => {
  const previous = process.env.PRICING_FX_RATE
  try {
    process.env.PRICING_FX_RATE = '7'
    const cost = costOf(SAMPLE, 'gpt-6-sol', at('2026-10-19T04:00:00Z'))!
    const { actualMicro, billableMicro, marginMicro } = settleMicro(cost, 1.3)
    assert.equal(actualMicro, Math.round(cost * 1_000_000))
    assert.equal(billableMicro, Math.ceil(actualMicro * 1.3))
    assert.equal(marginMicro, billableMicro - actualMicro)
  } finally {
    if (previous === undefined) delete process.env.PRICING_FX_RATE
    else process.env.PRICING_FX_RATE = previous
  }
})

test('Responses API usage is read as cached input, not as a miss', () => {
  // The shape OpenAI returns for /v1/responses: cached tokens live in the
  // details, and reading this as Anthropic would bill them at the miss price.
  const tail = '{"type":"response.completed","response":{"usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":900},"output_tokens":50,"output_tokens_details":{"reasoning_tokens":20}}}}'
  const usage = usageFromResponseText(tail)
  assert.ok(usage !== undefined)
  assert.equal(usage.inputTokens, 1000)
  assert.equal(usage.cacheHitTokens, 900)
  assert.equal(usage.cacheMissTokens, 100)
  assert.equal(usage.outputTokens, 50)
  assert.equal(usage.reasoningTokens, 20)
})

test('an unpriced model is refused before it reaches the upstream', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mareo-openai-'))
  const db: GatewayDatabase = openDatabase(path.join(directory, 'gateway.db'))
  const accountId = createTokenAccount(db, '未定价测试')
  const token = 'unpriced-token-123456'
  storeToken(db, { userId: accountId, label: 'test', tokenHash: hashToken(token) })
  writeSetting(db, 'quota.mode', 'off')

  let upstreamCalls = 0
  const upstream: Server = createHttpServer((_request, response) => {
    upstreamCalls += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ id: 'x' }))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port

  const gateway = createGatewayServer({
    db,
    upstreamBaseUrl: 'http://127.0.0.1:1',
    apiKey: 'unused',
    openaiUpstream: {
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: 'sk-test',
      stripPrefix: '/openai',
    },
    dailyLimit: 0,
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  const gatewayPort = (gateway.address() as AddressInfo).port

  try {
    const refused = await fetch(`http://127.0.0.1:${gatewayPort}/openai/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5', input: 'hi' }),
    })
    assert.equal(refused.status, 400)
    const body = (await refused.json()) as { error: string }
    assert.equal(body.error, 'unpriced-model')
    assert.equal(upstreamCalls, 0, '未定价的请求不应产生上游调用（否则是我们付钱）')

    const accepted = await fetch(`http://127.0.0.1:${gatewayPort}/openai/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-6-sol', input: 'hi' }),
    })
    assert.equal(accepted.status, 200)
    assert.equal(upstreamCalls, 1, '已定价的模型应当被转发')
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('without an OpenAI key the path answers 503 instead of proxying', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mareo-openai-off-'))
  const db = openDatabase(path.join(directory, 'gateway.db'))
  const accountId = createTokenAccount(db, '未配置测试')
  const token = 'unconfigured-token-123'
  storeToken(db, { userId: accountId, label: 'test', tokenHash: hashToken(token) })
  const gateway = createGatewayServer({ db, upstreamBaseUrl: 'http://127.0.0.1:1', apiKey: 'unused', dailyLimit: 0 })
  return new Promise<void>((resolve, reject) => {
    gateway.listen(0, '127.0.0.1', async () => {
      try {
        const port = (gateway.address() as AddressInfo).port
        const response = await fetch(`http://127.0.0.1:${port}/openai/v1/responses`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ model: 'gpt-6-sol' }),
        })
        assert.equal(response.status, 503)
        const body = (await response.json()) as { error: string }
        assert.equal(body.error, 'openai-unavailable')
        gateway.close(() => {
          db.close()
          rmSync(directory, { recursive: true, force: true })
          resolve()
        })
      } catch (error) {
        reject(error)
      }
    })
  })
})

test('a Sol request is attributed to its session from the body, not the header', async () => {
  // The Responses route puts the cache/session key in the body; the Messages
  // route uses a header. Without reading the body every OpenAI row loses its
  // session, and cost can only ever be reported per account.
  const directory = mkdtempSync(path.join(tmpdir(), 'mareo-openai-session-'))
  const db: GatewayDatabase = openDatabase(path.join(directory, 'gateway.db'))
  const accountId = createTokenAccount(db, '会话归因测试')
  const token = 'session-attribution-token'
  storeToken(db, { userId: accountId, label: 'test', tokenHash: hashToken(token) })
  writeSetting(db, 'quota.mode', 'off')

  const upstream: Server = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      id: 'resp_1',
      model: 'gpt-6-sol',
      usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 900 }, output_tokens: 10 },
    }))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port

  const gateway = createGatewayServer({
    db,
    upstreamBaseUrl: 'http://127.0.0.1:1',
    apiKey: 'unused',
    openaiUpstream: {
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: 'sk-test',
      stripPrefix: '/openai',
    },
    dailyLimit: 0,
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  const port = (gateway.address() as AddressInfo).port

  try {
    // A body far larger than any header-based path would carry, with the key
    // where the adapter puts it: the scan must not depend on a full parse.
    const padding = 'x'.repeat(512 * 1024)
    const response = await fetch(`http://127.0.0.1:${port}/openai/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-6-sol',
        input: [{ role: 'user', content: padding }],
        prompt_cache_key: 'session-afc9bae8',
      }),
    })
    assert.equal(response.status, 200)
    const row = db.prepare('SELECT sessionId FROM usage WHERE model = ? ORDER BY id DESC LIMIT 1').get('gpt-6-sol') as
      | { sessionId: string | null }
      | undefined
    assert.equal(row?.sessionId, 'session-afc9bae8')
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the free allowance does not cover OpenAI models, only the cheap upstream', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mareo-openai-free-'))
  const db: GatewayDatabase = openDatabase(path.join(directory, 'gateway.db'))
  const accountId = createTokenAccount(db, '免费额度不覆盖 Sol')
  const token = 'free-allowance-exclusion-token'
  storeToken(db, { userId: accountId, label: 'test', tokenHash: hashToken(token) })
  writeSetting(db, 'quota.mode', 'enforce')

  const upstream: Server = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      model: 'gpt-6-sol',
      usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10 },
    }))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port

  const gateway = createGatewayServer({
    db,
    upstreamBaseUrl: 'http://127.0.0.1:1',
    apiKey: 'unused',
    openaiUpstream: { upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'sk-test', stripPrefix: '/openai' },
    dailyLimit: 0,
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  const port = (gateway.address() as AddressInfo).port

  try {
    const response = await fetch(`http://127.0.0.1:${port}/openai/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-6-sol', input: 'hi' }),
    })
    assert.equal(response.status, 200)
    const row = db.prepare('SELECT paidFromFreeMicro, billableMicro FROM usage WHERE model = ? ORDER BY id DESC LIMIT 1').get('gpt-6-sol') as
      | { paidFromFreeMicro: number | null; billableMicro: number | null }
      | undefined
    assert.equal(row?.paidFromFreeMicro, 0, 'Sol 不消耗免费额度')
    assert.ok((row?.billableMicro ?? 0) > 0, '仍然要结算，只是全部从余额走')
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Terra 是 Sol 的一半价，长上下文阶梯也落在厂商的价目上', () => {
  // Vendor list: cache $0.05 / input $1 / output $5. Above 272K input the WHOLE
  // request bills at 2x input and 1.5x output — the rule already in place, so
  // Terra needs no special case.
  const fx = fxRate()
  const now = new Date()
  const near = (actual: number | undefined, expected: number, what: string) => {
    assert.ok(actual !== undefined, `${what}: 应当有价格`)
    assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: 期望 ${expected}，实际 ${actual}`)
  }

  // 100K input stays under the cliff: $0.1 input + $5 output.
  const flat: TokenUsage = {
    inputTokens: 100_000, cacheHitTokens: 0, cacheMissTokens: 100_000,
    outputTokens: 1_000_000, reasoningTokens: 0,
  }
  near(costOf(flat, 'gpt-6.1-terra', now), (0.1 * 1 + 1 * 5) * fx, '标准价')
  // Sol costs exactly twice that at the same input: $2/$10 against $1/$5.
  near(costOf(flat, 'gpt-6-sol', now), (0.1 * 2 + 1 * 10) * fx, 'Sol 标准价')

  // 300K input crosses the cliff: 0.3M at $2 (doubled) + 1K at $7.5 (1.5x).
  const long: TokenUsage = {
    inputTokens: 300_000, cacheHitTokens: 0, cacheMissTokens: 300_000,
    outputTokens: 1_000, reasoningTokens: 0,
  }
  near(costOf(long, 'gpt-6.1-terra', now), (0.3 * 2 + 0.001 * 7.5) * fx, '长上下文阶梯')

  const cached: TokenUsage = {
    inputTokens: 100_000, cacheHitTokens: 100_000, cacheMissTokens: 0,
    outputTokens: 0, reasoningTokens: 0,
  }
  near(costOf(cached, 'gpt-6.1-terra', now), 0.1 * 0.05 * fx, '缓存读用缓存价')
})

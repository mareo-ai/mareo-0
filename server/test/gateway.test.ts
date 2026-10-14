import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { hashToken } from '../src/auth.js'
import { createTokenAccount, findTokenOwner, openDatabase, storeToken, type GatewayDatabase } from '../src/db.js'
import { createGatewayServer } from '../src/server.js'
import { startOfDay } from '../src/clock.js'
import { countRequestsSince } from '../src/usage.js'

const UPSTREAM_KEY = 'sk-gateway-own-key'

/** Stands in for api.deepseek.com so tests never need a real key. */
function createStubUpstream(): Promise<{
  server: Server
  url: string
  lastAuthorization: () => string | undefined
  lastHeaders: () => IncomingHttpHeaders
}> {
  let lastAuthorization: string | undefined
  let lastHeaders: IncomingHttpHeaders = {}
  const server = createHttpServer((request, response) => {
    lastAuthorization = request.headers.authorization
    lastHeaders = request.headers
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      // Only JSON bodies carry a model; a multipart upload must not throw here,
      // or the stub never answers and the test hangs until the runner gives up.
      const parsed = body.startsWith('{') ? (JSON.parse(body) as { model?: string }) : undefined
      const model = parsed?.model
      if (request.url?.startsWith('/stream')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"delta":"first"}\n\n')
        setTimeout(() => {
          response.write('data: {"delta":"second"}\n\n')
          response.end()
        }, 20)
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, echoModel: model ?? null }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('stub upstream did not bind a port')
      resolve({ server, url: `http://127.0.0.1:${address.port}`, lastAuthorization: () => lastAuthorization, lastHeaders: () => lastHeaders })
    })
  })
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('gateway did not bind a port')
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

async function issueToken(db: GatewayDatabase, displayName: string, secret: string): Promise<string> {
  const userId = createTokenAccount(db, displayName)
  storeToken(db, { userId, label: `${displayName} token`, tokenHash: hashToken(secret) })
  return userId
}

let directory: string
let stub: Awaited<ReturnType<typeof createStubUpstream>>
let gateway: Server
let db: GatewayDatabase
let gatewayUrl: string
let token: string

before(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'mareo-gateway-e2e-'))
  db = openDatabase(path.join(directory, 'gateway.db'))
  stub = await createStubUpstream()
  gateway = createGatewayServer({
    db,
    upstreamBaseUrl: stub.url,
    apiKey: UPSTREAM_KEY,
    dailyLimit: 100,
  })
  gatewayUrl = await listen(gateway)
  token = 'e2e-token-secret'
  await issueToken(db, 'E2E User', token)
})

after(async () => {
  await close(gateway)
  await close(stub.server)
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

test('rejects unauthenticated model requests', async () => {
  const response = await fetch(`${gatewayUrl}/v1/chat/completions`, { method: 'POST' })
  assert.equal(response.status, 401)
})

test('/me returns the token owner with its account id', async () => {
  const response = await fetch(`${gatewayUrl}/me`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(response.status, 200)
  const body = (await response.json()) as { displayName: string; accountId: string }
  assert.equal(body.displayName, 'E2E User')
  assert.equal(typeof body.accountId, 'string')
})

test('forwards the protocol headers an upstream feature depends on', async () => {
  // The file API answers 400 without `anthropic-beta`, and the client retries
  // that 400 in a loop: a gateway that drops the header breaks the feature.
  // Its own account, so the request counts other tests assert on stay untouched.
  const filesToken = 'gateway-files-token'
  storeToken(db, { userId: createTokenAccount(db, '附件转发测试'), label: 'files', tokenHash: hashToken(filesToken) })
  const response = await fetch(`${gatewayUrl}/anthropic/v1/files`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${filesToken}`,
      'content-type': 'multipart/form-data; boundary=x',
      'anthropic-beta': 'files-api-2025-04-14',
      'anthropic-version': '2023-06-01',
    },
    body: 'body',
  })
  assert.equal(response.status, 200)
  const headers = stub.lastHeaders()
  assert.equal(headers['anthropic-beta'], 'files-api-2025-04-14')
  assert.equal(headers['anthropic-version'], '2023-06-01')
  assert.equal(headers['content-type'], 'multipart/form-data; boundary=x')
})

test('proxies a chat completion and records usage with the owner and model', async () => {
  const body = { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }
  const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, echoModel: 'deepseek-chat' })
  assert.equal(stub.lastAuthorization(), `Bearer ${UPSTREAM_KEY}`)

  const userId = findTokenOwner(db, hashToken(token))?.userId
  assert.ok(userId !== undefined)
  assert.equal(countRequestsSince(db, userId, startOfDay()), 1)
})

/** The request kind recorded for an account's most recent model request. */
function lastRequestKind(userId: string): string | null {
  const row = db.prepare('SELECT requestKind FROM usage WHERE userId = ? ORDER BY id DESC LIMIT 1').get(userId) as
    | { requestKind: string | null }
    | undefined
  return row?.requestKind ?? null
}

test('separates web search from chat in the accounting', async () => {
  const userId = findTokenOwner(db, hashToken(token))?.userId
  assert.ok(userId !== undefined)

  await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(lastRequestKind(userId), 'chat')

  // Exactly what the bundled search provider sends: the Anthropic-compatible
  // Messages path, carrying the search tool declaration.
  const search = await fetch(`${gatewayUrl}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Perform a web search for the query: 上海天气' }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    }),
  })
  assert.equal(search.status, 200)
  assert.equal(lastRequestKind(userId), 'search')
})

test('a chat turn on the Messages path stays a chat, not a search', async () => {
  const userId = findTokenOwner(db, hashToken(token))?.userId
  assert.ok(userId !== undefined)

  // The harness now sends chat and session titles to the same Messages endpoint
  // the search provider uses, so the path must not decide the kind.
  const response = await fetch(`${gatewayUrl}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
      tools: [{ name: 'bash', description: 'Run a command', input_schema: { type: 'object' } }],
    }),
  })
  assert.equal(response.status, 200)
  assert.equal(lastRequestKind(userId), 'chat')
})

test('accepts the account token as x-api-key, the way the Messages providers send it', async () => {
  const userId = findTokenOwner(db, hashToken(token))?.userId
  assert.ok(userId !== undefined)

  const me = await fetch(`${gatewayUrl}/me`, { headers: { 'x-api-key': token } })
  assert.equal(me.status, 200)

  const response = await fetch(`${gatewayUrl}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': token, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 64, messages: [{ role: 'user', content: '你好' }] }),
  })
  assert.equal(response.status, 200)
  assert.equal(lastRequestKind(userId), 'chat')

  // An unknown key is still refused, whichever header carries it.
  const wrong = await fetch(`${gatewayUrl}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': 'not-a-real-token', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: '你好' }] }),
  })
  assert.equal(wrong.status, 401)
})

test('streams event-stream responses through', async () => {
  const response = await fetch(`${gatewayUrl}/stream`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    body: JSON.stringify({ stream: true }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const text = await response.text()
  assert.ok(text.includes('first'))
  assert.ok(text.includes('second'))
})

test('warns once at the attention threshold without blocking', async () => {
  const warnDb = openDatabase(path.join(directory, 'warn.db'))
  const warnToken = 'warn-user-secret'
  await issueToken(warnDb, 'Warn User', warnToken)
  // dailyLimit 0 = no cap, so the warning must be the only thing that happens.
  const warned = createGatewayServer({
    db: warnDb,
    upstreamBaseUrl: stub.url,
    apiKey: UPSTREAM_KEY,
    dailyLimit: 0,
    dailyWarnLimit: 1,
  })
  const warnUrl = await listen(warned)
  const lines: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    lines.push(args.join(' '))
  }
  const callChat = (): Promise<Response> =>
    fetch(`${warnUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${warnToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat' }),
    })
  try {
    assert.equal((await callChat()).status, 200)
    assert.equal((await callChat()).status, 200)
    assert.equal((await callChat()).status, 200)
  } finally {
    console.warn = originalWarn
    await close(warned)
    warnDb.close()
  }
  const usageWarnings = lines.filter((line) => line.includes('[usage]'))
  assert.equal(usageWarnings.length, 1, 'exactly one warning per account per day')
  assert.match(usageWarnings[0], /reached 1 requests today/)
})

test('enforces the per-user daily limit', async () => {
  // Use a dedicated database so usage from the other tests does not leak in.
  const limitedDb = openDatabase(path.join(directory, 'limited.db'))
  const limitedToken = 'limited-user-secret'
  await issueToken(limitedDb, 'Limited User', limitedToken)
  const limited = createGatewayServer({ db: limitedDb, upstreamBaseUrl: stub.url, apiKey: UPSTREAM_KEY, dailyLimit: 1 })
  const limitedUrl = await listen(limited)
  const callChat = (): Promise<Response> =>
    fetch(`${limitedUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${limitedToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat' }),
    })
  try {
    assert.equal((await callChat()).status, 200)
    const rejected = await callChat()
    assert.equal(rejected.status, 429)
    // The client shows this to the user, so it must be a sentence, not a code.
    const body = (await rejected.json()) as { error: string; message?: string }
    assert.equal(body.error, 'daily-limit-reached')
    assert.match(body.message ?? '', /明天|0 点|额度/)
  } finally {
    await close(limited)
    limitedDb.close()
  }
})

test('renames the account and signs out (revokes) the current token', async () => {
  const secret = 'account-ops-secret'
  await issueToken(db, 'Ops User', secret)
  const auth = { authorization: `Bearer ${secret}` }

  const rename = await fetch(`${gatewayUrl}/account/name`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: '新名字' }),
  })
  assert.equal(rename.status, 200)
  const me = await fetch(`${gatewayUrl}/me`, { headers: auth })
  assert.equal(((await me.json()) as { displayName: string }).displayName, '新名字')

  const signOut = await fetch(`${gatewayUrl}/account/sign-out`, { method: 'POST', headers: auth })
  assert.equal(signOut.status, 200)
  const after = await fetch(`${gatewayUrl}/me`, { headers: auth })
  assert.equal(after.status, 401)
})

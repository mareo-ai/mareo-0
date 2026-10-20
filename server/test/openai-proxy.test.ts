// The egress path: when the vendor is not reachable from this network, the
// gateway must go through a proxy rather than fail. Node's fetch ignores the
// usual proxy environment variables, so this pins that the configured proxy is
// actually used — and that leaving it unset keeps the direct path direct.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { connect as netConnect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { hashToken } from '../src/auth.js'
import { createTokenAccount, openDatabase, storeToken, type GatewayDatabase } from '../src/db.js'
import { createGatewayServer } from '../src/server.js'
import { writeSetting } from '../src/settings.js'

/** What the vendor answers with; only `usage` matters to the gateway. */
const VENDOR_BODY = JSON.stringify({
  id: 'resp_1',
  model: 'gpt-6-sol',
  usage: {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 600 },
    output_tokens: 20,
    output_tokens_details: { reasoning_tokens: 5 },
  },
})

interface Harness {
  gatewayPort: number
  proxyConnections: () => number
  vendorRequests: () => number
  close: () => Promise<void>
}

/**
 * One gateway in front of a fake vendor, optionally through a proxy that speaks
 * CONNECT — the same shape Squid exposes, and the only one undici's ProxyAgent
 * uses for either scheme.
 */
async function startHarness(options: { withProxy: boolean }): Promise<Harness> {
  const directory = mkdtempSync(path.join(tmpdir(), 'mareo-proxy-'))
  const db: GatewayDatabase = openDatabase(path.join(directory, 'gateway.db'))
  const accountId = createTokenAccount(db, '代理测试')
  const token = 'proxy-token-123456'
  storeToken(db, { userId: accountId, label: 'test', tokenHash: hashToken(token) })
  writeSetting(db, 'quota.mode', 'off')

  let vendorRequests = 0
  const vendor: Server = createHttpServer((_request, response) => {
    vendorRequests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(VENDOR_BODY)
  })
  await new Promise<void>((resolve) => vendor.listen(0, '127.0.0.1', resolve))
  const vendorPort = (vendor.address() as AddressInfo).port

  let proxyConnections = 0
  let proxy: Server | undefined
  let proxyUrl: string | undefined
  if (options.withProxy) {
    proxy = createHttpServer((_request, response) => {
      response.writeHead(501)
      response.end()
    })
    proxy.on('connect', (request, clientSocket, head) => {
      proxyConnections += 1
      const [host, port] = (request.url ?? '').split(':')
      // A tunnel is a raw socket pair; anything HTTP-aware here would deadlock.
      const upstreamSocket = netConnect(Number(port), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstreamSocket.write(head)
        upstreamSocket.pipe(clientSocket)
        clientSocket.pipe(upstreamSocket)
      })
      upstreamSocket.on('error', () => clientSocket.destroy())
      clientSocket.on('error', () => upstreamSocket.destroy())
    })
    await new Promise<void>((resolve) => proxy!.listen(0, '127.0.0.1', resolve))
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
  }

  const gateway = createGatewayServer({
    db,
    upstreamBaseUrl: 'http://127.0.0.1:1',
    apiKey: 'unused',
    openaiUpstream: {
      upstreamBaseUrl: `http://127.0.0.1:${vendorPort}/v1`,
      apiKey: 'sk-test',
      stripPrefix: '/openai',
      ...(proxyUrl === undefined ? {} : { proxyUrl }),
    },
    dailyLimit: 0,
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))

  return {
    gatewayPort: (gateway.address() as AddressInfo).port,
    proxyConnections: () => proxyConnections,
    vendorRequests: () => vendorRequests,
    close: async () => {
      await new Promise<void>((resolve) => gateway.close(() => resolve()))
      if (proxy !== undefined) await new Promise<void>((resolve) => proxy!.close(() => resolve()))
      await new Promise<void>((resolve) => vendor.close(() => resolve()))
      db.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

const call = (port: number, token = 'proxy-token-123456'): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/openai/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-6-sol', input: 'hi' }),
  })

test('a configured proxy is used for the vendor call, not bypassed', async () => {
  const harness = await startHarness({ withProxy: true })
  try {
    const response = await call(harness.gatewayPort)
    assert.equal(response.status, 200)
    assert.equal(harness.proxyConnections(), 1, '请求应当从代理出去')
    assert.equal(harness.vendorRequests(), 1)
  } finally {
    await harness.close()
  }
})

test('without a proxy the call goes direct and no proxy is touched', async () => {
  const harness = await startHarness({ withProxy: false })
  try {
    const response = await call(harness.gatewayPort)
    assert.equal(response.status, 200)
    assert.equal(harness.proxyConnections(), 0)
    assert.equal(harness.vendorRequests(), 1)
  } finally {
    await harness.close()
  }
})

test('a dead proxy fails loudly instead of silently going direct', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mareo-dead-proxy-'))
  const db: GatewayDatabase = openDatabase(path.join(directory, 'gateway.db'))
  const accountId = createTokenAccount(db, '坏代理测试')
  storeToken(db, { userId: accountId, label: 'test', tokenHash: hashToken('proxy-token-123456') })
  writeSetting(db, 'quota.mode', 'off')
  const harness = { close: async (): Promise<void> => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  } }
  try {
    // Port 1 refuses connections; a silent fallback would answer 200 here.
    const broken = createGatewayServer({
      db,
      upstreamBaseUrl: 'http://127.0.0.1:1',
      apiKey: 'unused',
      openaiUpstream: {
        upstreamBaseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'sk-test',
        stripPrefix: '/openai',
        proxyUrl: 'http://127.0.0.1:1',
      },
      dailyLimit: 0,
    })
    await new Promise<void>((resolve) => broken.listen(0, '127.0.0.1', resolve))
    const port = (broken.address() as AddressInfo).port
    try {
      const response = await call(port)
      assert.equal(response.status, 502)
      const body = (await response.json()) as { error: string }
      assert.equal(body.error, 'upstream unreachable: fetch failed')
    } finally {
      await new Promise<void>((resolve) => broken.close(() => resolve()))
    }
  } finally {
    await harness.close()
  }
})

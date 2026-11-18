import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openDatabase } from '../src/db.js'
import { createGatewayServer } from '../src/server.js'

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('did not bind')
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

/** Signs up through the real endpoints: send a code, then verify it. */
async function signUp(base: string, email: string, address: string): Promise<Response> {
  const sent = await fetch(`${base}/auth/email/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': address },
    body: JSON.stringify({ email }),
  })
  if (sent.status !== 200) return sent
  // The code is stored hashed, so it is captured on its way to the mailer.
  return fetch(`${base}/auth/email/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': address },
    body: JSON.stringify({ email, code: codes.get(email) ?? '' }),
  })
}

const codes = new Map<string, string>()

test('a sixth account from one address is refused, and a second address is unaffected', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mareo-signup-limit-'))
  const db = openDatabase(path.join(directory, 'gateway.db'))
  const gateway = createGatewayServer({
    db,
    upstreamBaseUrl: 'http://127.0.0.1:1',
    apiKey: 'unused',
    dailyLimit: 0,
    mailer: { sendCode: async (to: string, code: string) => { codes.set(to, code) } },
  })
  const base = await listen(gateway)
  const address = '203.0.113.7'

  try {
    for (let i = 0; i < 5; i += 1) {
      const res = await signUp(base, `limit-${i}@example.test`, address)
      assert.equal(res.status, 200, `第 ${i + 1} 个应当放行`)
    }
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM signup_ips').get() as { n: number }).n, 5)

    const sixth = await signUp(base, 'limit-5@example.test', address)
    assert.equal(sixth.status, 429)
    assert.equal(((await sixth.json()) as { error?: string }).error, 'too-many-signups')

    // A different address can still create an account.
    const other = await signUp(base, 'limit-6@example.test', '198.51.100.9')
    assert.equal(other.status, 200, '另一个地址不受影响')
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { hashToken } from '../src/auth.js'
import { createTokenAccount, openDatabase, storeToken } from '../src/db.js'
import { readSponsoredAd, recordAdEvent } from '../src/sponsored-ad.js'
import { createGatewayServer } from '../src/server.js'

const creative = { enabled: true, id: 'test-ad', image: 'https://images.example.test/ad.png',
  title: 'Test', description: 'Description', targetUrl: 'https://example.test/?affiliate=test', advertiser: 'Example' }

test('manual configuration: disabled, missing, malformed, URL safety and live edits', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mareo-ad-config-'))
  const file = path.join(directory, 'ad.json')
  try {
    assert.equal(await readSponsoredAd(file), null)
    for (const content of ['{', 'null', JSON.stringify({ ...creative, enabled: false }),
      JSON.stringify({ ...creative, targetUrl: 'javascript:alert(1)' }),
      JSON.stringify({ ...creative, image: 'https://user:secret@example.test/a.png' }),
      JSON.stringify({ ...creative, title: 'x'.repeat(121) })]) {
      writeFileSync(file, content)
      assert.equal(await readSponsoredAd(file), null)
    }
    writeFileSync(file, JSON.stringify(creative))
    assert.equal((await readSponsoredAd(file))?.id, 'test-ad')
    writeFileSync(file, JSON.stringify({ ...creative, id: 'new-ad' }))
    assert.equal((await readSponsoredAd(file))?.id, 'new-ad')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('authenticated ad delivery and events stay separate from model usage and diagnostics', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mareo-ad-http-'))
  const file = path.join(directory, 'ad.json')
  const db = openDatabase(path.join(directory, 'gateway.db'))
  const userId = createTokenAccount(db, 'Ad test')
  const token = 'ad-test-token'
  storeToken(db, { userId, label: 'test', tokenHash: hashToken(token) })
  writeFileSync(file, JSON.stringify(creative))
  const server = createGatewayServer({ db, upstreamBaseUrl: 'http://127.0.0.1:1', apiKey: 'unused',
    dailyLimit: 1, sponsoredAdFile: file })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const event = { eventId: randomUUID(), adId: creative.id, placement: 'sidebar-footer', type: 'impression' }
  try {
    assert.equal((await fetch(`${url}/sponsored-ad`)).status, 401)
    assert.equal((await fetch(`${url}/sponsored-ad/events`, { method: 'POST', body: '{}' })).status, 401)
    const response = await fetch(`${url}/sponsored-ad`, { headers })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal((await response.json() as { ad: { id: string } }).ad.id, creative.id)
    for (let i = 0; i < 2; i++) {
      assert.equal((await fetch(`${url}/sponsored-ad/events`, { method: 'POST', headers,
        body: JSON.stringify({ ...event, userId: 'forged-user', createdAt: 'yesterday', conversation: 'ignored' }) })).status, 200)
    }
    const rows = db.prepare('SELECT * FROM ad_events').all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].userId, userId)
    assert.equal(rows[0].type, 'impression')
    assert.match(rows[0].createdAt as string, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal('conversation' in rows[0], false)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 0)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number }).n, 0)
    assert.equal((await fetch(`${url}/sponsored-ad/events`, { method: 'POST', headers,
      body: JSON.stringify({ ...event, type: 'click' }) })).status, 409)
    assert.equal((await fetch(`${url}/sponsored-ad/events`, { method: 'POST', headers,
      body: JSON.stringify({ ...event, eventId: randomUUID(), type: 'click' }) })).status, 200)
    assert.equal((await fetch(`${url}/sponsored-ad/unknown`, { headers })).status, 404)
    writeFileSync(file, JSON.stringify({ enabled: false }))
    assert.deepEqual(await (await fetch(`${url}/sponsored-ad`, { headers })).json(), { ad: null })
    assert.equal((await fetch(`${url}/sponsored-ad/events`, { method: 'POST', headers,
      body: JSON.stringify({ ...event, eventId: randomUUID() }) })).status, 400)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('event validation, cross-account dedup, rate limit and retention', () => {
  const db = openDatabase(':memory:')
  const userId = createTokenAccount(db, 'one')
  const second = createTokenAccount(db, 'two')
  const event = { eventId: randomUUID(), adId: creative.id, placement: 'sidebar-footer', type: 'click' }
  try {
    for (const invalid of [null, { ...event, type: 'sale' }, { ...event, placement: 'chat' },
      { ...event, eventId: 'invalid' }, { ...event, adId: 'unknown' }]) {
      assert.equal(recordAdEvent(db, userId, invalid, creative), 400)
    }
    db.prepare('INSERT INTO ad_events VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), creative.id, 'sidebar-footer', userId, 'click', '2020-01-01T00:00:00.000Z')
    assert.equal(recordAdEvent(db, userId, event, creative), 200)
    assert.equal(recordAdEvent(db, second, event, creative), 409)
    for (let i = 1; i < 30; i++) assert.equal(recordAdEvent(db, userId, { ...event, eventId: randomUUID() }, creative), 200)
    assert.equal(recordAdEvent(db, userId, { ...event, eventId: randomUUID() }, creative), 429)
    assert.equal(recordAdEvent(db, userId, event, creative), 200)
    assert.equal(recordAdEvent(db, second, { ...event, eventId: randomUUID() }, creative), 200)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ad_events').get() as { n: number }).n, 31)
  } finally { db.close() }
})

test('schema v6 upgrade adds ad table without changing users or existing events', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mareo-ad-migrate-'))
  const file = path.join(directory, 'gateway.db')
  let db = openDatabase(file)
  const userId = createTokenAccount(db, 'preserved')
  db.exec("DROP TABLE ad_events; PRAGMA user_version = 6; INSERT INTO events(name, ts) VALUES ('launch', 'test')")
  db.close()
  db = openDatabase(file)
  try {
    assert.equal(db.prepare('SELECT id FROM users').get()?.id, userId)
    assert.equal(db.prepare('SELECT name FROM events').get()?.name, 'launch')
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 10)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ad_events').get()?.n, 0)
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
})

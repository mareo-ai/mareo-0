import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  harnessStampPath,
  isHarnessDowngrade,
  loadHarnessStamp,
  rememberHarness,
} from '../src/harness-stamp.js'

let root: string

test.before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mareo-harness-stamp-'))
})

test.after(async () => {
  await rm(root, { recursive: true, force: true })
})

async function freshHome(): Promise<string> {
  return mkdtemp(path.join(root, 'home-'))
}

test('reads nothing from a home that never ran a build', async () => {
  const home = await freshHome()
  assert.equal(await loadHarnessStamp(home), undefined)
})

test('a malformed stamp reads as a first run instead of failing', async () => {
  const home = await freshHome()
  await writeFile(harnessStampPath(home), '{ not json')
  assert.equal(await loadHarnessStamp(home), undefined)
})

test('records the first runtime and reports it back', async () => {
  const home = await freshHome()
  const stamp = { appVersion: '0.2.1', dshVersion: '0.2.0-rc.2' }
  assert.deepEqual(await rememberHarness(home, stamp), stamp)
  assert.deepEqual(await loadHarnessStamp(home), stamp)
})

test('a newer runtime replaces the record', async () => {
  const home = await freshHome()
  await rememberHarness(home, { appVersion: '0.2.1', dshVersion: '0.2.0-rc.2' })
  const newest = await rememberHarness(home, { appVersion: '0.2.2', dshVersion: '0.2.1-rc.2' })
  assert.deepEqual(newest, { appVersion: '0.2.2', dshVersion: '0.2.1-rc.2' })
  assert.deepEqual(await loadHarnessStamp(home), newest)
})

test('an older runtime keeps the record so the warning survives a restart', async () => {
  const home = await freshHome()
  const recorded = { appVersion: '0.2.2', dshVersion: '0.2.1-rc.2' }
  await rememberHarness(home, recorded)
  const newest = await rememberHarness(home, { appVersion: '0.2.1', dshVersion: '0.2.0-rc.2' })
  assert.deepEqual(newest, recorded)
  assert.deepEqual(await loadHarnessStamp(home), recorded)
})

test('the record is kept by version, not by write order', async () => {
  const home = await freshHome()
  await rememberHarness(home, { appVersion: '0.2.2', dshVersion: '0.2.1-rc.2' })
  // An app that went backwards while the DSH pin moved forwards keeps both halves.
  const newest = await rememberHarness(home, { appVersion: '0.2.1', dshVersion: '0.2.2-rc.1' })
  assert.deepEqual(newest, { appVersion: '0.2.2', dshVersion: '0.2.2-rc.1' })
  const stored = JSON.parse(await readFile(harnessStampPath(home), 'utf8')) as unknown
  assert.deepEqual(stored, newest)
})

test('detects a DSH downgrade and orders prereleases by number', async () => {
  const current = { appVersion: '0.2.1', dshVersion: '0.2.0-rc.2' }
  assert.equal(isHarnessDowngrade({ appVersion: '0.2.2', dshVersion: '0.2.1-rc.2' }, current), true)
  assert.equal(isHarnessDowngrade({ appVersion: '0.2.1', dshVersion: '0.2.1-rc.2' }, current), true)
  assert.equal(isHarnessDowngrade({ appVersion: '0.2.0', dshVersion: '0.2.0-rc.2' }, current), false)
  assert.equal(isHarnessDowngrade({ appVersion: '0.2.9', dshVersion: '0.1.5-rc.2' }, current), false)
})

test('an older app on the same DSH is not a downgrade: sessions stay readable', () => {
  const current = { appVersion: '0.2.1', dshVersion: '0.2.1-rc.2' }
  assert.equal(isHarnessDowngrade({ appVersion: '0.2.2', dshVersion: '0.2.1-rc.2' }, current), false)
})

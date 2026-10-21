import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

interface ReleaseScriptModule {
  recommendVersion: (current: string) => string
  isValidVersion: (version: string) => boolean
  isNewerVersion: (candidate: string, current: string) => boolean
  suggestNote: (subjects: string[]) => string
  tagArguments: (version: string, options: { notes: string; minimumVersion: string }) => string[]
  parseArguments: (argv: string[]) => Record<string, unknown>
  dshPinRefusal: (previousPin: string | undefined, nextPin: string | undefined) => string | undefined
}

async function releaseScript(): Promise<ReleaseScriptModule> {
  const script = pathToFileURL(path.resolve('scripts/release.mjs')).href
  return (await import(script)) as ReleaseScriptModule
}

test('suggests the next patch version', async () => {
  const { recommendVersion } = await releaseScript()
  assert.equal(recommendVersion('0.1.2'), '0.1.3')
  assert.equal(recommendVersion('1.9.9'), '1.9.10')
})

test('suggests a note that means something to a user', async () => {
  const { suggestNote } = await releaseScript()
  // A version bump says nothing; the change it ships does.
  assert.equal(
    suggestNote(['Release 0.1.3', 'Fix the account isolation leak']),
    'Fix the account isolation leak',
  )
  assert.equal(suggestNote(['Add telemetry', 'Release 0.1.2']), 'Add telemetry')
  assert.equal(suggestNote(['Release 0.1.3']), 'Release 0.1.3')
  assert.equal(suggestNote([]), '')
})

test('accepts only plain x.y.z versions and orders them numerically', async () => {
  const { isValidVersion, isNewerVersion } = await releaseScript()
  assert.equal(isValidVersion('0.1.3'), true)
  assert.equal(isValidVersion('0.1'), false)
  assert.equal(isValidVersion('v0.1.3'), false)

  assert.equal(isNewerVersion('0.1.10', '0.1.9'), true)
  assert.equal(isNewerVersion('0.2.0', '0.1.9'), true)
  assert.equal(isNewerVersion('0.1.3', '0.1.3'), false)
})

test('the tag carries the note and only adds a minimum when one is set', async () => {
  const { tagArguments } = await releaseScript()
  assert.deepEqual(tagArguments('0.1.3', { notes: '修复账户隔离问题', minimumVersion: '' }), [
    'tag',
    '-a',
    'v0.1.3',
    '-m',
    '修复账户隔离问题',
  ])
  assert.deepEqual(tagArguments('0.1.3', { notes: '修复账户隔离问题', minimumVersion: '0.1.2' }), [
    'tag',
    '-a',
    'v0.1.3',
    '-m',
    '修复账户隔离问题',
    '-m',
    'minimum-version: 0.1.2',
  ])
})

test('reads flags, defaulting to an interactive run', async () => {
  const { parseArguments } = await releaseScript()
  assert.deepEqual(parseArguments([]), {
    version: undefined,
    notes: undefined,
    minimumVersion: undefined,
    dryRun: false,
    yes: false,
    allowDshDowngrade: false,
  })
  assert.deepEqual(parseArguments(['--version', '0.1.3', '--notes', 'n', '--minimum-version', '', '--dry-run']), {
    version: '0.1.3',
    notes: 'n',
    minimumVersion: '',
    dryRun: true,
    yes: false,
    allowDshDowngrade: false,
  })
  assert.equal(parseArguments(['--allow-dsh-downgrade']).allowDshDowngrade, true)
})

test('orders pinned prerelease versions, so a DSH regression is visible', async () => {
  const { isNewerVersion } = await releaseScript()
  assert.equal(isNewerVersion('0.2.1-rc.2', '0.2.0-rc.2'), true)
  assert.equal(isNewerVersion('0.2.0-rc.2', '0.2.1-rc.2'), false)
  assert.equal(isNewerVersion('0.2.1', '0.2.1-rc.2'), true)
  assert.equal(isNewerVersion('0.2.1-rc.2', '0.2.1'), false)
  assert.equal(isNewerVersion('0.2.1-rc.2', '0.2.1-rc.2'), false)
})

test('refuses a release that would bundle an older DSH than the last one', async () => {
  const { dshPinRefusal } = await releaseScript()
  // Forward or unchanged pins are the normal case.
  assert.equal(dshPinRefusal('0.2.0-rc.2', '0.2.1-rc.2'), undefined)
  assert.equal(dshPinRefusal('0.2.1-rc.2', '0.2.1-rc.2'), undefined)
  assert.equal(dshPinRefusal(undefined, '0.2.1-rc.2'), undefined)
  assert.equal(dshPinRefusal('0.2.1-rc.2', undefined), undefined)

  const refusal = dshPinRefusal('0.2.1-rc.2', '0.2.0-rc.2')
  assert.ok(refusal !== undefined)
  assert.match(refusal, /0\.2\.1-rc\.2 回退到 0\.2\.0-rc\.2/)
})

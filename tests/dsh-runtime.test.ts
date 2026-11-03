import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { extractDshUrl, reportableErrorOutput, rotateEngineLog, startDshRuntime, stripPastedModelKeys, type DshRuntime } from '../src/dsh-runtime.js'

test('extracts the authenticated loopback URL reported by DSH', () => {
  assert.equal(
    extractDshUrl('dsh web: http://127.0.0.1:49152/?token=local-secret\n'),
    'http://127.0.0.1:49152/?token=local-secret',
  )
})

test('does not accept non-loopback addresses', () => {
  assert.equal(extractDshUrl('http://0.0.0.0:3080/?token=secret'), undefined)
  assert.equal(extractDshUrl('https://127.0.0.1:3080/?token=secret'), undefined)
})

test('requires the authenticated DSH launch URL', () => {
  assert.equal(extractDshUrl('http://127.0.0.1:3080/'), undefined)
})

test('the crash tail keeps the technical part and drops paths and tokens', () => {
  const raw = [
    'info: starting',
    "Error: Cannot find module '/Users/zhefeng/Mareo/resources/dsh-runtime/index.js'",
    'at Module._resolveFilename (/Users/zhefeng/Mareo/app.asar/node_modules/x.js:12:5)',
    'Launch URL: http://127.0.0.1:4567/?token=super-secret-token',
  ].join('\n')

  const tail = reportableErrorOutput(raw)
  assert.equal(tail.includes('/Users/zhefeng'), false)
  assert.equal(tail.includes('super-secret-token'), false)
  assert.match(tail, /Cannot find module/)
  assert.match(tail, /\[REDACTED\]/)
})

test('the crash tail is bounded by lines and by size', () => {
  const many = Array.from({ length: 50 }, (_value, index) => `line ${index}`).join('\n')
  const capped = reportableErrorOutput(many)
  assert.equal(capped.split('\n').length, 20)
  // The newest lines are the ones that matter.
  assert.match(capped, /line 49$/)

  const huge = 'x'.repeat(9_000)
  assert.equal(reportableErrorOutput(huge).length, 4_000)
  // Blank lines never pad the report.
  assert.equal(reportableErrorOutput('\n\n  \n'), '')
})

/**
 * A throwaway runtime directory holding a fake DSH CLI, so the real spawn path
 * is exercised: startup, address discovery and the retry loop.
 */
function fakeRuntime(cliSource: string): {
  options: Omit<Parameters<typeof startDshRuntime>[0], 'onUnexpectedExit'>
  markerFile: string
  logFile: string
  cleanup(): void
} {
  const directory = mkdtempSync(path.join(tmpdir(), 'mareo-dsh-'))
  const packageDirectory = path.join(directory, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(packageDirectory, { recursive: true })
  writeFileSync(
    path.join(packageDirectory, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: 'cli.js' } }),
  )
  writeFileSync(path.join(packageDirectory, 'cli.js'), cliSource)
  const logFile = path.join(directory, 'logs', 'mareo.log')
  return {
    options: {
      runtimeDirectory: directory,
      nodeExecutable: process.execPath,
      dshHome: path.join(directory, 'dsh-home'),
      workingDirectory: directory,
      logFile,
    },
    markerFile: path.join(directory, 'attempts'),
    logFile,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  }
}

/** Announces its address on stderr — the case that used to time out. */
const ANNOUNCES_ON_STDERR = `
const http = require('http')
const server = http.createServer((_request, response) => response.end('ok'))
server.listen(0, '127.0.0.1', () => {
  process.stderr.write('dsh web: http://127.0.0.1:' + server.address().port + '/?token=stderr-secret\\n')
})
setInterval(() => {}, 1000)
`

/** Silent on the first start, ready on the second. */
const SLOW_FIRST_ATTEMPT = `
const fs = require('fs')
const http = require('http')
const marker = process.env.FAKE_ATTEMPT_FILE
const attempt = Number(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '0') + 1
fs.writeFileSync(marker, String(attempt))
if (attempt > 1) {
  const server = http.createServer((_request, response) => response.end('ok'))
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write('dsh web: http://127.0.0.1:' + server.address().port + '/?token=second-attempt\\n')
  })
}
setInterval(() => {}, 1000)
`

/** Counts how many times it ran, then dies: a crash must not be retried. */
const EXITS_IMMEDIATELY = `
const fs = require('fs')
const marker = process.env.FAKE_ATTEMPT_FILE
const attempt = Number(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '0') + 1
fs.writeFileSync(marker, String(attempt))
process.exit(1)
`

test('starts from an address the engine announces on stderr', async () => {
  const runtime = fakeRuntime(ANNOUNCES_ON_STDERR)
  let started: DshRuntime | undefined
  try {
    started = await startDshRuntime({ ...runtime.options, onUnexpectedExit: () => {} })
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=stderr-secret$/)
    assert.equal(started.origin, new URL(started.url).origin)
    const patch = JSON.parse(readFileSync(path.join(runtime.options.dshHome, 'mareo-brand.patch.json'), 'utf8')) as {
      id?: string
      disabled?: boolean
      insert?: { id?: string }[]
    }[]
    assert.ok(patch.some((entry) => entry.id === 'ui-settings-models' && entry.disabled === true))
    assert.ok(!patch.some((entry) => entry.id === 'ui-model-selection' && entry.disabled === true))
    // DSH 0.2 brought surfaces that would take money or support out of Mareo's
    // hands: a DeepSeek account that bypasses the gateway, a plugin manager, and
    // a web-search endpoint setting. Each one has to stay off.
    for (const id of [
      'ui-brand-official',
      'ui-settings-account',
      'llm-deepseek-account',
      'deepseek-account',
    ]) {
      assert.ok(patch.some((entry) => entry.id === id && entry.disabled === true), `${id} must be disabled`)
    }
    // The config editor is the settings store's foundation, not a user-facing
    // editor: disabling it leaves settings (and our Account section) pending.
    assert.ok(!patch.some((entry) => entry.id === 'config-editor'), 'config-editor must stay enabled')
    // The plugin manager and the web-search page are deliberately left to the
    // user: they cannot override this overlay, and the search page only ever
    // spends the user's own credentials. Re-disabling them would take away the
    // official bundles (voice input) people may want.
    for (const id of ['ui-plugin-manager', 'plugin-manager', 'ui-settings-web-search']) {
      assert.ok(!patch.some((entry) => entry.id === id), `${id} must stay available to users`)
    }
    // Anything we do not have an opinion about stays exactly as DSH ships it,
    // the agent's plugin tool included: no entry here means upstream decides.
    assert.ok(!patch.some((entry) => entry.id === 'tool-plugin-manager'), 'leave upstream defaults alone')
    assert.ok(patch.some((entry) => entry.insert?.some((plugin) => plugin.id === 'mareo-brand')), 'mareo-brand must be injected')
  } finally {
    await started?.stop()
    runtime.cleanup()
  }
})

test('starts the engine again when the first attempt misses its budget', async () => {
  const runtime = fakeRuntime(SLOW_FIRST_ATTEMPT)
  let started: DshRuntime | undefined
  try {
    started = await startDshRuntime({
      ...runtime.options,
      env: { FAKE_ATTEMPT_FILE: runtime.markerFile },
      startupTimeoutMs: 1_000,
      onUnexpectedExit: () => {},
    })
    assert.match(started.url, /token=second-attempt$/)
    // Two CLI runs, and the second start is recorded in the same log file.
    assert.equal(readFileSync(runtime.markerFile, 'utf8'), '2')
    assert.match(readFileSync(runtime.logFile, 'utf8'), /starting the engine again/)
  } finally {
    await started?.stop()
    runtime.cleanup()
  }
})

test('does not retry an engine that exits during startup', async () => {
  const runtime = fakeRuntime(EXITS_IMMEDIATELY)
  try {
    await assert.rejects(
      startDshRuntime({
        ...runtime.options,
        env: { FAKE_ATTEMPT_FILE: runtime.markerFile },
        onUnexpectedExit: () => {},
      }),
      /exited before startup completed/,
    )
    // A crash is not intermittent: exactly one attempt, no second start.
    assert.equal(readFileSync(runtime.markerFile, 'utf8'), '1')
  } finally {
    runtime.cleanup()
  }
})

test('an oversized engine log is rotated aside, not deleted', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mareo-log-'))
  const file = path.join(directory, 'mareo.log')
  writeFileSync(file, 'x'.repeat(64))
  try {
    await rotateEngineLog(file, 32)
    assert.equal(readFileSync(`${file}.1`, 'utf8').length, 64, '旧内容应保留到 .1')
    assert.equal(existsSync(file), false, '原文件应被移走，下一次写入从头追加')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a log under the cap is left in place', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mareo-log-'))
  const file = path.join(directory, 'mareo.log')
  writeFileSync(file, 'small')
  try {
    await rotateEngineLog(file, 1024)
    assert.equal(readFileSync(file, 'utf8'), 'small')
    assert.equal(existsSync(`${file}.1`), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a pasted model key is removed from DSH credentials, so it cannot replace the account token', async () => {
  // DSH prefers `.credentials.yaml` refs over the environment. A vendor key pasted
  // into a settings field months earlier therefore wins over the token Mareo
  // injects, and every model call fails with "invalid API key" — the gateway never
  // sees the request, so it has nothing to log.
  const home = mkdtempSync(path.join(tmpdir(), 'mareo-creds-'))
  try {
    const globalFile = path.join(home, '.credentials.yaml')
    writeFileSync(globalFile, [
      'version: 1',
      'records:',
      '  client-connection/browser-session:',
      '    kind: grant',
      'refs:',
      '  DEEPSEEK_API_KEY: sk-pasted-by-user',
      '  FEISHU_APP_SECRET: keep-me',
      '',
    ].join('\n'))
    const accountDir = path.join(home, 'accounts', 'acct-1')
    mkdirSync(accountDir, { recursive: true })
    writeFileSync(path.join(accountDir, '.credentials.yaml'), [
      'version: 1',
      'records:',
      'refs:',
      '  OPENAI_API_KEY: sk-other-vendor',
      '',
    ].join('\n'))

    await stripPastedModelKeys(home)

    const global = readFileSync(globalFile, 'utf8')
    assert.doesNotMatch(global, /DEEPSEEK_API_KEY/, '粘贴的 DeepSeek key 应被删除')
    assert.match(global, /FEISHU_APP_SECRET: keep-me/, '其他 ref 必须保留')
    assert.match(global, /client-connection/, 'records 不受影响')

    const account = readFileSync(path.join(accountDir, '.credentials.yaml'), 'utf8')
    assert.doesNotMatch(account, /OPENAI_API_KEY/)

    // A backup is kept, so a user who really did mean to store a key can recover it.
    const backups = readdirSync(home).filter((name) => name.startsWith('.credentials.yaml.bak-'))
    assert.equal(backups.length, 1, '应当留下备份')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

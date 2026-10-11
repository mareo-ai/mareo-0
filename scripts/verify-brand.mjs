import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startDshRuntime } from '../dist/src/dsh-runtime.js'

const resources = path.resolve(process.argv[2] ?? '.staging')
const home = await mkdtemp(path.join(tmpdir(), 'mareo-brand-smoke-'))
const runtime = await startDshRuntime({
  runtimeDirectory: path.join(resources, 'dsh-runtime'),
  nodeExecutable: path.join(resources, 'node-runtime/bin/node'),
  dshHome: home, workingDirectory: home, logFile: path.join(home, 'smoke.log'),
  onUnexpectedExit: (message) => { console.error(message); process.exitCode = 1 },
})
try {
  const exchange = await fetch(runtime.url, { redirect: 'manual' })
  assert.equal(exchange.status, 303)
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0]
  assert(cookie)
  const page = await fetch(runtime.origin, { headers: { cookie } })
  assert.equal(page.status, 200)
  const html = await page.text()
  assert(html.includes('mareo-brand'), 'Mareo plugin missing from boot graph')
  assert(!html.includes('dsh-client-ui-brand-official'), 'Official brand still active')
  assert(!html.includes('dsh-client-ui-settings-models'), 'Provider settings still active')
  assert(html.includes('dsh-client-ui-model-selection'), 'Chat model selection missing from boot graph')
  const patch = JSON.parse(await readFile(path.join(home, 'mareo-brand.patch.json'), 'utf8'))
  assert.equal(patch[0].disabled, true)
  assert(patch.some(entry => entry.id === 'ui-settings-models' && entry.disabled === true))
  console.log('Verified official plugin composition and authenticated Web boot.')
  if (process.argv.includes('--serve')) {
    console.log(JSON.stringify({ pid: process.pid, home, url: runtime.url }))
    await new Promise(resolve => {
      process.once('SIGTERM', resolve)
      process.once('SIGINT', resolve)
    })
  }
} finally {
  await runtime.stop()
}

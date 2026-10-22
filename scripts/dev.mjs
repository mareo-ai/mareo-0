#!/usr/bin/env node
// Development loop for the injected UI (brand/).
//
// `npm start` reinstalls the whole DSH dependency tree on every launch, which is
// minutes of work to change one button. Here the dependency tree is reused and
// only the brand plugin is re-staged; the engine reloads it when the page is
// refreshed, so a style change is: save → ⌘R.
//
// Changes under src/ are not covered: the Electron main process has to restart.
import { spawn, execFileSync } from 'node:child_process'
import { watch } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stagingScript = path.join(projectDirectory, 'scripts', 'stage-runtime.mjs')

/** Rebuilds only the brand package inside .staging; fails loudly if nothing is staged. */
function restageBrand() {
  execFileSync(process.execPath, [stagingScript, '--skip-install'], {
    cwd: projectDirectory,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
}

restageBrand()

// An installed Mareo uses the same user-data directory, and DSH locks a session
// while it is open: two engines on one home is the failure recorded in
// docs/session-log-downgrade.md. Development therefore gets its own home unless
// it is pointed somewhere explicitly.
const devDataDirectory = process.env.MAREO_USER_DATA ?? path.join(projectDirectory, '.dev-data')
console.log(`[brand] 开发数据目录：${devDataDirectory}（与发行版隔离）`)
console.log('[brand] 改 brand/ 下的文件会自动同步，然后在窗口里按 ⌘R\n')

const forge = spawn('npx', ['electron-forge', 'start'], {
  cwd: projectDirectory,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, MAREO_USER_DATA: devDataDirectory },
})
forge.on('exit', (code) => process.exit(code ?? 0))

let pending
watch(path.join(projectDirectory, 'brand'), { recursive: true }, (_event, filename) => {
  // Editors write temp and swap files constantly; only source changes matter.
  if (filename === null || !/\.(cjs|js|json)$/.test(filename)) return
  clearTimeout(pending)
  pending = setTimeout(() => {
    try {
      restageBrand()
      console.log('\n[brand] 已同步 — 在 Mareo 窗口里按 ⌘R 刷新即可看到效果\n')
    } catch (error) {
      console.error(`\n[brand] 同步失败: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }, 200)
})

process.on('SIGINT', () => {
  forge.kill('SIGINT')
  process.exit(0)
})

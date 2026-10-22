import { lstat, readFile, realpath, readdir } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

const resourcesDirectory = path.resolve(process.argv[2] ?? '.staging')
const targetPlatform = argument('--platform') ?? process.platform
const targetArch = argument('--arch') ?? process.arch
const dshRuntimeRoot = await realpath(path.join(resourcesDirectory, 'rt'))
const nodeExecutable = path.join(
  resourcesDirectory,
  'node-runtime',
  'bin',
  targetPlatform === 'win32' ? 'node.exe' : 'node',
)
const manifest = JSON.parse(await readFile(path.join(dshRuntimeRoot, 'package.json'), 'utf8'))
const nodeRuntime = manifest.mareo.node[`${targetPlatform}-${targetArch}`]
if (!nodeRuntime) {
  throw new Error(`No pinned Node runtime for ${targetPlatform}/${targetArch} in the runtime manifest.`)
}

function argument(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const dshDirectory = path.join(dshRuntimeRoot, 'node_modules', '@deepseek-ai', 'dsh')
const dshPackage = JSON.parse(await readFile(path.join(dshDirectory, 'package.json'), 'utf8'))
const expectedVersion = manifest.dependencies?.['@deepseek-ai/dsh']

if (dshPackage.version !== expectedVersion) {
  throw new Error(`Expected DSH ${expectedVersion}, found ${dshPackage.version}.`)
}
if (!dshPackage.bin?.dsh) {
  throw new Error('The staged DSH package has no dsh CLI entry.')
}

let symlinkCount = 0
await inspectLinks(dshRuntimeRoot)
await run(nodeExecutable, ['--version'], `v${nodeRuntime.version}`, resourcesDirectory)
await run(nodeExecutable, ['--expose-internals', path.join(dshDirectory, dshPackage.bin.dsh), '--version'], dshPackage.version, dshRuntimeRoot)
console.log(`Verified Node ${nodeRuntime.version} and DSH ${dshPackage.version} (${symlinkCount} contained symlinks).`)

async function inspectLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    const entryStat = await lstat(entryPath)
    if (entryStat.isSymbolicLink()) {
      symlinkCount += 1
      const target = await realpath(entryPath)
      if (target !== dshRuntimeRoot && !target.startsWith(`${dshRuntimeRoot}${path.sep}`)) {
        throw new Error(`Runtime symlink escapes the staged directory: ${entryPath} -> ${target}`)
      }
    } else if (entryStat.isDirectory()) {
      await inspectLinks(entryPath)
    }
  }
}

function run(command, args, expectedOutput, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`${command} failed with code ${code}: ${stderr.trim()}`))
      } else if (stdout.trim() !== expectedOutput) {
        reject(new Error(`${command} reported ${JSON.stringify(stdout.trim())}, expected ${JSON.stringify(expectedOutput)}.`))
      } else {
        resolve()
      }
    })
  })
}

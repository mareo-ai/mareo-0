import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { get } from 'node:https'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

// Stages the packaged runtime for one target platform:
//   node scripts/stage-runtime.mjs [--platform <darwin|win32>] [--arch <arm64|x64>]
//   node scripts/stage-runtime.mjs --platform win32 --arch x64 --check-node-runtime
// The last form only downloads and validates the target's Node archive, which
// is how the Windows archive is verified from a non-Windows machine.
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestDirectory = path.join(projectDirectory, 'runtime')
const stagingRoot = path.join(projectDirectory, '.staging')
const dshStagingDirectory = path.join(stagingRoot, 'dsh-runtime')
const nodeStagingDirectory = path.join(stagingRoot, 'node-runtime')
const manifest = JSON.parse(await readFile(path.join(manifestDirectory, 'package.json'), 'utf8'))

const options = parseArguments(process.argv.slice(2))
const targetPlatform = options.platform
const targetArch = options.arch
const nodeRuntimes = manifest.mareo?.node ?? {}
const nodeRuntime = nodeRuntimes[`${targetPlatform}-${targetArch}`]

if (!nodeRuntime) {
  throw new Error(`No pinned Node runtime for ${targetPlatform}/${targetArch}. Add it to runtime/package.json.`)
}
if (!options.checkNodeRuntime && (targetPlatform !== process.platform || targetArch !== process.arch)) {
  throw new Error(
    `The DSH dependency tree is installed for the host platform, so staging must run on ${targetPlatform}/${targetArch}. ` +
      'Use --check-node-runtime to validate the Node archive from another machine.',
  )
}

if (options.checkNodeRuntime) {
  const checkDirectory = path.join(projectDirectory, '.cache', 'node-check')
  await rm(checkDirectory, { recursive: true, force: true })
  await stageNodeRuntime(nodeRuntime, checkDirectory)
  console.log(`Verified ${targetPlatform}/${targetArch} Node ${nodeRuntime.version} archive and layout.`)
  await rm(checkDirectory, { recursive: true, force: true })
} else {
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(dshStagingDirectory, { recursive: true })
  await Promise.all([
    cp(path.join(manifestDirectory, 'package.json'), path.join(dshStagingDirectory, 'package.json')),
    cp(path.join(manifestDirectory, 'package-lock.json'), path.join(dshStagingDirectory, 'package-lock.json')),
  ])

  await runNpm(['ci', '--omit=dev'], dshStagingDirectory)
  // Type declarations are for the compiler, never for the running engine, and
  // they are a third of the file count in this tree. The macOS signer walks
  // every file and opens each one, so shipping them costs the release build its
  // file descriptors (EMFILE) for nothing at runtime.
  const prunedTypes = await pruneTypeDeclarations(path.join(dshStagingDirectory, 'node_modules'))
  console.log(`Pruned ${prunedTypes.toLocaleString()} type declaration files from the staged runtime.`)
  // Ship our own package alongside npm dependencies; leave all DSH packages intact.
  const brandDirectory = path.join(dshStagingDirectory, 'node_modules', 'mareo-brand')
  await mkdir(brandDirectory, { recursive: true })
  for (const file of ['package.json', 'index.js']) {
    await cp(path.join(projectDirectory, 'brand', file), path.join(brandDirectory, file))
  }
  const logoUrl = `data:image/png;base64,${(await readFile(path.join(projectDirectory, 'assets', 'logo.png'))).toString('base64')}`
  const brandClient = await readFile(path.join(projectDirectory, 'brand', 'client.cjs'), 'utf8')
  await writeFile(path.join(brandDirectory, 'client.js'),
    `window.__ModuleLoader__.load({ id: 'mareo-brand', factory: (require) => {\nconst exports = {};\nconst logoUrl = ${JSON.stringify(logoUrl)};\n${brandClient}\nreturn exports;\n} });\n`)
  await stageNodeRuntime(nodeRuntime, nodeStagingDirectory)
  await run(process.execPath, [path.join(projectDirectory, 'scripts', 'verify-runtime.mjs'), stagingRoot, '--platform', targetPlatform, '--arch', targetArch], projectDirectory)
}

/**
 * Removes TypeScript declaration files from a staged dependency tree, returning
 * how many were removed. They are read by the compiler and never by Node, and in
 * this tree they are about a third of all files — which the macOS signer has to
 * walk and open one by one.
 */
async function pruneTypeDeclarations(rootDirectory) {
  const declaration = /\.d\.(ts|cts|mts)$/
  let removed = 0
  const pending = [rootDirectory]
  while (pending.length > 0) {
    const directory = pending.pop()
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(entryPath)
      } else if (declaration.test(entry.name)) {
        await unlink(entryPath).catch(() => undefined)
        removed += 1
      }
    }
  }
  return removed
}

function parseArguments(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  return {
    platform: value('--platform') ?? process.platform,
    arch: value('--arch') ?? process.arch,
    checkNodeRuntime: argv.includes('--check-node-runtime'),
  }
}

function nodeArchiveName(nodeConfig) {
  // Official archives spell Windows as "win" (node-vX-win-x64.zip), while
  // process.platform calls it "win32".
  const archivePlatform = nodeConfig.platform === 'win32' ? 'win' : nodeConfig.platform
  const extension = nodeConfig.platform === 'win32' ? 'zip' : 'tar.gz'
  return `node-v${nodeConfig.version}-${archivePlatform}-${nodeConfig.arch}.${extension}`
}

async function stageNodeRuntime(nodeConfig, destinationDirectory) {
  const archiveName = nodeArchiveName(nodeConfig)
  const cacheDirectory = path.join(projectDirectory, '.cache', 'node')
  const archivePath = path.join(cacheDirectory, archiveName)
  const extractionDirectory = path.join(destinationDirectory, 'extraction')
  const distributionDirectory = path.join(extractionDirectory, archiveName.replace(/\.(tar\.gz|zip)$/, ''))

  await mkdir(cacheDirectory, { recursive: true })
  try {
    await verifyChecksum(archivePath, nodeConfig.sha256)
  } catch {
    await download(`https://nodejs.org/dist/v${nodeConfig.version}/${archiveName}`, archivePath)
    await verifyChecksum(archivePath, nodeConfig.sha256)
  }

  // `tar -xf` handles both .tar.gz and .zip on macOS and Windows 10+ (bsdtar).
  await mkdir(extractionDirectory, { recursive: true })
  await run('tar', ['-xf', archivePath, '-C', extractionDirectory], projectDirectory)

  const executableSource = nodeConfig.platform === 'win32'
    ? path.join(distributionDirectory, 'node.exe')
    : path.join(distributionDirectory, 'bin', 'node')
  const executableName = nodeConfig.platform === 'win32' ? 'node.exe' : 'node'
  await mkdir(path.join(destinationDirectory, 'bin'), { recursive: true })
  await Promise.all([
    cp(executableSource, path.join(destinationDirectory, 'bin', executableName)),
    cp(path.join(distributionDirectory, 'LICENSE'), path.join(destinationDirectory, 'LICENSE')),
  ])
  await rm(extractionDirectory, { recursive: true, force: true })
}

async function verifyChecksum(filename, expected) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filename), hash)
  if (hash.digest('hex') !== expected) throw new Error(`Checksum verification failed for ${filename}.`)
}

async function download(url, destination) {
  const partial = `${destination}.partial`
  await rm(partial, { force: true })
  await downloadToFile(url, partial)
  await rename(partial, destination)
}

async function downloadToFile(url, destination) {
  await new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume()
        downloadToFile(new URL(response.headers.location, url).toString(), destination).then(resolve, reject)
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`))
        return
      }
      pipeline(response, createWriteStream(destination)).then(resolve, reject)
    })
    request.once('error', reject)
  })
}

// `npm` is a shell script on POSIX but npm.cmd on Windows, which Node cannot
// spawn directly. Running npm's own JS entry through the current Node avoids
// the platform difference entirely; when this script is not started by npm we
// fall back to the platform launcher.
function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath
  if (npmCli) return run(process.execPath, [npmCli, ...args], cwd)
  if (process.platform === 'win32') return run('cmd.exe', ['/d', '/s', '/c', 'npm', ...args], cwd)
  return run('npm', args, cwd)
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code}`))
    })
  })
}

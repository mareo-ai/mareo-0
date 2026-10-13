import { execFile, spawn } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { get } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { stripLocalPaths } from './telemetry.js'

const execFileAsync = promisify(execFile)

/**
 * How long one attempt may take to report its address. Generous on purpose: a
 * cold start on Windows — Defender scanning the runtime while the disk is busy —
 * has been measured past 30 seconds, and the user is looking at a spinner, not
 * at a broken window.
 */
const STARTUP_TIMEOUT_MS = 90_000
const SHUTDOWN_TIMEOUT_MS = 5_000
/** A missed startup budget is intermittent, so one silent retry is worth it. */
const STARTUP_ATTEMPTS = 2

export interface DshRuntime {
  url: string
  origin: string
  stop(): Promise<void>
}

/**
 * The engine process stayed alive but never became usable inside its budget.
 * Only this kind of failure is retried: a crash or a rejected launch would fail
 * the same way again.
 */
class StartupTimeoutError extends Error {}

interface StartDshRuntimeOptions {
  runtimeDirectory: string
  nodeExecutable: string
  dshHome: string
  workingDirectory: string
  logFile: string
  /** Extra environment variables merged over the process environment. */
  env?: Record<string, string>
  /** How long one startup attempt may take. Defaults to `STARTUP_TIMEOUT_MS`. */
  startupTimeoutMs?: number
  /**
   * Called when DSH dies on its own. The second argument is the tail of its
   * stderr, already stripped of paths and tokens, for the crash report.
   */
  onUnexpectedExit(message: string, errorOutput: string): void
}

interface DshPackageJson {
  bin?: {
    dsh?: string
  }
}

export function extractDshUrl(output: string): string | undefined {
  const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)
  if (!match) return undefined

  try {
    return new URL(match[0]).toString()
  } catch {
    return undefined
  }
}

export async function startDshRuntime(options: StartDshRuntimeOptions): Promise<DshRuntime> {
  const dshPackageDirectory = path.join(options.runtimeDirectory, 'node_modules', '@deepseek-ai', 'dsh')
  const packageJson = JSON.parse(
    await readFile(path.join(dshPackageDirectory, 'package.json'), 'utf8'),
  ) as DshPackageJson

  if (!packageJson.bin?.dsh) {
    throw new Error('The packaged DSH runtime does not declare a dsh CLI entry.')
  }

  // DSH resolves third-party plugins from its profile, so use the installed
  // package's file URL. This app-owned overlay never rewrites user config.
  await mkdir(options.dshHome, { recursive: true })
  const brandPatch = path.join(options.dshHome, 'mareo-brand.patch.json')
  await writeFile(brandPatch, JSON.stringify([
    { id: 'ui-brand-official', disabled: true },
    // Mareo owns provider credentials; keep the separate chat model picker.
    { id: 'ui-settings-models', disabled: true },
    // DSH 0.2 grew a DeepSeek account of its own. Signing in there would send
    // model calls straight to DeepSeek, past the gateway that bills and limits
    // them, so the whole account surface stays off.
    { id: 'ui-settings-account', disabled: true },
    { id: 'llm-deepseek-account', disabled: true },
    { id: 'deepseek-account', disabled: true },
    // The plugin manager and the web-search settings page stay available: users
    // may switch on the official bundles they want (voice input among them) and
    // point search at their own credentials — search on the user's own key costs
    // us nothing, so it needs no ledger entry. Neither surface can undo the
    // guards above, because this overlay is applied after the profile layer: a
    // profile-level edit loses to it.
    //
    // Everything else is left exactly as DSH ships it — the agent's plugin tool
    // included, which upstream keeps off. Overriding a default here would mean
    // quietly diverging from upstream on every future version.
    { insert: [{ id: 'mareo-brand', name: pathToFileURL(path.join(options.runtimeDirectory, 'node_modules', 'mareo-brand', 'index.js')).href }] },
  ]))
  await mkdir(path.dirname(options.logFile), { recursive: true })

  const launch: DshLaunch = {
    dshBinPath: path.join(dshPackageDirectory, packageJson.bin.dsh),
    brandPatch,
    startupTimeoutMs: options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
    log: createWriteStream(options.logFile, { flags: 'w' }),
  }

  let lastError: unknown
  for (let attempt = 1; attempt <= STARTUP_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      // The failed attempt closed its own stream, so reopen in append mode
      // instead of throwing its evidence away.
      launch.log = createWriteStream(options.logFile, { flags: 'a' })
      launch.log.write(`\n--- no address after ${launch.startupTimeoutMs} ms, starting the engine again (attempt ${attempt}) ---\n`)
    }
    try {
      return await launchDshProcess(options, launch)
    } catch (error) {
      lastError = error
      if (!(error instanceof StartupTimeoutError)) throw error
    }
  }
  throw lastError
}

interface DshLaunch {
  dshBinPath: string
  brandPatch: string
  startupTimeoutMs: number
  log: WriteStream
}

/** One engine process: spawn it, wait until its Web UI answers, hand it back. */
async function launchDshProcess(options: StartDshRuntimeOptions, launch: DshLaunch): Promise<DshRuntime> {
  const { log } = launch
  const child = spawn(
    options.nodeExecutable,
    [
      '--expose-internals',
      launch.dshBinPath,
      'web',
      '--patch',
      launch.brandPatch,
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--no-open',
    ],
    {
      cwd: options.workingDirectory,
      // POSIX uses a process group so the whole DSH tree can be signalled at
      // once; Windows has no process groups, so it is killed via taskkill.
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        DSH_HOME: options.dshHome,
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let stopping = false
  let ready = false
  let output = ''
  let recentErrorOutput = ''
  let exitDescription: string | undefined
  let resolveExit: (() => void) | undefined
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve
  })

  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    output = (output + text).slice(-16_384)
    log.write(redactDshToken(text))
  })
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    recentErrorOutput = (recentErrorOutput + text).slice(-4_096)
    log.write(text)
  })
  child.once('error', (error) => {
    recentErrorOutput = (recentErrorOutput + error.message).slice(-4_096)
  })
  child.on('close', (code, signal) => {
    exitDescription = code !== null ? `code ${code}` : `signal ${signal ?? 'unknown'}`
    log.end()
    resolveExit?.()
    if (ready && !stopping) {
      options.onUnexpectedExit(
        `DeepSeek Harness exited unexpectedly (${exitDescription}).`,
        reportableErrorOutput(recentErrorOutput),
      )
    }
  })

  try {
    // The address is normally on stdout, but a late or redirected line must not
    // cost a start: both streams are scanned, only stdout is logged as output.
    const url = await waitForDshUrl(() => output + recentErrorOutput, () => exitDescription, launch.startupTimeoutMs)
    await waitUntilReachable(url, () => exitDescription, launch.startupTimeoutMs)
    ready = true

    return {
      url,
      origin: new URL(url).origin,
      async stop() {
        if (stopping || exitDescription !== undefined) return
        stopping = true
        await terminateDshTree(child.pid, 'SIGTERM')
        await Promise.race([
          exited,
          new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
        ])
        if (exitDescription === undefined) {
          await terminateDshTree(child.pid, 'SIGKILL')
          await exited
        }
      },
    }
  } catch (error) {
    stopping = true
    if (exitDescription === undefined) await terminateDshTree(child.pid, 'SIGTERM')
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ])
    const detail = recentErrorOutput.trim()
    throw startFailure(error, detail)
  }
}

/** Keeps a startup timeout recognisable as retryable while attaching what the engine printed. */
function startFailure(error: unknown, detail: string): Error {
  const message = detail === '' ? messageFrom(error) : `${messageFrom(error)}\n\n${detail}`
  return error instanceof StartupTimeoutError ? new StartupTimeoutError(message) : new Error(message)
}

async function waitForDshUrl(
  currentOutput: () => string,
  currentExit: () => string | undefined,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const url = extractDshUrl(currentOutput())
    if (url) return url
    const exitDescription = currentExit()
    if (exitDescription !== undefined) {
      throw new Error(`DeepSeek Harness exited before startup completed (${exitDescription}).`)
    }
    await delay(100)
  }

  throw new StartupTimeoutError('Timed out waiting for DeepSeek Harness to report its local address.')
}

async function waitUntilReachable(url: string, currentExit: () => string | undefined, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const exitDescription = currentExit()
    if (exitDescription !== undefined) {
      throw new Error(`DeepSeek Harness exited during its health check (${exitDescription}).`)
    }

    if (await probeLocalUrl(url)) return
    await delay(150)
  }

  throw new StartupTimeoutError('Timed out waiting for the DeepSeek Harness Web UI.')
}

function probeLocalUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get(url, (response) => {
      response.resume()
      resolve(response.statusCode !== undefined && response.statusCode < 400)
    })
    request.setTimeout(1_000, () => request.destroy())
    request.once('error', () => resolve(false))
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * What we are willing to send about a crash: the last few lines of technical
 * output, with local paths and the DSH launch token removed and a hard size cap.
 * Anything longer is a conversation fragment, not a stack trace.
 */
export function reportableErrorOutput(text: string, maxLines = 20, maxChars = 4_000): string {
  const cleaned = stripLocalPaths(redactDshToken(text))
  const lines = cleaned
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
  const tail = lines.slice(-maxLines).join('\n')
  return tail.length > maxChars ? tail.slice(-maxChars) : tail
}

function redactDshToken(output: string): string {
  return output.replace(/([?&]token=)[^\s&]+/g, '$1[REDACTED]')
}

/** Stops the DSH process and its children on the current platform. */
async function terminateDshTree(pid: number | undefined, signal: NodeJS.Signals): Promise<void> {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    // taskkill /T terminates the whole tree; /F is required for the force case
    // since Windows has no SIGKILL.
    const args = ['/pid', String(pid), '/T']
    if (signal === 'SIGKILL') args.push('/F')
    try {
      await execFileAsync('taskkill', args)
    } catch {
      // The process may already be gone.
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

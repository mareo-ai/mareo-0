import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

interface UnstickModule {
  unstickSession: (
    logPath: string,
    options: { knownTypes: Set<string>; now?: Date },
  ) => Promise<{ events: number; patched: Record<string, number>; backupPath?: string }>
  scanZstdFrames: (buffer: Buffer) => { start: number; end: number }[]
}

async function unstickScript(): Promise<UnstickModule> {
  const script = pathToFileURL(path.resolve('scripts/unstick-session.mjs')).href
  return (await import(script)) as UnstickModule
}

const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
const HEADER = {
  type: 'session',
  version: 4,
  id: 'session-abc',
  createdAt: 1,
  cwd: '/tmp',
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: 'standard',
}

let root: string

test.before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mareo-unstick-'))
})

test.after(async () => {
  await rm(root, { recursive: true, force: true })
})

/** One frame per batch, the way DSH writes: a header frame, then one per append. */
function writeLog(logPath: string, events: Record<string, unknown>[]): void {
  const frames = [HEADER, ...events].map((event) =>
    zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`), CHECKSUM),
  )
  writeFileSync(logPath, Buffer.concat(frames))
}

async function readLog(logPath: string): Promise<Record<string, unknown>[]> {
  const { scanZstdFrames } = await unstickScript()
  const buffer = readFileSync(logPath)
  return scanZstdFrames(buffer).flatMap((frame) =>
    zlib
      .zstdDecompressSync(buffer.subarray(frame.start, frame.end))
      .toString('utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  )
}

// Zstandard arrived in Node 22.15. The bundled runtime is Node 24, but a
// developer's local Node may be older, where this script cannot run at all.
const zstdOnly = typeof zlib.zstdCompressSync === 'function'
  ? {}
  : { skip: 'this Node has no zstd support (needs 22.15 or newer)' }

const knownTypes = new Set(['user/message', 'turn/start'])
const userMessage = { type: 'user/message', seq: 0, time: 1, data: { text: 'hi' } }
const jobEvent = { type: 'job/registered', seq: 1, time: 2, data: { jobId: 'bash-1' } }

test('marks only the events this runtime does not know', zstdOnly, async () => {
  const { unstickSession } = await unstickScript()
  const logPath = path.join(await mkdtemp(path.join(root, 'log-')), 'session.v4.jsonl.zstd')
  writeLog(logPath, [userMessage, jobEvent])
  const original = await readFile(logPath)

  const result = await unstickSession(logPath, { knownTypes, now: new Date(2026, 9, 21, 22, 45, 3) })
  assert.deepEqual(result.patched, { 'job/registered': 1 })
  assert.equal(result.events, 3)
  assert.equal(result.backupPath, `${logPath}.bak-20261021-224503`)

  // The backup is byte-identical to what was there before.
  assert.deepEqual(await readFile(result.backupPath as string), original)

  const [header, first, second] = (await readLog(logPath)) as [
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
  ]
  assert.equal(header.version, 4)
  assert.equal(first.ignorable, undefined)
  assert.equal(second.ignorable, true)
  assert.deepEqual(second.data, { jobId: 'bash-1' })
})

test('leaves a log alone when every event is known', zstdOnly, async () => {
  const { unstickSession } = await unstickScript()
  const logPath = path.join(await mkdtemp(path.join(root, 'log-')), 'session.v4.jsonl.zstd')
  writeLog(logPath, [userMessage])
  const original = await readFile(logPath)

  const result = await unstickSession(logPath, { knownTypes })
  assert.deepEqual(result.patched, {})
  assert.equal(result.backupPath, undefined)
  assert.deepEqual(await readFile(logPath), original)
  assert.deepEqual((await readdir(path.dirname(logPath))).sort(), ['session.v4.jsonl.zstd'])
})

test('is idempotent: a second run finds nothing left to mark', zstdOnly, async () => {
  const { unstickSession } = await unstickScript()
  const logPath = path.join(await mkdtemp(path.join(root, 'log-')), 'session.v4.jsonl.zstd')
  writeLog(logPath, [userMessage, jobEvent])

  await unstickSession(logPath, { knownTypes })
  const second = await unstickSession(logPath, { knownTypes })
  assert.deepEqual(second.patched, {})
  assert.equal(second.backupPath, undefined)
})

test('refuses a log it cannot read rather than guessing', zstdOnly, async () => {
  const { unstickSession } = await unstickScript()
  const logPath = path.join(await mkdtemp(path.join(root, 'log-')), 'session.v4.jsonl.zstd')
  await writeFile(logPath, Buffer.from('not zstandard'))

  await assert.rejects(unstickSession(logPath, { knownTypes }), /invalid frame magic|torn frame/)
})

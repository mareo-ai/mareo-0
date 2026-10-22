// Recovers a session log written by a newer DSH than the one at hand.
//
//   node scripts/unstick-session.mjs <session.v4.jsonl.zstd> [--runtime <dsh-runtime dir>]
//
// DSH refuses a log holding an event type it does not know, unless the writer
// marked that event `ignorable: true`. When the newer runtime wrote events whose
// absence cannot change what the session means (job lifecycle records, say), the
// same log can be made readable by marking exactly those events ignorable. This
// rewrites the log — hence the backup and the frame-by-frame verification — and
// refuses to touch anything that is not already structurally sound.
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ZSTD_MAGIC = 4247762216
const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Marks events this runtime does not know as ignorable, so it can read the log.
 * @returns counts of what was patched, and the backup taken (none when no event
 *   needed a change).
 */
export async function unstickSession(logPath, { knownTypes, now = new Date() }) {
  const before = fs.statSync(logPath)
  const source = fs.readFileSync(logPath)
  const frames = scanZstdFrames(source)
  if (frames.length === 0) throw new Error(`${logPath} contains no Zstandard frames`)

  const chunks = []
  const patched = {}
  for (const frame of frames) {
    const text = zlib.zstdDecompressSync(source.subarray(frame.start, frame.end)).toString('utf8')
    const lines = text.split('\n')
    const trailingNewline = lines.pop() === ''
    let changed = false
    const rewritten = lines.map((line) => {
      const event = JSON.parse(line)
      if (event.type === 'session' || knownTypes.has(event.type) || event.ignorable === true) return line
      if (!line.endsWith('}')) throw new Error(`event line is not an object: ${line.slice(0, 120)}`)
      changed = true
      patched[event.type] = (patched[event.type] ?? 0) + 1
      return `${line.slice(0, -1)},"ignorable":true}`
    })
    const next = trailingNewline ? `${rewritten.join('\n')}\n` : rewritten.join('\n')
    chunks.push(changed ? zlib.zstdCompressSync(next, CHECKSUM) : source.subarray(frame.start, frame.end))
  }

  const eventCount = Object.values(patched).reduce((total, count) => total + count, 0)
  if (eventCount === 0) return { events: countEvents(source), patched }

  const stagedPath = `${logPath}.patched`
  fs.writeFileSync(stagedPath, Buffer.concat(chunks))
  // The log holds conversations, so it keeps the permissions it was written with.
  fs.chmodSync(stagedPath, fs.statSync(logPath).mode)
  try {
    verify(source, fs.readFileSync(stagedPath), knownTypes)
  } catch (error) {
    fs.rmSync(stagedPath, { force: true })
    throw error
  }

  // A session being written right now must not lose what landed after our read:
  // the app appends whole batches, so an unchanged size and mtime means the bytes
  // we verified are still the whole file.
  const reread = fs.statSync(logPath)
  if (reread.size !== before.size || reread.mtimeMs !== before.mtimeMs) {
    fs.rmSync(stagedPath, { force: true })
    throw new Error(`${logPath} 在改写期间有新的写入（会话可能正打开着）：先关闭该会话再重试`)
  }

  const backupPath = `${logPath}.bak-${stamp(now)}`
  fs.copyFileSync(logPath, backupPath)
  fs.renameSync(stagedPath, logPath)
  return { events: countEvents(fs.readFileSync(logPath)), patched, backupPath }
}

/** Complete Zstandard frame ranges; a torn tail refuses rather than guessing. */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  const need = (count) => {
    if (buffer.length - offset < count) throw new Error(`session log has a torn frame at byte ${offset}`)
  }
  while (offset < buffer.length) {
    const start = offset
    need(5)
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + (dictionaryFlag === 3 ? 4 : dictionaryFlag) + contentSizeBytes
    for (;;) {
      need(3)
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const blockType = (blockHeader >>> 1) & 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      offset += blockType === 1 ? 1 : blockHeader >>> 3
      if (blockHeader & 1) break
    }
    if (checksum) offset += 4
    need(0)
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * The rewrite must change exactly the event envelopes it targets: same frames,
 * same order, same sequence, and every unknown event now ignorable.
 */
function verify(before, after, knownTypes) {
  const beforeFrames = scanZstdFrames(before)
  const afterFrames = scanZstdFrames(after)
  if (beforeFrames.length !== afterFrames.length) throw new Error('frame count changed during the rewrite')

  let expectedSeq = 0
  let header
  for (const [index, frame] of beforeFrames.entries()) {
    const plaintext = zlib.zstdDecompressSync(before.subarray(frame.start, frame.end)).toString('utf8')
    const expected = plaintext.split('\n').map((line) => {
      if (line === '') return line
      const event = JSON.parse(line)
      if (event.type === 'session' || knownTypes.has(event.type) || event.ignorable === true) return line
      return `${line.slice(0, -1)},"ignorable":true}`
    }).join('\n')
    const written = zlib.zstdDecompressSync(after.subarray(afterFrames[index].start, afterFrames[index].end)).toString('utf8')
    if (written !== expected) throw new Error(`frame ${index} did not survive the rewrite`)

    for (const line of written.split('\n')) {
      if (line === '') continue
      const event = JSON.parse(line)
      if (event.type === 'session' && header === undefined) {
        header = event
        continue
      }
      if (event.seq !== expectedSeq) throw new Error(`sequence gap: expected ${expectedSeq}, found ${event.seq}`)
      expectedSeq += 1
      if (!knownTypes.has(event.type) && event.ignorable !== true) {
        throw new Error(`event ${event.type} at seq ${event.seq} is still unreadable`)
      }
    }
  }
  if (header?.version === undefined) throw new Error('the rewritten log has no session header')
}

function countEvents(buffer) {
  return scanZstdFrames(buffer).reduce((total, frame) => {
    const text = zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
    return total + text.split('\n').filter((line) => line !== '').length
  }, 0)
}

function stamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** The event vocabulary of a staged (or installed) runtime. */
async function loadKnownEventTypes(runtimeDirectory) {
  const modulePath = path.join(runtimeDirectory, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js')
  if (!fs.existsSync(modulePath)) {
    throw new Error(`找不到 DSH 运行时：${modulePath}（用 --runtime 指定 dsh-runtime 目录，或先 npm run stage:runtime）`)
  }
  const { KNOWN_SESSION_EVENT_TYPES } = await import(pathToFileURL(modulePath).href)
  return KNOWN_SESSION_EVENT_TYPES
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const positionals = []
  let runtimeDirectory = path.join(projectRoot, '.staging', 'rt')
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--runtime') {
      runtimeDirectory = path.resolve(args[index + 1] ?? '')
      index += 1
      continue
    }
    positionals.push(args[index])
  }

  if (positionals[0] === undefined) {
    console.error('用法：node scripts/unstick-session.mjs <session.v4.jsonl.zstd> [--runtime <dsh-runtime>]')
    process.exit(1)
  }

  const knownTypes = await loadKnownEventTypes(runtimeDirectory)
  const result = await unstickSession(path.resolve(positionals[0]), { knownTypes })
  if (result.backupPath === undefined) {
    console.log(`无需修改：${result.events} 条事件都已经是这个运行时能读的形式。`)
  } else {
    const counts = Object.entries(result.patched).map(([type, count]) => `${type} ×${count}`).join('、')
    console.log(`已标记为 ignorable：${counts}（共 ${result.events} 条事件）`)
    console.log(`原文件备份：${result.backupPath}`)
  }
}

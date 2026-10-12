// Interactive release: bumps the version, commits it to main, and pushes the tag
// that makes CI build, sign and publish everything.
//
//   npm run release                 # 交互式，逐项确认
//   npm run release -- --dry-run    # 只打印计划，不做任何改动
//
// The tag annotation carries the release metadata clients read: its first line
// becomes the in-app update note, and an optional "minimum-version:" line makes
// older builds update before they can be used at all.
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJsonPath = path.join(projectRoot, 'package.json')

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

async function git(...args) {
  const { stdout } = await execFileAsync('git', args, { cwd: projectRoot })
  return stdout.trim()
}

/** Patch bump: the next version this project is most likely to ship. */
export function recommendVersion(current) {
  const [major, minor, patch] = current.split('.').map((part) => Number.parseInt(part, 10))
  return `${major}.${minor}.${patch + 1}`
}

export function isValidVersion(version) {
  return VERSION_PATTERN.test(version)
}

/** Numeric comparison is enough here: the inputs are validated x.y.z strings. */
export function isNewerVersion(candidate, current) {
  const a = candidate.split('.').map(Number)
  const b = current.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index]
  }
  return false
}

/** Arguments for `git tag -a`, so the release metadata travels with the tag. */
export function tagArguments(version, { notes, minimumVersion }) {
  const args = ['tag', '-a', `v${version}`, '-m', notes]
  if (minimumVersion) args.push('-m', `minimum-version: ${minimumVersion}`)
  return args
}

/**
 * Suggests the update note: the newest commit subject, unless that is the version
 * bump itself ("Release 0.1.3"), which tells a user nothing — then the change it
 * ships is the better suggestion.
 */
export function suggestNote(subjects) {
  const [latest, previous] = subjects
  if (latest === undefined) return ''
  return /^Release\s+\d/.test(latest) && previous !== undefined ? previous : latest
}

export function parseArguments(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  return {
    version: value('--version'),
    notes: value('--notes'),
    minimumVersion: value('--minimum-version'),
    dryRun: argv.includes('--dry-run'),
    yes: argv.includes('--yes'),
  }
}

async function ask(question, fallback) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const suffix = fallback ? ` [${fallback}]` : ''
  const answer = (await rl.question(`${question}${suffix}: `)).trim()
  rl.close()
  return answer === '' ? (fallback ?? '') : answer
}

async function ensureReleasable() {
  if ((await git('status', '--porcelain')) !== '') throw new Error('工作区有未提交的改动，先提交或撤销')
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch !== 'main') throw new Error(`当前在 ${branch}，发布必须在 main 上`)
  await git('fetch', 'origin', 'main')
  if ((await git('rev-list', '--count', 'HEAD..origin/main')) !== '0') {
    throw new Error('本地 main 落后于远端，先 git pull')
  }
}

/** Rejects a version that is already tagged, before anything is written. */
async function ensureTagAvailable(version) {
  const tag = `v${version}`
  if ((await git('tag', '--list', tag)) !== '') {
    throw new Error(`本地已有 tag ${tag}；若上次发布中断，先 git tag -d ${tag} 再重试`)
  }
  if ((await git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) !== '') {
    throw new Error(`远端已有 tag ${tag}，该版本已经发布过`)
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const missing =
    options.version === undefined || options.notes === undefined || options.minimumVersion === undefined
  // A dry run with everything supplied asks nothing, so it never needs a TTY.
  const willPrompt = missing || (!options.yes && !options.dryRun)
  if (!process.stdin.isTTY && willPrompt) {
    throw new Error('非交互终端需要同时给出 --version、--notes、--minimum-version 和 --yes')
  }
  await ensureReleasable()

  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  const currentVersion = packageJson.version
  const recentSubjects = (await git('log', '-2', '--pretty=%s')).split('\n')
  console.log(`当前版本：${currentVersion}`)
  console.log(`最新提交：${recentSubjects[0]}\n`)

  const version = options.version ?? (await ask('新版本号', recommendVersion(currentVersion)))
  if (!isValidVersion(version)) throw new Error(`版本号格式应为 x.y.z：${version}`)
  if (version === currentVersion) throw new Error(`版本号未变化（${currentVersion}）`)

  const notes = options.notes ?? (await ask('更新说明（用户在升级提示里看到的一句话）', suggestNote(recentSubjects)))
  const minimumVersion = options.minimumVersion ?? (await ask('强制更新的最低版本（留空 = 不强制）'))
  if (minimumVersion !== '' && !isValidVersion(minimumVersion)) {
    throw new Error(`最低版本格式应为 x.y.z：${minimumVersion}`)
  }
  if (minimumVersion !== '' && isNewerVersion(minimumVersion, version)) {
    throw new Error(`最低版本 ${minimumVersion} 高于本次版本 ${version}，用户将无处可升`)
  }
  await ensureTagAvailable(version)

  console.log('\n将要执行：')
  console.log(`  1. package.json 版本 ${currentVersion} -> ${version}`)
  console.log(`  2. 提交 "Release ${version}" 并推送到 main`)
  console.log(`  3. 打 tag v${version}：更新说明「${notes}」`)
  console.log(
    minimumVersion === ''
      ? '     minimumVersion 留空 —— 用户收到提示但可以继续用旧版本'
      : `     minimumVersion ${minimumVersion} —— 低于该版本的客户端将无法使用，必须更新`,
  )
  console.log('  4. 推送 tag，CI 构建 macOS/Windows 安装包并发布到 OSS 与官网')

  if (options.dryRun) {
    console.log('\n[dry-run] 到此为止，没有做任何改动。')
    return
  }
  if (!options.yes && (await ask('\n确认发布？(yes/no)')) !== 'yes') {
    console.log('已取消。')
    return
  }

  packageJson.version = version
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)
  await git('commit', '-am', `Release ${version}`)
  await git(...tagArguments(version, { notes, minimumVersion }))
  // Atomic: either main and the tag both land, or neither does.
  await git('push', '--atomic', 'origin', 'main', `v${version}`)

  console.log(`\n已推送 v${version}，构建进度：`)
  console.log('  https://github.com/mareo-ai/mareo-0/actions/workflows/release.yml')
  console.log('约 20-40 分钟后（含 Apple 公证），官网与客户端会看到新版本。')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}

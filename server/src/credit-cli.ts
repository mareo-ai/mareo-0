// Operator CLI for the Mareo Wallet: grant credit, read a balance, inspect the
// ledger. Everything that adds credit goes through the same `grantCredit` the
// purchase callback and the reward tasks will use, so an operator grant is
// recorded the same way and shows up in the same reports.
//
//   npm run credit -- balance --account <id|昵称>
//   npm run credit -- grant --account <id|昵称> --amount-yuan 10 --source promotion --ref ORDER-1
//   npm run credit -- grant --account <id|昵称> --amount-yuan 5 --source manual
//   npm run credit -- list --account <id|昵称> --limit 20
//
// Amounts are given in yuan because that is what an operator knows; the wallet
// stores micro-yuan (1 元 = 1,000,000).
import { openDatabase, type GatewayDatabase } from './db.js'
import { CREDIT_SOURCES, grantCredit, recentLedger, walletBalanceMicro, type CreditSource } from './wallet.js'

interface CliArguments {
  command?: string
  flags: Map<string, string>
  dbPath: string
}

/** `--flag value` pairs, with the first bare argument as the command. */
function parseArguments(argv: string[]): CliArguments {
  const flags = new Map<string, string>()
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument.startsWith('--')) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} 需要一个值`)
      flags.set(argument.slice(2), value)
      index += 1
      continue
    }
    positional.push(argument)
  }
  return {
    command: positional[0],
    flags,
    dbPath: flags.get('db') ?? process.env.DB_PATH ?? 'data/mareo.db',
  }
}

function yuan(micro: number): string {
  return `¥${(micro / 1_000_000).toFixed(2)}`
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name)
  if (value === undefined || value === '') throw new Error(`缺少 --${name}`)
  return value
}

/** `--account` takes an id or the display name an operator sees in the panel. */
function resolveAccount(db: GatewayDatabase, needle: string): { id: string; displayName: string } {
  const byId = db.prepare('SELECT id, displayName FROM users WHERE id = ?').get(needle) as
    | { id: string; displayName: string }
    | undefined
  if (byId !== undefined) return byId
  const byName = db.prepare('SELECT id, displayName FROM users WHERE displayName = ?').all(needle) as {
    id: string
    displayName: string
  }[]
  if (byName.length === 1) return byName[0]!
  if (byName.length === 0) throw new Error(`找不到账号 ${needle}（可以用账号 id 或昵称）`)
  throw new Error(`昵称 ${needle} 对应 ${byName.length} 个账号，请改用账号 id`)
}

function parseAmountMicro(raw: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--amount-yuan 需要大于 0 的数，收到 ${raw}`)
  const micro = Math.round(value * 1_000_000)
  if (micro <= 0) throw new Error(`--amount-yuan 太小，最小 0.000001 元`)
  return micro
}

const { command, flags, dbPath } = parseArguments(process.argv.slice(2))
const db = openDatabase(dbPath)

try {
  if (command === undefined || command === 'help') {
    console.log(
      [
        '用法：',
        '  npm run credit -- balance --account <id|昵称>',
        '  npm run credit -- grant --account <id|昵称> --amount-yuan 10 --source promotion [--ref 单号] [--channel 渠道]',
        '  npm run credit -- list --account <id|昵称> [--limit 20]',
        '',
        `可用的额度来源：${CREDIT_SOURCES.join(', ')}`,
      ].join('\n'),
    )
  } else if (command === 'balance') {
    const account = resolveAccount(db, required(flags, 'account'))
    console.log(`${account.displayName}（${account.id}）\n  Mareo 余额 ${yuan(walletBalanceMicro(db, account.id))}`)
  } else if (command === 'list') {
    const account = resolveAccount(db, required(flags, 'account'))
    const limit = Number(flags.get('limit') ?? 20)
    const entries = recentLedger(db, account.id, Number.isInteger(limit) && limit > 0 ? limit : 20)
    console.log(`${account.displayName}（${account.id}）最近 ${entries.length} 条：`)
    for (const entry of entries) {
      const direction = entry.type === 'credit' ? '+' : '−'
      const reference = entry.externalRef === null ? '' : `  ref=${entry.externalRef}`
      const channel = entry.channel === null ? '' : `  channel=${entry.channel}`
      console.log(
        `  ${entry.createdAt.slice(0, 16).replace('T', ' ')}  ${direction}${yuan(entry.amountMicro).slice(1)}  ${entry.source.padEnd(10)}  余额 ${yuan(entry.balanceAfterMicro)}${reference}${channel}`,
      )
    }
  } else if (command === 'grant') {
    const account = resolveAccount(db, required(flags, 'account'))
    const amountMicro = parseAmountMicro(required(flags, 'amount-yuan'))
    const source = required(flags, 'source')
    if (!CREDIT_SOURCES.includes(source as CreditSource)) {
      throw new Error(`未知的额度来源 ${source}；可用：${CREDIT_SOURCES.join(', ')}`)
    }
    const externalRef = flags.get('ref') ?? null
    const channel = flags.get('channel') ?? null
    const { entry, duplicated } = grantCredit(db, {
      accountId: account.id,
      amountMicro,
      source: source as CreditSource,
      externalRef,
      channel,
    })
    console.log(
      duplicated
        ? `已存在（source=${source} ref=${externalRef}），未重复入账：余额 ${yuan(entry.balanceAfterMicro)}`
        : `已入账 ${yuan(entry.amountMicro)}（${source}${externalRef === null ? '' : ` ${externalRef}`}）给 ${account.displayName}，余额 ${yuan(entry.balanceAfterMicro)}`,
    )
  } else {
    throw new Error(`未知命令 ${command}；可用：balance、grant、list`)
  }
} finally {
  db.close()
}

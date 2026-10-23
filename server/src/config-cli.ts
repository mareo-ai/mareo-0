// Operator CLI for the quota settings. Values live in the database, so a change
// takes effect on the next request without a redeploy or a restart.
//
//   npm run config                    # show every key and its current value
//   npm run config -- set quota.mode shadow
//   npm run config -- set quota.dailyFreeMicro 10000000
//   npm run config -- unset quota.mode
//
// Amounts are micro-yuan: 1 元 = 1,000,000.
import { openDatabase, type GatewayDatabase } from './db.js'
import { readRawSettings, readSettings, SETTING_KEYS, writeSetting } from './settings.js'
import { quotaVisible } from './quota.js'

interface CliArguments {
  command?: string
  rest: string[]
  dbPath: string
  account?: string
}

/** Flags may appear anywhere; everything else is positional. */
function parseArguments(argv: string[]): CliArguments {
  let dbPath = process.env.DB_PATH ?? 'data/mareo.db'
  let account: string | undefined
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--db') {
      dbPath = argv[index + 1] ?? dbPath
      index += 1
      continue
    }
    if (argument === '--account') {
      account = argv[index + 1]
      index += 1
      continue
    }
    positional.push(argument)
  }
  return { command: positional[0], rest: positional.slice(1), dbPath, account }
}

function yuan(micro: number): string {
  return `¥${(micro / 1_000_000).toFixed(2)}`
}

function show(db: GatewayDatabase, account: string | undefined): void {
  const stored = readRawSettings(db)
  const effective = readSettings(db)
  const readable: Record<string, string> = {
    'quota.mode': effective.quotaMode,
    'quota.dailyFreeMicro': `${effective.dailyFreeMicro}（${yuan(effective.dailyFreeMicro)}）`,
    'quota.freeTiers': effective.freeTiers.length === 0
      ? '未配置（全部账号固定用 dailyFreeMicro）'
      : effective.freeTiers
          .map((tier) => `累计 ${yuan(tier.atMicro)} → 当日 ${yuan(tier.allowanceMicro)}`)
          .join('；'),
    'quota.rewardAmountMicro': `${effective.rewardAmountMicro}（${yuan(effective.rewardAmountMicro)}）`,
    'quota.dailyRewardCapMicro': `${effective.dailyRewardCapMicro}（${yuan(effective.dailyRewardCapMicro)}）`,
    'quota.rewardMinSeconds': `${effective.rewardMinSeconds} 秒`,
    'quota.rewardDailyLimit': `${effective.rewardDailyLimit} 次`,
    'quota.rewardAccounts': effective.rewardAccounts.length === 0 ? '（空：无人可用奖励）' : effective.rewardAccounts.join(', '),
    'quota.rewardProvider': effective.rewardProvider,
    'billing.settlementRate': `${effective.settlementRate} 倍`,
    'billing.modelRates': effective.modelRates.size === 0
      ? `（空：所有模型都用默认 ${effective.settlementRate} 倍）`
      : [...effective.modelRates].map(([model, rate]) => `${model} = ${rate} 倍`).join('；'),
  }
  for (const { key, meaning } of SETTING_KEYS) {
    const source = stored.has(key) ? '已设置' : '默认值'
    console.log(`${key}\n  = ${readable[key]}   [${source}]   ${meaning}`)
  }
  if (account !== undefined) {
    console.log(`\n账号 ${account}：每日免费额度 ${yuan(effective.dailyFreeMicro)}，可用奖励 ${effective.rewardAccounts.includes(account) ? '是' : '否'}，看得到额度 ${quotaVisible(effective, account) ? '是' : '否'}`)
  }
}

const { command, rest, dbPath, account } = parseArguments(process.argv.slice(2))
const db = openDatabase(dbPath)

try {
  if (command === undefined || command === 'list' || command === 'show') {
    show(db, account)
  } else if (command === 'set') {
    const [key, ...value] = rest
    if (key === undefined || value.length === 0) throw new Error('用法：npm run config -- set <key> <value>')
    writeSetting(db, key, value.join(' '))
    console.log(`已设置 ${key} = ${value.join(' ')}（下一次请求立即生效）`)
  } else if (command === 'unset') {
    const key = rest[0]
    if (key === undefined) throw new Error('用法：npm run config -- unset <key>')
    db.prepare('DELETE FROM settings WHERE key = ?').run(key)
    console.log(`已恢复 ${key} 的默认值`)
  } else {
    throw new Error(`未知命令 ${command}；可用：list、set、unset`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  db.close()
}

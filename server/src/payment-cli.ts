/**
 * The operator's view of recharge orders, for the questions a support desk
 * actually gets: "I paid and nothing arrived", "which order is this", "take
 * this order off the board".
 *
 *   npm run payment -- list --status pending
 *   npm run payment -- show MR20261013031500ABCDEF
 *   npm run payment -- pay  MR20261013031500ABCDEF --transaction 2026... --amount-fen 3000
 *   npm run payment -- cancel MR20261013031500ABCDEF
 *
 * `pay` goes through the same `confirmPayment` a callback uses, so a manual fix
 * is recorded exactly like a normal payment — including the fact that it cannot
 * happen twice.
 */
import { openDatabase, type GatewayDatabase } from './db.js'
import { confirmPayment, paymentOrder } from './payment/orders.js'
import type { PaymentOrderRow } from './payment/provider.js'

interface Arguments {
  command: 'list' | 'show' | 'pay' | 'cancel'
  orderId?: string
  account?: string
  status?: string
  limit: number
  transactionId?: string
  amountFen?: number
  dbPath: string
}

function parseArguments(argv: string[]): Arguments {
  const command = argv.find((argument) => ['list', 'show', 'pay', 'cancel'].includes(argument))
  if (command === undefined) {
    console.error('用法：payment <list|show|pay|cancel> [订单号] [--status <状态>] [--account <账号>] [--limit <n>] [--transaction <流水号>] [--amount-fen <分>] [--db <路径>]')
    process.exit(1)
  }
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const positional = argv.filter((argument) => !argument.startsWith('--'))
  const orderId = positional[positional.indexOf(command) + 1]
  const amountFen = value('--amount-fen')
  return {
    command: command as Arguments['command'],
    orderId: orderId?.startsWith('MR') === true ? orderId : undefined,
    account: value('--account'),
    status: value('--status'),
    limit: Number(value('--limit') ?? '20'),
    transactionId: value('--transaction'),
    amountFen: amountFen === undefined ? undefined : Number(amountFen),
    dbPath: value('--db') ?? process.env.DB_PATH ?? 'data/mareo.db',
  }
}

function money(micro: number): string {
  return `¥${(micro / 1_000_000).toFixed(2)}`
}

function resolveAccount(db: GatewayDatabase, needle: string): string | undefined {
  const row = db
    .prepare('SELECT id, displayName FROM users WHERE id = ? OR id LIKE ? OR displayName = ? ORDER BY createdAt LIMIT 1')
    .get(needle, `${needle}%`, needle) as { id: string } | undefined
  return row?.id
}

function printOrder(row: PaymentOrderRow | undefined): void {
  if (row === undefined) return
  console.log(`  ${row.orderId}  ${row.status.padEnd(9)} ${row.provider.padEnd(6)} ${money(row.amountMicro).padStart(9)}  ${row.createdAt}`)
  console.log(`    用户 ${row.userId}  流水号 ${row.transactionId ?? '—'}  支付时间 ${row.paidAt ?? '—'}`)
}

function main(): void {
  const args = parseArguments(process.argv.slice(2))
  const db = openDatabase(args.dbPath)
  try {
    if (args.command === 'list') {
      const conditions: string[] = []
      const params: (string | number)[] = []
      if (args.status !== undefined) {
        conditions.push('status = ?')
        params.push(args.status)
      }
      if (args.account !== undefined) {
        const accountId = resolveAccount(db, args.account)
        if (accountId === undefined) throw new Error(`找不到账号 ${args.account}`)
        conditions.push('userId = ?')
        params.push(accountId)
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const rows = db
        .prepare(`SELECT * FROM payment_orders ${where} ORDER BY createdAt DESC LIMIT ?`)
        .all(...params, Math.min(Math.max(args.limit, 1), 200)) as unknown as PaymentOrderRow[]
      console.log(`充值订单（${rows.length} 条）：`)
      for (const row of rows) printOrder(row)
      return
    }

    if (args.orderId === undefined) throw new Error(`${args.command} 需要订单号`)
    const order = paymentOrder(db, args.orderId)
    if (order === undefined) throw new Error(`找不到订单 ${args.orderId}`)

    if (args.command === 'show') {
      printOrder(order)
      if (order.codeUrl !== null) console.log(`    二维码内容 ${order.codeUrl}`)
      return
    }

    if (args.command === 'cancel') {
      const changed = db
        .prepare("UPDATE payment_orders SET status = 'cancelled', updatedAt = ? WHERE orderId = ? AND status = 'pending'")
        .run(new Date().toISOString(), args.orderId).changes
      console.log(changed === 0 ? '订单不是待支付状态，未改动。' : `订单 ${args.orderId} 已置为 cancelled。`)
      return
    }

    // `pay` is the manual fix for a payment the platform confirmed but whose
    // notification never reached us. It is the same door as a callback.
    const amountFen = args.amountFen ?? order.amountFen
    const transactionId = args.transactionId ?? `manual-${Date.now()}`
    const result = confirmPayment(db, args.orderId, { transactionId, amountFen })
    if (!result.ok) {
      console.error(`入账失败：${result.error}`)
      process.exitCode = 1
      return
    }
    console.log(
      result.duplicated
        ? `订单 ${args.orderId} 已经是 paid，未重复入账（当前余额见 credit-cli balance）。`
        : `订单 ${args.orderId} 已手工入账 ${money(order.amountMicro)}，流水号 ${transactionId}。`,
    )
  } finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main()
}

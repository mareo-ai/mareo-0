import { openDatabase } from './db.js'
import { expirePendingOrders, paymentEnvFromProcess, paymentsEnabled } from './payment/orders.js'
import { createGatewayServer } from './server.js'

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

/** A proxy address is worth logging; its credentials never are. */
function maskProxy(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl)
    // Rebuilt rather than mutated: a credential can sit in either the user or the
    // password position depending on how the operator wrote the URL.
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`
  } catch {
    return '(无法解析的代理地址)'
  }
}

const port = envNumber('PORT', 3000)
const host = process.env.HOST ?? '127.0.0.1'
const dbPath = process.env.DB_PATH ?? 'data/mareo.db'
const upstreamBaseUrl = process.env.UPSTREAM_BASE_URL ?? 'https://api.deepseek.com'
const apiKey = process.env.DEEPSEEK_API_KEY ?? ''
// The cap is a runaway guard, not a product quota: it should be far above any
// real day of use, and DAILY_WARN_LIMIT is what actually tells us to look.
const dailyLimit = envNumber('DAILY_LIMIT', 2000)
const dailyWarnLimit = envNumber('DAILY_WARN_LIMIT', 500)

if (apiKey === '') {
  console.error('DEEPSEEK_API_KEY is not set. Copy .env.example to .env and fill in your DeepSeek key.')
  process.exit(1)
}

const db = openDatabase(dbPath)
const payments = paymentEnvFromProcess()
// The OpenAI upstream is optional: without a key the gateway still runs, and the
// /openai/ paths answer 503 instead of pretending to work.
const openaiKey = process.env.OPENAI_API_KEY ?? ''
const openaiUpstream = openaiKey === ''
  ? undefined
  : {
      upstreamBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: openaiKey,
      stripPrefix: '/openai',
      // Some networks cannot reach the vendor directly; an egress proxy keeps the
      // domestic upstream direct and only detours this one.
      ...(process.env.OPENAI_PROXY_URL === undefined || process.env.OPENAI_PROXY_URL === ''
        ? {}
        : { proxyUrl: process.env.OPENAI_PROXY_URL }),
    }

const server = createGatewayServer({ db, upstreamBaseUrl, apiKey, dailyLimit, dailyWarnLimit,
  openaiUpstream,
  payments,
  sponsoredAdFile: process.env.SPONSORED_AD_FILE ?? 'data/sponsored-ad.json' })

// Unpaid QR codes stop being payable. The platform still tells us when one of
// them is paid anyway, and `confirmPayment` honours that, so this only tidies up
// the state the client reads.
if (payments.mode !== 'off') {
  const expire = (): void => {
    try {
      expirePendingOrders(db)
    } catch (error) {
      console.error(`[payment] 过期订单处理失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  expire()
  setInterval(expire, 5 * 60 * 1000).unref()
}

server.listen(port, host, () => {
  console.log(`Mareo gateway listening on http://${host}:${port}`)
  console.log(`Proxying to ${upstreamBaseUrl} with daily limit ${dailyLimit} requests per user (warn at ${dailyWarnLimit})`)
  console.log(openaiUpstream === undefined
    ? 'OpenAI upstream: not configured (OPENAI_API_KEY is empty)'
    : `OpenAI upstream: ${openaiUpstream.upstreamBaseUrl} at /openai/` +
      (openaiUpstream.proxyUrl === undefined ? '' : `, via ${maskProxy(openaiUpstream.proxyUrl)}`))
  console.log(`Recharge: mode=${payments.mode}, 用户可见=${paymentsEnabled(payments)}`)
})

function shutdown(): void {
  server.close(() => {
    db.close()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

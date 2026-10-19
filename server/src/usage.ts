import type { GatewayDatabase } from './db.js'
import type { TokenUsage } from './pricing.js'

/**
 * What a model request was for. `usage.requestKind` holds these values, and the
 * cost report splits on them.
 */
export type RequestKind = 'chat' | 'title' | 'search'

/** What one request cost us and what the user was charged, both in micro-yuan. */
export interface UsageBilling {
  actualMicro: number
  billableMicro: number
  marginMicro: number
  /** The part of `billableMicro` that today's free allowance covered. */
  paidFromFreeMicro: number
}

export interface UsageRecord {
  userId: string
  model: string | null
  promptChars: number
  completionChars: number
  status: number
  latencyMs: number
  /** Tokens exactly as the provider reported them; absent when it reported none. */
  tokens?: TokenUsage
  /** The harness session the request belongs to, when the client sent one. */
  sessionId?: string | null
  /** 'provider' when the usage block was captured, 'missing' when it was not. */
  usageSource?: 'provider' | 'missing'
  /** 'title' for the session-title call, 'search' for web search, 'chat' otherwise. */
  requestKind?: RequestKind
  /** Which upstream served the request; absent for rows written before it was recorded. */
  provider?: string
  /** The USD→CNY rate used to price this request, for rows billed in dollars. */
  fxRate?: number
  /** Absent when the model has no known price: an unpriced request is not billed. */
  billing?: UsageBilling
}

/** Writes the row and returns its id, which a wallet debit points back at. */
export function recordUsage(db: GatewayDatabase, record: UsageRecord): number {
  const tokens = record.tokens
  const billing = record.billing
  const result = db.prepare(
    `INSERT INTO usage (
       userId, ts, model, promptChars, completionChars, status, latencyMs,
       inputTokens, cacheHitTokens, cacheMissTokens, outputTokens, reasoningTokens,
       sessionId, usageSource, requestKind, provider, fxRate,
       actualMicro, billableMicro, marginMicro, paidFromFreeMicro
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.userId,
    new Date().toISOString(),
    record.model,
    record.promptChars,
    record.completionChars,
    record.status,
    record.latencyMs,
    tokens?.inputTokens ?? null,
    tokens?.cacheHitTokens ?? null,
    tokens?.cacheMissTokens ?? null,
    tokens?.outputTokens ?? null,
    tokens?.reasoningTokens ?? null,
    record.sessionId ?? null,
    record.usageSource ?? (tokens === undefined ? null : 'provider'),
    record.requestKind ?? 'chat',
    record.provider ?? null,
    record.fxRate ?? null,
    billing?.actualMicro ?? null,
    billing?.billableMicro ?? null,
    billing?.marginMicro ?? null,
    billing?.paidFromFreeMicro ?? null,
  )
  return Number(result.lastInsertRowid)
}

export function countRequestsSince(db: GatewayDatabase, userId: string, sinceIso: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM usage WHERE userId = ? AND ts >= ?')
    .get(userId, sinceIso) as { n: number }
  return row.n
}

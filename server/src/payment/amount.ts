/**
 * Recharge amounts, in the two units money moves in: the wallet counts
 * micro-yuan, the payment platforms count fen. The conversion lives here and
 * nowhere else, and it is integer arithmetic — 1 yuan is 1e6 micro, 1 fen is
 * 1e4 micro, so every tier is a whole number of fen by construction.
 *
 * The client picks a tier id, never an amount: what a top-up costs is decided
 * here, so a modified client cannot ask to be credited more than it paid for.
 */
import { CHINA_OFFSET_MS } from '../clock.js'

export const MICRO_PER_FEN = 10_000

/** What a user may top up. Adding one is a product decision, not a free input. */
export const RECHARGE_TIERS = {
  t10: 10_000_000,
  t30: 30_000_000,
  t100: 100_000_000,
} as const

export type RechargeTier = keyof typeof RECHARGE_TIERS

export function tierAmountMicro(tier: unknown): number | undefined {
  return typeof tier === 'string' && Object.hasOwn(RECHARGE_TIERS, tier)
    ? RECHARGE_TIERS[tier as RechargeTier]
    : undefined
}

/** The amount as the platform wants it: fen, as a whole number. */
export function microToFen(micro: number): number {
  return micro / MICRO_PER_FEN
}

export function fenToMicro(fen: number): number {
  return fen * MICRO_PER_FEN
}

/** The amount as the platform wants it: yuan with two decimals, as a string. */
export function microToYuan(micro: number): string {
  return (micro / 1_000_000).toFixed(2)
}

/** Risk ceilings. The client cannot raise them; the server owns them. */
export const MAX_ORDER_MICRO = 500_000_000
export const MAX_DAY_MICRO = 2_000_000_000
export const MAX_PENDING_ORDERS = 3
export const ORDER_TTL_MS = 2 * 60 * 60 * 1000

/** `MR` + Beijing timestamp + six random characters: 22 characters, alphanumeric. */
export function newOrderId(now = new Date()): string {
  const local = new Date(now.getTime() + CHINA_OFFSET_MS)
  const stamp =
    String(local.getUTCFullYear()) +
    String(local.getUTCMonth() + 1).padStart(2, '0') +
    String(local.getUTCDate()).padStart(2, '0') +
    String(local.getUTCHours()).padStart(2, '0') +
    String(local.getUTCMinutes()).padStart(2, '0') +
    String(local.getUTCSeconds()).padStart(2, '0')
  const random = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '0')
  return `MR${stamp}${random}`
}

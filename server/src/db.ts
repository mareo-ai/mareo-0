import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type GatewayDatabase = DatabaseSync

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  displayName TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS identities (
  accountId TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  subject TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_identities_account ON identities(accountId);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES users(id),
  tokenHash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  revokedAt TEXT
);

-- promptChars/completionChars are BYTE counts of the request/response bodies.
-- They are for trend and abuse detection only: a streaming response carries one
-- JSON frame per token, so response bytes overstate tokens by roughly 300x and
-- must never be used to price anything. Money comes from the token columns,
-- which are copied verbatim from the usage block the provider returns.
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId TEXT NOT NULL REFERENCES users(id),
  ts TEXT NOT NULL,
  model TEXT,
  promptChars INTEGER NOT NULL,
  completionChars INTEGER NOT NULL,
  status INTEGER NOT NULL,
  latencyMs INTEGER NOT NULL,
  requestKind TEXT,
  inputTokens INTEGER,
  cacheHitTokens INTEGER,
  cacheMissTokens INTEGER,
  outputTokens INTEGER,
  reasoningTokens INTEGER,
  sessionId TEXT,
  usageSource TEXT,
  actualMicro INTEGER,
  billableMicro INTEGER,
  marginMicro INTEGER,
  paidFromFreeMicro INTEGER
);

CREATE TABLE IF NOT EXISTS auth_codes (
  channel TEXT NOT NULL,
  target TEXT NOT NULL,
  codeHash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expiresAt TEXT NOT NULL,
  sentAt TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel, target)
);

CREATE TABLE IF NOT EXISTS auth_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  target TEXT NOT NULL,
  sentAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tokens_tokenHash ON tokens(tokenHash);
CREATE INDEX IF NOT EXISTS idx_usage_userId_ts ON usage(userId, ts);

-- Client-reported events (installs, launches, harness exits, sign-in results).
-- Content-free by construction: a name, the client version/platform and a short
-- opaque detail string. Anonymous rows happen when a client cannot sign in yet,
-- which is exactly the failure we want to see.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  accountId TEXT,
  name TEXT NOT NULL,
  version TEXT,
  platform TEXT,
  ts TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_name_ts ON events(name, ts);
CREATE INDEX IF NOT EXISTS idx_events_accountId ON events(accountId);

CREATE TABLE IF NOT EXISTS ad_events (
  eventId TEXT PRIMARY KEY,
  adId TEXT NOT NULL,
  placement TEXT NOT NULL CHECK (placement = 'sidebar-footer'),
  userId TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('impression', 'click')),
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ad_events_ad_time ON ad_events(adId, createdAt);
CREATE INDEX IF NOT EXISTS idx_ad_events_user_time ON ad_events(userId, createdAt);
CREATE INDEX IF NOT EXISTS idx_ad_events_time ON ad_events(createdAt);

-- One row per会话: the title the engine already generates for它, which is the
-- per-session label we report on. The title is derived from the start of the
-- conversation, so it may contain a few words of the user's first message —
-- the privacy notice says so, and no conversation body is stored anywhere.
CREATE TABLE IF NOT EXISTS session_titles (
  accountId TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (accountId, sessionId)
);

-- Website page views. Daily counters only: no IP, no user agent, no cookie and
-- no per-visit row, so this table can never identify a visitor.
CREATE TABLE IF NOT EXISTS site_views (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path)
);

-- Operator-tunable numbers: the daily free quota, reward amounts, switches and
-- the account allowlist. Stored as text because a human edits them through a
-- CLI and because a wrong value must degrade to a default, never crash.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

-- One row per task a user was offered as a way to earn quota. What counts as
-- "completing" it belongs to the provider; the quota ledger only records that
-- a task finished and how much it was worth.
CREATE TABLE IF NOT EXISTS reward_tasks (
  taskId TEXT PRIMARY KEY,
  accountId TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  amountMicro INTEGER NOT NULL,
  minSeconds INTEGER NOT NULL,
  createdAt TEXT NOT NULL,
  completedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_reward_tasks_account_time ON reward_tasks(accountId, createdAt);

-- The wallet ledger: every change to an account's Mareo Wallet, in order. The
-- balance is the last row's balanceAfterMicro, never a separate counter that
-- could drift from the rows. A credit carries the source it came from and the
-- identifier that source knows it by, so a replayed purchase callback or a
-- repeated ad completion cannot credit twice. A debit carries the usage row it
-- paid for. Amounts are always positive; the type column says which way the
-- money moved.
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  amountMicro INTEGER NOT NULL,
  source TEXT NOT NULL,
  balanceAfterMicro INTEGER NOT NULL,
  relatedRequestId INTEGER,
  externalRef TEXT,
  channel TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user ON wallet_ledger(userId, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_ledger_ref ON wallet_ledger(source, externalRef) WHERE externalRef IS NOT NULL;
`

const SCHEMA_VERSION = 9

export function openDatabase(dbPath: string): GatewayDatabase {
  mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true })
  const db = new DatabaseSync(dbPath)
  const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (version.user_version < SCHEMA_VERSION) {
    migrate(db)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  } else {
    db.exec(SCHEMA)
  }
  return db
}

/**
 * Brings a legacy database (v1: `users` carried provider/subject columns) up
 * to v2 (one `users` row per account plus an `identities` table). Account ids
 * are preserved so existing tokens and usage rows keep pointing at the same
 * user; token-issued users become token identities.
 */
function addUsageColumns(db: GatewayDatabase): void {
  const columns = (db.prepare('PRAGMA table_info(usage)').all() as { name: string }[]).map((row) => row.name)
  const additions: [string, string][] = [
    ['inputTokens', 'INTEGER'],
    ['cacheHitTokens', 'INTEGER'],
    ['cacheMissTokens', 'INTEGER'],
    ['outputTokens', 'INTEGER'],
    ['reasoningTokens', 'INTEGER'],
    ['sessionId', 'TEXT'],
    ['usageSource', 'TEXT'],
    ['requestKind', 'TEXT'],
    // v9: what the request really cost and what the user was charged for it.
    // Rows written before this arrived keep NULL, which is how the reports tell
    // "recorded before billing existed" apart from "recorded and free".
    ['actualMicro', 'INTEGER'],
    ['billableMicro', 'INTEGER'],
    ['marginMicro', 'INTEGER'],
    ['paidFromFreeMicro', 'INTEGER'],
  ]
  for (const [name, type] of additions) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE usage ADD COLUMN ${name} ${type}`)
  }
}

function migrate(db: GatewayDatabase): void {
  const users = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get()
  const fresh = users === undefined
  if (fresh) {
    db.exec(SCHEMA)
    return
  }
  const columns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[]
  const legacy = columns.some((column) => column.name === 'provider')
  if (!legacy) {
    db.exec(SCHEMA)
    addUsageColumns(db)
    // v9: rewards credit the wallet now, and the per-account daily allowance
    // override is gone — a special account gets wallet credit instead.
    db.exec('DROP TABLE IF EXISTS reward_grants')
    db.prepare("DELETE FROM settings WHERE key = 'quota.accountAllowances'").run()
    return
  }

  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('BEGIN')
  try {
    // Renaming `users` makes the child tables' foreign keys follow the new
    // name, so tokens/usage are rebuilt around the fresh accounts schema too.
    db.exec('ALTER TABLE tokens RENAME TO tokens_legacy')
    db.exec('ALTER TABLE usage RENAME TO usage_legacy')
    db.exec('ALTER TABLE users RENAME TO users_legacy')
    db.exec(SCHEMA)

    const legacyUsers = db
      .prepare('SELECT id, displayName, provider, subject, createdAt FROM users_legacy')
      .all() as { id: string; displayName: string; provider: string; subject: string | null; createdAt: string }[]
    const insertUser = db.prepare('INSERT INTO users (id, displayName, createdAt) VALUES (?, ?, ?)')
    const insertIdentity = db.prepare('INSERT INTO identities (accountId, provider, subject) VALUES (?, ?, ?)')
    for (const row of legacyUsers) {
      insertUser.run(row.id, row.displayName, row.createdAt)
      insertIdentity.run(row.id, row.provider, row.subject)
    }

    const legacyTokens = db
      .prepare('SELECT id, userId, tokenHash, label, createdAt, revokedAt FROM tokens_legacy')
      .all() as {
      id: string
      userId: string
      tokenHash: string
      label: string
      createdAt: string
      revokedAt: string | null
    }[]
    const insertToken = db.prepare(
      'INSERT INTO tokens (id, userId, tokenHash, label, createdAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const row of legacyTokens) {
      insertToken.run(row.id, row.userId, row.tokenHash, row.label, row.createdAt, row.revokedAt)
    }

    const legacyUsage = db
      .prepare(
        'SELECT userId, ts, model, promptChars, completionChars, status, latencyMs FROM usage_legacy',
      )
      .all() as {
      userId: string
      ts: string
      model: string | null
      promptChars: number
      completionChars: number
      status: number
      latencyMs: number
    }[]
    const insertUsage = db.prepare(
      `INSERT INTO usage (userId, ts, model, promptChars, completionChars, status, latencyMs)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const row of legacyUsage) {
      insertUsage.run(row.userId, row.ts, row.model, row.promptChars, row.completionChars, row.status, row.latencyMs)
    }

    db.exec('DROP TABLE users_legacy')
    db.exec('DROP TABLE tokens_legacy')
    db.exec('DROP TABLE usage_legacy')
    db.exec('COMMIT')
    db.exec('PRAGMA foreign_keys = ON')
  } catch (error) {
    db.exec('ROLLBACK')
    db.exec('PRAGMA foreign_keys = ON')
    throw error
  }
}

export interface Account {
  id: string
  displayName: string
  createdAt: string
}

export function createAccount(db: GatewayDatabase, displayName: string): string {
  const id = randomUUID()
  db.prepare('INSERT INTO users (id, displayName) VALUES (?, ?)').run(id, displayName)
  return id
}

export function addIdentity(db: GatewayDatabase, accountId: string, provider: string, subject: string | null): void {
  db.prepare('INSERT INTO identities (accountId, provider, subject) VALUES (?, ?, ?)').run(accountId, provider, subject)
}

/** Creates an account carrying a legacy token identity (admin-issued tokens). */
export function createTokenAccount(db: GatewayDatabase, displayName: string): string {
  const accountId = createAccount(db, displayName)
  addIdentity(db, accountId, 'token', null)
  return accountId
}

export function findAccountByIdentity(
  db: GatewayDatabase,
  provider: string,
  subject: string | null,
): Account | undefined {
  const row = db
    .prepare(
      `SELECT u.id AS id, u.displayName AS displayName, u.createdAt AS createdAt
       FROM identities i JOIN users u ON u.id = i.accountId
       WHERE i.provider = ? AND i.subject IS ?`,
    )
    .get(provider, subject) as { id: string; displayName: string; createdAt: string } | undefined
  if (row === undefined) return undefined
  return { id: row.id, displayName: row.displayName, createdAt: row.createdAt }
}

/**
 * Returns the account bound to an identity, creating both when they do not
 * exist yet (first login via that provider/subject auto-registers).
 */
export function findOrCreateAccountForIdentity(
  db: GatewayDatabase,
  provider: string,
  subject: string,
  displayNameForNew: string,
): Account {
  const existing = findAccountByIdentity(db, provider, subject)
  if (existing !== undefined) return existing
  const accountId = createAccount(db, displayNameForNew)
  addIdentity(db, accountId, provider, subject)
  const created = findAccountByIdentity(db, provider, subject)
  if (created !== undefined) return created
  throw new Error('Failed to read back the created account identity.')
}

export interface StoredToken {
  userId: string
  label: string
  tokenHash: string
}

export function storeToken(db: GatewayDatabase, token: StoredToken): void {
  db.prepare('INSERT INTO tokens (id, userId, tokenHash, label) VALUES (?, ?, ?, ?)').run(
    randomUUID(),
    token.userId,
    token.tokenHash,
    token.label,
  )
}

export interface TokenOwner {
  userId: string
  displayName: string
}

export function findTokenOwner(db: GatewayDatabase, tokenHash: string): TokenOwner | undefined {
  const row = db
    .prepare(
      `SELECT t.userId AS userId, u.displayName AS displayName
       FROM tokens t JOIN users u ON u.id = t.userId
       WHERE t.tokenHash = ? AND t.revokedAt IS NULL`,
    )
    .get(tokenHash) as { userId: string; displayName: string } | undefined
  if (row === undefined) return undefined
  return { userId: row.userId, displayName: row.displayName }
}

export function renameAccount(db: GatewayDatabase, accountId: string, displayName: string): void {
  db.prepare('UPDATE users SET displayName = ? WHERE id = ?').run(displayName, accountId)
}

/** Primary email of an account, if one is bound (provider 'email'). */
export function findAccountEmail(db: GatewayDatabase, accountId: string): string | undefined {
  const row = db
    .prepare("SELECT subject AS subject FROM identities WHERE accountId = ? AND provider = 'email' LIMIT 1")
    .get(accountId) as { subject: string | null } | undefined
  return typeof row?.subject === 'string' ? row.subject : undefined
}

/** Revokes one bearer token (e.g. "sign out on this device"). */
export function revokeToken(db: GatewayDatabase, tokenHash: string): boolean {
  const result = db
    .prepare('UPDATE tokens SET revokedAt = ? WHERE tokenHash = ? AND revokedAt IS NULL')
    .run(new Date().toISOString(), tokenHash)
  return result.changes > 0
}

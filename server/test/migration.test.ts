import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { findTokenOwner, openDatabase, storeToken, type GatewayDatabase } from '../src/db.js'
import { hashToken } from '../src/auth.js'

let directory: string
let dbPath: string
let db: GatewayDatabase

test.before(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'mareo-migrate-'))
  dbPath = path.join(directory, 'legacy.db')
})

test.after(() => {
  db?.close()
  rmSync(directory, { recursive: true, force: true })
})

test('migrates a legacy v1 database into accounts + identities', () => {
  // Build a legacy v1 file exactly as the first gateway release created it.
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, displayName TEXT NOT NULL, provider TEXT NOT NULL,
      subject TEXT, createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE tokens (
      id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id),
      tokenHash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      revokedAt TEXT
    );
    CREATE TABLE usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT NOT NULL REFERENCES users(id),
      ts TEXT NOT NULL, model TEXT, promptChars INTEGER NOT NULL, completionChars INTEGER NOT NULL,
      status INTEGER NOT NULL, latencyMs INTEGER NOT NULL
    );
  `)
  legacy
    .prepare("INSERT INTO users (id, displayName, provider, subject) VALUES ('acct-1', 'Zhe', 'token', NULL)")
    .run()
  legacy
    .prepare("INSERT INTO users (id, displayName, provider, subject) VALUES ('acct-2', 'Ada', 'token', 'subject-x')")
    .run()
  const secret = 'migrate-secret'
  legacy
    .prepare("INSERT INTO tokens (id, userId, tokenHash, label) VALUES ('tok-1', 'acct-1', ?, 'Zhe token')")
    .run(hashToken(secret))
  legacy.close()

  db = openDatabase(dbPath)

  const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
  assert.equal(version.user_version, 12)
  const identities = (db.prepare('SELECT provider, subject FROM identities ORDER BY accountId').all() as {
    provider: string
    subject: string | null
  }[]).map((row) => ({ provider: row.provider, subject: row.subject }))
  assert.deepEqual(identities, [
    { provider: 'token', subject: null },
    { provider: 'token', subject: 'subject-x' },
  ])
  // The legacy token still resolves to the migrated account.
  assert.deepEqual(findTokenOwner(db, hashToken(secret)), { userId: 'acct-1', displayName: 'Zhe' })
  // And the new schema can hold email identities next to them.
  storeToken(db, { userId: 'acct-2', label: 'new', tokenHash: hashToken('another') })
  assert.deepEqual(findTokenOwner(db, hashToken('another')), { userId: 'acct-2', displayName: 'Ada' })
})

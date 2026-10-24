import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createTokenAccount, findTokenOwner, openDatabase, storeToken, type GatewayDatabase } from '../src/db.js'
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

for (const interrupted of [false, true]) {
  test(`upgrades v11 ${interrupted ? 'after an interrupted invite migration' : 'before invites'} and preserves existing records`, () => {
    const upgradePath = path.join(directory, `v11-${interrupted}.db`)
    let upgraded = openDatabase(upgradePath)
    try {
      const accountId = createTokenAccount(upgraded, 'Migration test')
      storeToken(upgraded, { userId: accountId, label: 'existing', tokenHash: hashToken('v11-secret') })
      upgraded.prepare(`INSERT INTO usage (userId, ts, model, promptChars, completionChars, status, latencyMs,
        actualMicro, billableMicro, marginMicro, paidFromFreeMicro) VALUES (?, '2026-10-23T00:00:00Z', 'deepseek-flash', 10, 20, 200, 5, 100, 130, 30, 130)`).run(accountId)
      upgraded.prepare(`INSERT INTO wallet_ledger (userId, type, amountMicro, source, balanceAfterMicro, externalRef, createdAt)
        VALUES (?, 'credit', 5000000, 'manual', 5000000, 'migration-test', '2026-10-23T00:00:00Z')`).run(accountId)
      const usageBefore = upgraded.prepare('SELECT * FROM usage').all()
      const ledgerBefore = upgraded.prepare('SELECT * FROM wallet_ledger').all()
      // A failed v12 startup already created invites, but never added the user column.
      upgraded.exec('DROP INDEX idx_users_inviteCode; ALTER TABLE users DROP COLUMN inviteCode; PRAGMA user_version = 11')
      if (!interrupted) upgraded.exec('DROP TABLE invites')
      upgraded.close()

      upgraded = openDatabase(upgradePath)
      assert.equal(upgraded.prepare('PRAGMA user_version').get()?.user_version, 12)
      assert.equal(upgraded.prepare('SELECT inviteCode FROM users WHERE id = ?').get(accountId)?.inviteCode, null)
      assert.deepEqual(findTokenOwner(upgraded, hashToken('v11-secret')), { userId: accountId, displayName: 'Migration test' })
      assert.deepEqual(upgraded.prepare('SELECT * FROM usage').all(), usageBefore)
      assert.deepEqual(upgraded.prepare('SELECT * FROM wallet_ledger').all(), ledgerBefore)
      upgraded.prepare('UPDATE users SET inviteCode = ? WHERE id = ?').run('ABCDEFGH', accountId)
      const secondId = createTokenAccount(upgraded, 'Second account')
      assert.throws(() => upgraded.prepare('UPDATE users SET inviteCode = ? WHERE id = ?').run('ABCDEFGH', secondId), /UNIQUE constraint/)
      assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM invites').get()?.n, 0)
      upgraded.close()

      upgraded = openDatabase(upgradePath)
      assert.equal(upgraded.prepare('SELECT inviteCode FROM users WHERE id = ?').get(accountId)?.inviteCode, 'ABCDEFGH')
      assert.deepEqual(upgraded.prepare('SELECT * FROM wallet_ledger').all(), ledgerBefore)
    } finally {
      if (upgraded.isOpen) upgraded.close()
    }
  })
}

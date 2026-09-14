import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import Database from 'better-sqlite3'
import { inspectDatabase } from '../scripts/schema-preflight.mjs'

const contract = JSON.parse(
  await readFile(new URL('../backend/contracts/schema.json', import.meta.url)),
)

const indexColumns = {
  idx_namespace_key: ['settings', 'namespace', 'key'],
  idx_photos_owner_content_hash: ['photos', 'owner_user_id', 'content_hash'],
  idx_pipeline_queue_claim_expires: [
    'pipeline_queue',
    'status',
    'claim_expires_at',
  ],
  idx_pipeline_queue_ready: [
    'pipeline_queue',
    'status',
    'available_at',
    'priority',
    'created_at',
  ],
  idx_upload_shares_token_hash: ['upload_shares', 'token_hash'],
}

const securityTrigger = `
  CREATE TRIGGER users_security_fields_bump_auth_version
  AFTER UPDATE OF password, is_admin, is_active ON users
  FOR EACH ROW
  WHEN NEW.auth_version = OLD.auth_version
    AND (
      NEW.password IS NOT OLD.password
      OR NEW.is_admin IS NOT OLD.is_admin
      OR NEW.is_active IS NOT OLD.is_active
    )
  BEGIN
    UPDATE users
    SET auth_version = OLD.auth_version + 1
    WHERE id = OLD.id;
  END
`

function quote(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`
}

function fixture({
  omitTable,
  omitColumn,
  omitIndex,
  omitTrigger,
  wrongTrigger = false,
  forgedLedger = false,
} = {}) {
  const database = new Database(':memory:')
  for (const [table, columns] of Object.entries(contract.requiredTables)) {
    if (table === omitTable) continue
    const definitions = columns
      .filter((column) => `${table}.${column}` !== omitColumn)
      .map(
        (column) =>
          `${quote(column)} ${column === 'created_at' ? 'INTEGER' : 'TEXT'}`,
      )
    database.exec(`CREATE TABLE ${quote(table)} (${definitions.join(', ')})`)
  }

  for (const index of contract.requiredIndexes) {
    if (index === omitIndex) continue
    const [table, ...columns] = indexColumns[index]
    if (table === omitTable) continue
    database.exec(
      `CREATE INDEX ${quote(index)} ON ${quote(table)} (${columns.map(quote).join(', ')})`,
    )
  }

  if (!omitTrigger) {
    database.exec(
      wrongTrigger
        ? securityTrigger.replace(
            'SET auth_version = OLD.auth_version + 1',
            'SET auth_version = OLD.auth_version + 2',
          )
        : securityTrigger,
    )
  }

  if (omitTable !== '__drizzle_migrations') {
    const insert = database.prepare(
      'INSERT INTO __drizzle_migrations (created_at, hash) VALUES (?, ?)',
    )
    const transaction = database.transaction(() => {
      for (const [index, migration] of contract.migrations.entries()) {
        insert.run(
          migration.createdAt,
          forgedLedger && index === 0 ? 'forged' : migration.hash,
        )
      }
    })
    transaction()
  }
  return database
}

test('schema preflight accepts the exact migration and physical schema contract', () => {
  const database = fixture()
  try {
    const result = inspectDatabase(database, contract)
    assert.equal(result.compatible, true)
    assert.deepEqual(result.missing, [])
    assert.equal(result.ledgerMatches, true)
  } finally {
    database.close()
  }
})

for (const scenario of [
  {
    name: 'missing required table',
    options: { omitTable: 'photo_reactions' },
    expected: 'table:photo_reactions',
  },
  {
    name: 'missing required column',
    options: { omitColumn: 'users.auth_version' },
    expected: 'column:users.auth_version',
  },
  {
    name: 'missing required index',
    options: { omitIndex: 'idx_namespace_key' },
    expected: 'index:idx_namespace_key',
  },
  {
    name: 'missing required trigger',
    options: { omitTrigger: true },
    expected: 'trigger:users_security_fields_bump_auth_version',
  },
  {
    name: 'wrong required trigger definition',
    options: { wrongTrigger: true },
    expected: 'trigger-definition:users_security_fields_bump_auth_version',
  },
]) {
  test(`schema preflight rejects ${scenario.name}`, () => {
    const database = fixture(scenario.options)
    try {
      const result = inspectDatabase(database, contract)
      assert.equal(result.compatible, false)
      assert.ok(result.missing.includes(scenario.expected))
    } finally {
      database.close()
    }
  })
}

test('schema preflight rejects a forged migration ledger', () => {
  const database = fixture({ forgedLedger: true })
  try {
    const result = inspectDatabase(database, contract)
    assert.equal(result.compatible, false)
    assert.equal(result.ledgerMatches, false)
    assert.deepEqual(result.missing, [])
  } finally {
    database.close()
  }
})

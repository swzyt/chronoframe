import { createHash } from 'node:crypto'

export function canonicalSchemaSQL(value) {
  return value.toLowerCase().replaceAll(/[`";\s]/g, '')
}

function requiredSchema(contract) {
  const tables = contract.requiredTables
  const indexes = contract.requiredIndexes
  const triggers = contract.requiredTriggers
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) {
    throw new Error('schema contract requiredTables must be an object')
  }
  if (!Array.isArray(indexes)) {
    throw new Error('schema contract requiredIndexes must be an array')
  }
  if (!triggers || typeof triggers !== 'object' || Array.isArray(triggers)) {
    throw new Error('schema contract requiredTriggers must be an object')
  }
  return { tables, indexes, triggers }
}

export function inspectDatabase(database, contract) {
  const { tables, indexes, triggers } = requiredSchema(contract)
  database.pragma('busy_timeout = 5000')
  database.pragma('foreign_keys = ON')

  const quickCheck = database.pragma('quick_check', { simple: true })
  const foreignKeyViolations = database.pragma('foreign_key_check')
  const missing = []

  for (const tableName of Object.keys(tables).sort()) {
    const table = database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(tableName)
    if (!table.count) {
      missing.push(`table:${tableName}`)
      continue
    }

    for (const columnName of tables[tableName]) {
      const column = database
        .prepare(
          'SELECT count(*) AS count FROM pragma_table_info(?) WHERE name = ?',
        )
        .get(tableName, columnName)
      if (!column.count) missing.push(`column:${tableName}.${columnName}`)
    }
  }

  for (const indexName of [...indexes].sort()) {
    const index = database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get(indexName)
    if (!index.count) missing.push(`index:${indexName}`)
  }

  for (const [triggerName, expectedHash] of Object.entries(triggers).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const trigger = database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      )
      .get(triggerName)
    if (!trigger) {
      missing.push(`trigger:${triggerName}`)
      continue
    }
    const actualHash = createHash('sha256')
      .update(canonicalSchemaSQL(trigger.sql))
      .digest('hex')
    if (actualHash !== expectedHash) {
      missing.push(`trigger-definition:${triggerName}`)
    }
  }

  const ledgerReadable = !missing.some(
    (item) =>
      item === 'table:__drizzle_migrations' ||
      item === 'column:__drizzle_migrations.created_at' ||
      item === 'column:__drizzle_migrations.hash',
  )
  const actual = ledgerReadable
    ? database
        .prepare(
          'SELECT CAST(created_at AS INTEGER) AS createdAt, hash FROM __drizzle_migrations ORDER BY CAST(created_at AS INTEGER), hash',
        )
        .all()
    : []
  const expected = contract.migrations.map(({ createdAt, hash }) => ({
    createdAt,
    hash,
  }))
  const ledgerMatches =
    ledgerReadable && JSON.stringify(actual) === JSON.stringify(expected)

  return {
    compatible:
      quickCheck === 'ok' &&
      foreignKeyViolations.length === 0 &&
      ledgerMatches &&
      missing.length === 0,
    quickCheck,
    foreignKeyViolationCount: foreignKeyViolations.length,
    migrationCount: actual.length,
    expectedMigrationCount: expected.length,
    latestMigrationMillis: actual.at(-1)?.createdAt || 0,
    expectedLatestMigrationMillis: expected.at(-1)?.createdAt || 0,
    ledgerMatches,
    missing,
  }
}

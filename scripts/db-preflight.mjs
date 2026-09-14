import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { inspectDatabase } from './schema-preflight.mjs'

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function databasePath(value) {
  if (!value)
    throw new Error(
      'Usage: node scripts/db-preflight.mjs --database <SQLite file>',
    )
  if (value.includes('://') && !value.startsWith('file://')) {
    throw new Error('Only a local SQLite file is supported')
  }
  const raw = value.replace(/^file:/, '').split('?', 1)[0]
  return resolve(decodeURIComponent(raw))
}

const path = databasePath(option('--database'))
const contract = JSON.parse(
  await readFile(new URL('../backend/contracts/schema.json', import.meta.url)),
)
const database = new Database(path, { readonly: true, fileMustExist: true })

try {
  const result = inspectDatabase(database, contract)
  console.log(JSON.stringify(result, null, 2))
  if (!result.compatible) process.exitCode = 2
} finally {
  database.close()
}

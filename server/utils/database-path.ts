import { dirname, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

export function resolveDatabasePath() {
  const value = process.env.DATABASE_URL || './data/app.sqlite3'
  const withoutFilePrefix = value.startsWith('file:')
    ? value.slice('file:'.length)
    : value
  return resolve(withoutFilePrefix)
}

export function ensureDatabaseDirectory(dbPath = resolveDatabasePath()) {
  mkdirSync(dirname(dbPath), { recursive: true })
  return dbPath
}

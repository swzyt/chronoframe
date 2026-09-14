export const SQLITE_BUSY_TIMEOUT_MS = 5_000

type SQLitePragmaTarget = {
  pragma(source: string): unknown
}

export function applySQLiteSafetyPragmas(database: SQLitePragmaTarget): void {
  database.pragma('foreign_keys = ON')
  database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`)
}

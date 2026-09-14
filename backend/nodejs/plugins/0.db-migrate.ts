import { resolve } from 'node:path'

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { ensureDatabaseDirectory } from '#server/utils/database-path'
import { isNodeOwner, runtimeOwnership } from '#server/utils/runtime-ownership'

let migrationPromise: Promise<void> | null = null
const migrationLogger = logger.dynamic('db-migrate')

async function runMigrations() {
  const dbPath = ensureDatabaseDirectory()

  const sqlite = new Database(dbPath)

  try {
    const db = drizzle(sqlite)
    await migrate(db, {
      migrationsFolder: resolve('./backend/nodejs/database/migrations'),
    })
    migrationLogger.info('Database migration finished successfully')
  } finally {
    sqlite.close()
  }
}

export default defineNitroPlugin(async () => {
  const { dbMigrator } = runtimeOwnership
  if (!isNodeOwner(dbMigrator)) {
    migrationLogger.info(
      `Skipping database migrations because CFRAME_DB_MIGRATOR=${dbMigrator}`,
    )
    return
  }

  if (!migrationPromise) {
    migrationPromise = runMigrations().catch((error) => {
      migrationLogger.error('Database migration failed', error)
      throw error
    })
  }

  await migrationPromise
})

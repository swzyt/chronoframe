import { runDatabaseBackup } from '~~/server/services/backup/database-backup'

export default eventHandler(async (event) => {
  await requireAdmin(event)

  try {
    const result = await runDatabaseBackup()
    return {
      success: true,
      result,
    }
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage:
        (error as Error).message || 'Failed to run database backup',
    })
  }
})

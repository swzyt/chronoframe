import cron, { type ScheduledTask } from 'node-cron'

import {
  getDatabaseBackupScheduleSettings,
  runDatabaseBackup,
} from '~~/server/services/backup/database-backup'

const backupLogger = logger.dynamic('db-backup')

let scheduledTask: ScheduledTask | null = null
let scheduleSignature = ''
let isBackupRunning = false

async function executeScheduledBackup() {
  if (isBackupRunning) {
    backupLogger.warn(
      'Skipping database backup because a backup is already running',
    )
    return
  }

  isBackupRunning = true
  try {
    const result = await runDatabaseBackup()
    backupLogger.info(
      `Database backup sent to ${result.sentTo.join(', ')}: ${result.fileName}`,
    )
  } catch (error) {
    backupLogger.error('Scheduled database backup failed:', error)
  } finally {
    isBackupRunning = false
  }
}

async function refreshBackupSchedule() {
  const settings = await getDatabaseBackupScheduleSettings()
  const nextSignature =
    settings.enabled && settings.valid
      ? `${settings.cron}|${settings.timezone}`
      : ''

  if (nextSignature === scheduleSignature) {
    return
  }

  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask.destroy()
    scheduledTask = null
  }
  scheduleSignature = nextSignature

  if (!nextSignature) {
    backupLogger.info('Database backup schedule disabled')
    return
  }

  scheduledTask = cron.schedule(settings.cron, executeScheduledBackup, {
    timezone: settings.timezone,
  })
  backupLogger.info(
    `Database backup scheduled with "${settings.cron}" (${settings.timezone})`,
  )
}

export default defineNitroPlugin(async (nitroApp) => {
  await refreshBackupSchedule().catch((error) => {
    backupLogger.error('Failed to initialize database backup schedule:', error)
  })

  const interval = setInterval(() => {
    refreshBackupSchedule().catch((error) => {
      backupLogger.error('Failed to refresh database backup schedule:', error)
    })
  }, 60_000)

  nitroApp.hooks.hook('close', () => {
    clearInterval(interval)
    if (scheduledTask) {
      scheduledTask.stop()
      scheduledTask.destroy()
      scheduledTask = null
    }
  })
})

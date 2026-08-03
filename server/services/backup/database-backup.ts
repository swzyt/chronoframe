import { createCipheriv, randomBytes, scryptSync } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

import Database from 'better-sqlite3'
import cron from 'node-cron'
import nodemailer from 'nodemailer'

import { settingsManager } from '~~/server/services/settings/settingsManager'

const BACKUP_MAGIC = Buffer.from('CFDBENC1')
const DEFAULT_BACKUP_DIR = 'data/backups'

export interface DatabaseBackupSettings {
  enabled: boolean
  cron: string
  timezone: string
  retentionDays: number
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  smtpUser: string
  smtpPassword: string
  mailFrom: string
  mailTo: string
  encryptionPassphrase: string
}

export interface DatabaseBackupResult {
  fileName: string
  filePath: string
  size: number
  encrypted: boolean
  sentTo: string[]
  createdAt: string
}

function normalizeDatabasePath(rawPath?: string) {
  const value = rawPath || './data/app.sqlite3'
  const withoutFilePrefix = value.startsWith('file:')
    ? value.slice('file:'.length)
    : value
  return resolve(withoutFilePrefix)
}

function parseRecipients(value: string) {
  return value
    .split(/[,\n;]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function assertBackupSettings(settings: DatabaseBackupSettings) {
  if (!settings.smtpHost) {
    throw new Error('SMTP host is required')
  }
  if (
    !settings.smtpPort ||
    settings.smtpPort < 1 ||
    settings.smtpPort > 65535
  ) {
    throw new Error('SMTP port is invalid')
  }
  if (!settings.mailTo) {
    throw new Error('Recipient email is required')
  }
  if (parseRecipients(settings.mailTo).length === 0) {
    throw new Error('Recipient email is invalid')
  }
  if (!settings.mailFrom && !settings.smtpUser) {
    throw new Error('Sender email or SMTP username is required')
  }
  if (!cron.validate(settings.cron)) {
    throw new Error('Backup cron expression is invalid')
  }
}

async function getBackupSettings(): Promise<DatabaseBackupSettings> {
  const [
    enabled,
    cronExpression,
    timezone,
    retentionDays,
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUser,
    smtpPassword,
    mailFrom,
    mailTo,
    encryptionPassphrase,
  ] = await Promise.all([
    settingsManager.get<boolean>('system', 'backup.enabled' as any, false),
    settingsManager.get<string>('system', 'backup.cron' as any, '0 3 * * *'),
    settingsManager.get<string>(
      'system',
      'backup.timezone' as any,
      'Asia/Shanghai',
    ),
    settingsManager.get<number>('system', 'backup.retentionDays' as any, 30),
    settingsManager.get<string>('system', 'backup.smtpHost' as any, ''),
    settingsManager.get<number>('system', 'backup.smtpPort' as any, 465),
    settingsManager.get<boolean>('system', 'backup.smtpSecure' as any, true),
    settingsManager.get<string>('system', 'backup.smtpUser' as any, ''),
    settingsManager.get<string>('system', 'backup.smtpPassword' as any, ''),
    settingsManager.get<string>('system', 'backup.mailFrom' as any, ''),
    settingsManager.get<string>('system', 'backup.mailTo' as any, ''),
    settingsManager.get<string>(
      'system',
      'backup.encryptionPassphrase' as any,
      '',
    ),
  ])

  return {
    enabled: Boolean(enabled),
    cron: cronExpression || '0 3 * * *',
    timezone: timezone || 'Asia/Shanghai',
    retentionDays: Math.max(1, Number(retentionDays || 30)),
    smtpHost: smtpHost || '',
    smtpPort: Number(smtpPort || 465),
    smtpSecure: Boolean(smtpSecure),
    smtpUser: smtpUser || '',
    smtpPassword: smtpPassword || '',
    mailFrom: mailFrom || smtpUser || '',
    mailTo: mailTo || '',
    encryptionPassphrase: encryptionPassphrase || '',
  }
}

async function gzipFile(sourcePath: string, targetPath: string) {
  await pipeline(
    createReadStream(sourcePath),
    createGzip({ level: 9 }),
    createWriteStream(targetPath),
  )
}

async function encryptFile(
  sourcePath: string,
  targetPath: string,
  passphrase: string,
) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(passphrase, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const source = await readFile(sourcePath)
  const encrypted = Buffer.concat([cipher.update(source), cipher.final()])
  const tag = cipher.getAuthTag()

  await writeFile(
    targetPath,
    Buffer.concat([BACKUP_MAGIC, salt, iv, tag, encrypted]),
  )
}

async function cleanupOldBackups(retentionDays: number) {
  const backupDir = resolve(DEFAULT_BACKUP_DIR)
  const entries = await readdir(backupDir).catch(() => [])
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000

  await Promise.all(
    entries
      .filter((entry) => entry.startsWith('chronoframe-db-'))
      .map(async (entry) => {
        const filePath = join(backupDir, entry)
        const fileStat = await stat(filePath).catch(() => null)
        if (fileStat && fileStat.mtime.getTime() < cutoff) {
          await rm(filePath, { force: true })
        }
      }),
  )
}

async function createBackupFile(settings: DatabaseBackupSettings) {
  const dbPath = normalizeDatabasePath(process.env.DATABASE_URL)
  const backupDir = resolve(DEFAULT_BACKUP_DIR)
  const timestamp = new Date()
    .toISOString()
    .replaceAll(':', '')
    .replace(/\.\d{3}Z$/, 'Z')
  const rawBackupPath = join(backupDir, `chronoframe-db-${timestamp}.sqlite3`)
  const gzipPath = `${rawBackupPath}.gz`
  const encryptedPath = `${gzipPath}.enc`

  await mkdir(dirname(rawBackupPath), { recursive: true })

  const sqlite = new Database(dbPath, { fileMustExist: true, readonly: true })
  try {
    await sqlite.backup(rawBackupPath)
  } finally {
    sqlite.close()
  }

  await gzipFile(rawBackupPath, gzipPath)
  await rm(rawBackupPath, { force: true })

  if (settings.encryptionPassphrase) {
    await encryptFile(gzipPath, encryptedPath, settings.encryptionPassphrase)
    await rm(gzipPath, { force: true })
    return { filePath: encryptedPath, encrypted: true }
  }

  return { filePath: gzipPath, encrypted: false }
}

async function sendBackupEmail(
  settings: DatabaseBackupSettings,
  backup: { filePath: string; encrypted: boolean },
) {
  const recipients = parseRecipients(settings.mailTo)
  const transporter = nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpSecure,
    auth: settings.smtpUser
      ? {
          user: settings.smtpUser,
          pass: settings.smtpPassword,
        }
      : undefined,
  })

  const fileName = basename(backup.filePath)
  const encryptionNote = backup.encrypted
    ? '\n\nThis attachment is encrypted with AES-256-GCM. Keep the configured passphrase safe.'
    : ''

  await transporter.sendMail({
    from: settings.mailFrom || settings.smtpUser,
    to: recipients,
    subject: `ChronoFrame database backup ${new Date().toISOString()}`,
    text: `ChronoFrame database backup is attached.${encryptionNote}`,
    attachments: [
      {
        filename: fileName,
        path: backup.filePath,
      },
    ],
  })

  return recipients
}

export async function runDatabaseBackup(): Promise<DatabaseBackupResult> {
  const settings = await getBackupSettings()
  assertBackupSettings(settings)

  const backup = await createBackupFile(settings)
  const sentTo = await sendBackupEmail(settings, backup)
  const fileStat = await stat(backup.filePath)

  await cleanupOldBackups(settings.retentionDays)

  return {
    fileName: basename(backup.filePath),
    filePath: backup.filePath,
    size: fileStat.size,
    encrypted: backup.encrypted,
    sentTo,
    createdAt: new Date().toISOString(),
  }
}

export async function getDatabaseBackupScheduleSettings() {
  const settings = await getBackupSettings()
  return {
    enabled: settings.enabled,
    cron: settings.cron,
    timezone: settings.timezone,
    valid: cron.validate(settings.cron),
  }
}

import assert from 'node:assert/strict'
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto'
import { hostname } from 'node:os'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'

import {
  DEFAULT_BACKUP_COOKIE,
  encryptedBackupEnvelopeToSQLiteBytes,
  extractBackupAttachment,
} from '../scripts/verify-dual-backup.mjs'
import {
  DEFAULT_GO_BACKUP_SCHEDULER_CRON,
  findSMTPMessageOrigin,
  parseGoBackupSchedulerVerifierOptions,
  verifyGoBackupScheduler,
} from '../scripts/verify-go-backup-scheduler.mjs'

const BACKUP_KEYS = [
  'backup.enabled',
  'backup.cron',
  'backup.timezone',
  'backup.retentionDays',
  'backup.smtpHost',
  'backup.smtpPort',
  'backup.smtpSecure',
  'backup.smtpUser',
  'backup.smtpPassword',
  'backup.mailFrom',
  'backup.mailTo',
  'backup.encryptionPassphrase',
]

test('parseGoBackupSchedulerVerifierOptions defaults to fixture session and container backup dir', () => {
  const options = parseGoBackupSchedulerVerifierOptions([], {
    CFRAME_DUAL_PORT: '33120',
    DATABASE_URL: '/app/data/app.sqlite3',
  })

  assert.equal(options.base, 'http://127.0.0.1:33120')
  assert.equal(options.cookie, DEFAULT_BACKUP_COOKIE)
  assert.equal(options.smtpHost, 'host.docker.internal')
  assert.equal(options.smtpBind, '0.0.0.0')
  assert.equal(options.smtpPort, 0)
  assert.equal(options.backupDir, '/app/data/backups')
  assert.equal(options.cron, DEFAULT_GO_BACKUP_SCHEDULER_CRON)
  assert.equal(options.keepFiles, false)
  assert.equal(options.requireGoOrigin, false)
  assert.equal(options.goHost, 'go')
  assert.equal(options.nodeHost, 'node')
})

test('parseGoBackupSchedulerVerifierOptions accepts explicit origin verification values', () => {
  const options = parseGoBackupSchedulerVerifierOptions(
    [
      '--base',
      'http://gateway/',
      '--cookie',
      'cf_session=test',
      '--timeout-ms',
      '30000',
      '--prefix',
      'scheduler-test',
      '--smtp-host',
      'self',
      '--smtp-bind',
      '0.0.0.0',
      '--smtp-port',
      '2525',
      '--backup-dir',
      '/app/data/backups',
      '--cron',
      '*/10 * * * * *',
      '--go-host',
      'go-api',
      '--node-host',
      'node-api',
      '--require-go-origin',
      '--keep-files',
    ],
    {},
  )

  assert.equal(options.base, 'http://gateway')
  assert.equal(options.cookie, 'cf_session=test')
  assert.equal(options.timeoutMs, 30_000)
  assert.equal(options.prefix, 'scheduler-test')
  assert.equal(options.smtpHost, hostname())
  assert.equal(options.smtpBind, '0.0.0.0')
  assert.equal(options.smtpPort, 2525)
  assert.equal(options.backupDir, '/app/data/backups')
  assert.equal(options.cron, '*/10 * * * * *')
  assert.equal(options.goHost, 'go-api')
  assert.equal(options.nodeHost, 'node-api')
  assert.equal(options.requireGoOrigin, true)
  assert.equal(options.keepFiles, true)
})

test('findSMTPMessageOrigin maps queued mail back to the sending connection', () => {
  const origin = findSMTPMessageOrigin(
    [
      {
        id: 1,
        direction: 'connection',
        remoteAddress: '::ffff:192.168.1.10',
      },
      { id: 2, direction: 'connection', remoteAddress: '::ffff:10.0.0.3' },
      { id: 2, direction: 'message', line: 'queued', messageIndex: 0 },
    ],
    0,
  )

  assert.equal(origin, '10.0.0.3')
})

test('verifyGoBackupScheduler validates the Go scheduler email and restores settings', async () => {
  const prefix = 'scheduler-unit'
  const smtp = fakeSMTPServer({
    message: schedulerMessage({ prefix }),
    remoteAddress: '10.0.0.3',
  })
  const gateway = createSchedulerGateway({ initialProvider: 'go' })

  const result = await verifyGoBackupScheduler({
    base: 'http://gateway',
    cookie: 'cf_session=test',
    smtpHost: 'fixture',
    smtpPort: 2525,
    backupDir: '/app/data/backups',
    prefix,
    requireGoOrigin: true,
    fetchImpl: gateway.fetchImpl,
    smtpServerFactory: async () => smtp,
    lookupImpl: fakeLookup({
      go: ['10.0.0.3'],
      node: ['10.0.0.2'],
    }),
  })

  assert.equal(result.ok, true)
  assert.equal(result.emails.length, 1)
  assert.equal(result.emails[0].provider, 'go')
  assert.equal(result.emails[0].validated, true)
  assert.equal(result.emails[0].origin.validated, true)
  assert.equal(result.emails[0].origin.remoteAddress, '10.0.0.3')
  assert.equal(gateway.state.provider, 'go')
  for (const key of BACKUP_KEYS) {
    assert.deepEqual(
      gateway.state.settings.get(key),
      gateway.state.originalSettings.get(key),
      `${key} restored`,
    )
  }
})

test('verifyGoBackupScheduler fails when the scheduler email comes from Node', async () => {
  const prefix = 'scheduler-node-origin'
  const smtp = fakeSMTPServer({
    message: schedulerMessage({ prefix }),
    remoteAddress: '10.0.0.2',
  })
  const gateway = createSchedulerGateway({ initialProvider: 'node' })

  const result = await verifyGoBackupScheduler({
    base: 'http://gateway',
    cookie: 'cf_session=test',
    smtpHost: 'fixture',
    smtpPort: 2525,
    backupDir: '/app/data/backups',
    prefix,
    requireGoOrigin: true,
    fetchImpl: gateway.fetchImpl,
    smtpServerFactory: async () => smtp,
    lookupImpl: fakeLookup({
      go: ['10.0.0.3'],
      node: ['10.0.0.2'],
    }),
  })

  assert.equal(result.ok, false)
  assert.deepEqual(
    result.errors.map((error) => error.field),
    ['smtp.origin.remoteAddress', 'smtp.origin.remoteAddress'],
  )
  assert.equal(gateway.state.provider, 'node')
})

function createSchedulerGateway({ initialProvider }) {
  const state = {
    provider: initialProvider,
    originalSettings: new Map(
      BACKUP_KEYS.map((key) => [key, originalSettingValue(key)]),
    ),
    settings: new Map(
      BACKUP_KEYS.map((key) => [key, originalSettingValue(key)]),
    ),
  }

  const fetchImpl = async (url, options = {}) => {
    const requestURL = new URL(url)
    const body = options.body ? JSON.parse(options.body) : undefined
    const pathname = requestURL.pathname
    if (pathname === '/api/system/settings/system/backend.readProvider') {
      if (options.method === 'GET') {
        return jsonResponse({
          namespace: 'system',
          key: 'backend.readProvider',
          value: state.provider,
        })
      }
      if (options.method === 'PUT') {
        state.provider = body.value
        return jsonResponse({
          namespace: 'system',
          key: 'backend.readProvider',
          value: state.provider,
        })
      }
    }

    const settingMatch = /^\/api\/system\/settings\/system\/(.+)$/.exec(
      pathname,
    )
    if (settingMatch) {
      const key = settingMatch[1]
      if (options.method === 'GET') {
        return jsonResponse({
          namespace: 'system',
          key,
          value: state.settings.get(key),
        })
      }
      if (options.method === 'PUT') {
        state.settings.set(key, body.value)
        return jsonResponse({
          namespace: 'system',
          key,
          value: body.value,
        })
      }
    }

    return jsonResponse({ statusMessage: 'not found' }, 404)
  }

  return { state, fetchImpl }
}

function fakeSMTPServer({ message, remoteAddress }) {
  return {
    messages: [message],
    events: [
      {
        id: 1,
        direction: 'connection',
        remoteAddress,
        remotePort: 12345,
      },
      {
        id: 1,
        direction: 'message',
        line: 'queued',
        messageIndex: 0,
        size: Buffer.byteLength(message),
      },
    ],
    port: 2525,
    waitForMessageCount(count) {
      if (this.messages.length < count) {
        throw new Error(`missing SMTP message ${count}`)
      }
      return this.messages[count - 1]
    },
    close: async () => {},
  }
}

function schedulerMessage({ prefix }) {
  const passphrase = `${prefix}-chronoframe-backup-passphrase`
  const sqlite = Buffer.concat([
    Buffer.from('SQLite format 3\0'),
    Buffer.from('scheduled backup fixture'),
  ])
  const fileName = 'chronoframe-db-2026-09-12T010203Z.sqlite3.gz.enc'
  const attachment = encryptedBackupEnvelope(gzipSync(sqlite), passphrase)
  const message = [
    'From: sender@example.test',
    'To: recipient@example.test',
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    `Content-Type: application/octet-stream; name="${fileName}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${fileName}"`,
    '',
    attachment.toString('base64'),
    '--b--',
    '',
  ].join('\r\n')

  const parsed = extractBackupAttachment(message)
  assert.equal(parsed.fileName, fileName)
  assert.deepEqual(
    encryptedBackupEnvelopeToSQLiteBytes(parsed.bytes, passphrase),
    sqlite,
  )
  return message
}

function encryptedBackupEnvelope(gzipBytes, passphrase) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(passphrase, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(gzipBytes), cipher.final()])
  return Buffer.concat([
    Buffer.from('CFDBENC2'),
    salt,
    iv,
    ciphertext,
    cipher.getAuthTag(),
  ])
}

function fakeLookup(addressesByHost) {
  return async (host) =>
    (addressesByHost[host] || []).map((address) => ({ address, family: 4 }))
}

function originalSettingValue(key) {
  if (key === 'backup.smtpPort') return 465
  if (key === 'backup.smtpSecure') return true
  if (key === 'backup.enabled') return false
  if (key === 'backup.retentionDays') return 30
  if (key === 'backup.cron') return '0 3 * * *'
  if (key === 'backup.timezone') return 'Asia/Shanghai'
  return ''
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-chronoframe-backend': 'node',
      'x-request-id': 'unit-response-request',
    },
  })
}

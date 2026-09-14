import assert from 'node:assert/strict'
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto'
import { hostname } from 'node:os'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'

import {
  DEFAULT_BACKUP_COOKIE,
  encryptedBackupEnvelopeToSQLiteBytes,
  extractBackupAttachment,
  parseBackupVerifierOptions,
  verifyDualBackup,
} from '../scripts/verify-dual-backup.mjs'

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

test('parseBackupVerifierOptions defaults to fixture session and local SMTP', () => {
  const options = parseBackupVerifierOptions([], {
    CFRAME_DUAL_PORT: '33100',
  })

  assert.equal(options.base, 'http://127.0.0.1:33100')
  assert.equal(options.cookie, DEFAULT_BACKUP_COOKIE)
  assert.equal(options.smtpHost, 'host.docker.internal')
  assert.equal(options.smtpBind, '0.0.0.0')
  assert.equal(options.smtpPort, 0)
  assert.equal(options.startSmtp, true)
  assert.equal(options.keepFiles, false)
})

test('parseBackupVerifierOptions accepts explicit SMTP values', () => {
  const options = parseBackupVerifierOptions(
    [
      '--base',
      'http://gateway/',
      '--cookie',
      'cf_session=test',
      '--timeout-ms',
      '30000',
      '--prefix',
      'backup_test',
      '--smtp-host',
      'fixture',
      '--smtp-bind',
      '0.0.0.0',
      '--smtp-port',
      '2525',
      '--no-start-smtp',
      '--keep-files',
    ],
    {},
  )

  assert.equal(options.base, 'http://gateway')
  assert.equal(options.cookie, 'cf_session=test')
  assert.equal(options.timeoutMs, 30_000)
  assert.equal(options.prefix, 'backup_test')
  assert.equal(options.smtpHost, 'fixture')
  assert.equal(options.smtpPort, 2525)
  assert.equal(options.startSmtp, false)
  assert.equal(options.keepFiles, true)
})

test('parseBackupVerifierOptions expands self SMTP host to current hostname', () => {
  const options = parseBackupVerifierOptions(['--smtp-host', 'self'], {})

  assert.equal(options.smtpHost, hostname())
})

test('extractBackupAttachment decrypts a ChronoFrame encrypted SQLite backup', () => {
  const passphrase = 'unit-test-passphrase'
  const sqlite = Buffer.concat([
    Buffer.from('SQLite format 3\0'),
    Buffer.from('unit fixture'),
  ])
  const envelope = encryptedBackupEnvelope(gzipSync(sqlite), passphrase)
  const message = [
    'From: sender@example.test',
    'To: recipient@example.test',
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    'Content-Type: application/octet-stream; name="chronoframe-db-2026-09-12T010203Z.sqlite3.gz.enc"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="chronoframe-db-2026-09-12T010203Z.sqlite3.gz.enc"',
    '',
    envelope.toString('base64'),
    '--b--',
    '',
  ].join('\r\n')

  const attachment = extractBackupAttachment(message)
  assert.equal(
    attachment.fileName,
    'chronoframe-db-2026-09-12T010203Z.sqlite3.gz.enc',
  )
  assert.deepEqual(
    encryptedBackupEnvelopeToSQLiteBytes(attachment.bytes, passphrase),
    sqlite,
  )
})

test('verifyDualBackup runs encrypted backups through both providers and restores settings', async () => {
  const smtp = fakeSMTPServer()
  const gateway = createBackupGateway({ smtp })

  const result = await verifyDualBackup({
    base: 'http://gateway',
    cookie: 'cf_session=test',
    smtpHost: 'fixture',
    smtpPort: 2525,
    startSmtp: true,
    prefix: 'backup-unit',
    fetchImpl: gateway.fetchImpl,
    smtpServerFactory: async () => smtp,
    sleepImpl: async () => {},
  })

  assert.equal(result.ok, true)
  assert.deepEqual(
    result.emails.map((email) => [email.provider, email.validated]),
    [
      ['node', true],
      ['go', true],
    ],
  )
  assert.equal(gateway.state.provider, 'node')
  for (const key of BACKUP_KEYS) {
    assert.deepEqual(
      gateway.state.settings.get(key),
      gateway.state.originalSettings.get(key),
      `${key} restored`,
    )
  }
})

test('verifyDualBackup fails when the Go backup response shape drifts', async () => {
  const smtp = fakeSMTPServer()
  const gateway = createBackupGateway({ smtp, breakGoEncryptedFlag: true })

  const result = await verifyDualBackup({
    base: 'http://gateway',
    cookie: 'cf_session=test',
    smtpHost: 'fixture',
    smtpPort: 2525,
    startSmtp: true,
    prefix: 'backup-unit',
    fetchImpl: gateway.fetchImpl,
    smtpServerFactory: async () => smtp,
    sleepImpl: async () => {},
  })

  assert.equal(result.ok, false)
  assert.deepEqual(
    result.errors.map((error) => error.field),
    ['body.result.encrypted'],
  )
  assert.equal(gateway.state.provider, 'node')
})

function createBackupGateway({ smtp, breakGoEncryptedFlag = false }) {
  const state = {
    provider: 'node',
    backupIndex: 0,
    originalSettings: new Map(
      BACKUP_KEYS.map((key) => [key, originalSettingValue(key)]),
    ),
    settings: new Map(BACKUP_KEYS.map((key) => [key, originalSettingValue(key)])),
  }

  const fetchImpl = async (url, options) => {
    const requestURL = new URL(url)
    const body = options.body ? JSON.parse(options.body) : undefined
    const pathname = requestURL.pathname
    if (
      options.method === 'PUT' &&
      pathname === '/api/system/settings/system/backend.readProvider'
    ) {
      state.provider = body.value
      return jsonResponse(
        {
          namespace: 'system',
          key: 'backend.readProvider',
          value: state.provider,
        },
        'node',
      )
    }

    const settingMatch = /^\/api\/system\/settings\/system\/(.+)$/.exec(
      pathname,
    )
    if (settingMatch) {
      const key = settingMatch[1]
      if (options.method === 'GET') {
        return jsonResponse(
          { namespace: 'system', key, value: state.settings.get(key) },
          state.provider,
        )
      }
      if (options.method === 'PUT') {
        state.settings.set(key, body.value)
        return jsonResponse(
          { namespace: 'system', key, value: body.value },
          state.provider,
        )
      }
    }

    if (pathname === '/api/system/backup/run' && options.method === 'POST') {
      const provider = state.provider
      const passphrase = state.settings.get('backup.encryptionPassphrase')
      const fileName = `chronoframe-db-2026-09-12T01020${state.backupIndex++}Z.sqlite3.gz.enc`
      const attachment = encryptedBackupEnvelope(
        gzipSync(Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.from(provider)])),
        passphrase,
      )
      smtp.messages.push(
        smtpMessage({
          fileName,
          attachment,
        }),
      )
      return jsonResponse(
        {
          success: true,
          result: {
            fileName,
            filePath: `/app/data/backups/${fileName}`,
            size: attachment.length,
            encrypted: breakGoEncryptedFlag && provider === 'go' ? false : true,
            sentTo: state.settings.get('backup.mailTo').split(','),
            createdAt: '2026-09-12T01:02:03.004Z',
          },
        },
        provider,
      )
    }

    return jsonResponse({ statusMessage: 'not found' }, state.provider, 404)
  }

  return { state, fetchImpl }
}

function fakeSMTPServer() {
  return {
    messages: [],
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

function smtpMessage({ fileName, attachment }) {
  return [
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

function originalSettingValue(key) {
  if (key === 'backup.smtpPort') return 465
  if (key === 'backup.smtpSecure') return true
  if (key === 'backup.enabled') return false
  if (key === 'backup.retentionDays') return 30
  if (key === 'backup.cron') return '0 3 * * *'
  if (key === 'backup.timezone') return 'Asia/Shanghai'
  return ''
}

function jsonResponse(body, backend, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-chronoframe-backend': backend,
      'x-request-id': 'unit-response-request',
    },
  })
}

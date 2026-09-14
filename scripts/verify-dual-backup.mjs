#!/usr/bin/env node

import { randomUUID, scryptSync, createDecipheriv } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { hostname } from 'node:os'
import { basename } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { FIXTURE_SESSION_TOKEN } from './seed-dual-backend-fixture.mjs'

export const DEFAULT_BACKUP_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_BACKUP_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`
export const DEFAULT_BACKUP_SMTP_HOST = 'host.docker.internal'
export const DEFAULT_BACKUP_SMTP_BIND = '0.0.0.0'
export const DEFAULT_BACKUP_PREFIX = 'dual-backup'

const BACKUP_MAGIC = Buffer.from('CFDBENC2')
const PROVIDERS = ['node', 'go']
const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'
const BACKUP_RUN_PATH = '/api/system/backup/run'
const BACKUP_SETTING_KEYS = [
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
const ISO_MILLISECOND_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const BACKUP_FILE_NAME_PATTERN =
  /^chronoframe-db-\d{4}-\d{2}-\d{2}T\d{6}Z\.sqlite3\.gz\.enc$/

export function parseBackupVerifierOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const values = new Map()
  let startSmtp = true
  let keepFiles = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--no-start-smtp') {
      startSmtp = false
      continue
    }
    if (arg === '--keep-files') {
      keepFiles = true
      continue
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`)
    }
    if (
      ![
        '--base',
        '--cookie',
        '--timeout-ms',
        '--prefix',
        '--smtp-host',
        '--smtp-bind',
        '--smtp-port',
      ].includes(arg)
    ) {
      throw new Error(`Unknown option: ${arg}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`)
    }
    values.set(arg, value)
    index += 1
  }

  const base =
    values.get('--base') ||
    environment.CFRAME_DUAL_BASE_URL ||
    (environment.CFRAME_DUAL_PORT
      ? `http://127.0.0.1:${environment.CFRAME_DUAL_PORT}`
      : DEFAULT_BACKUP_BASE_URL)
  const cookie =
    values.get('--cookie') ||
    environment.CFRAME_DUAL_COOKIE ||
    DEFAULT_BACKUP_COOKIE
  const timeoutMs = parsePositiveInteger(
    values.get('--timeout-ms') || environment.CFRAME_DUAL_TIMEOUT_MS || 20_000,
    'timeout-ms',
  )
  if (timeoutMs > 120_000) {
    throw new Error('timeout-ms must be 120000 or less')
  }
  const smtpPort = values.has('--smtp-port')
    ? parsePort(values.get('--smtp-port'), 'smtp-port')
    : environment.CFRAME_DUAL_BACKUP_SMTP_PORT
      ? parsePort(environment.CFRAME_DUAL_BACKUP_SMTP_PORT, 'smtp-port')
      : 0
  if (!startSmtp && smtpPort === 0) {
    throw new Error('--smtp-port is required with --no-start-smtp')
  }

  return {
    base: normalizeBaseURL(base),
    cookie: normalizeCookie(cookie),
    timeoutMs,
    prefix: normalizePrefix(
      values.get('--prefix') ||
        environment.CFRAME_DUAL_BACKUP_PREFIX ||
        DEFAULT_BACKUP_PREFIX,
    ),
    smtpHost: normalizeSMTPHost(
      values.get('--smtp-host') ||
        environment.CFRAME_DUAL_BACKUP_SMTP_HOST ||
        DEFAULT_BACKUP_SMTP_HOST,
    ),
    smtpBind:
      values.get('--smtp-bind') ||
      environment.CFRAME_DUAL_BACKUP_SMTP_BIND ||
      DEFAULT_BACKUP_SMTP_BIND,
    smtpPort,
    startSmtp,
    keepFiles,
  }
}

export async function verifyDualBackup({
  base = DEFAULT_BACKUP_BASE_URL,
  cookie = DEFAULT_BACKUP_COOKIE,
  timeoutMs = 20_000,
  prefix = DEFAULT_BACKUP_PREFIX,
  smtpHost = DEFAULT_BACKUP_SMTP_HOST,
  smtpBind = DEFAULT_BACKUP_SMTP_BIND,
  smtpPort = 0,
  startSmtp = true,
  keepFiles = false,
  fetchImpl = globalThis.fetch,
  smtpServerFactory = startFakeSMTPServer,
  sleepImpl = sleep,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function')
  }
  const normalized = {
    base: normalizeBaseURL(base),
    cookie: normalizeCookie(cookie),
    timeoutMs: parsePositiveInteger(timeoutMs, 'timeout-ms'),
    prefix: normalizePrefix(prefix),
    smtpHost: normalizeSMTPHost(smtpHost),
    smtpBind: String(smtpBind || '').trim() || DEFAULT_BACKUP_SMTP_BIND,
    smtpPort: parsePort(smtpPort, 'smtp-port', { allowZero: startSmtp }),
    startSmtp: Boolean(startSmtp),
    keepFiles: Boolean(keepFiles),
  }
  if (!normalized.smtpHost) {
    throw new Error('smtpHost must not be empty')
  }
  const summary = {
    ok: false,
    base: normalized.base,
    prefix: normalized.prefix,
    smtpHost: normalized.smtpHost,
    smtpPort: normalized.smtpPort,
    startSmtp: normalized.startSmtp,
    keepFiles: normalized.keepFiles,
    checks: [],
    emails: [],
    backupFiles: [],
    cleanup: [],
  }
  const api = createBackupAPI({ ...normalized, summary, fetchImpl })
  const state = {
    originalSettings: new Map(),
    backupFiles: new Set(),
  }
  let smtpServer = null

  try {
    if (normalized.startSmtp) {
      smtpServer = await smtpServerFactory({
        bind: normalized.smtpBind,
        port: normalized.smtpPort,
      })
      normalized.smtpPort = smtpServer.port
      summary.smtpPort = smtpServer.port
      if (smtpServer.events) {
        summary.smtpEvents = smtpServer.events
      }
    }

    await setProvider(api, 'node')
    await captureOriginalBackupSettings(api, state)
    await configureVerifierBackupSettings(api, normalized)

    for (const provider of PROVIDERS) {
      await verifyBackupRunForProvider({
        api,
        provider,
        state,
        summary,
        smtpServer,
        passphrase: verifierPassphrase(normalized.prefix),
        timeoutMs: normalized.timeoutMs,
      })
      await sleepImpl(1_100)
    }

    summary.ok = true
    return summary
  } catch (error) {
    summary.errors =
      error instanceof VerificationFailure
        ? error.errors
        : [
            {
              name: 'dual backup verifier',
              message: error instanceof Error ? error.message : String(error),
            },
          ]
    return summary
  } finally {
    await cleanupBackupVerification(api, state, summary, {
      keepFiles: normalized.keepFiles,
    })
    if (smtpServer) {
      await smtpServer.close()
    }
  }
}

async function verifyBackupRunForProvider({
  api,
  provider,
  state,
  summary,
  smtpServer,
  passphrase,
  timeoutMs,
}) {
  await setProvider(api, provider)
  const emailOffset = smtpServer?.messages?.length ?? 0
  const response = await api.request({
    name: `database backup run via ${provider}`,
    method: 'POST',
    path: BACKUP_RUN_PATH,
    expectedBackend: provider,
  })
  const backup = response.body?.result
  expectExactKeys(response.name, response.body, ['result', 'success'], 'body')
  expectEqual(response.name, response.body.success, true, 'body.success')
  expectBackupResult(response.name, backup)
  expectDeepEqual(
    response.name,
    backup.sentTo,
    verifierRecipients(api.prefix),
    'body.result.sentTo',
  )
  state.backupFiles.add(backup.filePath)
  summary.backupFiles.push({
    provider,
    fileName: backup.fileName,
    filePath: backup.filePath,
    size: backup.size,
    encrypted: backup.encrypted,
  })

  if (!smtpServer) {
    summary.emails.push({
      provider,
      validated: false,
      reason: 'external SMTP server was used',
    })
    return
  }

  const message = await smtpServer.waitForMessageCount(
    emailOffset + 1,
    timeoutMs,
  )
  const attachment = extractBackupAttachment(message)
  expectEqual(
    response.name,
    attachment.fileName,
    backup.fileName,
    'email.attachment.fileName',
  )
  expectEqual(
    response.name,
    attachment.bytes.length,
    backup.size,
    'email.attachment.size',
  )
  const sqliteBytes = encryptedBackupEnvelopeToSQLiteBytes(
    attachment.bytes,
    passphrase,
  )
  if (!sqliteBytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) {
    throw new VerificationFailure([
      {
        name: response.name,
        field: 'email.attachment.sqliteHeader',
        expected: 'SQLite format 3\\0',
        actual: sqliteBytes.subarray(0, 16).toString('latin1'),
      },
    ])
  }
  summary.emails.push({
    provider,
    validated: true,
    fileName: attachment.fileName,
    attachmentSize: attachment.bytes.length,
    sqliteSize: sqliteBytes.length,
  })
}

function expectBackupResult(name, backup) {
  expectExactKeys(
    name,
    backup,
    ['createdAt', 'encrypted', 'fileName', 'filePath', 'sentTo', 'size'],
    'body.result',
  )
  expectEqual(name, backup.encrypted, true, 'body.result.encrypted')
  if (
    typeof backup.fileName !== 'string' ||
    !BACKUP_FILE_NAME_PATTERN.test(backup.fileName)
  ) {
    throw new VerificationFailure([
      {
        name,
        field: 'body.result.fileName',
        expected: BACKUP_FILE_NAME_PATTERN.toString(),
        actual: backup.fileName,
      },
    ])
  }
  expectEqual(
    name,
    typeof backup.filePath === 'string' &&
      backup.filePath.endsWith(`/data/backups/${backup.fileName}`),
    true,
    'body.result.filePath',
  )
  if (!Number.isSafeInteger(backup.size) || backup.size <= 0) {
    throw new VerificationFailure([
      {
        name,
        field: 'body.result.size',
        expected: 'positive integer',
        actual: backup.size,
      },
    ])
  }
  if (
    typeof backup.createdAt !== 'string' ||
    !ISO_MILLISECOND_UTC_PATTERN.test(backup.createdAt)
  ) {
    throw new VerificationFailure([
      {
        name,
        field: 'body.result.createdAt',
        expected: 'ISO 8601 UTC string with millisecond precision',
        actual: backup.createdAt,
      },
    ])
  }
}

async function captureOriginalBackupSettings(api, state) {
  for (const key of BACKUP_SETTING_KEYS) {
    const result = await api.request({
      name: `capture original system.${key}`,
      method: 'GET',
      path: `/api/system/settings/system/${key}`,
      expectedBackend: 'node',
    })
    state.originalSettings.set(key, result.body?.value)
  }
}

async function configureVerifierBackupSettings(api, options) {
  const updates = [
    ['backup.enabled', false],
    ['backup.cron', '0 3 * * *'],
    ['backup.timezone', 'Asia/Shanghai'],
    ['backup.retentionDays', 1],
    ['backup.smtpHost', options.smtpHost],
    ['backup.smtpPort', options.smtpPort],
    ['backup.smtpSecure', false],
    ['backup.smtpUser', ''],
    ['backup.smtpPassword', ''],
    [`backup.mailFrom`, `${options.prefix}@chronoframe.local`],
    ['backup.mailTo', verifierRecipients(options.prefix).join(',')],
    ['backup.encryptionPassphrase', verifierPassphrase(options.prefix)],
  ]
  for (const [key, value] of updates) {
    await api.request({
      name: `configure system.${key}`,
      method: 'PUT',
      path: `/api/system/settings/system/${key}`,
      expectedBackend: 'node',
      body: { value },
    })
  }
}

async function cleanupBackupVerification(api, state, summary, { keepFiles }) {
  const cleanup = async (name, action) => {
    try {
      await action()
      summary.cleanup.push({ name, ok: true })
    } catch (error) {
      summary.cleanup.push({
        name,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
      summary.ok = false
    }
  }

  await cleanup('restore provider to node', () => setProvider(api, 'node'))
  for (const [key, value] of [...state.originalSettings.entries()].reverse()) {
    await cleanup(`restore system.${key}`, () =>
      api.request({
        name: `cleanup: restore system.${key}`,
        method: 'PUT',
        path: `/api/system/settings/system/${key}`,
        expectedBackend: 'node',
        body: { value },
      }),
    )
  }

  if (keepFiles) return
  for (const filePath of state.backupFiles) {
    await cleanup(`delete backup file ${basename(filePath)}`, async () => {
      if (!existsSync(filePath)) {
        return
      }
      await rm(filePath, { force: true })
    })
  }
}

async function setProvider(api, provider) {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unknown provider ${provider}`)
  }
  await api.request({
    name: `switch provider to ${provider}`,
    method: 'PUT',
    path: PROVIDER_SETTING_PATH,
    expectedBackend: 'node',
    expectedValue: provider,
    body: { value: provider },
  })
}

function createBackupAPI({
  base,
  cookie,
  timeoutMs,
  prefix,
  summary,
  fetchImpl,
}) {
  return {
    prefix,
    async request(expectation) {
      const requestId = `dual-backup-${randomUUID()}`
      const headers = {
        Accept: 'application/json',
        Cookie: cookie,
        'X-Request-Id': requestId,
      }
      Object.assign(headers, expectation.headers || {})
      const options = {
        method: expectation.method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      }
      if (Object.hasOwn(expectation, 'body')) {
        headers['Content-Type'] = 'application/json'
        options.body = JSON.stringify(expectation.body)
      }

      const response = await fetchImpl(
        joinBackupURL(base, expectation.path),
        options,
      )
      const text = await response.text()
      const body = parseJSONBody(text)
      const result = {
        name: expectation.name,
        method: expectation.method,
        path: expectation.path,
        expectedBackend: expectation.expectedBackend,
        status: response.status,
        backend: response.headers.get('x-chronoframe-backend'),
        contentType: normalizedContentType(
          response.headers.get('content-type'),
        ),
        requestId,
        responseRequestId: response.headers.get('x-request-id'),
        body,
      }
      summary.checks.push(result)

      const errors = validateHTTPResult(expectation, result)
      if (errors.length > 0) {
        throw new VerificationFailure(errors)
      }
      return result
    },
  }
}

export async function startFakeSMTPServer({ bind = '0.0.0.0', port = 0 } = {}) {
  const messages = []
  const events = []
  let connectionId = 0
  const server = createServer((socket) => {
    connectionId += 1
    const id = connectionId
    socket.setEncoding('utf8')
    let buffer = ''
    let dataMode = false
    let dataLines = []
    const record = (event) => {
      events.push({
        id,
        ...event,
      })
    }
    const write = (line) => {
      record({ direction: 'server', line })
      socket.write(`${line}\r\n`)
    }
    record({
      direction: 'connection',
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort,
    })
    write('220 chronoframe backup verifier smtp')

    socket.on('data', (chunk) => {
      buffer += chunk
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n')
        const rawLine = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const line = rawLine.replace(/\r$/, '')
        if (dataMode) {
          if (line === '.') {
            const message = dataLines.join('\r\n')
            const messageIndex = messages.length
            messages.push(message)
            record({
              direction: 'message',
              line: 'queued',
              messageIndex,
              size: Buffer.byteLength(message),
            })
            dataLines = []
            dataMode = false
            write('250 2.0.0 queued')
          } else {
            dataLines.push(line.startsWith('..') ? line.slice(1) : line)
          }
          continue
        }

        const upper = line.toUpperCase()
        record({
          direction: 'client',
          line: upper === 'DATA' ? line : redactSMTPLine(line),
        })
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write(
            '250-chronoframe-backup-verifier\r\n250 SIZE 104857600\r\n',
          )
          record({
            direction: 'server',
            line: '250-chronoframe-backup-verifier',
          })
          record({ direction: 'server', line: '250 SIZE 104857600' })
        } else if (upper.startsWith('MAIL FROM:')) {
          write('250 2.1.0 ok')
        } else if (upper.startsWith('RCPT TO:')) {
          write('250 2.1.5 ok')
        } else if (upper === 'DATA') {
          dataMode = true
          write('354 end data with <CR><LF>.<CR><LF>')
        } else if (upper === 'RSET' || upper === 'NOOP') {
          write('250 2.0.0 ok')
        } else if (upper === 'QUIT') {
          write('221 2.0.0 bye')
        } else {
          write('250 2.0.0 ok')
        }
      }
    })
    socket.on('end', () => {
      record({ direction: 'client', line: 'END' })
    })
    socket.on('close', (hadError) => {
      record({ direction: 'connection', line: 'close', hadError })
    })
    socket.on('error', (error) => {
      record({
        direction: 'connection',
        line: 'error',
        message: error.message,
      })
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, bind, () => {
      server.off('error', reject)
      resolve()
    })
  })

  return {
    messages,
    events,
    port: server.address().port,
    async waitForMessageCount(count, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (messages.length >= count) {
          return messages[count - 1]
        }
        await sleep(50)
      }
      throw new Error(`timed out waiting for ${count} SMTP message(s)`)
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    },
  }
}

function redactSMTPLine(line) {
  const upper = line.toUpperCase()
  if (upper.startsWith('AUTH ')) return 'AUTH <redacted>'
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

export function extractBackupAttachment(message) {
  const normalized = String(message || '').replace(/\r\n/g, '\n')
  const filenameMatch = /filename="?([^"\n;]+)"?/i.exec(normalized)
  if (!filenameMatch) {
    throw new Error('SMTP message did not include an attachment filename')
  }
  const filenameIndex = filenameMatch.index
  const partStart = Math.max(0, normalized.lastIndexOf('\n--', filenameIndex))
  const base64Header = /content-transfer-encoding:\s*base64/i.exec(
    normalized.slice(partStart),
  )
  if (!base64Header) {
    throw new Error('SMTP message attachment is not base64 encoded')
  }
  const headerIndex = partStart + base64Header.index
  const bodyStart = normalized.indexOf('\n\n', headerIndex)
  if (bodyStart < 0) {
    throw new Error('SMTP message attachment headers are incomplete')
  }
  const body = normalized.slice(bodyStart + 2)
  const boundaryIndex = body.search(/\n--[^\n]+/)
  const encoded = (boundaryIndex >= 0 ? body.slice(0, boundaryIndex) : body)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /^[A-Za-z0-9+/=]+$/.test(line))
    .join('')
  if (!encoded) {
    throw new Error('SMTP message attachment body is empty')
  }
  return {
    fileName: filenameMatch[1],
    bytes: Buffer.from(encoded, 'base64'),
  }
}

export function encryptedBackupEnvelopeToSQLiteBytes(envelope, passphrase) {
  const buffer = Buffer.from(envelope)
  if (!buffer.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
    throw new Error('encrypted backup is missing ChronoFrame backup magic')
  }
  const minimumSize = BACKUP_MAGIC.length + 16 + 12 + 16
  if (buffer.length <= minimumSize) {
    throw new Error('encrypted backup envelope is too short')
  }
  const saltStart = BACKUP_MAGIC.length
  const ivStart = saltStart + 16
  const payloadStart = ivStart + 12
  const tagStart = buffer.length - 16
  const salt = buffer.subarray(saltStart, ivStart)
  const iv = buffer.subarray(ivStart, payloadStart)
  const ciphertext = buffer.subarray(payloadStart, tagStart)
  const tag = buffer.subarray(tagStart)
  const key = scryptSync(passphrase, salt, 32)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const gzipBytes = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ])
  return gunzipSync(gzipBytes)
}

function validateHTTPResult(expectation, result) {
  const errors = []
  const expectedStatuses = expectation.expectedStatuses || [
    expectation.expectedStatus || 200,
  ]
  if (!expectedStatuses.includes(result.status)) {
    errors.push({
      name: expectation.name,
      field: 'status',
      expected:
        expectedStatuses.length === 1 ? expectedStatuses[0] : expectedStatuses,
      actual: result.status,
    })
  }
  if (
    expectation.expectedBackend &&
    result.backend !== expectation.expectedBackend
  ) {
    errors.push({
      name: expectation.name,
      field: 'headers.x-chronoframe-backend',
      expected: expectation.expectedBackend,
      actual: result.backend,
    })
  }
  if (
    expectation.expectJSON !== false &&
    result.contentType !== 'application/json'
  ) {
    errors.push({
      name: expectation.name,
      field: 'headers.content-type',
      expected: 'application/json',
      actual: result.contentType,
    })
  }
  if (
    Object.hasOwn(expectation, 'expectedValue') &&
    result.body?.value !== expectation.expectedValue
  ) {
    errors.push({
      name: expectation.name,
      field: 'body.value',
      expected: expectation.expectedValue,
      actual: result.body?.value,
    })
  }
  return errors
}

function expectEqual(name, actual, expected, field) {
  if (actual !== expected) {
    throw new VerificationFailure([{ name, field, expected, actual }])
  }
}

function expectDeepEqual(name, actual, expected, field) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new VerificationFailure([{ name, field, expected, actual }])
  }
}

function expectExactKeys(name, actual, expected, field) {
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    throw new VerificationFailure([{ name, field, expected, actual }])
  }
  expectDeepEqual(name, Object.keys(actual).sort(), [...expected].sort(), field)
}

function verifierRecipients(prefix) {
  return [`${prefix}-recipient@example.test`, `${prefix}-second@example.test`]
}

function verifierPassphrase(prefix) {
  return `${prefix}-chronoframe-backup-passphrase`
}

function joinBackupURL(baseURL, requestPath) {
  const base = new URL(baseURL)
  const suffix = requestPath.startsWith('/') ? requestPath : `/${requestPath}`
  const [pathPart, searchPart = ''] = suffix.split('?')
  base.pathname = `${base.pathname.replace(/\/+$/, '')}${pathPart}`
  base.search = searchPart ? `?${searchPart}` : ''
  base.hash = ''
  return base
}

function normalizeBaseURL(rawValue) {
  const value = String(rawValue || '').trim()
  if (!value) throw new Error('base must not be empty')
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('base must be an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('base must use http or https')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function normalizeCookie(rawValue) {
  const value = String(rawValue || '').trim()
  if (!value) {
    throw new Error(
      'cookie must not be empty; seed the fixture session or pass --cookie',
    )
  }
  return value
}

function normalizePrefix(rawValue) {
  const value = String(rawValue || '').trim()
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(value)) {
    throw new Error(
      'prefix must be 1-64 characters and contain only letters, numbers, dot, underscore, or dash',
    )
  }
  return value
}

function normalizeSMTPHost(rawValue) {
  const value = String(rawValue || '').trim()
  if (value === 'self') return hostname()
  return value
}

function parsePositiveInteger(rawValue, name) {
  const value =
    typeof rawValue === 'number' ? rawValue : Number.parseInt(rawValue, 10)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function parsePort(rawValue, name, { allowZero = false } = {}) {
  const value =
    typeof rawValue === 'number' ? rawValue : Number.parseInt(rawValue, 10)
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > 65_535
  ) {
    throw new Error(
      `${name} must be ${allowZero ? '0 or ' : ''}a valid TCP port`,
    )
  }
  return value
}

function normalizedContentType(value) {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || ''
}

function parseJSONBody(text) {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

class VerificationFailure extends Error {
  constructor(errors) {
    super(errors.map((error) => `${error.name}: ${error.field}`).join(', '))
    this.name = 'VerificationFailure'
    this.errors = errors
  }
}

async function main() {
  const options = parseBackupVerifierOptions()
  const result = await verifyDualBackup(options)
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}

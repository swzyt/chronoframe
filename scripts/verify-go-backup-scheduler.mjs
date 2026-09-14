#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  DEFAULT_BACKUP_BASE_URL,
  DEFAULT_BACKUP_COOKIE,
  DEFAULT_BACKUP_SMTP_BIND,
  DEFAULT_BACKUP_SMTP_HOST,
  encryptedBackupEnvelopeToSQLiteBytes,
  extractBackupAttachment,
  startFakeSMTPServer,
} from './verify-dual-backup.mjs'

export const DEFAULT_GO_BACKUP_SCHEDULER_PREFIX = 'go-backup-scheduler'
export const DEFAULT_GO_BACKUP_SCHEDULER_TIMEOUT_MS = 45_000
export const DEFAULT_GO_BACKUP_SCHEDULER_CRON = '*/5 * * * * *'

const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'
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
const BACKUP_FILE_NAME_PATTERN =
  /^chronoframe-db-\d{4}-\d{2}-\d{2}T\d{6}Z\.sqlite3\.gz\.enc$/
const SQLITE_HEADER = Buffer.from('SQLite format 3\0')

export function parseGoBackupSchedulerVerifierOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const values = new Map()
  let keepFiles = false
  let requireGoOrigin = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--keep-files') {
      keepFiles = true
      continue
    }
    if (arg === '--require-go-origin') {
      requireGoOrigin = true
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
        '--backup-dir',
        '--cron',
        '--go-host',
        '--node-host',
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
    values.get('--timeout-ms') ||
      environment.CFRAME_GO_BACKUP_SCHEDULER_TIMEOUT_MS ||
      environment.CFRAME_DUAL_TIMEOUT_MS ||
      DEFAULT_GO_BACKUP_SCHEDULER_TIMEOUT_MS,
    'timeout-ms',
  )
  const smtpPort = values.has('--smtp-port')
    ? parsePort(values.get('--smtp-port'), 'smtp-port')
    : environment.CFRAME_GO_BACKUP_SCHEDULER_SMTP_PORT
      ? parsePort(environment.CFRAME_GO_BACKUP_SCHEDULER_SMTP_PORT, 'smtp-port')
      : 0
  const backupDir =
    values.get('--backup-dir') ||
    environment.CFRAME_BACKUP_DIR ||
    (String(environment.DATABASE_URL || '').startsWith('/app/')
      ? '/app/data/backups'
      : 'data/backups')

  if (timeoutMs > 120_000) {
    throw new Error('timeout-ms must be 120000 or less')
  }
  if (environment.CFRAME_GO_BACKUP_SCHEDULER_REQUIRE_ORIGIN === 'true') {
    requireGoOrigin = true
  }

  return {
    base: normalizeBaseURL(base),
    cookie: normalizeCookie(cookie),
    timeoutMs,
    prefix: normalizePrefix(
      values.get('--prefix') ||
        environment.CFRAME_GO_BACKUP_SCHEDULER_PREFIX ||
        DEFAULT_GO_BACKUP_SCHEDULER_PREFIX,
    ),
    smtpHost: normalizeSMTPHost(
      values.get('--smtp-host') ||
        environment.CFRAME_GO_BACKUP_SCHEDULER_SMTP_HOST ||
        DEFAULT_BACKUP_SMTP_HOST,
    ),
    smtpBind:
      values.get('--smtp-bind') ||
      environment.CFRAME_GO_BACKUP_SCHEDULER_SMTP_BIND ||
      DEFAULT_BACKUP_SMTP_BIND,
    smtpPort,
    backupDir,
    cron:
      values.get('--cron') ||
      environment.CFRAME_GO_BACKUP_SCHEDULER_CRON ||
      DEFAULT_GO_BACKUP_SCHEDULER_CRON,
    keepFiles,
    requireGoOrigin,
    goHost: values.get('--go-host') || environment.CFRAME_GO_HOST || 'go',
    nodeHost:
      values.get('--node-host') || environment.CFRAME_NODE_HOST || 'node',
  }
}

export async function verifyGoBackupScheduler({
  base = DEFAULT_BACKUP_BASE_URL,
  cookie = DEFAULT_BACKUP_COOKIE,
  timeoutMs = DEFAULT_GO_BACKUP_SCHEDULER_TIMEOUT_MS,
  prefix = DEFAULT_GO_BACKUP_SCHEDULER_PREFIX,
  smtpHost = DEFAULT_BACKUP_SMTP_HOST,
  smtpBind = DEFAULT_BACKUP_SMTP_BIND,
  smtpPort = 0,
  backupDir = 'data/backups',
  cron = DEFAULT_GO_BACKUP_SCHEDULER_CRON,
  keepFiles = false,
  requireGoOrigin = false,
  goHost = 'go',
  nodeHost = 'node',
  fetchImpl = globalThis.fetch,
  smtpServerFactory = startFakeSMTPServer,
  lookupImpl = lookup,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function')
  }
  if (typeof lookupImpl !== 'function') {
    throw new Error('lookupImpl must be a function')
  }

  const normalized = {
    base: normalizeBaseURL(base),
    cookie: normalizeCookie(cookie),
    timeoutMs: parsePositiveInteger(timeoutMs, 'timeout-ms'),
    prefix: normalizePrefix(prefix),
    smtpHost: normalizeSMTPHost(smtpHost),
    smtpBind: String(smtpBind || '').trim() || DEFAULT_BACKUP_SMTP_BIND,
    smtpPort: parsePort(smtpPort, 'smtp-port', { allowZero: true }),
    backupDir: String(backupDir || '').trim() || 'data/backups',
    cron: String(cron || '').trim() || DEFAULT_GO_BACKUP_SCHEDULER_CRON,
    keepFiles: Boolean(keepFiles),
    requireGoOrigin: Boolean(requireGoOrigin),
    goHost: String(goHost || '').trim(),
    nodeHost: String(nodeHost || '').trim(),
  }
  if (!normalized.smtpHost) {
    throw new Error('smtpHost must not be empty')
  }
  if (!normalized.goHost && normalized.requireGoOrigin) {
    throw new Error('goHost must not be empty when requireGoOrigin is true')
  }

  const summary = {
    ok: false,
    base: normalized.base,
    prefix: normalized.prefix,
    smtpHost: normalized.smtpHost,
    smtpPort: normalized.smtpPort,
    backupDir: normalized.backupDir,
    cron: normalized.cron,
    requireGoOrigin: normalized.requireGoOrigin,
    checks: [],
    cleanup: [],
    emails: [],
  }
  const state = {
    originalProvider: 'node',
    originalSettings: new Map(),
    backupFiles: new Set(),
  }
  const api = createSchedulerAPI({ ...normalized, summary, fetchImpl })
  let smtpServer = null

  try {
    smtpServer = await smtpServerFactory({
      bind: normalized.smtpBind,
      port: normalized.smtpPort,
    })
    normalized.smtpPort = smtpServer.port
    summary.smtpPort = smtpServer.port
    if (smtpServer.events) {
      summary.smtpEvents = smtpServer.events
    }

    await captureOriginalProvider(api, state)
    await setProvider(api, 'node')
    await captureOriginalBackupSettings(api, state)
    await configureSchedulerBackupSettings(api, normalized)

    const message = await smtpServer.waitForMessageCount(
      1,
      normalized.timeoutMs,
    )
    const email = await validateSchedulerEmail({
      message,
      messageIndex: 0,
      smtpEvents: smtpServer.events || [],
      passphrase: verifierPassphrase(normalized.prefix),
      backupDir: normalized.backupDir,
      requireGoOrigin: normalized.requireGoOrigin,
      goHost: normalized.goHost,
      nodeHost: normalized.nodeHost,
      lookupImpl,
    })
    summary.emails.push(email)
    state.backupFiles.add(email.filePath)

    summary.ok = true
    return summary
  } catch (error) {
    summary.errors =
      error instanceof VerificationFailure
        ? error.errors
        : [
            {
              name: 'go backup scheduler verifier',
              message: error instanceof Error ? error.message : String(error),
            },
          ]
    return summary
  } finally {
    await cleanupSchedulerVerification(api, state, summary, {
      keepFiles: normalized.keepFiles,
    })
    if (smtpServer) {
      await smtpServer.close()
    }
  }
}

async function validateSchedulerEmail({
  message,
  messageIndex,
  smtpEvents,
  passphrase,
  backupDir,
  requireGoOrigin,
  goHost,
  nodeHost,
  lookupImpl,
}) {
  const attachment = extractBackupAttachment(message)
  if (!BACKUP_FILE_NAME_PATTERN.test(attachment.fileName)) {
    throw new VerificationFailure([
      {
        name: 'go backup scheduler email',
        field: 'attachment.fileName',
        expected: BACKUP_FILE_NAME_PATTERN.toString(),
        actual: attachment.fileName,
      },
    ])
  }
  const sqliteBytes = encryptedBackupEnvelopeToSQLiteBytes(
    attachment.bytes,
    passphrase,
  )
  if (!sqliteBytes.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
    throw new VerificationFailure([
      {
        name: 'go backup scheduler email',
        field: 'attachment.sqliteHeader',
        expected: 'SQLite format 3\\0',
        actual: sqliteBytes
          .subarray(0, SQLITE_HEADER.length)
          .toString('latin1'),
      },
    ])
  }

  const origin = await validateSMTPOrigin({
    smtpEvents,
    messageIndex,
    requireGoOrigin,
    goHost,
    nodeHost,
    lookupImpl,
  })
  return {
    provider: 'go',
    validated: true,
    fileName: attachment.fileName,
    filePath: join(backupDir, attachment.fileName),
    attachmentSize: attachment.bytes.length,
    sqliteSize: sqliteBytes.length,
    origin,
  }
}

async function validateSMTPOrigin({
  smtpEvents,
  messageIndex,
  requireGoOrigin,
  goHost,
  nodeHost,
  lookupImpl,
}) {
  const remoteAddress = findSMTPMessageOrigin(smtpEvents, messageIndex)
  const goAddresses = await resolveHostAddresses(goHost, lookupImpl)
  const nodeAddresses = await resolveHostAddresses(nodeHost, lookupImpl)
  const origin = {
    remoteAddress,
    goHost,
    nodeHost,
    goAddresses,
    nodeAddresses,
    validated: false,
  }
  if (!requireGoOrigin) {
    return origin
  }

  const errors = []
  if (!remoteAddress) {
    errors.push({
      name: 'go backup scheduler email',
      field: 'smtp.origin.remoteAddress',
      expected: 'SMTP connection address',
      actual: remoteAddress,
    })
  }
  if (goAddresses.length === 0) {
    errors.push({
      name: 'go backup scheduler email',
      field: 'smtp.origin.goAddresses',
      expected: `resolved addresses for ${goHost}`,
      actual: goAddresses,
    })
  } else if (!goAddresses.includes(remoteAddress)) {
    errors.push({
      name: 'go backup scheduler email',
      field: 'smtp.origin.remoteAddress',
      expected: goAddresses,
      actual: remoteAddress,
    })
  }
  if (nodeAddresses.includes(remoteAddress)) {
    errors.push({
      name: 'go backup scheduler email',
      field: 'smtp.origin.remoteAddress',
      expected: 'not a Node service address',
      actual: remoteAddress,
    })
  }
  if (errors.length > 0) {
    throw new VerificationFailure(errors)
  }
  return { ...origin, validated: true }
}

export function findSMTPMessageOrigin(events, messageIndex) {
  const messageEvent = (events || []).find(
    (event) =>
      event &&
      event.direction === 'message' &&
      event.messageIndex === messageIndex,
  )
  if (!messageEvent) return ''
  const connection = (events || []).find(
    (event) =>
      event &&
      event.id === messageEvent.id &&
      event.direction === 'connection' &&
      event.remoteAddress,
  )
  return normalizeIPAddress(connection?.remoteAddress || '')
}

async function resolveHostAddresses(host, lookupImpl) {
  const normalized = String(host || '').trim()
  if (!normalized) return []
  try {
    const result = await lookupImpl(normalized, { all: true })
    const addresses = Array.isArray(result) ? result : [result]
    return [
      ...new Set(
        addresses
          .map((entry) => normalizeIPAddress(entry?.address || ''))
          .filter(Boolean),
      ),
    ]
  } catch {
    return []
  }
}

function normalizeIPAddress(address) {
  const value = String(address || '').trim()
  if (value.startsWith('::ffff:')) return value.slice('::ffff:'.length)
  return value
}

async function captureOriginalProvider(api, state) {
  const result = await api.request({
    name: 'capture original backend provider',
    method: 'GET',
    path: PROVIDER_SETTING_PATH,
    expectedBackend: 'node',
  })
  if (['node', 'go'].includes(result.body?.value)) {
    state.originalProvider = result.body.value
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

async function configureSchedulerBackupSettings(api, options) {
  const updates = [
    ['backup.cron', options.cron],
    ['backup.timezone', 'UTC'],
    ['backup.retentionDays', 1],
    ['backup.smtpHost', options.smtpHost],
    ['backup.smtpPort', options.smtpPort],
    ['backup.smtpSecure', false],
    ['backup.smtpUser', ''],
    ['backup.smtpPassword', ''],
    ['backup.mailFrom', `${options.prefix}@chronoframe.local`],
    ['backup.mailTo', verifierRecipients(options.prefix).join(',')],
    ['backup.encryptionPassphrase', verifierPassphrase(options.prefix)],
    ['backup.enabled', true],
  ]
  for (const [key, value] of updates) {
    await api.request({
      name: `configure scheduler system.${key}`,
      method: 'PUT',
      path: `/api/system/settings/system/${key}`,
      expectedBackend: 'node',
      body: { value },
    })
  }
}

async function cleanupSchedulerVerification(
  api,
  state,
  summary,
  { keepFiles },
) {
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

  await cleanup('restore provider to node for cleanup', () =>
    setProvider(api, 'node'),
  )
  if (state.originalSettings.has('backup.enabled')) {
    await cleanup('restore system.backup.enabled', () =>
      api.request({
        name: 'cleanup: restore system.backup.enabled',
        method: 'PUT',
        path: '/api/system/settings/system/backup.enabled',
        expectedBackend: 'node',
        body: { value: state.originalSettings.get('backup.enabled') },
      }),
    )
  }
  for (const [key, value] of [...state.originalSettings.entries()].reverse()) {
    if (key === 'backup.enabled') continue
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
  await cleanup(`restore provider to ${state.originalProvider}`, () =>
    setProvider(api, state.originalProvider),
  )

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
  if (!['node', 'go'].includes(provider)) {
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

function createSchedulerAPI({ base, cookie, timeoutMs, summary, fetchImpl }) {
  return {
    async request(expectation) {
      const requestId = `go-backup-scheduler-${cryptoRandomUUID()}`
      const headers = {
        Accept: 'application/json',
        Cookie: cookie,
        'X-Request-Id': requestId,
      }
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

      const response = await fetchImpl(joinURL(base, expectation.path), options)
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

function validateHTTPResult(expectation, result) {
  const errors = []
  const expectedStatus = expectation.expectedStatus || 200
  if (result.status !== expectedStatus) {
    errors.push({
      name: expectation.name,
      field: 'status',
      expected: expectedStatus,
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
  if (result.contentType !== 'application/json') {
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

function verifierRecipients(prefix) {
  return [`${prefix}-recipient@example.test`, `${prefix}-second@example.test`]
}

function verifierPassphrase(prefix) {
  return `${prefix}-chronoframe-backup-passphrase`
}

function joinURL(baseURL, requestPath) {
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

function cryptoRandomUUID() {
  return randomUUID()
}

class VerificationFailure extends Error {
  constructor(errors) {
    super(errors.map((error) => `${error.name}: ${error.field}`).join(', '))
    this.name = 'VerificationFailure'
    this.errors = errors
  }
}

async function main() {
  const options = parseGoBackupSchedulerVerifierOptions()
  const result = await verifyGoBackupScheduler(options)
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

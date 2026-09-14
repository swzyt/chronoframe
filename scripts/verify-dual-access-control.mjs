#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { pathToFileURL } from 'node:url'

import { createClient } from 'redis'
import Database from 'better-sqlite3'

import { joinBackendURL } from './compare-backends.mjs'
import {
  FIXTURE_ACCESS_PASSWORD,
  FIXTURE_SESSION_TOKEN,
  resolveSQLitePath,
} from './seed-dual-backend-fixture.mjs'

export const DEFAULT_ACCESS_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_ACCESS_ADMIN_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`

const DEFAULT_REDIS_PASSWORD = 'chronoframe-development-only-change-me'
const DEFAULT_SESSION_SECRET = 'chronoframe-dual-development-secret-change-me'
const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'
const ACCESS_VERSION_SETTING_PATH = '/api/system/settings/app/access.version'
const ACCESS_COOKIE_NAME = 'cf_access'
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const ACCESS_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60
const RATE_LIMIT_SECRET_CONTEXT = 'chronoframe:rate-limit:v1'

export function parseAccessVerifierOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (
      ![
        '--base',
        '--go',
        '--admin-cookie',
        '--password',
        '--redis-url',
        '--redis-password',
        '--environment',
        '--db',
        '--timeout-ms',
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

  const baseURL = normalizeBaseURL(
    values.get('--base') ||
      environment.CFRAME_DUAL_BASE_URL ||
      (environment.CFRAME_DUAL_PORT
        ? `http://127.0.0.1:${environment.CFRAME_DUAL_PORT}`
        : DEFAULT_ACCESS_BASE_URL),
  )
  const timeoutMs = parsePositiveInteger(
    values.get('--timeout-ms') || environment.CFRAME_DUAL_TIMEOUT_MS || 5_000,
    'timeout-ms',
  )
  if (timeoutMs > 60_000) {
    throw new Error('timeout-ms must be 60000 or less')
  }

  return {
    baseURL,
    goURL: normalizeBaseURL(
      values.get('--go') ||
        environment.CFRAME_DUAL_GO_URL ||
        `${baseURL}/__lab/go`,
    ),
    adminCookie: normalizeRequiredCookie(
      values.get('--admin-cookie') ||
        environment.CFRAME_DUAL_ADMIN_COOKIE ||
        environment.CFRAME_DUAL_COOKIE ||
        DEFAULT_ACCESS_ADMIN_COOKIE,
    ),
    password:
      values.get('--password') ||
      environment.CFRAME_DUAL_ACCESS_PASSWORD ||
      FIXTURE_ACCESS_PASSWORD,
    redisURL:
      values.get('--redis-url') ||
      environment.CFRAME_REDIS_URL ||
      `redis://127.0.0.1:${environment.CFRAME_DUAL_REDIS_PORT || 36379}/0`,
    redisPassword:
      values.get('--redis-password') ||
      environment.CFRAME_REDIS_PASSWORD ||
      DEFAULT_REDIS_PASSWORD,
    environment:
      values.get('--environment') || environment.CFRAME_ENV || 'development',
    sessionSecret: environment.NUXT_SESSION_PASSWORD || DEFAULT_SESSION_SECRET,
    rateLimitSecret: environment.CFRAME_RATE_LIMIT_SECRET || '',
    databasePath: resolveSQLitePath(
      values.get('--db') || environment.DATABASE_URL || './data/app.sqlite3',
    ),
    settingsCacheVersionKey:
      environment.CFRAME_SETTINGS_CACHE_VERSION_KEY ||
      'chronoframe:settings:version',
    timeoutMs,
  }
}

export async function verifyDualAccessControl({
  baseURL,
  goURL,
  adminCookie = DEFAULT_ACCESS_ADMIN_COOKIE,
  password = FIXTURE_ACCESS_PASSWORD,
  redisURL = 'redis://127.0.0.1:36379/0',
  redisPassword = DEFAULT_REDIS_PASSWORD,
  environment = 'development',
  sessionSecret = DEFAULT_SESSION_SECRET,
  rateLimitSecret = '',
  databasePath = './data/app.sqlite3',
  settingsCacheVersionKey = 'chronoframe:settings:version',
  timeoutMs = 5_000,
  fetchImpl = globalThis.fetch,
  cleanupSharedStateImpl = cleanupSharedState,
  restoreAccessVersionImpl = restoreAccessVersionInSQLite,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function')
  }
  if (typeof cleanupSharedStateImpl !== 'function') {
    throw new Error('cleanupSharedStateImpl must be a function')
  }
  if (typeof restoreAccessVersionImpl !== 'function') {
    throw new Error('restoreAccessVersionImpl must be a function')
  }
  if (!baseURL || !goURL) {
    throw new Error('baseURL and goURL are required')
  }
  assertSharedStateEnvironment(environment)

  const options = {
    baseURL: normalizeBaseURL(baseURL),
    goURL: normalizeBaseURL(goURL),
    adminCookie: normalizeRequiredCookie(adminCookie),
    password: String(password || ''),
    redisURL: String(redisURL || '').trim(),
    redisPassword: String(redisPassword || ''),
    environment,
    sessionSecret: String(sessionSecret || ''),
    rateLimitSecret: String(rateLimitSecret || ''),
    databasePath: resolveSQLitePath(databasePath),
    settingsCacheVersionKey: String(settingsCacheVersionKey || '').trim(),
    timeoutMs: parsePositiveInteger(timeoutMs, 'timeout-ms'),
    fetchImpl,
  }
  if (!options.password) throw new Error('password must not be empty')
  if (!options.redisURL) throw new Error('redisURL must not be empty')
  if (!options.settingsCacheVersionKey) {
    throw new Error('settingsCacheVersionKey must not be empty')
  }

  const checks = []
  const cleanup = []
  const cleanupKeys = new Set()
  let originalProvider = 'node'
  let originalConfig
  let originalVersion

  const parityIP = uniqueTestIP(11)
  const rateLimitIP = uniqueTestIP(29)
  addRateLimitCleanupKeys(cleanupKeys, options, parityIP)
  addRateLimitCleanupKeys(cleanupKeys, options, rateLimitIP)
  for (const address of localClientAddresses()) {
    addRateLimitCleanupKeys(cleanupKeys, options, address)
  }

  try {
    originalProvider = await readProvider(options)
    await setProviderChecked(options, 'node', checks)
    originalConfig = await readAccessConfig(options)
    originalVersion = await readAccessVersion(options)
    assert.equal(
      originalConfig.hasPassword,
      true,
      'fixture must have an existing access password before verification',
    )
    assert.equal(
      Number.isSafeInteger(originalVersion) && originalVersion > 0,
      true,
      'access.version must be a positive safe integer',
    )
    checks.push({ name: 'fixture access baseline captured', ok: true })

    const verificationConfig = {
      enabled: true,
      photoLimit: 1,
      albumLimit: 1,
    }
    const configuredByNode = await updateAccessConfig(
      options,
      verificationConfig,
      'node',
    )
    assert.deepEqual(configuredByNode.body, {
      ...verificationConfig,
      hasPassword: true,
    })
    checks.push({ name: 'Node updated shared access configuration', ok: true })

    const lockedStatus = await expectLockedReadParity(options, checks)
    await expectPreviewPhotoParity(options, lockedStatus, checks)
    await expectWrongPasswordParity(options, parityIP, checks)

    const nodeCookie = validateIssuedAccessCookie(
      await verifyPassword(options, options.baseURL, 'node', parityIP),
      'node',
      checks,
    )
    addAccessCleanupKey(cleanupKeys, options.environment, nodeCookie)
    await expectGrantAcceptedEverywhere(
      options,
      nodeCookie,
      'Node-issued grant accepted by both backends',
      checks,
    )

    await setProviderChecked(options, 'go', checks)
    const goCookie = validateIssuedAccessCookie(
      await verifyPassword(options, options.baseURL, 'go', parityIP),
      'go',
      checks,
    )
    addAccessCleanupKey(cleanupKeys, options.environment, goCookie)
    await setProviderChecked(options, 'node', checks)
    await expectGrantAcceptedEverywhere(
      options,
      goCookie,
      'Go-issued grant accepted by both backends',
      checks,
    )

    await setProviderChecked(options, 'go', checks)
    const configuredByGo = await updateAccessConfig(
      options,
      verificationConfig,
      'go',
    )
    assert.deepEqual(configuredByGo.body, {
      ...verificationConfig,
      hasPassword: true,
    })
    checks.push({
      name: 'Go rotated the shared access version transactionally',
      ok: true,
    })

    await setProviderChecked(options, 'node', checks)
    await expectInvalidGrantParity(
      options,
      nodeCookie,
      'stale Node-issued grant',
      checks,
    )
    await expectInvalidGrantParity(
      options,
      goCookie,
      'stale Go-issued grant',
      checks,
    )
    await expectInvalidGrantParity(
      options,
      `${ACCESS_COOKIE_NAME}=malformed-access-token`,
      'malformed grant',
      checks,
    )

    await expectSharedRateLimit(options, rateLimitIP, checks)
  } finally {
    cleanup.push(
      await cleanupAction('switch to Node for access cleanup', () =>
        setProvider(options, 'node'),
      ),
    )
    if (originalConfig) {
      cleanup.push(
        await cleanupAction('restore access configuration', async () => {
          const restored = await updateAccessConfig(
            options,
            {
              enabled: originalConfig.enabled,
              photoLimit: originalConfig.photoLimit,
              albumLimit: originalConfig.albumLimit,
            },
            'node',
          )
          assert.equal(restored.body.hasPassword, originalConfig.hasPassword)
        }),
      )
    }
    if (originalVersion !== undefined) {
      cleanup.push(
        await cleanupAction('restore exact access.version', async () => {
          const restored = await restoreAccessVersionImpl({
            databasePath: options.databasePath,
            version: originalVersion,
            redisURL: options.redisURL,
            redisPassword: options.redisPassword,
            settingsCacheVersionKey: options.settingsCacheVersionKey,
          })
          assert.equal(restored.version, originalVersion)
        }),
      )
    }
    cleanup.push(
      await cleanupAction('delete verifier-owned Redis keys', async () => {
        const result = await cleanupSharedStateImpl({
          redisURL: options.redisURL,
          redisPassword: options.redisPassword,
          keys: [...cleanupKeys],
        })
        assert.equal(result.residual, 0)
      }),
    )
    cleanup.push(
      await cleanupAction(`restore provider to ${originalProvider}`, () =>
        setProvider(options, originalProvider),
      ),
    )
  }

  const cleanupFailed = cleanup.filter((entry) => !entry.ok).length
  return {
    ok: cleanupFailed === 0,
    baseURL: options.baseURL,
    goURL: options.goURL,
    originalProvider,
    checkCount: checks.length,
    checks,
    cleanupKeyCount: cleanupKeys.size,
    cleanupFailed,
    cleanup,
  }
}

async function expectLockedReadParity(options, checks) {
  const [node, go] = await Promise.all([
    rawRequest(options, options.baseURL, '/api/access/status', {
      expectedBackend: 'node',
    }),
    rawRequest(options, options.goURL, '/api/access/status', {
      expectedBackend: 'go',
    }),
  ])
  for (const result of [node, go]) {
    assertJSONResponse(result, 200)
    assert.equal(result.body?.required, true)
    assert.equal(result.body?.granted, false)
    assert.equal(result.body?.photoLimit, 1)
    assert.equal(result.body?.albumLimit, 1)
    assert.equal(
      findSetCookie(result.setCookies, ACCESS_COOKIE_NAME),
      undefined,
    )
  }
  assert.deepEqual(canonicalize(node.body), canonicalize(go.body))
  checks.push({ name: 'locked access status exact parity', ok: true })
  return node.body
}

async function expectPreviewPhotoParity(options, status, checks) {
  const [node, go] = await Promise.all([
    rawRequest(options, options.baseURL, '/api/photos/visible', {
      expectedBackend: 'node',
    }),
    rawRequest(options, options.goURL, '/api/photos/visible', {
      expectedBackend: 'go',
    }),
  ])
  for (const result of [node, go]) {
    assertJSONResponse(result, 200)
    assert.equal(Array.isArray(result.body), true)
    assert.equal(result.body.length, Math.min(status.totalPhotos, 1))
    assert.equal(
      findSetCookie(result.setCookies, ACCESS_COOKIE_NAME),
      undefined,
    )
  }
  assert.deepEqual(canonicalize(node.body), canonicalize(go.body))
  checks.push({ name: 'locked photo preview exact parity', ok: true })
}

async function expectWrongPasswordParity(options, forwardedFor, checks) {
  const request = (baseURL, expectedBackend) =>
    rawRequest(options, baseURL, '/api/access/verify', {
      method: 'POST',
      body: { password: 'definitely-not-the-access-password' },
      forwardedFor,
      expectedBackend,
    })
  const [node, go] = await Promise.all([
    request(options.baseURL, 'node'),
    request(options.goURL, 'go'),
  ])
  for (const result of [node, go]) {
    assertJSONResponse(result, 401)
    assert.deepEqual(selectError(result.body), {
      statusCode: 401,
      statusMessage: 'Invalid password',
      message: 'Invalid password',
    })
    assert.equal(
      findSetCookie(result.setCookies, ACCESS_COOKIE_NAME),
      undefined,
    )
  }
  assert.deepEqual(selectError(node.body), selectError(go.body))
  checks.push({ name: 'wrong access password exact parity', ok: true })
}

async function verifyPassword(options, baseURL, expectedBackend, forwardedFor) {
  return rawRequest(options, baseURL, '/api/access/verify', {
    method: 'POST',
    body: { password: options.password },
    forwardedFor,
    expectedBackend,
  })
}

function validateIssuedAccessCookie(result, expectedBackend, checks) {
  assertJSONResponse(result, 200)
  assert.deepEqual(result.body, { success: true })
  const rawCookie = findSetCookie(result.setCookies, ACCESS_COOKIE_NAME)
  assert.ok(rawCookie, `${expectedBackend} must issue ${ACCESS_COOKIE_NAME}`)
  const token = rawCookie
    .slice(`${ACCESS_COOKIE_NAME}=`.length)
    .split(';', 1)[0]
  assert.match(token, ACCESS_TOKEN_PATTERN)
  assert.equal(
    rawCookie,
    `${ACCESS_COOKIE_NAME}=${token}; Max-Age=${ACCESS_MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Lax`,
  )
  checks.push({
    name: `${expectedBackend} issued exact shared access Cookie contract`,
    ok: true,
  })
  return `${ACCESS_COOKIE_NAME}=${token}`
}

async function expectGrantAcceptedEverywhere(options, cookie, name, checks) {
  const [node, go] = await Promise.all([
    rawRequest(options, options.baseURL, '/api/access/status', {
      cookie,
      expectedBackend: 'node',
    }),
    rawRequest(options, options.goURL, '/api/access/status', {
      cookie,
      expectedBackend: 'go',
    }),
  ])
  for (const result of [node, go]) {
    assertJSONResponse(result, 200)
    assert.equal(result.body?.required, true)
    assert.equal(result.body?.granted, true)
    assert.equal(
      findSetCookie(result.setCookies, ACCESS_COOKIE_NAME),
      undefined,
    )
  }
  assert.deepEqual(canonicalize(node.body), canonicalize(go.body))
  checks.push({ name, ok: true })
}

async function expectInvalidGrantParity(options, cookie, label, checks) {
  const [node, go] = await Promise.all([
    rawRequest(options, options.baseURL, '/api/access/status', {
      cookie,
      expectedBackend: 'node',
    }),
    rawRequest(options, options.goURL, '/api/access/status', {
      cookie,
      expectedBackend: 'go',
    }),
  ])
  const expectedClear = `${ACCESS_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`
  for (const result of [node, go]) {
    assertJSONResponse(result, 200)
    assert.equal(result.body?.required, true)
    assert.equal(result.body?.granted, false)
    assert.equal(
      findSetCookie(result.setCookies, ACCESS_COOKIE_NAME),
      expectedClear,
    )
  }
  assert.deepEqual(canonicalize(node.body), canonicalize(go.body))
  checks.push({
    name: `${label} rejection and Cookie clearing parity`,
    ok: true,
  })
}

async function expectSharedRateLimit(options, forwardedFor, checks) {
  const invalidPassword = { password: 'shared-rate-limit-wrong-password' }
  for (let index = 0; index < 5; index += 1) {
    const expectedBackend = index % 2 === 0 ? 'node' : 'go'
    const baseURL = expectedBackend === 'node' ? options.baseURL : options.goURL
    const result = await rawRequest(options, baseURL, '/api/access/verify', {
      method: 'POST',
      body: invalidPassword,
      forwardedFor,
      expectedBackend,
    })
    assertJSONResponse(result, 401)
    assert.deepEqual(selectError(result.body), {
      statusCode: 401,
      statusMessage: 'Invalid password',
      message: 'Invalid password',
    })
  }
  checks.push({
    name: 'five failed attempts accumulated across Node and Go',
    ok: true,
  })

  const [go, node] = await Promise.all([
    rawRequest(options, options.goURL, '/api/access/verify', {
      method: 'POST',
      body: invalidPassword,
      forwardedFor,
      expectedBackend: 'go',
    }),
    rawRequest(options, options.baseURL, '/api/access/verify', {
      method: 'POST',
      body: invalidPassword,
      forwardedFor,
      expectedBackend: 'node',
    }),
  ])
  for (const result of [node, go]) {
    assertJSONResponse(result, 429)
    assert.deepEqual(selectError(result.body), {
      statusCode: 429,
      statusMessage: 'Too many attempts',
      message: 'Too many attempts',
    })
    assert.equal(Number.parseInt(result.retryAfter, 10) > 0, true)
    assert.equal(
      findSetCookie(result.setCookies, ACCESS_COOKIE_NAME),
      undefined,
    )
  }
  checks.push({
    name: 'shared Redis access rate limit enforced by both backends',
    ok: true,
  })
}

async function readAccessConfig(options) {
  const result = await rawRequest(
    options,
    options.baseURL,
    '/api/access/config',
    {
      cookie: options.adminCookie,
      expectedBackend: 'node',
    },
  )
  assertJSONResponse(result, 200)
  return result.body
}

async function updateAccessConfig(options, config, expectedBackend) {
  const result = await rawRequest(
    options,
    options.baseURL,
    '/api/access/config',
    {
      method: 'PUT',
      cookie: options.adminCookie,
      body: config,
      expectedBackend,
    },
  )
  assertJSONResponse(result, 200)
  return result
}

async function readAccessVersion(options) {
  const result = await controlRequest(options, {
    method: 'GET',
    path: ACCESS_VERSION_SETTING_PATH,
  })
  return result.body?.value
}

async function setProviderChecked(options, provider, checks) {
  const result = await setProvider(options, provider)
  assert.equal(result?.value, provider)
  checks.push({ name: `switch API provider to ${provider}`, ok: true })
}

async function readProvider(options) {
  const result = await controlRequest(options, {
    method: 'GET',
    path: PROVIDER_SETTING_PATH,
  })
  return result.body?.value === 'go' ? 'go' : 'node'
}

async function setProvider(options, provider) {
  const result = await controlRequest(options, {
    method: 'PUT',
    path: PROVIDER_SETTING_PATH,
    body: { value: provider },
  })
  return result.body
}

async function controlRequest(options, { method, path, body }) {
  const result = await rawRequest(options, options.baseURL, path, {
    method,
    cookie: options.adminCookie,
    body,
    expectedBackend: 'node',
  })
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `${method} ${path} returned ${result.status}: ${result.body?.statusMessage || result.text}`,
    )
  }
  return result
}

async function rawRequest(
  options,
  baseURL,
  path,
  { method = 'GET', cookie, body, forwardedFor, expectedBackend } = {},
) {
  const requestId = `dual-access-${randomUUID()}`
  const headers = {
    Accept: 'application/json',
    'Accept-Language': 'en',
    'X-Request-Id': requestId,
  }
  if (cookie) headers.Cookie = cookie
  if (forwardedFor) headers['X-Forwarded-For'] = forwardedFor
  const payload = body === undefined ? undefined : JSON.stringify(body)
  if (payload !== undefined) headers['Content-Type'] = 'application/json'
  const response = await options.fetchImpl(joinBackendURL(baseURL, path), {
    method,
    headers,
    body: payload,
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs),
  })
  const text = await response.text()
  const result = {
    status: response.status,
    backend: response.headers.get('x-chronoframe-backend'),
    requestId: response.headers.get('x-request-id'),
    contentType: normalizedContentType(response.headers.get('content-type')),
    setCookies: getSetCookies(response.headers),
    retryAfter: response.headers.get('retry-after'),
    body: parseJSONBody(text),
    text,
  }
  assert.equal(result.requestId, requestId, `${method} ${path} request id`)
  if (expectedBackend !== undefined) {
    assert.equal(result.backend, expectedBackend, `${method} ${path} backend`)
  }
  return result
}

export async function cleanupSharedState({ redisURL, redisPassword, keys }) {
  const client = createClient({
    url: redisURL,
    password: redisPassword || undefined,
  })
  try {
    await client.connect()
    const uniqueKeys = [...new Set(keys)].filter(Boolean)
    const deleted = uniqueKeys.length > 0 ? await client.del(uniqueKeys) : 0
    const residual = uniqueKeys.length > 0 ? await client.exists(uniqueKeys) : 0
    return { keyCount: uniqueKeys.length, deleted, residual }
  } finally {
    if (client.isOpen) await client.quit()
  }
}

export async function restoreAccessVersionInSQLite({
  databasePath,
  version,
  redisURL,
  redisPassword,
  settingsCacheVersionKey,
}) {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('access.version restore value must be a positive integer')
  }
  const database = new Database(resolveSQLitePath(databasePath))
  try {
    const result = database
      .prepare(
        `UPDATE settings
         SET value = ?, updated_at = unixepoch()
         WHERE namespace = 'app' AND key = 'access.version'`,
      )
      .run(String(version))
    assert.equal(result.changes, 1, 'access.version restore row count')
    const row = database
      .prepare(
        `SELECT value FROM settings
         WHERE namespace = 'app' AND key = 'access.version'`,
      )
      .get()
    assert.equal(Number(row?.value), version)
  } finally {
    database.close()
  }

  const client = createClient({
    url: redisURL,
    password: redisPassword || undefined,
  })
  try {
    await client.connect()
    await client.incr(settingsCacheVersionKey)
  } finally {
    if (client.isOpen) await client.quit()
  }
  return { version }
}

function addAccessCleanupKey(keys, environment, cookie) {
  const token = cookie.slice(`${ACCESS_COOKIE_NAME}=`.length)
  keys.add(
    `cf:v1:${environment}:access:${createHash('sha256').update(token).digest('hex')}`,
  )
}

function addRateLimitCleanupKeys(keys, options, subject) {
  const secret = effectiveRateLimitSecret(options)
  const digest = createHmac('sha256', secret).update(subject).digest('hex')
  const currentWindow = Math.floor(
    Date.now() / 1_000 / RATE_LIMIT_WINDOW_SECONDS,
  )
  for (const window of [currentWindow - 1, currentWindow, currentWindow + 1]) {
    keys.add(
      `cf:v1:${options.environment}:ratelimit:access:${digest}:${window}`,
    )
  }
}

function effectiveRateLimitSecret(options) {
  if (options.rateLimitSecret) {
    if (options.rateLimitSecret.length < 32) {
      throw new Error(
        'CFRAME_RATE_LIMIT_SECRET must contain at least 32 characters',
      )
    }
    return options.rateLimitSecret
  }
  if (options.sessionSecret.length < 32) {
    throw new Error(
      'CFRAME_RATE_LIMIT_SECRET or NUXT_SESSION_PASSWORD must contain at least 32 characters',
    )
  }
  return createHmac('sha256', options.sessionSecret)
    .update(RATE_LIMIT_SECRET_CONTEXT)
    .digest()
}

function uniqueTestIP(offset) {
  const value = createHash('sha256')
    .update(randomUUID())
    .digest()
    .readUInt16BE(0)
  return `198.18.${offset}.${(value % 250) + 1}`
}

function localClientAddresses() {
  const addresses = new Set(['127.0.0.1', '::1'])
  for (const candidates of Object.values(networkInterfaces())) {
    for (const candidate of candidates || []) {
      if (candidate.address) addresses.add(candidate.address)
    }
  }
  return addresses
}

function assertJSONResponse(result, status) {
  assert.equal(result.status, status)
  assert.equal(result.contentType, 'application/json')
}

function selectError(body) {
  return {
    statusCode: body?.statusCode,
    statusMessage: body?.statusMessage,
    message: body?.message,
  }
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie()
  }
  const combined = headers.get('set-cookie')
  if (!combined) return []
  return combined.split(/,(?=\s*[^;,=\s]+=[^;,]*)/).map((value) => value.trim())
}

function findSetCookie(cookies, name) {
  return cookies.find((cookie) =>
    cookie.toLowerCase().startsWith(`${name.toLowerCase()}=`),
  )
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

async function cleanupAction(name, action) {
  try {
    await action()
    return { name, ok: true }
  } catch (error) {
    return {
      name,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function parseJSONBody(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { parseError: true, raw: text.slice(0, 500) }
  }
}

function normalizedContentType(value) {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || ''
}

function normalizeBaseURL(value) {
  const url = new URL(value)
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/g, '') || '/'
  return url.toString().replace(/\/$/g, '')
}

function normalizeRequiredCookie(value) {
  const cookie = String(value || '').trim()
  if (!cookie) throw new Error('admin-cookie must not be empty')
  return cookie
}

function assertSharedStateEnvironment(value) {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(value)) {
    throw new Error('environment has an invalid shared-state namespace')
  }
}

function parsePositiveInteger(value, label) {
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return parsed
}

async function main() {
  const result = await verifyDualAccessControl(parseAccessVerifierOptions())
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.stack || error.message)
    process.exitCode = 1
  })
}

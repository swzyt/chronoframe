#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import Database from 'better-sqlite3'
import { createClient } from 'redis'

import {
  FIXTURE_ADMIN_EMAIL,
  FIXTURE_SESSION_TOKEN,
} from './seed-dual-backend-fixture.mjs'

export const WIZARD_ROUTE_IDS = Object.freeze([
  'wizard.admin',
  'wizard.complete',
  'wizard.map',
  'wizard.schema',
  'wizard.site',
  'wizard.storage',
  'wizard.submit',
])

export const WIZARD_CASES = Object.freeze([
  'all schema namespaces and secret redaction',
  'exact Zod validation envelopes for every write route',
  'admin password update and cross-runtime identity visibility',
  'site settings cross-runtime visibility',
  'local storage provider cross-runtime visibility',
  'S3 defaults and normalized storage config',
  'OpenList defaults and normalized storage config',
  'Mapbox, MapLibre, and AMap settings persistence',
  'complete closes every setup-only route',
  'submit persists the full setup and issues a cross-runtime session',
  'database, settings cache, session, and provider cleanup',
])

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000'
const DEFAULT_DATABASE_PATH = './data/app.sqlite3'
const DEFAULT_REDIS_PASSWORD = 'chronoframe-development-only-change-me'
const DEFAULT_SETTINGS_VERSION_KEY = 'chronoframe:settings:version'
const ADMIN_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`
const WIZARD_PASSWORD = 'WizardParity123!'
const TRACKED_SETTINGS = Object.freeze([
  ['system', 'firstLaunch'],
  ['app', 'title'],
  ['app', 'slogan'],
  ['app', 'avatarUrl'],
  ['app', 'author'],
  ['storage', 'provider'],
  ['map', 'provider'],
  ['map', 'mapbox.token'],
  ['map', 'mapbox.style'],
  ['map', 'maplibre.token'],
  ['map', 'maplibre.style'],
  ['map', 'amap.key'],
  ['map', 'amap.securityJsCode'],
])

export function parseWizardVerifierOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--') continue
    if (
      ![
        '--base',
        '--node',
        '--go',
        '--db',
        '--redis-url',
        '--redis-password',
        '--settings-version-key',
        '--timeout-ms',
      ].includes(option)
    ) {
      throw new Error(`Unknown option: ${option}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${option} requires a value`)
    }
    values.set(option, value)
    index += 1
  }

  const base = normalizeBaseURL(
    values.get('--base') ||
      environment.CFRAME_DUAL_BASE_URL ||
      (environment.CFRAME_DUAL_PORT
        ? `http://127.0.0.1:${environment.CFRAME_DUAL_PORT}`
        : DEFAULT_BASE_URL),
  )
  const timeoutMs = Number(
    values.get('--timeout-ms') || environment.CFRAME_DUAL_TIMEOUT_MS || 10_000,
  )
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('--timeout-ms must be an integer between 1 and 60000')
  }

  return {
    base,
    nodeURL: normalizeBaseURL(
      values.get('--node') || environment.CFRAME_DUAL_NODE_URL || base,
    ),
    goURL: normalizeBaseURL(
      values.get('--go') ||
        environment.CFRAME_DUAL_GO_URL ||
        `${base}/__lab/go`,
    ),
    databasePath:
      values.get('--db') ||
      environment.CFRAME_DUAL_DATABASE_PATH ||
      DEFAULT_DATABASE_PATH,
    redisURL:
      values.get('--redis-url') ||
      environment.CFRAME_DUAL_REDIS_URL ||
      environment.CFRAME_REDIS_URL ||
      `redis://127.0.0.1:${environment.CFRAME_DUAL_REDIS_PORT || 36379}/0`,
    redisPassword:
      values.get('--redis-password') ||
      environment.CFRAME_DUAL_REDIS_PASSWORD ||
      environment.CFRAME_REDIS_PASSWORD ||
      DEFAULT_REDIS_PASSWORD,
    settingsVersionKey:
      values.get('--settings-version-key') ||
      environment.CFRAME_SETTINGS_CACHE_VERSION_KEY ||
      DEFAULT_SETTINGS_VERSION_KEY,
    timeoutMs,
  }
}

export async function verifyDualWizard(options = {}) {
  const normalized = {
    ...parseWizardVerifierOptions([], {}),
    ...options,
  }
  normalized.base = normalizeBaseURL(normalized.base)
  normalized.nodeURL = normalizeBaseURL(normalized.nodeURL)
  normalized.goURL = normalizeBaseURL(normalized.goURL)
  if (!normalized.database && !existsSync(normalized.databasePath)) {
    throw new Error(
      `SQLite database does not exist: ${normalized.databasePath}`,
    )
  }

  const ownsDatabase = !normalized.database
  const database =
    normalized.database ||
    new Database(normalized.databasePath, { timeout: normalized.timeoutMs })
  database.pragma('foreign_keys = ON')
  database.pragma(`busy_timeout = ${normalized.timeoutMs}`)

  const ownsRedis = !normalized.redis
  const redis =
    normalized.redis ||
    createClient({
      url: normalized.redisURL,
      password: normalized.redisPassword || undefined,
    })
  if (ownsRedis) await redis.connect()

  const baseline = captureBaseline(database)
  const summary = {
    ok: false,
    base: normalized.base,
    databasePath: normalized.databasePath,
    routeIds: [...WIZARD_ROUTE_IDS],
    cases: [...WIZARD_CASES],
    checks: [],
    cleanup: [],
  }
  const issuedCookies = new Set()

  const runtime = {
    ...normalized,
    database,
    redis,
    baseline,
    summary,
    issuedCookies,
    fetchImpl: normalized.fetchImpl || globalThis.fetch,
  }
  if (typeof runtime.fetchImpl !== 'function') {
    throw new Error('fetch is not available')
  }

  try {
    assert.equal(
      baseline.provider,
      'node',
      'wizard verification requires backend.readProvider=node',
    )
    await verifyClosedWizard(runtime)
    await verifySchemas(runtime)
    await verifyValidation(runtime)

    const successCases = createSuccessCases()
    for (const testCase of successCases) {
      await verifySuccessCase(runtime, testCase)
    }

    summary.ok = true
  } finally {
    for (const cookie of issuedCookies) {
      await logoutEverywhere(runtime, cookie).catch(() => {})
    }
    try {
      await restoreBaseline(runtime)
      assertBaselineRestored(database, baseline)
      summary.cleanup.push({
        name: 'restore wizard database rows and shared settings cache version',
        ok: true,
      })
    } catch (error) {
      summary.ok = false
      summary.cleanup.push({
        name: 'restore wizard database rows and shared settings cache version',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    if (ownsRedis && redis.isOpen) await redis.quit()
    if (ownsDatabase) database.close()
  }

  summary.checkCount = summary.checks.length
  if (!summary.cleanup.every((entry) => entry.ok)) summary.ok = false
  return summary
}

function createSuccessCases() {
  return [
    {
      id: 'wizard.admin',
      path: '/api/wizard/admin',
      body: {
        email: FIXTURE_ADMIN_EMAIL,
        password: WIZARD_PASSWORD,
        username: 'wizard-parity-admin',
        ignored: true,
      },
      verifyCrossRuntime: verifyAdminCrossRuntime,
    },
    {
      id: 'wizard.site',
      path: '/api/wizard/site',
      body: {
        title: 'Wizard Parity Site',
        slogan: 'Node and Go share one timeline',
        avatarUrl: '/wizard-avatar.png',
        author: 'ChronoFrame Wizard',
        ignored: true,
      },
      verifyCrossRuntime: verifySiteCrossRuntime,
    },
    {
      id: 'wizard.storage',
      name: 'wizard.storage local',
      path: '/api/wizard/storage',
      body: {
        name: 'Wizard Local',
        config: {
          provider: 'local',
          basePath: '/app/data/wizard-storage',
          baseUrl: '/wizard-storage',
          prefix: 'wizard/',
          ignored: true,
        },
      },
      verifyCrossRuntime: verifyStorageCrossRuntime,
    },
    {
      id: 'wizard.storage',
      name: 'wizard.storage S3 defaults',
      path: '/api/wizard/storage',
      body: {
        name: 'Wizard S3',
        config: {
          provider: 's3',
          bucket: 'wizard-bucket',
          endpoint: 'https://s3.example.test',
          accessKeyId: 'wizard-key',
          secretAccessKey: 'wizard-secret',
          ignored: true,
        },
      },
      verifyCrossRuntime: verifyStorageCrossRuntime,
    },
    {
      id: 'wizard.storage',
      name: 'wizard.storage OpenList defaults',
      path: '/api/wizard/storage',
      body: {
        name: 'Wizard OpenList',
        config: {
          provider: 'openlist',
          baseUrl: 'https://openlist.example.test',
          rootPath: '/wizard',
          token: 'wizard-openlist-token',
          ignored: true,
        },
      },
      verifyCrossRuntime: verifyStorageCrossRuntime,
    },
    ...[
      {
        provider: 'mapbox',
        token: 'wizard-mapbox-token',
        style: 'mapbox://styles/wizard',
      },
      {
        provider: 'maplibre',
        token: 'wizard-maplibre-token',
        style: 'https://maps.example.test/style.json',
      },
      {
        provider: 'amap',
        key: 'wizard-amap-key',
        securityJsCode: 'wizard-amap-security',
      },
    ].map((body) => ({
      id: 'wizard.map',
      name: `wizard.map ${body.provider}`,
      path: '/api/wizard/map',
      body,
      verifyCrossRuntime: verifyMapCrossRuntime,
    })),
    {
      id: 'wizard.complete',
      path: '/api/wizard/complete',
      body: undefined,
      verifyCrossRuntime: verifyCompleteCrossRuntime,
    },
    {
      id: 'wizard.submit',
      path: '/api/wizard/submit',
      body: {
        admin: {
          email: FIXTURE_ADMIN_EMAIL,
          password: WIZARD_PASSWORD,
          username: 'wizard-submit-admin',
        },
        site: {
          title: 'Wizard Submit Site',
          slogan: 'Full setup parity',
          author: 'ChronoFrame',
        },
        storage: {
          name: 'Wizard Submit OpenList',
          config: {
            provider: 'openlist',
            baseUrl: 'https://openlist.example.test',
            rootPath: '/submit',
            token: 'submit-token',
          },
        },
        map: {
          provider: 'maplibre',
          token: 'submit-map-token',
          style: 'https://maps.example.test/submit.json',
        },
        ignored: true,
      },
      verifyCrossRuntime: verifySubmitCrossRuntime,
    },
  ]
}

async function verifyClosedWizard(runtime) {
  await restoreBaseline(runtime)
  const results = await requestPair(runtime, {
    name: 'setup-only routes reject requests after completion',
    path: '/api/wizard/schema?namespace=admin',
  })
  assert.equal(results.node.status, 403)
  assert.deepEqual(results.node.body, results.go.body)
}

async function verifySchemas(runtime) {
  await restoreBaseline(runtime)
  await openWizard(runtime)
  for (const namespace of ['admin', 'storage', 'app', 'map', 'unknown']) {
    const results = await requestPair(runtime, {
      name: `wizard.schema ${namespace}`,
      path: `/api/wizard/schema?namespace=${namespace}`,
    })
    assert.equal(results.node.status, 200)
    assert.deepEqual(results.node.body, results.go.body)
    if (namespace === 'storage') {
      const secrets = results.node.body.fields.filter((field) =>
        ['s3.secretAccessKey', 'openlist.token'].includes(field.key),
      )
      assert.equal(secrets.length, 2)
      assert.ok(
        secrets.every(
          (field) =>
            field.value === '' &&
            field.defaultValue === '' &&
            field.ui?.type === 'password',
        ),
      )
    }
  }
}

async function verifyValidation(runtime) {
  const cases = [
    ['wizard.admin empty object', '/api/wizard/admin', {}],
    ['wizard.site empty object', '/api/wizard/site', {}],
    ['wizard.storage empty object', '/api/wizard/storage', {}],
    [
      'wizard.storage missing discriminator',
      '/api/wizard/storage',
      { name: 'storage', config: {} },
    ],
    ['wizard.map empty object', '/api/wizard/map', {}],
    [
      'wizard.map field types',
      '/api/wizard/map',
      { provider: 'amap', key: 42, securityJsCode: null },
    ],
    ['wizard.submit empty object', '/api/wizard/submit', {}],
  ]
  for (const [name, path, body] of cases) {
    await restoreBaseline(runtime)
    await openWizard(runtime)
    const results = await requestPair(runtime, {
      name,
      path,
      method: 'POST',
      body,
    })
    assert.equal(results.node.status, 400)
    assert.deepEqual(results.node.body, results.go.body)
  }
}

async function verifySuccessCase(runtime, testCase) {
  const results = {}
  const states = {}
  for (const provider of ['node', 'go']) {
    await restoreBaseline(runtime)
    await openWizard(runtime)
    const result = await request(runtime, provider, {
      name: `${testCase.name || testCase.id} via ${provider}`,
      path: testCase.path,
      method: 'POST',
      body: testCase.body,
    })
    assert.equal(result.status, 200, `${testCase.id} ${provider} status`)
    assert.deepEqual(result.body, successBody(testCase.id, result.body))
    if (testCase.id === 'wizard.submit') {
      validateSessionCookie(result)
      runtime.issuedCookies.add(result.sessionCookie)
    } else {
      assert.equal(
        result.setCookies.length,
        0,
        `${testCase.id} ${provider} cookie`,
      )
    }
    await testCase.verifyCrossRuntime(runtime, provider, result, testCase)
    results[provider] = normalizeSuccessResponse(testCase.id, result)
    states[provider] = captureSemanticState(runtime.database, runtime.baseline)
  }
  assert.deepEqual(results.node, results.go, `${testCase.id} response parity`)
  assert.deepEqual(
    states.node,
    states.go,
    `${testCase.id} persisted state parity`,
  )
}

function successBody(id, body) {
  if (id === 'wizard.storage') {
    assert.equal(body?.success, true)
    assert.equal(Number.isSafeInteger(body?.id), true)
    return { success: true, id: body.id }
  }
  return { success: true }
}

async function verifyAdminCrossRuntime(runtime, provider, _result, testCase) {
  const opposite = provider === 'node' ? 'go' : 'node'
  const login = await request(runtime, provider, {
    name: `${testCase.id} ${provider} password accepted`,
    path: '/api/login',
    method: 'POST',
    body: { email: FIXTURE_ADMIN_EMAIL, password: WIZARD_PASSWORD },
  })
  assert.equal(login.status, 201)
  validateSessionCookie(login)
  runtime.issuedCookies.add(login.sessionCookie)
  const profile = await request(runtime, opposite, {
    name: `${testCase.id} ${provider} write visible to ${opposite}`,
    path: '/api/profile',
    cookie: login.sessionCookie,
  })
  assert.equal(profile.status, 200)
  assert.equal(profile.body.username, testCase.body.username)
  await logoutEverywhere(runtime, login.sessionCookie)
  runtime.issuedCookies.delete(login.sessionCookie)
}

async function verifySiteCrossRuntime(runtime, provider, _result, testCase) {
  const opposite = provider === 'node' ? 'go' : 'node'
  const schema = await request(runtime, opposite, {
    name: `${testCase.id} ${provider} write visible to ${opposite}`,
    path: '/api/wizard/schema?namespace=app',
  })
  assert.equal(schema.status, 200)
  const values = Object.fromEntries(
    schema.body.fields.map((field) => [field.key, field.value]),
  )
  assert.equal(values.title, testCase.body.title)
  assert.equal(values.slogan, testCase.body.slogan)
  assert.equal(values.author, testCase.body.author)
}

async function verifyStorageCrossRuntime(runtime, provider, result, testCase) {
  const opposite = provider === 'node' ? 'go' : 'node'
  const storage = await request(runtime, opposite, {
    name: `${testCase.name || testCase.id} ${provider} write visible to ${opposite}`,
    path: `/api/system/settings/storage-config/${result.body.id}`,
    cookie: ADMIN_COOKIE,
  })
  assert.equal(storage.status, 200)
  assert.equal(storage.body.provider, testCase.body.config.provider)
  assert.equal(storage.body.name, testCase.body.name)
  assert.equal('ignored' in storage.body.config, false)
}

async function verifyMapCrossRuntime(runtime, provider, _result, testCase) {
  const opposite = provider === 'node' ? 'go' : 'node'
  const schema = await request(runtime, opposite, {
    name: `${testCase.name} ${provider} write visible to ${opposite}`,
    path: '/api/wizard/schema?namespace=map',
  })
  assert.equal(schema.status, 200)
  const values = Object.fromEntries(
    schema.body.fields.map((field) => [field.key, field.value]),
  )
  assert.equal(values.provider, testCase.body.provider)
  if (testCase.body.style) {
    assert.equal(values[`${testCase.body.provider}.style`], testCase.body.style)
  }
  for (const key of [
    'mapbox.token',
    'maplibre.token',
    'amap.key',
    'amap.securityJsCode',
  ]) {
    assert.equal(values[key], '', `${key} must remain redacted`)
  }
}

async function verifyCompleteCrossRuntime(runtime, provider) {
  const opposite = provider === 'node' ? 'go' : 'node'
  const closed = await request(runtime, opposite, {
    name: `wizard.complete via ${provider} closes ${opposite}`,
    path: '/api/wizard/schema?namespace=admin',
  })
  assert.equal(closed.status, 403)
}

async function verifySubmitCrossRuntime(runtime, provider, result, testCase) {
  const opposite = provider === 'node' ? 'go' : 'node'
  const profile = await request(runtime, opposite, {
    name: `wizard.submit ${provider} session accepted by ${opposite}`,
    path: '/api/profile',
    cookie: result.sessionCookie,
  })
  assert.equal(profile.status, 200)
  assert.equal(profile.body.email, FIXTURE_ADMIN_EMAIL)
  assert.equal(profile.body.username, testCase.body.admin.username)
  const storageID = result.body.id || activeStorageID(runtime.database)
  const storage = await request(runtime, opposite, {
    name: `wizard.submit ${provider} storage visible to ${opposite}`,
    path: `/api/system/settings/storage-config/${storageID}`,
    cookie: result.sessionCookie,
  })
  assert.equal(storage.status, 200)
  assert.equal(storage.body.provider, 'openlist')
  await logoutEverywhere(runtime, result.sessionCookie)
  runtime.issuedCookies.delete(result.sessionCookie)
}

async function requestPair(runtime, input) {
  const node = await request(runtime, 'node', input)
  const go = await request(runtime, 'go', input)
  assert.equal(node.status, go.status, `${input.name} status`)
  assert.equal(node.contentType, go.contentType, `${input.name} content type`)
  assert.equal(node.setCookies.length, 0, `${input.name} Node cookie`)
  assert.equal(go.setCookies.length, 0, `${input.name} Go cookie`)
  return { node, go }
}

async function request(
  runtime,
  provider,
  { name, path, method = 'GET', body, cookie = '' },
) {
  const requestID = `dual-wizard-${randomUUID()}`
  const headers = {
    Accept: 'application/json',
    'Accept-Language': 'en',
    'X-Request-Id': requestID,
  }
  if (cookie) headers.Cookie = cookie
  let payload
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const baseURL = provider === 'node' ? runtime.nodeURL : runtime.goURL
  const response = await runtime.fetchImpl(`${baseURL}${path}`, {
    method,
    headers,
    body: payload,
    redirect: 'manual',
    signal: AbortSignal.timeout(runtime.timeoutMs),
  })
  const text = await response.text()
  const result = {
    name,
    provider,
    method,
    path,
    status: response.status,
    backend: response.headers.get('x-chronoframe-backend'),
    requestID: response.headers.get('x-request-id'),
    contentType: normalizeContentType(response.headers.get('content-type')),
    setCookies: getSetCookies(response.headers),
    body: parseBody(text),
  }
  assert.equal(result.backend, provider, `${name} backend`)
  assert.equal(result.requestID, requestID, `${name} request id`)
  if (result.setCookies.length > 0) {
    result.sessionCookie = extractSessionCookie(result.setCookies)
  }
  runtime.summary.checks.push(result)
  return result
}

function normalizeSuccessResponse(id, result) {
  return {
    status: result.status,
    contentType: result.contentType,
    body: result.body,
    session: id === 'wizard.submit' ? normalizeCookie(result.setCookies) : null,
  }
}

function validateSessionCookie(result) {
  assert.ok(result.sessionCookie, `${result.name} session cookie`)
  assert.match(result.sessionCookie, /^cf_session=[A-Za-z0-9_-]{43}$/)
  const normalized = normalizeCookie(result.setCookies)
  assert.deepEqual(normalized, {
    name: 'cf_session',
    maxAge: 2_592_000,
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
  })
}

function normalizeCookie(setCookies) {
  const raw = setCookies.find((value) => value.startsWith('cf_session='))
  assert.ok(raw, 'cf_session Set-Cookie header is required')
  const parts = raw.split(';').map((part) => part.trim())
  const attributes = new Map()
  for (const part of parts.slice(1)) {
    const [name, ...rest] = part.split('=')
    attributes.set(name.toLowerCase(), rest.join('=') || true)
  }
  return {
    name: 'cf_session',
    maxAge: Number(attributes.get('max-age')),
    path: attributes.get('path'),
    httpOnly: attributes.has('httponly'),
    sameSite: String(attributes.get('samesite')).toLowerCase(),
    secure: attributes.has('secure'),
  }
}

function extractSessionCookie(setCookies) {
  const raw = setCookies.find((value) => value.startsWith('cf_session='))
  return raw ? raw.split(';', 1)[0] : ''
}

async function logoutEverywhere(runtime, cookie) {
  for (const provider of ['node', 'go']) {
    await runtime.fetchImpl(
      `${provider === 'node' ? runtime.nodeURL : runtime.goURL}/api/logout`,
      {
        method: 'GET',
        headers: { Cookie: cookie },
        signal: AbortSignal.timeout(runtime.timeoutMs),
      },
    )
  }
}

function captureBaseline(database) {
  const user = database
    .prepare('SELECT * FROM users WHERE email = ?')
    .get(FIXTURE_ADMIN_EMAIL)
  assert.ok(user, `fixture administrator ${FIXTURE_ADMIN_EMAIL} is required`)
  const settings = TRACKED_SETTINGS.map(([namespace, key]) => {
    const row = database
      .prepare(
        'SELECT id, namespace, key, value, updated_at, updated_by FROM settings WHERE namespace = ? AND key = ?',
      )
      .get(namespace, key)
    assert.ok(row, `required setting ${namespace}.${key} is missing`)
    return row
  })
  const providers = database
    .prepare('SELECT * FROM settings_storage_providers ORDER BY id')
    .all()
  const sequences = database
    .prepare(
      "SELECT name, seq FROM sqlite_sequence WHERE name IN ('users', 'settings_storage_providers') ORDER BY name",
    )
    .all()
  const provider = database
    .prepare(
      "SELECT value FROM settings WHERE namespace = 'system' AND key = 'backend.readProvider'",
    )
    .get()?.value
  return { user, settings, providers, sequences, provider }
}

async function openWizard(runtime) {
  const changed = runtime.database
    .prepare(
      "UPDATE settings SET value = 'true' WHERE namespace = 'system' AND key = 'firstLaunch'",
    )
    .run()
  assert.equal(changed.changes, 1)
  await runtime.redis.incr(runtime.settingsVersionKey)
}

async function restoreBaseline(runtime) {
  const { database, baseline } = runtime
  const restore = database.transaction(() => {
    for (const row of baseline.settings) {
      database
        .prepare(
          `UPDATE settings
           SET value = ?, updated_at = ?, updated_by = ?
           WHERE id = ?`,
        )
        .run(row.value, row.updated_at, row.updated_by, row.id)
    }
    restoreFullRow(database, 'users', baseline.user, 'id')

    const providerIDs = baseline.providers.map((provider) => provider.id)
    if (providerIDs.length === 0) {
      database.prepare('DELETE FROM settings_storage_providers').run()
    } else {
      const placeholders = providerIDs.map(() => '?').join(',')
      database
        .prepare(
          `DELETE FROM settings_storage_providers WHERE id NOT IN (${placeholders})`,
        )
        .run(...providerIDs)
      for (const provider of baseline.providers) {
        restoreFullRow(database, 'settings_storage_providers', provider, 'id')
      }
    }

    for (const name of ['users', 'settings_storage_providers']) {
      const sequence = baseline.sequences.find((row) => row.name === name)
      if (sequence) {
        database
          .prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?')
          .run(sequence.seq, name)
      } else {
        database.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(name)
      }
    }
  })
  restore()
  await runtime.redis.incr(runtime.settingsVersionKey)
}

function restoreFullRow(database, table, row, primaryKey) {
  const columns = Object.keys(row).filter((column) => column !== primaryKey)
  const assignments = columns.map((column) => `"${column}" = ?`).join(', ')
  database
    .prepare(`UPDATE "${table}" SET ${assignments} WHERE "${primaryKey}" = ?`)
    .run(...columns.map((column) => row[column]), row[primaryKey])
}

function captureSemanticState(database, baseline) {
  const user = database
    .prepare(
      'SELECT id, name, email, is_admin, is_active, auth_version FROM users WHERE id = ?',
    )
    .get(baseline.user.id)
  const settings = database
    .prepare(
      `SELECT namespace, key, value, updated_by
       FROM settings
       WHERE (namespace = 'system' AND key = 'firstLaunch')
          OR namespace IN ('app', 'map')
          OR (namespace = 'storage' AND key = 'provider')
       ORDER BY namespace, key`,
    )
    .all()
  const baselineProviderIDs = new Set(
    baseline.providers.map((provider) => provider.id),
  )
  const providers = database
    .prepare(
      'SELECT id, name, provider, config FROM settings_storage_providers ORDER BY id',
    )
    .all()
    .filter((provider) => !baselineProviderIDs.has(provider.id))
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      provider: provider.provider,
      config: JSON.parse(provider.config),
    }))
  return { user, settings, providers }
}

function assertBaselineRestored(database, baseline) {
  const current = captureBaseline(database)
  assert.deepEqual(current.user, baseline.user)
  assert.deepEqual(current.settings, baseline.settings)
  assert.deepEqual(current.providers, baseline.providers)
  assert.deepEqual(current.sequences, baseline.sequences)
  assert.equal(current.provider, baseline.provider)
}

function activeStorageID(database) {
  const value = database
    .prepare(
      "SELECT value FROM settings WHERE namespace = 'storage' AND key = 'provider'",
    )
    .get()?.value
  const id = Number(value)
  assert.equal(Number.isSafeInteger(id), true)
  return id
}

function normalizeBaseURL(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`)
  }
  return url.toString().replace(/\/$/, '')
}

function normalizeContentType(value) {
  return String(value || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
}

function parseBody(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const value = headers.get('set-cookie')
  return value ? [value] : []
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyDualWizard(parseWizardVerifierOptions())
    .then((result) => {
      console.log(JSON.stringify(result, null, 2))
      if (!result.ok) process.exitCode = 1
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}

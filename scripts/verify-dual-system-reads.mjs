#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import Database from 'better-sqlite3'

import {
  canonicalize,
  joinBackendURL,
  normalizedContentType,
} from './compare-backends.mjs'
import {
  FIXTURE_MEMBER_SESSION_TOKEN,
  FIXTURE_SESSION_TOKEN,
} from './seed-dual-backend-fixture.mjs'

export const DEFAULT_SYSTEM_READS_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_SYSTEM_READS_DATABASE_PATH = './data/app.sqlite3'
export const DEFAULT_SYSTEM_READS_ADMIN_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`
export const DEFAULT_SYSTEM_READS_MEMBER_COOKIE = `cf_session=${FIXTURE_MEMBER_SESSION_TOKEN}`
export const DEFAULT_SYSTEM_READS_PREFIX = 'dual-system-reads'

export const SYSTEM_READ_ROUTE_IDS = Object.freeze([
  'settings.public.read',
  'system.stats',
])

export const SYSTEM_READ_CASES = Object.freeze([
  'anonymous public settings decode every persisted type',
  'public settings include firstLaunch and exclude private values',
  'anonymous system stats are rejected',
  'administrator system stats include global photos and runtime details',
  'member system stats are owner scoped and hide runtime details',
  'gateway provider switch serves both routes through Node and Go',
])

const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'
const PUBLIC_SETTINGS_PATH = '/api/system/settings/all'
const SYSTEM_STATS_PATH = '/api/system/stats'

export function parseSystemReadsVerifierOptions(
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
        '--node',
        '--go',
        '--admin-cookie',
        '--member-cookie',
        '--db',
        '--timeout-ms',
        '--prefix',
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

  const base = normalizeBaseURL(
    values.get('--base') ||
      environment.CFRAME_DUAL_BASE_URL ||
      (environment.CFRAME_DUAL_PORT
        ? `http://127.0.0.1:${environment.CFRAME_DUAL_PORT}`
        : DEFAULT_SYSTEM_READS_BASE_URL),
  )
  const databasePath =
    values.get('--db') ||
    environment.CFRAME_DUAL_DATABASE_PATH ||
    DEFAULT_SYSTEM_READS_DATABASE_PATH
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
    adminCookie:
      values.get('--admin-cookie') ||
      environment.CFRAME_DUAL_ADMIN_COOKIE ||
      DEFAULT_SYSTEM_READS_ADMIN_COOKIE,
    memberCookie:
      values.get('--member-cookie') ||
      environment.CFRAME_DUAL_MEMBER_COOKIE ||
      DEFAULT_SYSTEM_READS_MEMBER_COOKIE,
    databasePath,
    timeoutMs,
    prefix: normalizePrefix(
      values.get('--prefix') ||
        environment.CFRAME_DUAL_SYSTEM_READS_PREFIX ||
        DEFAULT_SYSTEM_READS_PREFIX,
    ),
  }
}

export async function verifyDualSystemReads(options = {}) {
  const normalized = {
    ...parseSystemReadsVerifierOptions([], {}),
    ...options,
  }
  normalized.base = normalizeBaseURL(normalized.base)
  normalized.nodeURL = normalizeBaseURL(normalized.nodeURL)
  normalized.goURL = normalizeBaseURL(normalized.goURL)
  normalized.prefix = normalizePrefix(normalized.prefix)

  if (!normalized.database && !existsSync(normalized.databasePath)) {
    throw new Error(
      `SQLite database does not exist: ${normalized.databasePath}`,
    )
  }
  const ownsDatabase = !normalized.database
  const database =
    normalized.database ||
    new Database(normalized.databasePath, { timeout: 5000 })
  database.pragma('foreign_keys = ON')
  database.pragma('busy_timeout = 5000')

  const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
  const state = createFixtureState(normalized.prefix, suffix)
  const summary = {
    ok: false,
    base: normalized.base,
    databasePath: normalized.databasePath,
    routeIds: [...SYSTEM_READ_ROUTE_IDS],
    checks: [],
    cases: [...SYSTEM_READ_CASES],
    cleanup: [],
  }
  const api = createAPI(normalized, summary)

  try {
    await setProvider(api, 'node')

    const baselinePublic = await comparePair(api, {
      name: 'baseline anonymous public settings',
      routeId: 'settings.public.read',
      path: PUBLIC_SETTINGS_PATH,
      cookie: '',
      expectedStatus: 200,
    })
    assertFirstLaunchIsPublic(baselinePublic.node.body)

    const baselineAdmin = await comparePair(api, {
      name: 'baseline administrator system stats',
      routeId: 'system.stats',
      path: SYSTEM_STATS_PATH,
      cookie: normalized.adminCookie,
      expectedStatus: 200,
      role: 'admin',
    })
    const baselineMember = await comparePair(api, {
      name: 'baseline member system stats',
      routeId: 'system.stats',
      path: SYSTEM_STATS_PATH,
      cookie: normalized.memberCookie,
      expectedStatus: 200,
      role: 'member',
    })

    insertSystemReadFixtures(database, state)
    state.inserted = true

    const publicPair = await comparePair(api, {
      name: 'anonymous public settings type matrix',
      routeId: 'settings.public.read',
      path: PUBLIC_SETTINGS_PATH,
      cookie: '',
      expectedStatus: 200,
    })
    assertPublicSettingsFixture(publicPair.node.body, state)

    await comparePair(api, {
      name: 'anonymous system stats authorization',
      routeId: 'system.stats',
      path: SYSTEM_STATS_PATH,
      cookie: '',
      expectedStatus: 401,
      role: 'error',
    })

    const adminPair = await comparePair(api, {
      name: 'administrator global system stats after fixtures',
      routeId: 'system.stats',
      path: SYSTEM_STATS_PATH,
      cookie: normalized.adminCookie,
      expectedStatus: 200,
      role: 'admin',
    })
    const memberPair = await comparePair(api, {
      name: 'member owner-scoped system stats after fixtures',
      routeId: 'system.stats',
      path: SYSTEM_STATS_PATH,
      cookie: normalized.memberCookie,
      expectedStatus: 200,
      role: 'member',
    })

    assertStatsDeltas({
      baselineAdmin: baselineAdmin.node.body,
      baselineMember: baselineMember.node.body,
      admin: adminPair.node.body,
      member: memberPair.node.body,
      state,
    })

    for (const provider of ['node', 'go']) {
      await setProvider(api, provider)
      const publicResult = await api.request({
        name: `${provider} gateway public settings`,
        baseURL: normalized.base,
        path: PUBLIC_SETTINGS_PATH,
        cookie: '',
        expectedBackend: provider,
      })
      expectStatus(publicResult, 200)
      assertPublicSettingsFixture(publicResult.body, state)

      const statsResult = await api.request({
        name: `${provider} gateway member system stats`,
        baseURL: normalized.base,
        path: SYSTEM_STATS_PATH,
        cookie: normalized.memberCookie,
        expectedBackend: provider,
      })
      expectStatus(statsResult, 200)
      assertMemberRuntimeHidden(statsResult.body)
    }

    summary.ok = true
    return summary
  } catch (error) {
    summary.errors = [
      {
        name: 'dual system reads verifier',
        message: error instanceof Error ? error.message : String(error),
      },
    ]
    return summary
  } finally {
    cleanupSystemReadFixtures(database, state, summary)
    try {
      await setProvider(api, 'node', 'cleanup: restore provider to node')
      summary.cleanup.push({ name: 'restore provider to node', ok: true })
    } catch (error) {
      summary.cleanup.push({
        name: 'restore provider to node',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
      summary.ok = false
    }
    summary.checkCount = summary.checks.length
    if (summary.cleanup.some((entry) => !entry.ok)) summary.ok = false
    if (ownsDatabase) database.close()
  }
}

function createFixtureState(prefix, suffix) {
  const namespace = `${prefix}-${suffix}`
  const today = startOfUTCDay(new Date())
  const sixDaysAgo = addUTCDays(today, -6)
  return {
    inserted: false,
    namespace,
    today: formatDate(today),
    sixDaysAgo: formatDate(sixDaysAgo),
    sixDaysAgoIsThisMonth:
      today.getUTCFullYear() === sixDaysAgo.getUTCFullYear() &&
      today.getUTCMonth() === sixDaysAgo.getUTCMonth(),
    photoIds: {
      adminToday: `${namespace}-admin-today`,
      memberToday: `${namespace}-member-today`,
      memberSixDays: `${namespace}-member-six-days`,
      memberOld: `${namespace}-member-old`,
    },
  }
}

function insertSystemReadFixtures(database, state) {
  const insertSetting = database.prepare(`
    INSERT INTO settings(namespace, key, type, value, is_public, is_readonly, is_secret)
    VALUES (?, ?, ?, ?, ?, 0, 0)
  `)
  const insertPhoto = database.prepare(`
    INSERT INTO photos(id, title, date_taken, file_size, owner_user_id)
    VALUES (?, ?, ?, ?, ?)
  `)
  const todayISO = `${state.today}T12:00:00.000Z`
  const sixDaysISO = `${state.sixDaysAgo}T12:00:00.000Z`

  database.transaction(() => {
    for (const [key, type, value, isPublic] of [
      ['stringValue', 'string', '  public text  ', 1],
      ['numberValue', 'number', '1.25e2', 1],
      ['invalidNumber', 'number', ' 125 ', 1],
      ['booleanValue', 'boolean', 'true', 1],
      ['invalidBoolean', 'boolean', 'TRUE', 1],
      ['jsonValue', 'json', '{"nested":[1,true,null],"name":"value"}', 1],
      ['invalidJSON', 'json', '[1,2,3]', 1],
      ['nullValue', 'string', null, 1],
      ['privateValue', 'string', 'must-not-leak', 0],
    ]) {
      insertSetting.run(state.namespace, key, type, value, isPublic)
    }

    insertPhoto.run(
      state.photoIds.adminToday,
      'System reads admin today',
      todayISO,
      700,
      910_001,
    )
    insertPhoto.run(
      state.photoIds.memberToday,
      'System reads member today',
      todayISO,
      100,
      910_002,
    )
    insertPhoto.run(
      state.photoIds.memberSixDays,
      'System reads member six days ago',
      sixDaysISO,
      300,
      910_002,
    )
    insertPhoto.run(
      state.photoIds.memberOld,
      'System reads member old',
      '2000-01-01T12:00:00.000Z',
      50,
      910_002,
    )
  })()
}

function cleanupSystemReadFixtures(database, state, summary) {
  try {
    if (state.inserted) {
      database.transaction(() => {
        database
          .prepare('DELETE FROM photos WHERE id IN (?, ?, ?, ?)')
          .run(...Object.values(state.photoIds))
        database
          .prepare('DELETE FROM settings WHERE namespace = ?')
          .run(state.namespace)
      })()
    }
    const remainingPhotos = database
      .prepare('SELECT COUNT(*) AS count FROM photos WHERE id IN (?, ?, ?, ?)')
      .get(...Object.values(state.photoIds)).count
    const remainingSettings = database
      .prepare('SELECT COUNT(*) AS count FROM settings WHERE namespace = ?')
      .get(state.namespace).count
    if (remainingPhotos !== 0 || remainingSettings !== 0) {
      throw new Error(
        `fixture residue: photos=${remainingPhotos}, settings=${remainingSettings}`,
      )
    }
    summary.cleanup.push({
      name: 'remove system-read database fixtures',
      ok: true,
    })
  } catch (error) {
    summary.cleanup.push({
      name: 'remove system-read database fixtures',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
    summary.ok = false
  }
}

async function comparePair(api, testCase) {
  const requestID = `dual-system-reads-${randomUUID()}`
  const [node, go] = await Promise.all([
    api.request({
      name: `${testCase.name} via node`,
      baseURL: api.options.nodeURL,
      path: testCase.path,
      cookie: testCase.cookie,
      expectedBackend: 'node',
      requestID,
    }),
    api.request({
      name: `${testCase.name} via go`,
      baseURL: api.options.goURL,
      path: testCase.path,
      cookie: testCase.cookie,
      expectedBackend: 'go',
      requestID,
    }),
  ])
  expectStatus(node, testCase.expectedStatus)
  expectStatus(go, testCase.expectedStatus)

  const nodeBody = normalizeSystemReadBody(
    testCase.routeId,
    node.body,
    testCase.role,
  )
  const goBody = normalizeSystemReadBody(
    testCase.routeId,
    go.body,
    testCase.role,
  )
  if (
    JSON.stringify(canonicalize(nodeBody)) !==
    JSON.stringify(canonicalize(goBody))
  ) {
    throw new Error(
      `${testCase.name} body drift: ${JSON.stringify({ node: nodeBody, go: goBody })}`,
    )
  }
  return { node, go }
}

export function normalizeSystemReadBody(routeId, body, role = '') {
  const normalized = structuredClone(body)
  if (routeId === 'settings.public.read') {
    delete normalized.timestamp
    return normalized
  }
  if (routeId !== 'system.stats') return normalized
  if (role === 'error') {
    return {
      statusCode: normalized.statusCode,
      statusMessage: normalized.statusMessage,
      message: normalized.message,
    }
  }
  delete normalized.timestamp
  if (role === 'admin') {
    delete normalized.uptime
    if (normalized.memory) delete normalized.memory.used
    for (const worker of normalized.workerPool?.workers || []) {
      delete worker.uptime
    }
  }
  return normalized
}

function assertFirstLaunchIsPublic(body) {
  if (!body?.data?.system || !Object.hasOwn(body.data.system, 'firstLaunch')) {
    throw new Error(
      'public settings omitted the mandatory system:firstLaunch value',
    )
  }
}

function assertPublicSettingsFixture(body, state) {
  assertFirstLaunchIsPublic(body)
  const actual = body?.data?.[state.namespace]
  const expected = {
    stringValue: '  public text  ',
    numberValue: 125,
    invalidNumber: null,
    booleanValue: true,
    invalidBoolean: null,
    jsonValue: { nested: [1, true, null], name: 'value' },
    invalidJSON: null,
    nullValue: null,
  }
  if (
    JSON.stringify(canonicalize(actual)) !==
    JSON.stringify(canonicalize(expected))
  ) {
    throw new Error(
      `public settings fixture drift: ${JSON.stringify({ expected, actual })}`,
    )
  }
  if (Object.hasOwn(actual || {}, 'privateValue')) {
    throw new Error('public settings leaked a non-public value')
  }
}

export function assertStatsDeltas({
  baselineAdmin,
  baselineMember,
  admin,
  member,
  state,
}) {
  const expected = {
    admin: {
      total: 4,
      today: 2,
      thisWeek: 3,
      thisMonth: state.sixDaysAgoIsThisMonth ? 3 : 2,
      storage: 1150,
      todayTrend: 2,
      sixDaysTrend: 1,
    },
    member: {
      total: 3,
      today: 1,
      thisWeek: 2,
      thisMonth: state.sixDaysAgoIsThisMonth ? 2 : 1,
      storage: 450,
      todayTrend: 1,
      sixDaysTrend: 1,
    },
  }
  for (const [role, before, after] of [
    ['admin', baselineAdmin, admin],
    ['member', baselineMember, member],
  ]) {
    const wanted = expected[role]
    for (const field of ['total', 'today', 'thisWeek', 'thisMonth']) {
      const delta = after.photos[field] - before.photos[field]
      if (delta !== wanted[field]) {
        throw new Error(
          `${role} photos.${field} delta = ${delta}, expected ${wanted[field]}`,
        )
      }
    }
    const storageDelta = after.storage.totalSize - before.storage.totalSize
    if (storageDelta !== wanted.storage) {
      throw new Error(
        `${role} storage.totalSize delta = ${storageDelta}, expected ${wanted.storage}`,
      )
    }
    assertTrendDelta(role, before, after, state.today, wanted.todayTrend)
    assertTrendDelta(role, before, after, state.sixDaysAgo, wanted.sixDaysTrend)
  }
  assertMemberRuntimeHidden(member)
  if (admin.runningOn !== 'docker') {
    throw new Error(
      `administrator runningOn = ${admin.runningOn}, expected docker`,
    )
  }
  if (!(admin.memory?.total > 0) || !(admin.memory?.used >= 0)) {
    throw new Error(
      `administrator memory stats are invalid: ${JSON.stringify(admin.memory)}`,
    )
  }
}

function assertTrendDelta(role, before, after, date, expected) {
  const beforeCount =
    before.trends.find((item) => item.date === date)?.count || 0
  const afterCount = after.trends.find((item) => item.date === date)?.count || 0
  if (afterCount - beforeCount !== expected) {
    throw new Error(
      `${role} trend delta for ${date} = ${afterCount - beforeCount}, expected ${expected}`,
    )
  }
}

function assertMemberRuntimeHidden(body) {
  if (
    body.uptime !== 0 ||
    body.runningOn !== 'unknown' ||
    body.memory?.used !== 0 ||
    body.memory?.total !== 0 ||
    body.workerPool !== null
  ) {
    throw new Error(`member runtime details leaked: ${JSON.stringify(body)}`)
  }
}

function createAPI(options, summary) {
  return {
    options,
    async request({
      name,
      baseURL,
      path,
      cookie,
      expectedBackend,
      method = 'GET',
      body,
      requestID = `dual-system-reads-${randomUUID()}`,
    }) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
      try {
        const headers = { 'X-Request-Id': requestID }
        if (cookie) headers.Cookie = cookie
        if (body !== undefined) headers['Content-Type'] = 'application/json'
        const response = await fetch(joinBackendURL(baseURL, path), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        })
        const result = {
          name,
          method,
          path,
          status: response.status,
          backend: response.headers.get('x-chronoframe-backend'),
          requestID: response.headers.get('x-request-id'),
          contentType: normalizedContentType(
            response.headers.get('content-type'),
          ),
          setCookie: response.headers.get('set-cookie'),
          body: await readBody(response),
        }
        summary.checks.push(result)
        if (result.backend !== expectedBackend) {
          throw new Error(
            `${name} backend = ${result.backend}, expected ${expectedBackend}`,
          )
        }
        if (result.requestID !== requestID) {
          throw new Error(
            `${name} request id = ${result.requestID}, expected ${requestID}`,
          )
        }
        if (result.contentType !== 'application/json') {
          throw new Error(
            `${name} content type = ${result.contentType}, expected application/json`,
          )
        }
        if (result.setCookie) {
          throw new Error(`${name} unexpectedly wrote a cookie`)
        }
        return result
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

async function setProvider(
  api,
  provider,
  name = `switch provider to ${provider}`,
) {
  const result = await api.request({
    name,
    baseURL: api.options.base,
    path: PROVIDER_SETTING_PATH,
    cookie: api.options.adminCookie,
    expectedBackend: 'node',
    method: 'PUT',
    body: { value: provider },
  })
  expectStatus(result, 200)
  if (result.body?.value !== provider) {
    throw new Error(`${name} response did not persist ${provider}`)
  }
}

function expectStatus(result, expected) {
  if (result.status !== expected) {
    throw new Error(
      `${result.name} status = ${result.status}, expected ${expected}: ${JSON.stringify(result.body)}`,
    )
  }
}

async function readBody(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function normalizeBaseURL(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`)
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function normalizePrefix(value) {
  const prefix = String(value || '').trim()
  if (!/^[a-z0-9][a-z0-9-]{2,48}$/.test(prefix)) {
    throw new Error(
      '--prefix must contain 3-49 lowercase letters, digits, or hyphens',
    )
  }
  return prefix
}

function startOfUTCDay(date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  )
}

function addUTCDays(date, days) {
  const result = new Date(date)
  result.setUTCDate(result.getUTCDate() + days)
  return result
}

function formatDate(date) {
  return date.toISOString().slice(0, 10)
}

async function main() {
  const options = parseSystemReadsVerifierOptions()
  const summary = await verifyDualSystemReads(options)
  console.log(JSON.stringify(summary, null, 2))
  if (!summary.ok) process.exitCode = 1
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import {
  buildRouteSurfaceProbePlan,
  loadGoRouteSurfaceRoutes,
} from './verify-dual-route-surface.mjs'
import {
  FIXTURE_ADMIN_EMAIL,
  FIXTURE_ADMIN_PASSWORD,
  FIXTURE_SESSION_TOKEN,
} from './seed-dual-backend-fixture.mjs'

export const DEFAULT_GO_STANDALONE_URL = 'http://127.0.0.1:38080'
export const DEFAULT_GO_STANDALONE_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`

const SLOGAN_SETTING_PATH = '/api/system/settings/app/slogan'
const SESSION_COOKIE_NAME = 'cf_session'

export const STANDALONE_SUCCESS_READS = Object.freeze([
  Object.freeze({ path: '/api/profile', auth: 'admin' }),
  Object.freeze({ path: '/api/_auth/session', auth: 'admin' }),
  Object.freeze({
    path: '/api/system/settings/system/backend.readProvider',
    auth: 'admin',
  }),
  Object.freeze({ path: '/api/system/settings/all', auth: 'anonymous' }),
  Object.freeze({ path: '/api/access/config', auth: 'admin' }),
  Object.freeze({ path: '/api/admin/users', auth: 'admin' }),
  Object.freeze({ path: '/api/albums?scope=manage', auth: 'admin' }),
  Object.freeze({
    path: '/api/photos?scope=manage&page=1&pageSize=10',
    auth: 'admin',
  }),
  Object.freeze({ path: '/api/system/stats', auth: 'admin' }),
  Object.freeze({ path: '/api/queue/stats', auth: 'admin' }),
])

export function parseGoStandaloneVerifierOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (
      ![
        '--go-base',
        '--admin-cookie',
        '--email',
        '--password',
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

  const goBase =
    values.get('--go-base') ||
    environment.CFRAME_DUAL_GO_DIRECT_URL ||
    (environment.CFRAME_DUAL_GO_PORT
      ? `http://127.0.0.1:${environment.CFRAME_DUAL_GO_PORT}`
      : DEFAULT_GO_STANDALONE_URL)
  const timeoutMs = positiveInteger(
    values.get('--timeout-ms') || environment.CFRAME_DUAL_TIMEOUT_MS || 5_000,
    'timeout-ms',
  )
  if (timeoutMs > 60_000) {
    throw new Error('timeout-ms must be 60000 or less')
  }

  return {
    goBase: normalizeBaseURL(goBase),
    adminCookie: normalizeCookie(
      values.get('--admin-cookie') ||
        environment.CFRAME_DUAL_ADMIN_COOKIE ||
        environment.CFRAME_DUAL_COOKIE ||
        DEFAULT_GO_STANDALONE_COOKIE,
    ),
    email:
      values.get('--email') ||
      environment.CFRAME_DUAL_ADMIN_EMAIL ||
      FIXTURE_ADMIN_EMAIL,
    password:
      values.get('--password') ||
      environment.CFRAME_DUAL_ADMIN_PASSWORD ||
      FIXTURE_ADMIN_PASSWORD,
    timeoutMs,
  }
}

export async function verifyGoStandalone({
  goBase = DEFAULT_GO_STANDALONE_URL,
  adminCookie = DEFAULT_GO_STANDALONE_COOKIE,
  email = FIXTURE_ADMIN_EMAIL,
  password = FIXTURE_ADMIN_PASSWORD,
  timeoutMs = 5_000,
  routes = loadGoRouteSurfaceRoutes(),
  successReads = STANDALONE_SUCCESS_READS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function')
  }
  const options = {
    goBase: normalizeBaseURL(goBase),
    adminCookie: normalizeCookie(adminCookie),
    email: String(email || '').trim(),
    password: String(password || ''),
    timeoutMs: positiveInteger(timeoutMs, 'timeout-ms'),
    fetchImpl,
  }
  if (!options.email || !options.password) {
    throw new Error('email and password are required')
  }

  const summary = {
    ok: false,
    goBase: options.goBase,
    routeCount: routes.length,
    runtimeCheckCount: 0,
    successReadCount: 0,
    checks: [],
    cleanup: [],
  }
  let originalSlogan
  let restoreSlogan = false
  let issuedCookie = ''

  try {
    await verifyRuntime(options, summary)
    await verifyCompleteRouteSurface(options, routes, summary)
    await verifyRepresentativeReads(options, successReads, summary)

    const currentSetting = await request(options, SLOGAN_SETTING_PATH, {
      cookie: options.adminCookie,
    })
    expectGoJSON(currentSetting, 200, 'read original slogan')
    originalSlogan = currentSetting.body?.value
    restoreSlogan = true
    const temporarySlogan = `Go standalone ${randomUUID()}`
    const updatedSetting = await request(options, SLOGAN_SETTING_PATH, {
      method: 'PUT',
      cookie: options.adminCookie,
      body: { value: temporarySlogan },
    })
    expectGoJSON(updatedSetting, 200, 'write slogan without Node')
    assert.equal(updatedSetting.body?.value, temporarySlogan)
    const rereadSetting = await request(options, SLOGAN_SETTING_PATH, {
      cookie: options.adminCookie,
    })
    expectGoJSON(rereadSetting, 200, 're-read Go-written slogan')
    assert.equal(rereadSetting.body?.value, temporarySlogan)
    summary.checks.push({
      name: 'Go settings write and read succeed while Node is stopped',
      ok: true,
    })

    const login = await request(options, '/api/login', {
      method: 'POST',
      body: { email: options.email, password: options.password },
    })
    expectGoEmpty(login, 201, 'standalone Go login')
    issuedCookie = extractSessionCookie(login.setCookies)
    assert.ok(issuedCookie, 'standalone Go login must issue cf_session')

    const profile = await request(options, '/api/profile', {
      cookie: issuedCookie,
    })
    expectGoJSON(profile, 200, 'standalone Go profile')
    assert.equal(profile.body?.email, options.email)
    const session = await request(options, '/api/_auth/session', {
      cookie: issuedCookie,
    })
    expectGoJSON(session, 200, 'standalone Go session read')
    assert.equal(session.body?.user?.email, options.email)
    const sessionDelete = await request(options, '/api/_auth/session', {
      method: 'DELETE',
      cookie: issuedCookie,
    })
    expectGoJSON(sessionDelete, 200, 'standalone Go session delete')
    assert.deepEqual(sessionDelete.body, { loggedOut: true })
    assert.match(
      findSetCookie(sessionDelete.setCookies, SESSION_COOKIE_NAME) || '',
      /^cf_session=; Max-Age=0; Path=\//,
    )
    const revokedProfile = await request(options, '/api/profile', {
      cookie: issuedCookie,
    })
    expectGoJSON(revokedProfile, 401, 'standalone revoked Go session')
    issuedCookie = ''
    summary.checks.push({
      name: 'Go login, identity read, and revocation succeed without Node',
      ok: true,
    })

    summary.ok = true
  } catch (error) {
    summary.errors = [
      {
        name: 'Go standalone verifier',
        message: error instanceof Error ? error.message : String(error),
      },
    ]
  } finally {
    if (issuedCookie) {
      summary.cleanup.push(
        await cleanupAction('revoke residual standalone Go session', () =>
          request(options, '/api/_auth/session', {
            method: 'DELETE',
            cookie: issuedCookie,
          }),
        ),
      )
    }
    if (restoreSlogan) {
      summary.cleanup.push(
        await cleanupAction('restore original slogan through Go', async () => {
          const restored = await request(options, SLOGAN_SETTING_PATH, {
            method: 'PUT',
            cookie: options.adminCookie,
            body: { value: originalSlogan },
          })
          expectGoJSON(restored, 200, 'restore original slogan')
          assert.equal(restored.body?.value, originalSlogan)
        }),
      )
    }
    summary.cleanupFailed = summary.cleanup.filter((entry) => !entry.ok).length
    if (summary.cleanupFailed > 0) summary.ok = false
  }

  return summary
}

async function verifyRuntime(options, summary) {
  const live = await request(options, '/health/live')
  expectGoJSON(live, 200, 'Go liveness')
  assert.deepEqual(live.body, { status: 'ok' })

  const ready = await request(options, '/health/ready')
  expectGoJSON(ready, 200, 'Go readiness')
  assert.equal(ready.body?.status, 'ready')
  for (const dependency of ['database', 'redis', 'mediaTools']) {
    assert.equal(ready.body?.checks?.[dependency], 'ok')
  }
  assert.ok(Number.isInteger(ready.body?.schema?.migrationCount))
  assert.ok(Number.isInteger(ready.body?.schema?.latestMigrationMillis))

  const version = await request(options, '/version')
  expectGoJSON(version, 200, 'Go version')
  assert.equal(version.body?.backend, 'go')
  assert.equal(version.body?.mode, 'normal')

  summary.runtimeCheckCount = 3
  summary.checks.push({
    name: 'Go runtime remains live and ready without Node',
    ok: true,
  })
}

async function verifyCompleteRouteSurface(options, routes, summary) {
  const plan = buildRouteSurfaceProbePlan(routes, { surface: 'standalone' })
  for (const step of plan) {
    const result = await request(options, step.path, { method: step.method })
    assert.equal(
      result.backend,
      'go',
      `${step.id || step.routeId} must be served by Go`,
    )
    assert.ok(
      result.status < 500,
      `${step.id || step.routeId} returned ${result.status}`,
    )
  }
  summary.checks.push({
    name: 'Every registered Go route responds without Node',
    ok: true,
    count: plan.length,
  })
}

async function verifyRepresentativeReads(options, reads, summary) {
  for (const read of reads) {
    const result = await request(options, read.path, {
      cookie: read.auth === 'admin' ? options.adminCookie : undefined,
    })
    expectGoJSON(result, 200, `standalone read ${read.path}`)
  }
  summary.successReadCount = reads.length
  summary.checks.push({
    name: 'Representative authenticated Go reads succeed without Node',
    ok: true,
    count: reads.length,
  })
}

async function request(options, path, { method = 'GET', cookie, body } = {}) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en',
    'X-Request-Id': `go-standalone-${randomUUID()}`,
  }
  if (cookie) headers.Cookie = cookie
  let payload
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const response = await options.fetchImpl(joinURL(options.goBase, path), {
    method,
    headers,
    body: payload,
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs),
  })
  const text = method === 'HEAD' ? '' : await response.text()
  return {
    status: response.status,
    backend: response.headers.get('x-chronoframe-backend'),
    contentType: normalizedContentType(response.headers.get('content-type')),
    setCookies:
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean),
    body: parseJSON(text),
    bodyPreview: text.slice(0, 240),
  }
}

function expectGoJSON(result, status, label) {
  assert.equal(result.status, status, `${label} status`)
  assert.equal(result.backend, 'go', `${label} backend`)
  assert.equal(result.contentType, 'application/json', `${label} content type`)
}

function expectGoEmpty(result, status, label) {
  assert.equal(result.status, status, `${label} status`)
  assert.equal(result.backend, 'go', `${label} backend`)
  assert.equal(result.contentType, '', `${label} content type`)
  assert.equal(result.body, null, `${label} body`)
}

function extractSessionCookie(cookies) {
  const raw = findSetCookie(cookies, SESSION_COOKIE_NAME)
  const value = raw?.match(/^cf_session=([^;]+)/)?.[1]
  return value ? `${SESSION_COOKIE_NAME}=${value}` : ''
}

function findSetCookie(cookies, name) {
  return cookies.find((cookie) => String(cookie).startsWith(`${name}=`))
}

function normalizedContentType(value) {
  return String(value || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
}

function parseJSON(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function joinURL(base, path) {
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

function normalizeBaseURL(value) {
  const url = new URL(String(value))
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('go-base must be an http(s) URL')
  }
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

function normalizeCookie(value) {
  const cookie = String(value || '').trim()
  if (!cookie || /[\r\n]/.test(cookie)) {
    throw new Error('admin-cookie must be a non-empty single header')
  }
  return cookie
}

function positiveInteger(value, label) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return number
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

async function main() {
  const summary = await verifyGoStandalone(parseGoStandaloneVerifierOptions())
  console.log(JSON.stringify(summary, null, 2))
  if (!summary.ok) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}

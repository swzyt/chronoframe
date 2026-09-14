import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  DEFAULT_ACCESS_ADMIN_COOKIE,
  parseAccessVerifierOptions,
  verifyDualAccessControl,
} from '../scripts/verify-dual-access-control.mjs'
import { FIXTURE_ACCESS_PASSWORD } from '../scripts/seed-dual-backend-fixture.mjs'

const nodeToken = Buffer.alloc(32, 0x4e).toString('base64url')
const goToken = Buffer.alloc(32, 0x47).toString('base64url')

test('access-control routes are promoted only to verified maturity', () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL('../backend/contracts/routes.yaml', import.meta.url),
      'utf8',
    ),
  )
  const routes = manifest.routes.filter(
    (route) => route.capability === 'access-control',
  )
  assert.deepEqual(
    routes.map((route) => [route.id, route.maturity.go]),
    [
      ['access.config.read', 'verified'],
      ['access.config.update', 'verified'],
      ['access.status.read', 'verified'],
      ['access.verify', 'verified'],
    ],
  )
})

test('access verifier options derive the lab and Redis surfaces', () => {
  assert.deepEqual(
    parseAccessVerifierOptions(['--base', 'http://gateway/'], {}),
    {
      baseURL: 'http://gateway',
      goURL: 'http://gateway/__lab/go',
      adminCookie: DEFAULT_ACCESS_ADMIN_COOKIE,
      password: FIXTURE_ACCESS_PASSWORD,
      redisURL: 'redis://127.0.0.1:36379/0',
      redisPassword: 'chronoframe-development-only-change-me',
      environment: 'development',
      sessionSecret: 'chronoframe-dual-development-secret-change-me',
      rateLimitSecret: '',
      databasePath: new URL('../data/app.sqlite3', import.meta.url).pathname,
      settingsCacheVersionKey: 'chronoframe:settings:version',
      timeoutMs: 5_000,
    },
  )
})

test('access verifier proves cross-runtime grants, invalidation, and shared rate limiting', async () => {
  const state = {
    provider: 'go',
    config: {
      enabled: true,
      hasPassword: true,
      photoLimit: 500,
      albumLimit: 1,
    },
    version: 7,
    grants: new Map(),
    rateCounts: new Map(),
    calls: [],
    cleanupKeys: [],
  }

  const result = await verifyDualAccessControl({
    baseURL: 'http://gateway',
    goURL: 'http://gateway/__lab/go',
    fetchImpl: createAccessFetch(state),
    async cleanupSharedStateImpl({ keys }) {
      state.cleanupKeys.push(...keys)
      state.grants.clear()
      state.rateCounts.clear()
      return { keyCount: keys.length, deleted: keys.length, residual: 0 }
    },
    async restoreAccessVersionImpl({ version }) {
      state.version = version
      return { version }
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.cleanupFailed, 0)
  assert.equal(state.provider, 'go')
  assert.equal(state.version, 7)
  assert.deepEqual(state.config, {
    enabled: true,
    hasPassword: true,
    photoLimit: 500,
    albumLimit: 1,
  })
  assert.equal(state.grants.size, 0)
  assert.equal(state.rateCounts.size, 0)
  assert.ok(state.cleanupKeys.length >= 8)
  assert.ok(
    result.checks.some(
      (entry) => entry.name === 'Node-issued grant accepted by both backends',
    ),
  )
  assert.ok(
    result.checks.some(
      (entry) => entry.name === 'Go-issued grant accepted by both backends',
    ),
  )
  assert.ok(
    result.checks.some(
      (entry) =>
        entry.name ===
        'shared Redis access rate limit enforced by both backends',
    ),
  )
  assert.equal(
    state.calls.filter(
      (call) => call.path === '/api/access/verify' && call.status === 429,
    ).length,
    2,
  )
})

function createAccessFetch(state) {
  return async (input, init = {}) => {
    const url = new URL(input)
    const directGo = url.pathname.startsWith('/__lab/go')
    const path = directGo
      ? url.pathname.slice('/__lab/go'.length) || '/'
      : url.pathname
    const method = init.method || 'GET'
    const backend = directGo ? 'go' : state.provider
    const requestId = init.headers?.['X-Request-Id']
    const cookie = String(init.headers?.Cookie || '')
    const forwardedFor = String(init.headers?.['X-Forwarded-For'] || '')

    let response
    if (path === '/api/system/settings/system/backend.readProvider') {
      if (method === 'PUT') state.provider = JSON.parse(init.body).value
      response = jsonResponse(
        200,
        {
          namespace: 'system',
          key: 'backend.readProvider',
          value: state.provider,
        },
        'node',
        requestId,
      )
    } else if (path === '/api/system/settings/app/access.version') {
      if (method === 'PUT') state.version = JSON.parse(init.body).value
      response = jsonResponse(
        200,
        { namespace: 'app', key: 'access.version', value: state.version },
        'node',
        requestId,
      )
    } else if (path === '/api/access/config' && method === 'GET') {
      response = jsonResponse(200, state.config, backend, requestId)
    } else if (path === '/api/access/config' && method === 'PUT') {
      const body = JSON.parse(init.body)
      state.config = { ...body, hasPassword: true }
      state.version += 1
      response = jsonResponse(200, state.config, backend, requestId)
    } else if (path === '/api/access/status') {
      response = accessStatusResponse(state, backend, requestId, cookie)
    } else if (path === '/api/photos/visible') {
      response = jsonResponse(
        200,
        [{ id: 'preview-photo' }],
        backend,
        requestId,
      )
    } else if (path === '/api/access/verify' && method === 'POST') {
      response = accessVerifyResponse(
        state,
        backend,
        requestId,
        forwardedFor,
        JSON.parse(init.body).password,
      )
    } else {
      throw new Error(`Unexpected mock request: ${method} ${url}`)
    }

    state.calls.push({ path, method, backend, status: response.status })
    return response
  }
}

function accessStatusResponse(state, backend, requestId, cookie) {
  const token = cookie.match(/(?:^|;\s*)cf_access=([^;]+)/)?.[1]
  const granted = Boolean(token && state.grants.get(token) === state.version)
  const invalid = Boolean(token && !granted)
  if (invalid) state.grants.delete(token)
  return jsonResponse(
    200,
    {
      required: state.config.enabled,
      granted,
      photoLimit: state.config.photoLimit,
      albumLimit: state.config.albumLimit,
      totalPhotos: 2,
      totalAlbums: 2,
      hasMorePhotos: state.config.enabled && !granted,
      hasMoreAlbums: state.config.enabled && !granted,
    },
    backend,
    requestId,
    invalid ? ['cf_access=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax'] : [],
  )
}

function accessVerifyResponse(
  state,
  backend,
  requestId,
  forwardedFor,
  password,
) {
  const attempts = state.rateCounts.get(forwardedFor) || 0
  if (attempts >= 5) {
    return jsonResponse(
      429,
      errorBody(429, 'Too many attempts'),
      backend,
      requestId,
      [],
      { 'Retry-After': '300' },
    )
  }
  state.rateCounts.set(forwardedFor, attempts + 1)
  if (password !== FIXTURE_ACCESS_PASSWORD) {
    return jsonResponse(
      401,
      errorBody(401, 'Invalid password'),
      backend,
      requestId,
    )
  }

  state.rateCounts.delete(forwardedFor)
  const token = backend === 'go' ? goToken : nodeToken
  state.grants.set(token, state.version)
  return jsonResponse(200, { success: true }, backend, requestId, [
    `cf_access=${token}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax`,
  ])
}

function errorBody(statusCode, message) {
  return {
    error: true,
    statusCode,
    statusMessage: message,
    message,
  }
}

function jsonResponse(
  status,
  body,
  backend,
  requestId,
  cookies = [],
  extraHeaders = {},
) {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'X-ChronoFrame-Backend': backend,
    'X-Request-Id': requestId,
    ...extraHeaders,
  })
  for (const cookie of cookies) headers.append('Set-Cookie', cookie)
  return new Response(JSON.stringify(body), { status, headers })
}

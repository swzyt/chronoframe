import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  parseGoStandaloneVerifierOptions,
  verifyGoStandalone,
} from '../scripts/verify-go-standalone.mjs'
import {
  FIXTURE_ADMIN_EMAIL,
  FIXTURE_ADMIN_PASSWORD,
  FIXTURE_SESSION_TOKEN,
} from '../scripts/seed-dual-backend-fixture.mjs'

const fixtureCookie = `cf_session=${FIXTURE_SESSION_TOKEN}`
const issuedToken = Buffer.alloc(32, 0x53).toString('base64url')

test('standalone runtime routes are promoted only after Node-off verification', () => {
  const contract = JSON.parse(
    readFileSync(
      new URL('../backend/contracts/routes.yaml', import.meta.url),
      'utf8',
    ),
  )
  const routes = contract.routes.filter(
    (route) => route.capability === 'backend-runtime',
  )
  assert.deepEqual(routes.map((route) => route.id).sort(), [
    'runtime.health.live',
    'runtime.health.ready',
    'runtime.version',
  ])
  assert.ok(routes.every((route) => route.maturity.go === 'verified'))
})

test('standalone verifier options derive the direct Go host port', () => {
  assert.deepEqual(
    parseGoStandaloneVerifierOptions([], {
      CFRAME_DUAL_GO_PORT: '38123',
    }),
    {
      goBase: 'http://127.0.0.1:38123',
      adminCookie: fixtureCookie,
      email: FIXTURE_ADMIN_EMAIL,
      password: FIXTURE_ADMIN_PASSWORD,
      timeoutMs: 5_000,
    },
  )
})

test('standalone verifier exercises route surface, writes, and identity without Node', async () => {
  const state = {
    slogan: 'original slogan',
    sessionActive: false,
    calls: [],
  }
  const result = await verifyGoStandalone({
    goBase: 'http://go-primary.test',
    routes: [
      {
        id: 'settings.public.read',
        method: 'GET',
        path: '/api/system/settings/all',
      },
      { id: 'identity.login', method: 'POST', path: '/api/login' },
    ],
    successReads: [
      { path: '/api/profile', auth: 'admin' },
      { path: '/api/system/settings/all', auth: 'anonymous' },
    ],
    fetchImpl: createStandaloneFetch(state),
  })

  assert.equal(result.ok, true)
  assert.equal(result.routeCount, 2)
  assert.equal(result.runtimeCheckCount, 3)
  assert.equal(result.successReadCount, 2)
  assert.equal(result.cleanupFailed, 0)
  assert.equal(state.slogan, 'original slogan')
  assert.equal(state.sessionActive, false)
  assert.ok(
    state.calls.every((call) => call.origin === 'http://go-primary.test'),
  )
  assert.ok(
    result.checks.some(
      (entry) =>
        entry.name === 'Every registered Go route responds without Node',
    ),
  )
})

function createStandaloneFetch(state) {
  return async (input, init = {}) => {
    const url = new URL(input)
    const method = init.method || 'GET'
    const cookie = String(init.headers?.Cookie || '')
    state.calls.push({ origin: url.origin, path: url.pathname, method, cookie })

    if (url.pathname === '/health/live') {
      return jsonResponse(200, { status: 'ok' })
    }
    if (url.pathname === '/health/ready') {
      return jsonResponse(200, {
        status: 'ready',
        checks: { database: 'ok', redis: 'ok', mediaTools: 'ok' },
        schema: {
          migrationCount: 23,
          latestMigrationMillis: 1_762_089_381_492,
        },
      })
    }
    if (url.pathname === '/version') {
      return jsonResponse(200, {
        backend: 'go',
        version: 'test',
        maturity: 'experimental',
        mode: 'normal',
      })
    }

    if (url.pathname === '/api/system/settings/app/slogan') {
      if (method === 'PUT') {
        state.slogan = JSON.parse(init.body).value
      }
      return jsonResponse(200, {
        namespace: 'app',
        key: 'slogan',
        value: state.slogan,
      })
    }

    if (url.pathname === '/api/login' && method === 'POST' && init.body) {
      assert.deepEqual(JSON.parse(init.body), {
        email: FIXTURE_ADMIN_EMAIL,
        password: FIXTURE_ADMIN_PASSWORD,
      })
      state.sessionActive = true
      return emptyResponse(201, [
        `cf_session=${issuedToken}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax`,
      ])
    }

    const issued = cookie === `cf_session=${issuedToken}`
    const fixture = cookie === fixtureCookie
    if (url.pathname === '/api/profile') {
      if (fixture || (issued && state.sessionActive)) {
        return jsonResponse(200, { email: FIXTURE_ADMIN_EMAIL })
      }
      return jsonResponse(401, {
        statusCode: 401,
        statusMessage: 'Unauthorized',
        message: 'Unauthorized',
      })
    }
    if (url.pathname === '/api/_auth/session') {
      if (method === 'DELETE') {
        state.sessionActive = false
        return jsonResponse(200, { loggedOut: true }, [
          'cf_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
        ])
      }
      return jsonResponse(200, {
        user:
          issued && state.sessionActive ? { email: FIXTURE_ADMIN_EMAIL } : null,
      })
    }
    if (url.pathname === '/api/system/settings/all') {
      return jsonResponse(200, { data: {} })
    }

    return jsonResponse(init.body ? 400 : 401, {
      statusCode: init.body ? 400 : 401,
    })
  }
}

function jsonResponse(status, body, cookies = []) {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'X-ChronoFrame-Backend': 'go',
  })
  for (const cookie of cookies) headers.append('Set-Cookie', cookie)
  return new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers,
  })
}

function emptyResponse(status, cookies = []) {
  const headers = new Headers({ 'X-ChronoFrame-Backend': 'go' })
  for (const cookie of cookies) headers.append('Set-Cookie', cookie)
  return new Response(null, { status, headers })
}

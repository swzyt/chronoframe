import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  parseIdentityVerifierOptions,
  verifyDualIdentity,
} from '../scripts/verify-dual-identity.mjs'
import {
  FIXTURE_ADMIN_EMAIL,
  FIXTURE_ADMIN_PASSWORD,
  FIXTURE_SESSION_TOKEN,
} from '../scripts/seed-dual-backend-fixture.mjs'

const nodeToken = Buffer.alloc(32, 0x4e).toString('base64url')
const goToken = Buffer.alloc(32, 0x47).toString('base64url')

test('every identity route is promoted after the complete identity gates', () => {
  const contract = JSON.parse(
    readFileSync(
      new URL('../backend/contracts/routes.yaml', import.meta.url),
      'utf8',
    ),
  )
  const routes = contract.routes.filter(
    (route) => route.capability === 'identity',
  )
  assert.deepEqual(routes.map((route) => route.id).sort(), [
    'identity.github.callback',
    'identity.login',
    'identity.logout',
    'identity.profile',
    'identity.session.delete',
    'identity.session.read',
  ])
  assert.ok(routes.every((route) => route.maturity.go === 'verified'))
})

test('identity verifier options derive the two surfaces from a container base', () => {
  assert.deepEqual(
    parseIdentityVerifierOptions(['--base', 'http://gateway/'], {}),
    {
      nodeURL: 'http://gateway',
      goURL: 'http://gateway/__lab/go',
      adminCookie: `cf_session=${FIXTURE_SESSION_TOKEN}`,
      email: FIXTURE_ADMIN_EMAIL,
      password: FIXTURE_ADMIN_PASSWORD,
      timeoutMs: 5_000,
    },
  )
})

test('identity verifier proves both session writers and both revocation APIs', async () => {
  const state = {
    provider: 'go',
    sessions: new Set(),
    calls: [],
  }
  const result = await verifyDualIdentity({
    nodeURL: 'http://gateway',
    goURL: 'http://gateway/__lab/go',
    fetchImpl: createIdentityFetch(state),
  })

  assert.equal(result.ok, true)
  assert.equal(result.originalProvider, 'go')
  assert.equal(result.cleanupFailed, 0)
  assert.equal(state.provider, 'go')
  assert.equal(state.sessions.size, 0)
  assert.ok(
    result.checks.some(
      (entry) => entry.name === 'Node-issued session accepted by Go',
    ),
  )
  assert.ok(
    result.checks.some(
      (entry) => entry.name === 'Go-issued session accepted by Node',
    ),
  )
  assert.ok(
    result.checks.some(
      (entry) => entry.name === 'Node-issued session revoked by Go',
    ),
  )
  assert.ok(
    result.checks.some(
      (entry) => entry.name === 'Go-issued session revoked by Node',
    ),
  )
  assert.ok(
    result.checks.some(
      (entry) =>
        entry.name === 'Node-issued session deleted by Go auth endpoint',
    ),
  )
  assert.ok(
    result.checks.some(
      (entry) =>
        entry.name === 'Go-issued session deleted by Node auth endpoint',
    ),
  )
  assert.ok(
    result.checks.some((entry) => entry.name === 'Invalid credentials parity'),
  )
  assert.deepEqual(
    state.calls
      .filter((call) => call.path === '/api/login')
      .map((call) => call.backend),
    ['node', 'go', 'node', 'node', 'go', 'go'],
  )
})

function createIdentityFetch(state) {
  return async (input, init = {}) => {
    const url = new URL(input)
    const directGo = url.pathname.startsWith('/__lab/go')
    const path = directGo
      ? url.pathname.slice('/__lab/go'.length) || '/'
      : url.pathname
    const backend = directGo ? 'go' : state.provider
    const method = init.method || 'GET'
    const cookie = String(init.headers?.Cookie || '')
    state.calls.push({ path, method, backend, cookie })

    if (path === '/api/system/settings/system/backend.readProvider') {
      if (method === 'PUT') {
        const body = JSON.parse(init.body)
        state.provider = body.value
      }
      return jsonResponse(
        200,
        {
          namespace: 'system',
          key: 'backend.readProvider',
          value: state.provider,
        },
        'node',
      )
    }

    if (path === '/api/login' && method === 'POST') {
      const body = JSON.parse(init.body)
      if (body.email !== FIXTURE_ADMIN_EMAIL) {
        assert.match(
          body.email,
          /^dual-identity-[0-9a-f-]+@chronoframe\.invalid$/,
        )
        assert.equal(body.password, 'invalid-password')
        return jsonResponse(
          401,
          {
            statusCode: 401,
            statusMessage: 'Server Error',
            message: 'Invalid credentials',
          },
          backend,
        )
      }
      assert.equal(body.password, FIXTURE_ADMIN_PASSWORD)
      const token = backend === 'go' ? goToken : nodeToken
      state.sessions.add(token)
      return response(201, null, backend, [
        `cf_session=${token}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax`,
      ])
    }

    const token = cookie.match(/(?:^|;\s*)cf_session=([^;]+)/)?.[1]
    const authenticated = Boolean(token && state.sessions.has(token))
    if (path === '/api/profile') {
      return authenticated
        ? jsonResponse(200, fixtureProfile(), backend)
        : jsonResponse(
            401,
            {
              statusCode: 401,
              statusMessage: 'Unauthorized',
              message: 'Unauthorized',
            },
            backend,
          )
    }
    if (path === '/api/_auth/session') {
      if (method === 'DELETE') {
        if (token) state.sessions.delete(token)
        return response(200, { loggedOut: true }, backend, [
          'cf_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
        ])
      }
      return jsonResponse(
        200,
        authenticated
          ? {
              id: token,
              user: {
                id: 910001,
                username: FIXTURE_ADMIN_EMAIL.split('@')[0],
                email: FIXTURE_ADMIN_EMAIL,
                avatar: null,
                isAdmin: 1,
                isActive: true,
              },
            }
          : { id: 'anonymous' },
        backend,
      )
    }
    if (path === '/api/logout') {
      if (token) state.sessions.delete(token)
      return response(200, { success: true }, backend, [
        'cf_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
      ])
    }
    throw new Error(`Unexpected mock request: ${method} ${url}`)
  }
}

function fixtureProfile() {
  return {
    id: 910001,
    username: FIXTURE_ADMIN_EMAIL.split('@')[0],
    email: FIXTURE_ADMIN_EMAIL,
    avatar: null,
    createdAt: '2027-01-01T00:00:00.000Z',
    isAdmin: 1,
    isActive: true,
    authVersion: 1,
  }
}

function jsonResponse(status, body, backend) {
  return response(status, body, backend)
}

function response(status, body, backend, cookies = []) {
  const headers = new Headers({ 'X-ChronoFrame-Backend': backend })
  if (body !== null) headers.set('Content-Type', 'application/json')
  for (const cookie of cookies) headers.append('Set-Cookie', cookie)
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers,
  })
}

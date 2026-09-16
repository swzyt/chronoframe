import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_ROUTE_BOUNDARIES_ADMIN_COOKIE,
  buildRouteBoundaryCases,
  normalizeRouteBoundaryBody,
  parseRouteBoundariesVerifierOptions,
  validateRouteBoundaryComparison,
  verifyDualRouteBoundaries,
} from '../scripts/verify-dual-route-boundaries.mjs'
import { PROVIDER_SETTING_PATH } from '../scripts/verify-dual-route-surface.mjs'

function jsonResponse(body, backend, requestId, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-chronoframe-backend': backend,
      'x-request-id': requestId,
      ...extraHeaders,
    },
  })
}

function createBoundaryGateway({
  bodyDriftRouteId,
  statusDriftRouteId,
  initialProvider = 'go',
} = {}) {
  const state = { provider: initialProvider }
  const requests = []
  const fetchImpl = async (url, options) => {
    const requestURL = new URL(String(url))
    const directGo = requestURL.pathname.startsWith('/__lab/go')
    const path = requestURL.pathname.replace(/^\/__lab\/go/, '') || '/'
    const pathWithSearch = `${path}${requestURL.search}`
    const body = options.body ? JSON.parse(options.body) : undefined
    const request = {
      backend: directGo ? 'go' : state.provider,
      directGo,
      method: options.method,
      path: pathWithSearch,
      cookie: options.headers.Cookie,
      requestId: options.headers['X-Request-Id'],
      body,
    }
    requests.push(request)

    if (path === PROVIDER_SETTING_PATH) {
      if (request.method === 'GET') {
        return jsonResponse(
          { namespace: 'system', key: 'backend.readProvider', value: state.provider },
          request.backend,
          request.requestId,
        )
      }
      if (request.method === 'PUT') {
        state.provider = body.value
        return jsonResponse(
          { namespace: 'system', key: 'backend.readProvider', value: state.provider },
          'node',
          request.requestId,
        )
      }
    }

    const routeId = path.includes('/api/login')
      ? 'identity.login'
      : 'settings.public.read'
    const backend = directGo ? 'go' : state.provider
    const status =
      backend === 'go' && routeId === statusDriftRouteId ? 403 : 401
    const message =
      backend === 'go' && routeId === bodyDriftRouteId
        ? 'Different'
        : 'Unauthorized'
    return jsonResponse(
      {
        error: true,
        url: `http://gateway.test${requestURL.pathname}`,
        statusCode: status,
        statusMessage: message,
        message,
        routeId,
      },
      backend,
      request.requestId,
      status,
    )
  }
  return { fetchImpl, requests, state }
}

test('route boundary verifier options default to fixture session and lab URLs', () => {
  const options = parseRouteBoundariesVerifierOptions([], {
    CFRAME_DUAL_PORT: '33105',
  })

  assert.equal(options.base, 'http://127.0.0.1:33105')
  assert.equal(options.nodeURL, 'http://127.0.0.1:33105')
  assert.equal(options.goURL, 'http://127.0.0.1:33105/__lab/go')
  assert.equal(options.adminCookie, DEFAULT_ROUTE_BOUNDARIES_ADMIN_COOKIE)
  assert.equal(options.timeoutMs, 5_000)
})

test('route boundary cases cover every Go-capable non-runtime contract route', () => {
  const cases = buildRouteBoundaryCases()

  assert.equal(cases.length, 86)
  assert.deepEqual(new Set(cases.map((entry) => entry.routeId)).size, 86)
  assert.ok(cases.some((entry) => entry.routeId === 'identity.login'))
  assert.ok(cases.some((entry) => entry.routeId === 'photos.upload'))
  assert.ok(cases.some((entry) => entry.routeId === 'media.storage.head'))
  assert.ok(cases.every((entry) => !Object.hasOwn(entry, 'cookie')))
})

test('route boundary verifier forces Node provider, compares without cookies, and restores', async () => {
  const gateway = createBoundaryGateway()
  const routes = [
    {
      id: 'identity.login',
      method: 'POST',
      path: '/api/login',
      auth: 'anonymous',
      sideEffect: 'session',
    },
    {
      id: 'settings.public.read',
      method: 'GET',
      path: '/api/system/settings/all',
      auth: 'anonymous',
      sideEffect: 'none',
    },
  ]

  const result = await verifyDualRouteBoundaries({
    nodeURL: 'http://gateway.test',
    goURL: 'http://gateway.test/__lab/go',
    adminCookie: 'cf_session=admin',
    timeoutMs: 1_000,
    routes,
    fetchImpl: gateway.fetchImpl,
  })

  assert.equal(result.ok, true)
  assert.equal(gateway.state.provider, 'go')
  assert.deepEqual(
    gateway.requests.map((request) => [
      request.method,
      request.path,
      request.directGo,
      request.cookie || null,
    ]),
    [
      ['GET', PROVIDER_SETTING_PATH, false, 'cf_session=admin'],
      ['PUT', PROVIDER_SETTING_PATH, false, 'cf_session=admin'],
      ['POST', '/api/login', false, null],
      ['POST', '/api/login', true, null],
      ['GET', '/api/system/settings/all', false, null],
      ['GET', '/api/system/settings/all', true, null],
      ['PUT', PROVIDER_SETTING_PATH, false, 'cf_session=admin'],
    ],
  )
})

test('route boundary verifier reports status and body drift', async () => {
  const gateway = createBoundaryGateway({
    bodyDriftRouteId: 'identity.login',
    statusDriftRouteId: 'identity.login',
    initialProvider: 'node',
  })
  const result = await verifyDualRouteBoundaries({
    nodeURL: 'http://gateway.test',
    goURL: 'http://gateway.test/__lab/go',
    adminCookie: 'cf_session=admin',
    timeoutMs: 1_000,
    routes: [
      {
        id: 'identity.login',
        method: 'POST',
        path: '/api/login',
        auth: 'anonymous',
        sideEffect: 'session',
      },
    ],
    fetchImpl: gateway.fetchImpl,
  })

  assert.equal(result.ok, false)
  assert.equal(result.failed, 1)
  assert.deepEqual(
    result.results[0].differences.map((difference) => difference.field),
    ['status', 'body'],
  )
})

test('route boundary normalization ignores diagnostic url, stack, and configured dynamic fields', () => {
  assert.deepEqual(
    normalizeRouteBoundaryBody(
      {
        error: true,
        url: 'http://node.test/api/system/settings/all',
        stack: 'node stack',
        timestamp: '2026-09-12T00:00:00.000Z',
        nested: {
          stack: 'nested stack',
          message: 'same',
        },
      },
      ['/timestamp'],
    ),
    {
      error: true,
      nested: {
        message: 'same',
      },
    },
  )
})

test('route boundary validation rejects backend and set-cookie drift', () => {
  const differences = validateRouteBoundaryComparison(
    {
      routeId: 'identity.session.delete',
      method: 'DELETE',
      path: '/api/_auth/session',
      bodyNormalizers: [],
    },
    {
      status: 200,
      backend: 'node',
      contentType: 'application/json',
      location: '',
      setCookie: true,
      requestId: 'route-boundary-test',
      responseRequestId: 'route-boundary-test',
      body: { success: true },
    },
    {
      status: 200,
      backend: 'node',
      contentType: 'application/json',
      location: '',
      setCookie: false,
      requestId: 'route-boundary-test',
      responseRequestId: 'route-boundary-test',
      body: { success: true },
    },
  )

  assert.deepEqual(
    differences.map((difference) => difference.field),
    ['go.headers.x-chronoframe-backend', 'headers.set-cookie'],
  )
})

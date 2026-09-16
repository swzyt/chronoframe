import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_ROUTE_SURFACE_COOKIE,
  PROVIDER_SETTING_PATH,
  buildRouteSurfaceProbePlan,
  loadGoRouteSurfaceRoutes,
  parseRouteSurfaceVerifierOptions,
  samplePathForRoute,
  validateSurfaceProbe,
  verifyDualRouteSurface,
} from '../scripts/verify-dual-route-surface.mjs'

function jsonResponse(body, backend, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-chronoframe-backend': backend,
      'x-request-id': 'response-request-1',
    },
  })
}

function createSurfaceGateway({ driftRouteId } = {}) {
  let provider = 'node'
  const requests = []
  const fetchImpl = async (url, options) => {
    const request = {
      url: String(url),
      method: options.method,
      headers: { ...options.headers },
      body: options.body ? JSON.parse(options.body) : undefined,
    }
    requests.push(request)

    const pathname = new URL(url).pathname
    if (request.method === 'PUT' && pathname === PROVIDER_SETTING_PATH) {
      provider = request.body.value
      return jsonResponse(
        {
          namespace: 'system',
          key: 'backend.readProvider',
          value: provider,
        },
        'node',
      )
    }

    const routeId = options.headers['X-Test-Route-Id']
    const backend =
      provider === 'go' && routeId !== driftRouteId ? 'go' : 'node'
    return jsonResponse({ routeId }, backend, 401)
  }

  return {
    fetchImpl,
    requests,
    getProvider: () => provider,
  }
}

test('route surface verifier options default to fixture session and dual port', () => {
  const options = parseRouteSurfaceVerifierOptions([], {
    CFRAME_DUAL_PORT: '33105',
  })

  assert.equal(options.base, 'http://127.0.0.1:33105')
  assert.equal(options.labBase, '')
  assert.equal(options.cookie, DEFAULT_ROUTE_SURFACE_COOKIE)
  assert.equal(options.timeoutMs, 5_000)
})

test('route surface probe plan covers every Go-capable non-runtime contract route', () => {
  const routes = loadGoRouteSurfaceRoutes()
  const plan = buildRouteSurfaceProbePlan(routes)

  assert.equal(plan.length, 86)
  assert.deepEqual(new Set(plan.map((step) => step.routeId)).size, plan.length)
  assert.ok(plan.some((step) => step.routeId === 'identity.login'))
  assert.ok(plan.some((step) => step.routeId === 'photos.upload'))
  assert.ok(plan.some((step) => step.routeId === 'media.image.head'))
  assert.ok(plan.every((step) => step.surface === 'gateway'))
  assert.ok(plan.every((step) => step.expectedBackend === 'go'))
  assert.ok(plan.every((step) => step.sendCookie === false))
})

test('route surface verifier options accept explicit lab base', () => {
  const options = parseRouteSurfaceVerifierOptions(
    ['--base', 'http://gateway.test/', '--lab-base', 'http://go.test/'],
    {},
  )

  assert.equal(options.base, 'http://gateway.test')
  assert.equal(options.labBase, 'http://go.test')
})

test('route surface samples avoid the provider control write and preserve suffix routes', () => {
  assert.equal(
    samplePathForRoute({
      id: 'settings.key.update',
      path: '/api/system/settings/{namespace}/{key}',
    }),
    '/api/system/settings/app/slogan',
  )
  assert.equal(
    samplePathForRoute({
      id: 'media.share-og',
      path: '/share-og/{photoId}.png',
    }),
    '/share-og/dual-surface-missing-photo.png',
  )
  assert.equal(
    samplePathForRoute({
      id: 'media.storage',
      path: '/storage/{path}',
    }),
    '/storage/dual-surface-missing.jpg',
  )
})

test('route surface verifier toggles Go, probes routes without auth cookies, and restores Node', async () => {
  const gateway = createSurfaceGateway()
  const routes = [
    {
      id: 'identity.login',
      method: 'POST',
      path: '/api/login',
      auth: 'anonymous',
      sideEffect: 'session',
    },
    {
      id: 'settings.key.update',
      method: 'PUT',
      path: '/api/system/settings/{namespace}/{key}',
      auth: 'admin',
      sideEffect: 'database',
    },
  ]

  const result = await verifyDualRouteSurface({
    base: 'http://gateway.test',
    cookie: 'cf_session=test-token',
    timeoutMs: 1_000,
    routes,
    fetchImpl: (url, options) => {
      if (!options.headers['X-Test-Route-Id']) {
        const requestURL = new URL(String(url))
        const path = requestURL.pathname.replace(/^\/__lab\/go(?=\/)/, '')
        const route = buildRouteSurfaceProbePlan(routes, {
          surface: requestURL.pathname.startsWith('/__lab/go')
            ? 'lab'
            : 'gateway',
        }).find((step) => step.path === path && step.method === options.method)
        if (route) options.headers['X-Test-Route-Id'] = route.routeId
      }
      return gateway.fetchImpl(url, options)
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.routeCount, 2)
  assert.deepEqual(result.surfaceCounts, { gateway: 2, lab: 2 })
  assert.equal(result.probeCount, 4)
  assert.equal(gateway.getProvider(), 'node')
  assert.deepEqual(
    gateway.requests.map((request) => [
      request.method,
      new URL(request.url).pathname,
      request.headers.Cookie || null,
    ]),
    [
      ['PUT', PROVIDER_SETTING_PATH, 'cf_session=test-token'],
      ['PUT', PROVIDER_SETTING_PATH, 'cf_session=test-token'],
      ['POST', '/api/login', null],
      ['PUT', '/api/system/settings/app/slogan', null],
      ['POST', '/__lab/go/api/login', null],
      ['PUT', '/__lab/go/api/system/settings/app/slogan', null],
      ['PUT', PROVIDER_SETTING_PATH, 'cf_session=test-token'],
    ],
  )
})

test('route surface verifier reports a route that falls back to Node', async () => {
  const gateway = createSurfaceGateway({ driftRouteId: 'identity.login' })
  const routes = [
    {
      id: 'identity.login',
      method: 'POST',
      path: '/api/login',
      auth: 'anonymous',
      sideEffect: 'session',
    },
  ]

  const result = await verifyDualRouteSurface({
    base: 'http://gateway.test',
    cookie: 'cf_session=test-token',
    timeoutMs: 1_000,
    routes,
    fetchImpl: (url, options) => {
      const path = new URL(String(url)).pathname.replace(
        /^\/__lab\/go(?=\/)/,
        '',
      )
      if (path === '/api/login') {
        options.headers['X-Test-Route-Id'] = 'identity.login'
      }
      return gateway.fetchImpl(url, options)
    },
  })

  assert.equal(result.ok, false)
  assert.equal(gateway.getProvider(), 'node')
  assert.deepEqual(
    result.errors.map((error) => error.routeId),
    ['identity.login', 'identity.login'],
  )
  assert.deepEqual(
    result.errors.map((error) => error.field),
    ['headers.x-chronoframe-backend', 'headers.x-chronoframe-backend'],
  )
})

test('route surface validation rejects 5xx responses even from Go', () => {
  assert.deepEqual(
    validateSurfaceProbe(
      {
        name: 'probe',
        routeId: 'system.logs',
        method: 'GET',
        path: '/api/system/logs',
        expectedBackend: 'go',
        maxStatus: 499,
      },
      {
        status: 500,
        backend: 'go',
        bodyPreview: 'panic',
      },
    ).map((error) => error.field),
    ['status'],
  )
})

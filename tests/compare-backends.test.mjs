import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  COMPARABLE_READ_ROUTE_SAMPLES,
  COMPARABLE_READ_ROUTES,
  canonicalize,
  compareComparableReads,
  compareBackends,
  joinBackendURL,
  normalizedContentType,
  removeJSONPointer,
  resolveSafeReadPath,
} from '../scripts/compare-backends.mjs'

const routeManifest = JSON.parse(
  readFileSync(
    new URL('../backend/contracts/routes.yaml', import.meta.url),
    'utf8',
  ),
)

function backendResponse(backend, { status = 200, setCookie = false } = {}) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'x-chronoframe-backend': backend,
    'x-request-id': 'request-1',
  }
  if (setCookie) headers['set-cookie'] = 'sensitive=value'
  return new Response(JSON.stringify({ data: {}, timestamp: 1 }), {
    status,
    headers,
  })
}

test('canonicalize ignores object key order but preserves array order', () => {
  const left = canonicalize({ z: 1, a: { y: 2, x: [3, 1] } })
  const right = canonicalize({ a: { x: [3, 1], y: 2 }, z: 1 })
  assert.equal(JSON.stringify(left), JSON.stringify(right))
  assert.notEqual(
    JSON.stringify(canonicalize({ values: [1, 2] })),
    JSON.stringify(canonicalize({ values: [2, 1] })),
  )
})

test('removeJSONPointer removes only the approved dynamic field', () => {
  const value = { timestamp: 123, data: { timestamp: 'keep' } }
  removeJSONPointer(value, '/timestamp')
  assert.deepEqual(value, { data: { timestamp: 'keep' } })
})

test('removeJSONPointer supports wildcard array segments', () => {
  const value = {
    pool: {
      totalWorkers: 2,
      workers: [
        { workerId: 'worker-1', uptime: 10, processedCount: 1 },
        { workerId: 'worker-2', uptime: 11, processedCount: 0 },
      ],
    },
  }

  removeJSONPointer(value, '/pool/workers/*/uptime')

  assert.deepEqual(value, {
    pool: {
      totalWorkers: 2,
      workers: [
        { workerId: 'worker-1', processedCount: 1 },
        { workerId: 'worker-2', processedCount: 0 },
      ],
    },
  })
})

test('content type comparison ignores charset parameters', () => {
  assert.equal(
    normalizedContentType('application/json; charset=utf-8'),
    'application/json',
  )
})

test('backend URL joining preserves a lab-router base path', () => {
  assert.equal(
    joinBackendURL(
      'http://127.0.0.1:3100/__lab/go/',
      '/api/system/settings/all',
    ).href,
    'http://127.0.0.1:3100/__lab/go/api/system/settings/all',
  )
  assert.equal(
    joinBackendURL('http://127.0.0.1:3100', '/health/live').href,
    'http://127.0.0.1:3100/health/live',
  )
})

test('backend URL joining and route approval preserve read query strings', () => {
  assert.equal(
    joinBackendURL(
      'http://127.0.0.1:3100/__lab/go',
      '/api/photos/reactions?ids=img-1&ids=video-1',
    ).href,
    'http://127.0.0.1:3100/__lab/go/api/photos/reactions?ids=img-1&ids=video-1',
  )
})

test('comparison route registry is derived from the route contract', () => {
  const manifestComparableReadRouteIds = routeManifest.routes
    .filter(
      (route) =>
        route.method === 'GET' &&
        route.sideEffect === 'none' &&
        route.allowCompare === true,
    )
    .map((route) => route.id)
    .sort()

  assert.deepEqual(
    COMPARABLE_READ_ROUTES.map((route) => route.id).sort(),
    manifestComparableReadRouteIds,
  )
  assert.ok(
    COMPARABLE_READ_ROUTES.every(
      (route) =>
        route.expectedStatus === 200 && route.responseSideEffect === 'none',
    ),
  )
  const sampleRouteIds = new Set(
    COMPARABLE_READ_ROUTE_SAMPLES.map((sample) => sample.id),
  )
  assert.deepEqual([...sampleRouteIds].sort(), manifestComparableReadRouteIds)
  for (const sample of COMPARABLE_READ_ROUTE_SAMPLES) {
    assert.equal(resolveSafeReadPath(sample.path)?.id, sample.id)
  }
})

test('comparison route resolver keeps specific routes ahead of generic settings routes', () => {
  assert.equal(
    resolveSafeReadPath('/api/system/settings/storage-config')?.id,
    'settings.storage-config.list',
  )
  assert.equal(
    resolveSafeReadPath('/api/system/settings/storage-config/1')?.id,
    'settings.storage-config.read',
  )
  assert.equal(
    resolveSafeReadPath('/api/system/settings/system/backend.readProvider')?.id,
    'settings.key.read',
  )
})

test('comparison route resolver rejects unsafe setting namespaces', () => {
  assert.equal(resolveSafeReadPath('/api/system/settings/security'), undefined)
  assert.equal(
    resolveSafeReadPath('/api/system/settings/security/jwtSecret'),
    undefined,
  )
})

test('comparison rejects matching error responses instead of reporting equality', async () => {
  const originalFetch = globalThis.fetch
  let call = 0
  globalThis.fetch = async () =>
    backendResponse(call++ === 0 ? 'node' : 'go', { status: 500 })
  try {
    const result = await compareBackends({
      nodeURL: 'http://node.test',
      goURL: 'http://go.test',
      path: '/api/system/settings/all',
      requestId: 'request-1',
    })
    assert.equal(result.equal, false)
    assert.ok(result.differences.some(({ field }) => field === 'node.status'))
    assert.ok(result.differences.some(({ field }) => field === 'go.status'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('comparison rejects cookies on a side-effect-free route', async () => {
  const originalFetch = globalThis.fetch
  let call = 0
  globalThis.fetch = async () => {
    const backend = call++ === 0 ? 'node' : 'go'
    return backendResponse(backend, { setCookie: backend === 'node' })
  }
  try {
    const result = await compareBackends({
      nodeURL: 'http://node.test',
      goURL: 'http://go.test',
      path: '/api/system/settings/all',
      requestId: 'request-1',
    })
    assert.equal(result.equal, false)
    assert.ok(
      result.differences.some(
        ({ field }) => field === 'node.headers.set-cookie',
      ),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('comparison can run every comparable read sample from the contract', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options })
    return backendResponse(
      String(url).startsWith('http://node.test') ? 'node' : 'go',
    )
  }
  try {
    const result = await compareComparableReads({
      nodeURL: 'http://node.test',
      goURL: 'http://go.test',
      requestHeaders: {
        Cookie: 'cf_session=test',
        'X-Request-Id': 'request-1',
      },
    })
    assert.equal(result.equal, true)
    assert.equal(result.total, COMPARABLE_READ_ROUTE_SAMPLES.length)
    assert.equal(requests.length, COMPARABLE_READ_ROUTE_SAMPLES.length * 2)
    for (const request of requests) {
      assert.equal(request.options.headers.Cookie, 'cf_session=test')
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('comparison allows authenticated Go read routes and parameterized reads', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options })
    return backendResponse(
      String(url).startsWith('http://node.test') ? 'node' : 'go',
    )
  }
  try {
    for (const path of [
      '/api/albums/42',
      '/api/photos/photo-1/albums',
      '/api/queue/stats/1',
      '/api/queue/stats',
      '/api/system/stats',
      '/api/system/settings/system',
      '/api/system/settings/system/backend.readProvider',
      '/api/system/settings/storage-config/1',
      '/api/upload-shares/public/token-with-at-least-24-chars',
    ]) {
      const result = await compareBackends({
        nodeURL: 'http://node.test',
        goURL: 'http://go.test',
        path,
        requestHeaders: { Cookie: 'cf_session=test' },
        requestId: 'request-1',
      })
      assert.equal(result.equal, true)
    }
    assert.equal(requests.length, 18)
    for (const request of requests) {
      assert.equal(request.options.headers.Cookie, 'cf_session=test')
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('comparison allowlist rejects upload share mutation-shaped routes', async () => {
  await assert.rejects(
    compareBackends({
      nodeURL: 'http://node.test',
      goURL: 'http://go.test',
      path: '/api/upload-shares/1',
      requestId: 'request-1',
    }),
    /Refusing to compare unapproved route/,
  )
})

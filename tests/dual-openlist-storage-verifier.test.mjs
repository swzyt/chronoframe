import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_OPENLIST_STORAGE_COOKIE,
  parseOpenListStorageVerifierOptions,
  startFakeOpenListServer,
  verifyDualOpenListStorage,
} from '../scripts/verify-dual-openlist-storage.mjs'

function jsonResponse(body, backend = 'node', status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-chronoframe-backend': backend,
      'x-request-id': 'response-request-id',
    },
  })
}

function createGateway() {
  const state = {
    backend: 'node',
    activeStorageProvider: 17,
    requests: [],
  }
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url)
    const body = options.body ? JSON.parse(options.body) : undefined
    const request = {
      method: options.method || 'GET',
      path: parsed.pathname,
      body,
      backend: state.backend,
    }
    state.requests.push(request)

    if (
      request.method === 'PUT' &&
      request.path === '/api/system/settings/system/backend.readProvider'
    ) {
      state.backend = body.value
      return jsonResponse({ value: state.backend }, 'node')
    }
    if (
      request.method === 'GET' &&
      request.path === '/api/system/settings/storage/provider'
    ) {
      return jsonResponse({ value: state.activeStorageProvider }, state.backend)
    }
    if (
      request.method === 'PUT' &&
      request.path === '/api/system/settings/storage/provider'
    ) {
      state.activeStorageProvider = body.value
      return jsonResponse({ value: body.value }, state.backend)
    }
    if (
      request.method === 'POST' &&
      request.path === '/api/system/settings/storage-config'
    ) {
      return jsonResponse({ id: 99 }, state.backend)
    }
    if (
      request.method === 'DELETE' &&
      request.path === '/api/system/settings/storage-config/99'
    ) {
      return jsonResponse({ success: true }, state.backend)
    }
    if (
      request.method === 'PUT' &&
      request.path === '/api/system/settings/storage-config/99'
    ) {
      return jsonResponse({ success: true }, state.backend)
    }
    return jsonResponse({ statusMessage: 'not found' }, state.backend, 404)
  }
  return { fetchImpl, state }
}

function createOpenListServerStub({ unexpectedRequests = 0 } = {}) {
  const state = { cleared: 0, closed: 0 }
  return {
    state,
    factory: async () => ({
      baseURL: 'http://openlist-fixture:4321',
      snapshot() {
        return {
          objectCount: 0,
          requestCount: 8,
          authFailures: 0,
          unexpectedRequests,
          byRoute: {
            'PUT /api/fs/put': 2,
            'POST /api/fs/get': 2,
            'GET /download': 2,
            'GET /raw': 2,
            'POST /api/fs/remove': 2,
          },
          observedKeys: [],
          ignoredRangeRequests: 4,
        }
      },
      clear() {
        state.cleared += 1
        return 0
      },
      async close() {
        state.closed += 1
      },
    }),
  }
}

test('OpenList protocol fixture accepts authenticated upload, metadata, download, and delete', async () => {
  const token = 'fixture-token'
  const fixture = await startFakeOpenListServer({
    bind: '127.0.0.1',
    publicHost: '127.0.0.1',
    token,
  })
  const body = Buffer.from('openlist protocol fixture')
  const key = '/root/photos/example image.png'
  const authHeaders = { Authorization: token }

  try {
    const upload = await fetch(`${fixture.baseURL}/api/fs/put`, {
      method: 'PUT',
      headers: {
        ...authHeaders,
        'Content-Type': 'image/png',
        'File-Path': encodeURIComponent(key),
      },
      body,
    })
    assert.equal(upload.status, 200)

    const meta = await fetch(`${fixture.baseURL}/api/fs/get`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: key }),
    })
    assert.equal(meta.status, 200)
    const metadata = await meta.json()
    assert.equal(metadata.data.size, body.byteLength)
    assert.equal(metadata.data.content_type, 'image/png')

    const ranged = await fetch(
      `${fixture.baseURL}/download?path=${encodeURIComponent(key)}`,
      { headers: { ...authHeaders, Range: 'bytes=3-7' } },
    )
    assert.equal(ranged.status, 200)
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), body)

    const raw = await fetch(metadata.data.raw_url)
    assert.equal(raw.status, 200)
    assert.deepEqual(Buffer.from(await raw.arrayBuffer()), body)

    const remove = await fetch(`${fixture.baseURL}/api/fs/remove`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dir: '/root/photos',
        names: ['example image.png'],
      }),
    })
    assert.equal(remove.status, 200)

    const snapshot = fixture.snapshot()
    assert.equal(snapshot.objectCount, 0)
    assert.equal(snapshot.authFailures, 0)
    assert.equal(snapshot.unexpectedRequests, 0)
    assert.equal(snapshot.byRoute['PUT /api/fs/put'], 1)
    assert.equal(snapshot.byRoute['POST /api/fs/get'], 1)
    assert.equal(snapshot.byRoute['GET /download'], 1)
    assert.equal(snapshot.byRoute['GET /raw'], 1)
    assert.equal(snapshot.byRoute['POST /api/fs/remove'], 1)
    assert.equal(snapshot.ignoredRangeRequests, 1)
  } finally {
    await fixture.close()
  }
})

test('dual OpenList verifier provisions shared storage and runs Node and Go media matrices', async () => {
  const gateway = createGateway()
  const openList = createOpenListServerStub()
  const mediaRuns = []
  const serverOptions = []
  const summary = await verifyDualOpenListStorage({
    base: 'http://dual.test',
    cookie: DEFAULT_OPENLIST_STORAGE_COOKIE,
    timeoutMs: 5_000,
    pollMs: 1,
    prefix: 'openlist-test',
    openListBind: '0.0.0.0',
    openListHost: 'openlist-fixture',
    token: 'shared-token',
    fetchImpl: gateway.fetchImpl,
    sleep: async () => {},
    openListServerFactory: async (options) => {
      serverOptions.push(options)
      return openList.factory(options)
    },
    mediaVerifier: async (options) => {
      mediaRuns.push(options)
      return {
        ok: true,
        cleanup: [{ name: 'delete media parity photo', ok: true }],
        mediaComparisons: 11,
        checkCount: 31,
      }
    },
  })

  assert.equal(summary.ok, true)
  assert.equal(summary.runCount, 4)
  assert.deepEqual(
    mediaRuns.map((run) => [run.setupProvider, run.cleanupProvider]),
    [
      ['node', 'node'],
      ['go', 'go'],
      ['node', 'node'],
      ['go', 'go'],
    ],
  )
  assert.equal(serverOptions[0].bind, '0.0.0.0')
  assert.equal(serverOptions[0].publicHost, 'openlist-fixture')
  assert.equal(serverOptions[0].token, 'shared-token')

  const create = gateway.state.requests.find(
    (request) =>
      request.method === 'POST' &&
      request.path === '/api/system/settings/storage-config',
  )
  assert.equal(create.backend, 'go')
  assert.equal(create.body.provider, 'openlist')
  assert.equal(create.body.config.baseUrl, 'http://openlist-fixture:4321')
  assert.match(create.body.config.rootPath, /^\/openlist-test\/[a-f0-9]{8}$/)
  assert.equal(create.body.config.downloadEndpoint, '/download')
  assert.equal(create.body.config.token, 'shared-token')
  const update = gateway.state.requests.find(
    (request) =>
      request.method === 'PUT' &&
      request.path === '/api/system/settings/storage-config/99',
  )
  assert.equal(update.backend, 'node')
  assert.equal(update.body.provider, 'openlist')
  assert.equal(update.body.config.downloadEndpoint, '')
  assert.equal(gateway.state.backend, 'node')
  assert.equal(gateway.state.activeStorageProvider, 17)
  assert.equal(openList.state.cleared, 1)
  assert.equal(openList.state.closed, 1)
})

test('dual OpenList verifier rejects unexpected protocol traffic and still cleans up', async () => {
  const gateway = createGateway()
  const openList = createOpenListServerStub({ unexpectedRequests: 1 })
  const summary = await verifyDualOpenListStorage({
    base: 'http://dual.test',
    timeoutMs: 5_000,
    pollMs: 1,
    fetchImpl: gateway.fetchImpl,
    sleep: async () => {},
    openListServerFactory: openList.factory,
    mediaVerifier: async () => ({
      ok: true,
      cleanup: [{ name: 'delete media parity photo', ok: true }],
      mediaComparisons: 11,
      checkCount: 31,
    }),
  })

  assert.equal(summary.ok, false)
  assert.match(summary.errors[0].message, /unexpected requests/)
  assert.equal(gateway.state.backend, 'node')
  assert.equal(gateway.state.activeStorageProvider, 17)
  assert.equal(openList.state.cleared, 1)
  assert.equal(openList.state.closed, 1)
})

test('dual OpenList verifier option parser accepts container values', () => {
  assert.deepEqual(
    parseOpenListStorageVerifierOptions([], {
      CFRAME_DUAL_PORT: '33120',
      CFRAME_DUAL_COOKIE: 'cf_session=test',
      CFRAME_DUAL_OPENLIST_TIMEOUT_MS: '9000',
      CFRAME_DUAL_OPENLIST_POLL_MS: '25',
      CFRAME_DUAL_OPENLIST_PREFIX: 'OpenList env',
      CFRAME_DUAL_OPENLIST_BIND: '0.0.0.0',
      CFRAME_DUAL_OPENLIST_HOST: 'fixture-host',
      CFRAME_DUAL_OPENLIST_PORT: '4876',
      CFRAME_DUAL_OPENLIST_TOKEN: 'token',
    }),
    {
      base: 'http://127.0.0.1:33120',
      cookie: 'cf_session=test',
      timeoutMs: 9000,
      pollMs: 25,
      prefix: 'OpenList-env',
      openListBind: '0.0.0.0',
      openListHost: 'fixture-host',
      openListPort: 4876,
      token: 'token',
    },
  )
})

test('dual OpenList verifier rejects unsafe public hosts', () => {
  assert.throws(
    () =>
      parseOpenListStorageVerifierOptions([
        '--openlist-host',
        'http://fixture.invalid',
      ]),
    /openlist-host must be a hostname or IP address/,
  )
})

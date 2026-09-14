import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_MEDIA_PARITY_COOKIE,
  parseMediaParityVerifierOptions,
  verifyDualMediaParity,
} from '../scripts/verify-dual-media-parity.mjs'

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

function mediaResponse(body, backend, contentType, request) {
  const source = Buffer.from(body)
  const headers = {
    'content-type': contentType,
    'cache-control':
      contentType === 'image/png'
        ? 'private, max-age=86400'
        : 'private, max-age=604800',
    'accept-ranges': 'bytes',
    vary: 'Cookie',
    'x-chronoframe-backend': backend,
    'x-request-id': 'response-request-1',
  }
  const range = request.headers.Range || request.headers.range
  const ifRange = request.headers['If-Range'] || request.headers['if-range']
  if (range === 'bytes=-4' && ifRange !== '"stale-validator"') {
    const ranged = source.subarray(source.length - 4)
    headers['content-range'] =
      `bytes ${source.length - 4}-${source.length - 1}/${source.length}`
    headers['content-length'] = String(ranged.length)
    return new Response(request.method === 'HEAD' ? null : ranged, {
      status: 206,
      headers,
    })
  }
  headers['content-length'] = String(source.length)
  return new Response(request.method === 'HEAD' ? null : source, {
    status: 200,
    headers,
  })
}

function createGateway({ goBodyDrift = false, externalUpload = false } = {}) {
  const state = {
    provider: 'node',
    nextTaskId: 1,
    tasks: new Map(),
    photos: new Map(),
    requests: [],
  }
  const fetchImpl = async (url, options) => {
    const urlObject = new URL(url)
    const request = {
      method: options.method,
      hostname: urlObject.hostname,
      path: urlObject.pathname,
      headers: options.headers,
      body:
        options.body && options.headers['Content-Type'] === 'application/json'
          ? JSON.parse(options.body)
          : undefined,
    }
    state.requests.push(request)
    if (urlObject.hostname === 'minio.test' && request.method === 'PUT') {
      return new Response(null, { status: 200 })
    }
    if (
      request.method === 'PUT' &&
      request.path === '/api/system/settings/system/backend.readProvider'
    ) {
      state.provider = request.body.value
      return jsonResponse({ value: state.provider }, 'node')
    }
    const backend = state.provider
    if (request.path === '/api/queue/stats') {
      return jsonResponse(
        {
          pool: {
            isActive: true,
            workers: [{ workerId: 'go-worker-1' }],
          },
        },
        backend,
      )
    }
    if (request.path === '/api/photos' && request.method === 'POST') {
      const key = `dual-fixture/users/910001/${request.body.fileName}`
      return jsonResponse(
        {
          signedUrl: externalUpload
            ? `http://minio.test/test-bucket/${key}?signature=test`
            : `/api/photos/upload?key=${encodeURIComponent(key)}`,
          fileKey: key,
          contentHash: request.body.contentHash,
          expiresIn: 3600,
        },
        backend,
      )
    }
    if (request.path === '/api/photos/upload' && request.method === 'PUT') {
      return jsonResponse(
        { ok: true, key: urlObject.searchParams.get('key') },
        backend,
      )
    }
    if (request.path === '/api/queue/add-task' && request.method === 'POST') {
      const taskId = state.nextTaskId++
      const storageKey = request.body.payload.storageKey
      const photoId = storageKey
        .split('/')
        .at(-1)
        .replace(/\.[^.]*$/, '')
      state.tasks.set(taskId, { id: taskId, status: 'completed' })
      state.photos.set(photoId, {
        id: photoId,
        storageKey,
        thumbnailKey: `dual-fixture/thumbnails/910001/${photoId}.webp`,
        thumbnailUrl: `/image/dual-fixture/thumbnails/910001/${photoId}.webp`,
        displayKey: `dual-fixture/display/910001/${photoId}.webp`,
      })
      return jsonResponse({ success: true, taskId }, backend)
    }
    const taskMatch = /^\/api\/queue\/stats\/(\d+)$/.exec(request.path)
    if (taskMatch)
      return jsonResponse(state.tasks.get(Number(taskMatch[1])), backend)
    if (request.path === '/api/photos' && request.method === 'GET') {
      return jsonResponse({ items: [...state.photos.values()] }, backend)
    }
    if (
      /^\/api\/photos\/[^/]+$/.test(request.path) &&
      request.method === 'DELETE'
    ) {
      return jsonResponse({ ok: true }, backend)
    }
    if (
      request.path.startsWith('/image/') ||
      request.path.startsWith('/storage/') ||
      request.path.startsWith('/display/') ||
      request.path.startsWith('/thumb/')
    ) {
      const contentType = request.path.endsWith('.png')
        ? 'image/png'
        : request.path.startsWith('/thumb/')
          ? 'image/jpeg'
          : 'image/webp'
      const body =
        goBodyDrift && backend === 'go' && request.path.endsWith('.webp')
          ? `${request.path}:go`
          : request.path
      return mediaResponse(body, backend, contentType, request)
    }
    return jsonResponse({ statusMessage: 'not found' }, backend, 404)
  }
  return { fetchImpl, state }
}

test('dual media parity verifier compares Node and Go media bytes and headers', async () => {
  const gateway = createGateway()
  const summary = await verifyDualMediaParity({
    base: 'http://dual.test',
    cookie: DEFAULT_MEDIA_PARITY_COOKIE,
    timeoutMs: 5_000,
    pollMs: 1,
    prefix: 'dual-media-test',
    fetchImpl: gateway.fetchImpl,
    sleep: async () => {},
  })

  assert.equal(summary.ok, true)
  assert.equal(summary.mediaComparisons, 22)
  assert.equal(gateway.state.provider, 'node')
  assert.ok(
    summary.checks.some(
      (check) =>
        check.name ===
          'media parity compare: original suffix Range image media via go' &&
        check.status === 206 &&
        check.byteLength === 4,
    ),
  )
})

test('dual media parity verifier supports external presigned uploads and configurable setup/cleanup owners', async () => {
  const gateway = createGateway({ externalUpload: true })
  const summary = await verifyDualMediaParity({
    base: 'http://dual.test',
    cookie: DEFAULT_MEDIA_PARITY_COOKIE,
    timeoutMs: 5_000,
    pollMs: 1,
    prefix: 'dual-s3-media-test',
    setupProvider: 'node',
    cleanupProvider: 'node',
    fetchImpl: gateway.fetchImpl,
    sleep: async () => {},
  })

  assert.equal(summary.ok, true)
  assert.equal(summary.mediaComparisons, 22)
  const upload = gateway.state.requests.find(
    (request) => request.hostname === 'minio.test' && request.method === 'PUT',
  )
  assert.ok(upload)
  assert.equal(Object.hasOwn(upload.headers, 'Cookie'), false)
  assert.ok(
    summary.checks.some(
      (check) =>
        check.name === 'media parity setup: prepare upload via node' &&
        check.backend === 'node',
    ),
  )
  assert.ok(
    summary.checks.some(
      (check) =>
        check.name.startsWith('cleanup: delete media parity photo') &&
        check.backend === 'node',
    ),
  )
})

test('dual media parity verifier rejects byte drift', async () => {
  const gateway = createGateway({ goBodyDrift: true })
  const summary = await verifyDualMediaParity({
    base: 'http://dual.test',
    cookie: DEFAULT_MEDIA_PARITY_COOKIE,
    timeoutMs: 5_000,
    pollMs: 1,
    fetchImpl: gateway.fetchImpl,
    sleep: async () => {},
  })

  assert.equal(summary.ok, false)
  assert.equal(
    summary.errors?.[0]?.name,
    'media parity compare: thumbnail image media',
  )
  assert.equal(
    summary.errors?.some((error) => error.field === 'sha256'),
    true,
  )
  assert.equal(gateway.state.provider, 'node')
})

test('media parity option parser accepts env defaults', () => {
  assert.deepEqual(
    parseMediaParityVerifierOptions([], {
      CFRAME_DUAL_PORT: '33115',
      CFRAME_DUAL_COOKIE: 'cf_session=test',
      CFRAME_DUAL_MEDIA_PARITY_TIMEOUT_MS: '1000',
      CFRAME_DUAL_MEDIA_PARITY_POLL_MS: '10',
      CFRAME_DUAL_MEDIA_PARITY_PREFIX: 'media env',
    }),
    {
      base: 'http://127.0.0.1:33115',
      cookie: 'cf_session=test',
      timeoutMs: 1000,
      pollMs: 10,
      prefix: 'media-env',
    },
  )
})

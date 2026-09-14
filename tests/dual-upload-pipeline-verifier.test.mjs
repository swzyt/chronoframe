import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_UPLOAD_PIPELINE_COOKIE,
  parseUploadPipelineVerifierOptions,
  verifyDualUploadPipeline,
} from '../scripts/verify-dual-upload-pipeline.mjs'

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

function mediaResponse(
  body,
  backend,
  contentType = 'image/webp',
  range = '',
  ifRange = '',
  method = 'GET',
) {
  const headers = {
    'content-type': contentType,
    vary: 'Cookie',
    'x-chronoframe-backend': backend,
    'x-request-id': 'response-request-1',
  }
  const bodyBuffer = Buffer.from(body)
  const match = /^bytes=-(\d+)$/.exec(range)
  if (match && (!ifRange || ifRange === '"media-object-etag"')) {
    const suffixLength = Number(match[1])
    const start = Math.max(bodyBuffer.length - suffixLength, 0)
    const rangedBody = bodyBuffer.subarray(start)
    headers['content-range'] =
      `bytes ${start}-${bodyBuffer.length - 1}/${bodyBuffer.length}`
    headers['content-length'] = String(rangedBody.length)
    if (method === 'HEAD') {
      return new Response(null, { status: 206, headers })
    }
    return new Response(rangedBody, { status: 206, headers })
  }
  headers['content-length'] = String(bodyBuffer.length)
  if (method === 'HEAD') {
    return new Response(null, { status: 200, headers })
  }
  return new Response(bodyBuffer, { status: 200, headers })
}

function createUploadPipelineGateway({
  consumerActive = true,
  consumerActivatesAfterStatsPolls = 0,
  failTask = false,
  omitThumbnail = false,
  goWorkerTelemetry = true,
} = {}) {
  const state = {
    provider: 'node',
    nextTaskId: 990_001,
    nextUploadShareId: 995_001,
    statsPolls: 0,
    taskPolls: 0,
    uploadedObjects: new Map(),
    uploadShares: new Map(),
    tasks: new Map(),
    photos: new Map(),
    requests: [],
  }

  const fetchImpl = async (url, options) => {
    const urlObject = new URL(url)
    const directGo = urlObject.pathname.startsWith('/__lab/go')
    const pathname = directGo
      ? urlObject.pathname.replace(/^\/__lab\/go/, '') || '/'
      : urlObject.pathname
    const contentType = options.headers['Content-Type'] || ''
    const request = {
      url: String(url),
      method: options.method,
      body:
        options.body && contentType.startsWith('application/json')
          ? JSON.parse(options.body)
          : undefined,
      rawBody:
        options.body && !contentType.startsWith('application/json')
          ? Buffer.from(options.body).toString('base64')
          : undefined,
      headers: options.headers,
    }
    state.requests.push(request)

    if (
      request.method === 'PUT' &&
      pathname === '/api/system/settings/system/backend.readProvider'
    ) {
      state.provider = request.body.value
      return jsonResponse(
        {
          namespace: 'system',
          key: 'backend.readProvider',
          value: state.provider,
        },
        'node',
      )
    }

    const backend = directGo ? 'go' : state.provider

    if (pathname === '/api/queue/stats' && request.method === 'GET') {
      state.statsPolls += 1
      const active =
        consumerActive ||
        (consumerActivatesAfterStatsPolls > 0 &&
          state.statsPolls >= consumerActivatesAfterStatsPolls)
      const configuredWorkers =
        active || consumerActivatesAfterStatsPolls > 0 ? 1 : 0
      return jsonResponse(
        {
          timestamp: '2026-09-11T00:00:00.000Z',
          pool: {
            isActive: active,
            totalWorkers: configuredWorkers,
            workerCount: configuredWorkers,
            workers:
              configuredWorkers > 0
                ? [
                    {
                      workerId: goWorkerTelemetry ? 'go-worker-1' : 'worker-1',
                      isProcessing: false,
                    },
                  ]
                : [],
          },
          queue: {},
        },
        backend,
      )
    }

    if (pathname === '/api/photos' && request.method === 'POST') {
      const fileName = request.body.fileName
      const fileKey = `dual-fixture/users/910001/${fileName}`
      return jsonResponse(
        {
          signedUrl: `/api/photos/upload?key=${encodeURIComponent(fileKey)}`,
          fileKey,
          contentHash: request.body.contentHash,
          expiresIn: 3600,
        },
        backend,
      )
    }

    if (pathname === '/api/photos/upload' && request.method === 'PUT') {
      const key = urlObject.searchParams.get('key')
      state.uploadedObjects.set(key, request.rawBody)
      return jsonResponse({ ok: true, key }, backend)
    }

    if (pathname === '/api/queue/add-task' && request.method === 'POST') {
      const id = state.nextTaskId++
      const storedPayload = reorderPhotoPayload(request.body.payload)
      state.tasks.set(id, {
        id,
        payload: storedPayload,
        status: 'pending',
        ownerUserId: 910001,
      })
      return jsonResponse(
        {
          success: true,
          taskId: id,
          message: 'Task added to queue successfully',
          payload: storedPayload,
        },
        backend,
      )
    }

    if (pathname === '/api/upload-shares' && request.method === 'GET') {
      return jsonResponse([...state.uploadShares.values()], backend)
    }

    if (pathname === '/api/upload-shares' && request.method === 'POST') {
      const id = state.nextUploadShareId++
      const share = {
        id,
        label: request.body.label || null,
        isActive: true,
        uploadCount: 0,
        maxUploads: request.body.maxUploads ?? null,
        expiresAt: '2026-09-12T18:52:31.000Z',
        lastUsedAt: null,
        createdAt: '2026-09-11T18:52:31.000Z',
        updatedAt: '2026-09-11T18:52:31.000Z',
        token: `public-token-${id}`,
        url: `http://dual.test/upload/public-token-${id}`,
      }
      state.uploadShares.set(id, share)
      return jsonResponse(share, backend)
    }

    const uploadShareAdminMatch = /^\/api\/upload-shares\/(\d+)$/.exec(pathname)
    if (uploadShareAdminMatch && request.method === 'DELETE') {
      state.uploadShares.delete(Number(uploadShareAdminMatch[1]))
      return jsonResponse({ ok: true }, backend)
    }

    const publicUploadReadMatch =
      /^\/api\/upload-shares\/public\/([^/]+)$/.exec(pathname)
    if (publicUploadReadMatch && request.method === 'GET') {
      const token = decodeURIComponent(publicUploadReadMatch[1])
      const share = [...state.uploadShares.values()].find(
        (candidate) => candidate.token === token,
      )
      if (!share) {
        return jsonResponse(
          { statusMessage: 'Upload link not found' },
          backend,
          404,
        )
      }
      return jsonResponse(
        {
          id: share.id,
          label: share.label,
          expiresAt: share.expiresAt,
          uploadCount: share.uploadCount,
          maxUploads: share.maxUploads,
          owner: {
            username: 'dual-backend-fixture-admin',
            avatar: null,
          },
          maxFileSizeMB: 256,
        },
        backend,
      )
    }

    const publicUploadMatch =
      /^\/api\/upload-shares\/public\/([^/]+)\/(prepare|upload|task)$/.exec(
        pathname,
      )
    if (publicUploadMatch) {
      const token = decodeURIComponent(publicUploadMatch[1])
      const action = publicUploadMatch[2]
      const share = [...state.uploadShares.values()].find(
        (candidate) => candidate.token === token,
      )
      if (!share) {
        return jsonResponse(
          { statusMessage: 'Upload link not found' },
          backend,
          404,
        )
      }
      if (share.maxUploads !== null && share.uploadCount >= share.maxUploads) {
        return jsonResponse(
          {
            error: true,
            statusCode: 429,
            statusMessage: 'Upload link limit reached',
            message: 'Upload link limit reached',
          },
          backend,
          429,
        )
      }
      if (action === 'prepare' && request.method === 'POST') {
        const extension = request.body.fileName.endsWith('.png') ? '.png' : ''
        const baseName = request.body.fileName.replace(/\.[^.]*$/, '')
        const fileKey = `dual-fixture/users/910001/guest-uploads/${share.id}/2026-09-12/${baseName}-abcdef012345${extension}`
        return jsonResponse(
          {
            signedUrl: `/api/upload-shares/public/${encodeURIComponent(
              token,
            )}/upload?key=${encodeURIComponent(fileKey)}`,
            fileKey,
            contentHash: request.body.contentHash,
            expiresIn: 3600,
          },
          backend,
        )
      }
      if (action === 'upload' && request.method === 'PUT') {
        const key = urlObject.searchParams.get('key')
        state.uploadedObjects.set(key, request.rawBody)
        return jsonResponse({ ok: true, key }, backend)
      }
      if (action === 'task' && request.method === 'POST') {
        const id = state.nextTaskId++
        const storedPayload = reorderPhotoPayload(request.body.payload)
        state.tasks.set(id, {
          id,
          payload: storedPayload,
          status: 'pending',
          ownerUserId: 910001,
        })
        share.uploadCount += 1
        share.lastUsedAt = '2026-09-11T18:52:32.000Z'
        share.updatedAt = '2026-09-11T18:52:32.000Z'
        return jsonResponse(
          {
            success: true,
            taskId: id,
            message: 'Task added to queue successfully',
            payload: storedPayload,
          },
          backend,
        )
      }
    }

    const taskMatch = /^\/api\/queue\/stats\/(\d+)$/.exec(pathname)
    if (taskMatch && request.method === 'GET') {
      const task = state.tasks.get(Number(taskMatch[1]))
      if (!task) {
        return jsonResponse({ statusMessage: 'Task not found' }, backend, 404)
      }
      state.taskPolls += 1
      if (failTask) {
        task.status = 'failed'
        task.errorMessage = 'mock task failed'
      } else if (state.taskPolls >= 2) {
        task.status = 'completed'
        const fileName = task.payload.storageKey.split('/').at(-1)
        const photoId = fileName.replace(/\.[^.]*$/, '')
        state.photos.set(photoId, {
          id: photoId,
          title: photoId,
          description: '',
          width: 1,
          height: 1,
          mediaType: 'image',
          storageKey: task.payload.storageKey,
          contentHash: task.payload.contentHash,
          thumbnailKey: omitThumbnail
            ? ''
            : `dual-fixture/thumbnails/910001/${photoId}.webp`,
          displayKey: `dual-fixture/display/910001/${photoId}.webp`,
          originalUrl: `/image/${task.payload.storageKey}`,
          thumbnailUrl: `/image/dual-fixture/thumbnails/910001/${photoId}.webp`,
          ownerUserId: 910001,
        })
      }
      return jsonResponse(task, backend)
    }

    if (pathname === '/api/photos' && request.method === 'GET') {
      const search = urlObject.searchParams.get('search')
      const items = [...state.photos.values()].filter(
        (photo) =>
          !search ||
          photo.id.includes(search) ||
          photo.storageKey?.includes(search),
      )
      return jsonResponse(
        {
          items,
          total: items.length,
          page: 1,
          pageSize: 10,
          totalPages: 1,
        },
        backend,
      )
    }

    const photoDelete = /^\/api\/photos\/([^/]+)$/.exec(pathname)
    if (photoDelete && request.method === 'DELETE') {
      state.photos.delete(decodeURIComponent(photoDelete[1]))
      return jsonResponse(
        {
          statusCode: 200,
          statusMessage: 'Photo deleted successfully',
        },
        backend,
      )
    }

    if (
      pathname.startsWith('/image/') &&
      (request.method === 'GET' || request.method === 'HEAD')
    ) {
      return mediaResponse(
        Buffer.from('media-object'),
        backend,
        pathname.endsWith('.png') ? 'image/png' : 'image/webp',
        request.headers.Range || request.headers.range,
        request.headers['If-Range'] || request.headers['if-range'],
        request.method,
      )
    }

    return jsonResponse({ statusMessage: 'not found' }, backend, 404)
  }

  return { fetchImpl, state }
}

function reorderPhotoPayload(payload) {
  return {
    contentHash: payload.contentHash,
    eraseLocation: payload.eraseLocation,
    storageKey: payload.storageKey,
    type: payload.type,
  }
}

test('dual upload pipeline verifier exercises Go prepare, upload, enqueue, consumer and media reads', async () => {
  const gateway = createUploadPipelineGateway()
  const summary = await verifyDualUploadPipeline({
    base: 'http://dual.test',
    cookie: DEFAULT_UPLOAD_PIPELINE_COOKIE,
    timeoutMs: 5_000,
    pollMs: 1,
    prefix: 'dual-pipeline-test',
    fetchImpl: gateway.fetchImpl,
    sleep: async () => {},
  })

  assert.equal(summary.ok, true)
  assert.ok(
    summary.checks.some(
      (check) =>
        check.name === 'go upload pipeline: enqueue photo task' &&
        check.backend === 'go',
    ),
  )
  assert.ok(
    summary.checks.some(
      (check) =>
        check.name ===
          'go upload pipeline: read thumbnail through Go media route' &&
        check.contentType === 'image/webp' &&
        check.byteLength > 0,
    ),
  )
  assert.ok(
    summary.checks.some(
      (check) =>
        check.name ===
          'go upload pipeline: head original through Go media route' &&
        check.method === 'HEAD' &&
        check.contentType === 'image/png' &&
        check.vary === 'Cookie' &&
        check.byteLength === 0,
    ),
  )
  assert.ok(
    summary.checks.some(
      (check) =>
        check.name ===
          'go upload pipeline: read original suffix range through Go media route' &&
        check.status === 206 &&
        check.contentRange === 'bytes 8-11/12' &&
        check.byteLength === 4,
    ),
  )
  assert.ok(
    summary.checks.some(
      (check) =>
        check.name ===
          'go upload pipeline: stale if-range falls back to full original' &&
        check.status === 200 &&
        check.contentRange === null &&
        check.vary === 'Cookie' &&
        check.byteLength > 4,
    ),
  )
  assert.equal(summary.publicChecks, 14)
  assert.equal(summary.exhaustedShareChecks, 2)
  assert.equal(summary.atomicQuotaChecks, 6)
  assert.equal(gateway.state.provider, 'node')
  assert.equal(gateway.state.tasks.size, 4)
  assert.ok(
    [...gateway.state.tasks.values()].every(
      (task) => task.status === 'completed',
    ),
  )
  assert.equal(gateway.state.photos.size, 0)
  assert.equal(gateway.state.uploadShares.size, 0)
  assert.ok(
    gateway.state.requests.some(
      (request) =>
        request.url.includes('/api/upload-shares/public/') &&
        request.headers.Cookie === undefined,
    ),
  )
})

test('dual upload pipeline verifier rejects inactive Go consumer', async () => {
  const gateway = createUploadPipelineGateway({ consumerActive: false })
  const summary = await verifyDualUploadPipeline({
    base: 'http://dual.test',
    cookie: DEFAULT_UPLOAD_PIPELINE_COOKIE,
    timeoutMs: 5_000,
    pollMs: 1,
    fetchImpl: gateway.fetchImpl,
    sleep: async () => {},
  })

  assert.equal(summary.ok, false)
  assert.deepEqual(summary.errors?.[0], {
    name: 'go upload pipeline: verify Go consumer is active',
    field: 'body.pool.isActive',
    expected: true,
    actual: false,
  })
  assert.equal(gateway.state.provider, 'node')
})

test('dual upload pipeline verifier rejects Node worker telemetry from the Go endpoint', async () => {
  const gateway = createUploadPipelineGateway({ goWorkerTelemetry: false })
  const summary = await verifyDualUploadPipeline({
    base: 'http://dual.test',
    cookie: DEFAULT_UPLOAD_PIPELINE_COOKIE,
    timeoutMs: 5_000,
    pollMs: 1,
    fetchImpl: gateway.fetchImpl,
    sleep: async () => {},
  })

  assert.equal(summary.ok, false)
  assert.deepEqual(summary.errors?.[0], {
    name: 'go upload pipeline: verify Go consumer is active',
    field: 'body.pool.workers[].workerId',
    expected: 'at least one go-worker-* entry',
    actual: ['worker-1'],
    message:
      'The Go HTTP backend is reachable, but the queue telemetry is not from the Go pipeline consumer; start the dual stack with deploy/dual/compose.go-pipeline-consumer.yaml.',
  })
  assert.equal(gateway.state.provider, 'node')
})

test('dual upload pipeline verifier waits for Go consumer runtime lease handoff', async () => {
  const gateway = createUploadPipelineGateway({
    consumerActive: false,
    consumerActivatesAfterStatsPolls: 2,
  })
  const sleeps = []
  const summary = await verifyDualUploadPipeline({
    base: 'http://dual.test',
    cookie: DEFAULT_UPLOAD_PIPELINE_COOKIE,
    timeoutMs: 5_000,
    pollMs: 25,
    prefix: 'dual-pipeline-test',
    fetchImpl: gateway.fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })

  assert.equal(summary.ok, true)
  assert.equal(gateway.state.statsPolls, 2)
  assert.deepEqual(sleeps.slice(0, 1), [25])
  assert.equal(gateway.state.provider, 'node')
})

test('dual upload pipeline verifier reports failed Go consumer tasks', async () => {
  const gateway = createUploadPipelineGateway({ failTask: true })
  const summary = await verifyDualUploadPipeline({
    base: 'http://dual.test',
    cookie: DEFAULT_UPLOAD_PIPELINE_COOKIE,
    timeoutMs: 5_000,
    pollMs: 1,
    fetchImpl: gateway.fetchImpl,
    sleep: async () => {},
  })

  assert.equal(summary.ok, false)
  assert.equal(summary.errors?.[0]?.field, 'body.status')
  assert.equal(summary.errors?.[0]?.actual, 'failed')
  assert.equal(summary.errors?.[0]?.message, 'mock task failed')
  assert.equal(gateway.state.provider, 'node')
})

test('dual upload pipeline verifier rejects missing derived media fields', async () => {
  const gateway = createUploadPipelineGateway({ omitThumbnail: true })
  const summary = await verifyDualUploadPipeline({
    base: 'http://dual.test',
    cookie: DEFAULT_UPLOAD_PIPELINE_COOKIE,
    timeoutMs: 5_000,
    pollMs: 1,
    fetchImpl: gateway.fetchImpl,
    sleep: async () => {},
  })

  assert.equal(summary.ok, false)
  assert.equal(summary.errors?.[0]?.field, 'photo.thumbnailKey')
  assert.equal(summary.errors?.[0]?.expected, 'non-empty string')
  assert.equal(gateway.state.provider, 'node')
})

test('dual upload pipeline verifier options default to fixture session and dual port', () => {
  const options = parseUploadPipelineVerifierOptions([], {
    CFRAME_DUAL_PORT: '33142',
  })

  assert.equal(options.base, 'http://127.0.0.1:33142')
  assert.equal(options.cookie, DEFAULT_UPLOAD_PIPELINE_COOKIE)
  assert.equal(options.timeoutMs, 60_000)
  assert.equal(options.pollMs, 500)
})

test('dual upload pipeline verifier options accept explicit values', () => {
  const options = parseUploadPipelineVerifierOptions(
    [
      '--base',
      'http://127.0.0.1:33143/',
      '--cookie',
      'cf_session=test',
      '--timeout-ms',
      '1000',
      '--poll-ms',
      '25',
      '--prefix',
      'pipeline manual',
    ],
    {},
  )

  assert.equal(options.base, 'http://127.0.0.1:33143')
  assert.equal(options.cookie, 'cf_session=test')
  assert.equal(options.timeoutMs, 1000)
  assert.equal(options.pollMs, 25)
  assert.equal(options.prefix, 'pipeline-manual')
})

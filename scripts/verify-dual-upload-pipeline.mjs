#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { DUAL_BACKEND_COMPARE_FIXTURE } from './compare-backends.mjs'
import {
  FIXTURE_ADMIN_NAME,
  FIXTURE_SESSION_TOKEN,
} from './seed-dual-backend-fixture.mjs'

export const DEFAULT_UPLOAD_PIPELINE_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_UPLOAD_PIPELINE_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`
export const DEFAULT_UPLOAD_PIPELINE_PREFIX = 'dual-pipeline'
export const DEFAULT_UPLOAD_PIPELINE_TIMEOUT_MS = 60_000
export const DEFAULT_UPLOAD_PIPELINE_POLL_MS = 500

const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'
const PROVIDERS = ['node', 'go']
const TEST_IMAGE_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

export function parseUploadPipelineVerifierOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`)
    }
    if (
      !['--base', '--cookie', '--timeout-ms', '--poll-ms', '--prefix'].includes(
        arg,
      )
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

  const base =
    values.get('--base') ||
    environment.CFRAME_DUAL_BASE_URL ||
    (environment.CFRAME_DUAL_PORT
      ? `http://127.0.0.1:${environment.CFRAME_DUAL_PORT}`
      : DEFAULT_UPLOAD_PIPELINE_BASE_URL)
  const cookie =
    values.get('--cookie') ||
    environment.CFRAME_DUAL_COOKIE ||
    DEFAULT_UPLOAD_PIPELINE_COOKIE
  const timeoutMs = parsePositiveInteger(
    values.get('--timeout-ms') ||
      environment.CFRAME_DUAL_UPLOAD_PIPELINE_TIMEOUT_MS ||
      environment.CFRAME_DUAL_TIMEOUT_MS ||
      DEFAULT_UPLOAD_PIPELINE_TIMEOUT_MS,
    'timeout-ms',
  )
  const pollMs = parsePositiveInteger(
    values.get('--poll-ms') ||
      environment.CFRAME_DUAL_UPLOAD_PIPELINE_POLL_MS ||
      DEFAULT_UPLOAD_PIPELINE_POLL_MS,
    'poll-ms',
  )
  const prefix = normalizePrefix(
    values.get('--prefix') ||
      environment.CFRAME_DUAL_UPLOAD_PIPELINE_PREFIX ||
      DEFAULT_UPLOAD_PIPELINE_PREFIX,
  )

  if (timeoutMs > 120_000) {
    throw new Error('timeout-ms must be 120000 or less')
  }
  if (pollMs > 5_000) {
    throw new Error('poll-ms must be 5000 or less')
  }

  return {
    base: normalizeBaseURL(base),
    cookie: normalizeCookie(cookie),
    timeoutMs,
    pollMs,
    prefix,
  }
}

export async function verifyDualUploadPipeline({
  base = DEFAULT_UPLOAD_PIPELINE_BASE_URL,
  cookie = DEFAULT_UPLOAD_PIPELINE_COOKIE,
  timeoutMs = DEFAULT_UPLOAD_PIPELINE_TIMEOUT_MS,
  pollMs = DEFAULT_UPLOAD_PIPELINE_POLL_MS,
  prefix = DEFAULT_UPLOAD_PIPELINE_PREFIX,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function')
  }
  if (typeof sleep !== 'function') {
    throw new Error('sleep must be a function')
  }

  const normalized = {
    base: normalizeBaseURL(base),
    cookie: normalizeCookie(cookie),
    timeoutMs: parsePositiveInteger(timeoutMs, 'timeout-ms'),
    pollMs: parsePositiveInteger(pollMs, 'poll-ms'),
    prefix: normalizePrefix(prefix),
  }
  const runId = randomUUID().slice(0, 8)
  const fileName = `${normalized.prefix}-${runId}.png`
  const photoId = generateSafePhotoId(fileName)
  const contentHash = createHash('sha256')
    .update(`${normalized.prefix}:${runId}:`)
    .update(TEST_IMAGE_BUFFER)
    .digest('hex')
  const summary = {
    ok: false,
    base: normalized.base,
    prefix: normalized.prefix,
    fileName,
    photoId,
    checks: [],
    cleanup: [],
  }
  const state = {
    photoId,
    fileKey: undefined,
    taskId: undefined,
    queueTaskIds: new Set(),
    publicPhotoIds: new Set(),
    publicUploadShareIds: new Set(),
  }
  const api = createUploadPipelineAPI({ ...normalized, summary, fetchImpl })

  try {
    await setProvider(api, 'go')
    await verifyGoConsumerReady({
      api,
      timeoutMs: normalized.timeoutMs,
      pollMs: normalized.pollMs,
      sleep,
    })

    const prepare = await api.request({
      name: 'go upload pipeline: prepare photo upload',
      method: 'POST',
      path: '/api/photos',
      expectedBackend: 'go',
      body: {
        fileName,
        contentType: 'image/png',
        contentHash,
      },
    })
    expectExactKeys(
      prepare.name,
      prepare.body,
      ['signedUrl', 'fileKey', 'contentHash', 'expiresIn'],
      'body',
    )
    expectEqual(
      prepare.name,
      prepare.body?.contentHash,
      contentHash,
      'body.contentHash',
    )
    expectEqual(prepare.name, prepare.body?.expiresIn, 3600, 'body.expiresIn')
    requireNonEmptyString(
      prepare.body?.signedUrl,
      prepare.name,
      'body.signedUrl',
    )
    state.fileKey = requireNonEmptyString(
      prepare.body?.fileKey,
      prepare.name,
      'body.fileKey',
    )

    const uploadPath = relativeAPIPath(prepare.body.signedUrl)
    const upload = await api.request({
      name: 'go upload pipeline: put original object',
      method: 'PUT',
      path: uploadPath,
      expectedBackend: 'go',
      rawBody: TEST_IMAGE_BUFFER,
      contentType: 'image/png',
    })
    expectExactKeys(upload.name, upload.body, ['ok', 'key'], 'body')
    expectEqual(upload.name, upload.body?.ok, true, 'body.ok')
    expectEqual(upload.name, upload.body?.key, state.fileKey, 'body.key')

    const enqueue = await api.request({
      name: 'go upload pipeline: enqueue photo task',
      method: 'POST',
      path: '/api/queue/add-task',
      expectedBackend: 'go',
      body: {
        payload: {
          type: 'photo',
          storageKey: state.fileKey,
          contentHash,
          eraseLocation: false,
        },
        priority: 0,
        maxAttempts: 1,
      },
    })
    expectEqual(enqueue.name, enqueue.body?.success, true, 'body.success')
    state.taskId = requirePositiveInteger(
      enqueue.body?.taskId,
      enqueue.name,
      'body.taskId',
    )
    state.queueTaskIds.add(state.taskId)
    expectDeepEqual(
      enqueue.name,
      enqueue.body?.payload,
      {
        type: 'photo',
        storageKey: state.fileKey,
        contentHash,
        eraseLocation: false,
      },
      'body.payload',
    )

    const completedTask = await waitForTaskCompletion({
      api,
      taskId: state.taskId,
      timeoutMs: normalized.timeoutMs,
      pollMs: normalized.pollMs,
      sleep,
    })
    expectEqual(
      'go upload pipeline: completed task status',
      completedTask.status,
      'completed',
      'body.status',
    )
    expectEqual(
      'go upload pipeline: completed task owner',
      completedTask.ownerUserId,
      910001,
      'body.ownerUserId',
    )

    const photo = await readGeneratedPhoto(
      api,
      photoId,
      state.fileKey,
      state.fileKey,
    )
    expectEqual(
      'go upload pipeline: generated photo',
      photo.id,
      photoId,
      'photo.id',
    )
    expectEqual(
      'go upload pipeline: generated photo',
      photo.storageKey,
      state.fileKey,
      'photo.storageKey',
    )
    expectEqual(
      'go upload pipeline: generated photo',
      photo.contentHash,
      contentHash,
      'photo.contentHash',
    )
    expectEqual(
      'go upload pipeline: generated photo',
      photo.mediaType,
      'image',
      'photo.mediaType',
    )
    expectEqual(
      'go upload pipeline: generated photo',
      photo.ownerUserId,
      910001,
      'photo.ownerUserId',
    )
    requirePositiveInteger(
      photo.width,
      'go upload pipeline: generated photo',
      'photo.width',
    )
    requirePositiveInteger(
      photo.height,
      'go upload pipeline: generated photo',
      'photo.height',
    )
    requireNonEmptyString(
      photo.thumbnailKey,
      'go upload pipeline: generated photo',
      'photo.thumbnailKey',
    )
    requireNonEmptyString(
      photo.displayKey,
      'go upload pipeline: generated photo',
      'photo.displayKey',
    )
    requireNonEmptyString(
      photo.originalUrl,
      'go upload pipeline: generated photo',
      'photo.originalUrl',
    )
    requireNonEmptyString(
      photo.thumbnailUrl,
      'go upload pipeline: generated photo',
      'photo.thumbnailUrl',
    )

    await api.mediaRequest({
      name: 'go upload pipeline: read original through Go media route',
      path: imageRoutePath(state.fileKey),
      expectedBackend: 'go',
      expectedContentType: 'image/png',
      expectedVary: 'Cookie',
    })
    await api.mediaRequest({
      name: 'go upload pipeline: head original through Go media route',
      method: 'HEAD',
      path: imageRoutePath(state.fileKey),
      expectedBackend: 'go',
      expectedContentType: 'image/png',
      expectedByteLength: 0,
      expectedVary: 'Cookie',
    })
    await api.mediaRequest({
      name: 'go upload pipeline: read original suffix range through Go media route',
      path: imageRoutePath(state.fileKey),
      expectedBackend: 'go',
      expectedContentType: 'image/png',
      expectedStatus: 206,
      expectedByteLength: 4,
      expectedContentRangePattern: /^bytes \d+-\d+\/\d+$/,
      expectedVary: 'Cookie',
      headers: { Range: 'bytes=-4' },
    })
    await api.mediaRequest({
      name: 'go upload pipeline: stale if-range falls back to full original',
      path: imageRoutePath(state.fileKey),
      expectedBackend: 'go',
      expectedContentType: 'image/png',
      expectedContentRange: null,
      expectedVary: 'Cookie',
      headers: { Range: 'bytes=-4', 'If-Range': '"stale-validator"' },
    })
    await api.mediaRequest({
      name: 'go upload pipeline: read thumbnail through Go media route',
      path: imageRoutePath(photo.thumbnailKey),
      expectedBackend: 'go',
      expectedContentType: 'image/webp',
      expectedVary: 'Cookie',
    })
    await api.mediaRequest({
      name: 'go upload pipeline: read display through Go media route',
      path: imageRoutePath(photo.displayKey),
      expectedBackend: 'go',
      expectedContentType: 'image/webp',
      expectedVary: 'Cookie',
    })

    await verifyPublicUploadSharePipelines({
      api,
      state,
      prefix: normalized.prefix,
      timeoutMs: normalized.timeoutMs,
      pollMs: normalized.pollMs,
      sleep,
    })
    await verifyConcurrentPublicUploadShareQuota({
      api,
      state,
      prefix: normalized.prefix,
      timeoutMs: normalized.timeoutMs,
      pollMs: normalized.pollMs,
      sleep,
    })

    summary.ok = true
    return summary
  } catch (error) {
    summary.errors =
      error instanceof VerificationFailure
        ? error.errors
        : [
            {
              name: 'dual upload pipeline verifier',
              message: error instanceof Error ? error.message : String(error),
            },
          ]
    return summary
  } finally {
    await cleanupUploadPipelineState(api, state, summary)
    summarizeUploadPipelineChecks(summary)
  }
}

function createUploadPipelineAPI({
  base,
  cookie,
  timeoutMs,
  summary,
  fetchImpl,
}) {
  return {
    async request(expectation) {
      const requestId = `dual-upload-pipeline-${randomUUID()}`
      const headers = {
        Accept: 'application/json',
        'X-Request-Id': requestId,
      }
      if (expectation.cookie !== 'anonymous') {
        headers.Cookie = cookie
      }
      const options = {
        method: expectation.method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      }
      if (Object.hasOwn(expectation, 'body')) {
        headers['Content-Type'] = 'application/json'
        options.body = JSON.stringify(expectation.body)
      } else if (Object.hasOwn(expectation, 'rawBody')) {
        headers['Content-Type'] =
          expectation.contentType || 'application/octet-stream'
        options.body = expectation.rawBody
      }

      const response = await fetchImpl(joinURL(base, expectation.path), options)
      const text = await response.text()
      const body = parseJSONBody(text)
      const result = {
        name: expectation.name,
        method: expectation.method,
        path: expectation.path,
        expectedBackend: expectation.expectedBackend,
        status: response.status,
        backend: response.headers.get('x-chronoframe-backend'),
        contentType: normalizedContentType(
          response.headers.get('content-type'),
        ),
        requestId,
        responseRequestId: response.headers.get('x-request-id'),
        body,
      }
      summary.checks.push(result)

      const errors = validateHTTPResult(expectation, result)
      if (errors.length > 0) {
        throw new VerificationFailure(errors)
      }
      return result
    },

    async mediaRequest(expectation) {
      const requestId = `dual-upload-pipeline-${randomUUID()}`
      const method = expectation.method || 'GET'
      const response = await fetchImpl(joinURL(base, expectation.path), {
        method,
        headers: {
          Accept: '*/*',
          Cookie: cookie,
          'X-Request-Id': requestId,
          ...expectation.headers,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const body = Buffer.from(await response.arrayBuffer())
      const result = {
        name: expectation.name,
        method,
        path: expectation.path,
        expectedBackend: expectation.expectedBackend,
        status: response.status,
        backend: response.headers.get('x-chronoframe-backend'),
        contentType: normalizedContentType(
          response.headers.get('content-type'),
        ),
        contentRange: response.headers.get('content-range'),
        vary: response.headers.get('vary'),
        requestId,
        responseRequestId: response.headers.get('x-request-id'),
        byteLength: body.byteLength,
      }
      summary.checks.push(result)

      const errors = validateHTTPResult(
        {
          ...expectation,
          method,
          expectedStatus: expectation.expectedStatus || 200,
          expectJSON: false,
          expectedContentType: expectation.expectedContentType,
        },
        result,
      )
      if (
        expectation.expectedContentRangePattern &&
        !expectation.expectedContentRangePattern.test(
          String(result.contentRange || ''),
        )
      ) {
        errors.push({
          name: expectation.name,
          field: 'headers.content-range',
          expected: String(expectation.expectedContentRangePattern),
          actual: result.contentRange,
        })
      }
      if (
        Object.hasOwn(expectation, 'expectedContentRange') &&
        result.contentRange !== expectation.expectedContentRange
      ) {
        errors.push({
          name: expectation.name,
          field: 'headers.content-range',
          expected: expectation.expectedContentRange,
          actual: result.contentRange,
        })
      }
      if (
        Object.hasOwn(expectation, 'expectedVary') &&
        result.vary !== expectation.expectedVary
      ) {
        errors.push({
          name: expectation.name,
          field: 'headers.vary',
          expected: expectation.expectedVary,
          actual: result.vary,
        })
      }
      if (
        Number.isSafeInteger(expectation.expectedByteLength) &&
        result.byteLength !== expectation.expectedByteLength
      ) {
        errors.push({
          name: expectation.name,
          field: 'body.byteLength',
          expected: expectation.expectedByteLength,
          actual: result.byteLength,
        })
      }
      if (
        !Number.isSafeInteger(expectation.expectedByteLength) &&
        result.byteLength <= 0
      ) {
        errors.push({
          name: expectation.name,
          field: 'body.byteLength',
          expected: '> 0',
          actual: result.byteLength,
        })
      }
      if (errors.length > 0) {
        throw new VerificationFailure(errors)
      }
      return result
    },
  }
}

async function verifyPublicUploadSharePipelines({
  api,
  state,
  prefix,
  timeoutMs,
  pollMs,
  sleep,
}) {
  for (const provider of PROVIDERS) {
    const runId = randomUUID().slice(0, 8)
    const fileName = `${prefix}-public-${provider}-${runId}.png`
    const contentHash = createHash('sha256')
      .update(`${prefix}:public:${provider}:${runId}:`)
      .update(TEST_IMAGE_BUFFER)
      .digest('hex')

    await setProvider(api, provider)
    const share = await api.request({
      name: `public upload share pipeline: create share via ${provider}`,
      method: 'POST',
      path: '/api/upload-shares',
      expectedBackend: provider,
      body: {
        label: `${prefix} public upload ${provider}`,
        expiresInDays: 1,
        maxUploads: 1,
      },
    })
    const shareId = requirePositiveInteger(
      share.body?.id,
      share.name,
      'body.id',
    )
    state.publicUploadShareIds.add(shareId)
    const token = requireNonEmptyString(
      share.body?.token,
      share.name,
      'body.token',
    )
    expectEqual(share.name, share.body?.uploadCount, 0, 'body.uploadCount')

    const publicBase = `/api/upload-shares/public/${encodeURIComponent(token)}`
    const publicRead = await api.request({
      name: `public upload share pipeline: anonymous read via ${provider}`,
      method: 'GET',
      path: publicBase,
      expectedBackend: provider,
      cookie: 'anonymous',
    })
    expectExactKeys(
      publicRead.name,
      publicRead.body,
      [
        'expiresAt',
        'id',
        'label',
        'maxFileSizeMB',
        'maxUploads',
        'owner',
        'uploadCount',
      ],
      'body',
    )
    expectExactKeys(
      publicRead.name,
      publicRead.body?.owner,
      ['avatar', 'username'],
      'body.owner',
    )
    expectEqual(publicRead.name, publicRead.body?.id, shareId, 'body.id')
    expectEqual(
      publicRead.name,
      publicRead.body?.owner?.username,
      FIXTURE_ADMIN_NAME,
      'body.owner.username',
    )
    expectEqual(
      publicRead.name,
      publicRead.body?.uploadCount,
      0,
      'body.uploadCount',
    )
    expectEqual(
      publicRead.name,
      publicRead.body?.maxUploads,
      1,
      'body.maxUploads',
    )
    expectEqual(
      publicRead.name,
      publicRead.body?.maxFileSizeMB,
      256,
      'body.maxFileSizeMB',
    )
    const prepare = await api.request({
      name: `public upload share pipeline: anonymous prepare via ${provider}`,
      method: 'POST',
      path: `${publicBase}/prepare`,
      expectedBackend: provider,
      cookie: 'anonymous',
      body: {
        fileName,
        contentType: 'image/png',
        contentHash,
      },
    })
    expectExactKeys(
      prepare.name,
      prepare.body,
      ['signedUrl', 'fileKey', 'contentHash', 'expiresIn'],
      'body',
    )
    expectEqual(
      prepare.name,
      prepare.body?.contentHash,
      contentHash,
      'body.contentHash',
    )
    expectEqual(prepare.name, prepare.body?.expiresIn, 3600, 'body.expiresIn')
    const fileKey = requireNonEmptyString(
      prepare.body?.fileKey,
      prepare.name,
      'body.fileKey',
    )
    expectStringStartsWith(
      prepare.name,
      fileKey,
      `dual-fixture/users/${DUAL_BACKEND_COMPARE_FIXTURE.userId}/guest-uploads/${shareId}/`,
      'body.fileKey',
    )
    expectStringEndsWith(prepare.name, fileKey, '.png', 'body.fileKey')

    const upload = await api.request({
      name: `public upload share pipeline: anonymous object PUT via ${provider}`,
      method: 'PUT',
      path: relativeAPIPath(prepare.body.signedUrl),
      expectedBackend: provider,
      cookie: 'anonymous',
      rawBody: TEST_IMAGE_BUFFER,
      contentType: 'image/png',
    })
    expectExactKeys(upload.name, upload.body, ['ok', 'key'], 'body')
    expectEqual(upload.name, upload.body?.ok, true, 'body.ok')
    expectEqual(upload.name, upload.body?.key, fileKey, 'body.key')

    const enqueue = await api.request({
      name: `public upload share pipeline: anonymous task via ${provider}`,
      method: 'POST',
      path: `${publicBase}/task`,
      expectedBackend: provider,
      cookie: 'anonymous',
      body: {
        payload: {
          type: 'photo',
          storageKey: fileKey,
          contentHash,
          eraseLocation: false,
          extra: 'must-be-stripped',
        },
      },
    })
    expectExactKeys(
      enqueue.name,
      enqueue.body,
      ['message', 'payload', 'success', 'taskId'],
      'body',
    )
    expectEqual(enqueue.name, enqueue.body?.success, true, 'body.success')
    const taskId = requirePositiveInteger(
      enqueue.body?.taskId,
      enqueue.name,
      'body.taskId',
    )
    state.queueTaskIds.add(taskId)
    expectDeepEqual(
      enqueue.name,
      enqueue.body?.payload,
      {
        type: 'photo',
        storageKey: fileKey,
        contentHash,
        eraseLocation: false,
      },
      'body.payload',
    )

    await setProvider(api, 'go')
    const completedTask = await waitForTaskCompletion({
      api,
      taskId,
      timeoutMs,
      pollMs,
      sleep,
    })
    expectEqual(
      `public upload share pipeline: completed task via ${provider}`,
      completedTask.status,
      'completed',
      'body.status',
    )

    const generatedPhoto = await readGeneratedPhoto(
      api,
      generateSafePhotoId(fileKey.split('/').at(-1) || fileName),
      fileKey,
      fileKey,
    )
    state.publicPhotoIds.add(generatedPhoto.id)
    expectEqual(
      `public upload share pipeline: generated photo via ${provider}`,
      generatedPhoto.storageKey,
      fileKey,
      'photo.storageKey',
    )
    expectEqual(
      `public upload share pipeline: generated photo via ${provider}`,
      generatedPhoto.contentHash,
      contentHash,
      'photo.contentHash',
    )
    expectEqual(
      `public upload share pipeline: generated photo via ${provider}`,
      generatedPhoto.ownerUserId,
      DUAL_BACKEND_COMPARE_FIXTURE.userId,
      'photo.ownerUserId',
    )

    const shares = await api.request({
      name: `public upload share pipeline: read share usage after ${provider}`,
      method: 'GET',
      path: '/api/upload-shares',
      expectedBackend: 'go',
    })
    const updatedShare = findById(shares.body, shareId)
    expectEqual(shares.name, updatedShare?.uploadCount, 1, 'body[].uploadCount')
    requireNonEmptyString(
      updatedShare?.lastUsedAt,
      shares.name,
      'body[].lastUsedAt',
    )

    await setProvider(api, provider)
    const exhausted = await api.request({
      name: `public upload share pipeline: exhausted share rejects prepare via ${provider}`,
      method: 'POST',
      path: `${publicBase}/prepare`,
      expectedBackend: provider,
      expectedStatus: 429,
      cookie: 'anonymous',
      body: {
        fileName: `${prefix}-public-exhausted-${provider}-${runId}.png`,
        contentType: 'image/png',
        contentHash,
      },
    })
    expectEqual(
      exhausted.name,
      exhausted.body?.statusCode,
      429,
      'body.statusCode',
    )
    expectEqual(
      exhausted.name,
      exhausted.body?.statusMessage,
      'Upload link limit reached',
      'body.statusMessage',
    )
    expectEqual(
      exhausted.name,
      exhausted.body?.message,
      'Upload link limit reached',
      'body.message',
    )
  }
}

async function verifyConcurrentPublicUploadShareQuota({
  api,
  state,
  prefix,
  timeoutMs,
  pollMs,
  sleep,
}) {
  const runId = randomUUID().slice(0, 8)
  const fileName = `${prefix}-atomic-quota-${runId}.png`
  const contentHash = createHash('sha256')
    .update(`${prefix}:atomic-quota:${runId}:`)
    .update(TEST_IMAGE_BUFFER)
    .digest('hex')

  await setProvider(api, 'node')
  const share = await api.request({
    name: 'public upload share atomic quota: create one-use share',
    method: 'POST',
    path: '/api/upload-shares',
    expectedBackend: 'node',
    body: {
      label: `${prefix} atomic quota`,
      expiresInDays: 1,
      maxUploads: 1,
    },
  })
  const shareId = requirePositiveInteger(share.body?.id, share.name, 'body.id')
  state.publicUploadShareIds.add(shareId)
  const token = requireNonEmptyString(
    share.body?.token,
    share.name,
    'body.token',
  )
  const publicBase = `/api/upload-shares/public/${encodeURIComponent(token)}`

  const prepare = await api.request({
    name: 'public upload share atomic quota: prepare object',
    method: 'POST',
    path: `${publicBase}/prepare`,
    expectedBackend: 'node',
    cookie: 'anonymous',
    body: { fileName, contentType: 'image/png', contentHash },
  })
  const fileKey = requireNonEmptyString(
    prepare.body?.fileKey,
    prepare.name,
    'body.fileKey',
  )
  await api.request({
    name: 'public upload share atomic quota: upload object',
    method: 'PUT',
    path: relativeAPIPath(prepare.body.signedUrl),
    expectedBackend: 'node',
    cookie: 'anonymous',
    rawBody: TEST_IMAGE_BUFFER,
    contentType: 'image/png',
  })

  const body = {
    payload: {
      type: 'photo',
      storageKey: fileKey,
      contentHash,
      eraseLocation: false,
    },
  }
  const [nodeAttempt, goAttempt] = await Promise.all([
    api.request({
      name: 'public upload share atomic quota: concurrent Node task',
      method: 'POST',
      path: `${publicBase}/task`,
      expectedBackend: 'node',
      expectedStatuses: [200, 429],
      cookie: 'anonymous',
      body,
    }),
    api.request({
      name: 'public upload share atomic quota: concurrent Go task',
      method: 'POST',
      path: `/__lab/go${publicBase}/task`,
      expectedBackend: 'go',
      expectedStatuses: [200, 429],
      cookie: 'anonymous',
      body,
    }),
  ])
  expectDeepEqual(
    'public upload share atomic quota: exactly one reservation',
    [nodeAttempt.status, goAttempt.status].sort((left, right) => left - right),
    [200, 429],
    'statuses',
  )
  const winner = nodeAttempt.status === 200 ? nodeAttempt : goAttempt
  const rejected = nodeAttempt.status === 429 ? nodeAttempt : goAttempt
  const taskId = requirePositiveInteger(
    winner.body?.taskId,
    winner.name,
    'body.taskId',
  )
  state.queueTaskIds.add(taskId)
  expectEqual(
    rejected.name,
    rejected.body?.statusMessage,
    'Upload link limit reached',
    'body.statusMessage',
  )

  await setProvider(api, 'go')
  const completedTask = await waitForTaskCompletion({
    api,
    taskId,
    timeoutMs,
    pollMs,
    sleep,
  })
  expectEqual(
    'public upload share atomic quota: winning task completed',
    completedTask.status,
    'completed',
    'body.status',
  )
  const generatedPhoto = await readGeneratedPhoto(
    api,
    generateSafePhotoId(fileKey.split('/').at(-1) || fileName),
    fileKey,
    fileKey,
  )
  state.publicPhotoIds.add(generatedPhoto.id)

  const shares = await api.request({
    name: 'public upload share atomic quota: read committed usage',
    method: 'GET',
    path: '/api/upload-shares',
    expectedBackend: 'go',
  })
  const updatedShare = findById(shares.body, shareId)
  expectEqual(shares.name, updatedShare?.uploadCount, 1, 'body[].uploadCount')
}

export function validateHTTPResult(expectation, result) {
  const errors = []
  const expectedStatuses = expectation.expectedStatuses || [
    expectation.expectedStatus || 200,
  ]
  if (!expectedStatuses.includes(result.status)) {
    errors.push({
      name: expectation.name,
      field: 'status',
      expected:
        expectedStatuses.length === 1 ? expectedStatuses[0] : expectedStatuses,
      actual: result.status,
    })
  }
  if (
    expectation.expectedBackend &&
    result.backend !== expectation.expectedBackend
  ) {
    errors.push({
      name: expectation.name,
      field: 'headers.x-chronoframe-backend',
      expected: expectation.expectedBackend,
      actual: result.backend,
    })
  }
  if (
    expectation.expectJSON !== false &&
    result.contentType !== 'application/json'
  ) {
    errors.push({
      name: expectation.name,
      field: 'headers.content-type',
      expected: 'application/json',
      actual: result.contentType,
    })
  }
  if (
    expectation.expectedContentType &&
    result.contentType !== expectation.expectedContentType
  ) {
    errors.push({
      name: expectation.name,
      field: 'headers.content-type',
      expected: expectation.expectedContentType,
      actual: result.contentType,
    })
  }
  return errors
}

async function setProvider(api, provider) {
  const result = await api.request({
    name: `switch provider to ${provider}`,
    method: 'PUT',
    path: PROVIDER_SETTING_PATH,
    expectedBackend: 'node',
    body: { value: provider },
  })
  expectEqual(result.name, result.body?.value, provider, 'body.value')
}

async function verifyGoConsumerReady({ api, timeoutMs, pollMs, sleep }) {
  const startedAt = Date.now()
  let lastStats = null
  while (Date.now() - startedAt <= timeoutMs) {
    const stats = await api.request({
      name: 'go upload pipeline: verify Go consumer is active',
      method: 'GET',
      path: '/api/queue/stats',
      expectedBackend: 'go',
    })
    lastStats = stats

    const pool = stats.body?.pool
    const workers = Array.isArray(pool?.workers) ? pool.workers : []
    const hasGoWorker = workers.some((worker) =>
      String(worker?.workerId || '').startsWith('go-worker-'),
    )
    if (pool?.isActive === true && !hasGoWorker) {
      throw new VerificationFailure([
        {
          name: stats.name,
          field: 'body.pool.workers[].workerId',
          expected: 'at least one go-worker-* entry',
          actual: workers.map((worker) => worker?.workerId),
          message:
            'The Go HTTP backend is reachable, but the queue telemetry is not from the Go pipeline consumer; start the dual stack with deploy/dual/compose.go-pipeline-consumer.yaml.',
        },
      ])
    }
    const configuredWorkers = Number(
      pool?.workerCount ?? pool?.totalWorkers ?? 0,
    )
    if (pool?.isActive === true) {
      if (!Number.isFinite(configuredWorkers) || configuredWorkers <= 0) {
        throw new VerificationFailure([
          {
            name: stats.name,
            field: 'body.pool.workerCount',
            expected: 'positive Go worker count',
            actual: pool?.workerCount ?? pool?.totalWorkers,
          },
        ])
      }
      return
    }

    const hasConfiguredGoWorkers =
      Number.isFinite(configuredWorkers) && configuredWorkers > 0 && hasGoWorker
    if (!hasConfiguredGoWorkers) {
      throw new VerificationFailure([
        {
          name: stats.name,
          field: 'body.pool.isActive',
          expected: true,
          actual: pool?.isActive,
        },
      ])
    }
    await sleep(pollMs)
  }
  throw new VerificationFailure([
    {
      name: 'go upload pipeline: verify Go consumer is active',
      field: 'body.pool.isActive',
      expected: true,
      actual: lastStats?.body?.pool?.isActive,
      message: `Timed out after ${timeoutMs}ms waiting for Go pipeline consumer to become active`,
    },
  ])
}

async function waitForTaskCompletion({
  api,
  taskId,
  timeoutMs,
  pollMs,
  sleep,
}) {
  const startedAt = Date.now()
  let lastTask = null
  while (Date.now() - startedAt <= timeoutMs) {
    const result = await api.request({
      name: `go upload pipeline: poll task ${taskId}`,
      method: 'GET',
      path: `/api/queue/stats/${taskId}`,
      expectedBackend: 'go',
    })
    lastTask = result.body
    if (result.body?.status === 'completed') {
      return result.body
    }
    if (result.body?.status === 'failed') {
      throw new VerificationFailure([
        {
          name: result.name,
          field: 'body.status',
          expected: 'completed',
          actual: 'failed',
          message: result.body?.errorMessage || 'pipeline task failed',
        },
      ])
    }
    await sleep(pollMs)
  }
  throw new VerificationFailure([
    {
      name: `go upload pipeline: poll task ${taskId}`,
      field: 'body.status',
      expected: 'completed before timeout',
      actual: lastTask?.status,
      message: `Timed out after ${timeoutMs}ms waiting for Go pipeline task ${taskId}`,
    },
  ])
}

async function readGeneratedPhoto(api, photoId, fileKey, search = photoId) {
  const result = await api.request({
    name: 'go upload pipeline: read generated photo through Go',
    method: 'GET',
    path: `/api/photos?scope=manage&search=${encodeURIComponent(search)}&page=1&pageSize=10`,
    expectedBackend: 'go',
  })
  const candidates = Array.isArray(result.body?.items) ? result.body.items : []
  const photo =
    candidates.find((item) => item?.id === photoId) ||
    candidates.find((item) => item?.storageKey === fileKey)
  if (!photo) {
    throw new VerificationFailure([
      {
        name: result.name,
        field: 'body.items',
        expected: `photo ${photoId}`,
        actual: candidates.map((item) => item?.id),
      },
    ])
  }
  return photo
}

async function cleanupUploadPipelineState(api, state, summary) {
  try {
    await setProvider(api, 'go')
    summary.cleanup.push({
      name: 'switch provider to go for photo cleanup',
      ok: true,
    })
  } catch (error) {
    summary.cleanup.push({
      name: 'switch provider to go for photo cleanup',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  const photoIds = [
    state.photoId,
    ...Array.from(state.publicPhotoIds || []),
  ].filter(Boolean)
  for (const photoId of photoIds) {
    try {
      const result = await api.request({
        name: `cleanup: delete uploaded photo ${photoId}`,
        method: 'DELETE',
        path: `/api/photos/${encodeURIComponent(photoId)}`,
        expectedBackend: 'go',
        expectedStatuses: [200, 404],
      })
      summary.cleanup.push({
        name: `delete uploaded photo ${photoId}`,
        ok: result.status === 200 || result.status === 404,
      })
    } catch (error) {
      summary.cleanup.push({
        name: `delete uploaded photo ${photoId}`,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  try {
    await setProvider(api, 'node')
    summary.cleanup.push({ name: 'restore provider to node', ok: true })
  } catch (error) {
    summary.cleanup.push({
      name: 'restore provider to node',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  for (const shareId of Array.from(
    state.publicUploadShareIds || [],
  ).reverse()) {
    try {
      const result = await api.request({
        name: `cleanup: delete public upload share ${shareId}`,
        method: 'DELETE',
        path: `/api/upload-shares/${shareId}`,
        expectedBackend: 'node',
        expectedStatuses: [200, 404],
      })
      summary.cleanup.push({
        name: `delete public upload share ${shareId}`,
        ok: result.status === 200 || result.status === 404,
      })
    } catch (error) {
      summary.cleanup.push({
        name: `delete public upload share ${shareId}`,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  await cleanupRecordedQueueTasks(state, summary)
}

async function cleanupRecordedQueueTasks(state, summary) {
  const taskIds = Array.from(state.queueTaskIds || []).filter((value) =>
    Number.isSafeInteger(value),
  )
  if (taskIds.length === 0) return

  const databasePath = String(process.env.DATABASE_URL || '').trim()
  if (!databasePath || databasePath.includes('://')) {
    summary.cleanup.push({
      name: `delete ${taskIds.length} recorded pipeline tasks`,
      ok: true,
      skipped: true,
    })
    return
  }

  let database
  try {
    const { default: Database } = await import('better-sqlite3')
    database = new Database(databasePath)
    database.pragma('busy_timeout = 5000')
    const placeholders = taskIds.map(() => '?').join(', ')
    const result = database
      .prepare(`DELETE FROM pipeline_queue WHERE id IN (${placeholders})`)
      .run(...taskIds)
    const remaining = database
      .prepare(
        `SELECT COUNT(*) AS count FROM pipeline_queue WHERE id IN (${placeholders})`,
      )
      .get(...taskIds)
    if (Number(remaining?.count || 0) !== 0) {
      throw new Error('recorded pipeline tasks still exist after cleanup')
    }
    summary.cleanup.push({
      name: `delete ${taskIds.length} recorded pipeline tasks`,
      ok: true,
      deletedCount: result.changes,
    })
  } catch (error) {
    summary.cleanup.push({
      name: `delete ${taskIds.length} recorded pipeline tasks`,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
    summary.ok = false
  } finally {
    database?.close()
  }
}

function summarizeUploadPipelineChecks(summary) {
  summary.checkCount = summary.checks.length
  summary.publicChecks = summary.checks.filter((check) =>
    String(check.name || '').startsWith('public upload share pipeline:'),
  ).length
  summary.exhaustedShareChecks = summary.checks.filter((check) =>
    String(check.name || '').startsWith(
      'public upload share pipeline: exhausted share rejects prepare via ',
    ),
  ).length
  summary.atomicQuotaChecks = summary.checks.filter((check) =>
    String(check.name || '').startsWith('public upload share atomic quota:'),
  ).length
}

function imageRoutePath(key) {
  return `/image/${String(key)
    .replace(/^\/+/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
}

function relativeAPIPath(value) {
  const text = requireNonEmptyString(value, 'upload prepare', 'signedUrl')
  if (text.startsWith('/')) return text
  const url = new URL(text)
  return `${url.pathname}${url.search}`
}

function generateSafePhotoId(fileName) {
  const baseName = fileName.replace(/\.[^.]*$/, '')
  return sanitizeFileName(baseName, {
    maxLength: 32,
    fallbackPrefix: 'photo',
    minLength: 3,
  })
}

function sanitizeFileName(
  fileName,
  { maxLength = 50, fallbackPrefix = 'file', minLength = 3 } = {},
) {
  const cleanedName = String(fileName)
    .replace(/[^\w\-.]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')

  if (cleanedName.length < minLength) {
    const hash = createHash('md5').update(String(fileName)).digest('hex')
    return `${fallbackPrefix}_${hash.slice(0, 8)}`
  }
  if (cleanedName.length > maxLength) {
    const hash = createHash('md5').update(String(fileName)).digest('hex')
    return `${cleanedName.slice(0, maxLength - 9)}_${hash.slice(0, 8)}`
  }
  return cleanedName
}

function joinURL(base, path) {
  return new URL(path, `${base}/`).toString()
}

function normalizeBaseURL(value) {
  const url = new URL(String(value))
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('base must use http or https')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function normalizeCookie(value) {
  const cookie = String(value || '').trim()
  if (!cookie) throw new Error('cookie must be non-empty')
  return cookie
}

function normalizePrefix(value) {
  const prefix = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '-')
  if (!prefix) throw new Error('prefix must be non-empty')
  return prefix.slice(0, 32)
}

function parsePositiveInteger(value, name) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  throw new Error(`${name} must be a positive safe integer`)
}

function parseJSONBody(text) {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return text
  }
}

function normalizedContentType(value) {
  return String(value || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
}

function expectEqual(name, actual, expected, field) {
  if (actual !== expected) {
    throw new VerificationFailure([{ name, field, expected, actual }])
  }
}

function expectDeepEqual(name, actual, expected, field) {
  const actualJSON = JSON.stringify(canonicalizeForCompare(actual))
  const expectedJSON = JSON.stringify(canonicalizeForCompare(expected))
  if (actualJSON !== expectedJSON) {
    throw new VerificationFailure([{ name, field, expected, actual }])
  }
}

function expectStringStartsWith(name, actual, expected, field) {
  if (typeof actual !== 'string' || !actual.startsWith(expected)) {
    throw new VerificationFailure([{ name, field, expected, actual }])
  }
}

function expectStringEndsWith(name, actual, expected, field) {
  if (typeof actual !== 'string' || !actual.endsWith(expected)) {
    throw new VerificationFailure([{ name, field, expected, actual }])
  }
}

function canonicalizeForCompare(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeForCompare)
  }
  if (!value || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeForCompare(value[key])]),
  )
}

function findById(values, id) {
  return Array.isArray(values)
    ? values.find((value) => value?.id === id)
    : undefined
}

function expectExactKeys(name, value, keys, field) {
  const actual = Object.keys(value || {}).sort()
  const expected = [...keys].sort()
  expectDeepEqual(name, actual, expected, `${field}.keys`)
}

function requireNonEmptyString(value, name, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new VerificationFailure([
      { name, field, expected: 'non-empty string', actual: value },
    ])
  }
  return value
}

function requirePositiveInteger(value, name, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new VerificationFailure([
      { name, field, expected: 'positive safe integer', actual: value },
    ])
  }
  return value
}

class VerificationFailure extends Error {
  constructor(errors) {
    super(
      errors
        .map((error) => error.message || `${error.name}: ${error.field}`)
        .join('; '),
    )
    this.name = 'VerificationFailure'
    this.errors = errors
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyDualUploadPipeline(parseUploadPipelineVerifierOptions())
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2))
      if (!summary.ok) {
        process.exitCode = 1
      }
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}

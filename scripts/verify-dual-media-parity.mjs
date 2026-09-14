#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { FIXTURE_SESSION_TOKEN } from './seed-dual-backend-fixture.mjs'

export const DEFAULT_MEDIA_PARITY_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_MEDIA_PARITY_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`
export const DEFAULT_MEDIA_PARITY_PREFIX = 'dual-media'
export const DEFAULT_MEDIA_PARITY_TIMEOUT_MS = 60_000
export const DEFAULT_MEDIA_PARITY_POLL_MS = 500

const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'
const TEST_IMAGE_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

export function parseMediaParityVerifierOptions(
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

  return {
    base: normalizeBaseURL(
      values.get('--base') ||
        environment.CFRAME_DUAL_BASE_URL ||
        (environment.CFRAME_DUAL_PORT
          ? `http://127.0.0.1:${environment.CFRAME_DUAL_PORT}`
          : DEFAULT_MEDIA_PARITY_BASE_URL),
    ),
    cookie: normalizeCookie(
      values.get('--cookie') ||
        environment.CFRAME_DUAL_COOKIE ||
        DEFAULT_MEDIA_PARITY_COOKIE,
    ),
    timeoutMs: parsePositiveInteger(
      values.get('--timeout-ms') ||
        environment.CFRAME_DUAL_MEDIA_PARITY_TIMEOUT_MS ||
        environment.CFRAME_DUAL_TIMEOUT_MS ||
        DEFAULT_MEDIA_PARITY_TIMEOUT_MS,
      'timeout-ms',
    ),
    pollMs: parsePositiveInteger(
      values.get('--poll-ms') ||
        environment.CFRAME_DUAL_MEDIA_PARITY_POLL_MS ||
        DEFAULT_MEDIA_PARITY_POLL_MS,
      'poll-ms',
    ),
    prefix: normalizePrefix(
      values.get('--prefix') ||
        environment.CFRAME_DUAL_MEDIA_PARITY_PREFIX ||
        DEFAULT_MEDIA_PARITY_PREFIX,
    ),
  }
}

export async function verifyDualMediaParity({
  base = DEFAULT_MEDIA_PARITY_BASE_URL,
  cookie = DEFAULT_MEDIA_PARITY_COOKIE,
  timeoutMs = DEFAULT_MEDIA_PARITY_TIMEOUT_MS,
  pollMs = DEFAULT_MEDIA_PARITY_POLL_MS,
  prefix = DEFAULT_MEDIA_PARITY_PREFIX,
  setupProvider = 'go',
  cleanupProvider = 'go',
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function')
  }
  const normalized = {
    base: normalizeBaseURL(base),
    cookie: normalizeCookie(cookie),
    timeoutMs: parsePositiveInteger(timeoutMs, 'timeout-ms'),
    pollMs: parsePositiveInteger(pollMs, 'poll-ms'),
    prefix: normalizePrefix(prefix),
    setupProvider: normalizeProvider(setupProvider, 'setupProvider'),
    cleanupProvider: normalizeProvider(cleanupProvider, 'cleanupProvider'),
  }
  const runId = randomUUID().slice(0, 8)
  const fileName = `${normalized.prefix}-${runId}.png`
  const photoId = safePhotoId(fileName)
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
  const state = { photoId, fileKey: undefined, taskId: undefined }
  const api = createAPI({ ...normalized, summary, fetchImpl })

  try {
    await setProvider(api, 'go')
    await waitForGoConsumer(api, normalized.timeoutMs, normalized.pollMs, sleep)
    await setProvider(api, normalized.setupProvider)
    const prepare = await api.json({
      name: `media parity setup: prepare upload via ${normalized.setupProvider}`,
      method: 'POST',
      path: '/api/photos',
      expectedBackend: normalized.setupProvider,
      body: { fileName, contentType: 'image/png', contentHash },
    })
    state.fileKey = requireString(
      prepare.body?.fileKey,
      prepare.name,
      'body.fileKey',
    )
    const signedURL = requireString(
      prepare.body?.signedUrl,
      prepare.name,
      'body.signedUrl',
    )
    const externalUpload = isAbsoluteHTTPURL(signedURL)
    await api.json({
      name: `media parity setup: put original via ${normalized.setupProvider}`,
      method: 'PUT',
      path: signedURL,
      expectedBackend: externalUpload ? undefined : normalized.setupProvider,
      includeCookie: !externalUpload,
      rawBody: TEST_IMAGE_BUFFER,
      contentType: 'image/png',
    })
    const enqueue = await api.json({
      name: `media parity setup: enqueue via ${normalized.setupProvider}`,
      method: 'POST',
      path: '/api/queue/add-task',
      expectedBackend: normalized.setupProvider,
      body: {
        payload: {
          type: 'photo',
          storageKey: state.fileKey,
          contentHash,
          eraseLocation: false,
        },
        maxAttempts: 1,
      },
    })
    state.taskId = requirePositiveInteger(
      enqueue.body?.taskId,
      enqueue.name,
      'body.taskId',
    )
    await waitForTask(
      api,
      state.taskId,
      normalized.timeoutMs,
      normalized.pollMs,
      sleep,
      normalized.setupProvider,
    )
    const photo = await readPhoto(
      api,
      photoId,
      state.fileKey,
      normalized.setupProvider,
    )
    const mediaSamples = [
      {
        name: 'original full image media',
        path: imageRoutePath(state.fileKey),
        expectedContentType: 'image/png',
      },
      {
        name: 'original full storage media',
        path: storageRoutePath(state.fileKey),
        expectedContentType: 'image/png',
      },
      {
        name: 'original HEAD storage media',
        method: 'HEAD',
        path: storageRoutePath(state.fileKey),
        expectedContentType: 'image/png',
      },
      {
        name: 'original suffix Range storage media',
        path: storageRoutePath(state.fileKey),
        headers: { Range: 'bytes=-4' },
        expectedStatus: 206,
        expectedContentType: 'image/png',
      },
      {
        name: 'original HEAD image media',
        method: 'HEAD',
        path: imageRoutePath(state.fileKey),
        expectedContentType: 'image/png',
      },
      {
        name: 'original suffix Range image media',
        path: imageRoutePath(state.fileKey),
        headers: { Range: 'bytes=-4' },
        expectedStatus: 206,
        expectedContentType: 'image/png',
      },
      {
        name: 'original stale If-Range image media',
        path: imageRoutePath(state.fileKey),
        headers: { Range: 'bytes=-4', 'If-Range': '"stale-validator"' },
        expectedStatus: 200,
        expectedContentType: 'image/png',
        expectedContentRange: null,
      },
      {
        name: 'thumbnail image media',
        path: imageRoutePath(
          requireString(
            photo.thumbnailKey,
            'media parity setup',
            'photo.thumbnailKey',
          ),
        ),
        expectedContentType: 'image/webp',
      },
      {
        name: 'display image media',
        path: imageRoutePath(
          requireString(
            photo.displayKey,
            'media parity setup',
            'photo.displayKey',
          ),
        ),
        expectedContentType: 'image/webp',
      },
      {
        name: 'display route media',
        path: `/display/${encodeURIComponent(photoId)}`,
        expectedContentType: 'image/webp',
      },
      {
        name: 'thumbnail route media',
        path: thumbRoutePath(
          requireString(
            photo.thumbnailUrl,
            'media parity setup',
            'photo.thumbnailUrl',
          ),
        ),
        expectedContentType: 'image/jpeg',
      },
    ]
    for (const sample of mediaSamples) {
      await compareMediaSample(api, sample)
    }

    summary.ok = true
    return summary
  } catch (error) {
    summary.errors =
      error instanceof VerificationFailure
        ? error.errors
        : [
            {
              name: 'dual media parity verifier',
              message: error.message || String(error),
            },
          ]
    return summary
  } finally {
    await cleanup(api, state, summary, normalized.cleanupProvider)
    summary.checkCount = summary.checks.length
    summary.mediaComparisons = summary.checks.filter((check) =>
      String(check.name || '').startsWith('media parity compare:'),
    ).length
  }
}

function createAPI({ base, cookie, timeoutMs, summary, fetchImpl }) {
  async function request({
    name,
    method = 'GET',
    path,
    headers = {},
    body,
    rawBody,
    contentType,
    includeCookie = true,
  }) {
    const requestId = `dual-media-parity-${randomUUID()}`
    const requestHeaders = {
      'X-Request-Id': requestId,
      ...headers,
    }
    if (includeCookie) requestHeaders.Cookie = cookie
    const options = {
      method,
      headers: requestHeaders,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    }
    if (body !== undefined) {
      requestHeaders.Accept = 'application/json'
      requestHeaders['Content-Type'] = 'application/json'
      options.body = JSON.stringify(body)
    } else if (rawBody !== undefined) {
      requestHeaders['Content-Type'] = contentType || 'application/octet-stream'
      options.body = rawBody
    } else {
      requestHeaders.Accept = '*/*'
    }
    const response = await fetchImpl(resolveRequestURL(base, path), options)
    return { response, requestId, name, method, path }
  }
  return {
    async json(expectation) {
      const { response, requestId } = await request(expectation)
      const text = await response.text()
      const result = {
        name: expectation.name,
        method: expectation.method || 'GET',
        path: expectation.path,
        status: response.status,
        backend: response.headers.get('x-chronoframe-backend'),
        contentType: normalizedContentType(
          response.headers.get('content-type'),
        ),
        requestId,
        responseRequestId: response.headers.get('x-request-id'),
        body: parseJSON(text),
      }
      summary.checks.push(result)
      validate(result, expectation)
      return result
    },
    async media(expectation) {
      const { response, requestId } = await request(expectation)
      const body = Buffer.from(await response.arrayBuffer())
      const result = {
        name: expectation.name,
        method: expectation.method || 'GET',
        path: expectation.path,
        status: response.status,
        backend: response.headers.get('x-chronoframe-backend'),
        contentType: normalizedContentType(
          response.headers.get('content-type'),
        ),
        cacheControl: response.headers.get('cache-control'),
        contentLength: response.headers.get('content-length'),
        contentRange: response.headers.get('content-range'),
        acceptRanges: response.headers.get('accept-ranges'),
        etag: response.headers.get('etag'),
        vary: response.headers.get('vary'),
        requestId,
        responseRequestId: response.headers.get('x-request-id'),
        byteLength: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
      }
      summary.checks.push(result)
      validate(result, expectation)
      return result
    },
  }
}

async function compareMediaSample(api, sample) {
  const results = {}
  for (const provider of ['node', 'go']) {
    await setProvider(api, provider)
    results[provider] = await api.media({
      ...sample,
      name: `media parity compare: ${sample.name} via ${provider}`,
      expectedBackend: provider,
      expectedStatus: sample.expectedStatus || 200,
      expectedContentType: sample.expectedContentType,
    })
  }
  const fields = [
    'status',
    'contentType',
    'cacheControl',
    'contentRange',
    'acceptRanges',
    'vary',
    'byteLength',
    'sha256',
  ]
  const errors = []
  for (const field of fields) {
    if (results.node[field] !== results.go[field]) {
      errors.push({
        name: `media parity compare: ${sample.name}`,
        field,
        expected: results.node[field],
        actual: results.go[field],
      })
    }
  }
  if (
    Object.hasOwn(sample, 'expectedContentRange') &&
    results.go.contentRange !== sample.expectedContentRange
  ) {
    errors.push({
      name: `media parity compare: ${sample.name}`,
      field: 'headers.content-range',
      expected: sample.expectedContentRange,
      actual: results.go.contentRange,
    })
  }
  if (errors.length > 0) throw new VerificationFailure(errors)
}

async function setProvider(api, provider) {
  const result = await api.json({
    name: `switch provider to ${provider}`,
    method: 'PUT',
    path: PROVIDER_SETTING_PATH,
    expectedBackend: 'node',
    body: { value: provider },
  })
  if (result.body?.value !== provider) {
    throw new VerificationFailure([
      {
        name: result.name,
        field: 'body.value',
        expected: provider,
        actual: result.body?.value,
      },
    ])
  }
}

async function waitForGoConsumer(api, timeoutMs, pollMs, sleep) {
  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    const stats = await api.json({
      name: 'media parity setup: verify Go consumer is active',
      path: '/api/queue/stats',
      expectedBackend: 'go',
    })
    const pool = stats.body?.pool
    const workers = Array.isArray(pool?.workers) ? pool.workers : []
    const hasGoWorker = workers.some((worker) =>
      String(worker?.workerId || '').startsWith('go-worker-'),
    )
    if (pool?.isActive === true && hasGoWorker) return
    await sleep(pollMs)
  }
  throw new VerificationFailure([
    {
      name: 'media parity setup: verify Go consumer is active',
      field: 'body.pool.isActive',
      expected: true,
      actual: false,
    },
  ])
}

async function waitForTask(
  api,
  taskId,
  timeoutMs,
  pollMs,
  sleep,
  expectedBackend = 'go',
) {
  const startedAt = Date.now()
  let lastStatus
  while (Date.now() - startedAt <= timeoutMs) {
    const result = await api.json({
      name: `media parity setup: poll task ${taskId}`,
      path: `/api/queue/stats/${taskId}`,
      expectedBackend,
    })
    lastStatus = result.body?.status
    if (lastStatus === 'completed') return
    if (lastStatus === 'failed') {
      throw new VerificationFailure([
        {
          name: result.name,
          field: 'body.status',
          expected: 'completed',
          actual: 'failed',
          message: result.body?.errorMessage,
        },
      ])
    }
    await sleep(pollMs)
  }
  throw new VerificationFailure([
    {
      name: `media parity setup: poll task ${taskId}`,
      field: 'body.status',
      expected: 'completed',
      actual: lastStatus,
    },
  ])
}

async function readPhoto(api, photoId, fileKey, expectedBackend = 'go') {
  const result = await api.json({
    name: 'media parity setup: read generated photo',
    path: `/api/photos?scope=manage&search=${encodeURIComponent(fileKey)}&page=1&pageSize=10`,
    expectedBackend,
  })
  const items = Array.isArray(result.body?.items) ? result.body.items : []
  const photo = items.find(
    (item) => item?.id === photoId || item?.storageKey === fileKey,
  )
  if (!photo) {
    throw new VerificationFailure([
      {
        name: result.name,
        field: 'body.items',
        expected: photoId,
        actual: items.map((item) => item?.id),
      },
    ])
  }
  return photo
}

async function cleanup(api, state, summary, cleanupProvider = 'go') {
  try {
    await setProvider(api, cleanupProvider)
    if (state.photoId) {
      await api.json({
        name: `cleanup: delete media parity photo ${state.photoId}`,
        method: 'DELETE',
        path: `/api/photos/${encodeURIComponent(state.photoId)}`,
        expectedBackend: cleanupProvider,
        expectedStatuses: [200, 404],
      })
    }
    summary.cleanup.push({ name: 'delete media parity photo', ok: true })
  } catch (error) {
    summary.cleanup.push({
      name: 'delete media parity photo',
      ok: false,
      error: error.message || String(error),
    })
  }
  try {
    await setProvider(api, 'node')
    summary.cleanup.push({ name: 'restore provider to node', ok: true })
  } catch (error) {
    summary.cleanup.push({
      name: 'restore provider to node',
      ok: false,
      error: error.message || String(error),
    })
  }
}

function validate(result, expectation) {
  const expectedStatuses = expectation.expectedStatuses || [
    expectation.expectedStatus || 200,
  ]
  const errors = []
  if (!expectedStatuses.includes(result.status)) {
    errors.push({
      name: result.name,
      field: 'status',
      expected: expectedStatuses,
      actual: result.status,
    })
  }
  if (
    expectation.expectedBackend &&
    result.backend !== expectation.expectedBackend
  ) {
    errors.push({
      name: result.name,
      field: 'headers.x-chronoframe-backend',
      expected: expectation.expectedBackend,
      actual: result.backend,
    })
  }
  if (
    expectation.expectedContentType &&
    result.contentType !== expectation.expectedContentType
  ) {
    errors.push({
      name: result.name,
      field: 'headers.content-type',
      expected: expectation.expectedContentType,
      actual: result.contentType,
    })
  }
  if (errors.length > 0) throw new VerificationFailure(errors)
}

function imageRoutePath(key) {
  return `/image/${String(key).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`
}

function storageRoutePath(key) {
  return `/storage/${String(key).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`
}

function thumbRoutePath(value) {
  return `/thumb/${encodeURIComponent(String(value))}`
}

function safePhotoId(fileName) {
  const cleaned = fileName
    .replace(/\.[^.]*$/, '')
    .replace(/[^\w\-.]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
  if (cleaned.length >= 3 && cleaned.length <= 32) return cleaned
  const hash = createHash('md5').update(fileName).digest('hex')
  return `${cleaned.slice(0, 23) || 'photo'}_${hash.slice(0, 8)}`
}

function joinURL(base, path) {
  return new URL(path, `${base}/`).toString()
}

function isAbsoluteHTTPURL(value) {
  return /^https?:\/\//i.test(String(value))
}

function resolveRequestURL(base, path) {
  return isAbsoluteHTTPURL(path) ? String(path) : joinURL(base, path)
}

function normalizeBaseURL(value) {
  const url = new URL(String(value))
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('base must use http or https')
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

function normalizeProvider(value, name) {
  const provider = String(value || '')
    .trim()
    .toLowerCase()
  if (provider !== 'node' && provider !== 'go') {
    throw new Error(`${name} must be node or go`)
  }
  return provider
}

function parsePositiveInteger(value, name) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    return value
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  throw new Error(`${name} must be a positive safe integer`)
}

function parseJSON(text) {
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

function requireString(value, name, field) {
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
  verifyDualMediaParity(parseMediaParityVerifierOptions())
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2))
      if (!summary.ok) process.exitCode = 1
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}

#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'

import { FIXTURE_SESSION_TOKEN } from './seed-dual-backend-fixture.mjs'
import { verifyDualMediaParity } from './verify-dual-media-parity.mjs'

export const DEFAULT_S3_STORAGE_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_S3_STORAGE_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`
export const DEFAULT_S3_STORAGE_ENDPOINT = 'http://127.0.0.1:39000'
export const DEFAULT_S3_STORAGE_ACCESS_KEY = 'chronoframe-minio'
export const DEFAULT_S3_STORAGE_SECRET_KEY =
  'chronoframe-minio-development-secret'
export const DEFAULT_S3_STORAGE_REGION = 'us-east-1'
export const DEFAULT_S3_STORAGE_PREFIX = 'dual-s3'
export const DEFAULT_S3_STORAGE_TIMEOUT_MS = 60_000
export const DEFAULT_S3_STORAGE_POLL_MS = 500

const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'
const STORAGE_PROVIDER_SETTING_PATH = '/api/system/settings/storage/provider'
const STORAGE_CONFIG_PATH = '/api/system/settings/storage-config'

export function parseS3StorageVerifierOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const values = new Map()
  const allowed = new Set([
    '--base',
    '--cookie',
    '--timeout-ms',
    '--poll-ms',
    '--prefix',
    '--s3-endpoint',
    '--s3-access-key',
    '--s3-secret-key',
    '--s3-region',
  ])

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (!allowed.has(arg)) {
      throw new Error(
        arg.startsWith('--')
          ? `Unknown option: ${arg}`
          : `Unexpected positional argument: ${arg}`,
      )
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`)
    }
    values.set(arg, value)
    index += 1
  }

  return {
    base: normalizeHTTPURL(
      values.get('--base') ||
        environment.CFRAME_DUAL_BASE_URL ||
        (environment.CFRAME_DUAL_PORT
          ? `http://127.0.0.1:${environment.CFRAME_DUAL_PORT}`
          : DEFAULT_S3_STORAGE_BASE_URL),
      'base',
    ),
    cookie: normalizeRequiredString(
      values.get('--cookie') ||
        environment.CFRAME_DUAL_COOKIE ||
        DEFAULT_S3_STORAGE_COOKIE,
      'cookie',
    ),
    timeoutMs: parsePositiveInteger(
      values.get('--timeout-ms') ||
        environment.CFRAME_DUAL_S3_TIMEOUT_MS ||
        environment.CFRAME_DUAL_TIMEOUT_MS ||
        DEFAULT_S3_STORAGE_TIMEOUT_MS,
      'timeout-ms',
    ),
    pollMs: parsePositiveInteger(
      values.get('--poll-ms') ||
        environment.CFRAME_DUAL_S3_POLL_MS ||
        DEFAULT_S3_STORAGE_POLL_MS,
      'poll-ms',
    ),
    prefix: normalizePrefix(
      values.get('--prefix') ||
        environment.CFRAME_DUAL_S3_PREFIX ||
        DEFAULT_S3_STORAGE_PREFIX,
    ),
    endpoint: normalizeHTTPURL(
      values.get('--s3-endpoint') ||
        environment.CFRAME_DUAL_S3_ENDPOINT ||
        DEFAULT_S3_STORAGE_ENDPOINT,
      's3-endpoint',
    ),
    accessKeyId: normalizeRequiredString(
      values.get('--s3-access-key') ||
        environment.CFRAME_DUAL_S3_ACCESS_KEY ||
        DEFAULT_S3_STORAGE_ACCESS_KEY,
      's3-access-key',
    ),
    secretAccessKey: normalizeRequiredString(
      values.get('--s3-secret-key') ||
        environment.CFRAME_DUAL_S3_SECRET_KEY ||
        DEFAULT_S3_STORAGE_SECRET_KEY,
      's3-secret-key',
    ),
    region: normalizeRequiredString(
      values.get('--s3-region') ||
        environment.CFRAME_DUAL_S3_REGION ||
        DEFAULT_S3_STORAGE_REGION,
      's3-region',
    ),
  }
}

export async function verifyDualS3Storage({
  base = DEFAULT_S3_STORAGE_BASE_URL,
  cookie = DEFAULT_S3_STORAGE_COOKIE,
  timeoutMs = DEFAULT_S3_STORAGE_TIMEOUT_MS,
  pollMs = DEFAULT_S3_STORAGE_POLL_MS,
  prefix = DEFAULT_S3_STORAGE_PREFIX,
  endpoint = DEFAULT_S3_STORAGE_ENDPOINT,
  accessKeyId = DEFAULT_S3_STORAGE_ACCESS_KEY,
  secretAccessKey = DEFAULT_S3_STORAGE_SECRET_KEY,
  region = DEFAULT_S3_STORAGE_REGION,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  s3Client,
  mediaVerifier = verifyDualMediaParity,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function')
  }
  if (typeof sleep !== 'function') {
    throw new Error('sleep must be a function')
  }
  if (typeof mediaVerifier !== 'function') {
    throw new Error('mediaVerifier must be a function')
  }

  const normalized = {
    base: normalizeHTTPURL(base, 'base'),
    cookie: normalizeRequiredString(cookie, 'cookie'),
    timeoutMs: parsePositiveInteger(timeoutMs, 'timeout-ms'),
    pollMs: parsePositiveInteger(pollMs, 'poll-ms'),
    prefix: normalizePrefix(prefix),
    endpoint: normalizeHTTPURL(endpoint, 's3-endpoint'),
    accessKeyId: normalizeRequiredString(accessKeyId, 's3-access-key'),
    secretAccessKey: normalizeRequiredString(secretAccessKey, 's3-secret-key'),
    region: normalizeRequiredString(region, 's3-region'),
  }
  if (normalized.timeoutMs > 120_000) {
    throw new Error('timeout-ms must be 120000 or less')
  }
  if (normalized.pollMs > 5_000) {
    throw new Error('poll-ms must be 5000 or less')
  }

  const runId = randomUUID().slice(0, 8)
  const bucket = buildBucketName(normalized.prefix, runId)
  const objectPrefix = `${normalized.prefix}/${runId}`
  const client =
    s3Client ||
    new S3Client({
      endpoint: normalized.endpoint,
      region: normalized.region,
      forcePathStyle: true,
      responseChecksumValidation: 'WHEN_REQUIRED',
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: normalized.accessKeyId,
        secretAccessKey: normalized.secretAccessKey,
      },
    })
  const summary = {
    ok: false,
    base: normalized.base,
    endpoint: normalized.endpoint,
    bucket,
    objectPrefix,
    checks: [],
    runs: [],
    cleanup: [],
  }
  const state = {
    bucketCreated: false,
    storageConfigId: undefined,
    originalStorageProvider: undefined,
  }
  const api = createAPI({ ...normalized, summary, fetchImpl })

  try {
    await waitForS3(client, normalized.timeoutMs, normalized.pollMs, sleep)
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
    state.bucketCreated = true
    summary.checks.push({ name: 'create isolated MinIO bucket', ok: true })

    await setBackendProvider(api, 'node')
    state.originalStorageProvider = (
      await api.request({
        name: 'capture original active storage provider',
        path: STORAGE_PROVIDER_SETTING_PATH,
        expectedBackend: 'node',
      })
    ).body?.value

    await setBackendProvider(api, 'go')
    const create = await api.request({
      name: 'create shared MinIO S3 storage configuration via Go',
      method: 'POST',
      path: STORAGE_CONFIG_PATH,
      expectedBackend: 'go',
      body: {
        name: `${normalized.prefix} MinIO ${runId}`,
        provider: 's3',
        config: {
          provider: 's3',
          bucket,
          region: normalized.region,
          endpoint: normalized.endpoint,
          prefix: objectPrefix,
          accessKeyId: normalized.accessKeyId,
          secretAccessKey: normalized.secretAccessKey,
          forcePathStyle: true,
        },
      },
    })
    state.storageConfigId = requirePositiveInteger(
      create.body?.id,
      create.name,
      'body.id',
    )

    await api.request({
      name: 'activate shared MinIO S3 storage configuration via Go',
      method: 'PUT',
      path: STORAGE_PROVIDER_SETTING_PATH,
      expectedBackend: 'go',
      expectedValue: state.storageConfigId,
      body: { value: state.storageConfigId },
    })

    for (const provider of ['node', 'go']) {
      const run = await mediaVerifier({
        base: normalized.base,
        cookie: normalized.cookie,
        timeoutMs: normalized.timeoutMs,
        pollMs: normalized.pollMs,
        prefix: `${normalized.prefix}-${provider}`,
        setupProvider: provider,
        cleanupProvider: provider,
        fetchImpl,
        sleep,
      })
      summary.runs.push({ provider, ...run })
      if (!run.ok) {
        throw new Error(
          `${provider} S3 media parity run failed: ${formatNestedErrors(run.errors)}`,
        )
      }
      const failedCleanup = (run.cleanup || []).filter(
        (cleanup) => cleanup.ok !== true,
      )
      if (failedCleanup.length > 0) {
        throw new Error(
          `${provider} S3 media cleanup failed: ${formatNestedErrors(failedCleanup)}`,
        )
      }
      await assertBucketEmpty(client, bucket, `${provider} API cleanup`)
      summary.checks.push({
        name: `${provider} S3 prepare/read/delete round trip`,
        ok: true,
        mediaComparisons: run.mediaComparisons,
        checkCount: run.checkCount,
      })
    }

    summary.ok = true
    return summary
  } catch (error) {
    summary.errors = [
      {
        name: 'dual S3 storage verifier',
        message: error instanceof Error ? error.message : String(error),
      },
    ]
    return summary
  } finally {
    await cleanup({ api, client, bucket, state, summary })
    if (summary.cleanup.some((item) => item.ok !== true)) {
      summary.ok = false
    }
    summary.checkCount = summary.checks.length
    summary.runCount = summary.runs.length
  }
}

function createAPI({ base, cookie, timeoutMs, summary, fetchImpl }) {
  return {
    async request(expectation) {
      const requestId = `dual-s3-${randomUUID()}`
      const headers = {
        Accept: 'application/json',
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
      }
      const response = await fetchImpl(
        new URL(expectation.path, `${base}/`).toString(),
        {
          method: expectation.method || 'GET',
          headers,
          body:
            expectation.body === undefined
              ? undefined
              : JSON.stringify(expectation.body),
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        },
      )
      const text = await response.text()
      const result = {
        name: expectation.name,
        method: expectation.method || 'GET',
        path: expectation.path,
        status: response.status,
        backend: response.headers.get('x-chronoframe-backend'),
        responseRequestId: response.headers.get('x-request-id'),
        body: parseJSON(text),
      }
      summary.checks.push(result)
      const expectedStatuses = expectation.expectedStatuses || [200]
      if (!expectedStatuses.includes(result.status)) {
        throw new Error(
          `${result.name}: expected status ${expectedStatuses.join(' or ')}, got ${result.status}: ${text}`,
        )
      }
      if (
        expectation.expectedBackend &&
        result.backend !== expectation.expectedBackend
      ) {
        throw new Error(
          `${result.name}: expected backend ${expectation.expectedBackend}, got ${String(result.backend)}`,
        )
      }
      if (
        Object.hasOwn(expectation, 'expectedValue') &&
        result.body?.value !== expectation.expectedValue
      ) {
        throw new Error(
          `${result.name}: expected body.value ${String(expectation.expectedValue)}, got ${String(result.body?.value)}`,
        )
      }
      return result
    },
  }
}

async function setBackendProvider(api, provider) {
  await api.request({
    name: `switch backend provider to ${provider}`,
    method: 'PUT',
    path: PROVIDER_SETTING_PATH,
    expectedBackend: 'node',
    expectedValue: provider,
    body: { value: provider },
  })
}

async function waitForS3(client, timeoutMs, pollMs, sleep) {
  const startedAt = Date.now()
  let lastError
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      await client.send(new ListBucketsCommand({}))
      return
    } catch (error) {
      lastError = error
      await sleep(pollMs)
    }
  }
  throw new Error(
    `S3 endpoint did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

async function assertBucketEmpty(client, bucket, context) {
  const listed = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 10 }),
  )
  const keys = (listed.Contents || [])
    .map((object) => object.Key)
    .filter(Boolean)
  if (keys.length > 0) {
    throw new Error(
      `${context}: expected MinIO bucket cleanup, found ${keys.join(', ')}`,
    )
  }
}

async function cleanup({ api, client, bucket, state, summary }) {
  const attempt = async (name, operation) => {
    try {
      await operation()
      summary.cleanup.push({ name, ok: true })
    } catch (error) {
      summary.cleanup.push({
        name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  await attempt('restore backend provider to node', () =>
    setBackendProvider(api, 'node'),
  )
  if (state.originalStorageProvider !== undefined) {
    await attempt('restore original active storage provider', () =>
      api.request({
        name: 'cleanup: restore original active storage provider',
        method: 'PUT',
        path: STORAGE_PROVIDER_SETTING_PATH,
        expectedBackend: 'node',
        expectedValue: state.originalStorageProvider,
        body: { value: state.originalStorageProvider },
      }),
    )
  }
  if (state.storageConfigId !== undefined) {
    await attempt('delete temporary MinIO storage configuration', () =>
      api.request({
        name: 'cleanup: delete temporary MinIO storage configuration',
        method: 'DELETE',
        path: `${STORAGE_CONFIG_PATH}/${state.storageConfigId}`,
        expectedBackend: 'node',
        expectedStatuses: [200, 404],
      }),
    )
  }
  if (state.bucketCreated) {
    await attempt('delete remaining temporary MinIO objects', () =>
      deleteAllObjects(client, bucket),
    )
    await attempt('delete temporary MinIO bucket', () =>
      client.send(new DeleteBucketCommand({ Bucket: bucket })),
    )
  }
}

async function deleteAllObjects(client, bucket) {
  let continuationToken
  do {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      }),
    )
    const objects = (listed.Contents || [])
      .map((object) => object.Key)
      .filter(Boolean)
      .map((Key) => ({ Key }))
    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects, Quiet: true },
        }),
      )
    }
    continuationToken = listed.IsTruncated
      ? listed.NextContinuationToken
      : undefined
  } while (continuationToken)
}

function buildBucketName(prefix, runId) {
  const normalized = `${prefix}-${runId}`
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 60)
  return `cf-${normalized}`.slice(0, 63)
}

function formatNestedErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return 'unknown error'
  return errors
    .map((error) => error.message || error.error || JSON.stringify(error))
    .join('; ')
}

function normalizeHTTPURL(value, name) {
  const url = new URL(String(value))
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`)
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function normalizeRequiredString(value, name) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`${name} must be non-empty`)
  return normalized
}

function normalizePrefix(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 32)
  if (!normalized) throw new Error('prefix must be non-empty')
  return normalized
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

function requirePositiveInteger(value, name, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${name}: expected ${field} to be a positive safe integer, got ${String(value)}`,
    )
  }
  return value
}

function parseJSON(text) {
  const normalized = String(text || '').trim()
  if (!normalized) return null
  try {
    return JSON.parse(normalized)
  } catch {
    return normalized
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyDualS3Storage(parseS3StorageVerifierOptions())
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2))
      if (!summary.ok) process.exitCode = 1
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}

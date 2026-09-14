import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_S3_STORAGE_COOKIE,
  parseS3StorageVerifierOptions,
  verifyDualS3Storage,
} from '../scripts/verify-dual-s3-storage.mjs'

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
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url)
    const body = options.body ? JSON.parse(options.body) : undefined
    const request = {
      method: options.method,
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
    return jsonResponse({ statusMessage: 'not found' }, state.backend, 404)
  }
  return { fetchImpl, state }
}

function createS3Client() {
  const state = { commands: [] }
  return {
    state,
    async send(command) {
      const name = command.constructor.name
      state.commands.push(name)
      switch (name) {
        case 'ListBucketsCommand':
        case 'CreateBucketCommand':
        case 'DeleteBucketCommand':
        case 'DeleteObjectsCommand':
          return {}
        case 'ListObjectsV2Command':
          return { Contents: [], IsTruncated: false }
        default:
          throw new Error(`Unexpected S3 command ${name}`)
      }
    },
  }
}

test('dual S3 verifier provisions shared storage and runs Node and Go media matrices', async () => {
  const gateway = createGateway()
  const s3Client = createS3Client()
  const mediaRuns = []
  const summary = await verifyDualS3Storage({
    base: 'http://dual.test',
    cookie: DEFAULT_S3_STORAGE_COOKIE,
    endpoint: 'http://minio.test:9000',
    timeoutMs: 5_000,
    pollMs: 1,
    prefix: 's3-test',
    fetchImpl: gateway.fetchImpl,
    sleep: async () => {},
    s3Client,
    mediaVerifier: async (options) => {
      mediaRuns.push(options)
      return {
        ok: true,
        cleanup: [{ name: 'delete media parity photo', ok: true }],
        mediaComparisons: 22,
        checkCount: 33,
      }
    },
  })

  assert.equal(summary.ok, true)
  assert.equal(summary.runCount, 2)
  assert.deepEqual(
    mediaRuns.map((run) => [run.setupProvider, run.cleanupProvider]),
    [
      ['node', 'node'],
      ['go', 'go'],
    ],
  )
  assert.equal(
    mediaRuns.every((run) => run.base === 'http://dual.test'),
    true,
  )
  assert.ok(
    gateway.state.requests.some(
      (request) =>
        request.method === 'POST' &&
        request.path === '/api/system/settings/storage-config' &&
        request.backend === 'go' &&
        request.body.provider === 's3' &&
        request.body.config.endpoint === 'http://minio.test:9000',
    ),
  )
  assert.equal(gateway.state.backend, 'node')
  assert.equal(gateway.state.activeStorageProvider, 17)
  assert.deepEqual(s3Client.state.commands, [
    'ListBucketsCommand',
    'CreateBucketCommand',
    'ListObjectsV2Command',
    'ListObjectsV2Command',
    'ListObjectsV2Command',
    'DeleteBucketCommand',
  ])
})

test('dual S3 verifier option parser accepts container environment', () => {
  assert.deepEqual(
    parseS3StorageVerifierOptions([], {
      CFRAME_DUAL_PORT: '33120',
      CFRAME_DUAL_COOKIE: 'cf_session=test',
      CFRAME_DUAL_S3_TIMEOUT_MS: '9000',
      CFRAME_DUAL_S3_POLL_MS: '25',
      CFRAME_DUAL_S3_PREFIX: 'S3 env',
      CFRAME_DUAL_S3_ENDPOINT: 'http://minio:9000/',
      CFRAME_DUAL_S3_ACCESS_KEY: 'access',
      CFRAME_DUAL_S3_SECRET_KEY: 'secret',
      CFRAME_DUAL_S3_REGION: 'auto',
    }),
    {
      base: 'http://127.0.0.1:33120',
      cookie: 'cf_session=test',
      timeoutMs: 9000,
      pollMs: 25,
      prefix: 'S3-env',
      endpoint: 'http://minio:9000',
      accessKeyId: 'access',
      secretAccessKey: 'secret',
      region: 'auto',
    },
  )
})

test('dual S3 verifier rejects unsafe endpoint protocols', () => {
  assert.throws(
    () => parseS3StorageVerifierOptions(['--s3-endpoint', 'file:///tmp/minio']),
    /s3-endpoint must use http or https/,
  )
})

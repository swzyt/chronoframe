import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  GO_READY_PATH,
  parseGoReadinessVerifierOptions,
  validateReadyProbe,
  verifyGoReadiness,
} from '../scripts/verify-go-readiness.mjs'

function readyResponse({
  backend = 'go',
  body = readyBody(),
  status = 200,
} = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-chronoframe-backend': backend,
    },
  })
}

function readyBody(overrides = {}) {
  return {
    status: 'ready',
    checks: {
      database: 'ok',
      redis: 'ok',
      mediaTools: 'ok',
    },
    schema: {
      migrationCount: 24,
      latestMigrationMillis: 1788940800123,
    },
    ...overrides,
  }
}

test('go readiness verifier options accept gateway and direct Go bases', () => {
  const options = parseGoReadinessVerifierOptions(
    [
      '--base',
      'http://gateway/',
      '--go-base',
      'http://go:8080/',
      '--timeout-ms',
      '10',
    ],
    {},
  )

  assert.equal(options.base, 'http://gateway')
  assert.equal(options.goBase, 'http://go:8080')
  assert.equal(options.timeoutMs, 10)
})

test('go readiness verifier probes gateway runtime route and direct Go service', async () => {
  const requests = []
  const result = await verifyGoReadiness({
    base: 'http://gateway',
    goBase: 'http://go:8080',
    timeoutMs: 50,
    fetchImpl: async (url) => {
      requests.push(new URL(String(url)).href)
      return readyResponse()
    },
  })

  assert.equal(result.ok, true)
  assert.deepEqual(requests, [
    `http://gateway${GO_READY_PATH}`,
    `http://go:8080${GO_READY_PATH}`,
  ])
  assert.equal(result.checks.length, 2)
})

test('go readiness verifier reports missing media tool readiness', async () => {
  const result = await verifyGoReadiness({
    base: 'http://gateway',
    goBase: 'http://go:8080',
    timeoutMs: 50,
    fetchImpl: async () =>
      readyResponse({
        status: 503,
        body: readyBody({
          status: 'not_ready',
          checks: { database: 'ok', redis: 'ok', mediaTools: 'failed' },
          mediaTools: { ffmpeg: 'missing: /usr/bin/ffmpeg' },
        }),
      }),
  })

  assert.equal(result.ok, false)
  assert.ok(
    result.errors.some(
      (error) =>
        error.field === 'body.checks.mediaTools' &&
        error.expected === 'ok' &&
        error.actual === 'failed',
    ),
  )
})

test('ready probe validation rejects backend drift and schema drift', () => {
  const errors = validateReadyProbe({
    name: 'sample',
    status: 200,
    backend: 'node',
    contentType: 'application/json',
    body: readyBody({
      schema: { migrationCount: '24', latestMigrationMillis: null },
    }),
  })

  assert.ok(
    errors.some((error) => error.field === 'headers.x-chronoframe-backend'),
  )
  assert.ok(
    errors.some((error) => error.field === 'body.schema.migrationCount'),
  )
  assert.ok(
    errors.some((error) => error.field === 'body.schema.latestMigrationMillis'),
  )
})

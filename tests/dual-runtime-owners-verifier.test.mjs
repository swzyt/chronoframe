import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_DUAL_RUNTIME_OWNER_COOKIE,
  PROVIDER_SETTING_PATH,
  QUEUE_STATS_PATH,
  parseDualRuntimeOwnerVerifierOptions,
  validateRuntimeOwnerProbe,
  verifyDualRuntimeOwners,
} from '../scripts/verify-dual-runtime-owners.mjs'

function jsonResponse(body, backend, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-chronoframe-backend': backend,
    },
  })
}

function queueStatsResponse({ backend, workerId, isActive = true }) {
  return jsonResponse(
    {
      timestamp: new Date(0).toISOString(),
      pool: {
        isActive,
        workerCount: workerId ? 1 : 0,
        totalWorkers: workerId ? 1 : 0,
        activeWorkers: 0,
        totalProcessed: 0,
        totalErrors: 0,
        averageSuccessRate: 0,
        workers: workerId
          ? [
              {
                workerId,
                isProcessing: false,
                processedCount: 0,
                errorCount: 0,
                uptime: 0,
                successRate: 0,
              },
            ]
          : [],
      },
      queue: {},
    },
    backend,
  )
}

function createRuntimeOwnerGateway({
  owner = 'node',
  inactivePolls = 0,
  backendDrift = false,
} = {}) {
  let provider = 'node'
  let statsPolls = 0
  const requests = []
  return {
    requests,
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(String(url))
      requests.push({
        method: options.method || 'GET',
        pathname: parsed.pathname,
        cookie: options.headers?.Cookie || null,
        body: options.body ? JSON.parse(options.body) : null,
      })

      if (
        options.method === 'PUT' &&
        parsed.pathname === PROVIDER_SETTING_PATH
      ) {
        provider = JSON.parse(options.body).value
        return jsonResponse(
          { namespace: 'system', key: 'backend.readProvider', value: provider },
          'node',
        )
      }

      if (parsed.pathname === QUEUE_STATS_PATH) {
        statsPolls += 1
        const active = statsPolls > inactivePolls
        const workerId = owner === 'go' ? 'go-worker-1' : 'worker-1'
        return queueStatsResponse({
          backend: backendDrift ? 'node' : provider,
          workerId,
          isActive: active,
        })
      }

      return jsonResponse({ message: 'not found' }, provider, 404)
    },
    getProvider: () => provider,
  }
}

test('runtime owner verifier options default to fixture session and Node owner', () => {
  const options = parseDualRuntimeOwnerVerifierOptions([], {
    CFRAME_DUAL_PORT: '33107',
  })

  assert.equal(options.base, 'http://127.0.0.1:33107')
  assert.equal(options.cookie, DEFAULT_DUAL_RUNTIME_OWNER_COOKIE)
  assert.equal(options.expectedOwner, 'node')
  assert.equal(options.provider, 'node')
  assert.equal(options.timeoutMs, 15_000)
})

test('runtime owner verifier accepts Go owner override', () => {
  const options = parseDualRuntimeOwnerVerifierOptions(
    ['--expected-owner', 'go', '--timeout-ms', '10', '--poll-ms', '2'],
    {},
  )

  assert.equal(options.expectedOwner, 'go')
  assert.equal(options.provider, 'go')
  assert.equal(options.timeoutMs, 10)
  assert.equal(options.pollMs, 2)
})

test('runtime owner verifier proves Node pipeline consumer ownership and restores provider', async () => {
  const gateway = createRuntimeOwnerGateway({ owner: 'node' })

  const result = await verifyDualRuntimeOwners({
    base: 'http://gateway.test',
    cookie: 'cf_session=test-token',
    expectedOwner: 'node',
    provider: 'node',
    timeoutMs: 50,
    pollMs: 1,
    sleep: async () => {},
    fetchImpl: gateway.fetchImpl,
  })

  assert.equal(result.ok, true)
  assert.equal(gateway.getProvider(), 'node')
  assert.deepEqual(
    gateway.requests.map((request) => [
      request.method,
      request.pathname,
      request.cookie,
    ]),
    [
      ['PUT', PROVIDER_SETTING_PATH, 'cf_session=test-token'],
      ['GET', QUEUE_STATS_PATH, 'cf_session=test-token'],
      ['PUT', PROVIDER_SETTING_PATH, 'cf_session=test-token'],
    ],
  )
})

test('runtime owner verifier waits for Go pipeline consumer ownership', async () => {
  const gateway = createRuntimeOwnerGateway({ owner: 'go', inactivePolls: 1 })

  const result = await verifyDualRuntimeOwners({
    base: 'http://gateway.test',
    cookie: 'cf_session=test-token',
    expectedOwner: 'go',
    provider: 'go',
    timeoutMs: 50,
    pollMs: 1,
    sleep: async () => {},
    fetchImpl: gateway.fetchImpl,
  })

  assert.equal(result.ok, true)
  assert.equal(gateway.getProvider(), 'node')
  assert.equal(
    result.checks.filter((check) => check.path === QUEUE_STATS_PATH).length,
    2,
  )
})

test('runtime owner verifier reports unexpected worker owner and backend drift', async () => {
  const gateway = createRuntimeOwnerGateway({
    owner: 'node',
    backendDrift: true,
  })

  const result = await verifyDualRuntimeOwners({
    base: 'http://gateway.test',
    cookie: 'cf_session=test-token',
    expectedOwner: 'go',
    provider: 'go',
    timeoutMs: 1,
    pollMs: 1,
    sleep: async () => {},
    fetchImpl: gateway.fetchImpl,
  })

  assert.equal(result.ok, false)
  assert.deepEqual(
    result.errors.map((error) => error.field),
    [
      'headers.x-chronoframe-backend',
      'body.pool.workers[].workerId',
      'body.pool.workers[].workerId',
    ],
  )
})

test('runtime owner validation rejects inactive pools and empty workers', () => {
  assert.deepEqual(
    validateRuntimeOwnerProbe(
      {
        name: 'probe',
        expectedBackend: 'go',
        status: 200,
        backend: 'go',
        body: {
          pool: {
            isActive: false,
            workerCount: 0,
            workers: [],
          },
        },
      },
      'go',
    ).map((error) => error.field),
    [
      'body.pool.isActive',
      'body.pool.workers[].workerId',
      'body.pool.workerCount',
    ],
  )
})

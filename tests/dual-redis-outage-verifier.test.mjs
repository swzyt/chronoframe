import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseRedisOutageVerifierOptions,
  verifyDualRedisOutage,
} from '../scripts/verify-dual-redis-outage.mjs'

const ADMIN_PROFILE = {
  id: 910001,
  username: 'dual-backend-fixture-admin',
  email: 'dual-backend-fixture-admin@chronoframe.local',
  avatar: null,
  createdAt: '2027-01-01T00:00:00.000Z',
  isAdmin: 1,
  isActive: true,
  authVersion: 1,
}

function createHarness({ driftPublicGo = false } = {}) {
  const state = {
    redisRunning: true,
    provider: 'node',
    composeCalls: [],
    providerWrites: [],
  }

  const composeRunner = async ({ args }) => {
    state.composeCalls.push(args)
    if (args[0] === 'ps') {
      return { stdout: 'gateway\ngo\nnode\nredis\n' }
    }
    if (args[0] === 'stop' && args[1] === 'redis') {
      state.redisRunning = false
      return { stdout: '' }
    }
    if (args[0] === 'start' && args[1] === 'redis') {
      state.redisRunning = true
      return { stdout: '' }
    }
    throw new Error(`unexpected compose call: ${args.join(' ')}`)
  }

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input)
    const requestId = new Headers(init.headers).get('x-request-id') || ''
    const headers = {
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
    }
    let status = 200
    let body

    if (
      url.pathname === '/api/system/settings/system/backend.readProvider' &&
      init.method === 'PUT'
    ) {
      const requested = JSON.parse(init.body).value
      state.provider = requested
      state.providerWrites.push(requested)
      headers['X-ChronoFrame-Backend'] = 'node'
      body = { value: requested }
    } else if (url.pathname === '/health/ready') {
      headers['X-ChronoFrame-Backend'] = 'go'
      status = state.redisRunning ? 200 : 503
      body = {
        status: state.redisRunning ? 'ready' : 'not_ready',
        checks: {
          database: 'ok',
          mediaTools: 'ok',
          redis: state.redisRunning ? 'ok' : 'failed',
        },
        schema: { latestMigrationMillis: 1, migrationCount: 24 },
      }
    } else if (
      url.pathname === '/api/profile' ||
      url.pathname === '/__lab/go/api/profile'
    ) {
      const backend = url.pathname.startsWith('/__lab/go') ? 'go' : 'node'
      headers['X-ChronoFrame-Backend'] = backend
      if (state.redisRunning) {
        body = ADMIN_PROFILE
      } else {
        status = 503
        body = {
          error: true,
          statusCode: 503,
          statusMessage: 'Shared identity service unavailable',
          message: 'Shared identity service unavailable',
        }
      }
    } else if (
      url.pathname === '/api/photos/visible' ||
      url.pathname === '/__lab/go/api/photos/visible'
    ) {
      const backend = url.pathname.startsWith('/__lab/go') ? 'go' : 'node'
      headers['X-ChronoFrame-Backend'] = backend
      body = [{ id: driftPublicGo && backend === 'go' ? 'drift' : 'photo-1' }]
    } else {
      throw new Error(
        `unexpected request: ${init.method || 'GET'} ${url.pathname}`,
      )
    }

    return new Response(JSON.stringify(body), { status, headers })
  }

  return { state, composeRunner, fetchImpl }
}

test('Redis outage verifier proves fail-closed identity, public reads, and persisted-session recovery', async () => {
  const harness = createHarness()
  const summary = await verifyDualRedisOutage({
    base: 'http://127.0.0.1:33121',
    cookie: 'cf_session=fixture',
    timeoutMs: 5_000,
    requestTimeoutMs: 1_000,
    pollMs: 1,
    fetchImpl: harness.fetchImpl,
    composeRunner: harness.composeRunner,
    sleep: async () => {},
  })

  assert.equal(summary.ok, true)
  assert.equal(summary.outage.privateReadsFailClosed, true)
  assert.equal(summary.outage.publicReadsAvailable, true)
  assert.equal(summary.recovery.persistedSessionAcceptedByNode, true)
  assert.equal(summary.recovery.persistedSessionAcceptedByGo, true)
  assert.equal(
    summary.checks.every((check) => check.ok),
    true,
  )
  assert.deepEqual(harness.state.composeCalls, [
    ['ps', '--services', '--status', 'running'],
    ['stop', 'redis'],
    ['start', 'redis'],
  ])
  assert.equal(harness.state.redisRunning, true)
  assert.deepEqual(harness.state.providerWrites, ['node', 'node'])
})

test('Redis outage verifier restarts Redis and restores Node after a parity failure', async () => {
  const harness = createHarness({ driftPublicGo: true })
  await assert.rejects(
    verifyDualRedisOutage({
      base: 'http://127.0.0.1:33121',
      cookie: 'cf_session=fixture',
      timeoutMs: 5_000,
      requestTimeoutMs: 1_000,
      pollMs: 1,
      fetchImpl: harness.fetchImpl,
      composeRunner: harness.composeRunner,
      sleep: async () => {},
    }),
    (error) => {
      assert.equal(error.summary.ok, false)
      assert.match(error.message, /public photo bodies match/)
      assert.equal(
        error.summary.cleanup.every((entry) => entry.ok),
        true,
      )
      return true
    },
  )
  assert.equal(harness.state.redisRunning, true)
  assert.deepEqual(harness.state.composeCalls, [
    ['ps', '--services', '--status', 'running'],
    ['stop', 'redis'],
    ['start', 'redis'],
  ])
  assert.deepEqual(harness.state.providerWrites, ['node', 'node'])
})

test('Redis outage verifier options stay on loopback and inside the repository', () => {
  const options = parseRedisOutageVerifierOptions([], {
    CFRAME_DUAL_PORT: '33155',
    CFRAME_DUAL_REDIS_OUTAGE_TIMEOUT_MS: '45000',
    CFRAME_DUAL_REDIS_OUTAGE_REQUEST_TIMEOUT_MS: '12000',
    CFRAME_DUAL_REDIS_OUTAGE_POLL_MS: '500',
  })
  assert.equal(options.base, 'http://127.0.0.1:33155')
  assert.equal(options.timeoutMs, 45_000)
  assert.equal(options.requestTimeoutMs, 12_000)
  assert.equal(options.pollMs, 500)
  assert.match(options.composeFile, /deploy\/dual\/compose\.yaml$/)

  assert.throws(
    () => parseRedisOutageVerifierOptions(['--base', 'https://example.com']),
    /must use http/,
  )
  assert.throws(
    () => parseRedisOutageVerifierOptions(['--base', 'http://example.com']),
    /loopback/,
  )
  assert.throws(
    () =>
      parseRedisOutageVerifierOptions([
        '--compose-file',
        '../../../../tmp/compose.yaml',
      ]),
    /inside the repository/,
  )
})

test('Redis outage verifier refuses to touch an incomplete Compose stack', async () => {
  let fetchCalls = 0
  const composeCalls = []
  await assert.rejects(
    verifyDualRedisOutage({
      base: 'http://127.0.0.1:33121',
      cookie: 'cf_session=fixture',
      timeoutMs: 5_000,
      requestTimeoutMs: 1_000,
      pollMs: 1,
      fetchImpl: async () => {
        fetchCalls += 1
        throw new Error('should not fetch')
      },
      composeRunner: async ({ args }) => {
        composeCalls.push(args)
        return { stdout: 'node\nredis\n' }
      },
      sleep: async () => {},
    }),
    (error) => {
      assert.match(error.message, /required Compose services are running/)
      assert.deepEqual(error.summary.cleanup, [
        { name: 'Compose stack left untouched', ok: true },
      ])
      return true
    },
  )
  assert.equal(fetchCalls, 0)
  assert.deepEqual(composeCalls, [['ps', '--services', '--status', 'running']])
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_DUAL_LOGS_COOKIE,
  EXPECTED_SYSTEM_LOGS_CACHE_CONTROL,
  PROVIDER_SETTING_PATH,
  SYSTEM_LOG_INITIAL_QUERY_CASES,
  SYSTEM_LOGS_PATH,
  parseDualSystemLogsVerifierOptions,
  validateLogsProbe,
  verifyDualSystemLogs,
} from '../scripts/verify-dual-system-logs.mjs'

function jsonResponse(body, backend, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-chronoframe-backend': backend,
    },
  })
}

function sseResponse(line, backend, status = 200) {
  return new Response(`data: ${line}\n\n`, {
    status,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': EXPECTED_SYSTEM_LOGS_CACHE_CONTROL,
      'x-accel-buffering': 'no',
      'x-chronoframe-backend': backend,
    },
  })
}

function createLogsGateway({ driftProvider, omitLineProvider } = {}) {
  let provider = 'node'
  const requests = []
  return {
    requests,
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(String(url))
      requests.push({
        method: options.method || 'GET',
        pathname: parsed.pathname,
        search: parsed.search,
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

      if (parsed.pathname === SYSTEM_LOGS_PATH) {
        const backend = driftProvider === provider ? 'node' : provider
        const line =
          omitLineProvider === provider
            ? '{"message":"different log line"}'
            : '{"message":"dual system logs parity probe"}'
        return sseResponse(line, backend)
      }

      return jsonResponse({ message: 'not found' }, provider, 404)
    },
    getProvider: () => provider,
  }
}

test('system logs verifier options default to fixture session and dual port', () => {
  const options = parseDualSystemLogsVerifierOptions(['--line', 'fixed-line'], {
    CFRAME_DUAL_PORT: '33106',
  })

  assert.equal(options.base, 'http://127.0.0.1:33106')
  assert.equal(options.cookie, DEFAULT_DUAL_LOGS_COOKIE)
  assert.equal(options.timeoutMs, 5_000)
  assert.equal(options.line, 'fixed-line')
})

test('system logs verifier toggles Node and Go SSE streams and restores Node', async () => {
  const gateway = createLogsGateway()
  const result = await verifyDualSystemLogs({
    base: 'http://gateway.test',
    cookie: 'cf_session=test-token',
    line: '{"message":"dual system logs parity probe"}',
    timeoutMs: 1_000,
    appendLog: false,
    fetchImpl: gateway.fetchImpl,
  })

  assert.equal(result.ok, true)
  assert.equal(gateway.getProvider(), 'node')
  assert.deepEqual(
    gateway.requests.map((request) => [
      request.method,
      request.pathname,
      request.search,
      request.cookie,
    ]),
    [
      ['PUT', PROVIDER_SETTING_PATH, '', 'cf_session=test-token'],
      ['PUT', PROVIDER_SETTING_PATH, '', 'cf_session=test-token'],
      ['GET', SYSTEM_LOGS_PATH, '?initial=all', 'cf_session=test-token'],
      ['PUT', PROVIDER_SETTING_PATH, '', 'cf_session=test-token'],
      ['GET', SYSTEM_LOGS_PATH, '?initial=all', 'cf_session=test-token'],
      ['PUT', PROVIDER_SETTING_PATH, '', 'cf_session=test-token'],
    ],
  )
  assert.deepEqual(
    result.checks
      .filter((check) => check.path === `${SYSTEM_LOGS_PATH}?initial=all`)
      .map((check) => [check.name, check.backend, check.foundLine]),
    [
      ['system logs SSE via node', 'node', true],
      ['system logs SSE via go', 'go', true],
    ],
  )
})

test('system logs verifier reports a stream that falls back to Node', async () => {
  const gateway = createLogsGateway({ driftProvider: 'go' })
  const result = await verifyDualSystemLogs({
    base: 'http://gateway.test',
    cookie: 'cf_session=test-token',
    line: '{"message":"dual system logs parity probe"}',
    timeoutMs: 1_000,
    appendLog: false,
    fetchImpl: gateway.fetchImpl,
  })

  assert.equal(result.ok, false)
  assert.deepEqual(
    result.errors.map((error) => error.field),
    ['headers.x-chronoframe-backend'],
  )
})

test('system logs validation reports missing target event data', () => {
  assert.deepEqual(
    validateLogsProbe(
      {
        name: 'system logs SSE via go',
        expectedBackend: 'go',
        status: 200,
        backend: 'go',
        contentType: 'text/event-stream',
        cacheControl: EXPECTED_SYSTEM_LOGS_CACHE_CONTROL,
        foundLine: false,
        eventPreview: 'data: other',
      },
      'target',
    ).map((error) => error.field),
    ['event.data'],
  )
})

test('system logs deep matrix covers JavaScript query coercion and live appends', () => {
  const names = SYSTEM_LOG_INITIAL_QUERY_CASES.map((testCase) => testCase.name)
  for (const fragment of [
    'empty',
    'hex',
    'exponent',
    'fractional',
    'spaced all',
    'repeated',
  ]) {
    assert.ok(names.some((name) => name.includes(fragment)))
  }
  assert.deepEqual(
    validateLogsProbe(
      {
        name: 'empty initial',
        expectedBackend: 'go',
        status: 200,
        backend: 'go',
        contentType: 'text/event-stream',
        cacheControl: EXPECTED_SYSTEM_LOGS_CACHE_CONTROL,
        foundLine: false,
        eventPreview: '',
      },
      'target',
      false,
    ),
    [],
  )
})

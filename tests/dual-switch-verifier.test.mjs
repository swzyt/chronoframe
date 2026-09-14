import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_SWITCH_COOKIE,
  PROVIDER_SETTING_PATH,
  PUBLIC_SETTINGS_PATH,
  SLOGAN_SETTING_PATH,
  buildSwitchVerificationPlan,
  parseSwitchVerifierOptions,
  validateStepResult,
  verifyDualSwitch,
} from '../scripts/verify-dual-switch.mjs'

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

function createGatewayFetch({ failGoReadBackend = false } = {}) {
  let provider = 'node'
  let slogan = 'original slogan'
  const requests = []
  const fetchImpl = async (url, options) => {
    const requestURL = new URL(url)
    const directGo = requestURL.host === 'go.test'
    const request = {
      url: String(url),
      method: options.method,
      headers: options.headers,
      body: options.body ? JSON.parse(options.body) : undefined,
      directGo,
    }
    requests.push(request)

    const pathname = requestURL.pathname
    if (options.method === 'PUT' && pathname === PROVIDER_SETTING_PATH) {
      provider = request.body.value
      return jsonResponse(
        {
          namespace: 'system',
          key: 'backend.readProvider',
          value: provider,
        },
        directGo ? 'go' : 'node',
      )
    }

    if (options.method === 'GET' && pathname === PROVIDER_SETTING_PATH) {
      return jsonResponse(
        {
          namespace: 'system',
          key: 'backend.readProvider',
          value: provider,
        },
        failGoReadBackend && provider === 'go' ? 'node' : provider,
      )
    }

    if (options.method === 'GET' && pathname === PUBLIC_SETTINGS_PATH) {
      return jsonResponse(
        {
          timestamp: 1,
          data: { system: { firstLaunch: false } },
        },
        provider,
      )
    }

    if (pathname === SLOGAN_SETTING_PATH) {
      if (options.method === 'GET') {
        return jsonResponse(
          {
            namespace: 'app',
            key: 'slogan',
            value: slogan,
          },
          provider,
        )
      }
      if (options.method === 'PUT') {
        slogan = request.body.value
        return jsonResponse(
          {
            namespace: 'app',
            key: 'slogan',
            value: slogan,
          },
          provider,
        )
      }
    }

    return jsonResponse({ error: 'not found' }, 'node', 404)
  }
  return {
    fetchImpl,
    requests,
    getProvider: () => provider,
    getSlogan: () => slogan,
  }
}

test('dual switch verifier toggles gateway reads through Go and then Node', async () => {
  const gateway = createGatewayFetch()

  const result = await verifyDualSwitch({
    base: 'http://gateway.test',
    cookie: 'cf_session=test-token',
    iterations: 2,
    fetchImpl: gateway.fetchImpl,
  })

  assert.equal(result.ok, true)
  assert.equal(result.checks.length, 19)
  assert.equal(gateway.requests.length, 19)
  assert.equal(gateway.getProvider(), 'node')
  assert.equal(gateway.getSlogan(), 'original slogan')
  assert.deepEqual(
    gateway.requests.map((request) => [
      request.method,
      new URL(request.url).pathname,
      request.body?.value,
    ]),
    [
      ['PUT', PROVIDER_SETTING_PATH, 'node'],
      ['GET', SLOGAN_SETTING_PATH, undefined],
      ['PUT', PROVIDER_SETTING_PATH, 'go'],
      ['GET', PROVIDER_SETTING_PATH, undefined],
      ['GET', PUBLIC_SETTINGS_PATH, undefined],
      ['PUT', SLOGAN_SETTING_PATH, 'dual-switch-go-write-1'],
      ['PUT', PROVIDER_SETTING_PATH, 'node'],
      ['GET', PROVIDER_SETTING_PATH, undefined],
      ['GET', PUBLIC_SETTINGS_PATH, undefined],
      ['GET', SLOGAN_SETTING_PATH, undefined],
      ['PUT', PROVIDER_SETTING_PATH, 'go'],
      ['GET', PROVIDER_SETTING_PATH, undefined],
      ['GET', PUBLIC_SETTINGS_PATH, undefined],
      ['PUT', SLOGAN_SETTING_PATH, 'dual-switch-go-write-2'],
      ['PUT', PROVIDER_SETTING_PATH, 'node'],
      ['GET', PROVIDER_SETTING_PATH, undefined],
      ['GET', PUBLIC_SETTINGS_PATH, undefined],
      ['GET', SLOGAN_SETTING_PATH, undefined],
      ['PUT', SLOGAN_SETTING_PATH, 'original slogan'],
    ],
  )
  for (const request of gateway.requests) {
    assert.equal(request.headers.Cookie, 'cf_session=test-token')
    assert.match(request.headers['X-Request-Id'], /^dual-switch-/)
  }
})

test('dual switch verifier can prove direct Go service settings writes', async () => {
  const gateway = createGatewayFetch()

  const result = await verifyDualSwitch({
    base: 'http://gateway.test',
    goBase: 'http://go.test',
    cookie: 'cf_session=test-token',
    fetchImpl: gateway.fetchImpl,
  })

  assert.equal(result.ok, true)
  assert.equal(result.goBase, 'http://go.test')
  assert.equal(gateway.getProvider(), 'node')
  assert.equal(gateway.getSlogan(), 'original slogan')
  assert.deepEqual(
    gateway.requests
      .slice(0, 7)
      .map((request) => [
        request.method,
        new URL(request.url).host,
        new URL(request.url).pathname,
        request.body?.value,
      ]),
    [
      ['PUT', 'gateway.test', PROVIDER_SETTING_PATH, 'node'],
      ['GET', 'gateway.test', SLOGAN_SETTING_PATH, undefined],
      ['PUT', 'go.test', PROVIDER_SETTING_PATH, 'go'],
      ['GET', 'gateway.test', PROVIDER_SETTING_PATH, undefined],
      ['PUT', 'go.test', SLOGAN_SETTING_PATH, 'dual-switch-direct-go-write'],
      ['PUT', 'gateway.test', PROVIDER_SETTING_PATH, 'node'],
      ['GET', 'gateway.test', SLOGAN_SETTING_PATH, undefined],
    ],
  )
  assert.equal(result.checks[6].body.value, 'dual-switch-direct-go-write')
})

test('dual switch verifier restores Node when validation fails after Go switch', async () => {
  const gateway = createGatewayFetch({ failGoReadBackend: true })

  const result = await verifyDualSwitch({
    base: 'http://gateway.test',
    cookie: 'cf_session=test-token',
    fetchImpl: gateway.fetchImpl,
  })

  assert.equal(result.ok, false)
  assert.equal(gateway.getProvider(), 'node')
  assert.equal(gateway.getSlogan(), 'original slogan')
  assert.deepEqual(result.errors, [
    {
      name: 'iteration 1: read provider setting through go',
      field: 'headers.x-chronoframe-backend',
      expected: 'go',
      actual: 'node',
    },
  ])
  const providerRestore = result.checks.find((check) => check.restore)
  assert.equal(providerRestore.method, 'PUT')
  assert.equal(providerRestore.body.value, 'node')
})

test('switch verification plan encodes provider control as Node-owned', () => {
  const plan = buildSwitchVerificationPlan(1)

  assert.equal(plan.length, 8)
  assert.deepEqual(
    plan.map((step) => [step.kind, step.provider, step.expectedBackend]),
    [
      ['switch', 'go', 'node'],
      ['read-provider', 'go', 'go'],
      ['read-public-settings', 'go', 'go'],
      ['write-slogan-go', 'go', 'go'],
      ['switch', 'node', 'node'],
      ['read-provider', 'node', 'node'],
      ['read-public-settings', 'node', 'node'],
      ['read-slogan-node', 'node', 'node'],
    ],
  )
})

test('switch verifier options default to fixture session and dual port', () => {
  const options = parseSwitchVerifierOptions([], {
    CFRAME_DUAL_PORT: '33105',
  })

  assert.equal(options.base, 'http://127.0.0.1:33105')
  assert.equal(options.goBase, '')
  assert.equal(options.cookie, DEFAULT_SWITCH_COOKIE)
  assert.equal(options.iterations, 1)
  assert.equal(options.timeoutMs, 5_000)
})

test('switch verifier options accept explicit base, cookie, iterations and timeout', () => {
  const options = parseSwitchVerifierOptions(
    [
      '--',
      '--base',
      'http://gateway.test/prefix/',
      '--go-base',
      'http://go.test/',
      '--cookie',
      'cf_session=custom',
      '--iterations',
      '3',
      '--timeout-ms',
      '2500',
    ],
    {},
  )

  assert.deepEqual(options, {
    base: 'http://gateway.test/prefix',
    goBase: 'http://go.test',
    cookie: 'cf_session=custom',
    iterations: 3,
    timeoutMs: 2_500,
  })
})

test('switch verifier options accept Go base from environment', () => {
  const options = parseSwitchVerifierOptions([], {
    CFRAME_DUAL_GO_BASE_URL: 'http://go:8080/',
  })

  assert.equal(options.goBase, 'http://go:8080')
})

test('switch verifier validation reports status, backend, content type and value drift', () => {
  const errors = validateStepResult(
    {
      name: 'read provider',
      expectedStatus: 200,
      expectedBackend: 'go',
      expectedValue: 'go',
    },
    {
      status: 500,
      backend: 'node',
      contentType: 'text/plain',
      body: { value: 'node' },
    },
  )

  assert.deepEqual(
    errors.map((error) => error.field),
    [
      'status',
      'headers.x-chronoframe-backend',
      'headers.content-type',
      'body.value',
    ],
  )
})

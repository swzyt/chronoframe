#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { joinBackendURL } from './compare-backends.mjs'
import { FIXTURE_SESSION_TOKEN } from './seed-dual-backend-fixture.mjs'

export const DEFAULT_OAUTH_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_OAUTH_ADMIN_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`

const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'
const OAUTH_SETTING_KEYS = [
  'auth.github.enabled',
  'auth.github.clientId',
  'auth.github.clientSecret',
]
const TEST_CLIENT_ID = 'dual-oauth-client'
const TEST_CLIENT_SECRET = 'dual-oauth-secret-at-least-32-characters'
const STATE_COOKIE_NAME = 'nuxt-auth-state'
const STATE_PATTERN = /^[A-Za-z0-9_-]{11}$/
const STATE_PLACEHOLDER = '<oauth-state>'

export const OAUTH_PARITY_CASES = Object.freeze([
  Object.freeze({
    name: 'initial authorization redirect',
    path: '/api/auth/github',
    kind: 'new-state-redirect',
  }),
  Object.freeze({
    name: 'empty code starts authorization',
    path: '/api/auth/github?code=',
    kind: 'new-state-redirect',
  }),
  Object.freeze({
    name: 'provider error array coercion',
    path: '/api/auth/github?error=access_denied&error=user_cancelled',
    kind: 'error',
    expectedMessage:
      'Authentication failed: GitHub login failed: access_denied,user_cancelled',
  }),
  Object.freeze({
    name: 'empty repeated provider error is truthy',
    path: '/api/auth/github?error=&error=',
    kind: 'error',
    expectedMessage: 'Authentication failed: GitHub login failed: ,',
  }),
  Object.freeze({
    name: 'invalid state clears oauth cookie',
    path: '/api/auth/github?code=x&state=y',
    kind: 'state-error',
  }),
  Object.freeze({
    name: 'repeated state never equals scalar cookie',
    path: '/api/auth/github?code=x&state=match&state=other',
    kind: 'state-error',
    cookie: `${STATE_COOKIE_NAME}=match`,
  }),
  Object.freeze({
    name: 'repeated code is a truthy callback value',
    path: '/api/auth/github?code=x&code=y',
    kind: 'new-state-error',
  }),
  Object.freeze({
    name: 'state without code reuses and clears cookie',
    path: '/api/auth/github?state=match',
    kind: 'existing-state-redirect',
    cookie: `${STATE_COOKIE_NAME}=match`,
  }),
])

export function parseOAuthVerifierOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (
      !['--base', '--node', '--go', '--admin-cookie', '--timeout-ms'].includes(
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

  const base = normalizeBaseURL(
    values.get('--base') ||
      environment.CFRAME_DUAL_BASE_URL ||
      (environment.CFRAME_DUAL_PORT
        ? `http://127.0.0.1:${environment.CFRAME_DUAL_PORT}`
        : DEFAULT_OAUTH_BASE_URL),
  )
  const timeoutMs = parsePositiveInteger(
    values.get('--timeout-ms') || environment.CFRAME_DUAL_TIMEOUT_MS || 5_000,
    'timeout-ms',
  )
  if (timeoutMs > 60_000) {
    throw new Error('timeout-ms must be 60000 or less')
  }

  return {
    nodeURL: normalizeBaseURL(
      values.get('--node') || environment.CFRAME_DUAL_NODE_URL || base,
    ),
    goURL: normalizeBaseURL(
      values.get('--go') ||
        environment.CFRAME_DUAL_GO_URL ||
        `${base}/__lab/go`,
    ),
    adminCookie: normalizeOptionalCookie(
      values.get('--admin-cookie') ||
        environment.CFRAME_DUAL_ADMIN_COOKIE ||
        environment.CFRAME_DUAL_COOKIE ||
        DEFAULT_OAUTH_ADMIN_COOKIE,
    ),
    timeoutMs,
  }
}

export async function verifyDualOAuth({
  nodeURL,
  goURL,
  adminCookie = DEFAULT_OAUTH_ADMIN_COOKIE,
  timeoutMs = 5_000,
  cases = OAUTH_PARITY_CASES,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function')
  }
  if (!nodeURL || !goURL) {
    throw new Error('nodeURL and goURL are required')
  }

  const options = {
    nodeURL: normalizeBaseURL(nodeURL),
    goURL: normalizeBaseURL(goURL),
    adminCookie: normalizeOptionalCookie(adminCookie),
    timeoutMs: parsePositiveInteger(timeoutMs, 'timeout-ms'),
    fetchImpl,
  }
  const originalSettings = new Map()
  let originalProvider = 'node'
  const cleanup = []
  const results = []

  try {
    originalProvider = await forceNodeProvider(options)
    await captureSettings(options, originalSettings)
    await configureOAuth(options)

    for (const testCase of cases) {
      results.push(await compareOAuthCase(options, testCase))
    }
  } finally {
    for (const [key, value] of [...originalSettings.entries()].reverse()) {
      cleanup.push(
        await cleanupAction(`restore system.${key}`, () =>
          controlRequest(options, {
            method: 'PUT',
            path: `/api/system/settings/system/${key}`,
            body: { value },
          }),
        ),
      )
    }
    if (originalProvider !== 'node') {
      cleanup.push(
        await cleanupAction(`restore provider to ${originalProvider}`, () =>
          controlRequest(options, {
            method: 'PUT',
            path: PROVIDER_SETTING_PATH,
            body: { value: originalProvider },
          }),
        ),
      )
    }
  }

  const failed = results.filter((result) => !result.equal).length
  const cleanupFailed = cleanup.filter((result) => !result.ok).length
  return {
    ok: failed === 0 && cleanupFailed === 0,
    total: results.length,
    failed,
    cleanupFailed,
    nodeURL: options.nodeURL,
    goURL: options.goURL,
    results,
    cleanup,
  }
}

async function compareOAuthCase(options, testCase) {
  const [node, go] = await Promise.all([
    requestOAuth(options, options.nodeURL, 'node', testCase),
    requestOAuth(options, options.goURL, 'go', testCase),
  ])
  const nodeComparable = validateAndNormalizeResult(testCase, node)
  const goComparable = validateAndNormalizeResult(testCase, go)
  const differences = [
    ...nodeComparable.differences,
    ...goComparable.differences,
  ]
  if (
    JSON.stringify(nodeComparable.value) !== JSON.stringify(goComparable.value)
  ) {
    differences.push({
      field: 'node-go parity',
      node: nodeComparable.value,
      go: goComparable.value,
    })
  }
  return {
    name: testCase.name,
    equal: differences.length === 0,
    differences,
    node: nodeComparable.value,
    go: goComparable.value,
  }
}

async function requestOAuth(options, baseURL, expectedBackend, testCase) {
  const headers = {
    Accept: '*/*',
    'X-Request-Id': `dual-oauth-${expectedBackend}-${randomUUID()}`,
  }
  if (testCase.cookie) headers.Cookie = testCase.cookie
  const response = await options.fetchImpl(
    joinBackendURL(baseURL, testCase.path),
    {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    },
  )
  const text = await response.text()
  return {
    expectedBackend,
    status: response.status,
    backend: response.headers.get('x-chronoframe-backend'),
    contentType: normalizedContentType(response.headers.get('content-type')),
    location: response.headers.get('location'),
    setCookie: response.headers.get('set-cookie'),
    text,
    body: parseJSONBody(text),
  }
}

function validateAndNormalizeResult(testCase, result) {
  const differences = []
  if (result.backend !== result.expectedBackend) {
    differences.push({
      field: `${result.expectedBackend}.backend`,
      expected: result.expectedBackend,
      actual: result.backend,
    })
  }

  if (testCase.kind.endsWith('redirect')) {
    return normalizeRedirect(testCase, result, differences)
  }
  return normalizeError(testCase, result, differences)
}

function normalizeRedirect(testCase, result, differences) {
  if (result.status !== 302) {
    differences.push({
      field: `${result.expectedBackend}.status`,
      expected: 302,
      actual: result.status,
    })
  }
  if (result.contentType !== 'text/html') {
    differences.push({
      field: `${result.expectedBackend}.contentType`,
      expected: 'text/html',
      actual: result.contentType,
    })
  }
  const location = result.location || ''
  const expectedBody = `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url=${location.replaceAll('"', '%22')}"></head></html>`
  if (result.text !== expectedBody) {
    differences.push({
      field: `${result.expectedBackend}.body`,
      expected: expectedBody,
      actual: result.text,
    })
  }

  let state = 'match'
  try {
    const authorizeURL = new URL(location)
    if (
      authorizeURL.origin !== 'https://github.com' ||
      authorizeURL.pathname !== '/login/oauth/authorize'
    ) {
      throw new Error('unexpected GitHub authorization endpoint')
    }
    if (authorizeURL.searchParams.get('client_id') !== TEST_CLIENT_ID) {
      throw new Error('unexpected client_id')
    }
    if (authorizeURL.searchParams.get('scope') !== 'user:email') {
      throw new Error('unexpected scope')
    }
    state = authorizeURL.searchParams.get('state') || ''
  } catch (error) {
    differences.push({
      field: `${result.expectedBackend}.location`,
      expected: 'valid GitHub authorization URL',
      actual: error instanceof Error ? error.message : String(error),
    })
  }

  if (testCase.kind === 'new-state-redirect') {
    if (!STATE_PATTERN.test(state)) {
      differences.push({
        field: `${result.expectedBackend}.state`,
        expected: '11-character base64url value',
        actual: state,
      })
    }
    const expectedCookie = `${STATE_COOKIE_NAME}=${state}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`
    if (result.setCookie !== expectedCookie) {
      differences.push({
        field: `${result.expectedBackend}.setCookie`,
        expected: expectedCookie,
        actual: result.setCookie,
      })
    }
  } else {
    if (state !== 'match') {
      differences.push({
        field: `${result.expectedBackend}.state`,
        expected: 'match',
        actual: state,
      })
    }
    assertClearCookie(result, differences)
  }

  return {
    differences,
    value: {
      status: result.status,
      contentType: result.contentType,
      location: replaceState(location, state),
      setCookie:
        testCase.kind === 'new-state-redirect'
          ? replaceState(result.setCookie, state)
          : result.setCookie,
      body: replaceState(result.text, state),
    },
  }
}

function normalizeError(testCase, result, differences) {
  if (result.status !== 401) {
    differences.push({
      field: `${result.expectedBackend}.status`,
      expected: 401,
      actual: result.status,
    })
  }
  if (result.contentType !== 'application/json') {
    differences.push({
      field: `${result.expectedBackend}.contentType`,
      expected: 'application/json',
      actual: result.contentType,
    })
  }

  const expectedMessage =
    testCase.expectedMessage ||
    'Authentication failed: Github login failed: state mismatch'
  for (const field of ['statusMessage', 'message']) {
    if (result.body?.[field] !== expectedMessage) {
      differences.push({
        field: `${result.expectedBackend}.body.${field}`,
        expected: expectedMessage,
        actual: result.body?.[field],
      })
    }
  }

  let normalizedCookie = result.setCookie
  if (testCase.kind === 'state-error') {
    assertClearCookie(result, differences)
  } else if (testCase.kind === 'new-state-error') {
    const state = extractCookieState(result.setCookie)
    if (!STATE_PATTERN.test(state)) {
      differences.push({
        field: `${result.expectedBackend}.cookieState`,
        expected: '11-character base64url value',
        actual: state,
      })
    }
    const expectedCookie = `${STATE_COOKIE_NAME}=${state}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`
    if (result.setCookie !== expectedCookie) {
      differences.push({
        field: `${result.expectedBackend}.setCookie`,
        expected: expectedCookie,
        actual: result.setCookie,
      })
    }
    normalizedCookie = replaceState(result.setCookie, state)
  } else if (result.setCookie !== null) {
    differences.push({
      field: `${result.expectedBackend}.setCookie`,
      expected: null,
      actual: result.setCookie,
    })
  }

  return {
    differences,
    value: {
      status: result.status,
      contentType: result.contentType,
      setCookie: normalizedCookie,
      statusMessage: result.body?.statusMessage,
      message: result.body?.message,
    },
  }
}

function assertClearCookie(result, differences) {
  const expected = `${STATE_COOKIE_NAME}=; Max-Age=0; Path=/`
  if (result.setCookie !== expected) {
    differences.push({
      field: `${result.expectedBackend}.setCookie`,
      expected,
      actual: result.setCookie,
    })
  }
}

function extractCookieState(cookie) {
  const match = String(cookie || '').match(/^nuxt-auth-state=([^;]+);/)
  return match?.[1] || ''
}

function replaceState(value, state) {
  if (!value || !state) return value
  return value.replaceAll(state, STATE_PLACEHOLDER)
}

async function forceNodeProvider(options) {
  const current = await controlRequest(options, {
    method: 'GET',
    path: PROVIDER_SETTING_PATH,
  })
  const originalProvider = current?.value === 'go' ? 'go' : 'node'
  if (originalProvider !== 'node') {
    await controlRequest(options, {
      method: 'PUT',
      path: PROVIDER_SETTING_PATH,
      body: { value: 'node' },
    })
  }
  return originalProvider
}

async function captureSettings(options, originalSettings) {
  for (const key of OAUTH_SETTING_KEYS) {
    const result = await controlRequest(options, {
      method: 'GET',
      path: `/api/system/settings/system/${key}`,
    })
    originalSettings.set(key, result?.value)
  }
}

async function configureOAuth(options) {
  const values = new Map([
    ['auth.github.enabled', true],
    ['auth.github.clientId', TEST_CLIENT_ID],
    ['auth.github.clientSecret', TEST_CLIENT_SECRET],
  ])
  for (const [key, value] of values) {
    await controlRequest(options, {
      method: 'PUT',
      path: `/api/system/settings/system/${key}`,
      body: { value },
    })
  }
}

async function controlRequest(options, { method, path, body }) {
  const headers = {
    Accept: 'application/json',
    'Accept-Language': 'en',
    'X-Request-Id': `dual-oauth-control-${randomUUID()}`,
  }
  if (options.adminCookie) headers.Cookie = options.adminCookie
  const payload = body === undefined ? undefined : JSON.stringify(body)
  if (payload !== undefined) headers['Content-Type'] = 'application/json'
  const response = await options.fetchImpl(
    joinBackendURL(options.nodeURL, path),
    {
      method,
      headers,
      body: payload,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    },
  )
  const text = await response.text()
  const parsed = parseJSONBody(text)
  if (!response.ok) {
    throw new Error(
      `${method} ${path} returned ${response.status}: ${parsed?.statusMessage || text}`,
    )
  }
  return parsed
}

async function cleanupAction(name, action) {
  try {
    await action()
    return { name, ok: true }
  } catch (error) {
    return {
      name,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function parseJSONBody(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { parseError: true, raw: text.slice(0, 500) }
  }
}

function normalizedContentType(value) {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || ''
}

function normalizeBaseURL(value) {
  const url = new URL(value)
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/g, '') || '/'
  return url.toString().replace(/\/$/g, '')
}

function normalizeOptionalCookie(value) {
  const cookie = String(value || '').trim()
  return cookie || undefined
}

function parsePositiveInteger(value, label) {
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return parsed
}

async function main() {
  const result = await verifyDualOAuth(parseOAuthVerifierOptions())
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}

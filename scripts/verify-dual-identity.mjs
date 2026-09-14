#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { joinBackendURL } from './compare-backends.mjs'
import {
  FIXTURE_ADMIN_EMAIL,
  FIXTURE_ADMIN_NAME,
  FIXTURE_ADMIN_PASSWORD,
  FIXTURE_SESSION_TOKEN,
} from './seed-dual-backend-fixture.mjs'

export const DEFAULT_IDENTITY_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_IDENTITY_ADMIN_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`

const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'
const SESSION_COOKIE_NAME = 'cf_session'
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

export function parseIdentityVerifierOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (
      ![
        '--base',
        '--node',
        '--go',
        '--admin-cookie',
        '--email',
        '--password',
        '--timeout-ms',
      ].includes(arg)
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
        : DEFAULT_IDENTITY_BASE_URL),
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
    adminCookie: normalizeRequiredCookie(
      values.get('--admin-cookie') ||
        environment.CFRAME_DUAL_ADMIN_COOKIE ||
        environment.CFRAME_DUAL_COOKIE ||
        DEFAULT_IDENTITY_ADMIN_COOKIE,
    ),
    email:
      values.get('--email') ||
      environment.CFRAME_DUAL_ADMIN_EMAIL ||
      FIXTURE_ADMIN_EMAIL,
    password:
      values.get('--password') ||
      environment.CFRAME_DUAL_ADMIN_PASSWORD ||
      FIXTURE_ADMIN_PASSWORD,
    timeoutMs,
  }
}

export async function verifyDualIdentity({
  nodeURL,
  goURL,
  adminCookie = DEFAULT_IDENTITY_ADMIN_COOKIE,
  email = FIXTURE_ADMIN_EMAIL,
  password = FIXTURE_ADMIN_PASSWORD,
  timeoutMs = 5_000,
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
    adminCookie: normalizeRequiredCookie(adminCookie),
    email: String(email || '').trim(),
    password: String(password || ''),
    timeoutMs: parsePositiveInteger(timeoutMs, 'timeout-ms'),
    fetchImpl,
  }
  if (!options.email || !options.password) {
    throw new Error('email and password are required')
  }

  const checks = []
  const cleanup = []
  const issuedCookies = new Set()
  let originalProvider = 'node'

  try {
    originalProvider = await readProvider(options)

    await switchProvider(options, 'node', checks)
    await expectInvalidCredentialsParity(options, checks)
    const nodeLogin = await login(options, 'node')
    const nodeCookie = validateLogin(nodeLogin, 'node', checks)
    issuedCookies.add(nodeCookie)

    const nodeIssuedGoProfile = await expectProfile(
      options,
      options.goURL,
      nodeCookie,
      'go',
      'Node-issued session accepted by Go',
      checks,
    )
    const nodeIssuedNodeProfile = await expectProfile(
      options,
      options.nodeURL,
      nodeCookie,
      'node',
      'Node-issued session accepted by Node',
      checks,
    )
    assert.deepEqual(nodeIssuedGoProfile, nodeIssuedNodeProfile)
    checks.push({
      name: 'Node-issued session profile parity',
      ok: true,
    })
    await expectSessionUser(
      options,
      options.goURL,
      nodeCookie,
      'go',
      'Node-issued session exposed by Go auth endpoint',
      checks,
    )
    await expectLogout(
      options,
      options.goURL,
      nodeCookie,
      'go',
      'Node-issued session revoked by Go',
      checks,
    )
    await expectUnauthorizedEverywhere(
      options,
      nodeCookie,
      'Node-issued session rejected after Go logout',
      checks,
    )
    issuedCookies.delete(nodeCookie)

    const nodeSessionDeleteLogin = await login(options, 'node')
    const nodeSessionDeleteCookie = validateLogin(
      nodeSessionDeleteLogin,
      'node',
      checks,
    )
    issuedCookies.add(nodeSessionDeleteCookie)
    await expectSessionDelete(
      options,
      options.goURL,
      nodeSessionDeleteCookie,
      'go',
      'Node-issued session deleted by Go auth endpoint',
      checks,
    )
    await expectUnauthorizedEverywhere(
      options,
      nodeSessionDeleteCookie,
      'Node-issued session rejected after Go auth endpoint delete',
      checks,
    )
    issuedCookies.delete(nodeSessionDeleteCookie)

    await switchProvider(options, 'go', checks)
    const goLogin = await login(options, 'go')
    const goCookie = validateLogin(goLogin, 'go', checks)
    issuedCookies.add(goCookie)

    const goIssuedGoProfile = await expectProfile(
      options,
      options.goURL,
      goCookie,
      'go',
      'Go-issued session accepted by Go',
      checks,
    )
    await switchProvider(options, 'node', checks)
    const goIssuedNodeProfile = await expectProfile(
      options,
      options.nodeURL,
      goCookie,
      'node',
      'Go-issued session accepted by Node',
      checks,
    )
    assert.deepEqual(goIssuedGoProfile, goIssuedNodeProfile)
    checks.push({
      name: 'Go-issued session profile parity',
      ok: true,
    })
    await expectSessionUser(
      options,
      options.nodeURL,
      goCookie,
      'node',
      'Go-issued session exposed by Node auth endpoint',
      checks,
    )
    await expectLogout(
      options,
      options.nodeURL,
      goCookie,
      'node',
      'Go-issued session revoked by Node',
      checks,
    )
    await expectUnauthorizedEverywhere(
      options,
      goCookie,
      'Go-issued session rejected after Node logout',
      checks,
    )
    issuedCookies.delete(goCookie)

    await switchProvider(options, 'go', checks)
    const goSessionDeleteLogin = await login(options, 'go')
    const goSessionDeleteCookie = validateLogin(
      goSessionDeleteLogin,
      'go',
      checks,
    )
    issuedCookies.add(goSessionDeleteCookie)
    await switchProvider(options, 'node', checks)
    await expectSessionDelete(
      options,
      options.nodeURL,
      goSessionDeleteCookie,
      'node',
      'Go-issued session deleted by Node auth endpoint',
      checks,
    )
    await expectUnauthorizedEverywhere(
      options,
      goSessionDeleteCookie,
      'Go-issued session rejected after Node auth endpoint delete',
      checks,
    )
    issuedCookies.delete(goSessionDeleteCookie)
  } finally {
    cleanup.push(
      await cleanupAction('switch to Node for session cleanup', () =>
        setProvider(options, 'node'),
      ),
    )
    for (const cookie of issuedCookies) {
      cleanup.push(
        await cleanupAction('revoke residual session through Go', () =>
          rawRequest(options, options.goURL, '/api/logout', {
            method: 'GET',
            cookie,
          }),
        ),
      )
      cleanup.push(
        await cleanupAction('revoke residual session through Node', () =>
          rawRequest(options, options.nodeURL, '/api/logout', {
            method: 'GET',
            cookie,
          }),
        ),
      )
    }
    cleanup.push(
      await cleanupAction(`restore provider to ${originalProvider}`, () =>
        setProvider(options, originalProvider),
      ),
    )
  }

  const cleanupFailed = cleanup.filter((entry) => !entry.ok).length
  return {
    ok: cleanupFailed === 0,
    nodeURL: options.nodeURL,
    goURL: options.goURL,
    originalProvider,
    checkCount: checks.length,
    checks,
    cleanupFailed,
    cleanup,
  }
}

async function expectInvalidCredentialsParity(options, checks) {
  const invalidEmail = `dual-identity-${randomUUID()}@chronoframe.invalid`
  const body = { email: invalidEmail, password: 'invalid-password' }
  const [node, go] = await Promise.all([
    rawRequest(options, options.nodeURL, '/api/login', {
      method: 'POST',
      body,
      expectedBackend: 'node',
    }),
    rawRequest(options, options.goURL, '/api/login', {
      method: 'POST',
      body,
      expectedBackend: 'go',
    }),
  ])
  const expectedError = {
    statusCode: 401,
    statusMessage: 'Server Error',
    message: 'Invalid credentials',
  }
  for (const result of [node, go]) {
    assert.equal(result.status, 401, `${result.backend} invalid login status`)
    assert.equal(result.contentType, 'application/json')
    assert.deepEqual(selectIdentityError(result.body), expectedError)
    assert.equal(
      findSetCookie(result.setCookies, SESSION_COOKIE_NAME),
      undefined,
      `${result.backend} invalid login must not issue a session`,
    )
  }
  checks.push({
    name: 'Invalid credentials parity',
    ok: true,
    statuses: { node: node.status, go: go.status },
  })
}

function selectIdentityError(body) {
  return {
    statusCode: body?.statusCode,
    statusMessage: body?.statusMessage,
    message: body?.message,
  }
}

async function login(options, expectedBackend) {
  return rawRequest(options, options.nodeURL, '/api/login', {
    method: 'POST',
    body: {
      email: options.email,
      password: options.password,
    },
    expectedBackend,
  })
}

function validateLogin(result, expectedBackend, checks) {
  assert.equal(result.status, 201, `${expectedBackend} login status`)
  assert.equal(result.contentType, '', `${expectedBackend} login content type`)
  assert.equal(result.body, null, `${expectedBackend} login body`)
  assert.equal(
    result.backend,
    expectedBackend,
    `${expectedBackend} login owner`,
  )
  const sharedCookie = findSetCookie(result.setCookies, SESSION_COOKIE_NAME)
  assert.ok(
    sharedCookie,
    `${expectedBackend} login must set ${SESSION_COOKIE_NAME}`,
  )
  const parsed = parseSetCookie(sharedCookie)
  assert.match(parsed.value, SESSION_TOKEN_PATTERN)
  assert.notEqual(parsed.value, FIXTURE_SESSION_TOKEN)
  assert.equal(
    parsed.attributes.get('max-age'),
    String(SESSION_MAX_AGE_SECONDS),
  )
  assert.equal(parsed.attributes.get('path'), '/')
  assert.equal(parsed.attributes.has('httponly'), true)
  assert.equal(parsed.attributes.get('samesite')?.toLowerCase(), 'lax')
  checks.push({
    name: `${expectedBackend} login issued shared session`,
    ok: true,
    backend: result.backend,
    status: result.status,
  })
  return `${SESSION_COOKIE_NAME}=${parsed.value}`
}

async function expectProfile(
  options,
  baseURL,
  cookie,
  expectedBackend,
  name,
  checks,
) {
  const result = await rawRequest(options, baseURL, '/api/profile', {
    method: 'GET',
    cookie,
    expectedBackend,
  })
  assert.equal(result.status, 200, `${name} status`)
  assert.equal(result.backend, expectedBackend, `${name} backend`)
  assert.equal(result.body?.username, FIXTURE_ADMIN_NAME)
  assert.equal(result.body?.email, FIXTURE_ADMIN_EMAIL)
  assert.equal(result.body?.isAdmin, 1)
  assert.equal(result.body?.isActive, true)
  assert.equal('password' in (result.body || {}), false)
  checks.push({
    name,
    ok: true,
    backend: result.backend,
    status: result.status,
  })
  return canonicalize(result.body)
}

async function expectSessionUser(
  options,
  baseURL,
  cookie,
  expectedBackend,
  name,
  checks,
) {
  const result = await rawRequest(options, baseURL, '/api/_auth/session', {
    method: 'GET',
    cookie,
    expectedBackend,
  })
  assert.equal(result.status, 200, `${name} status`)
  assert.equal(result.backend, expectedBackend, `${name} backend`)
  assert.equal(result.body?.user?.username, FIXTURE_ADMIN_NAME)
  assert.equal(result.body?.user?.email, FIXTURE_ADMIN_EMAIL)
  assert.equal(result.body?.user?.isAdmin, 1)
  assert.equal(result.body?.user?.isActive, true)
  assert.equal('password' in (result.body?.user || {}), false)
  checks.push({
    name,
    ok: true,
    backend: result.backend,
    status: result.status,
  })
}

async function expectLogout(
  options,
  baseURL,
  cookie,
  expectedBackend,
  name,
  checks,
) {
  const result = await rawRequest(options, baseURL, '/api/logout', {
    method: 'GET',
    cookie,
    expectedBackend,
  })
  assert.equal(result.status, 200, `${name} status`)
  assert.equal(result.backend, expectedBackend, `${name} backend`)
  assert.deepEqual(result.body, { success: true })
  const cleared = findSetCookie(result.setCookies, SESSION_COOKIE_NAME)
  assert.ok(cleared, `${name} must clear ${SESSION_COOKIE_NAME}`)
  const parsed = parseSetCookie(cleared)
  assert.equal(parsed.value, '')
  assert.equal(parsed.attributes.get('max-age'), '0')
  assert.equal(parsed.attributes.get('path'), '/')
  checks.push({
    name,
    ok: true,
    backend: result.backend,
    status: result.status,
  })
}

async function expectSessionDelete(
  options,
  baseURL,
  cookie,
  expectedBackend,
  name,
  checks,
) {
  const result = await rawRequest(options, baseURL, '/api/_auth/session', {
    method: 'DELETE',
    cookie,
    expectedBackend,
  })
  assert.equal(result.status, 200, `${name} status`)
  assert.equal(result.backend, expectedBackend, `${name} backend`)
  assert.deepEqual(result.body, { loggedOut: true })
  const cleared = findSetCookie(result.setCookies, SESSION_COOKIE_NAME)
  assert.ok(cleared, `${name} must clear ${SESSION_COOKIE_NAME}`)
  const parsed = parseSetCookie(cleared)
  assert.equal(parsed.value, '')
  assert.equal(parsed.attributes.get('max-age'), '0')
  assert.equal(parsed.attributes.get('path'), '/')
  checks.push({
    name,
    ok: true,
    backend: result.backend,
    status: result.status,
  })
}

async function expectUnauthorizedEverywhere(options, cookie, name, checks) {
  await setProvider(options, 'node')
  const [node, go] = await Promise.all([
    rawRequest(options, options.nodeURL, '/api/profile', {
      method: 'GET',
      cookie,
      expectedBackend: 'node',
    }),
    rawRequest(options, options.goURL, '/api/profile', {
      method: 'GET',
      cookie,
      expectedBackend: 'go',
    }),
  ])
  for (const result of [node, go]) {
    assert.equal(result.status, 401, `${name} (${result.backend}) status`)
    assert.equal(result.body?.statusMessage, 'Unauthorized')
  }
  checks.push({
    name,
    ok: true,
    statuses: { node: node.status, go: go.status },
  })
}

async function switchProvider(options, provider, checks) {
  const result = await setProvider(options, provider)
  assert.equal(result?.value, provider)
  checks.push({
    name: `switch API provider to ${provider}`,
    ok: true,
    backend: 'node',
    status: 200,
  })
}

async function readProvider(options) {
  const result = await controlRequest(options, {
    method: 'GET',
    path: PROVIDER_SETTING_PATH,
  })
  return result.body?.value === 'go' ? 'go' : 'node'
}

async function setProvider(options, provider) {
  const result = await controlRequest(options, {
    method: 'PUT',
    path: PROVIDER_SETTING_PATH,
    body: { value: provider },
  })
  return result.body
}

async function controlRequest(options, { method, path, body }) {
  const result = await rawRequest(options, options.nodeURL, path, {
    method,
    cookie: options.adminCookie,
    body,
    expectedBackend: 'node',
  })
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `${method} ${path} returned ${result.status}: ${result.body?.statusMessage || result.text}`,
    )
  }
  assert.equal(result.backend, 'node', `${method} ${path} control owner`)
  return result
}

async function rawRequest(
  options,
  baseURL,
  path,
  { method = 'GET', cookie, body, expectedBackend } = {},
) {
  const headers = {
    Accept: 'application/json',
    'Accept-Language': 'en',
    'X-Request-Id': `dual-identity-${randomUUID()}`,
  }
  if (cookie) headers.Cookie = cookie
  const payload = body === undefined ? undefined : JSON.stringify(body)
  if (payload !== undefined) headers['Content-Type'] = 'application/json'
  const response = await options.fetchImpl(joinBackendURL(baseURL, path), {
    method,
    headers,
    body: payload,
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs),
  })
  const text = await response.text()
  const result = {
    status: response.status,
    backend: response.headers.get('x-chronoframe-backend'),
    contentType: normalizedContentType(response.headers.get('content-type')),
    setCookies: getSetCookies(response.headers),
    body: parseJSONBody(text),
    text,
  }
  if (expectedBackend !== undefined) {
    assert.equal(result.backend, expectedBackend, `${method} ${path} backend`)
  }
  return result
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie()
  }
  const combined = headers.get('set-cookie')
  if (!combined) return []
  return combined.split(/,(?=\s*[^;,=\s]+=[^;,]*)/).map((value) => value.trim())
}

function findSetCookie(cookies, name) {
  return cookies.find((cookie) =>
    cookie.toLowerCase().startsWith(`${name.toLowerCase()}=`),
  )
}

function parseSetCookie(cookie) {
  const parts = String(cookie)
    .split(';')
    .map((part) => part.trim())
  const first = parts.shift() || ''
  const separator = first.indexOf('=')
  const attributes = new Map()
  for (const part of parts) {
    const attributeSeparator = part.indexOf('=')
    if (attributeSeparator < 0) {
      attributes.set(part.toLowerCase(), '')
    } else {
      attributes.set(
        part.slice(0, attributeSeparator).toLowerCase(),
        part.slice(attributeSeparator + 1),
      )
    }
  }
  return {
    name: separator < 0 ? first : first.slice(0, separator),
    value: separator < 0 ? '' : first.slice(separator + 1),
    attributes,
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
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

function normalizeRequiredCookie(value) {
  const cookie = String(value || '').trim()
  if (!cookie) throw new Error('admin-cookie must not be empty')
  return cookie
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
  const result = await verifyDualIdentity(parseIdentityVerifierOptions())
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.stack || error.message)
    process.exitCode = 1
  })
}

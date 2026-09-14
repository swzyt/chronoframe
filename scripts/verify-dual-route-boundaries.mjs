#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import {
  canonicalize,
  joinBackendURL,
  removeJSONPointer,
} from './compare-backends.mjs'
import { FIXTURE_SESSION_TOKEN } from './seed-dual-backend-fixture.mjs'
import {
  PROVIDER_SETTING_PATH,
  buildRouteSurfaceProbePlan,
  loadGoRouteSurfaceRoutes,
} from './verify-dual-route-surface.mjs'

export const DEFAULT_ROUTE_BOUNDARIES_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_ROUTE_BOUNDARIES_ADMIN_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`

const ROUTE_BODY_NORMALIZERS = new Map([
  ['identity.session.read', ['/id']],
  ['photos.status', ['/timestamp']],
  ['queue.stats', ['/timestamp', '/pool/workers/*/uptime']],
  ['settings.public.read', ['/timestamp']],
  [
    'system.stats',
    ['/timestamp', '/uptime', '/memory/used', '/workerPool/workers/*/uptime'],
  ],
])

export function parseRouteBoundariesVerifierOptions(
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
      ![
        '--base',
        '--node',
        '--go',
        '--admin-cookie',
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
        : DEFAULT_ROUTE_BOUNDARIES_BASE_URL),
  )
  const nodeURL = normalizeBaseURL(
    values.get('--node') || environment.CFRAME_DUAL_NODE_URL || base,
  )
  const goURL = normalizeBaseURL(
    values.get('--go') || environment.CFRAME_DUAL_GO_URL || `${base}/__lab/go`,
  )
  const adminCookie = normalizeRequiredCookie(
    values.get('--admin-cookie') ||
      environment.CFRAME_DUAL_ADMIN_COOKIE ||
      environment.CFRAME_DUAL_COOKIE ||
      DEFAULT_ROUTE_BOUNDARIES_ADMIN_COOKIE,
  )
  const timeoutMs = parsePositiveSafeInteger(
    values.get('--timeout-ms') || environment.CFRAME_DUAL_TIMEOUT_MS || 5_000,
    'timeout-ms',
  )
  if (timeoutMs > 60_000) {
    throw new Error('timeout-ms must be 60000 or less')
  }

  return {
    base,
    nodeURL,
    goURL,
    adminCookie,
    timeoutMs,
  }
}

export function buildRouteBoundaryCases(routes = loadGoRouteSurfaceRoutes()) {
  return Object.freeze(
    buildRouteSurfaceProbePlan(routes).map((step) =>
      Object.freeze({
        name: `route boundary parity: ${step.routeId}`,
        routeId: step.routeId,
        method: step.method,
        path: step.path,
        bodyNormalizers: Object.freeze([
          ...(ROUTE_BODY_NORMALIZERS.get(step.routeId) || []),
        ]),
      }),
    ),
  )
}

export async function verifyDualRouteBoundaries({
  nodeURL,
  goURL,
  adminCookie = DEFAULT_ROUTE_BOUNDARIES_ADMIN_COOKIE,
  timeoutMs = 5_000,
  routes = loadGoRouteSurfaceRoutes(),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function')
  }
  if (!nodeURL || !goURL) {
    throw new Error('nodeURL and goURL are required')
  }

  const normalized = {
    nodeURL: normalizeBaseURL(nodeURL),
    goURL: normalizeBaseURL(goURL),
    adminCookie: normalizeRequiredCookie(adminCookie),
    timeoutMs: parsePositiveSafeInteger(timeoutMs, 'timeout-ms'),
  }
  const results = []
  const restoreProvider = await forceNodeProvider({
    nodeURL: normalized.nodeURL,
    adminCookie: normalized.adminCookie,
    timeoutMs: normalized.timeoutMs,
    fetchImpl,
  })

  try {
    for (const testCase of buildRouteBoundaryCases(routes)) {
      results.push(
        await compareRouteBoundaryCase({
          ...normalized,
          testCase,
          fetchImpl,
        }),
      )
    }
  } finally {
    await restoreProvider()
  }

  return {
    ok: results.every((result) => result.equal),
    total: results.length,
    failed: results.filter((result) => !result.equal).length,
    nodeURL: normalized.nodeURL,
    goURL: normalized.goURL,
    results,
  }
}

export async function compareRouteBoundaryCase({
  nodeURL,
  goURL,
  timeoutMs = 5_000,
  testCase,
  fetchImpl = globalThis.fetch,
}) {
  const requestId = `dual-route-boundary-${randomUUID()}`
  const [nodeResult, goResult] = await Promise.all([
    executeBoundaryRequest({
      baseURL: nodeURL,
      expectedBackend: 'node',
      timeoutMs,
      requestId,
      testCase,
      fetchImpl,
    }),
    executeBoundaryRequest({
      baseURL: goURL,
      expectedBackend: 'go',
      timeoutMs,
      requestId,
      testCase,
      fetchImpl,
    }),
  ])
  const differences = validateRouteBoundaryComparison(
    testCase,
    nodeResult,
    goResult,
  )
  return {
    equal: differences.length === 0,
    name: testCase.name,
    routeId: testCase.routeId,
    method: testCase.method,
    path: testCase.path,
    node: summarizeBoundaryResult(nodeResult),
    go: summarizeBoundaryResult(goResult),
    differences,
  }
}

export function validateRouteBoundaryComparison(
  testCase,
  nodeResult,
  goResult,
) {
  const differences = []
  for (const [backendName, result] of [
    ['node', nodeResult],
    ['go', goResult],
  ]) {
    if (result.fetchError) {
      differences.push({
        field: `${backendName}.fetch`,
        message: result.fetchError,
      })
      continue
    }
    if (result.status > 499) {
      differences.push({
        field: `${backendName}.status`,
        expected: '<= 499',
        actual: result.status,
      })
    }
    if (result.backend !== backendName) {
      differences.push({
        field: `${backendName}.headers.x-chronoframe-backend`,
        expected: backendName,
        actual: result.backend,
      })
    }
    if (result.requestId !== result.responseRequestId) {
      differences.push({
        field: `${backendName}.headers.x-request-id`,
        expected: result.requestId,
        actual: result.responseRequestId,
      })
    }
  }

  if (nodeResult.fetchError || goResult.fetchError) return differences

  if (nodeResult.status !== goResult.status) {
    differences.push({
      field: 'status',
      node: nodeResult.status,
      go: goResult.status,
    })
  }
  if (nodeResult.contentType !== goResult.contentType) {
    differences.push({
      field: 'headers.content-type',
      node: nodeResult.contentType,
      go: goResult.contentType,
    })
  }
  if (nodeResult.location !== goResult.location) {
    differences.push({
      field: 'headers.location',
      node: nodeResult.location,
      go: goResult.location,
    })
  }
  if (nodeResult.setCookie !== goResult.setCookie) {
    differences.push({
      field: 'headers.set-cookie',
      node: nodeResult.setCookie ? 'present' : 'absent',
      go: goResult.setCookie ? 'present' : 'absent',
    })
  }

  const nodeBody = comparableBoundaryBody(testCase, nodeResult)
  const goBody = comparableBoundaryBody(testCase, goResult)
  if (JSON.stringify(nodeBody) !== JSON.stringify(goBody)) {
    differences.push({
      field: 'body',
      node: nodeBody,
      go: goBody,
    })
  }
  return differences
}

export function normalizeRouteBoundaryBody(body, normalizers = []) {
  const clone = cloneJSON(body)
  normalizeDynamicDiagnosticFields(clone)
  for (const pointer of normalizers) {
    removeJSONPointer(clone, pointer)
  }
  return canonicalize(clone)
}

async function executeBoundaryRequest({
  baseURL,
  expectedBackend,
  timeoutMs,
  requestId,
  testCase,
  fetchImpl,
}) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en',
    'X-Request-Id': requestId,
  }

  try {
    const response = await fetchImpl(joinBackendURL(baseURL, testCase.path), {
      method: testCase.method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const bodyText = testCase.method === 'HEAD' ? '' : await response.text()
    return {
      expectedBackend,
      status: response.status,
      backend: response.headers.get('x-chronoframe-backend'),
      contentType: normalizedContentType(response.headers.get('content-type')),
      location: normalizeLocation(response.headers.get('location')),
      setCookie: response.headers.has('set-cookie'),
      requestId,
      responseRequestId: response.headers.get('x-request-id'),
      body: parseResponseBody(bodyText),
      bodyPreview: bodyText.slice(0, 240),
    }
  } catch (error) {
    return {
      expectedBackend,
      requestId,
      fetchError: error instanceof Error ? error.message : String(error),
    }
  }
}

async function forceNodeProvider({
  nodeURL,
  adminCookie,
  timeoutMs,
  fetchImpl,
}) {
  const current = await executeControlRequest({
    baseURL: nodeURL,
    method: 'GET',
    adminCookie,
    timeoutMs,
    fetchImpl,
  })
  const originalProvider = current?.value === 'go' ? 'go' : 'node'
  if (originalProvider !== 'node') {
    await executeControlRequest({
      baseURL: nodeURL,
      method: 'PUT',
      adminCookie,
      timeoutMs,
      fetchImpl,
      body: { value: 'node' },
    })
  }

  return async () => {
    if (originalProvider === 'node') return
    await executeControlRequest({
      baseURL: nodeURL,
      method: 'PUT',
      adminCookie,
      timeoutMs,
      fetchImpl,
      body: { value: originalProvider },
    })
  }
}

async function executeControlRequest({
  baseURL,
  method,
  adminCookie,
  timeoutMs,
  fetchImpl,
  body,
}) {
  const headers = {
    Accept: 'application/json',
    'Accept-Language': 'en',
    Cookie: adminCookie,
    'X-Request-Id': `dual-route-boundary-control-${randomUUID()}`,
  }
  const payload = body === undefined ? undefined : JSON.stringify(body)
  if (payload !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetchImpl(joinBackendURL(baseURL, PROVIDER_SETTING_PATH), {
    method,
    headers,
    body: payload,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `Route boundary control request failed: ${method} ${PROVIDER_SETTING_PATH} returned ${response.status}`,
    )
  }
  return parseResponseBody(text)
}

function comparableBoundaryBody(testCase, result) {
  return normalizeRouteBoundaryBody(
    result.body,
    testCase.bodyNormalizers || [],
  )
}

function summarizeBoundaryResult(result) {
  return {
    status: result.status,
    backend: result.backend,
    contentType: result.contentType,
    location: result.location,
    setCookie: result.setCookie,
    body: result.body,
    bodyPreview: result.bodyPreview,
    fetchError: result.fetchError,
  }
}

function normalizeDynamicDiagnosticFields(value) {
  if (Array.isArray(value)) {
    value.forEach((item) => normalizeDynamicDiagnosticFields(item))
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const key of Object.keys(value)) {
    if (key === 'url' || key === 'stack') {
      delete value[key]
      continue
    }
    normalizeDynamicDiagnosticFields(value[key])
  }
}

function parseResponseBody(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function cloneJSON(value) {
  if (value === undefined) return undefined
  if (value === null) return null
  return JSON.parse(JSON.stringify(value))
}

function normalizeLocation(value) {
  if (!value) return ''
  try {
    const url = new URL(value, 'http://route-boundary.local')
    return `${url.pathname}${url.search}`
  } catch {
    return value
  }
}

function normalizedContentType(value) {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || ''
}

function normalizeBaseURL(value) {
  const url = new URL(String(value))
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('base URL must use http(s)')
  }
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/g, '') || '/'
  return url.toString().replace(/\/$/g, '')
}

function normalizeRequiredCookie(value) {
  const cookie = String(value || '').trim()
  if (!cookie) throw new Error('admin-cookie must not be empty')
  if (/[\r\n]/.test(cookie)) {
    throw new Error('admin-cookie must be a single header')
  }
  return cookie
}

function parsePositiveSafeInteger(value, label) {
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return parsed
}

async function main() {
  const options = parseRouteBoundariesVerifierOptions()
  const result = await verifyDualRouteBoundaries(options)
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

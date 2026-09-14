#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { FIXTURE_SESSION_TOKEN } from './seed-dual-backend-fixture.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const ROUTE_CONTRACT_PATH = resolve(REPO_ROOT, 'backend/contracts/routes.yaml')

export const DEFAULT_ROUTE_SURFACE_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_ROUTE_SURFACE_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`
export const PROVIDER_SETTING_PATH =
  '/api/system/settings/system/backend.readProvider'

const PARAMETER_SAMPLES = {
  albumId: '999999999',
  id: '999999999',
  key: 'dual-surface-missing.jpg',
  path: 'dual-surface-missing.jpg',
  photoId: 'dual-surface-missing-photo',
  taskId: '999999999',
  thumbnailUrl: 'dual-surface-missing.jpg',
  token: 'dual-surface-invalid-token',
}

const SAMPLE_PATH_OVERRIDES = {
  'settings.key.read': '/api/system/settings/app/slogan',
  'settings.key.update': '/api/system/settings/app/slogan',
  'settings.namespace.read': '/api/system/settings/app',
  'photos.upload':
    '/api/photos/upload?key=dual-surface%2Fusers%2F910001%2Fprobe.jpg',
}

export function parseRouteSurfaceVerifierOptions(
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
    if (!['--base', '--lab-base', '--cookie', '--timeout-ms'].includes(arg)) {
      throw new Error(`Unknown option: ${arg}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`)
    }
    values.set(arg, value)
    index += 1
  }

  const base =
    values.get('--base') ||
    environment.CFRAME_DUAL_BASE_URL ||
    (environment.CFRAME_DUAL_PORT
      ? `http://127.0.0.1:${environment.CFRAME_DUAL_PORT}`
      : DEFAULT_ROUTE_SURFACE_BASE_URL)
  const cookie =
    values.get('--cookie') ||
    environment.CFRAME_DUAL_COOKIE ||
    DEFAULT_ROUTE_SURFACE_COOKIE
  const labBase =
    values.get('--lab-base') || environment.CFRAME_DUAL_GO_LAB_BASE_URL || ''
  const timeoutMs = parsePositiveInteger(
    values.get('--timeout-ms') || environment.CFRAME_DUAL_TIMEOUT_MS || 5_000,
    'timeout-ms',
  )
  if (timeoutMs > 60_000) {
    throw new Error('timeout-ms must be 60000 or less')
  }

  return {
    base: normalizeBaseURL(base),
    labBase: labBase ? normalizeBaseURL(labBase) : '',
    cookie: normalizeCookie(cookie),
    timeoutMs,
  }
}

export function parsePositiveInteger(value, label) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return number
}

export function normalizeBaseURL(value) {
  const url = new URL(String(value))
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('base must be an http(s) URL')
  }
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

export function normalizeCookie(value) {
  const cookie = String(value || '').trim()
  if (!cookie) throw new Error('cookie must not be empty')
  if (/[\r\n]/.test(cookie)) throw new Error('cookie must be a single header')
  return cookie
}

export function loadGoRouteSurfaceRoutes(
  source = readFileSync(ROUTE_CONTRACT_PATH, 'utf8'),
) {
  const contract = JSON.parse(source)
  return contract.routes
    .filter((route) => route.sourceType !== 'virtual' && route.maturity?.go)
    .map((route) =>
      Object.freeze({
        id: route.id,
        method: route.method,
        path: route.path,
        auth: route.auth,
        sideEffect: route.sideEffect,
      }),
    )
}

export function buildRouteSurfaceProbePlan(
  routes = loadGoRouteSurfaceRoutes(),
  { surface = 'gateway' } = {},
) {
  return Object.freeze(
    routes.map((route) =>
      Object.freeze({
        name: `probe Go ${surface} route surface: ${route.id}`,
        routeId: route.id,
        surface,
        method: route.method,
        path: samplePathForRoute(route),
        expectedBackend: 'go',
        maxStatus: 499,
        sendCookie: false,
      }),
    ),
  )
}

export function samplePathForRoute(route) {
  if (Object.hasOwn(SAMPLE_PATH_OVERRIDES, route.id)) {
    return SAMPLE_PATH_OVERRIDES[route.id]
  }
  return route.path.replaceAll(/\{([^}]+)\}/g, (_match, rawName) => {
    const name = String(rawName).replace(/\.\.\.$/, '')
    return PARAMETER_SAMPLES[name] || `dual-surface-${name}`
  })
}

export async function verifyDualRouteSurface({
  base = DEFAULT_ROUTE_SURFACE_BASE_URL,
  labBase,
  cookie = DEFAULT_ROUTE_SURFACE_COOKIE,
  timeoutMs = 5_000,
  fetchImpl = globalThis.fetch,
  routes = loadGoRouteSurfaceRoutes(),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function')
  }
  const normalized = {
    base: normalizeBaseURL(base),
    labBase: normalizeBaseURL(
      labBase || joinURL(normalizeBaseURL(base), '/__lab/go'),
    ),
    cookie: normalizeCookie(cookie),
    timeoutMs: parsePositiveInteger(timeoutMs, 'timeout-ms'),
  }
  const summary = {
    ok: false,
    base: normalized.base,
    labBase: normalized.labBase,
    routeCount: routes.length,
    surfaceCounts: {
      gateway: routes.length,
      lab: routes.length,
    },
    probeCount: routes.length * 2,
    checks: [],
  }
  let restoreNeeded = false

  try {
    const switchToGo = await executeSurfaceRequest({
      ...normalized,
      fetchImpl,
      step: switchProviderStep('go'),
    })
    summary.checks.push(switchToGo)
    restoreNeeded = switchToGo.status >= 200 && switchToGo.status < 300
    const switchErrors = validateExactBackendStep(
      switchProviderStep('go'),
      switchToGo,
    )
    if (switchErrors.length > 0) {
      summary.errors = switchErrors
      return summary
    }

    const controlPlane = await executeSurfaceRequest({
      ...normalized,
      fetchImpl,
      step: controlPlaneStep(),
    })
    summary.checks.push(controlPlane)
    const controlErrors = validateExactBackendStep(
      controlPlaneStep(),
      controlPlane,
    )
    if (controlErrors.length > 0) {
      summary.errors = controlErrors
      return summary
    }

    const errors = []
    for (const step of buildRouteSurfaceProbePlan(routes, {
      surface: 'gateway',
    })) {
      const result = await executeSurfaceRequest({
        ...normalized,
        base: normalized.base,
        fetchImpl,
        step,
      })
      summary.checks.push(result)
      errors.push(...validateSurfaceProbe(step, result))
    }
    for (const step of buildRouteSurfaceProbePlan(routes, { surface: 'lab' })) {
      const result = await executeSurfaceRequest({
        ...normalized,
        base: normalized.labBase,
        fetchImpl,
        step,
      })
      summary.checks.push(result)
      errors.push(...validateSurfaceProbe(step, result))
    }
    if (errors.length > 0) {
      summary.errors = errors
      return summary
    }

    summary.ok = true
    return summary
  } catch (error) {
    summary.errors = [
      {
        name: 'dual route surface verifier',
        message: error instanceof Error ? error.message : String(error),
      },
    ]
    return summary
  } finally {
    if (restoreNeeded) {
      try {
        const restore = await executeSurfaceRequest({
          ...normalized,
          fetchImpl,
          step: switchProviderStep('node'),
        })
        summary.checks.push(restore)
        const restoreErrors = validateExactBackendStep(
          switchProviderStep('node'),
          restore,
        )
        summary.restore = {
          ok: restoreErrors.length === 0,
          backend: restore.backend,
          status: restore.status,
        }
        if (restoreErrors.length > 0) {
          summary.ok = false
          summary.restoreErrors = restoreErrors
        }
      } catch (error) {
        summary.ok = false
        summary.restore = {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    }
  }
}

export function validateExactBackendStep(step, result) {
  const errors = []
  if (result.fetchError) {
    errors.push({
      name: step.name,
      field: 'fetch',
      message: result.fetchError,
    })
    return errors
  }
  if (result.status !== step.expectedStatus) {
    errors.push({
      name: step.name,
      field: 'status',
      expected: step.expectedStatus,
      actual: result.status,
    })
  }
  if (result.backend !== step.expectedBackend) {
    errors.push({
      name: step.name,
      field: 'headers.x-chronoframe-backend',
      expected: step.expectedBackend,
      actual: result.backend,
    })
  }
  if (
    Object.hasOwn(step, 'expectedValue') &&
    result.body?.value !== step.expectedValue
  ) {
    errors.push({
      name: step.name,
      field: 'body.value',
      expected: step.expectedValue,
      actual: result.body?.value,
    })
  }
  return errors
}

export function validateSurfaceProbe(step, result) {
  const errors = []
  if (result.fetchError) {
    errors.push({
      name: step.name,
      routeId: step.routeId,
      field: 'fetch',
      message: result.fetchError,
    })
    return errors
  }
  if (result.backend !== step.expectedBackend) {
    errors.push({
      name: step.name,
      routeId: step.routeId,
      field: 'headers.x-chronoframe-backend',
      expected: step.expectedBackend,
      actual: result.backend,
      status: result.status,
      path: step.path,
      method: step.method,
    })
  }
  if (result.status > step.maxStatus) {
    errors.push({
      name: step.name,
      routeId: step.routeId,
      field: 'status',
      expected: `<= ${step.maxStatus}`,
      actual: result.status,
      path: step.path,
      method: step.method,
      bodyPreview: result.bodyPreview,
    })
  }
  return errors
}

async function executeSurfaceRequest({
  base,
  cookie,
  timeoutMs,
  fetchImpl,
  step,
}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'X-Request-Id': `dual-route-surface-${randomUUID()}`,
  }
  if (step.sendCookie) {
    headers.Cookie = cookie
  }
  let body
  if (Object.hasOwn(step, 'body')) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(step.body)
  }

  try {
    const response = await fetchImpl(joinURL(base, step.path), {
      method: step.method,
      headers,
      body,
      redirect: 'manual',
      signal: controller.signal,
    })
    const bodyText = step.method === 'HEAD' ? '' : await response.text()
    return {
      name: step.name,
      routeId: step.routeId,
      method: step.method,
      path: step.path,
      status: response.status,
      backend: response.headers.get('x-chronoframe-backend'),
      contentType: normalizeContentType(response.headers.get('content-type')),
      requestId: headers['X-Request-Id'],
      responseRequestId: response.headers.get('x-request-id'),
      body: parseJSONBody(bodyText),
      bodyPreview: bodyText.slice(0, 240),
    }
  } catch (error) {
    return {
      name: step.name,
      routeId: step.routeId,
      method: step.method,
      path: step.path,
      fetchError: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

function switchProviderStep(provider) {
  return {
    name: `switch provider to ${provider}`,
    method: 'PUT',
    path: PROVIDER_SETTING_PATH,
    expectedStatus: 200,
    expectedBackend: 'node',
    expectedValue: provider,
    sendCookie: true,
    body: { value: provider },
  }
}

function controlPlaneStep() {
  return {
    ...switchProviderStep('go'),
    name: 'provider control-plane write remains Node-owned while Go is selected',
  }
}

function joinURL(base, path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${base}${normalizedPath}`
}

function normalizeContentType(value) {
  return String(value || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
}

function parseJSONBody(value) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summary = await verifyDualRouteSurface(
    parseRouteSurfaceVerifierOptions(),
  )
  console.log(JSON.stringify(summary, null, 2))
  if (!summary.ok) process.exitCode = 1
}

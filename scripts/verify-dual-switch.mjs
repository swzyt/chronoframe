#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { FIXTURE_SESSION_TOKEN } from './seed-dual-backend-fixture.mjs'

export const DEFAULT_SWITCH_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_SWITCH_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`
export const PROVIDER_SETTING_PATH =
  '/api/system/settings/system/backend.readProvider'
export const PUBLIC_SETTINGS_PATH = '/api/system/settings/all'
export const SLOGAN_SETTING_PATH = '/api/system/settings/app/slogan'

const PROVIDERS = new Set(['node', 'go'])

export function parseSwitchVerifierOptions(
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
        '--go-base',
        '--cookie',
        '--iterations',
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

  const base =
    values.get('--base') ||
    environment.CFRAME_DUAL_BASE_URL ||
    (environment.CFRAME_DUAL_PORT
      ? `http://127.0.0.1:${environment.CFRAME_DUAL_PORT}`
      : DEFAULT_SWITCH_BASE_URL)
  const cookie =
    values.get('--cookie') ||
    environment.CFRAME_DUAL_COOKIE ||
    DEFAULT_SWITCH_COOKIE
  const goBase =
    values.get('--go-base') || environment.CFRAME_DUAL_GO_BASE_URL || ''
  const iterations = parsePositiveInteger(
    values.get('--iterations') ||
      environment.CFRAME_DUAL_SWITCH_ITERATIONS ||
      1,
    'iterations',
  )
  const timeoutMs = parsePositiveInteger(
    values.get('--timeout-ms') || environment.CFRAME_DUAL_TIMEOUT_MS || 5_000,
    'timeout-ms',
  )

  if (iterations > 25) {
    throw new Error('iterations must be 25 or less')
  }
  if (timeoutMs > 60_000) {
    throw new Error('timeout-ms must be 60000 or less')
  }

  return {
    base: normalizeBaseURL(base),
    goBase: goBase ? normalizeBaseURL(goBase) : '',
    cookie: normalizeCookie(cookie),
    iterations,
    timeoutMs,
  }
}

export function buildSwitchVerificationPlan(iterations = 1) {
  const count = parsePositiveInteger(iterations, 'iterations')
  const steps = []
  for (let iteration = 1; iteration <= count; iteration += 1) {
    steps.push(
      switchProviderStep(iteration, 'go'),
      readProviderStep(iteration, 'go'),
      readPublicSettingsStep(iteration, 'go'),
      writeSloganStep(iteration, 'go', `dual-switch-go-write-${iteration}`),
      switchProviderStep(iteration, 'node'),
      readProviderStep(iteration, 'node'),
      readPublicSettingsStep(iteration, 'node'),
      readSloganStep(iteration, 'node', `dual-switch-go-write-${iteration}`),
    )
  }
  return Object.freeze(steps.map((step) => Object.freeze(step)))
}

export async function verifyDualSwitch({
  base = DEFAULT_SWITCH_BASE_URL,
  cookie = DEFAULT_SWITCH_COOKIE,
  iterations = 1,
  timeoutMs = 5_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function')
  }
  const normalized = {
    base: normalizeBaseURL(base),
    goBase: '',
    cookie: normalizeCookie(cookie),
    iterations: parsePositiveInteger(iterations, 'iterations'),
    timeoutMs: parsePositiveInteger(timeoutMs, 'timeout-ms'),
  }
  if (arguments[0]?.goBase) {
    normalized.goBase = normalizeBaseURL(arguments[0].goBase)
  }
  const summary = {
    ok: false,
    base: normalized.base,
    ...(normalized.goBase ? { goBase: normalized.goBase } : {}),
    iterations: normalized.iterations,
    checks: [],
  }
  let restoreNeeded = false
  let originalSlogan
  let restoreSloganNeeded = false

  try {
    const initialProvider = await executeStep({
      ...normalized,
      step: switchProviderStep('initial', 'node'),
      fetchImpl,
    })
    summary.checks.push(initialProvider)
    const initialProviderErrors = validateStepResult(
      switchProviderStep('initial', 'node'),
      initialProvider,
    )
    if (initialProviderErrors.length > 0) {
      summary.errors = initialProviderErrors
      return summary
    }

    const originalSloganResult = await executeStep({
      ...normalized,
      step: readSloganStep('initial', 'node'),
      fetchImpl,
    })
    summary.checks.push(originalSloganResult)
    const originalSloganErrors = validateStepResult(
      readSloganStep('initial', 'node'),
      originalSloganResult,
    )
    if (originalSloganErrors.length > 0) {
      summary.errors = originalSloganErrors
      return summary
    }
    originalSlogan = originalSloganResult.body?.value

    if (normalized.goBase) {
      const directGoControl = directGoSwitchProviderStep('direct-go-control')
      const directGoControlResult = await executeStep({
        ...normalized,
        step: directGoControl,
        fetchImpl,
      })
      summary.checks.push(directGoControlResult)
      if (
        directGoControlResult.status >= 200 &&
        directGoControlResult.status < 300
      ) {
        restoreNeeded = true
      }
      const directGoControlErrors = validateStepResult(
        directGoControl,
        directGoControlResult,
      )
      if (directGoControlErrors.length > 0) {
        summary.errors = directGoControlErrors
        return summary
      }

      const directGoReadBack = readProviderStep('direct-go-control', 'go')
      const directGoReadBackResult = await executeStep({
        ...normalized,
        step: directGoReadBack,
        fetchImpl,
      })
      summary.checks.push(directGoReadBackResult)
      const directGoReadBackErrors = validateStepResult(
        directGoReadBack,
        directGoReadBackResult,
      )
      if (directGoReadBackErrors.length > 0) {
        summary.errors = directGoReadBackErrors
        return summary
      }

      const directGoSloganValue = 'dual-switch-direct-go-write'
      const directGoWriteSlogan = directGoWriteSloganStep(
        'direct-go-control',
        directGoSloganValue,
      )
      const directGoWriteSloganResult = await executeStep({
        ...normalized,
        step: directGoWriteSlogan,
        fetchImpl,
      })
      summary.checks.push(directGoWriteSloganResult)
      restoreSloganNeeded = true
      const directGoWriteSloganErrors = validateStepResult(
        directGoWriteSlogan,
        directGoWriteSloganResult,
      )
      if (directGoWriteSloganErrors.length > 0) {
        summary.errors = directGoWriteSloganErrors
        return summary
      }

      const nodeAfterDirectGo = switchProviderStep('direct-go-control', 'node')
      const nodeAfterDirectGoResult = await executeStep({
        ...normalized,
        step: nodeAfterDirectGo,
        fetchImpl,
      })
      summary.checks.push(nodeAfterDirectGoResult)
      if (
        nodeAfterDirectGoResult.status >= 200 &&
        nodeAfterDirectGoResult.status < 300
      ) {
        restoreNeeded = false
      }
      const nodeAfterDirectGoErrors = validateStepResult(
        nodeAfterDirectGo,
        nodeAfterDirectGoResult,
      )
      if (nodeAfterDirectGoErrors.length > 0) {
        summary.errors = nodeAfterDirectGoErrors
        return summary
      }

      const nodeReadsDirectGoSlogan = readSloganStep(
        'direct-go-control',
        'node',
        directGoSloganValue,
      )
      const nodeReadsDirectGoSloganResult = await executeStep({
        ...normalized,
        step: nodeReadsDirectGoSlogan,
        fetchImpl,
      })
      summary.checks.push(nodeReadsDirectGoSloganResult)
      const nodeReadsDirectGoSloganErrors = validateStepResult(
        nodeReadsDirectGoSlogan,
        nodeReadsDirectGoSloganResult,
      )
      if (nodeReadsDirectGoSloganErrors.length > 0) {
        summary.errors = nodeReadsDirectGoSloganErrors
        return summary
      }
    }

    for (const step of buildSwitchVerificationPlan(normalized.iterations)) {
      const result = await executeStep({
        ...normalized,
        step,
        fetchImpl,
      })
      summary.checks.push(result)

      if (
        step.kind === 'switch' &&
        step.provider === 'go' &&
        result.status >= 200 &&
        result.status < 300
      ) {
        restoreNeeded = true
      }
      if (
        step.kind === 'switch' &&
        step.provider === 'node' &&
        result.status >= 200 &&
        result.status < 300
      ) {
        restoreNeeded = false
      }
      if (step.kind === 'write-slogan-go') {
        restoreSloganNeeded = true
      }

      const errors = validateStepResult(step, result)
      if (errors.length > 0) {
        summary.errors = errors
        return summary
      }
    }

    summary.ok = true
    return summary
  } catch (error) {
    summary.errors = [
      {
        name: 'dual switch verifier',
        message: error instanceof Error ? error.message : String(error),
      },
    ]
    return summary
  } finally {
    if (restoreNeeded) {
      const restore = restoreNodeStep()
      try {
        const restoreResult = await executeStep({
          ...normalized,
          step: restore,
          fetchImpl,
        })
        summary.checks.push(restoreResult)
        const errors = validateStepResult(restore, restoreResult)
        if (errors.length > 0) {
          summary.ok = false
          summary.restoreErrors = errors
        }
      } catch (error) {
        summary.ok = false
        summary.restoreErrors = [
          {
            name: restore.name,
            message: error instanceof Error ? error.message : String(error),
          },
        ]
      }
    }
    if (restoreSloganNeeded) {
      const restoreSlogan = writeSloganStep('restore', 'node', originalSlogan)
      try {
        const restoreSloganResult = await executeStep({
          ...normalized,
          step: restoreSlogan,
          fetchImpl,
        })
        summary.checks.push(restoreSloganResult)
        const errors = validateStepResult(restoreSlogan, restoreSloganResult)
        if (errors.length > 0) {
          summary.ok = false
          summary.restoreErrors = [...(summary.restoreErrors || []), ...errors]
        }
      } catch (error) {
        summary.ok = false
        summary.restoreErrors = [
          ...(summary.restoreErrors || []),
          {
            name: restoreSlogan.name,
            message: error instanceof Error ? error.message : String(error),
          },
        ]
      }
    }
  }
}

export function validateStepResult(step, result) {
  const errors = []
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
  if (result.contentType !== 'application/json') {
    errors.push({
      name: step.name,
      field: 'headers.content-type',
      expected: 'application/json',
      actual: result.contentType,
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

function switchProviderStep(iteration, provider) {
  assertProvider(provider)
  return {
    name: `iteration ${iteration}: switch provider to ${provider}`,
    kind: 'switch',
    method: 'PUT',
    path: PROVIDER_SETTING_PATH,
    provider,
    expectedStatus: 200,
    expectedBackend: 'node',
    expectedValue: provider,
    body: { value: provider },
  }
}

function directGoSwitchProviderStep(iteration) {
  return {
    ...switchProviderStep(iteration, 'go'),
    name: `iteration ${iteration}: switch provider directly through go service`,
    kind: 'direct-go-switch',
    directBackendBase: 'go',
    expectedBackend: 'go',
  }
}

function directGoWriteSloganStep(iteration, value) {
  return {
    ...writeSloganStep(iteration, 'go', value),
    name: `iteration ${iteration}: write app slogan directly through go service`,
    kind: 'direct-go-write-slogan',
    directBackendBase: 'go',
  }
}

function writeSloganStep(iteration, provider, value) {
  assertProvider(provider)
  return {
    name: `iteration ${iteration}: write app slogan through ${provider}`,
    kind: `write-slogan-${provider}`,
    method: 'PUT',
    path: SLOGAN_SETTING_PATH,
    provider,
    expectedStatus: 200,
    expectedBackend: provider,
    expectedValue: value,
    body: { value },
  }
}

function readSloganStep(iteration, provider, expectedValue) {
  assertProvider(provider)
  return {
    name: `iteration ${iteration}: read app slogan through ${provider}`,
    kind: `read-slogan-${provider}`,
    method: 'GET',
    path: SLOGAN_SETTING_PATH,
    provider,
    expectedStatus: 200,
    expectedBackend: provider,
    ...(arguments.length >= 3 ? { expectedValue } : {}),
  }
}

function readProviderStep(iteration, provider) {
  assertProvider(provider)
  return {
    name: `iteration ${iteration}: read provider setting through ${provider}`,
    kind: 'read-provider',
    method: 'GET',
    path: PROVIDER_SETTING_PATH,
    provider,
    expectedStatus: 200,
    expectedBackend: provider,
    expectedValue: provider,
  }
}

function readPublicSettingsStep(iteration, provider) {
  assertProvider(provider)
  return {
    name: `iteration ${iteration}: read public settings through ${provider}`,
    kind: 'read-public-settings',
    method: 'GET',
    path: PUBLIC_SETTINGS_PATH,
    provider,
    expectedStatus: 200,
    expectedBackend: provider,
  }
}

function restoreNodeStep() {
  return {
    ...switchProviderStep('restore', 'node'),
    name: 'restore provider to node after failed Go switch verification',
    restore: true,
  }
}

async function executeStep({
  base,
  goBase,
  cookie,
  timeoutMs,
  step,
  fetchImpl,
}) {
  const requestId = `dual-switch-${randomUUID()}`
  const headers = {
    Accept: 'application/json',
    Cookie: cookie,
    'X-Request-Id': requestId,
  }
  const options = {
    method: step.method,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  }
  if (step.body) {
    headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(step.body)
  }

  const targetBase = step.directBackendBase === 'go' ? goBase : base
  if (!targetBase) {
    throw new Error(`${step.name} requires --go-base`)
  }
  const response = await fetchImpl(
    joinSwitchURL(targetBase, step.path),
    options,
  )
  const text = await response.text()
  const contentType = normalizedContentType(
    response.headers.get('content-type'),
  )
  let body
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = { raw: text }
    }
  }

  return {
    name: step.name,
    method: step.method,
    path: step.path,
    expectedBackend: step.expectedBackend,
    status: response.status,
    backend: response.headers.get('x-chronoframe-backend'),
    contentType,
    requestId,
    responseRequestId: response.headers.get('x-request-id'),
    value: body?.value,
    body,
    restore: step.restore === true,
  }
}

function joinSwitchURL(baseURL, requestPath) {
  const base = new URL(baseURL)
  const suffix = requestPath.startsWith('/') ? requestPath : `/${requestPath}`
  base.pathname = `${base.pathname.replace(/\/+$/, '')}${suffix}`
  base.search = ''
  base.hash = ''
  return base
}

function normalizeBaseURL(rawValue) {
  const value = String(rawValue || '').trim()
  if (!value) throw new Error('base must not be empty')
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('base must be an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('base must use http or https')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function normalizeCookie(rawValue) {
  const value = String(rawValue || '').trim()
  if (!value) {
    throw new Error(
      'cookie must not be empty; seed the fixture session or pass --cookie',
    )
  }
  return value
}

function parsePositiveInteger(rawValue, name) {
  const value =
    typeof rawValue === 'number' ? rawValue : Number.parseInt(rawValue, 10)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function assertProvider(provider) {
  if (!PROVIDERS.has(provider)) {
    throw new Error(`Unknown backend provider: ${provider}`)
  }
}

function normalizedContentType(value) {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || ''
}

async function main() {
  const options = parseSwitchVerifierOptions()
  const result = await verifyDualSwitch(options)
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

#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const DEFAULT_GO_READINESS_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_GO_READINESS_DIRECT_URL = 'http://127.0.0.1:8080'
export const GO_READY_PATH = '/health/ready'
export const REQUIRED_READY_CHECKS = Object.freeze([
  'database',
  'redis',
  'mediaTools',
])

export function parseGoReadinessVerifierOptions(
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
    if (!['--base', '--go-base', '--timeout-ms'].includes(arg)) {
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
      : DEFAULT_GO_READINESS_BASE_URL)
  const goBase =
    values.get('--go-base') ||
    environment.CFRAME_DUAL_GO_DIRECT_URL ||
    DEFAULT_GO_READINESS_DIRECT_URL
  const timeoutMs = parsePositiveInteger(
    values.get('--timeout-ms') || environment.CFRAME_DUAL_TIMEOUT_MS || 5_000,
    'timeout-ms',
  )
  if (timeoutMs > 60_000) {
    throw new Error('timeout-ms must be 60000 or less')
  }

  return {
    base: normalizeBaseURL(base),
    goBase: normalizeBaseURL(goBase),
    timeoutMs,
  }
}

export async function verifyGoReadiness({
  base = DEFAULT_GO_READINESS_BASE_URL,
  goBase = DEFAULT_GO_READINESS_DIRECT_URL,
  timeoutMs = 5_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function')
  }
  const normalized = {
    base: normalizeBaseURL(base),
    goBase: normalizeBaseURL(goBase),
    timeoutMs: parsePositiveInteger(timeoutMs, 'timeout-ms'),
  }
  const summary = {
    ok: false,
    base: normalized.base,
    goBase: normalized.goBase,
    checks: [],
  }

  try {
    const probes = [
      { name: 'go readiness via gateway runtime route', base: normalized.base },
      { name: 'go readiness direct service', base: normalized.goBase },
    ]
    const errors = []
    for (const probe of probes) {
      const result = await executeReadyProbe({
        ...probe,
        timeoutMs: normalized.timeoutMs,
        fetchImpl,
      })
      summary.checks.push(result)
      errors.push(...validateReadyProbe(result))
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
        name: 'go readiness verifier',
        message: error instanceof Error ? error.message : String(error),
      },
    ]
    return summary
  }
}

export async function executeReadyProbe({ name, base, timeoutMs, fetchImpl }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const requestId = `go-readiness-${randomUUID()}`
  try {
    const response = await fetchImpl(joinURL(base, GO_READY_PATH), {
      method: 'GET',
      signal: controller.signal,
      headers: { 'X-Request-Id': requestId },
    })
    const contentType = response.headers.get('content-type') || ''
    const backend = response.headers.get('x-chronoframe-backend') || ''
    let body
    try {
      body = await response.json()
    } catch {
      body = null
    }
    return {
      name,
      path: GO_READY_PATH,
      status: response.status,
      backend,
      contentType: contentType.split(';')[0].toLowerCase(),
      body,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function validateReadyProbe(result) {
  const errors = []
  if (result.status !== 200) {
    errors.push({
      name: result.name,
      field: 'status',
      expected: 200,
      actual: result.status,
    })
  }
  if (result.backend !== 'go') {
    errors.push({
      name: result.name,
      field: 'headers.x-chronoframe-backend',
      expected: 'go',
      actual: result.backend,
    })
  }
  if (result.contentType !== 'application/json') {
    errors.push({
      name: result.name,
      field: 'headers.content-type',
      expected: 'application/json',
      actual: result.contentType,
    })
  }
  if (result.body?.status !== 'ready') {
    errors.push({
      name: result.name,
      field: 'body.status',
      expected: 'ready',
      actual: result.body?.status,
    })
  }
  for (const check of REQUIRED_READY_CHECKS) {
    if (result.body?.checks?.[check] !== 'ok') {
      errors.push({
        name: result.name,
        field: `body.checks.${check}`,
        expected: 'ok',
        actual: result.body?.checks?.[check],
      })
    }
  }
  if (!Number.isInteger(result.body?.schema?.migrationCount)) {
    errors.push({
      name: result.name,
      field: 'body.schema.migrationCount',
      expected: 'integer',
      actual: result.body?.schema?.migrationCount,
    })
  }
  if (!Number.isInteger(result.body?.schema?.latestMigrationMillis)) {
    errors.push({
      name: result.name,
      field: 'body.schema.latestMigrationMillis',
      expected: 'integer',
      actual: result.body?.schema?.latestMigrationMillis,
    })
  }
  return errors
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

export function parsePositiveInteger(value, label) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return number
}

export function joinURL(base, path) {
  const baseURL = new URL(base)
  baseURL.pathname = `${baseURL.pathname.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`
  baseURL.search = ''
  baseURL.hash = ''
  return baseURL
}

async function main() {
  const options = parseGoReadinessVerifierOptions()
  const summary = await verifyGoReadiness(options)
  console.log(JSON.stringify(summary, null, 2))
  if (!summary.ok) {
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}

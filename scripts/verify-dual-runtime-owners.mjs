#!/usr/bin/env node

export const DEFAULT_DUAL_RUNTIME_OWNER_COOKIE =
  'cf_session=Q0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0M'
export const PROVIDER_SETTING_PATH =
  '/api/system/settings/system/backend.readProvider'
export const QUEUE_STATS_PATH = '/api/queue/stats'

const OWNER_PREFIX = {
  node: 'worker-',
  go: 'go-worker-',
}

export function parseDualRuntimeOwnerVerifierOptions(
  args = process.argv.slice(2),
  environment = process.env,
) {
  const options = {
    base: `http://127.0.0.1:${environment.CFRAME_DUAL_PORT || '3000'}`,
    cookie: DEFAULT_DUAL_RUNTIME_OWNER_COOKIE,
    expectedOwner: environment.CFRAME_EXPECTED_PIPELINE_CONSUMER || 'node',
    provider: '',
    timeoutMs: 15_000,
    pollMs: 500,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--base') options.base = args[++index]
    else if (arg === '--cookie') options.cookie = args[++index]
    else if (arg === '--expected-owner') options.expectedOwner = args[++index]
    else if (arg === '--provider') options.provider = args[++index]
    else if (arg === '--timeout-ms') options.timeoutMs = Number(args[++index])
    else if (arg === '--poll-ms') options.pollMs = Number(args[++index])
    else throw new Error(`Unknown argument: ${arg}`)
  }

  options.expectedOwner = normalizeOwner(options.expectedOwner)
  if (!options.provider) options.provider = options.expectedOwner
  options.provider = normalizeOwner(options.provider)
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number')
  }
  if (!Number.isFinite(options.pollMs) || options.pollMs <= 0) {
    throw new Error('--poll-ms must be a positive number')
  }
  return options
}

export async function verifyDualRuntimeOwners(options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available')
  }

  const base = options.base.replace(/\/+$/, '')
  const checks = []
  const cleanup = []
  const errors = []

  try {
    await setProvider({
      base,
      cookie: options.cookie,
      provider: options.provider,
      fetchImpl,
      checks,
    })
    const result = await waitForRuntimeOwner({
      base,
      cookie: options.cookie,
      provider: options.provider,
      expectedOwner: options.expectedOwner,
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
      fetchImpl,
      sleep,
      checks,
    })
    errors.push(...validateRuntimeOwnerProbe(result, options.expectedOwner))
  } finally {
    try {
      await setProvider({
        base,
        cookie: options.cookie,
        provider: 'node',
        fetchImpl,
        checks,
        checkName: 'cleanup: restore provider to node',
      })
      cleanup.push({ name: 'restore provider to node', ok: true })
    } catch (error) {
      cleanup.push({
        name: 'restore provider to node',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    ok: errors.length === 0 && cleanup.every((entry) => entry.ok),
    base,
    provider: options.provider,
    expectedOwner: options.expectedOwner,
    checks,
    cleanup,
    errors,
  }
}

export function validateRuntimeOwnerProbe(result, expectedOwner) {
  const errors = []
  const prefix = OWNER_PREFIX[expectedOwner]
  const otherOwner = expectedOwner === 'go' ? 'node' : 'go'
  const otherPrefix = OWNER_PREFIX[otherOwner]
  const workers = Array.isArray(result.body?.pool?.workers)
    ? result.body.pool.workers
    : []
  const workerIds = workers.map((worker) => String(worker?.workerId || ''))
  const pool = result.body?.pool || {}

  if (result.status !== 200) {
    errors.push({
      name: result.name,
      field: 'status',
      expected: 200,
      actual: result.status,
    })
  }
  if (result.backend !== result.expectedBackend) {
    errors.push({
      name: result.name,
      field: 'headers.x-chronoframe-backend',
      expected: result.expectedBackend,
      actual: result.backend,
    })
  }
  if (pool.isActive !== true) {
    errors.push({
      name: result.name,
      field: 'body.pool.isActive',
      expected: true,
      actual: pool.isActive,
    })
  }
  if (!workerIds.some((workerId) => workerId.startsWith(prefix))) {
    errors.push({
      name: result.name,
      field: 'body.pool.workers[].workerId',
      expected: `at least one ${prefix}* worker`,
      actual: workerIds,
    })
  }
  if (workerIds.some((workerId) => workerId.startsWith(otherPrefix))) {
    errors.push({
      name: result.name,
      field: 'body.pool.workers[].workerId',
      expected: `no ${otherPrefix}* workers while ${expectedOwner} owns pipeline-consumer`,
      actual: workerIds,
    })
  }
  const configuredWorkers = Number(pool.workerCount ?? pool.totalWorkers ?? 0)
  if (!Number.isFinite(configuredWorkers) || configuredWorkers <= 0) {
    errors.push({
      name: result.name,
      field: 'body.pool.workerCount',
      expected: 'positive worker count',
      actual: pool.workerCount ?? pool.totalWorkers,
    })
  }
  return errors
}

async function waitForRuntimeOwner({
  base,
  cookie,
  provider,
  expectedOwner,
  timeoutMs,
  pollMs,
  fetchImpl,
  sleep,
  checks,
}) {
  const startedAt = Date.now()
  let lastResult = null
  while (Date.now() - startedAt <= timeoutMs) {
    const result = await readQueueStats({
      base,
      cookie,
      provider,
      fetchImpl,
      expectedBackend: provider,
    })
    checks.push(result)
    lastResult = result
    if (validateRuntimeOwnerProbe(result, expectedOwner).length === 0) {
      return result
    }
    await sleep(pollMs)
  }
  return lastResult
}

async function setProvider({
  base,
  cookie,
  provider,
  fetchImpl,
  checks,
  checkName = `switch provider to ${provider}`,
}) {
  const response = await fetchImpl(`${base}${PROVIDER_SETTING_PATH}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({ value: provider }),
  })
  const body = await readMaybeJSON(response)
  const check = {
    name: checkName,
    method: 'PUT',
    path: PROVIDER_SETTING_PATH,
    expectedBackend: 'node',
    status: response.status,
    backend: response.headers.get('x-chronoframe-backend') || null,
    contentType: response.headers.get('content-type') || null,
    body,
  }
  checks.push(check)
  if (
    response.status !== 200 ||
    check.backend !== 'node' ||
    body?.value !== provider
  ) {
    throw new Error(`Failed to switch provider to ${provider}`)
  }
}

async function readQueueStats({
  base,
  cookie,
  provider,
  fetchImpl,
  expectedBackend,
}) {
  const response = await fetchImpl(`${base}${QUEUE_STATS_PATH}`, {
    method: 'GET',
    headers: { Cookie: cookie },
  })
  return {
    name: `pipeline consumer owner via ${provider}`,
    method: 'GET',
    path: QUEUE_STATS_PATH,
    expectedBackend,
    status: response.status,
    backend: response.headers.get('x-chronoframe-backend') || null,
    contentType: response.headers.get('content-type') || null,
    body: await readMaybeJSON(response),
  }
}

async function readMaybeJSON(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function normalizeOwner(value) {
  if (value !== 'node' && value !== 'go') {
    throw new Error('runtime owner must be node or go')
  }
  return value
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verifyDualRuntimeOwners(parseDualRuntimeOwnerVerifierOptions())
    .then((result) => {
      console.log(JSON.stringify(result, null, 2))
      process.exit(result.ok ? 0 : 1)
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error))
      process.exit(1)
    })
}

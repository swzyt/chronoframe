#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { FIXTURE_SESSION_TOKEN } from './seed-dual-backend-fixture.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REQUIRED_SERVICES = ['gateway', 'go', 'node', 'redis']
const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'

export const DEFAULT_REDIS_OUTAGE_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_REDIS_OUTAGE_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`
export const DEFAULT_REDIS_OUTAGE_TIMEOUT_MS = 30_000
export const DEFAULT_REDIS_OUTAGE_REQUEST_TIMEOUT_MS = 10_000
export const DEFAULT_REDIS_OUTAGE_POLL_MS = 250
export const DEFAULT_REDIS_OUTAGE_COMPOSE_FILE = 'deploy/dual/compose.yaml'

export function parseRedisOutageVerifierOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const values = new Map()
  const allowed = new Set([
    '--base',
    '--cookie',
    '--timeout-ms',
    '--request-timeout-ms',
    '--poll-ms',
    '--compose-file',
  ])

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (!allowed.has(arg)) {
      throw new Error(
        arg.startsWith('--')
          ? `Unknown option: ${arg}`
          : `Unexpected positional argument: ${arg}`,
      )
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`)
    }
    values.set(arg, value)
    index += 1
  }

  const timeoutMs = parsePositiveInteger(
    values.get('--timeout-ms') ||
      environment.CFRAME_DUAL_REDIS_OUTAGE_TIMEOUT_MS ||
      environment.CFRAME_DUAL_TIMEOUT_MS ||
      DEFAULT_REDIS_OUTAGE_TIMEOUT_MS,
    'timeout-ms',
  )
  const requestTimeoutMs = parsePositiveInteger(
    values.get('--request-timeout-ms') ||
      environment.CFRAME_DUAL_REDIS_OUTAGE_REQUEST_TIMEOUT_MS ||
      DEFAULT_REDIS_OUTAGE_REQUEST_TIMEOUT_MS,
    'request-timeout-ms',
  )
  if (timeoutMs > 120_000) {
    throw new Error('timeout-ms must be 120000 or less')
  }
  if (requestTimeoutMs > 30_000) {
    throw new Error('request-timeout-ms must be 30000 or less')
  }

  return {
    base: normalizeLoopbackBaseURL(
      values.get('--base') ||
        environment.CFRAME_DUAL_BASE_URL ||
        (environment.CFRAME_DUAL_PORT
          ? `http://127.0.0.1:${environment.CFRAME_DUAL_PORT}`
          : DEFAULT_REDIS_OUTAGE_BASE_URL),
    ),
    cookie: normalizeRequiredString(
      values.get('--cookie') ||
        environment.CFRAME_DUAL_COOKIE ||
        DEFAULT_REDIS_OUTAGE_COOKIE,
      'cookie',
    ),
    timeoutMs,
    requestTimeoutMs,
    pollMs: parsePositiveInteger(
      values.get('--poll-ms') ||
        environment.CFRAME_DUAL_REDIS_OUTAGE_POLL_MS ||
        DEFAULT_REDIS_OUTAGE_POLL_MS,
      'poll-ms',
    ),
    composeFile: normalizeComposeFile(
      values.get('--compose-file') ||
        environment.CFRAME_DUAL_REDIS_OUTAGE_COMPOSE_FILE ||
        DEFAULT_REDIS_OUTAGE_COMPOSE_FILE,
    ),
  }
}

export async function verifyDualRedisOutage({
  base = DEFAULT_REDIS_OUTAGE_BASE_URL,
  cookie = DEFAULT_REDIS_OUTAGE_COOKIE,
  timeoutMs = DEFAULT_REDIS_OUTAGE_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REDIS_OUTAGE_REQUEST_TIMEOUT_MS,
  pollMs = DEFAULT_REDIS_OUTAGE_POLL_MS,
  composeFile = DEFAULT_REDIS_OUTAGE_COMPOSE_FILE,
  fetchImpl = globalThis.fetch,
  composeRunner = runDockerCompose,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function')
  }
  if (typeof composeRunner !== 'function') {
    throw new Error('composeRunner must be a function')
  }
  if (typeof sleep !== 'function') {
    throw new Error('sleep must be a function')
  }

  const normalized = {
    base: normalizeLoopbackBaseURL(base),
    cookie: normalizeRequiredString(cookie, 'cookie'),
    timeoutMs: parsePositiveInteger(timeoutMs, 'timeout-ms'),
    requestTimeoutMs: parsePositiveInteger(
      requestTimeoutMs,
      'request-timeout-ms',
    ),
    pollMs: parsePositiveInteger(pollMs, 'poll-ms'),
    composeFile: normalizeComposeFile(composeFile),
  }
  if (normalized.timeoutMs > 120_000) {
    throw new Error('timeout-ms must be 120000 or less')
  }
  if (normalized.requestTimeoutMs > 30_000) {
    throw new Error('request-timeout-ms must be 30000 or less')
  }

  const summary = {
    ok: false,
    base: normalized.base,
    composeFile: relative(REPO_ROOT, normalized.composeFile),
    checks: [],
    outage: {},
    recovery: {},
    cleanup: [],
  }
  const api = createAPI({ ...normalized, fetchImpl, summary })
  const compose = async (args) =>
    await composeRunner({
      composeFile: normalized.composeFile,
      args,
      timeoutMs: normalized.timeoutMs,
    })
  let redisStopped = false
  let stackConfirmed = false
  let primaryError

  try {
    const runningOutput = await compose([
      'ps',
      '--services',
      '--status',
      'running',
    ])
    const runningServices = parseServiceList(commandStdout(runningOutput))
    recordCheck(
      summary,
      'redis outage: required Compose services are running',
      REQUIRED_SERVICES.every((service) => runningServices.includes(service)),
      REQUIRED_SERVICES,
      runningServices,
    )
    stackConfirmed = true

    await setProvider(api, 'node')
    const preflightNode = await api.request({
      name: 'redis outage preflight: Node authenticated profile',
      path: '/api/profile',
      expectedStatus: 200,
      expectedBackend: 'node',
      includeCookie: true,
    })
    const preflightGo = await api.request({
      name: 'redis outage preflight: Go authenticated profile',
      path: '/__lab/go/api/profile',
      expectedStatus: 200,
      expectedBackend: 'go',
      includeCookie: true,
    })
    expectFixtureAdmin(summary, preflightNode)
    expectFixtureAdmin(summary, preflightGo)
    recordCheck(
      summary,
      'redis outage preflight: Node and Go profile bodies match',
      isDeepStrictEqual(preflightNode.body, preflightGo.body),
      preflightNode.body,
      preflightGo.body,
    )
    await expectReady(api, summary, 'redis outage preflight', 200, 'ok')

    await compose(['stop', 'redis'])
    redisStopped = true

    const outageNode = await api.request({
      name: 'redis outage: Node authenticated profile fails closed',
      path: '/api/profile',
      expectedStatus: 503,
      expectedBackend: 'node',
      includeCookie: true,
    })
    const outageGo = await api.request({
      name: 'redis outage: Go authenticated profile fails closed',
      path: '/__lab/go/api/profile',
      expectedStatus: 503,
      expectedBackend: 'go',
      includeCookie: true,
    })
    expectSharedIdentityUnavailable(summary, outageNode)
    expectSharedIdentityUnavailable(summary, outageGo)

    const publicNode = await api.request({
      name: 'redis outage: Node public photos remain available',
      path: '/api/photos/visible',
      expectedStatus: 200,
      expectedBackend: 'node',
      includeCookie: false,
    })
    const publicGo = await api.request({
      name: 'redis outage: Go public photos remain available',
      path: '/__lab/go/api/photos/visible',
      expectedStatus: 200,
      expectedBackend: 'go',
      includeCookie: false,
    })
    recordCheck(
      summary,
      'redis outage: public photo bodies match without Redis',
      isDeepStrictEqual(publicNode.body, publicGo.body),
      publicNode.body,
      publicGo.body,
    )
    const outageReady = await expectReady(
      api,
      summary,
      'redis outage',
      503,
      'failed',
    )
    summary.outage = {
      nodeProfileDurationMs: outageNode.durationMs,
      goProfileDurationMs: outageGo.durationMs,
      readinessDurationMs: outageReady.durationMs,
      publicReadsAvailable: true,
      privateReadsFailClosed: true,
    }

    await compose(['start', 'redis'])
    redisStopped = false
    const recoveredReady = await waitForRecovery({
      api,
      timeoutMs: normalized.timeoutMs,
      pollMs: normalized.pollMs,
      sleep,
    })
    const recoveredNode = await api.request({
      name: 'redis recovery: Node reuses persisted session',
      path: '/api/profile',
      expectedStatus: 200,
      expectedBackend: 'node',
      includeCookie: true,
    })
    const recoveredGo = await api.request({
      name: 'redis recovery: Go reuses persisted session',
      path: '/__lab/go/api/profile',
      expectedStatus: 200,
      expectedBackend: 'go',
      includeCookie: true,
    })
    expectFixtureAdmin(summary, recoveredNode)
    expectFixtureAdmin(summary, recoveredGo)
    recordCheck(
      summary,
      'redis recovery: Node and Go persisted-session profiles match',
      isDeepStrictEqual(recoveredNode.body, recoveredGo.body),
      recoveredNode.body,
      recoveredGo.body,
    )
    summary.recovery = {
      readinessAttempts: recoveredReady.attempts,
      readinessDurationMs: recoveredReady.durationMs,
      persistedSessionAcceptedByNode: true,
      persistedSessionAcceptedByGo: true,
    }
    summary.ok = true
  } catch (error) {
    primaryError = error
  } finally {
    if (!stackConfirmed) {
      summary.cleanup.push({ name: 'Compose stack left untouched', ok: true })
    }
    if (stackConfirmed) {
      if (redisStopped) {
        await cleanupAction(summary, 'Redis service restarted', async () => {
          await compose(['start', 'redis'])
          redisStopped = false
        })
      } else {
        summary.cleanup.push({ name: 'Redis service running', ok: true })
      }
      await cleanupAction(summary, 'Redis readiness recovered', async () => {
        await waitForRecovery({
          api,
          timeoutMs: normalized.timeoutMs,
          pollMs: normalized.pollMs,
          sleep,
        })
      })
      await cleanupAction(
        summary,
        'backend provider restored to Node',
        async () => {
          await setProvider(api, 'node')
        },
      )
    }
  }

  const cleanupError = summary.cleanup.find((entry) => !entry.ok)
  if (primaryError || cleanupError) {
    summary.ok = false
    const error = new Error(
      primaryError?.message ||
        cleanupError?.error ||
        'Redis outage cleanup failed',
    )
    error.summary = summary
    throw error
  }
  return summary
}

export function runDockerCompose({ composeFile, args, timeoutMs }) {
  const result = spawnSync('docker', ['compose', '-f', composeFile, ...args], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `docker compose ${args.join(' ')} failed (${result.status}): ${String(result.stderr || result.stdout).trim()}`,
    )
  }
  return result
}

function createAPI({ base, cookie, requestTimeoutMs, fetchImpl, summary }) {
  return {
    summary,
    async request({
      name,
      path,
      method = 'GET',
      body,
      expectedStatus,
      expectedBackend,
      includeCookie = false,
      record = true,
    }) {
      const requestId = `dual-redis-outage-${randomUUID()}`
      const headers = {
        Accept: 'application/json',
        'Accept-Language': 'en',
        'X-Request-Id': requestId,
      }
      if (includeCookie) headers.Cookie = cookie
      const payload = body === undefined ? undefined : JSON.stringify(body)
      if (payload !== undefined) headers['Content-Type'] = 'application/json'
      const startedAt = Date.now()
      const response = await fetchImpl(joinURL(base, path), {
        method,
        headers,
        body: payload,
        redirect: 'manual',
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
      const durationMs = Date.now() - startedAt
      const text = await response.text()
      const parsed = parseJSON(text, name)
      const result = {
        name,
        status: response.status,
        backend: response.headers.get('x-chronoframe-backend'),
        requestId: response.headers.get('x-request-id'),
        contentType: response.headers.get('content-type'),
        setCookie: response.headers.get('set-cookie'),
        body: parsed,
        durationMs,
      }
      if (record) {
        recordCheck(
          summary,
          `${name}: status`,
          result.status === expectedStatus,
          expectedStatus,
          result.status,
        )
        recordCheck(
          summary,
          `${name}: backend`,
          result.backend === expectedBackend,
          expectedBackend,
          result.backend,
        )
        recordCheck(
          summary,
          `${name}: request id`,
          result.requestId === requestId,
          requestId,
          result.requestId,
        )
        recordCheck(
          summary,
          `${name}: JSON content type`,
          String(result.contentType || '')
            .toLowerCase()
            .startsWith('application/json'),
          'application/json',
          result.contentType,
        )
        recordCheck(
          summary,
          `${name}: no Cookie mutation`,
          result.setCookie === null,
          null,
          result.setCookie,
        )
      }
      return result
    },
  }
}

async function setProvider(api, provider) {
  const result = await api.request({
    name: `redis outage control: set provider ${provider}`,
    method: 'PUT',
    path: PROVIDER_SETTING_PATH,
    body: { value: provider },
    expectedStatus: 200,
    expectedBackend: 'node',
    includeCookie: true,
  })
  if (result.body?.value !== provider) {
    throw new Error(
      `redis outage control expected provider ${provider}, got ${JSON.stringify(result.body?.value)}`,
    )
  }
}

function expectFixtureAdmin(summary, result) {
  recordCheck(
    summary,
    `${result.name}: fixture admin id`,
    result.body?.id === 910001 && result.body?.isAdmin === 1,
    { id: 910001, isAdmin: 1 },
    { id: result.body?.id, isAdmin: result.body?.isAdmin },
  )
}

function expectSharedIdentityUnavailable(summary, result) {
  const expected = {
    statusCode: 503,
    statusMessage: 'Shared identity service unavailable',
    message: 'Shared identity service unavailable',
  }
  const actual = {
    statusCode: result.body?.statusCode,
    statusMessage: result.body?.statusMessage,
    message: result.body?.message,
  }
  recordCheck(
    summary,
    `${result.name}: shared identity error contract`,
    isDeepStrictEqual(actual, expected),
    expected,
    actual,
  )
}

async function expectReady(api, summary, prefix, expectedStatus, redisState) {
  const result = await api.request({
    name: `${prefix}: Go readiness`,
    path: '/health/ready',
    expectedStatus,
    expectedBackend: 'go',
    includeCookie: false,
  })
  const expectedBodyStatus = expectedStatus === 200 ? 'ready' : 'not_ready'
  recordCheck(
    summary,
    `${prefix}: readiness state`,
    result.body?.status === expectedBodyStatus &&
      result.body?.checks?.database === 'ok' &&
      result.body?.checks?.mediaTools === 'ok' &&
      result.body?.checks?.redis === redisState,
    {
      status: expectedBodyStatus,
      checks: { database: 'ok', mediaTools: 'ok', redis: redisState },
    },
    { status: result.body?.status, checks: result.body?.checks },
  )
  return result
}

async function waitForRecovery({ api, timeoutMs, pollMs, sleep }) {
  const startedAt = Date.now()
  let attempts = 0
  let lastError
  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1
    try {
      const result = await api.request({
        name: `redis recovery readiness attempt ${attempts}`,
        path: '/health/ready',
        expectedStatus: 200,
        expectedBackend: 'go',
        includeCookie: false,
        record: false,
      })
      if (
        result.body?.status === 'ready' &&
        result.body?.checks?.redis === 'ok' &&
        result.body?.checks?.database === 'ok' &&
        result.body?.checks?.mediaTools === 'ok'
      ) {
        const validMetadata =
          result.status === 200 &&
          result.backend === 'go' &&
          result.requestId !== null &&
          result.setCookie === null
        if (!validMetadata) {
          lastError = new Error(
            `Go readiness metadata drifted after Redis recovery: ${JSON.stringify(
              {
                status: result.status,
                backend: result.backend,
                requestId: result.requestId,
                setCookie: result.setCookie,
              },
            )}`,
          )
          await sleep(pollMs)
          continue
        }
        recordCheck(
          api.summary,
          'redis recovery: Go readiness returned to healthy',
          true,
          {
            status: 200,
            backend: 'go',
            requestId: 'present',
            setCookie: null,
          },
          {
            status: result.status,
            backend: result.backend,
            requestId: result.requestId,
            setCookie: result.setCookie,
          },
        )
        return {
          attempts,
          durationMs: Date.now() - startedAt,
          result,
        }
      }
      lastError = new Error('Go readiness body did not report Redis recovery')
    } catch (error) {
      lastError = error
    }
    await sleep(pollMs)
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for Redis recovery${lastError ? `: ${lastError.message}` : ''}`,
  )
}

async function cleanupAction(summary, name, action) {
  try {
    await action()
    summary.cleanup.push({ name, ok: true })
  } catch (error) {
    summary.cleanup.push({
      name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function recordCheck(summary, name, ok, expected, actual) {
  summary.checks.push({ name, ok })
  if (!ok) {
    throw new Error(
      `${name} failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
  }
}

function commandStdout(result) {
  if (typeof result === 'string') return result
  return String(result?.stdout || '')
}

function parseServiceList(output) {
  return [
    ...new Set(
      String(output)
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].sort()
}

function normalizeLoopbackBaseURL(value) {
  const normalized = normalizeRequiredString(value, 'base')
  let parsed
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error('base must be an absolute HTTP URL')
  }
  if (parsed.protocol !== 'http:') {
    throw new Error('base must use http for the local outage verifier')
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('base must target a loopback host')
  }
  parsed.username = ''
  parsed.password = ''
  parsed.hash = ''
  parsed.search = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '') || '/'
  return parsed.toString().replace(/\/$/u, '')
}

function normalizeComposeFile(value) {
  const normalized = normalizeRequiredString(value, 'compose-file')
  const absolute = resolve(REPO_ROOT, normalized)
  const localPath = relative(REPO_ROOT, absolute)
  if (
    localPath === '..' ||
    localPath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error('compose-file must stay inside the repository')
  }
  if (!existsSync(absolute)) {
    throw new Error(`compose-file does not exist: ${localPath}`)
  }
  return absolute
}

function normalizeRequiredString(value, name) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`${name} must not be empty`)
  return normalized
}

function parsePositiveInteger(value, name) {
  const normalized = String(value).trim()
  if (!/^\d+$/u.test(normalized)) {
    throw new Error(`${name} must be a positive integer`)
  }
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function joinURL(base, path) {
  const root = base.endsWith('/') ? base : `${base}/`
  return new URL(String(path).replace(/^\/+/, ''), root).toString()
}

function parseJSON(text, name) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${name} returned non-JSON: ${text}`)
  }
}

function isMainModule() {
  return (
    Boolean(process.argv[1]) &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  )
}

if (isMainModule()) {
  try {
    const summary = await verifyDualRedisOutage(
      parseRedisOutageVerifierOptions(),
    )
    console.log(JSON.stringify(summary, null, 2))
  } catch (error) {
    console.error(
      JSON.stringify(
        error?.summary || {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    )
    process.exitCode = 1
  }
}

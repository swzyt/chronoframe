#!/usr/bin/env node

import { mkdir, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const DEFAULT_DUAL_LOGS_COOKIE =
  'cf_session=Q0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0M'
export const PROVIDER_SETTING_PATH =
  '/api/system/settings/system/backend.readProvider'
export const SYSTEM_LOGS_PATH = '/api/system/logs'
export const EXPECTED_SYSTEM_LOGS_CACHE_CONTROL =
  'private, no-cache, no-store, no-transform, must-revalidate, max-age=0'
export const SYSTEM_LOG_INITIAL_QUERY_CASES = Object.freeze([
  Object.freeze({
    name: 'empty initial coerces to zero',
    query: '?initial=',
    found: false,
  }),
  Object.freeze({
    name: 'hex initial uses Number coercion',
    query: '?initial=0x1',
    found: true,
  }),
  Object.freeze({
    name: 'exponent initial uses Number coercion',
    query: '?initial=1e0',
    found: true,
  }),
  Object.freeze({
    name: 'fractional initial floors',
    query: '?initial=1.9',
    found: true,
  }),
  Object.freeze({
    name: 'spaced all falls back to default',
    query: '?initial=%20all%20',
    found: true,
  }),
  Object.freeze({
    name: 'repeated initial falls back to default',
    query: '?initial=all&initial=0',
    found: true,
  }),
])

export function parseDualSystemLogsVerifierOptions(
  args = process.argv.slice(2),
  environment = process.env,
) {
  const options = {
    base: `http://127.0.0.1:${environment.CFRAME_DUAL_PORT || '3000'}`,
    cookie: DEFAULT_DUAL_LOGS_COOKIE,
    logFile:
      environment.CFRAME_DUAL_LOG_FILE ||
      environment.CFRAME_LOG_FILE ||
      path.resolve('data/logs/app.log'),
    timeoutMs: 5_000,
    line: '',
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--base') options.base = args[++index]
    else if (arg === '--cookie') options.cookie = args[++index]
    else if (arg === '--log-file') options.logFile = args[++index]
    else if (arg === '--timeout-ms') options.timeoutMs = Number(args[++index])
    else if (arg === '--line') options.line = args[++index]
    else throw new Error(`Unknown argument: ${arg}`)
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number')
  }
  if (!options.line) {
    options.line = JSON.stringify({
      level: 30,
      tag: 'dual-system-logs',
      requestId: randomUUID(),
      message: 'dual system logs parity probe',
      time: new Date(0).toISOString(),
    })
  }
  return options
}

export async function verifyDualSystemLogs(options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available')
  }

  const checks = []
  const cleanup = []
  const errors = []

  const record = (check) => {
    checks.push(check)
    return check
  }

  const base = options.base.replace(/\/+$/, '')
  const logFile = options.logFile
  if (options.appendLog !== false) {
    await appendLogLine(logFile, options.line)
  }

  try {
    await setProvider({
      base,
      cookie: options.cookie,
      provider: 'node',
      fetchImpl,
      checks,
    })

    for (const provider of ['node', 'go']) {
      await setProvider({
        base,
        cookie: options.cookie,
        provider,
        fetchImpl,
        checks,
      })
      const check = await readLogsProbe({
        base,
        cookie: options.cookie,
        provider,
        line: options.line,
        timeoutMs: options.timeoutMs,
        fetchImpl,
      })
      record(check)
      errors.push(...validateLogsProbe(check, options.line))

      if (options.appendLog !== false) {
        for (const testCase of SYSTEM_LOG_INITIAL_QUERY_CASES) {
          const boundaryLine = JSON.stringify({
            level: 30,
            tag: 'dual-system-logs-boundary',
            provider,
            query: testCase.query,
            requestId: randomUUID(),
            message: 'dual system logs initial query probe',
            time: new Date(0).toISOString(),
          })
          const wakeLine = JSON.stringify({
            level: 30,
            tag: 'dual-system-logs-wake',
            provider,
            requestId: randomUUID(),
            message: 'wake an empty initial log stream',
            time: new Date(0).toISOString(),
          })
          await appendLogLine(logFile, boundaryLine)
          const boundaryCheck = await readLogsProbe({
            base,
            cookie: options.cookie,
            provider,
            line: boundaryLine,
            query: testCase.query,
            timeoutMs: testCase.found ? options.timeoutMs : 1_500,
            fetchImpl,
            name: `${provider} ${testCase.name}`,
            appendAfterOpen: testCase.found
              ? undefined
              : () => appendLogLine(logFile, wakeLine),
          })
          record(boundaryCheck)
          errors.push(
            ...validateLogsProbe(boundaryCheck, boundaryLine, testCase.found),
          )
        }

        const liveLine = JSON.stringify({
          level: 30,
          tag: 'dual-system-logs-live',
          provider,
          requestId: randomUUID(),
          message: 'dual system logs live append probe',
          time: new Date(0).toISOString(),
        })
        const liveCheck = await readLogsProbe({
          base,
          cookie: options.cookie,
          provider,
          line: liveLine,
          query: '?initial=0',
          timeoutMs: options.timeoutMs,
          fetchImpl,
          name: `${provider} streams newly appended log lines`,
          appendAfterOpen: () => appendLogLine(logFile, liveLine),
        })
        record(liveCheck)
        errors.push(...validateLogsProbe(liveCheck, liveLine))
      }
    }
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
    logFile,
    targetLine: options.line,
    checks,
    cleanup,
    errors,
  }
}

async function appendLogLine(filePath, line) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await appendFile(filePath, `${line}\n`, 'utf8')
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

async function readLogsProbe({
  base,
  cookie,
  provider,
  line,
  timeoutMs,
  fetchImpl,
  query = '?initial=all',
  name = `system logs SSE via ${provider}`,
  appendAfterOpen,
}) {
  const controller = new AbortController()
  const check = {
    name,
    method: 'GET',
    path: `${SYSTEM_LOGS_PATH}${query}`,
    expectedBackend: provider,
    status: null,
    backend: null,
    contentType: null,
    cacheControl: null,
    xAccelBuffering: null,
    foundLine: false,
    eventPreview: '',
  }

  const expectedEvent = `data: ${line}`
  let buffer = ''
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  let appendError = null
  const appendTimer = appendAfterOpen
    ? setTimeout(() => {
        Promise.resolve(appendAfterOpen()).catch((error) => {
          appendError = error instanceof Error ? error.message : String(error)
          controller.abort()
        })
      }, 150)
    : null
  try {
    const response = await fetchImpl(`${base}${SYSTEM_LOGS_PATH}${query}`, {
      method: 'GET',
      headers: { Cookie: cookie },
      signal: controller.signal,
    })
    check.status = response.status
    check.backend = response.headers.get('x-chronoframe-backend') || null
    check.contentType = response.headers.get('content-type') || null
    check.cacheControl = response.headers.get('cache-control') || null
    check.xAccelBuffering = response.headers.get('x-accel-buffering') || null
    if (!response.body) {
      check.eventPreview = await response.text()
      return check
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.includes(expectedEvent)) {
        check.foundLine = true
        break
      }
      if (buffer.length > 16_384) {
        buffer = buffer.slice(-16_384)
      }
    }
  } catch (error) {
    if (error?.name !== 'AbortError') {
      check.streamError = error instanceof Error ? error.message : String(error)
    } else if (check.status === null) {
      check.streamError = 'Timed out before receiving SSE response headers'
    }
  } finally {
    clearTimeout(timeout)
    if (appendTimer) clearTimeout(appendTimer)
    controller.abort()
  }
  if (appendError) check.streamError = appendError
  check.eventPreview = buffer.slice(-2_000)
  return check
}

export function validateLogsProbe(check, line, expectedFound = true) {
  const errors = []
  const fail = (field, expected, actual) => {
    errors.push({ name: check.name, field, expected, actual })
  }

  if (check.status !== 200) fail('status', 200, check.status)
  if (check.backend !== check.expectedBackend) {
    fail('headers.x-chronoframe-backend', check.expectedBackend, check.backend)
  }
  if (!String(check.contentType || '').includes('text/event-stream')) {
    fail('headers.content-type', 'text/event-stream', check.contentType)
  }
  if (check.cacheControl !== EXPECTED_SYSTEM_LOGS_CACHE_CONTROL) {
    fail(
      'headers.cache-control',
      EXPECTED_SYSTEM_LOGS_CACHE_CONTROL,
      check.cacheControl,
    )
  }
  if (check.foundLine !== expectedFound) {
    fail('event.data', `data: ${line}`, check.eventPreview)
  }
  if (check.streamError) fail('stream.error', null, check.streamError)
  return errors
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

if (import.meta.url === `file://${process.argv[1]}`) {
  verifyDualSystemLogs(parseDualSystemLogsVerifierOptions())
    .then((result) => {
      console.log(JSON.stringify(result, null, 2))
      if (!result.ok) process.exitCode = 1
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}

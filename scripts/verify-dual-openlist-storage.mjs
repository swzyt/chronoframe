#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { hostname } from 'node:os'
import { pathToFileURL } from 'node:url'

import { FIXTURE_SESSION_TOKEN } from './seed-dual-backend-fixture.mjs'
import { verifyDualMediaParity } from './verify-dual-media-parity.mjs'

export const DEFAULT_OPENLIST_STORAGE_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_OPENLIST_STORAGE_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`
export const DEFAULT_OPENLIST_STORAGE_BIND = '127.0.0.1'
export const DEFAULT_OPENLIST_STORAGE_HOST = '127.0.0.1'
export const DEFAULT_OPENLIST_STORAGE_PREFIX = 'dual-openlist'
export const DEFAULT_OPENLIST_STORAGE_TOKEN =
  'chronoframe-openlist-development-token'
export const DEFAULT_OPENLIST_STORAGE_TIMEOUT_MS = 60_000
export const DEFAULT_OPENLIST_STORAGE_POLL_MS = 500

const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'
const STORAGE_PROVIDER_SETTING_PATH = '/api/system/settings/storage/provider'
const STORAGE_CONFIG_PATH = '/api/system/settings/storage-config'
const MAX_FIXTURE_OBJECT_BYTES = 32 * 1024 * 1024

export function parseOpenListStorageVerifierOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const values = new Map()
  const allowed = new Set([
    '--base',
    '--cookie',
    '--timeout-ms',
    '--poll-ms',
    '--prefix',
    '--openlist-bind',
    '--openlist-host',
    '--openlist-port',
    '--openlist-token',
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

  return {
    base: normalizeHTTPURL(
      values.get('--base') ||
        environment.CFRAME_DUAL_BASE_URL ||
        (environment.CFRAME_DUAL_PORT
          ? `http://127.0.0.1:${environment.CFRAME_DUAL_PORT}`
          : DEFAULT_OPENLIST_STORAGE_BASE_URL),
      'base',
    ),
    cookie: normalizeRequiredString(
      values.get('--cookie') ||
        environment.CFRAME_DUAL_COOKIE ||
        DEFAULT_OPENLIST_STORAGE_COOKIE,
      'cookie',
    ),
    timeoutMs: parsePositiveInteger(
      values.get('--timeout-ms') ||
        environment.CFRAME_DUAL_OPENLIST_TIMEOUT_MS ||
        environment.CFRAME_DUAL_TIMEOUT_MS ||
        DEFAULT_OPENLIST_STORAGE_TIMEOUT_MS,
      'timeout-ms',
    ),
    pollMs: parsePositiveInteger(
      values.get('--poll-ms') ||
        environment.CFRAME_DUAL_OPENLIST_POLL_MS ||
        DEFAULT_OPENLIST_STORAGE_POLL_MS,
      'poll-ms',
    ),
    prefix: normalizePrefix(
      values.get('--prefix') ||
        environment.CFRAME_DUAL_OPENLIST_PREFIX ||
        DEFAULT_OPENLIST_STORAGE_PREFIX,
    ),
    openListBind: normalizeRequiredString(
      values.get('--openlist-bind') ||
        environment.CFRAME_DUAL_OPENLIST_BIND ||
        DEFAULT_OPENLIST_STORAGE_BIND,
      'openlist-bind',
    ),
    openListHost: normalizeHost(
      values.get('--openlist-host') ||
        environment.CFRAME_DUAL_OPENLIST_HOST ||
        DEFAULT_OPENLIST_STORAGE_HOST,
    ),
    openListPort: parsePort(
      values.get('--openlist-port') ||
        environment.CFRAME_DUAL_OPENLIST_PORT ||
        0,
      'openlist-port',
      { allowZero: true },
    ),
    token: normalizeRequiredString(
      values.get('--openlist-token') ||
        environment.CFRAME_DUAL_OPENLIST_TOKEN ||
        DEFAULT_OPENLIST_STORAGE_TOKEN,
      'openlist-token',
    ),
  }
}

export async function verifyDualOpenListStorage({
  base = DEFAULT_OPENLIST_STORAGE_BASE_URL,
  cookie = DEFAULT_OPENLIST_STORAGE_COOKIE,
  timeoutMs = DEFAULT_OPENLIST_STORAGE_TIMEOUT_MS,
  pollMs = DEFAULT_OPENLIST_STORAGE_POLL_MS,
  prefix = DEFAULT_OPENLIST_STORAGE_PREFIX,
  openListBind = DEFAULT_OPENLIST_STORAGE_BIND,
  openListHost = DEFAULT_OPENLIST_STORAGE_HOST,
  openListPort = 0,
  token = DEFAULT_OPENLIST_STORAGE_TOKEN,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  openListServerFactory = startFakeOpenListServer,
  mediaVerifier = verifyDualMediaParity,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function')
  }
  if (typeof sleep !== 'function') {
    throw new Error('sleep must be a function')
  }
  if (typeof openListServerFactory !== 'function') {
    throw new Error('openListServerFactory must be a function')
  }
  if (typeof mediaVerifier !== 'function') {
    throw new Error('mediaVerifier must be a function')
  }

  const normalized = {
    base: normalizeHTTPURL(base, 'base'),
    cookie: normalizeRequiredString(cookie, 'cookie'),
    timeoutMs: parsePositiveInteger(timeoutMs, 'timeout-ms'),
    pollMs: parsePositiveInteger(pollMs, 'poll-ms'),
    prefix: normalizePrefix(prefix),
    openListBind: normalizeRequiredString(openListBind, 'openlist-bind'),
    openListHost: normalizeHost(openListHost),
    openListPort: parsePort(openListPort, 'openlist-port', { allowZero: true }),
    token: normalizeRequiredString(token, 'openlist-token'),
  }
  if (normalized.timeoutMs > 120_000) {
    throw new Error('timeout-ms must be 120000 or less')
  }
  if (normalized.pollMs > 5_000) {
    throw new Error('poll-ms must be 5000 or less')
  }

  const runId = randomUUID().slice(0, 8)
  const rootPath = `${normalized.prefix}/${runId}`
  const summary = {
    ok: false,
    base: normalized.base,
    rootPath,
    openListURL: undefined,
    checks: [],
    runs: [],
    protocol: undefined,
    cleanup: [],
  }
  const state = {
    server: undefined,
    storageConfigId: undefined,
    originalStorageProvider: undefined,
  }
  const api = createAPI({ ...normalized, summary, fetchImpl })

  try {
    state.server = await openListServerFactory({
      bind: normalized.openListBind,
      port: normalized.openListPort,
      publicHost: normalized.openListHost,
      token: normalized.token,
      maxObjectBytes: MAX_FIXTURE_OBJECT_BYTES,
    })
    summary.openListURL = normalizeHTTPURL(
      state.server.baseURL,
      'OpenList fixture baseURL',
    )
    summary.checks.push({
      name: 'start isolated OpenList protocol fixture',
      ok: true,
      baseURL: summary.openListURL,
    })

    await setBackendProvider(api, 'node')
    state.originalStorageProvider = (
      await api.request({
        name: 'capture original active storage provider',
        path: STORAGE_PROVIDER_SETTING_PATH,
        expectedBackend: 'node',
      })
    ).body?.value

    await setBackendProvider(api, 'go')
    const create = await api.request({
      name: 'create shared OpenList storage configuration via Go',
      method: 'POST',
      path: STORAGE_CONFIG_PATH,
      expectedBackend: 'go',
      body: {
        name: `${normalized.prefix} OpenList ${runId}`,
        provider: 'openlist',
        config: openListConfig({
          baseURL: summary.openListURL,
          rootPath,
          token: normalized.token,
          downloadEndpoint: '/download',
        }),
      },
    })
    state.storageConfigId = requirePositiveInteger(
      create.body?.id,
      create.name,
      'body.id',
    )

    await api.request({
      name: 'activate shared OpenList storage configuration via Go',
      method: 'PUT',
      path: STORAGE_PROVIDER_SETTING_PATH,
      expectedBackend: 'go',
      expectedValue: state.storageConfigId,
      body: { value: state.storageConfigId },
    })

    const modes = [
      { name: 'download-endpoint', downloadEndpoint: '/download' },
      { name: 'raw-url', downloadEndpoint: '' },
    ]
    for (const [modeIndex, mode] of modes.entries()) {
      if (modeIndex > 0) {
        await setBackendProvider(api, 'node')
        await api.request({
          name: 'switch active OpenList configuration to raw_url via Node',
          method: 'PUT',
          path: `${STORAGE_CONFIG_PATH}/${state.storageConfigId}`,
          expectedBackend: 'node',
          body: {
            provider: 'openlist',
            config: openListConfig({
              baseURL: summary.openListURL,
              rootPath,
              token: normalized.token,
              downloadEndpoint: mode.downloadEndpoint,
            }),
          },
        })
      }

      for (const provider of ['node', 'go']) {
        const run = await mediaVerifier({
          base: normalized.base,
          cookie: normalized.cookie,
          timeoutMs: normalized.timeoutMs,
          pollMs: normalized.pollMs,
          prefix: `${normalized.prefix}-${modeIndex}-${provider}`,
          setupProvider: provider,
          cleanupProvider: provider,
          fetchImpl,
          sleep,
        })
        summary.runs.push({ mode: mode.name, provider, ...run })
        if (!run.ok) {
          throw new Error(
            `${provider} OpenList ${mode.name} media parity run failed: ${formatNestedErrors(run.errors)}`,
          )
        }
        const failedCleanup = (run.cleanup || []).filter(
          (item) => item.ok !== true,
        )
        if (failedCleanup.length > 0) {
          throw new Error(
            `${provider} OpenList ${mode.name} media cleanup failed: ${formatNestedErrors(failedCleanup)}`,
          )
        }
        assertOpenListEmpty(
          state.server.snapshot(),
          `${provider} ${mode.name} API cleanup`,
        )
        summary.checks.push({
          name: `${provider} OpenList ${mode.name} prepare/read/delete round trip`,
          ok: true,
          mediaComparisons: run.mediaComparisons,
          checkCount: run.checkCount,
        })
      }
    }

    summary.protocol = state.server.snapshot()
    validateProtocolSnapshot(summary.protocol, rootPath)
    summary.checks.push({
      name: 'validate OpenList protocol traffic and root isolation',
      ok: true,
      protocol: summary.protocol,
    })
    summary.ok = true
    return summary
  } catch (error) {
    summary.errors = [
      {
        name: 'dual OpenList storage verifier',
        message: error instanceof Error ? error.message : String(error),
      },
    ]
    return summary
  } finally {
    await cleanup({ api, state, summary })
    if (summary.cleanup.some((item) => item.ok !== true)) {
      summary.ok = false
    }
    summary.checkCount = summary.checks.length
    summary.runCount = summary.runs.length
  }
}

export async function startFakeOpenListServer({
  bind = DEFAULT_OPENLIST_STORAGE_BIND,
  port = 0,
  publicHost = DEFAULT_OPENLIST_STORAGE_HOST,
  token = DEFAULT_OPENLIST_STORAGE_TOKEN,
  maxObjectBytes = MAX_FIXTURE_OBJECT_BYTES,
} = {}) {
  const expectedToken = normalizeRequiredString(token, 'openlist-token')
  const limit = parsePositiveInteger(maxObjectBytes, 'maxObjectBytes')
  const objects = new Map()
  const events = []
  let unexpectedRequests = 0
  let authFailures = 0

  const server = createServer(async (request, response) => {
    try {
      const requestURL = new URL(request.url || '/', 'http://fixture.invalid')
      const route = `${request.method || 'GET'} ${requestURL.pathname}`
      const needsAuth = requestURL.pathname !== '/raw'
      if (needsAuth && request.headers.authorization !== expectedToken) {
        authFailures += 1
        events.push({ route, status: 401 })
        writeJSON(response, 401, { code: 401, message: 'unauthorized' })
        return
      }

      if (request.method === 'PUT' && requestURL.pathname === '/api/fs/put') {
        const key = normalizeOpenListPath(
          decodePathHeader(request.headers['file-path']),
        )
        const body = await readRequestBody(request, limit)
        const modified = new Date().toISOString()
        const contentType = normalizedContentType(
          request.headers['content-type'],
        )
        objects.set(key, {
          body,
          contentType,
          modified,
          etag: quotedETag(body),
        })
        events.push({ route, status: 200, key, bytes: body.byteLength })
        writeJSON(response, 200, { code: 200, message: 'success', data: null })
        return
      }

      if (request.method === 'POST' && requestURL.pathname === '/api/fs/get') {
        const payload = await readJSONRequest(request, limit)
        const key = normalizeOpenListPath(payload?.path)
        const object = objects.get(key)
        if (!object) {
          events.push({ route, status: 404, key })
          writeJSON(response, 404, { code: 404, message: 'not found' })
          return
        }
        events.push({ route, status: 200, key })
        writeJSON(response, 200, {
          code: 200,
          message: 'success',
          data: {
            size: object.body.byteLength,
            modified: object.modified,
            etag: object.etag,
            raw_url: `${publicBaseURL(publicHost, listeningPort(server))}/raw?path=${encodeURIComponent(key)}`,
            content_type: object.contentType,
          },
        })
        return
      }

      if (
        request.method === 'GET' &&
        (requestURL.pathname === '/download' || requestURL.pathname === '/raw')
      ) {
        const key = normalizeOpenListPath(requestURL.searchParams.get('path'))
        const object = objects.get(key)
        if (!object) {
          events.push({ route, status: 404, key })
          response.writeHead(404)
          response.end()
          return
        }
        events.push({
          route,
          status: 200,
          key,
          range: request.headers.range || null,
          bytes: object.body.byteLength,
        })
        response.writeHead(200, {
          'Accept-Ranges': 'bytes',
          'Content-Length': String(object.body.byteLength),
          'Content-Type': object.contentType,
          ETag: object.etag,
          'Last-Modified': new Date(object.modified).toUTCString(),
        })
        response.end(object.body)
        return
      }

      if (
        request.method === 'POST' &&
        requestURL.pathname === '/api/fs/remove'
      ) {
        const payload = await readJSONRequest(request, limit)
        const dir = normalizeOpenListPath(payload?.dir)
        const names = Array.isArray(payload?.names) ? payload.names : []
        const keys = names.map((name) =>
          normalizeOpenListPath(`${dir}/${String(name || '')}`),
        )
        for (const key of keys) objects.delete(key)
        events.push({ route, status: 200, keys })
        writeJSON(response, 200, { code: 200, message: 'success', data: null })
        return
      }

      unexpectedRequests += 1
      events.push({ route, status: 404 })
      writeJSON(response, 404, { code: 404, message: 'not found' })
    } catch (error) {
      events.push({
        route: `${request.method || 'GET'} ${request.url || '/'}`,
        status: 400,
        error: error instanceof Error ? error.message : String(error),
      })
      writeJSON(response, 400, { code: 400, message: 'bad request' })
    }
  })

  await listen(server, bind, port)
  const baseURL = publicBaseURL(publicHost, listeningPort(server))
  let closed = false

  return {
    baseURL,
    snapshot() {
      const byRoute = {}
      for (const event of events) {
        byRoute[event.route] = (byRoute[event.route] || 0) + 1
      }
      const observedKeys = [
        ...new Set(
          events.flatMap((event) => [
            ...(event.key ? [event.key] : []),
            ...(Array.isArray(event.keys) ? event.keys : []),
          ]),
        ),
      ].sort()
      return {
        objectCount: objects.size,
        requestCount: events.length,
        authFailures,
        unexpectedRequests,
        byRoute,
        observedKeys,
        ignoredRangeRequests: events.filter(
          (event) =>
            (event.route === 'GET /download' || event.route === 'GET /raw') &&
            event.range,
        ).length,
      }
    },
    clear() {
      const removed = objects.size
      objects.clear()
      return removed
    },
    async close() {
      if (closed) return
      closed = true
      await closeServer(server)
    },
  }
}

function createAPI({ base, cookie, timeoutMs, summary, fetchImpl }) {
  return {
    async request(expectation) {
      const requestId = `dual-openlist-${randomUUID()}`
      const headers = {
        Accept: 'application/json',
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
      }
      const response = await fetchImpl(
        new URL(expectation.path, `${base}/`).toString(),
        {
          method: expectation.method || 'GET',
          headers,
          body:
            expectation.body === undefined
              ? undefined
              : JSON.stringify(expectation.body),
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        },
      )
      const text = await response.text()
      const result = {
        name: expectation.name,
        method: expectation.method || 'GET',
        path: expectation.path,
        status: response.status,
        backend: response.headers.get('x-chronoframe-backend'),
        responseRequestId: response.headers.get('x-request-id'),
        body: parseJSON(text),
      }
      summary.checks.push(result)
      const expectedStatuses = expectation.expectedStatuses || [200]
      if (!expectedStatuses.includes(result.status)) {
        throw new Error(
          `${result.name}: expected status ${expectedStatuses.join(' or ')}, got ${result.status}: ${text}`,
        )
      }
      if (
        expectation.expectedBackend &&
        result.backend !== expectation.expectedBackend
      ) {
        throw new Error(
          `${result.name}: expected backend ${expectation.expectedBackend}, got ${String(result.backend)}`,
        )
      }
      if (
        Object.hasOwn(expectation, 'expectedValue') &&
        result.body?.value !== expectation.expectedValue
      ) {
        throw new Error(
          `${result.name}: expected body.value ${String(expectation.expectedValue)}, got ${String(result.body?.value)}`,
        )
      }
      return result
    },
  }
}

async function setBackendProvider(api, provider) {
  await api.request({
    name: `switch backend provider to ${provider}`,
    method: 'PUT',
    path: PROVIDER_SETTING_PATH,
    expectedBackend: 'node',
    expectedValue: provider,
    body: { value: provider },
  })
}

function validateProtocolSnapshot(snapshot, rootPath) {
  assertOpenListEmpty(snapshot, 'completed verifier')
  if (snapshot.authFailures !== 0) {
    throw new Error(
      `OpenList protocol fixture observed ${snapshot.authFailures} authorization failures`,
    )
  }
  if (snapshot.unexpectedRequests !== 0) {
    throw new Error(
      `OpenList protocol fixture observed ${snapshot.unexpectedRequests} unexpected requests`,
    )
  }
  for (const route of [
    'PUT /api/fs/put',
    'POST /api/fs/get',
    'GET /download',
    'GET /raw',
    'POST /api/fs/remove',
  ]) {
    if (
      !Number.isSafeInteger(snapshot.byRoute?.[route]) ||
      snapshot.byRoute[route] < 1
    ) {
      throw new Error(`OpenList protocol fixture did not observe ${route}`)
    }
  }
  if (snapshot.ignoredRangeRequests < 1) {
    throw new Error(
      'OpenList protocol fixture did not exercise ignored Range fallback',
    )
  }
  const normalizedRoot = normalizeOpenListPath(rootPath)
  const doubleRoot = `${normalizedRoot}${normalizedRoot}/`
  for (const key of snapshot.observedKeys || []) {
    if (key !== normalizedRoot && !key.startsWith(`${normalizedRoot}/`)) {
      throw new Error(`OpenList fixture key escaped rootPath: ${key}`)
    }
    if (key.startsWith(doubleRoot)) {
      throw new Error(`OpenList fixture applied rootPath twice: ${key}`)
    }
  }
}

function openListConfig({ baseURL, rootPath, token, downloadEndpoint }) {
  return {
    provider: 'openlist',
    baseUrl: baseURL,
    rootPath: `/${rootPath}`,
    token,
    cdnUrl: '',
    uploadEndpoint: '/api/fs/put',
    downloadEndpoint,
    listEndpoint: '',
    deleteEndpoint: '/api/fs/remove',
    metaEndpoint: '/api/fs/get',
    pathField: 'path',
  }
}

function assertOpenListEmpty(snapshot, context) {
  if (snapshot.objectCount !== 0) {
    throw new Error(
      `${context}: expected OpenList object cleanup, found ${snapshot.objectCount} objects`,
    )
  }
}

async function cleanup({ api, state, summary }) {
  const attempt = async (name, operation) => {
    try {
      const details = await operation()
      summary.cleanup.push({
        name,
        ok: true,
        ...(Number.isSafeInteger(details?.removed)
          ? { removed: details.removed }
          : {}),
      })
    } catch (error) {
      summary.cleanup.push({
        name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  await attempt('restore backend provider to node', () =>
    setBackendProvider(api, 'node'),
  )
  if (state.originalStorageProvider !== undefined) {
    await attempt('restore original active storage provider', () =>
      api.request({
        name: 'cleanup: restore original active storage provider',
        method: 'PUT',
        path: STORAGE_PROVIDER_SETTING_PATH,
        expectedBackend: 'node',
        expectedValue: state.originalStorageProvider,
        body: { value: state.originalStorageProvider },
      }),
    )
  }
  if (state.storageConfigId !== undefined) {
    await attempt('delete temporary OpenList storage configuration', () =>
      api.request({
        name: 'cleanup: delete temporary OpenList storage configuration',
        method: 'DELETE',
        path: `${STORAGE_CONFIG_PATH}/${state.storageConfigId}`,
        expectedBackend: 'node',
        expectedStatuses: [200, 404],
      }),
    )
  }
  if (state.server) {
    await attempt('clear remaining OpenList fixture objects', () => ({
      removed: state.server.clear(),
    }))
    summary.protocol = state.server.snapshot()
    await attempt('stop OpenList protocol fixture', () => state.server.close())
  }
}

function decodePathHeader(value) {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) throw new Error('File-Path header is required')
  try {
    return decodeURIComponent(String(raw))
  } catch {
    throw new Error('File-Path header is not valid percent encoding')
  }
}

function normalizeOpenListPath(value) {
  const raw = String(value || '')
    .replaceAll('\\', '/')
    .trim()
  if (!raw || raw.includes('\0')) {
    throw new Error('OpenList path must not be empty')
  }
  const segments = raw.split('/').filter(Boolean)
  if (
    segments.length === 0 ||
    segments.some((part) => part === '.' || part === '..')
  ) {
    throw new Error('OpenList path is unsafe')
  }
  return `/${segments.join('/')}`
}

async function readJSONRequest(request, limit) {
  const body = await readRequestBody(request, limit)
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error('request body must be valid JSON')
  }
}

async function readRequestBody(request, limit) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    length += buffer.byteLength
    if (length > limit) throw new Error(`request body exceeds ${limit} bytes`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, length)
}

function writeJSON(response, status, body) {
  if (response.headersSent) return
  const payload = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.byteLength),
  })
  response.end(payload)
}

function quotedETag(body) {
  return `"${createHash('sha256').update(body).digest('hex')}"`
}

function listen(server, bind, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, bind)
  })
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function listeningPort(server) {
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('OpenList fixture is not listening on a TCP port')
  }
  return address.port
}

function publicBaseURL(host, port) {
  const bracketed =
    host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${bracketed}:${port}`
}

function formatNestedErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return 'unknown error'
  return errors
    .map((error) => error.message || error.error || JSON.stringify(error))
    .join('; ')
}

function normalizeHTTPURL(value, name) {
  const url = new URL(String(value))
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`)
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function normalizeRequiredString(value, name) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`${name} must be non-empty`)
  return normalized
}

function normalizePrefix(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 32)
  if (!normalized) throw new Error('prefix must be non-empty')
  return normalized
}

function normalizeHost(value) {
  const normalized = String(value || '').trim()
  if (normalized === 'self') return hostname()
  if (!normalized || /[\s/]/.test(normalized)) {
    throw new Error('openlist-host must be a hostname or IP address')
  }
  return normalized.replace(/^\[|\]$/g, '')
}

function parsePositiveInteger(value, name) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  throw new Error(`${name} must be a positive safe integer`)
}

function parsePort(value, name, { allowZero = false } = {}) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < (allowZero ? 0 : 1) ||
    parsed > 65_535
  ) {
    throw new Error(
      `${name} must be ${allowZero ? 'zero or ' : ''}a valid TCP port`,
    )
  }
  return parsed
}

function requirePositiveInteger(value, name, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${name}: expected ${field} to be a positive safe integer, got ${String(value)}`,
    )
  }
  return value
}

function normalizedContentType(value) {
  return String(value || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
}

function parseJSON(text) {
  const normalized = String(text || '').trim()
  if (!normalized) return null
  try {
    return JSON.parse(normalized)
  } catch {
    return normalized
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyDualOpenListStorage(parseOpenListStorageVerifierOptions())
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2))
      if (!summary.ok) process.exitCode = 1
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}

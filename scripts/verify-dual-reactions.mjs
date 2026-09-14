#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import Database from 'better-sqlite3'

import {
  canonicalize,
  DUAL_BACKEND_COMPARE_FIXTURE,
  joinBackendURL,
} from './compare-backends.mjs'
import { FIXTURE_SESSION_TOKEN } from './seed-dual-backend-fixture.mjs'

export const DEFAULT_REACTIONS_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_REACTIONS_ADMIN_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`
export const DEFAULT_REACTIONS_DATABASE_PATH = './data/app.sqlite3'
export const DEFAULT_REACTIONS_PREFIX = 'dual-reactions'

export const REACTION_ROUTE_IDS = Object.freeze([
  'photos.reactions.delete',
  'photos.reactions.read',
  'photos.reactions.create',
  'photos.reactions.list',
])

export const REACTION_TYPES = Object.freeze([
  'like',
  'love',
  'amazing',
  'funny',
  'wow',
  'sad',
  'fire',
  'sparkle',
])

const PROVIDERS = Object.freeze(['node', 'go'])
const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'
const PHOTO_ID = DUAL_BACKEND_COMPARE_FIXTURE.photoId
const HIDDEN_PHOTO_ID = DUAL_BACKEND_COMPARE_FIXTURE.hiddenPhotoId
const PHOTO_PATH = `/api/photos/${PHOTO_ID}/reactions`
const HIDDEN_PHOTO_PATH = `/api/photos/${HIDDEN_PHOTO_ID}/reactions`
const MISSING_PHOTO_PATH = '/api/photos/dual-reactions-missing/reactions'
const WHITESPACE_PHOTO_PATH = '/api/photos/%20/reactions'
const BULK_PATH = '/api/photos/reactions'

export const REACTION_READ_CASES = Object.freeze([
  readCase(
    'visible photo reactions for anonymous visitor',
    PHOTO_PATH,
    'anonymous',
  ),
  readCase(
    'hidden photo reactions for administrator',
    HIDDEN_PHOTO_PATH,
    'admin',
  ),
  readCase(
    'missing photo reactions preserve Node read semantics',
    MISSING_PHOTO_PATH,
    'admin',
  ),
  readCase(
    'whitespace photo id is preserved on read',
    WHITESPACE_PHOTO_PATH,
    'admin',
  ),
  readCase(
    'bulk reactions for visible photos',
    `${BULK_PATH}?ids=${PHOTO_ID}`,
    'admin',
  ),
  readCase(
    'bulk reactions preserve duplicate query values',
    `${BULK_PATH}?ids=${PHOTO_ID}&ids=${PHOTO_ID}`,
    'admin',
  ),
  readCase(
    'bulk reactions preserve repeated empty query values',
    `${BULK_PATH}?ids=&ids=`,
    'admin',
  ),
  readCase(
    'bulk reactions preserve empty item in a query array',
    `${BULK_PATH}?ids=&ids=${PHOTO_ID}`,
    'admin',
  ),
  readCase(
    'bulk reactions filter inaccessible photos for anonymous visitor',
    `${BULK_PATH}?ids=${PHOTO_ID}&ids=${HIDDEN_PHOTO_ID}`,
    'anonymous',
  ),
])

export const REACTION_BOUNDARY_CASES = Object.freeze([
  boundary(
    'bulk reactions require ids query',
    'GET',
    BULK_PATH,
    'admin',
    400,
    'Server Error',
    'Photo IDs are required',
  ),
  boundary(
    'bulk reactions reject one empty id query',
    'GET',
    `${BULK_PATH}?ids=`,
    'admin',
    400,
    'Server Error',
    'Photo IDs are required',
  ),
  boundary(
    'anonymous visitor cannot read hidden photo reactions',
    'GET',
    HIDDEN_PHOTO_PATH,
    'anonymous',
    401,
    'Site access required to view more photos',
    'Site access required to view more photos',
  ),
  boundary(
    'anonymous visitor cannot create hidden photo reaction',
    'POST',
    HIDDEN_PHOTO_PATH,
    'anonymous',
    401,
    'Site access required to view more photos',
    'Site access required to view more photos',
    { reactionType: 'like' },
  ),
  boundary(
    'anonymous visitor cannot delete hidden photo reaction',
    'DELETE',
    HIDDEN_PHOTO_PATH,
    'anonymous',
    401,
    'Site access required to view more photos',
    'Site access required to view more photos',
  ),
  boundary(
    'create reaction checks missing photo',
    'POST',
    MISSING_PHOTO_PATH,
    'admin',
    404,
    'Server Error',
    'Photo not found',
    { reactionType: 'like' },
  ),
  boundary(
    'delete reaction reports missing photo fingerprint relation',
    'DELETE',
    MISSING_PHOTO_PATH,
    'admin',
    404,
    'Server Error',
    'Reaction not found',
  ),
  boundary(
    'create reaction preserves whitespace photo id',
    'POST',
    WHITESPACE_PHOTO_PATH,
    'admin',
    404,
    'Server Error',
    'Photo not found',
    { reactionType: 'like' },
  ),
  boundary(
    'delete reaction preserves whitespace photo id',
    'DELETE',
    WHITESPACE_PHOTO_PATH,
    'admin',
    404,
    'Server Error',
    'Reaction not found',
  ),
  rawBoundary(
    'reaction create without body',
    undefined,
    500,
    'Server Error',
    'Server Error',
  ),
  rawBoundary(
    'reaction create with empty body',
    '',
    500,
    'Server Error',
    'Server Error',
  ),
  rawBoundary(
    'reaction create with malformed JSON',
    '{',
    400,
    'Bad Request',
    'Invalid JSON body',
  ),
  rawBoundary(
    'reaction create with trailing JSON value',
    '{"reactionType":"like"} {}',
    400,
    'Bad Request',
    'Invalid JSON body',
  ),
  rawBoundary(
    'reaction create with null body',
    'null',
    500,
    'Server Error',
    'Server Error',
  ),
  ...[
    ['number body', '1'],
    ['string body', '"like"'],
    ['array body', '[]'],
    ['empty object', '{}'],
    ['missing reaction type', '{"other":true}'],
    ['null reaction type', '{"reactionType":null}'],
    ['boolean reaction type', '{"reactionType":true}'],
    ['array reaction type', '{"reactionType":[]}'],
    ['empty reaction type', '{"reactionType":""}'],
    ['case-sensitive reaction type', '{"reactionType":"LIKE"}'],
    ['unknown reaction type', '{"reactionType":"clap"}'],
  ].map(([name, rawBody]) =>
    rawBoundary(
      `reaction create rejects ${name}`,
      rawBody,
      400,
      'Server Error',
      'Invalid reaction type',
    ),
  ),
])

function readCase(name, path, cookie) {
  return Object.freeze({ name, method: 'GET', path, cookie })
}

function boundary(
  name,
  method,
  path,
  cookie,
  expectedStatus,
  expectedStatusMessage,
  expectedMessage,
  body,
) {
  const result = {
    name,
    method,
    path,
    cookie,
    expectedStatus,
    expectedStatusMessage,
    expectedMessage,
  }
  if (arguments.length >= 8) result.body = body
  return Object.freeze(result)
}

function rawBoundary(
  name,
  rawBody,
  expectedStatus,
  expectedStatusMessage,
  expectedMessage,
) {
  const result = {
    name,
    method: 'POST',
    path: PHOTO_PATH,
    cookie: 'admin',
    expectedStatus,
    expectedStatusMessage,
    expectedMessage,
  }
  if (rawBody !== undefined) result.rawBody = rawBody
  return Object.freeze(result)
}

export function parseReactionsVerifierOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const values = new Map()
  const supported = new Set([
    '--base',
    '--node',
    '--go',
    '--admin-cookie',
    '--db',
    '--timeout-ms',
    '--prefix',
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (!supported.has(arg)) throw new Error(`Unknown option: ${arg}`)
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
        : DEFAULT_REACTIONS_BASE_URL),
  )
  const timeoutMs = positiveInteger(
    values.get('--timeout-ms') || environment.CFRAME_DUAL_TIMEOUT_MS || 5_000,
    'timeout-ms',
  )
  if (timeoutMs > 60_000) throw new Error('timeout-ms must be 60000 or less')

  return {
    base,
    nodeURL: normalizeBaseURL(
      values.get('--node') || environment.CFRAME_DUAL_NODE_URL || base,
    ),
    goURL: normalizeBaseURL(
      values.get('--go') ||
        environment.CFRAME_DUAL_GO_URL ||
        `${base}/__lab/go`,
    ),
    adminCookie: normalizeCookie(
      values.get('--admin-cookie') ||
        environment.CFRAME_DUAL_ADMIN_COOKIE ||
        environment.CFRAME_DUAL_COOKIE ||
        DEFAULT_REACTIONS_ADMIN_COOKIE,
      'admin-cookie',
    ),
    databasePath: normalizeDatabasePath(
      values.get('--db') ||
        environment.CFRAME_DUAL_DB_PATH ||
        environment.DATABASE_URL ||
        DEFAULT_REACTIONS_DATABASE_PATH,
    ),
    timeoutMs,
    prefix: normalizePrefix(
      values.get('--prefix') ||
        environment.CFRAME_DUAL_REACTIONS_PREFIX ||
        DEFAULT_REACTIONS_PREFIX,
    ),
  }
}

export async function verifyDualReactions({
  base = DEFAULT_REACTIONS_BASE_URL,
  nodeURL = base,
  goURL = `${base}/__lab/go`,
  adminCookie = DEFAULT_REACTIONS_ADMIN_COOKIE,
  databasePath = DEFAULT_REACTIONS_DATABASE_PATH,
  timeoutMs = 5_000,
  prefix = DEFAULT_REACTIONS_PREFIX,
  readCases = REACTION_READ_CASES,
  boundaryCases = REACTION_BOUNDARY_CASES,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function')
  }
  const options = {
    base: normalizeBaseURL(base),
    nodeURL: normalizeBaseURL(nodeURL),
    goURL: normalizeBaseURL(goURL),
    adminCookie: normalizeCookie(adminCookie, 'admin-cookie'),
    databasePath: normalizeDatabasePath(databasePath),
    timeoutMs: positiveInteger(timeoutMs, 'timeout-ms'),
    prefix: normalizePrefix(prefix),
    fetchImpl,
  }
  const summary = {
    ok: false,
    base: options.base,
    nodeURL: options.nodeURL,
    goURL: options.goURL,
    databasePath: options.databasePath,
    routeIds: [...REACTION_ROUTE_IDS],
    checks: [],
    cleanup: [],
  }
  const state = {
    originalProvider: undefined,
    fingerprints: new Set(),
    userAgents: new Set(),
  }

  try {
    assertDatabaseAvailable(options.databasePath)
    state.originalProvider = await readProvider(options, summary)
    await setProvider(options, summary, 'node')

    for (const testCase of readCases) {
      await comparePair(options, summary, {
        ...testCase,
        expectedStatus: 200,
        kind: 'read',
      })
    }
    for (const testCase of boundaryCases) {
      await comparePair(options, summary, { ...testCase, kind: 'boundary' })
    }
    for (const creator of PROVIDERS) {
      await verifyLifecycle(options, summary, state, creator)
    }
    await verifyFingerprintIsolation(options, summary, state)
    await verifySharedRateLimit(options, summary, state)

    summary.ok = true
  } catch (error) {
    summary.errors =
      error instanceof ReactionVerificationFailure
        ? error.errors
        : [{ name: 'dual reaction verifier', message: errorMessage(error) }]
  } finally {
    await cleanupReactions(options, summary, state)
  }

  summary.total = summary.checks.length
  summary.failed = summary.checks.filter((check) => check.ok === false).length
  if (summary.errors?.length && summary.failed === 0) summary.failed = 1
  if (summary.cleanup.some((entry) => entry.ok === false)) summary.ok = false
  return summary
}

async function verifyLifecycle(options, summary, state, creator) {
  const other = otherProvider(creator)
  const headers = fingerprintHeaders(options, `lifecycle-${creator}`)
  const fingerprint = reactionFingerprint(headers)
  state.fingerprints.add(fingerprint)

  await setProvider(options, summary, creator)
  const created = await requestOne(options, summary, {
    name: `reaction create via ${creator}`,
    baseURL: options.base,
    expectedBackend: creator,
    method: 'POST',
    path: PHOTO_PATH,
    cookie: 'admin',
    headers,
    body: { reactionType: 'fire' },
  })
  expectMutation(created.name, created.body, 'created', 'fire')

  await setProvider(options, summary, other)
  const crossRead = await requestOne(options, summary, {
    name: `reaction read via ${other} after ${creator} create`,
    baseURL: options.base,
    expectedBackend: other,
    method: 'GET',
    path: PHOTO_PATH,
    cookie: 'admin',
    headers,
  })
  expectEqual(
    crossRead.name,
    crossRead.body?.userReaction,
    'fire',
    'body.userReaction',
  )
  expectEqual(
    crossRead.name,
    crossRead.body?.reactions?.fire,
    1,
    'body.reactions.fire',
  )

  const updated = await requestOne(options, summary, {
    name: `reaction update via ${other} after ${creator} create`,
    baseURL: options.base,
    expectedBackend: other,
    method: 'POST',
    path: PHOTO_PATH,
    cookie: 'admin',
    headers,
    body: { reactionType: 'sparkle' },
  })
  expectMutation(updated.name, updated.body, 'updated', 'sparkle')

  await setProvider(options, summary, creator)
  const bulkRead = await requestOne(options, summary, {
    name: `bulk reaction read via ${creator} after ${other} update`,
    baseURL: options.base,
    expectedBackend: creator,
    method: 'GET',
    path: `${BULK_PATH}?ids=${PHOTO_ID}`,
    cookie: 'admin',
    headers,
  })
  expectEqual(
    bulkRead.name,
    bulkRead.body?.[PHOTO_ID]?.sparkle,
    1,
    `body.${PHOTO_ID}.sparkle`,
  )

  const removed = await requestOne(options, summary, {
    name: `reaction delete via ${creator} after ${other} update`,
    baseURL: options.base,
    expectedBackend: creator,
    method: 'DELETE',
    path: PHOTO_PATH,
    cookie: 'admin',
    headers,
  })
  expectEqual(
    removed.name,
    removed.body,
    { success: true, action: 'deleted' },
    'body',
  )
  state.fingerprints.delete(fingerprint)

  await setProvider(options, summary, other)
  const afterDelete = await requestOne(options, summary, {
    name: `reaction read via ${other} after ${creator} delete`,
    baseURL: options.base,
    expectedBackend: other,
    method: 'GET',
    path: PHOTO_PATH,
    cookie: 'admin',
    headers,
  })
  expectEqual(
    afterDelete.name,
    afterDelete.body?.userReaction,
    null,
    'body.userReaction',
  )
  expectEqual(
    afterDelete.name,
    afterDelete.body?.reactions?.sparkle,
    0,
    'body.reactions.sparkle',
  )

  await setProvider(options, summary, 'node')
  await comparePair(options, summary, {
    name: `second reaction delete after ${creator} lifecycle`,
    method: 'DELETE',
    path: PHOTO_PATH,
    cookie: 'admin',
    headers,
    expectedStatus: 404,
    expectedStatusMessage: 'Server Error',
    expectedMessage: 'Reaction not found',
    kind: 'boundary',
  })
}

async function verifyFingerprintIsolation(options, summary, state) {
  const firstHeaders = fingerprintHeaders(options, 'fingerprint-a')
  const secondHeaders = fingerprintHeaders(options, 'fingerprint-b')
  const firstFingerprint = reactionFingerprint(firstHeaders)
  const secondFingerprint = reactionFingerprint(secondHeaders)
  state.fingerprints.add(firstFingerprint)
  state.fingerprints.add(secondFingerprint)

  await setProvider(options, summary, 'node')
  const first = await requestOne(options, summary, {
    name: 'first isolated fingerprint reaction via node',
    baseURL: options.base,
    expectedBackend: 'node',
    method: 'POST',
    path: PHOTO_PATH,
    cookie: 'anonymous',
    headers: firstHeaders,
    body: { reactionType: 'amazing' },
  })
  expectMutation(first.name, first.body, 'created', 'amazing')

  await setProvider(options, summary, 'go')
  const second = await requestOne(options, summary, {
    name: 'second isolated fingerprint reaction via go',
    baseURL: options.base,
    expectedBackend: 'go',
    method: 'POST',
    path: PHOTO_PATH,
    cookie: 'anonymous',
    headers: secondHeaders,
    body: { reactionType: 'funny' },
  })
  expectMutation(second.name, second.body, 'created', 'funny')

  const firstRead = await requestOne(options, summary, {
    name: 'Go reads first isolated fingerprint',
    baseURL: options.base,
    expectedBackend: 'go',
    method: 'GET',
    path: PHOTO_PATH,
    cookie: 'anonymous',
    headers: firstHeaders,
  })
  expectEqual(
    firstRead.name,
    firstRead.body?.userReaction,
    'amazing',
    'body.userReaction',
  )
  expectEqual(
    firstRead.name,
    firstRead.body?.reactions?.amazing,
    1,
    'body.reactions.amazing',
  )
  expectEqual(
    firstRead.name,
    firstRead.body?.reactions?.funny,
    1,
    'body.reactions.funny',
  )

  await setProvider(options, summary, 'node')
  const secondRead = await requestOne(options, summary, {
    name: 'Node reads second isolated fingerprint',
    baseURL: options.base,
    expectedBackend: 'node',
    method: 'GET',
    path: PHOTO_PATH,
    cookie: 'anonymous',
    headers: secondHeaders,
  })
  expectEqual(
    secondRead.name,
    secondRead.body?.userReaction,
    'funny',
    'body.userReaction',
  )

  for (const [label, headers, fingerprint] of [
    ['first', firstHeaders, firstFingerprint],
    ['second', secondHeaders, secondFingerprint],
  ]) {
    const removed = await requestOne(options, summary, {
      name: `remove ${label} isolated fingerprint via node`,
      baseURL: options.base,
      expectedBackend: 'node',
      method: 'DELETE',
      path: PHOTO_PATH,
      cookie: 'anonymous',
      headers,
    })
    expectEqual(
      removed.name,
      removed.body,
      { success: true, action: 'deleted' },
      'body',
    )
    state.fingerprints.delete(fingerprint)
  }
}

async function verifySharedRateLimit(options, summary, state) {
  const headers = fingerprintHeaders(options, 'rate-limit')
  const userAgent = headers['User-Agent']
  state.userAgents.add(userAgent)

  // Caddy intentionally replaces untrusted X-Forwarded-For values with the
  // actual peer address. Bootstrap one real request and read back the exact
  // fingerprint observed by the production request chain instead of guessing
  // the proxy-assigned address in this verifier.
  await setProvider(options, summary, 'node')
  const bootstrap = await requestOne(options, summary, {
    name: 'capture production reaction fingerprint through Node gateway',
    baseURL: options.base,
    expectedBackend: 'node',
    method: 'POST',
    path: PHOTO_PATH,
    cookie: 'anonymous',
    headers,
    body: { reactionType: 'love' },
  })
  expectMutation(bootstrap.name, bootstrap.body, 'created', 'love')

  const fingerprint = findReactionFingerprint(
    options.databasePath,
    PHOTO_ID,
    userAgent,
  )
  state.fingerprints.add(fingerprint)
  seedRecentReactions(options.databasePath, fingerprint, 10)

  await comparePair(options, summary, {
    name: 'Node and Go enforce the same database-backed reaction rate limit',
    method: 'POST',
    path: PHOTO_PATH,
    cookie: 'anonymous',
    headers,
    body: { reactionType: 'love' },
    expectedStatus: 429,
    expectedStatusMessage: 'Server Error',
    expectedMessage: 'Too many reactions. Please try again later.',
    kind: 'rate-limit',
  })
  expectDatabaseReactionCount(
    options.databasePath,
    fingerprint,
    10,
    'rate limit must not mutate shared reaction rows',
  )
  deleteFingerprints(options.databasePath, [fingerprint])
  state.fingerprints.delete(fingerprint)
  state.userAgents.delete(userAgent)
}

async function comparePair(options, summary, testCase) {
  const requestID = `dual-reactions-${randomUUID()}`
  const [node, go] = await Promise.all([
    executeRequest(options, {
      ...testCase,
      baseURL: options.nodeURL,
      expectedBackend: 'node',
      requestID,
    }),
    executeRequest(options, {
      ...testCase,
      baseURL: options.goURL,
      expectedBackend: 'go',
      requestID,
    }),
  ])
  const errors = validateReactionPair(testCase, node, go)
  summary.checks.push({
    name: testCase.name,
    kind: testCase.kind,
    method: testCase.method,
    path: testCase.path,
    ok: errors.length === 0,
    node: compactResult(node),
    go: compactResult(go),
    differences: errors,
  })
  if (errors.length > 0) throw new ReactionVerificationFailure(errors)
  return { node, go }
}

export function validateReactionPair(testCase, node, go) {
  const errors = []
  for (const [backend, result] of [
    ['node', node],
    ['go', go],
  ]) {
    if (result.status !== testCase.expectedStatus) {
      errors.push(
        difference(
          testCase.name,
          `${backend}.status`,
          testCase.expectedStatus,
          result.status,
        ),
      )
    }
    if (result.backend !== backend) {
      errors.push(
        difference(
          testCase.name,
          `${backend}.headers.x-chronoframe-backend`,
          backend,
          result.backend,
        ),
      )
    }
    if (result.contentType !== 'application/json') {
      errors.push(
        difference(
          testCase.name,
          `${backend}.headers.content-type`,
          'application/json',
          result.contentType,
        ),
      )
    }
    if (result.responseRequestID !== result.requestID) {
      errors.push(
        difference(
          testCase.name,
          `${backend}.headers.x-request-id`,
          result.requestID,
          result.responseRequestID,
        ),
      )
    }
    if (result.setCookie) {
      errors.push(
        difference(
          testCase.name,
          `${backend}.headers.set-cookie`,
          'absent',
          'present',
        ),
      )
    }
    if (
      testCase.expectedStatusMessage &&
      result.body?.statusMessage !== testCase.expectedStatusMessage
    ) {
      errors.push(
        difference(
          testCase.name,
          `${backend}.body.statusMessage`,
          testCase.expectedStatusMessage,
          result.body?.statusMessage,
        ),
      )
    }
    if (
      testCase.expectedMessage &&
      result.body?.message !== testCase.expectedMessage
    ) {
      errors.push(
        difference(
          testCase.name,
          `${backend}.body.message`,
          testCase.expectedMessage,
          result.body?.message,
        ),
      )
    }
  }

  const nodeBody = comparableBody(node.body)
  const goBody = comparableBody(go.body)
  if (JSON.stringify(nodeBody) !== JSON.stringify(goBody)) {
    errors.push({
      name: testCase.name,
      field: 'body',
      node: nodeBody,
      go: goBody,
    })
  }
  return errors
}

async function requestOne(options, summary, request) {
  const result = await executeRequest(options, {
    ...request,
    requestID: `dual-reactions-${randomUUID()}`,
  })
  const errors = []
  const expectedStatus = request.expectedStatus || 200
  if (result.status !== expectedStatus) {
    errors.push(
      difference(request.name, 'status', expectedStatus, result.status),
    )
  }
  if (result.backend !== request.expectedBackend) {
    errors.push(
      difference(
        request.name,
        'headers.x-chronoframe-backend',
        request.expectedBackend,
        result.backend,
      ),
    )
  }
  if (result.contentType !== 'application/json') {
    errors.push(
      difference(
        request.name,
        'headers.content-type',
        'application/json',
        result.contentType,
      ),
    )
  }
  if (result.responseRequestID !== result.requestID) {
    errors.push(
      difference(
        request.name,
        'headers.x-request-id',
        result.requestID,
        result.responseRequestID,
      ),
    )
  }
  if (result.setCookie) {
    errors.push(
      difference(request.name, 'headers.set-cookie', 'absent', 'present'),
    )
  }
  summary.checks.push({
    name: request.name,
    kind: request.kind || 'lifecycle',
    method: request.method,
    path: request.path,
    ok: errors.length === 0,
    result: compactResult(result),
    differences: errors,
  })
  if (errors.length > 0) throw new ReactionVerificationFailure(errors)
  return { ...result, name: request.name }
}

async function executeRequest(options, request) {
  const headers = {
    Accept: 'application/json',
    'Accept-Language': 'en',
    'User-Agent': `${options.prefix}/verifier`,
    'X-Forwarded-For': '198.51.100.61',
    'X-Request-Id': request.requestID,
    'Accept-Encoding': 'identity',
    ...(request.headers || {}),
  }
  const cookie = resolveCookie(options, request.cookie)
  if (cookie) headers.Cookie = cookie
  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs),
  }
  if (Object.hasOwn(request, 'body')) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(request.body)
  } else if (Object.hasOwn(request, 'rawBody')) {
    headers['Content-Type'] = request.contentType || 'application/json'
    init.body = request.rawBody
  }
  const response = await options.fetchImpl(
    joinBackendURL(request.baseURL, request.path),
    init,
  )
  const text = await response.text()
  return {
    status: response.status,
    backend: response.headers.get('x-chronoframe-backend'),
    contentType: normalizedContentType(response.headers.get('content-type')),
    setCookie: response.headers.has('set-cookie'),
    requestID: request.requestID,
    responseRequestID: response.headers.get('x-request-id'),
    body: parseJSON(text),
  }
}

async function readProvider(options, summary) {
  const response = await requestOne(options, summary, {
    name: 'capture original backend provider',
    baseURL: options.nodeURL,
    expectedBackend: 'node',
    method: 'GET',
    path: PROVIDER_SETTING_PATH,
    cookie: 'admin',
  })
  return response.body?.value === 'go' ? 'go' : 'node'
}

async function setProvider(options, summary, provider) {
  if (!PROVIDERS.includes(provider))
    throw new Error(`Unknown provider: ${provider}`)
  const response = await requestOne(options, summary, {
    name: `switch provider to ${provider}`,
    kind: 'control',
    baseURL: options.nodeURL,
    expectedBackend: 'node',
    method: 'PUT',
    path: PROVIDER_SETTING_PATH,
    cookie: 'admin',
    body: { value: provider },
  })
  expectEqual(response.name, response.body?.value, provider, 'body.value')
}

async function cleanupReactions(options, summary, state) {
  const cleanup = async (name, action) => {
    try {
      await action()
      summary.cleanup.push({ name, ok: true })
    } catch (error) {
      summary.cleanup.push({ name, ok: false, message: errorMessage(error) })
    }
  }

  await cleanup('force Node provider for cleanup', async () => {
    const response = await cleanupRequest(
      options,
      'PUT',
      PROVIDER_SETTING_PATH,
      {
        value: 'node',
      },
    )
    if (!response.ok)
      throw new Error(`provider cleanup returned ${response.status}`)
  })
  if (state.fingerprints.size > 0) {
    await cleanup('delete temporary reaction fingerprints', async () => {
      deleteFingerprints(options.databasePath, [...state.fingerprints])
    })
  }
  if (state.userAgents.size > 0) {
    await cleanup('delete temporary reaction user agents', async () => {
      deleteUserAgents(options.databasePath, [...state.userAgents])
    })
  }
  if (PROVIDERS.includes(state.originalProvider)) {
    await cleanup(
      `restore backend provider to ${state.originalProvider}`,
      async () => {
        const response = await cleanupRequest(
          options,
          'PUT',
          PROVIDER_SETTING_PATH,
          {
            value: state.originalProvider,
          },
        )
        if (!response.ok)
          throw new Error(`provider restore returned ${response.status}`)
      },
    )
  }
}

async function cleanupRequest(options, method, path, body) {
  const headers = {
    Accept: 'application/json',
    Cookie: options.adminCookie,
    'X-Request-Id': `dual-reactions-cleanup-${randomUUID()}`,
  }
  const init = {
    method,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs),
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return options.fetchImpl(joinBackendURL(options.nodeURL, path), init)
}

function seedRecentReactions(databasePath, fingerprint, count) {
  const database = new Database(databasePath)
  try {
    database.pragma('foreign_keys = ON')
    const insert = database.prepare(`
      INSERT INTO photo_reactions(
        photo_id, reaction_type, fingerprint, ip_address, user_agent,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const now = Math.floor(Date.now() / 1000)
    database.transaction(() => {
      database
        .prepare('DELETE FROM photo_reactions WHERE fingerprint = ?')
        .run(fingerprint)
      for (let index = 0; index < count; index += 1) {
        insert.run(
          PHOTO_ID,
          REACTION_TYPES[index % REACTION_TYPES.length],
          fingerprint,
          '198.51.100.61',
          'dual-reactions-rate-limit',
          now,
          now,
        )
      }
    })()
  } finally {
    database.close()
  }
}

function findReactionFingerprint(databasePath, photoID, userAgent) {
  const database = new Database(databasePath, { readonly: true })
  try {
    const rows = database
      .prepare(
        `SELECT DISTINCT fingerprint
         FROM photo_reactions
         WHERE photo_id = ? AND user_agent = ?`,
      )
      .all(photoID, userAgent)
    if (rows.length !== 1 || !rows[0]?.fingerprint) {
      throw new Error(
        `expected one production fingerprint for ${userAgent}, found ${rows.length}`,
      )
    }
    return rows[0].fingerprint
  } finally {
    database.close()
  }
}

function expectDatabaseReactionCount(
  databasePath,
  fingerprint,
  expected,
  name,
) {
  const database = new Database(databasePath, { readonly: true })
  try {
    const row = database
      .prepare(
        'SELECT COUNT(*) AS count FROM photo_reactions WHERE fingerprint = ?',
      )
      .get(fingerprint)
    expectEqual(name, row?.count, expected, 'database.reactionCount')
  } finally {
    database.close()
  }
}

function deleteFingerprints(databasePath, fingerprints) {
  if (fingerprints.length === 0) return
  const database = new Database(databasePath)
  try {
    const remove = database.prepare(
      'DELETE FROM photo_reactions WHERE fingerprint = ?',
    )
    database.transaction(() => {
      for (const fingerprint of fingerprints) remove.run(fingerprint)
    })()
  } finally {
    database.close()
  }
}

function deleteUserAgents(databasePath, userAgents) {
  if (userAgents.length === 0) return
  const database = new Database(databasePath)
  try {
    const remove = database.prepare(
      'DELETE FROM photo_reactions WHERE user_agent = ?',
    )
    database.transaction(() => {
      for (const userAgent of userAgents) remove.run(userAgent)
    })()
  } finally {
    database.close()
  }
}

function assertDatabaseAvailable(databasePath) {
  if (!existsSync(databasePath)) {
    throw new Error(`shared SQLite database does not exist: ${databasePath}`)
  }
}

function fingerprintHeaders(options, label) {
  return {
    'X-Forwarded-For': '198.51.100.61',
    'User-Agent': `${options.prefix}/${label}/${randomUUID()}`,
    'Accept-Language': 'zh-CN,en;q=0.8',
    'Accept-Encoding': 'identity',
  }
}

export function reactionFingerprint(headers) {
  const value = [
    firstForwardedIP(headers['X-Forwarded-For']),
    headers['User-Agent'] || 'unknown',
    headers['Accept-Language'] || 'unknown',
    headers['Accept-Encoding'] || 'unknown',
  ].join('|')
  return Buffer.from(value).toString('base64')
}

function firstForwardedIP(value) {
  return (
    String(value || 'unknown')
      .split(',', 1)[0]
      .trim() || 'unknown'
  )
}

function expectMutation(name, body, action, reactionType) {
  expectEqual(name, body, { success: true, action, reactionType }, 'body')
}

function comparableBody(body) {
  const value = structuredClone(body)
  if (value && typeof value === 'object') {
    delete value.url
    delete value.stack
  }
  return canonicalize(value)
}

function resolveCookie(options, kind) {
  switch (kind) {
    case undefined:
    case 'admin':
      return options.adminCookie
    case 'anonymous':
      return undefined
    default:
      throw new Error(`Unknown cookie kind: ${kind}`)
  }
}

function otherProvider(provider) {
  return provider === 'node' ? 'go' : 'node'
}

function compactResult(result) {
  return {
    status: result.status,
    backend: result.backend,
    contentType: result.contentType,
  }
}

function expectEqual(name, actual, expected, field) {
  if (
    JSON.stringify(canonicalize(actual)) !==
    JSON.stringify(canonicalize(expected))
  ) {
    throw new ReactionVerificationFailure([
      difference(name, field, expected, actual),
    ])
  }
}

function difference(name, field, expected, actual) {
  return { name, field, expected, actual }
}

function normalizedContentType(value) {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || ''
}

function parseJSON(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { parseError: true, raw: text.slice(0, 500) }
  }
}

function normalizeBaseURL(value) {
  const url = new URL(String(value || '').trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('base URLs must use http or https')
  }
  url.pathname = url.pathname.replace(/\/+$/g, '') || '/'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/g, '')
}

function normalizeCookie(value, label) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`${label} must not be empty`)
  return normalized
}

function normalizeDatabasePath(value) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error('db must not be empty')
  if (normalized.startsWith('file:')) return new URL(normalized).pathname
  return normalized
}

function normalizePrefix(value) {
  const normalized = String(value || '').trim()
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(normalized)) {
    throw new Error(
      'prefix must be 1-64 characters using letters, numbers, dot, underscore, or dash',
    )
  }
  return normalized
}

function positiveInteger(value, label) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return parsed
}

function errorMessage(error) {
  if (error instanceof ReactionVerificationFailure) {
    return JSON.stringify(error.errors)
  }
  return error instanceof Error ? error.message : String(error)
}

class ReactionVerificationFailure extends Error {
  constructor(errors) {
    super(errors.map((error) => `${error.name}: ${error.field}`).join(', '))
    this.name = 'ReactionVerificationFailure'
    this.errors = errors
  }
}

async function main() {
  const result = await verifyDualReactions(parseReactionsVerifierOptions())
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(errorMessage(error))
    process.exitCode = 1
  })
}

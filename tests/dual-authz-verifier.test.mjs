import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AUTHZ_CASES,
  AUTHZ_ERROR_CASES,
  DEFAULT_AUTHZ_ADMIN_COOKIE,
  DEFAULT_AUTHZ_MEMBER_COOKIE,
  parseAuthzVerifierOptions,
  validateAuthzComparison,
  verifyDualAuthz,
} from '../scripts/verify-dual-authz.mjs'

function jsonErrorResponse({ body, backend, status, requestId, setCookie }) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'x-chronoframe-backend': backend,
    'x-request-id': requestId,
  }
  if (setCookie) headers['set-cookie'] = 'cf_session=unexpected'
  return new Response(JSON.stringify(body), { status, headers })
}

function jsonResponse({ body, backend, requestId, status = 200 }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-chronoframe-backend': backend,
      'x-request-id': requestId,
    },
  })
}

function createAuthzFetch({
  driftGoMemberForbidden = false,
  driftGoSystemStatsRuntime = false,
  initialProvider = 'node',
} = {}) {
  const state = { provider: initialProvider }
  const requests = []
  const fetchImpl = async (url, options) => {
    const requestURL = new URL(url)
    const pathname = requestURL.pathname
    const search = requestURL.search
    const directGo = pathname.startsWith('/__lab/go')
    const path = pathname.replace(/^\/__lab\/go/, '') || '/'
    const pathWithSearch = `${path}${search}`
    const backend = directGo ? 'go' : state.provider
    const requestContentType = options.headers['Content-Type']
    const body =
      options.body === undefined
        ? undefined
        : requestContentType === 'application/json'
          ? parseMaybeJSON(options.body)
          : options.body
    const request = {
      backend,
      path: pathWithSearch,
      method: options.method,
      body,
      contentType: requestContentType,
      cookie: options.headers.Cookie,
      requestId: options.headers['X-Request-Id'],
      control:
        pathWithSearch === '/api/system/settings/system/backend.readProvider',
      directGo,
    }
    requests.push(request)

    if (request.control) {
      if (request.method === 'GET') {
        return jsonResponse({
          backend,
          requestId: request.requestId,
          body: {
            namespace: 'system',
            key: 'backend.readProvider',
            value: state.provider,
          },
        })
      }
      if (request.method === 'PUT') {
        state.provider = request.body.value
        return jsonResponse({
          backend: 'node',
          requestId: request.requestId,
          body: {
            namespace: 'system',
            key: 'backend.readProvider',
            value: state.provider,
          },
        })
      }
    }

    const cookieKind =
      request.cookie === 'cf_session=member'
        ? 'member'
        : request.cookie === 'cf_session=admin'
          ? 'admin'
          : 'anonymous'
    const fixtureCase = AUTHZ_CASES.find(
      (testCase) =>
        testCase.method === request.method &&
        testCase.path === pathWithSearch &&
        testCase.cookie === cookieKind &&
        JSON.stringify(expectedRequestBody(testCase)) ===
          JSON.stringify(request.body) &&
        expectedRequestContentType(testCase) === request.contentType,
    )
    if (!fixtureCase) {
      return jsonErrorResponse({
        backend,
        status: 404,
        requestId: request.requestId,
        body: {
          statusCode: 404,
          statusMessage: 'Not Found',
          message: 'Not Found',
        },
      })
    }
    if (fixtureCase.expectedStatus === 200) {
      return jsonResponse({
        backend,
        requestId: request.requestId,
        body: successAuthzBody(fixtureCase, {
          backend,
          driftGoSystemStatsRuntime,
        }),
      })
    }

    let status = fixtureCase.expectedStatus
    let statusMessage = fixtureCase.expectedStatusMessage
    if (
      driftGoMemberForbidden &&
      backend === 'go' &&
      fixtureCase.cookie === 'member' &&
      fixtureCase.expectedStatus === 403
    ) {
      status = 401
      statusMessage = 'Unauthorized'
    }
    return jsonErrorResponse({
      backend,
      status,
      requestId: request.requestId,
      body: {
        error: true,
        url: `http://gateway.test${pathname}`,
        statusCode: status,
        statusMessage,
        message: statusMessage,
        ...(fixtureCase.expectedData === undefined
          ? {}
          : { data: fixtureCase.expectedData }),
        stack: 'ignored dynamic stack',
      },
    })
  }
  return { fetchImpl, requests, state }
}

function parseMaybeJSON(body) {
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

function expectedRequestBody(testCase) {
  if (testCase.rawBody !== undefined) return parseMaybeJSON(testCase.rawBody)
  return testCase.body
}

function expectedRequestContentType(testCase) {
  if (testCase.contentType) return testCase.contentType
  if (testCase.body !== undefined) return 'application/json'
  return undefined
}

function successAuthzBody(testCase, { backend, driftGoSystemStatsRuntime }) {
  if (testCase.bodyComparator === 'canonical') {
    return structuredClone(testCase.expectedBody)
  }
  if (testCase.bodyComparator !== 'member-system-stats') {
    throw new Error(`Unknown success authz test case: ${testCase.name}`)
  }
  return {
    uptime: 0,
    runningOn:
      driftGoSystemStatsRuntime && backend === 'go' ? 'docker' : 'unknown',
    memory: {
      used: driftGoSystemStatsRuntime && backend === 'go' ? 42 : 0,
      total: driftGoSystemStatsRuntime && backend === 'go' ? 100 : 0,
    },
    photos: {
      total: 3,
      today: 1,
      thisWeek: 2,
      thisMonth: 2,
    },
    workerPool: null,
    storage: {
      totalSize: 450,
      averageSize: 150,
      maxSize: 300,
    },
    trends: [
      { date: '2026-09-12', count: 1 },
      { date: '2026-09-11', count: 0 },
      { date: '2026-09-10', count: 1 },
    ],
    timestamp:
      backend === 'node' ? '2026-09-12T03:04:05.006Z' : 'dynamic-ignored',
  }
}

test('dual authz verifier compares representative read-only auth and error boundaries', async () => {
  const gateway = createAuthzFetch()

  const result = await verifyDualAuthz({
    nodeURL: 'http://gateway.test',
    goURL: 'http://gateway.test/__lab/go',
    adminCookie: 'cf_session=admin',
    memberCookie: 'cf_session=member',
    fetchImpl: gateway.fetchImpl,
  })

  assert.equal(result.ok, true)
  assert.equal(result.total, AUTHZ_CASES.length)
  assert.equal(result.failed, 0)
  assert.ok(
    AUTHZ_ERROR_CASES.some(
      (testCase) =>
        testCase.name === 'member hidden display media' &&
        testCase.expectedStatus === 404,
    ),
  )
  assert.equal(
    gateway.requests.filter((request) => !request.control).length,
    AUTHZ_CASES.length * 2,
  )
  assert.deepEqual(
    gateway.requests
      .filter(
        (request) =>
          request.path === '/api/admin/users' && request.method === 'GET',
      )
      .map((request) => [request.backend, request.cookie]),
    [
      ['node', undefined],
      ['go', undefined],
      ['node', 'cf_session=member'],
      ['go', 'cf_session=member'],
    ],
  )
  assert.ok(
    gateway.requests.every((request) =>
      request.requestId.startsWith('dual-authz-'),
    ),
  )
})

test('dual authz verifier reports member system stats body drift', async () => {
  const gateway = createAuthzFetch({ driftGoSystemStatsRuntime: true })

  const result = await verifyDualAuthz({
    nodeURL: 'http://gateway.test',
    goURL: 'http://gateway.test/__lab/go',
    adminCookie: 'cf_session=admin',
    memberCookie: 'cf_session=member',
    fetchImpl: gateway.fetchImpl,
  })

  assert.equal(result.ok, false)
  assert.equal(result.failed, 1)
  assert.deepEqual(
    result.results
      .flatMap((entry) => entry.differences)
      .map((difference) => difference.field),
    ['body.member-system-stats'],
  )
})

test('dual authz verifier forces Node provider and restores the original value', async () => {
  const gateway = createAuthzFetch({ initialProvider: 'go' })

  const result = await verifyDualAuthz({
    nodeURL: 'http://gateway.test',
    goURL: 'http://gateway.test/__lab/go',
    adminCookie: 'cf_session=admin',
    memberCookie: 'cf_session=member',
    fetchImpl: gateway.fetchImpl,
  })

  assert.equal(result.ok, true)
  assert.equal(gateway.state.provider, 'go')
  assert.deepEqual(
    gateway.requests
      .filter((request) => request.control)
      .map((request) => [request.method, request.body?.value ?? null]),
    [
      ['GET', null],
      ['PUT', 'node'],
      ['PUT', 'go'],
    ],
  )
  assert.ok(
    gateway.requests
      .filter((request) => !request.control && !request.directGo)
      .every((request) => request.backend === 'node'),
  )
})

test('dual authz verifier reports forbidden versus unauthorized drift', async () => {
  const gateway = createAuthzFetch({ driftGoMemberForbidden: true })

  const result = await verifyDualAuthz({
    nodeURL: 'http://gateway.test',
    goURL: 'http://gateway.test/__lab/go',
    adminCookie: 'cf_session=admin',
    memberCookie: 'cf_session=member',
    fetchImpl: gateway.fetchImpl,
  })

  assert.equal(result.ok, false)
  assert.equal(result.failed, 2)
  assert.deepEqual(
    result.results
      .flatMap((entry) => entry.differences)
      .filter((difference) => difference.field === 'status')
      .map((difference) => difference.go),
    [401, 401],
  )
})

test('dual authz verifier validation covers response headers and canonical error fields', () => {
  const errors = validateAuthzComparison(
    {
      name: 'member admin users list forbidden',
      expectedStatus: 403,
      expectedStatusMessage: 'Forbidden',
    },
    {
      status: 403,
      backend: 'node',
      contentType: 'application/json',
      setCookie: false,
      requestId: 'request-1',
      responseRequestId: 'request-1',
      errorBody: {
        statusCode: 403,
        statusMessage: 'Forbidden',
        message: 'Forbidden',
        url: 'ignored',
      },
    },
    {
      status: 401,
      backend: 'go',
      contentType: 'text/plain',
      setCookie: true,
      requestId: 'request-1',
      responseRequestId: 'other-request',
      errorBody: {
        statusCode: 401,
        statusMessage: 'Unauthorized',
        message: 'Unauthorized',
        stack: 'ignored',
      },
    },
  )

  assert.deepEqual(
    errors.map((error) => error.field),
    [
      'go.status',
      'go.headers.content-type',
      'go.headers.set-cookie',
      'go.headers.x-request-id',
      'go.body.statusMessage',
      'status',
      'body.error',
    ],
  )
})

test('dual authz verifier validation can require exact error data', () => {
  const errors = validateAuthzComparison(
    {
      name: 'admin duplicate check missing all inputs',
      expectedStatus: 400,
      expectedStatusMessage: 'Missing Required Parameter',
      expectedData: {
        title: 'Missing Required Parameter',
        message:
          'Please provide fileNames, storageKeys or contentHashes parameter',
      },
    },
    {
      status: 400,
      backend: 'node',
      contentType: 'application/json',
      setCookie: false,
      requestId: 'request-1',
      responseRequestId: 'request-1',
      errorBody: {
        statusCode: 400,
        statusMessage: 'Missing Required Parameter',
        message: 'Missing Required Parameter',
        data: {
          title: 'Missing Required Parameter',
          message:
            'Please provide fileNames, storageKeys or contentHashes parameter',
        },
      },
    },
    {
      status: 400,
      backend: 'go',
      contentType: 'application/json',
      setCookie: false,
      requestId: 'request-1',
      responseRequestId: 'request-1',
      errorBody: {
        statusCode: 400,
        statusMessage: 'Missing Required Parameter',
        message: 'Missing Required Parameter',
      },
    },
  )

  assert.deepEqual(
    errors.map((error) => error.field),
    ['go.body.data'],
  )
})

test('dual authz verifier validation checks canonical success bodies against the contract', () => {
  const testCase = {
    name: 'admin LivePhoto scan success shape',
    expectedStatus: 200,
    bodyComparator: 'canonical',
    expectedBody: {
      message: 'Scan completed',
      results: { processed: 0, matched: 0, errors: [] },
    },
  }
  const base = {
    status: 200,
    contentType: 'application/json',
    setCookie: false,
    requestId: 'request-1',
    responseRequestId: 'request-1',
  }
  const node = {
    ...base,
    backend: 'node',
    errorBody: {
      message: 'Scan completed',
      results: { errors: [], matched: 0, processed: 0 },
    },
  }
  const go = {
    ...base,
    backend: 'go',
    errorBody: {
      message: 'Scan completed',
      results: { errors: [], matched: 0, processed: 1 },
    },
  }

  const errors = validateAuthzComparison(testCase, node, go)
  assert.deepEqual(
    errors.map((error) => error.field),
    ['go.body', 'body.canonical'],
  )
})

test('dual authz verifier options default to fixture sessions and dual lab URLs', () => {
  const options = parseAuthzVerifierOptions([], {
    CFRAME_DUAL_PORT: '33105',
  })

  assert.equal(options.base, 'http://127.0.0.1:33105')
  assert.equal(options.nodeURL, 'http://127.0.0.1:33105')
  assert.equal(options.goURL, 'http://127.0.0.1:33105/__lab/go')
  assert.equal(options.adminCookie, DEFAULT_AUTHZ_ADMIN_COOKIE)
  assert.equal(options.memberCookie, DEFAULT_AUTHZ_MEMBER_COOKIE)
  assert.equal(options.timeoutMs, 5_000)
})

test('dual authz verifier options accept explicit endpoints and cookies', () => {
  const options = parseAuthzVerifierOptions(
    [
      '--',
      '--base',
      'http://gateway.test/prefix/',
      '--node',
      'http://node.test/',
      '--go',
      'http://go.test/api/',
      '--admin-cookie',
      'cf_session=admin',
      '--member-cookie',
      'cf_session=member',
      '--timeout-ms',
      '2500',
    ],
    {},
  )

  assert.deepEqual(options, {
    base: 'http://gateway.test/prefix',
    nodeURL: 'http://node.test',
    goURL: 'http://go.test/api',
    adminCookie: 'cf_session=admin',
    memberCookie: 'cf_session=member',
    timeoutMs: 2_500,
  })
})

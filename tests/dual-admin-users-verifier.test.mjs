import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ADMIN_USER_BOUNDARY_CASES,
  ADMIN_USER_ROUTE_IDS,
  DEFAULT_ADMIN_USERS_ADMIN_COOKIE,
  DEFAULT_ADMIN_USERS_MEMBER_COOKIE,
  parseAdminUsersVerifierOptions,
  validateAdminUserPair,
} from '../scripts/verify-dual-admin-users.mjs'

test('admin users verifier owns the complete users-admin route slice', () => {
  const contract = JSON.parse(
    readFileSync(
      new URL('../backend/contracts/routes.yaml', import.meta.url),
      'utf8',
    ),
  )
  const routes = contract.routes.filter(
    (route) => route.capability === 'users-admin',
  )

  assert.deepEqual(
    [...ADMIN_USER_ROUTE_IDS].sort(),
    routes.map((route) => route.id).sort(),
  )
  assert.equal(routes.length, 4)
  assert.ok(routes.every((route) => route.maturity.go === 'verified'))
})

test('admin users verifier covers deep auth, validation, conflict, and guard boundaries', () => {
  const names = ADMIN_USER_BOUNDARY_CASES.map((testCase) => testCase.name)
  const methods = new Set(
    ADMIN_USER_BOUNDARY_CASES.map((testCase) => testCase.method),
  )

  assert.equal(ADMIN_USER_BOUNDARY_CASES.length, 49)
  assert.deepEqual([...methods].sort(), ['DELETE', 'GET', 'PATCH', 'POST'])
  for (const fragment of [
    'anonymous',
    'member',
    'missing body',
    'malformed JSON',
    'UTF-16',
    'duplicate email',
    'duplicate username',
    'hexadecimal path',
    'unsafe integer path',
    'cannot demote own',
    'cannot disable own',
    'cannot delete own',
  ]) {
    assert.ok(
      names.some((name) => name.includes(fragment)),
      `missing boundary coverage for ${fragment}`,
    )
  }
})

test('admin user pair validation compares nested Zod data and ignores only diagnostics', () => {
  const testCase = {
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }
  const base = {
    status: 400,
    contentType: 'application/json; charset=utf-8',
    setCookie: false,
    requestID: 'request-1',
    responseRequestID: 'request-1',
    location: null,
    body: {
      error: true,
      statusCode: 400,
      statusMessage: 'Validation Error',
      message: '[validation details]',
      data: { name: 'ZodError', message: '[validation details]' },
      url: '/dynamic',
      stack: 'dynamic stack',
    },
  }
  const node = { ...structuredClone(base), backend: 'node' }
  const go = { ...structuredClone(base), backend: 'go' }
  go.body.url = '/__lab/go/dynamic'
  go.body.stack = 'other dynamic stack'

  assert.deepEqual(validateAdminUserPair(testCase, node, go), [])

  go.body.data.message = '[drift]'
  assert.equal(validateAdminUserPair(testCase, node, go)[0]?.field, 'body')
})

test('admin users verifier options derive lab URL and fixture sessions', () => {
  const defaults = parseAdminUsersVerifierOptions([])
  assert.equal(defaults.nodeURL, 'http://127.0.0.1:3000')
  assert.equal(defaults.goURL, 'http://127.0.0.1:3000/__lab/go')
  assert.equal(defaults.adminCookie, DEFAULT_ADMIN_USERS_ADMIN_COOKIE)
  assert.equal(defaults.memberCookie, DEFAULT_ADMIN_USERS_MEMBER_COOKIE)

  const explicit = parseAdminUsersVerifierOptions([
    '--base',
    'http://gateway/root/',
    '--node',
    'http://node:3000/',
    '--go',
    'http://go:8080/',
    '--timeout-ms',
    '2500',
  ])
  assert.equal(explicit.baseURL, 'http://gateway/root')
  assert.equal(explicit.nodeURL, 'http://node:3000')
  assert.equal(explicit.goURL, 'http://go:8080')
  assert.equal(explicit.timeoutMs, 2500)
})

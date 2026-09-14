import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  DEFAULT_SETTINGS_CONTROL_ADMIN_COOKIE,
  DEFAULT_SETTINGS_CONTROL_MEMBER_COOKIE,
  SETTINGS_CONTROL_BOUNDARY_CASES,
  SETTINGS_CONTROL_READ_CASES,
  SETTINGS_CONTROL_ROUTE_IDS,
  parseSettingsControlVerifierOptions,
  validateSettingsControlPair,
} from '../scripts/verify-dual-settings-control.mjs'

test('settings-control verifier owns all settings-control routes', () => {
  const contract = JSON.parse(
    readFileSync(
      new URL('../backend/contracts/routes.yaml', import.meta.url),
      'utf8',
    ),
  )
  const routes = contract.routes.filter(
    (route) => route.capability === 'settings-control',
  )
  assert.deepEqual(
    [...SETTINGS_CONTROL_ROUTE_IDS].sort(),
    routes.map((route) => route.id).sort(),
  )
  assert.equal(routes.length, 11)
  assert.ok(
    routes.every((route) => route.maturity.go === 'verified'),
    'all settings-control routes must remain verified after the production gate',
  )
})

test('settings-control matrix covers reads, authorization, validation, coercion, and all storage unions', () => {
  assert.ok(SETTINGS_CONTROL_READ_CASES.length >= 13)
  assert.ok(SETTINGS_CONTROL_BOUNDARY_CASES.length >= 100)
  const names = [
    ...SETTINGS_CONTROL_READ_CASES,
    ...SETTINGS_CONTROL_BOUNDARY_CASES,
  ].map((testCase) => testCase.name)
  for (const fragment of [
    'globally valid key in another namespace',
    'anonymous namespace read',
    'member storage config create',
    'readonly setting',
    'enum setting',
    'batch update with trailing JSON',
    'storage configuration decimal prefix id',
    'hex storage config id uses decimal radix',
    'local storage create missing fields',
    's3 storage create missing fields',
    'openlist storage create missing fields',
    'storage update rejects wrong nested literal',
  ]) {
    assert.ok(
      names.some((name) => name.includes(fragment)),
      `missing settings-control coverage for ${fragment}`,
    )
  }
})

test('settings-control pair validation compares exact bodies and response metadata', () => {
  const testCase = {
    name: 'exact setting error',
    expectedStatus: 400,
  }
  const base = {
    status: 400,
    contentType: 'application/json',
    requestID: 'settings-request',
    responseRequestID: 'settings-request',
    setCookie: false,
    body: {
      error: true,
      statusCode: 400,
      statusMessage: 'Validation Error',
      message: 'same',
      data: { name: 'ZodError', message: 'same' },
      url: '/dynamic',
      stack: 'dynamic stack',
    },
  }
  const node = { ...structuredClone(base), backend: 'node' }
  const go = { ...structuredClone(base), backend: 'go' }
  go.body.url = '/__lab/go/dynamic'
  go.body.stack = 'different stack'
  assert.deepEqual(validateSettingsControlPair(testCase, node, go), [])

  go.body.data.message = 'drift'
  assert.ok(validateSettingsControlPair(testCase, node, go).length > 0)
  go.body.data.message = 'same'
  go.setCookie = true
  assert.ok(validateSettingsControlPair(testCase, node, go).length > 0)
})

test('settings-control verifier options include shared database and fixture identities', () => {
  assert.deepEqual(
    parseSettingsControlVerifierOptions([], { CFRAME_DUAL_PORT: '33131' }),
    {
      base: 'http://127.0.0.1:33131',
      nodeURL: 'http://127.0.0.1:33131',
      goURL: 'http://127.0.0.1:33131/__lab/go',
      adminCookie: DEFAULT_SETTINGS_CONTROL_ADMIN_COOKIE,
      memberCookie: DEFAULT_SETTINGS_CONTROL_MEMBER_COOKIE,
      databasePath: './data/app.sqlite3',
      timeoutMs: 5000,
      prefix: 'dual-settings',
    },
  )
})

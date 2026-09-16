import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ALBUM_BOUNDARY_CASES,
  ALBUM_ROUTE_IDS,
  DEFAULT_ALBUMS_ADMIN_COOKIE,
  DEFAULT_ALBUMS_MEMBER_COOKIE,
  parseAlbumsVerifierOptions,
  validateAlbumPair,
} from '../scripts/verify-dual-albums.mjs'

test('album verifier owns the complete album read/write route slice', () => {
  const contract = JSON.parse(
    readFileSync(
      new URL('../backend/contracts/routes.yaml', import.meta.url),
      'utf8',
    ),
  )
  const albumRoutes = contract.routes.filter((route) =>
    ['albums-read', 'albums-write'].includes(route.capability),
  )
  const contractIDs = albumRoutes.map((route) => route.id).sort()

  assert.deepEqual([...ALBUM_ROUTE_IDS].sort(), contractIDs)
  assert.equal(contractIDs.length, 10)
  assert.ok(
    albumRoutes.every((route) => route.maturity.go === 'verified'),
    'all album routes must stay verified after the production parity gate',
  )
})

test('album verifier covers auth, ownership, validation, and missing resources', () => {
  const names = ALBUM_BOUNDARY_CASES.map((testCase) => testCase.name)
  const methods = new Set(
    ALBUM_BOUNDARY_CASES.map((testCase) => testCase.method),
  )

  assert.deepEqual([...methods].sort(), ['DELETE', 'GET', 'POST', 'PUT'])
  for (const fragment of [
    'anonymous',
    'another owner',
    'invalid album',
    'missing title',
    'invalid field types',
    'missing relation',
    'non-positive album id',
    'invalid mode',
    'missing photo',
    'missing album',
  ]) {
    assert.ok(
      names.some((name) => name.includes(fragment)),
      `missing boundary coverage for ${fragment}`,
    )
  }
})

test('album pair validation compares nested error data but ignores dynamic diagnostics', () => {
  const testCase = {
    name: 'validation parity',
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
    kind: 'boundary',
  }
  const base = {
    status: 400,
    contentType: 'application/json',
    setCookie: false,
    requestID: 'request-1',
    responseRequestID: 'request-1',
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

  assert.deepEqual(validateAlbumPair(testCase, node, go), [])

  go.body.data.message = '[drift]'
  assert.equal(validateAlbumPair(testCase, node, go)[0]?.field, 'body')
})

test('album verifier options default to shared fixture sessions and lab URLs', () => {
  assert.deepEqual(
    parseAlbumsVerifierOptions([], { CFRAME_DUAL_PORT: '33129' }),
    {
      base: 'http://127.0.0.1:33129',
      nodeURL: 'http://127.0.0.1:33129',
      goURL: 'http://127.0.0.1:33129/__lab/go',
      adminCookie: DEFAULT_ALBUMS_ADMIN_COOKIE,
      memberCookie: DEFAULT_ALBUMS_MEMBER_COOKIE,
      timeoutMs: 5000,
      prefix: 'dual-albums',
    },
  )
})

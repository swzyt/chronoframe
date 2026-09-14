import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  DEFAULT_PHOTOS_READ_ADMIN_COOKIE,
  DEFAULT_PHOTOS_READ_MEMBER_COOKIE,
  PHOTOS_READ_BOUNDARY_CASES,
  PHOTOS_READ_CASES,
  PHOTOS_READ_DUPLICATE_CASES,
  PHOTOS_READ_ROUTE_IDS,
  parsePhotosReadVerifierOptions,
  validatePhotosReadPair,
} from '../scripts/verify-dual-photos-read.mjs'

test('photos-read verifier owns the complete route slice', () => {
  const contract = JSON.parse(
    readFileSync(
      new URL('../backend/contracts/routes.yaml', import.meta.url),
      'utf8',
    ),
  )
  const routes = contract.routes.filter(
    (route) => route.capability === 'photos-read',
  )
  assert.deepEqual(
    [...PHOTOS_READ_ROUTE_IDS].sort(),
    routes.map((route) => route.id).sort(),
  )
  assert.equal(routes.length, 5)
  assert.ok(routes.every((route) => route.maturity.go === 'verified'))
})

test('photos-read gate covers caps, ownership, filters, maps, status, and duplicates', () => {
  const names = [
    ...PHOTOS_READ_CASES.map((testCase) => testCase.name),
    ...PHOTOS_READ_BOUNDARY_CASES.map((testCase) => testCase.name),
    ...PHOTOS_READ_DUPLICATE_CASES.map((testCase) => testCase.name),
  ]
  for (const fragment of [
    'capped at 500',
    'owner scoped',
    'pagination',
    'meta-only',
    'image filter',
    'video filter',
    'antimeridian',
    'large result sets',
    'high zoom',
    'photo status',
    'empty array',
    'normalizes',
    'file names and storage keys',
  ]) {
    assert.ok(
      names.some((name) => name.includes(fragment)),
      `missing photos-read coverage for ${fragment}`,
    )
  }
})

test('photos-read pair validation compares complete bodies with timestamp normalization', () => {
  const testCase = {
    name: 'photo status parity',
    expectedStatus: 200,
    normalizers: ['/timestamp'],
  }
  const base = {
    status: 200,
    contentType: 'application/json',
    requestID: 'photos-read-request',
    body: {
      recentPhotos: [{ id: 'photo-1', ownerUserId: 1 }],
      timestamp: 'node-time',
    },
  }
  const node = { ...structuredClone(base), backend: 'node' }
  const go = { ...structuredClone(base), backend: 'go' }
  go.body.timestamp = 'go-time'

  assert.deepEqual(validatePhotosReadPair(testCase, node, go), [])
  go.body.recentPhotos[0].id = 'drift'
  assert.ok(validatePhotosReadPair(testCase, node, go).length >= 1)
})

test('photos-read options target the production fixture database and both sessions', () => {
  assert.deepEqual(
    parsePhotosReadVerifierOptions([], { CFRAME_DUAL_PORT: '33124' }),
    {
      base: 'http://127.0.0.1:33124',
      nodeURL: 'http://127.0.0.1:33124',
      goURL: 'http://127.0.0.1:33124/__lab/go',
      adminCookie: DEFAULT_PHOTOS_READ_ADMIN_COOKIE,
      memberCookie: DEFAULT_PHOTOS_READ_MEMBER_COOKIE,
      databasePath: './data/app.sqlite3',
      timeoutMs: 10000,
      prefix: 'dual-photos-read',
    },
  )
})

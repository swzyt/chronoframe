import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  MEDIA_READ_ROUTE_IDS,
  MEDIA_READ_SCENARIOS,
  parseMediaReadVerifierOptions,
  validateMediaReadPair,
} from '../scripts/verify-dual-media-read.mjs'

test('media-read verifier owns the complete media-read route slice', () => {
  const contract = JSON.parse(
    readFileSync(
      new URL('../backend/contracts/routes.yaml', import.meta.url),
      'utf8',
    ),
  )
  const routes = contract.routes.filter(
    (route) => route.capability === 'media-read',
  )
  assert.deepEqual(
    [...MEDIA_READ_ROUTE_IDS].sort(),
    routes.map((route) => route.id).sort(),
  )
  assert.equal(routes.length, 8)
  assert.ok(
    routes.every((route) => route.maturity.go === 'verified'),
    'all media-read routes must remain verified after the production gate',
  )
})

test('media-read scenarios cover protocol, signing, auth, and path boundaries', () => {
  assert.ok(MEDIA_READ_SCENARIOS.length >= 12)
  const text = MEDIA_READ_SCENARIOS.join('\n')
  for (const fragment of [
    'HEAD',
    'conditional ranges',
    'cache validators',
    'explicit original key',
    'legacy',
    'Live Photo',
    'authorization',
    'traversal',
  ]) {
    assert.match(text, new RegExp(fragment))
  }
})

test('media-read pair validation includes validators and exact payloads', () => {
  const base = {
    status: 200,
    contentType: 'image/png',
    cacheControl: 'private, max-age=86400',
    acceptRanges: 'bytes',
    contentRange: null,
    etag: 'W/"1-key"',
    lastModified: 'Mon, 14 Sep 2026 00:00:00 GMT',
    vary: 'Cookie',
    byteLength: 1,
    sha256: 'same',
    body: null,
  }
  assert.deepEqual(validateMediaReadPair('same', base, { ...base }), [])
  assert.ok(
    validateMediaReadPair('etag drift', base, {
      ...base,
      etag: 'W/"1-other"',
    }).length > 0,
  )
  assert.ok(
    validateMediaReadPair('body drift', base, {
      ...base,
      sha256: 'different',
    }).length > 0,
  )
})

test('media-read verifier options support the shared database gate', () => {
  assert.deepEqual(
    parseMediaReadVerifierOptions([], { CFRAME_DUAL_PORT: '33124' }),
    {
      base: 'http://127.0.0.1:33124',
      cookie: 'cf_session=Q0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0M',
      databasePath: './data/app.sqlite3',
      prefix: 'dual-media-read',
      timeoutMs: 10000,
    },
  )
})

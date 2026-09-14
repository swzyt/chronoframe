import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  DEFAULT_REACTIONS_ADMIN_COOKIE,
  REACTION_BOUNDARY_CASES,
  REACTION_READ_CASES,
  REACTION_ROUTE_IDS,
  parseReactionsVerifierOptions,
  reactionFingerprint,
  validateReactionPair,
} from '../scripts/verify-dual-reactions.mjs'

test('reaction verifier owns the complete reaction read/write route slice', () => {
  const contract = JSON.parse(
    readFileSync(
      new URL('../backend/contracts/routes.yaml', import.meta.url),
      'utf8',
    ),
  )
  const reactionRoutes = contract.routes.filter((route) =>
    ['reactions-read', 'reactions-write'].includes(route.capability),
  )
  const contractIDs = reactionRoutes.map((route) => route.id).sort()

  assert.deepEqual([...REACTION_ROUTE_IDS].sort(), contractIDs)
  assert.equal(contractIDs.length, 4)
  assert.ok(
    reactionRoutes.every((route) => route.maturity.go === 'verified'),
    'all reaction routes must remain verified after the production gate',
  )
})

test('reaction verifier covers access, parsing, query coercion, and rate limiting', () => {
  const names = [
    ...REACTION_READ_CASES.map((testCase) => testCase.name),
    ...REACTION_BOUNDARY_CASES.map((testCase) => testCase.name),
  ]

  for (const fragment of [
    'hidden photo',
    'missing photo',
    'whitespace photo id',
    'empty id query',
    'repeated empty query',
    'malformed JSON',
    'trailing JSON',
    'null body',
    'unknown reaction type',
  ]) {
    assert.ok(
      names.some((name) => name.includes(fragment)),
      `missing reaction coverage for ${fragment}`,
    )
  }
  assert.deepEqual(
    REACTION_BOUNDARY_CASES.find(
      (testCase) => testCase.name === 'create reaction checks missing photo',
    )?.body,
    { reactionType: 'like' },
  )
})

test('reaction pair validation compares full bodies but ignores dynamic diagnostics', () => {
  const testCase = {
    name: 'reaction error parity',
    expectedStatus: 400,
    expectedStatusMessage: 'Server Error',
    expectedMessage: 'Invalid reaction type',
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
      statusMessage: 'Server Error',
      message: 'Invalid reaction type',
      url: '/dynamic',
      stack: 'dynamic stack',
    },
  }
  const node = { ...structuredClone(base), backend: 'node' }
  const go = { ...structuredClone(base), backend: 'go' }
  go.body.url = '/__lab/go/dynamic'
  go.body.stack = 'different stack'

  assert.deepEqual(validateReactionPair(testCase, node, go), [])

  go.body.message = 'drift'
  assert.ok(validateReactionPair(testCase, node, go).length >= 1)
})

test('reaction verifier derives the same base64 fingerprint as both runtimes', () => {
  assert.equal(
    reactionFingerprint({
      'X-Forwarded-For': '198.51.100.61, 10.0.0.1',
      'User-Agent': 'reaction-test',
      'Accept-Language': 'zh-CN',
      'Accept-Encoding': 'identity',
    }),
    Buffer.from('198.51.100.61|reaction-test|zh-CN|identity').toString(
      'base64',
    ),
  )
})

test('reaction verifier options include the production fixture database', () => {
  assert.deepEqual(
    parseReactionsVerifierOptions([], { CFRAME_DUAL_PORT: '33129' }),
    {
      base: 'http://127.0.0.1:33129',
      nodeURL: 'http://127.0.0.1:33129',
      goURL: 'http://127.0.0.1:33129/__lab/go',
      adminCookie: DEFAULT_REACTIONS_ADMIN_COOKIE,
      databasePath: './data/app.sqlite3',
      timeoutMs: 5000,
      prefix: 'dual-reactions',
    },
  )
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  DEFAULT_SYSTEM_READS_ADMIN_COOKIE,
  DEFAULT_SYSTEM_READS_MEMBER_COOKIE,
  SYSTEM_READ_CASES,
  SYSTEM_READ_ROUTE_IDS,
  normalizeSystemReadBody,
  parseSystemReadsVerifierOptions,
} from '../scripts/verify-dual-system-reads.mjs'

test('system-read verifier owns both remaining read routes', () => {
  const contract = JSON.parse(
    readFileSync(
      new URL('../backend/contracts/routes.yaml', import.meta.url),
      'utf8',
    ),
  )
  const routes = contract.routes.filter((route) =>
    ['settings-public-read', 'system-observability'].includes(route.capability),
  )
  const selected = routes.filter((route) =>
    SYSTEM_READ_ROUTE_IDS.includes(route.id),
  )
  assert.deepEqual(
    selected.map((route) => route.id).sort(),
    [...SYSTEM_READ_ROUTE_IDS].sort(),
  )
})

test('system capability gates promote every covered route to verified', () => {
  const contract = JSON.parse(
    readFileSync(
      new URL('../backend/contracts/routes.yaml', import.meta.url),
      'utf8',
    ),
  )
  const routeIds = [
    'settings.public.read',
    'system.stats',
    'system.logs',
    'system.backup.run',
  ]
  assert.deepEqual(
    routeIds.map(
      (id) => contract.routes.find((route) => route.id === id)?.maturity.go,
    ),
    routeIds.map(() => 'verified'),
  )
})

test('system-read gate covers decoding, privacy, scope, and provider switching', () => {
  for (const fragment of [
    'every persisted type',
    'exclude private',
    'rejected',
    'global photos',
    'owner scoped',
    'provider switch',
  ]) {
    assert.ok(
      SYSTEM_READ_CASES.some((name) => name.includes(fragment)),
      `missing system-read coverage for ${fragment}`,
    )
  }
})

test('system-read normalization removes only runtime-specific admin fields', () => {
  const input = {
    uptime: 10,
    runningOn: 'docker',
    memory: { used: 20, total: 100 },
    photos: { total: 1 },
    workerPool: { workers: [{ workerId: 'one', uptime: 4 }] },
    timestamp: 'dynamic',
  }
  assert.deepEqual(normalizeSystemReadBody('system.stats', input, 'admin'), {
    runningOn: 'docker',
    memory: { total: 100 },
    photos: { total: 1 },
    workerPool: { workers: [{ workerId: 'one' }] },
  })
  assert.equal(input.timestamp, 'dynamic')
  assert.equal(input.memory.used, 20)
})

test('system-read options target the shared production database and sessions', () => {
  assert.deepEqual(
    parseSystemReadsVerifierOptions([], { CFRAME_DUAL_PORT: '33125' }),
    {
      base: 'http://127.0.0.1:33125',
      nodeURL: 'http://127.0.0.1:33125',
      goURL: 'http://127.0.0.1:33125/__lab/go',
      adminCookie: DEFAULT_SYSTEM_READS_ADMIN_COOKIE,
      memberCookie: DEFAULT_SYSTEM_READS_MEMBER_COOKIE,
      databasePath: './data/app.sqlite3',
      timeoutMs: 10000,
      prefix: 'dual-system-reads',
    },
  )
})

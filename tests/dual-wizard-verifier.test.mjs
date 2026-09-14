import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  WIZARD_CASES,
  WIZARD_ROUTE_IDS,
  parseWizardVerifierOptions,
} from '../scripts/verify-dual-wizard.mjs'

test('wizard verifier owns the complete setup route family', () => {
  const contract = JSON.parse(
    readFileSync(
      new URL('../backend/contracts/routes.yaml', import.meta.url),
      'utf8',
    ),
  )
  const setupRoutes = contract.routes
    .filter((route) => route.capability === 'setup')
    .map((route) => route.id)
    .sort()
  assert.deepEqual(setupRoutes, [...WIZARD_ROUTE_IDS].sort())
})

test('every wizard route is verified for Go after the production gate', () => {
  const contract = JSON.parse(
    readFileSync(
      new URL('../backend/contracts/routes.yaml', import.meta.url),
      'utf8',
    ),
  )
  const routesByID = new Map(contract.routes.map((route) => [route.id, route]))

  for (const routeID of WIZARD_ROUTE_IDS) {
    assert.equal(routesByID.get(routeID)?.maturity.go, 'verified', routeID)
  }
})

test('wizard gate covers schema, validation, persistence, sessions, and cleanup', () => {
  for (const fragment of [
    'schema namespaces',
    'Zod validation',
    'cross-runtime identity',
    'S3 defaults',
    'OpenList defaults',
    'Mapbox, MapLibre, and AMap',
    'closes every setup-only route',
    'cross-runtime session',
    'cleanup',
  ]) {
    assert.ok(
      WIZARD_CASES.some((entry) => entry.includes(fragment)),
      `missing wizard coverage for ${fragment}`,
    )
  }
})

test('wizard verifier options target the shared Compose services', () => {
  assert.deepEqual(
    parseWizardVerifierOptions([], {
      CFRAME_DUAL_PORT: '33125',
      CFRAME_DUAL_REDIS_PORT: '36425',
    }),
    {
      base: 'http://127.0.0.1:33125',
      nodeURL: 'http://127.0.0.1:33125',
      goURL: 'http://127.0.0.1:33125/__lab/go',
      databasePath: './data/app.sqlite3',
      redisURL: 'redis://127.0.0.1:36425/0',
      redisPassword: 'chronoframe-development-only-change-me',
      settingsVersionKey: 'chronoframe:settings:version',
      timeoutMs: 10000,
    },
  )
})

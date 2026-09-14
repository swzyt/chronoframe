import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  normalizeSmokeProjectName,
  parseDefaultSettingsCount,
  parseGoMigratorVerifierOptions,
  parseMigrationSummary,
  parseTaggedJSON,
  verifyGoMigratorDatabaseAudit,
} from '../scripts/verify-go-migrator.mjs'

test('Go migrator verifier options use an isolated safe Compose project', () => {
  const options = parseGoMigratorVerifierOptions([], {
    CFRAME_GO_MIGRATOR_VERIFY_SUFFIX: 'unit-1',
  })

  assert.equal(options.project, 'chronoframe-go-migrator-smoke-unit-1')
  assert.equal(options.port, 33106)
  assert.equal(options.redisPort, 36380)
  assert.equal(options.timeoutMs, 60_000)
  assert.equal(options.keep, false)
})

test('Go migrator verifier rejects unsafe project names before cleanup', () => {
  assert.throws(
    () => normalizeSmokeProjectName('chronoframe-dual'),
    /cleanup cannot target unrelated Compose projects/,
  )
  assert.throws(
    () =>
      parseGoMigratorVerifierOptions(['--project', 'production'], {
        CFRAME_GO_MIGRATOR_VERIFY_SUFFIX: 'unit-2',
      }),
    /cleanup cannot target unrelated Compose projects/,
  )
})

test('Go migrator verifier parses generated source counts', () => {
  assert.deepEqual(
    parseMigrationSummary(`
      {CreatedAtMillis: 1000, Hash: "a"},
      {CreatedAtMillis: 3000, Hash: "b"},
      {CreatedAtMillis: 2000, Hash: "c"},
    `),
    { count: 3, latest: 3000 },
  )
  assert.equal(
    parseDefaultSettingsCount(`
      {Key: "backend.readProvider"},
      {Key: "title"},
    `),
    2,
  )
})

test('Go migrator verifier parses tagged JSON from noisy Compose output', () => {
  assert.deepEqual(
    parseTaggedJSON(`container logs\n__CFRAME_GO_MIGRATOR_AUDIT__{"ok":true}`),
    { ok: true },
  )
})

test('Go migrator verifier validates migration ledger and backend setting', () => {
  const audit = {
    migrations: { count: 24, latest: 1789137245151 },
    settings: { count: 51 },
    backend: {
      value: 'node',
      default_value: 'node',
      enum: '["node","go"]',
    },
    integrity: [{ integrity_check: 'ok' }],
    foreignKeys: [],
  }

  assert.deepEqual(
    verifyGoMigratorDatabaseAudit(audit, {
      migrations: { count: 24, latest: 1789137245151 },
      defaultSettingsCount: 51,
    }),
    [],
  )

  assert.deepEqual(
    verifyGoMigratorDatabaseAudit(
      { ...audit, backend: { ...audit.backend, enum: '["node"]' } },
      {
        migrations: { count: 24, latest: 1789137245151 },
        defaultSettingsCount: 51,
      },
    ).map((error) => error.field),
    ['backend.readProvider.enum'],
  )
})

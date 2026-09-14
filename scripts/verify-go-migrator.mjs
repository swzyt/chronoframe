#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const AUDIT_TAG = '__CFRAME_GO_MIGRATOR_AUDIT__'
const DEFAULT_PROJECT_PREFIX = 'chronoframe-go-migrator-smoke'
const DEFAULT_HTTP_PORT = 33106
const DEFAULT_REDIS_PORT = 36380
const DEFAULT_TIMEOUT_MS = 60_000
const COMPOSE_FILES = [
  '-f',
  'deploy/dual/compose.yaml',
  '-f',
  'deploy/dual/compose.go-migrator.yaml',
]

export function parseGoMigratorVerifierOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const values = new Map()
  let keep = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--keep') {
      keep = true
      continue
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`)
    }
    if (
      !['--project', '--port', '--redis-port', '--timeout-ms'].includes(arg)
    ) {
      throw new Error(`Unknown option: ${arg}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`)
    }
    values.set(arg, value)
    index += 1
  }

  const suffix =
    environment.CFRAME_GO_MIGRATOR_VERIFY_SUFFIX ||
    `${process.pid}-${Date.now()}`
  return {
    project: normalizeSmokeProjectName(
      values.get('--project') ||
        environment.CFRAME_GO_MIGRATOR_VERIFY_PROJECT ||
        `${DEFAULT_PROJECT_PREFIX}-${suffix}`,
    ),
    port: parsePort(
      values.get('--port') ||
        environment.CFRAME_GO_MIGRATOR_VERIFY_PORT ||
        environment.CFRAME_DUAL_PORT ||
        DEFAULT_HTTP_PORT,
      'port',
    ),
    redisPort: parsePort(
      values.get('--redis-port') ||
        environment.CFRAME_GO_MIGRATOR_VERIFY_REDIS_PORT ||
        environment.CFRAME_DUAL_REDIS_PORT ||
        DEFAULT_REDIS_PORT,
      'redis-port',
    ),
    timeoutMs: parsePositiveInteger(
      values.get('--timeout-ms') ||
        environment.CFRAME_GO_MIGRATOR_VERIFY_TIMEOUT_MS ||
        DEFAULT_TIMEOUT_MS,
      'timeout-ms',
    ),
    keep,
  }
}

export function normalizeSmokeProjectName(value) {
  const project = String(value || '').trim().toLowerCase()
  if (!/^chronoframe-go-migrator-[a-z0-9-]+$/.test(project)) {
    throw new Error(
      'project must match chronoframe-go-migrator-[a-z0-9-]+ so cleanup cannot target unrelated Compose projects',
    )
  }
  return project
}

export function parsePort(value, label) {
  const port = parsePositiveInteger(value, label)
  if (port > 65_535) {
    throw new Error(`${label} must be 65535 or less`)
  }
  return port
}

export function parsePositiveInteger(value, label) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return number
}

export function parseMigrationSummary(source) {
  const migrations = [...source.matchAll(/CreatedAtMillis:\s*(\d+)/g)].map(
    (match) => Number(match[1]),
  )
  if (migrations.length === 0) {
    throw new Error('could not find generated Go migrations')
  }
  return {
    count: migrations.length,
    latest: Math.max(...migrations),
  }
}

export function parseDefaultSettingsCount(source) {
  const count = [...source.matchAll(/\bKey:\s*"[^"]+"/g)].length
  if (count === 0) {
    throw new Error('could not find generated Go default settings')
  }
  return count
}

export function parseTaggedJSON(output, tag = AUDIT_TAG) {
  const line = String(output)
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(tag))
  if (!line) {
    throw new Error(`could not find ${tag} line in command output`)
  }
  return JSON.parse(line.slice(tag.length))
}

export function verifyGoMigratorDatabaseAudit(audit, expected) {
  const errors = []

  if (audit.migrations?.count !== expected.migrations.count) {
    errors.push({
      field: 'migrations.count',
      expected: expected.migrations.count,
      actual: audit.migrations?.count,
    })
  }
  if (audit.migrations?.latest !== expected.migrations.latest) {
    errors.push({
      field: 'migrations.latest',
      expected: expected.migrations.latest,
      actual: audit.migrations?.latest,
    })
  }
  if (audit.settings?.count !== expected.defaultSettingsCount) {
    errors.push({
      field: 'settings.count',
      expected: expected.defaultSettingsCount,
      actual: audit.settings?.count,
    })
  }
  const backend = audit.backend || {}
  if (backend.value !== 'node') {
    errors.push({
      field: 'backend.readProvider.value',
      expected: 'node',
      actual: backend.value,
    })
  }
  if (backend.default_value !== 'node') {
    errors.push({
      field: 'backend.readProvider.default_value',
      expected: 'node',
      actual: backend.default_value,
    })
  }
  if (backend.enum !== '["node","go"]') {
    errors.push({
      field: 'backend.readProvider.enum',
      expected: '["node","go"]',
      actual: backend.enum,
    })
  }
  if (audit.integrity?.[0]?.integrity_check !== 'ok') {
    errors.push({
      field: 'integrity_check',
      expected: 'ok',
      actual: audit.integrity,
    })
  }
  if ((audit.foreignKeys || []).length !== 0) {
    errors.push({
      field: 'foreign_key_check',
      expected: [],
      actual: audit.foreignKeys,
    })
  }

  return errors
}

export async function verifyGoMigrator({
  project,
  port,
  redisPort,
  timeoutMs,
  keep = false,
  fetchImpl = globalThis.fetch,
} = parseGoMigratorVerifierOptions()) {
  const options = {
    project: normalizeSmokeProjectName(project),
    port: parsePort(port, 'port'),
    redisPort: parsePort(redisPort, 'redis-port'),
    timeoutMs: parsePositiveInteger(timeoutMs, 'timeout-ms'),
    keep,
  }
  const summary = {
    ok: false,
    project: options.project,
    port: options.port,
    redisPort: options.redisPort,
    keep: options.keep,
    checks: [],
  }

  try {
    runCompose(options, ['up', '--build', '-d'])
    summary.checks.push({
      name: 'compose up with Go migrator override',
      ok: true,
    })

    summary.migratorLogs = runCompose(options, [
      'logs',
      '--no-color',
      'go-migrator',
    ])

    const httpChecks = await waitForGoMigratorHTTP(options, fetchImpl)
    summary.checks.push(...httpChecks)

    const audit = parseTaggedJSON(
      runCompose(options, [
        '--profile',
        'tools',
        'run',
        '--rm',
        '--build',
        'fixture',
        'node',
        '-e',
        databaseAuditScript(),
      ]),
    )
    summary.database = audit
    const expected = expectedGoMigratorAudit()
    summary.expected = expected
    const errors = verifyGoMigratorDatabaseAudit(audit, expected)
    if (errors.length > 0) {
      summary.errors = errors
      return summary
    }
    summary.checks.push({
      name: 'Go-created SQLite migration ledger and default settings',
      ok: true,
    })

    summary.ok = true
    return summary
  } catch (error) {
    summary.errors = [
      {
        name: 'go migrator verifier',
        message: error instanceof Error ? error.message : String(error),
      },
    ]
    return summary
  } finally {
    if (!options.keep) {
      try {
        runCompose(options, ['down', '-v'], { inherit: true })
        summary.cleanup = { ok: true, volumesRemoved: true }
      } catch (error) {
        summary.cleanup = {
          ok: false,
          volumesRemoved: false,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    }
  }
}

function expectedGoMigratorAudit() {
  return {
    migrations: parseMigrationSummary(
      readFileSync(
        resolve(REPO_ROOT, 'backend/go/internal/platform/db/migrations_gen.go'),
        'utf8',
      ),
    ),
    defaultSettingsCount: parseDefaultSettingsCount(
      readFileSync(
        resolve(REPO_ROOT, 'backend/go/internal/settings/defaults_gen.go'),
        'utf8',
      ),
    ),
  }
}

async function waitForGoMigratorHTTP(options, fetchImpl) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function')
  }

  const checks = [
    {
      name: 'Go runtime version endpoint',
      url: `http://127.0.0.1:${options.port}/version`,
      expectedBackend: 'go',
    },
    {
      name: 'Node gateway default provider after Go migration',
      url: `http://127.0.0.1:${options.port}/api/system/settings/all`,
      expectedBackend: 'node',
    },
    {
      name: 'Go lab settings read after Go migration',
      url: `http://127.0.0.1:${options.port}/__lab/go/api/system/settings/all`,
      expectedBackend: 'go',
    },
  ]
  const deadline = Date.now() + options.timeoutMs
  const passed = []

  for (const check of checks) {
    let lastError
    while (Date.now() < deadline) {
      try {
        const response = await fetchImpl(check.url, {
          headers: {
            'X-Request-Id': `go-migrator-smoke-${Date.now()}`,
          },
        })
        const bodyText = await response.text()
        const backend = response.headers.get('x-chronoframe-backend')
        if (response.ok && backend === check.expectedBackend) {
          passed.push({
            name: check.name,
            ok: true,
            status: response.status,
            backend,
          })
          break
        }
        lastError = `${check.url} returned status=${response.status} backend=${backend} body=${bodyText.slice(0, 240)}`
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      await sleep(500)
    }
    if (passed[passed.length - 1]?.name !== check.name) {
      throw new Error(`${check.name} did not pass: ${lastError}`)
    }
  }

  return passed
}

function runCompose(options, composeArgs, { inherit = false } = {}) {
  const args = ['compose', '-p', options.project, ...COMPOSE_FILES, ...composeArgs]
  const environment = {
    ...process.env,
    CFRAME_DUAL_PORT: String(options.port),
    CFRAME_DUAL_REDIS_PORT: String(options.redisPort),
  }
  try {
    return execFileSync('docker', args, {
      cwd: REPO_ROOT,
      env: environment,
      encoding: 'utf8',
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const stdout = error?.stdout ? String(error.stdout) : ''
    const stderr = error?.stderr ? String(error.stderr) : ''
    throw new Error(
      [
        `docker ${args.join(' ')} failed`,
        stdout.trim(),
        stderr.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
}

function databaseAuditScript() {
  return `
const Database = require('better-sqlite3')
const db = new Database('/app/data/app.sqlite3', { readonly: true })
const audit = {
  migrations: db.prepare('select count(*) as count, max(created_at) as latest from __drizzle_migrations').get(),
  settings: db.prepare('select count(*) as count from settings').get(),
  backend: db.prepare("select namespace, key, type, value, default_value, enum from settings where namespace = 'system' and key = 'backend.readProvider'").get(),
  tables: db.prepare("select count(*) as count from sqlite_master where type = 'table' and name not like 'sqlite_%'").get(),
  integrity: db.pragma('integrity_check'),
  foreignKeys: db.pragma('foreign_key_check')
}
db.close()
console.log('${AUDIT_TAG}' + JSON.stringify(audit))
`
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summary = await verifyGoMigrator(parseGoMigratorVerifierOptions())
  console.log(JSON.stringify(summary, null, 2))
  if (!summary.ok) process.exitCode = 1
}

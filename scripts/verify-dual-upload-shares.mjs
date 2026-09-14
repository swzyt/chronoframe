#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import {
  AUTHZ_CASES,
  DEFAULT_AUTHZ_ADMIN_COOKIE,
  DEFAULT_AUTHZ_MEMBER_COOKIE,
  verifyDualAuthz,
} from './verify-dual-authz.mjs'
import {
  DEFAULT_MUTATION_BASE_URL,
  DEFAULT_MUTATION_COOKIE,
  verifyDualMutations,
} from './verify-dual-mutations.mjs'
import {
  DEFAULT_UPLOAD_PIPELINE_POLL_MS,
  DEFAULT_UPLOAD_PIPELINE_TIMEOUT_MS,
  verifyDualUploadPipeline,
} from './verify-dual-upload-pipeline.mjs'

export const UPLOAD_SHARE_ROUTE_IDS = Object.freeze([
  'upload-shares.delete',
  'upload-shares.update',
  'upload-shares.list',
  'upload-shares.create',
  'upload-shares.public.read',
  'upload-shares.public.prepare',
  'upload-shares.public.task',
  'upload-shares.public.upload',
])

export const UPLOAD_SHARE_AUTHZ_CASES = Object.freeze(
  AUTHZ_CASES.filter((testCase) =>
    testCase.path.startsWith('/api/upload-shares'),
  ),
)

export const UPLOAD_SHARE_EVIDENCE_REQUIREMENTS = Object.freeze({
  'upload-shares.list': Object.freeze([
    { source: 'authz', includes: 'anonymous upload shares list', minimum: 1 },
    {
      source: 'mutations',
      includes: 'upload share cross-read via ',
      minimum: 4,
    },
    {
      source: 'pipeline',
      includes: 'public upload share pipeline: read share usage after ',
      minimum: 2,
    },
  ]),
  'upload-shares.create': Object.freeze([
    { source: 'authz', includes: 'upload share create ', minimum: 5 },
    { source: 'mutations', includes: 'upload share create via ', minimum: 2 },
    {
      source: 'pipeline',
      includes: 'public upload share pipeline: create share via ',
      minimum: 2,
    },
  ]),
  'upload-shares.update': Object.freeze([
    { source: 'authz', includes: 'upload share update ', minimum: 9 },
    { source: 'mutations', includes: 'upload share update via ', minimum: 2 },
    {
      source: 'mutations',
      includes: 'upload share nullable update via ',
      minimum: 2,
    },
  ]),
  'upload-shares.delete': Object.freeze([
    { source: 'authz', includes: 'upload share delete', minimum: 2 },
    { source: 'mutations', includes: 'upload share delete via ', minimum: 2 },
    {
      source: 'pipeline',
      includes: 'cleanup: delete public upload share ',
      minimum: 3,
    },
  ]),
  'upload-shares.public.read': Object.freeze([
    {
      source: 'authz',
      includes: 'public missing upload share read',
      minimum: 1,
    },
    {
      source: 'pipeline',
      includes: 'public upload share pipeline: anonymous read via ',
      minimum: 2,
    },
  ]),
  'upload-shares.public.prepare': Object.freeze([
    {
      source: 'authz',
      includes: 'public upload share prepare ',
      minimum: 7,
    },
    {
      source: 'mutations',
      includes: 's3 public upload prepare via ',
      minimum: 4,
    },
    {
      source: 'pipeline',
      includes: 'public upload share pipeline: anonymous prepare via ',
      minimum: 2,
    },
    {
      source: 'pipeline',
      includes: 'exhausted share rejects prepare via ',
      minimum: 2,
    },
  ]),
  'upload-shares.public.task': Object.freeze([
    {
      source: 'authz',
      includes: 'public upload share task ',
      minimum: 6,
    },
    {
      source: 'pipeline',
      includes: 'public upload share pipeline: anonymous task via ',
      minimum: 2,
    },
    {
      source: 'pipeline',
      includes: 'public upload share atomic quota: concurrent ',
      minimum: 2,
    },
  ]),
  'upload-shares.public.upload': Object.freeze([
    {
      source: 'authz',
      includes: 'public upload share upload ',
      minimum: 3,
    },
    {
      source: 'pipeline',
      includes: 'public upload share pipeline: anonymous object PUT via ',
      minimum: 2,
    },
    {
      source: 'pipeline',
      includes: 'public upload share atomic quota: upload object',
      minimum: 1,
    },
  ]),
})

const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'

export function parseUploadShareVerifierOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${argument}`)
    }
    if (
      ![
        '--base',
        '--admin-cookie',
        '--member-cookie',
        '--timeout-ms',
        '--pipeline-timeout-ms',
        '--poll-ms',
        '--prefix',
      ].includes(argument)
    ) {
      throw new Error(`Unknown option: ${argument}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`)
    }
    values.set(argument, value)
    index += 1
  }

  const base = normalizeBaseURL(
    values.get('--base') ||
      environment.CFRAME_DUAL_BASE_URL ||
      (environment.CFRAME_DUAL_PORT
        ? `http://127.0.0.1:${environment.CFRAME_DUAL_PORT}`
        : DEFAULT_MUTATION_BASE_URL),
  )
  return {
    base,
    adminCookie: normalizeCookie(
      values.get('--admin-cookie') ||
        environment.CFRAME_DUAL_ADMIN_COOKIE ||
        environment.CFRAME_DUAL_COOKIE ||
        DEFAULT_MUTATION_COOKIE ||
        DEFAULT_AUTHZ_ADMIN_COOKIE,
    ),
    memberCookie: normalizeCookie(
      values.get('--member-cookie') ||
        environment.CFRAME_DUAL_MEMBER_COOKIE ||
        DEFAULT_AUTHZ_MEMBER_COOKIE,
    ),
    timeoutMs: positiveInteger(
      values.get('--timeout-ms') ||
        environment.CFRAME_DUAL_TIMEOUT_MS ||
        10_000,
      'timeout-ms',
      60_000,
    ),
    pipelineTimeoutMs: positiveInteger(
      values.get('--pipeline-timeout-ms') ||
        environment.CFRAME_DUAL_UPLOAD_PIPELINE_TIMEOUT_MS ||
        DEFAULT_UPLOAD_PIPELINE_TIMEOUT_MS,
      'pipeline-timeout-ms',
      120_000,
    ),
    pollMs: positiveInteger(
      values.get('--poll-ms') ||
        environment.CFRAME_DUAL_UPLOAD_PIPELINE_POLL_MS ||
        DEFAULT_UPLOAD_PIPELINE_POLL_MS,
      'poll-ms',
      5_000,
    ),
    prefix: normalizePrefix(
      values.get('--prefix') ||
        environment.CFRAME_DUAL_UPLOAD_SHARE_PREFIX ||
        'dual-upload-share',
    ),
  }
}

export function validateUploadShareEvidence(evidence) {
  const errors = []
  const routes = {}
  for (const routeID of UPLOAD_SHARE_ROUTE_IDS) {
    const requirements = UPLOAD_SHARE_EVIDENCE_REQUIREMENTS[routeID] || []
    const checks = requirements.map((requirement) => {
      const names = evidence[requirement.source] || []
      const count = names.filter((name) =>
        String(name).includes(requirement.includes),
      ).length
      const ok = count >= requirement.minimum
      if (!ok) {
        errors.push(
          `${routeID}: ${requirement.source} evidence containing ${JSON.stringify(requirement.includes)} = ${count}, want >= ${requirement.minimum}`,
        )
      }
      return { ...requirement, count, ok }
    })
    routes[routeID] = {
      ok: checks.every((check) => check.ok),
      checks,
    }
  }
  return { ok: errors.length === 0, routes, errors }
}

export async function verifyDualUploadShares(options = {}) {
  const normalized = {
    ...parseUploadShareVerifierOptions([], {}),
    ...options,
  }
  normalized.base = normalizeBaseURL(normalized.base)
  normalized.adminCookie = normalizeCookie(normalized.adminCookie)
  normalized.memberCookie = normalizeCookie(normalized.memberCookie)
  normalized.prefix = normalizePrefix(normalized.prefix)
  normalized.timeoutMs = positiveInteger(
    normalized.timeoutMs,
    'timeout-ms',
    60_000,
  )
  normalized.pipelineTimeoutMs = positiveInteger(
    normalized.pipelineTimeoutMs,
    'pipeline-timeout-ms',
    120_000,
  )
  normalized.pollMs = positiveInteger(normalized.pollMs, 'poll-ms', 5_000)

  const summary = {
    ok: false,
    base: normalized.base,
    routeIds: UPLOAD_SHARE_ROUTE_IDS,
    stages: {},
    cleanup: [],
  }

  try {
    const authz = await verifyDualAuthz({
      nodeURL: normalized.base,
      goURL: `${normalized.base}/__lab/go`,
      adminCookie: normalized.adminCookie,
      memberCookie: normalized.memberCookie,
      timeoutMs: normalized.timeoutMs,
      cases: UPLOAD_SHARE_AUTHZ_CASES,
    })
    summary.stages.authz = {
      ok: authz.ok,
      checkCount: authz.total,
      failed: authz.failed,
    }
    if (!authz.ok) throw new Error('upload-share authorization parity failed')

    const mutations = await verifyDualMutations({
      base: normalized.base,
      cookie: normalized.adminCookie,
      timeoutMs: normalized.timeoutMs,
      prefix: `${normalized.prefix}-mutation`,
    })
    summary.stages.mutations = {
      ok: mutations.ok,
      checkCount: mutations.checks.length,
      cleanupCount: mutations.cleanup.length,
      cleanupOK: mutations.cleanup.every((entry) => entry.ok),
      ...(mutations.ok ? {} : { errors: mutations.errors || [] }),
    }
    if (!mutations.ok || !summary.stages.mutations.cleanupOK) {
      throw new Error('upload-share cross-backend mutation parity failed')
    }

    const pipeline = await verifyDualUploadPipeline({
      base: normalized.base,
      cookie: normalized.adminCookie,
      timeoutMs: normalized.pipelineTimeoutMs,
      pollMs: normalized.pollMs,
      prefix: `${normalized.prefix}-pipeline`,
    })
    summary.stages.pipeline = {
      ok: pipeline.ok,
      checkCount: pipeline.checks.length,
      publicChecks: pipeline.publicChecks,
      exhaustedShareChecks: pipeline.exhaustedShareChecks,
      atomicQuotaChecks: pipeline.atomicQuotaChecks,
      cleanupCount: pipeline.cleanup.length,
      cleanupOK: pipeline.cleanup.every((entry) => entry.ok),
      ...(pipeline.ok ? {} : { errors: pipeline.errors || [] }),
    }
    if (!pipeline.ok || !summary.stages.pipeline.cleanupOK) {
      throw new Error('upload-share object and queue pipeline parity failed')
    }

    const evidence = {
      authz: authz.results.map((entry) => entry.name),
      mutations: mutations.checks.map((entry) => entry.name),
      pipeline: pipeline.checks.map((entry) => entry.name),
    }
    const coverage = validateUploadShareEvidence(evidence)
    summary.routeCoverage = coverage.routes
    if (!coverage.ok) {
      throw new Error(coverage.errors.join('; '))
    }

    summary.checkCount =
      authz.total + mutations.checks.length + pipeline.checks.length
    summary.ok = true
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error)
  } finally {
    const restored = await restoreNodeProvider(normalized)
    summary.cleanup.push(restored)
    if (!restored.ok) summary.ok = false
  }

  return summary
}

async function restoreNodeProvider(options) {
  try {
    const response = await fetch(
      new URL(PROVIDER_SETTING_PATH, `${options.base}/`),
      {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Cookie: options.adminCookie,
          'X-Request-Id': `dual-upload-share-cleanup-${randomUUID()}`,
        },
        body: JSON.stringify({ value: 'node' }),
        signal: AbortSignal.timeout(options.timeoutMs),
      },
    )
    if (!response.ok) {
      throw new Error(`unexpected status ${response.status}`)
    }
    return { name: 'restore backend provider to node', ok: true }
  } catch (error) {
    return {
      name: 'restore backend provider to node',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function normalizeBaseURL(value) {
  const parsed = new URL(String(value || '').trim())
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('base must use http or https')
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/'
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/$/, '')
}

function normalizeCookie(value) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error('cookie must not be empty')
  return normalized
}

function normalizePrefix(value) {
  const normalized = String(value || '').trim()
  if (!/^[a-z0-9][a-z0-9_.-]{0,31}$/i.test(normalized)) {
    throw new Error(
      'prefix must be 1-32 characters using letters, numbers, dot, underscore, or dash',
    )
  }
  return normalized
}

function positiveInteger(value, label, maximum) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`)
  }
  return parsed
}

async function main() {
  const result = await verifyDualUploadShares(parseUploadShareVerifierOptions())
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

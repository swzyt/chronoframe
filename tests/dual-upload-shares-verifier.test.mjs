import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  UPLOAD_SHARE_AUTHZ_CASES,
  UPLOAD_SHARE_EVIDENCE_REQUIREMENTS,
  UPLOAD_SHARE_ROUTE_IDS,
  parseUploadShareVerifierOptions,
  validateUploadShareEvidence,
} from '../scripts/verify-dual-upload-shares.mjs'

test('upload-share verifier owns the complete route slice', () => {
  const contract = JSON.parse(
    readFileSync(
      new URL('../backend/contracts/routes.yaml', import.meta.url),
      'utf8',
    ),
  )
  const routes = contract.routes.filter(
    (route) => route.capability === 'upload-shares',
  )
  assert.deepEqual(
    [...UPLOAD_SHARE_ROUTE_IDS].sort(),
    routes.map((route) => route.id).sort(),
  )
  assert.equal(routes.length, 8)
  assert.equal(
    routes.every((route) => route.maturity.go === 'verified'),
    true,
  )
})

test('upload-share authz matrix covers every public and owner route', () => {
  assert.equal(UPLOAD_SHARE_AUTHZ_CASES.length, 35)
  const text = UPLOAD_SHARE_AUTHZ_CASES.map(
    (entry) => `${entry.method} ${entry.path}`,
  ).join('\n')
  for (const fragment of [
    'GET /api/upload-shares',
    'POST /api/upload-shares',
    'PATCH /api/upload-shares/',
    'DELETE /api/upload-shares/',
    '/public/missing-token',
    '/prepare',
    '/task',
    '/upload',
  ]) {
    assert.match(text, new RegExp(fragment.replaceAll('/', '\\/')))
  }
})

test('upload-share evidence gate requires authz, lifecycle, S3, object, queue, and quota checks', () => {
  const evidence = { authz: [], mutations: [], pipeline: [] }
  for (const requirements of Object.values(
    UPLOAD_SHARE_EVIDENCE_REQUIREMENTS,
  )) {
    for (const requirement of requirements) {
      for (let index = 0; index < requirement.minimum; index += 1) {
        evidence[requirement.source].push(`${requirement.includes}${index}`)
      }
    }
  }

  assert.equal(validateUploadShareEvidence(evidence).ok, true)
  evidence.pipeline = evidence.pipeline.filter(
    (name) => !name.includes('atomic quota: concurrent '),
  )
  const missing = validateUploadShareEvidence(evidence)
  assert.equal(missing.ok, false)
  assert.ok(
    missing.errors.some((message) =>
      message.startsWith('upload-shares.public.task:'),
    ),
  )
})

test('upload-share verifier options target the shared production stack', () => {
  assert.deepEqual(
    parseUploadShareVerifierOptions([], { CFRAME_DUAL_PORT: '33124' }),
    {
      base: 'http://127.0.0.1:33124',
      adminCookie: 'cf_session=Q0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0M',
      memberCookie: 'cf_session=REREREREREREREREREREREREREREREREREREREREREQ',
      timeoutMs: 10000,
      pipelineTimeoutMs: 60000,
      pollMs: 500,
      prefix: 'dual-upload-share',
    },
  )
})

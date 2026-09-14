#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import Database from 'better-sqlite3'

import {
  DUAL_BACKEND_COMPARE_FIXTURE,
  joinBackendURL,
} from './compare-backends.mjs'
import {
  FIXTURE_MEMBER_SESSION_TOKEN,
  FIXTURE_SESSION_TOKEN,
} from './seed-dual-backend-fixture.mjs'

export const DEFAULT_SETTINGS_CONTROL_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_SETTINGS_CONTROL_DATABASE_PATH = './data/app.sqlite3'
export const DEFAULT_SETTINGS_CONTROL_ADMIN_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`
export const DEFAULT_SETTINGS_CONTROL_MEMBER_COOKIE = `cf_session=${FIXTURE_MEMBER_SESSION_TOKEN}`
export const DEFAULT_SETTINGS_CONTROL_PREFIX = 'dual-settings'

export const SETTINGS_CONTROL_ROUTE_IDS = Object.freeze([
  'settings.namespace.read',
  'settings.key.read',
  'settings.key.update',
  'settings.batch.update',
  'settings.fields',
  'settings.schema',
  'settings.storage-config.delete',
  'settings.storage-config.read',
  'settings.storage-config.update',
  'settings.storage-config.list',
  'settings.storage-config.create',
])

const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'
const STORAGE_CONFIG_PATH = '/api/system/settings/storage-config'
const FIXTURE_STORAGE_ID = DUAL_BACKEND_COMPARE_FIXTURE.storageProviderId
const PROVIDERS = Object.freeze(['node', 'go'])

function pairCase(
  name,
  method,
  path,
  expectedStatus,
  { cookie = 'admin', body, rawBody, contentType } = {},
) {
  return Object.freeze({
    name,
    method,
    path,
    expectedStatus,
    cookie,
    ...(body !== undefined ? { body } : {}),
    ...(rawBody !== undefined ? { rawBody } : {}),
    ...(contentType ? { contentType } : {}),
  })
}

function rawCase(name, method, path, rawBody, expectedStatus = 400) {
  return pairCase(name, method, path, expectedStatus, {
    rawBody,
    contentType: 'application/json',
  })
}

const AUTH_OPERATIONS = Object.freeze([
  ['namespace read', 'GET', '/api/system/settings/app'],
  ['key read', 'GET', '/api/system/settings/app/title'],
  ['key update', 'PUT', '/api/system/settings/app/title'],
  ['batch update', 'PUT', '/api/system/settings/batch'],
  ['fields read', 'GET', '/api/system/settings/fields?namespace=app'],
  ['schema read', 'GET', '/api/system/settings/schema'],
  ['storage config list', 'GET', STORAGE_CONFIG_PATH],
  ['storage config create', 'POST', STORAGE_CONFIG_PATH],
  [
    'storage config read',
    'GET',
    `${STORAGE_CONFIG_PATH}/${FIXTURE_STORAGE_ID}`,
  ],
  [
    'storage config update',
    'PUT',
    `${STORAGE_CONFIG_PATH}/${FIXTURE_STORAGE_ID}`,
  ],
  ['storage config delete', 'DELETE', `${STORAGE_CONFIG_PATH}/99999999`],
])

export const SETTINGS_CONTROL_READ_CASES = Object.freeze([
  pairCase('app namespace', 'GET', '/api/system/settings/app', 200),
  pairCase('system namespace', 'GET', '/api/system/settings/system', 200),
  pairCase('map namespace', 'GET', '/api/system/settings/map', 200),
  pairCase('setting key', 'GET', '/api/system/settings/app/title', 200),
  pairCase(
    'globally valid key in another namespace returns null',
    'GET',
    '/api/system/settings/system/title',
    200,
  ),
  pairCase('settings schema', 'GET', '/api/system/settings/schema', 200),
  pairCase(
    'app setting fields',
    'GET',
    '/api/system/settings/fields?namespace=app',
    200,
  ),
  pairCase(
    'system setting fields',
    'GET',
    '/api/system/settings/fields?namespace=system',
    200,
  ),
  pairCase('storage configuration list', 'GET', STORAGE_CONFIG_PATH, 200),
  pairCase(
    'storage configuration exact id',
    'GET',
    `${STORAGE_CONFIG_PATH}/${FIXTURE_STORAGE_ID}`,
    200,
  ),
  pairCase(
    'storage configuration decimal prefix id',
    'GET',
    `${STORAGE_CONFIG_PATH}/${FIXTURE_STORAGE_ID}suffix`,
    200,
  ),
  pairCase(
    'storage configuration fractional prefix id',
    'GET',
    `${STORAGE_CONFIG_PATH}/${FIXTURE_STORAGE_ID}.9`,
    200,
  ),
  pairCase(
    'storage configuration ECMAScript whitespace id',
    'GET',
    `${STORAGE_CONFIG_PATH}/%E3%80%80${FIXTURE_STORAGE_ID}%E3%80%80`,
    200,
  ),
])

export const SETTINGS_CONTROL_BOUNDARY_CASES = Object.freeze([
  ...AUTH_OPERATIONS.flatMap(([name, method, path]) => [
    pairCase(`anonymous ${name}`, method, path, 401, { cookie: 'anonymous' }),
    pairCase(`member ${name}`, method, path, 403, { cookie: 'member' }),
  ]),
  pairCase(
    'invalid setting namespace',
    'GET',
    '/api/system/settings/__invalid_namespace__',
    400,
  ),
  pairCase(
    'invalid setting key',
    'GET',
    '/api/system/settings/app/__invalid_key__',
    400,
  ),
  pairCase(
    'invalid setting namespace and key',
    'GET',
    '/api/system/settings/__invalid_namespace__/__invalid_key__',
    400,
  ),
  pairCase(
    'fields missing namespace',
    'GET',
    '/api/system/settings/fields',
    400,
  ),
  pairCase(
    'fields empty namespace',
    'GET',
    '/api/system/settings/fields?namespace=',
    400,
  ),
  pairCase(
    'fields repeated namespace',
    'GET',
    '/api/system/settings/fields?namespace=app&namespace=system',
    400,
  ),
  pairCase(
    'fields unknown namespace',
    'GET',
    '/api/system/settings/fields?namespace=unknown',
    404,
  ),
  rawCase(
    'setting update without body',
    'PUT',
    '/api/system/settings/app/title',
    undefined,
  ),
  rawCase(
    'setting update with empty body',
    'PUT',
    '/api/system/settings/app/title',
    '',
  ),
  rawCase(
    'setting update with malformed JSON',
    'PUT',
    '/api/system/settings/app/title',
    '{',
  ),
  rawCase(
    'setting update with trailing JSON',
    'PUT',
    '/api/system/settings/app/title',
    '{"value":"x"}{}',
  ),
  rawCase(
    'setting update with null body',
    'PUT',
    '/api/system/settings/app/title',
    'null',
  ),
  ...['1', '"x"', '[]', 'true'].map((rawBody) =>
    rawCase(
      `setting update primitive ${rawBody}`,
      'PUT',
      '/api/system/settings/app/title',
      rawBody,
    ),
  ),
  pairCase(
    'setting update missing value',
    'PUT',
    '/api/system/settings/app/title',
    400,
    { body: {} },
  ),
  pairCase(
    'string setting rejects number',
    'PUT',
    '/api/system/settings/app/title',
    400,
    { body: { value: 1 } },
  ),
  pairCase(
    'number setting rejects string',
    'PUT',
    '/api/system/settings/app/access.previewPhotoLimit',
    400,
    { body: { value: '1' } },
  ),
  pairCase(
    'boolean setting rejects number',
    'PUT',
    '/api/system/settings/system/webglImageViewerDebug',
    400,
    { body: { value: 1 } },
  ),
  pairCase(
    'readonly setting rejects update',
    'PUT',
    '/api/system/settings/system/firstLaunch',
    400,
    { body: { value: true } },
  ),
  pairCase(
    'enum setting rejects unknown value',
    'PUT',
    '/api/system/settings/app/appearance.theme',
    400,
    { body: { value: 'neon' } },
  ),
  pairCase(
    'enum setting rejects null',
    'PUT',
    '/api/system/settings/app/appearance.theme',
    400,
    { body: { value: null } },
  ),
  pairCase(
    'globally valid key in another namespace cannot be updated',
    'PUT',
    '/api/system/settings/system/title',
    400,
    { body: { value: 'x' } },
  ),
  rawCase(
    'batch update without body',
    'PUT',
    '/api/system/settings/batch',
    undefined,
  ),
  rawCase(
    'batch update with empty body',
    'PUT',
    '/api/system/settings/batch',
    '',
  ),
  rawCase(
    'batch update with malformed JSON',
    'PUT',
    '/api/system/settings/batch',
    '{',
  ),
  rawCase(
    'batch update with trailing JSON',
    'PUT',
    '/api/system/settings/batch',
    '{"updates":[]}{}',
  ),
  rawCase(
    'batch update with null body',
    'PUT',
    '/api/system/settings/batch',
    'null',
  ),
  ...['1', '"x"', '[]', 'true'].map((rawBody) =>
    rawCase(
      `batch update primitive ${rawBody}`,
      'PUT',
      '/api/system/settings/batch',
      rawBody,
    ),
  ),
  pairCase(
    'batch update missing updates',
    'PUT',
    '/api/system/settings/batch',
    400,
    { body: {} },
  ),
  ...[null, {}, 'x', 1, true].map((updates) =>
    pairCase(
      `batch update rejects updates ${JSON.stringify(updates)}`,
      'PUT',
      '/api/system/settings/batch',
      400,
      { body: { updates } },
    ),
  ),
  ...[null, 1, 'x', []].map((entry) =>
    pairCase(
      `batch update rejects entry ${JSON.stringify(entry)}`,
      'PUT',
      '/api/system/settings/batch',
      400,
      { body: { updates: [entry] } },
    ),
  ),
  pairCase(
    'batch update rejects invalid namespace and key',
    'PUT',
    '/api/system/settings/batch',
    400,
    {
      body: {
        updates: [{ namespace: 'unknown', key: 'unknown', value: 'x' }],
      },
    },
  ),
  pairCase(
    'batch update rejects missing value',
    'PUT',
    '/api/system/settings/batch',
    400,
    { body: { updates: [{ namespace: 'app', key: 'title' }] } },
  ),
  pairCase(
    'batch update accepts an empty list',
    'PUT',
    '/api/system/settings/batch',
    200,
    { body: { updates: [] } },
  ),
  rawCase(
    'storage create without body',
    'POST',
    STORAGE_CONFIG_PATH,
    undefined,
  ),
  rawCase('storage create with empty body', 'POST', STORAGE_CONFIG_PATH, ''),
  rawCase(
    'storage create with malformed JSON',
    'POST',
    STORAGE_CONFIG_PATH,
    '{',
  ),
  rawCase(
    'storage create with trailing JSON',
    'POST',
    STORAGE_CONFIG_PATH,
    '{"provider":"local"}{}',
  ),
  rawCase('storage create with null body', 'POST', STORAGE_CONFIG_PATH, 'null'),
  ...['1', '"x"', '[]', 'true'].map((rawBody) =>
    rawCase(
      `storage create primitive ${rawBody}`,
      'POST',
      STORAGE_CONFIG_PATH,
      rawBody,
    ),
  ),
  pairCase(
    'storage create missing discriminator',
    'POST',
    STORAGE_CONFIG_PATH,
    400,
    {
      body: {},
    },
  ),
  pairCase(
    'storage create invalid discriminator',
    'POST',
    STORAGE_CONFIG_PATH,
    400,
    {
      body: { name: 'x', provider: 'unknown', config: {} },
    },
  ),
  pairCase(
    'storage create missing name and config',
    'POST',
    STORAGE_CONFIG_PATH,
    400,
    {
      body: { provider: 'local' },
    },
  ),
  pairCase('storage create null name', 'POST', STORAGE_CONFIG_PATH, 400, {
    body: {
      name: null,
      provider: 'local',
      config: { provider: 'local', basePath: '/tmp' },
    },
  }),
  pairCase('storage create null config', 'POST', STORAGE_CONFIG_PATH, 400, {
    body: { name: 'x', provider: 'local', config: null },
  }),
  pairCase(
    'local storage create missing fields',
    'POST',
    STORAGE_CONFIG_PATH,
    400,
    {
      body: { name: 'x', provider: 'local', config: {} },
    },
  ),
  pairCase(
    'local storage create wrong literal',
    'POST',
    STORAGE_CONFIG_PATH,
    400,
    {
      body: {
        name: 'x',
        provider: 'local',
        config: { provider: 's3', basePath: '/tmp' },
      },
    },
  ),
  pairCase(
    'local storage create empty base path',
    'POST',
    STORAGE_CONFIG_PATH,
    400,
    {
      body: {
        name: 'x',
        provider: 'local',
        config: { provider: 'local', basePath: '' },
      },
    },
  ),
  pairCase(
    'local storage create invalid optional type',
    'POST',
    STORAGE_CONFIG_PATH,
    400,
    {
      body: {
        name: 'x',
        provider: 'local',
        config: { provider: 'local', basePath: '/tmp', prefix: 1 },
      },
    },
  ),
  pairCase(
    's3 storage create missing fields',
    'POST',
    STORAGE_CONFIG_PATH,
    400,
    {
      body: { name: 'x', provider: 's3', config: { provider: 's3' } },
    },
  ),
  pairCase(
    's3 storage create invalid optional types',
    'POST',
    STORAGE_CONFIG_PATH,
    400,
    {
      body: {
        name: 'x',
        provider: 's3',
        config: {
          provider: 's3',
          bucket: 'b',
          endpoint: 'https://example.test',
          accessKeyId: 'a',
          secretAccessKey: 's',
          forcePathStyle: 'true',
          maxKeys: '10',
        },
      },
    },
  ),
  pairCase(
    'openlist storage create missing fields',
    'POST',
    STORAGE_CONFIG_PATH,
    400,
    {
      body: {
        name: 'x',
        provider: 'openlist',
        config: { provider: 'openlist' },
      },
    },
  ),
  pairCase(
    'openlist storage create empty required fields',
    'POST',
    STORAGE_CONFIG_PATH,
    400,
    {
      body: {
        name: 'x',
        provider: 'openlist',
        config: { provider: 'openlist', baseUrl: '', rootPath: '', token: '' },
      },
    },
  ),
  pairCase(
    'missing storage config update precedes validation',
    'PUT',
    `${STORAGE_CONFIG_PATH}/99999999`,
    404,
    { body: {} },
  ),
  pairCase(
    'missing storage config delete',
    'DELETE',
    `${STORAGE_CONFIG_PATH}/99999999`,
    404,
  ),
  pairCase(
    'invalid storage config read id',
    'GET',
    `${STORAGE_CONFIG_PATH}/abc`,
    404,
  ),
  pairCase(
    'invalid storage config update id',
    'PUT',
    `${STORAGE_CONFIG_PATH}/abc`,
    404,
    { body: {} },
  ),
  pairCase(
    'invalid storage config delete id',
    'DELETE',
    `${STORAGE_CONFIG_PATH}/abc`,
    404,
  ),
  pairCase(
    'hex storage config id uses decimal radix',
    'GET',
    `${STORAGE_CONFIG_PATH}/0x${FIXTURE_STORAGE_ID.toString(16)}`,
    404,
  ),
  rawCase(
    'storage update without body',
    'PUT',
    `${STORAGE_CONFIG_PATH}/${FIXTURE_STORAGE_ID}`,
    undefined,
  ),
  rawCase(
    'storage update with malformed JSON',
    'PUT',
    `${STORAGE_CONFIG_PATH}/${FIXTURE_STORAGE_ID}`,
    '{',
  ),
  rawCase(
    'storage update with null body',
    'PUT',
    `${STORAGE_CONFIG_PATH}/${FIXTURE_STORAGE_ID}`,
    'null',
  ),
  pairCase(
    'storage update missing discriminator',
    'PUT',
    `${STORAGE_CONFIG_PATH}/${FIXTURE_STORAGE_ID}`,
    400,
    { body: {} },
  ),
  pairCase(
    'storage update missing config',
    'PUT',
    `${STORAGE_CONFIG_PATH}/${FIXTURE_STORAGE_ID}`,
    400,
    { body: { provider: 'local' } },
  ),
  pairCase(
    'storage update rejects null name',
    'PUT',
    `${STORAGE_CONFIG_PATH}/${FIXTURE_STORAGE_ID}`,
    400,
    { body: { name: null, provider: 'local', config: {} } },
  ),
  pairCase(
    'storage update rejects wrong nested literal',
    'PUT',
    `${STORAGE_CONFIG_PATH}/${FIXTURE_STORAGE_ID}`,
    400,
    { body: { provider: 'local', config: { provider: 's3' } } },
  ),
  pairCase(
    'storage update rejects empty partial base path',
    'PUT',
    `${STORAGE_CONFIG_PATH}/${FIXTURE_STORAGE_ID}`,
    400,
    { body: { provider: 'local', config: { basePath: '' } } },
  ),
])

export class SettingsControlVerificationFailure extends Error {
  constructor(errors) {
    super(errors.map((error) => `${error.name}: ${error.message}`).join('; '))
    this.name = 'SettingsControlVerificationFailure'
    this.errors = errors
  }
}

export function parseSettingsControlVerifierOptions(
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
        '--node',
        '--go',
        '--admin-cookie',
        '--member-cookie',
        '--db',
        '--timeout-ms',
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
      `http://127.0.0.1:${environment.CFRAME_DUAL_PORT || '3000'}`,
  )
  return {
    base,
    nodeURL: normalizeBaseURL(values.get('--node') || base),
    goURL: normalizeBaseURL(values.get('--go') || `${base}/__lab/go`),
    adminCookie: normalizeCookie(
      values.get('--admin-cookie') ||
        environment.CFRAME_DUAL_ADMIN_COOKIE ||
        DEFAULT_SETTINGS_CONTROL_ADMIN_COOKIE,
      'admin-cookie',
    ),
    memberCookie: normalizeCookie(
      values.get('--member-cookie') ||
        environment.CFRAME_DUAL_MEMBER_COOKIE ||
        DEFAULT_SETTINGS_CONTROL_MEMBER_COOKIE,
      'member-cookie',
    ),
    databasePath: normalizeDatabasePath(
      values.get('--db') ||
        environment.CFRAME_DUAL_DATABASE_PATH ||
        DEFAULT_SETTINGS_CONTROL_DATABASE_PATH,
    ),
    timeoutMs: positiveInteger(
      values.get('--timeout-ms') || environment.CFRAME_DUAL_TIMEOUT_MS || 5_000,
      'timeout-ms',
    ),
    prefix: normalizePrefix(
      values.get('--prefix') ||
        environment.CFRAME_DUAL_SETTINGS_PREFIX ||
        DEFAULT_SETTINGS_CONTROL_PREFIX,
    ),
  }
}

export async function verifyDualSettingsControl({
  base = DEFAULT_SETTINGS_CONTROL_BASE_URL,
  nodeURL = base,
  goURL = `${base}/__lab/go`,
  adminCookie = DEFAULT_SETTINGS_CONTROL_ADMIN_COOKIE,
  memberCookie = DEFAULT_SETTINGS_CONTROL_MEMBER_COOKIE,
  databasePath = DEFAULT_SETTINGS_CONTROL_DATABASE_PATH,
  timeoutMs = 5_000,
  prefix = DEFAULT_SETTINGS_CONTROL_PREFIX,
  readCases = SETTINGS_CONTROL_READ_CASES,
  boundaryCases = SETTINGS_CONTROL_BOUNDARY_CASES,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function')
    throw new Error('fetchImpl must be a function')
  const options = {
    base: normalizeBaseURL(base),
    nodeURL: normalizeBaseURL(nodeURL),
    goURL: normalizeBaseURL(goURL),
    adminCookie: normalizeCookie(adminCookie, 'admin-cookie'),
    memberCookie: normalizeCookie(memberCookie, 'member-cookie'),
    databasePath: normalizeDatabasePath(databasePath),
    timeoutMs: positiveInteger(timeoutMs, 'timeout-ms'),
    prefix: normalizePrefix(prefix),
    fetchImpl,
  }
  const summary = {
    ok: false,
    base: options.base,
    nodeURL: options.nodeURL,
    goURL: options.goURL,
    databasePath: options.databasePath,
    routeIds: [...SETTINGS_CONTROL_ROUTE_IDS],
    checks: [],
    cleanup: [],
  }
  const state = {
    originalProvider: 'node',
    originalSettings: new Map(),
    storageConfigIDs: new Set(),
  }

  try {
    assertDatabaseAvailable(options.databasePath)
    state.originalProvider = await readProvider(options)
    await setProvider(options, 'node')
    await captureSettings(options, state)

    for (const testCase of readCases) {
      await comparePair(options, summary, testCase, 'read')
    }
    for (const testCase of boundaryCases) {
      await comparePair(options, summary, testCase, 'boundary')
    }
    await verifySettingLifecycle(options, summary)
    await verifyStorageLifecycles(options, summary, state)
    await verifyGatewaySwitch(options, summary)
    summary.ok = true
  } catch (error) {
    summary.errors =
      error instanceof SettingsControlVerificationFailure
        ? error.errors
        : [{ name: 'settings control verifier', message: errorMessage(error) }]
  } finally {
    await cleanupSettingsControl(options, summary, state)
  }

  summary.total = summary.checks.length
  summary.reads = summary.checks.filter((check) => check.kind === 'read').length
  summary.boundaries = summary.checks.filter(
    (check) => check.kind === 'boundary',
  ).length
  summary.lifecycle = summary.checks.filter(
    (check) => check.kind === 'lifecycle',
  ).length
  summary.failed = summary.checks.filter((check) => !check.ok).length
  if (summary.errors?.length && summary.failed === 0) summary.failed = 1
  if (summary.cleanup.some((entry) => !entry.ok)) summary.ok = false
  return summary
}

async function comparePair(options, summary, testCase, kind) {
  const requestID = `${options.prefix}-${kind}-${randomUUID()}`
  const [node, go] = await Promise.all([
    executeRequest(options, options.nodeURL, 'node', testCase, requestID),
    executeRequest(options, options.goURL, 'go', testCase, requestID),
  ])
  const differences = validateSettingsControlPair(testCase, node, go)
  const check = {
    name: testCase.name,
    kind,
    ok: differences.length === 0,
    method: testCase.method,
    path: testCase.path,
    node,
    go,
    differences,
  }
  summary.checks.push(check)
  if (!check.ok) {
    throw new SettingsControlVerificationFailure([
      { name: check.name, message: JSON.stringify(differences) },
    ])
  }
  return { node, go }
}

export function validateSettingsControlPair(testCase, node, go) {
  const differences = []
  for (const [name, result] of [
    ['node', node],
    ['go', go],
  ]) {
    if (result.status !== testCase.expectedStatus) {
      differences.push({
        field: `${name}.status`,
        expected: testCase.expectedStatus,
        actual: result.status,
      })
    }
    if (result.backend !== name) {
      differences.push({
        field: `${name}.backend`,
        expected: name,
        actual: result.backend,
      })
    }
    if (result.contentType !== 'application/json') {
      differences.push({
        field: `${name}.contentType`,
        expected: 'application/json',
        actual: result.contentType,
      })
    }
    if (result.responseRequestID !== result.requestID) {
      differences.push({
        field: `${name}.requestId`,
        expected: result.requestID,
        actual: result.responseRequestID,
      })
    }
    if (result.setCookie) {
      differences.push({
        field: `${name}.setCookie`,
        expected: false,
        actual: true,
      })
    }
  }
  if (node.status !== go.status) {
    differences.push({ field: 'status', node: node.status, go: go.status })
  }
  const nodeBody = comparableBody(node.body)
  const goBody = comparableBody(go.body)
  if (stableJSON(nodeBody) !== stableJSON(goBody)) {
    differences.push({ field: 'body', node: nodeBody, go: goBody })
  }
  return differences
}

async function verifySettingLifecycle(options, summary) {
  const singleWrites = [
    [
      'node',
      'go',
      '/api/system/settings/app/title',
      `${options.prefix} node title`,
    ],
    [
      'go',
      'node',
      '/api/system/settings/app/title',
      `${options.prefix} go title`,
    ],
    ['node', 'go', '/api/system/settings/app/access.previewPhotoLimit', 412.5],
    ['go', 'node', '/api/system/settings/system/webglImageViewerDebug', true],
    ['go', 'node', '/api/system/settings/app/appearance.theme', 'dark'],
    ['node', 'go', '/api/system/settings/app/slogan', null],
  ]
  for (const [writer, reader, path, value] of singleWrites) {
    const update = await requestOne(options, summary, {
      name: `setting write via ${writer}: ${path}`,
      kind: 'lifecycle',
      backend: writer,
      method: 'PUT',
      path,
      body: { value, unknown: 'stripped' },
      expectedStatus: 200,
    })
    requireDeepEqual(update.body?.value, value, `${update.name} response value`)
    const read = await requestOne(options, summary, {
      name: `setting cross-read via ${reader}: ${path}`,
      kind: 'lifecycle',
      backend: reader,
      method: 'GET',
      path,
      expectedStatus: 200,
    })
    requireDeepEqual(read.body?.value, value, `${read.name} value`)
  }

  const nodeBatchBody = {
    updates: [
      {
        namespace: 'app',
        key: 'title',
        value: `${options.prefix} node batch`,
        ignored: true,
      },
      { namespace: 'app', key: 'access.previewPhotoLimit', value: 513.25 },
      { namespace: 'system', key: 'webglImageViewerDebug', value: false },
    ],
    ignored: true,
  }
  const nodeBatch = await requestOne(options, summary, {
    name: 'batch setting update via node',
    kind: 'lifecycle',
    backend: 'node',
    method: 'PUT',
    path: '/api/system/settings/batch',
    body: nodeBatchBody,
    expectedStatus: 200,
  })
  requireDeepEqual(
    nodeBatch.body,
    { success: true, updated: 3 },
    nodeBatch.name,
  )
  for (const [path, value] of [
    ['/api/system/settings/app/title', `${options.prefix} node batch`],
    ['/api/system/settings/app/access.previewPhotoLimit', 513.25],
    ['/api/system/settings/system/webglImageViewerDebug', false],
  ]) {
    const read = await requestOne(options, summary, {
      name: `Go reads Node batch value: ${path}`,
      kind: 'lifecycle',
      backend: 'go',
      method: 'GET',
      path,
      expectedStatus: 200,
    })
    requireDeepEqual(read.body?.value, value, read.name)
  }

  const goBatch = await requestOne(options, summary, {
    name: 'batch setting update via go',
    kind: 'lifecycle',
    backend: 'go',
    method: 'PUT',
    path: '/api/system/settings/batch',
    body: {
      updates: [
        { namespace: 'app', key: 'title', value: `${options.prefix} go batch` },
        { namespace: 'app', key: 'slogan', value: `${options.prefix} slogan` },
        { namespace: 'app', key: 'appearance.theme', value: 'light' },
      ],
    },
    expectedStatus: 200,
  })
  requireDeepEqual(goBatch.body, { success: true, updated: 3 }, goBatch.name)
  for (const [path, value] of [
    ['/api/system/settings/app/title', `${options.prefix} go batch`],
    ['/api/system/settings/app/slogan', `${options.prefix} slogan`],
    ['/api/system/settings/app/appearance.theme', 'light'],
  ]) {
    const read = await requestOne(options, summary, {
      name: `Node reads Go batch value: ${path}`,
      kind: 'lifecycle',
      backend: 'node',
      method: 'GET',
      path,
      expectedStatus: 200,
    })
    requireDeepEqual(read.body?.value, value, read.name)
  }

  const partialBody = (value) => ({
    updates: [
      { namespace: 'app', key: 'title', value },
      { namespace: 'system', key: 'firstLaunch', value: false },
    ],
  })
  const nodePartial = await requestOne(options, summary, {
    name: 'partial batch update via node',
    kind: 'lifecycle',
    backend: 'node',
    method: 'PUT',
    path: '/api/system/settings/batch',
    body: partialBody(`${options.prefix} partial node`),
    expectedStatus: 200,
  })
  const goPartial = await requestOne(options, summary, {
    name: 'partial batch update via go',
    kind: 'lifecycle',
    backend: 'go',
    method: 'PUT',
    path: '/api/system/settings/batch',
    body: partialBody(`${options.prefix} partial go`),
    expectedStatus: 200,
  })
  requireDeepEqual(
    comparableBody(nodePartial.body),
    comparableBody(goPartial.body),
    'partial batch response parity',
  )
  requireDeepEqual(nodePartial.body?.updated, 1, nodePartial.name)
  requireDeepEqual(nodePartial.body?.success, false, nodePartial.name)
}

async function verifyStorageLifecycles(options, summary, state) {
  const cases = storageLifecycleCases(options.prefix)
  for (const storageCase of cases) {
    for (const creator of PROVIDERS) {
      const updater = creator === 'node' ? 'go' : 'node'
      const name = `${options.prefix} ${storageCase.provider} ${creator}`
      const created = await requestOne(options, summary, {
        name: `${storageCase.provider} storage create via ${creator}`,
        kind: 'lifecycle',
        backend: creator,
        method: 'POST',
        path: STORAGE_CONFIG_PATH,
        body: {
          name,
          provider: storageCase.provider,
          config: storageCase.createConfig(creator),
          ignored: true,
        },
        expectedStatus: 200,
      })
      const id = requirePositiveInteger(created.body?.id, created.name)
      state.storageConfigIDs.add(id)

      const afterCreate = await comparePair(
        options,
        summary,
        pairCase(
          `${storageCase.provider} storage pair read after ${creator} create`,
          'GET',
          `${STORAGE_CONFIG_PATH}/${id}`,
          200,
        ),
        'lifecycle',
      )
      requireStorageConfig(
        afterCreate.node.body,
        {
          id,
          name,
          provider: storageCase.provider,
          config: storageCase.expectedCreateConfig(creator),
        },
        `${storageCase.provider} create`,
      )
      const listAfterCreate = await comparePair(
        options,
        summary,
        pairCase(
          `${storageCase.provider} storage pair list after create`,
          'GET',
          STORAGE_CONFIG_PATH,
          200,
        ),
        'lifecycle',
      )
      if (
        !Array.isArray(listAfterCreate.node.body) ||
        !listAfterCreate.node.body.some((entry) => entry?.id === id)
      ) {
        throw failure(
          `${storageCase.provider} list`,
          `created id ${id} was not listed`,
        )
      }

      const updatedName = `${name} updated ${updater}`
      const updated = await requestOne(options, summary, {
        name: `${storageCase.provider} storage update via ${updater}`,
        kind: 'lifecycle',
        backend: updater,
        method: 'PUT',
        path: `${STORAGE_CONFIG_PATH}/${id}suffix`,
        body: {
          name: updatedName,
          provider: storageCase.provider,
          config: storageCase.updateConfig(creator, updater),
          ignored: true,
        },
        expectedStatus: 200,
      })
      requireDeepEqual(updated.body, { success: true }, updated.name)
      const afterUpdate = await comparePair(
        options,
        summary,
        pairCase(
          `${storageCase.provider} storage pair read after ${updater} update`,
          'GET',
          `${STORAGE_CONFIG_PATH}/${id}.9`,
          200,
        ),
        'lifecycle',
      )
      requireStorageConfig(
        afterUpdate.node.body,
        {
          id,
          name: updatedName,
          provider: storageCase.provider,
          config: storageCase.expectedUpdateConfig(creator, updater),
        },
        `${storageCase.provider} update`,
      )

      const removed = await requestOne(options, summary, {
        name: `${storageCase.provider} storage delete via ${creator}`,
        kind: 'lifecycle',
        backend: creator,
        method: 'DELETE',
        path: `${STORAGE_CONFIG_PATH}/${id}delete-suffix`,
        expectedStatus: 200,
      })
      requireDeepEqual(removed.body, { success: true }, removed.name)
      state.storageConfigIDs.delete(id)
      await comparePair(
        options,
        summary,
        pairCase(
          `${storageCase.provider} storage missing after delete`,
          'GET',
          `${STORAGE_CONFIG_PATH}/${id}`,
          404,
        ),
        'lifecycle',
      )
    }
  }
}

async function verifyGatewaySwitch(options, summary) {
  const switchToGo = await requestOne(options, summary, {
    name: 'gateway switches settings provider to Go',
    kind: 'lifecycle',
    backend: 'node',
    baseURL: options.base,
    method: 'PUT',
    path: PROVIDER_SETTING_PATH,
    body: { value: 'go' },
    expectedStatus: 200,
  })
  requireDeepEqual(switchToGo.body?.value, 'go', switchToGo.name)
  const goRead = await requestOne(options, summary, {
    name: 'gateway settings read is served by Go',
    kind: 'lifecycle',
    backend: 'go',
    baseURL: options.base,
    method: 'GET',
    path: '/api/system/settings/app/title',
    expectedStatus: 200,
  })
  if (typeof goRead.body?.value !== 'string') {
    throw failure(goRead.name, 'expected a string title')
  }
  const switchToNode = await requestOne(options, summary, {
    name: 'gateway switches settings provider back to Node',
    kind: 'lifecycle',
    // Provider mutations are deliberately pinned to Node so the gateway cannot
    // strand itself while changing the setting that controls its own routing.
    backend: 'node',
    baseURL: options.base,
    method: 'PUT',
    path: PROVIDER_SETTING_PATH,
    body: { value: 'node' },
    expectedStatus: 200,
  })
  requireDeepEqual(switchToNode.body?.value, 'node', switchToNode.name)
  await requestOne(options, summary, {
    name: 'gateway settings read is served by Node again',
    kind: 'lifecycle',
    backend: 'node',
    baseURL: options.base,
    method: 'GET',
    path: '/api/system/settings/app/title',
    expectedStatus: 200,
  })
}

function storageLifecycleCases(prefix) {
  return [
    {
      provider: 'local',
      createConfig: (creator) => ({
        provider: 'local',
        basePath: `/app/data/storage/${prefix}-${creator}`,
        prefix: `${prefix}-${creator}`,
        ignored: true,
      }),
      expectedCreateConfig: (creator) => ({
        provider: 'local',
        basePath: `/app/data/storage/${prefix}-${creator}`,
        prefix: `${prefix}-${creator}`,
      }),
      updateConfig: (creator, updater) => ({
        basePath: `/app/data/storage/${prefix}-${creator}-${updater}`,
        ignored: true,
      }),
      expectedUpdateConfig: (creator, updater) => ({
        basePath: `/app/data/storage/${prefix}-${creator}-${updater}`,
      }),
    },
    {
      provider: 's3',
      createConfig: (creator) => ({
        provider: 's3',
        bucket: `${prefix}-${creator}`,
        endpoint: `https://${creator}.s3.example.test`,
        accessKeyId: `access-${creator}`,
        secretAccessKey: `secret-${creator}`,
        ignored: true,
      }),
      expectedCreateConfig: (creator) => ({
        provider: 's3',
        bucket: `${prefix}-${creator}`,
        region: 'auto',
        endpoint: `https://${creator}.s3.example.test`,
        prefix: '/photos',
        accessKeyId: `access-${creator}`,
        secretAccessKey: `secret-${creator}`,
      }),
      updateConfig: (creator, updater) => ({
        bucket: `${prefix}-${creator}-${updater}`,
        maxKeys: 12.5,
        ignored: true,
      }),
      expectedUpdateConfig: (creator, updater) => ({
        bucket: `${prefix}-${creator}-${updater}`,
        region: 'auto',
        prefix: '/photos',
        maxKeys: 12.5,
      }),
    },
    {
      provider: 'openlist',
      createConfig: (creator) => ({
        provider: 'openlist',
        baseUrl: `https://${creator}.files.example.test`,
        rootPath: `/${prefix}/${creator}`,
        token: `token-${creator}`,
        ignored: true,
      }),
      expectedCreateConfig: (creator) => ({
        provider: 'openlist',
        baseUrl: `https://${creator}.files.example.test`,
        rootPath: `/${prefix}/${creator}`,
        token: `token-${creator}`,
        uploadEndpoint: '/api/fs/put',
        deleteEndpoint: '/api/fs/remove',
        metaEndpoint: '/api/fs/get',
        pathField: 'path',
      }),
      updateConfig: () => ({ ignored: true }),
      expectedUpdateConfig: () => ({
        uploadEndpoint: '/api/fs/put',
        deleteEndpoint: '/api/fs/remove',
        metaEndpoint: '/api/fs/get',
        pathField: 'path',
      }),
    },
  ]
}

async function executeRequest(
  options,
  baseURL,
  expectedBackend,
  testCase,
  requestID,
) {
  const headers = {
    Accept: 'application/json',
    'Accept-Language': 'en',
    'X-Request-Id': requestID,
  }
  const cookie = resolveCookie(options, testCase.cookie)
  if (cookie) headers.Cookie = cookie
  let body
  if (Object.hasOwn(testCase, 'rawBody')) {
    body = testCase.rawBody
    headers['Content-Type'] = testCase.contentType || 'application/json'
  } else if (Object.hasOwn(testCase, 'body')) {
    body = JSON.stringify(testCase.body)
    headers['Content-Type'] = testCase.contentType || 'application/json'
  }
  const response = await options.fetchImpl(
    joinBackendURL(baseURL, testCase.path),
    {
      method: testCase.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    },
  )
  const text = await response.text()
  return {
    expectedBackend,
    status: response.status,
    backend: response.headers.get('x-chronoframe-backend'),
    contentType: normalizeContentType(response.headers.get('content-type')),
    requestID,
    responseRequestID: response.headers.get('x-request-id'),
    setCookie: response.headers.has('set-cookie'),
    body: parseBody(text),
  }
}

async function requestOne(options, summary, request) {
  const requestID = `${options.prefix}-${request.kind}-${randomUUID()}`
  const baseURL =
    request.baseURL ||
    (request.backend === 'go' ? options.goURL : options.nodeURL)
  const result = await executeRequest(
    options,
    baseURL,
    request.backend,
    {
      method: request.method,
      path: request.path,
      cookie: request.cookie || 'admin',
      ...(Object.hasOwn(request, 'body') ? { body: request.body } : {}),
      ...(Object.hasOwn(request, 'rawBody')
        ? { rawBody: request.rawBody }
        : {}),
    },
    requestID,
  )
  const differences = []
  if (result.status !== request.expectedStatus)
    differences.push(`status ${result.status}`)
  if (result.backend !== request.backend)
    differences.push(`backend ${result.backend}`)
  if (result.contentType !== 'application/json')
    differences.push(`content-type ${result.contentType}`)
  if (result.responseRequestID !== requestID)
    differences.push(`request-id ${result.responseRequestID}`)
  if (result.setCookie) differences.push('unexpected set-cookie')
  const check = {
    name: request.name,
    kind: request.kind,
    ok: differences.length === 0,
    method: request.method,
    path: request.path,
    result,
    differences,
  }
  summary.checks.push(check)
  if (!check.ok) throw failure(request.name, differences.join(', '))
  return { ...result, name: request.name }
}

async function readProvider(options) {
  const result = await controlRequest(options, 'GET', PROVIDER_SETTING_PATH)
  return result.body?.value === 'go' ? 'go' : 'node'
}

async function setProvider(options, provider) {
  const result = await controlRequest(options, 'PUT', PROVIDER_SETTING_PATH, {
    value: provider,
  })
  if (result.status !== 200 || result.body?.value !== provider) {
    throw new Error(`failed to set provider to ${provider}`)
  }
}

async function controlRequest(options, method, path, body) {
  return executeRequest(
    options,
    options.base,
    'control',
    {
      method,
      path,
      cookie: 'admin',
      ...(body !== undefined ? { body } : {}),
    },
    `${options.prefix}-control-${randomUUID()}`,
  )
}

async function captureSettings(options, state) {
  for (const path of [
    '/api/system/settings/app/title',
    '/api/system/settings/app/slogan',
    '/api/system/settings/app/access.previewPhotoLimit',
    '/api/system/settings/app/appearance.theme',
    '/api/system/settings/system/webglImageViewerDebug',
  ]) {
    const result = await controlRequest(options, 'GET', path)
    if (result.status !== 200) throw new Error(`failed to capture ${path}`)
    state.originalSettings.set(path, result.body?.value ?? null)
  }
}

async function cleanupSettingsControl(options, summary, state) {
  await cleanup(summary, 'force Node provider for cleanup', () =>
    setProvider(options, 'node'),
  )
  for (const [path, value] of state.originalSettings) {
    await cleanup(summary, `restore ${path}`, async () => {
      const result = await controlRequest(options, 'PUT', path, { value })
      if (result.status !== 200) throw new Error(`returned ${result.status}`)
    })
  }
  if (state.storageConfigIDs.size > 0) {
    await cleanup(summary, 'delete tracked temporary storage configs', () => {
      deleteTrackedStorageConfigs(options.databasePath, [
        ...state.storageConfigIDs,
      ])
    })
  }
  await cleanup(summary, `restore provider to ${state.originalProvider}`, () =>
    setProvider(options, state.originalProvider),
  )
}

async function cleanup(summary, name, action) {
  try {
    await action()
    summary.cleanup.push({ name, ok: true })
  } catch (error) {
    summary.cleanup.push({ name, ok: false, error: errorMessage(error) })
  }
}

function deleteTrackedStorageConfigs(databasePath, ids) {
  if (ids.length === 0) return
  const database = new Database(databasePath)
  try {
    const remove = database.prepare(
      `DELETE FROM settings_storage_providers WHERE id = ?`,
    )
    database.transaction(() => {
      for (const id of ids) remove.run(id)
    })()
  } finally {
    database.close()
  }
}

function requireStorageConfig(actual, expected, name) {
  for (const key of ['id', 'name', 'provider', 'config']) {
    requireDeepEqual(actual?.[key], expected[key], `${name}.${key}`)
  }
  for (const key of ['createdAt', 'updatedAt']) {
    if (typeof actual?.[key] !== 'string' || !actual[key].endsWith('.000Z')) {
      throw failure(name, `${key} is not a millisecond UTC timestamp`)
    }
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw failure(name, `expected a positive safe integer id, got ${value}`)
  }
  return value
}

function requireDeepEqual(actual, expected, name) {
  if (stableJSON(actual) !== stableJSON(expected)) {
    throw failure(
      name,
      `expected ${stableJSON(expected)}, got ${stableJSON(actual)}`,
    )
  }
}

function comparableBody(value) {
  if (Array.isArray(value)) return value.map(comparableBody)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'url' && key !== 'stack')
      .map(([key, child]) => [key, comparableBody(child)]),
  )
}

function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJSON(value[key])}`)
    .join(',')}}`
}

function resolveCookie(options, kind) {
  if (kind === undefined || kind === 'admin') return options.adminCookie
  if (kind === 'member') return options.memberCookie
  if (kind === 'anonymous') return undefined
  throw new Error(`unknown cookie kind ${kind}`)
}

function parseBody(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { invalidJSON: text }
  }
}

function normalizeContentType(value) {
  return String(value || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
}

function normalizeBaseURL(value) {
  const parsed = new URL(String(value))
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('base URL must use http or https')
  }
  return parsed.toString().replace(/\/$/, '')
}

function normalizeCookie(value, name) {
  const normalized = String(value || '').trim()
  if (!normalized.includes('='))
    throw new Error(`${name} must be a Cookie header`)
  return normalized
}

function normalizeDatabasePath(value) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error('db must not be empty')
  return normalized
}

function normalizePrefix(value) {
  const normalized = String(value || '').trim()
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(normalized)) {
    throw new Error(
      'prefix must use 1-64 letters, numbers, underscores, or hyphens',
    )
  }
  return normalized
}

function positiveInteger(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 60_000) {
    throw new Error(`${name} must be an integer between 1 and 60000`)
  }
  return parsed
}

function assertDatabaseAvailable(path) {
  if (!existsSync(path)) throw new Error(`SQLite database not found: ${path}`)
  const database = new Database(path, { readonly: true })
  try {
    const row = database.prepare('PRAGMA integrity_check').get()
    if (row?.integrity_check !== 'ok')
      throw new Error('SQLite integrity check failed')
  } finally {
    database.close()
  }
}

function failure(name, message) {
  return new SettingsControlVerificationFailure([{ name, message }])
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function main() {
  const options = parseSettingsControlVerifierOptions()
  const summary = await verifyDualSettingsControl(options)
  console.log(
    JSON.stringify(
      {
        ok: summary.ok,
        total: summary.total,
        reads: summary.reads,
        boundaries: summary.boundaries,
        lifecycle: summary.lifecycle,
        failed: summary.failed,
        routeIds: summary.routeIds,
        cleanup: summary.cleanup,
        errors: summary.errors,
      },
      null,
      2,
    ),
  )
  if (!summary.ok) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main()
}

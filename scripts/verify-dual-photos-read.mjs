#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import Database from 'better-sqlite3'

import {
  canonicalize,
  DUAL_BACKEND_COMPARE_FIXTURE,
  joinBackendURL,
} from './compare-backends.mjs'
import {
  FIXTURE_MEMBER_SESSION_TOKEN,
  FIXTURE_SESSION_TOKEN,
} from './seed-dual-backend-fixture.mjs'

export const DEFAULT_PHOTOS_READ_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_PHOTOS_READ_DATABASE_PATH = './data/app.sqlite3'
export const DEFAULT_PHOTOS_READ_ADMIN_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`
export const DEFAULT_PHOTOS_READ_MEMBER_COOKIE = `cf_session=${FIXTURE_MEMBER_SESSION_TOKEN}`
export const DEFAULT_PHOTOS_READ_PREFIX = 'dual-photos-read'

export const PHOTOS_READ_ROUTE_IDS = Object.freeze([
  'photos.duplicate.check',
  'photos.list',
  'photos.map',
  'photos.status',
  'photos.visible',
])

const PROVIDERS = Object.freeze(['node', 'go'])
const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'
const PREVIEW_LIMIT_SETTING_PATH =
  '/api/system/settings/app/access.previewPhotoLimit'

export const PHOTOS_READ_CASES = Object.freeze([
  readCase(
    'anonymous public photo list is capped at 500',
    'photos.list',
    '/api/photos',
    'anonymous',
    'public-cap',
  ),
  readCase(
    'authenticated public photo list is complete',
    'photos.list',
    '/api/photos',
    'admin',
    'public-complete',
  ),
  readCase(
    'anonymous visible photo list is capped at 500',
    'photos.visible',
    '/api/photos/visible',
    'anonymous',
    'public-cap',
  ),
  readCase(
    'authenticated visible photo list is complete',
    'photos.visible',
    '/api/photos/visible',
    'admin',
    'public-complete',
  ),
  readCase(
    'administrator managed photo list',
    'photos.list',
    '/api/photos?scope=manage',
    'admin',
    'manage-admin',
  ),
  readCase(
    'member managed photo list is owner scoped',
    'photos.list',
    '/api/photos?scope=manage',
    'member',
    'manage-member',
  ),
  readCase(
    'managed photo pagination',
    'photos.list',
    '/api/photos?scope=manage&page=2&pageSize=17',
    'admin',
    'pagination',
  ),
  readCase(
    'managed photo meta-only response',
    'photos.list',
    '/api/photos?scope=manage&page=1&pageSize=17&metaOnly=true',
    'admin',
    'meta-only',
  ),
  readCase(
    'managed photo image filter',
    'photos.list',
    '/api/photos?scope=manage&page=1&pageSize=200&mediaType=image',
    'admin',
    'image-filter',
  ),
  readCase(
    'managed photo video filter',
    'photos.list',
    '/api/photos?scope=manage&page=1&pageSize=200&mediaType=video',
    'admin',
    'video-filter',
  ),
  readCase(
    'managed photo escaped wildcard search',
    'photos.list',
    '/api/photos?scope=manage&search=%25_',
    'admin',
    'read',
  ),
  readCase(
    'managed photo repeated query coercion',
    'photos.list',
    '/api/photos?scope=manage&page=2&page=1&pageSize=1&pageSize=2&mediaType=image&mediaType=video',
    'admin',
    'read',
  ),
  readCase(
    'anonymous photo map respects the preview cap',
    'photos.map',
    '/api/photos/map?zoom=2',
    'anonymous',
    'map-preview-cap',
  ),
  readCase(
    'authenticated photo map clusters large result sets',
    'photos.map',
    '/api/photos/map?zoom=2',
    'admin',
    'map-clustered',
  ),
  readCase(
    'high zoom photo map returns markers directly',
    'photos.map',
    '/api/photos/map?zoom=12',
    'admin',
    'map-unclustered',
  ),
  readCase(
    'photo map supports antimeridian bounds',
    'photos.map',
    '/api/photos/map?zoom=12&west=170&east=-170&south=-20&north=20',
    'admin',
    'map-antimeridian',
  ),
  readCase(
    'photo map supports ordinary bounds',
    'photos.map',
    '/api/photos/map?zoom=12&west=120&east=123&south=30&north=33',
    'admin',
    'map-shanghai',
  ),
  readCase(
    'photo map ignores incomplete bounds',
    'photos.map',
    '/api/photos/map?zoom=12&west=170&east=-170&south=-20',
    'admin',
    'map-unclustered',
  ),
  readCase(
    'photo map repeats query values with Node coercion',
    'photos.map',
    '/api/photos/map?zoom=12&zoom=2&west=170&west=-180&east=-170&south=-20&north=20',
    'admin',
    'read',
  ),
  readCase(
    'administrator photo status',
    'photos.status',
    '/api/photos/status',
    'admin',
    'status-admin',
    ['/timestamp'],
  ),
  readCase(
    'member photo status is owner scoped',
    'photos.status',
    '/api/photos/status',
    'member',
    'status-member',
    ['/timestamp'],
  ),
])

export const PHOTOS_READ_BOUNDARY_CASES = Object.freeze([
  boundary(
    'anonymous managed photo list',
    'GET',
    '/api/photos?scope=manage',
    'anonymous',
    401,
    'Unauthorized',
  ),
  boundary(
    'anonymous photo status',
    'GET',
    '/api/photos/status',
    'anonymous',
    401,
    'Unauthorized',
  ),
  boundary(
    'anonymous duplicate check',
    'POST',
    '/api/photos/check-duplicate',
    'anonymous',
    401,
    'Unauthorized',
    {},
  ),
  rawBoundary(
    'duplicate check missing body',
    undefined,
    400,
    'Validation Error',
  ),
  rawBoundary('duplicate check null body', 'null', 400, 'Validation Error'),
  rawBoundary('duplicate check malformed JSON', '{', 400, 'Bad Request'),
  boundary(
    'duplicate check missing all inputs',
    'POST',
    '/api/photos/check-duplicate',
    'admin',
    400,
    'Missing Required Parameter',
    {},
  ),
  boundary(
    'duplicate check rejects null array',
    'POST',
    '/api/photos/check-duplicate',
    'admin',
    400,
    'Validation Error',
    { fileNames: null },
  ),
  boundary(
    'duplicate check rejects non-string items',
    'POST',
    '/api/photos/check-duplicate',
    'admin',
    400,
    'Validation Error',
    { storageKeys: [1] },
  ),
])

export const PHOTOS_READ_DUPLICATE_CASES = Object.freeze([
  duplicateCase(
    'duplicate check accepts one empty array',
    { fileNames: [] },
    'empty',
  ),
  duplicateCase(
    'duplicate check accepts all empty arrays',
    { fileNames: [], storageKeys: [], contentHashes: [] },
    'empty',
  ),
  duplicateCase(
    'duplicate check normalizes and scopes content hashes',
    null,
    'hashes',
  ),
  duplicateCase(
    'duplicate check resolves file names and storage keys',
    null,
    'keys',
  ),
])

function readCase(name, routeId, path, cookie, assertion, normalizers = []) {
  return Object.freeze({
    name,
    routeId,
    method: 'GET',
    path,
    cookie,
    expectedStatus: 200,
    assertion,
    normalizers: Object.freeze([...normalizers]),
  })
}

function boundary(
  name,
  method,
  path,
  cookie,
  expectedStatus,
  expectedStatusMessage,
  body,
) {
  const result = {
    name,
    method,
    path,
    cookie,
    expectedStatus,
    expectedStatusMessage,
    assertion: 'boundary',
    normalizers: Object.freeze([]),
  }
  if (arguments.length >= 7) result.body = body
  return Object.freeze(result)
}

function rawBoundary(name, rawBody, expectedStatus, expectedStatusMessage) {
  const result = {
    name,
    method: 'POST',
    path: '/api/photos/check-duplicate',
    cookie: 'admin',
    expectedStatus,
    expectedStatusMessage,
    assertion: 'boundary',
    normalizers: Object.freeze([]),
  }
  if (rawBody !== undefined) result.rawBody = rawBody
  return Object.freeze(result)
}

function duplicateCase(name, body, assertion) {
  return Object.freeze({
    name,
    routeId: 'photos.duplicate.check',
    method: 'POST',
    path: '/api/photos/check-duplicate',
    cookie: 'admin',
    expectedStatus: 200,
    body,
    assertion,
    normalizers: Object.freeze([]),
  })
}

export function parsePhotosReadVerifierOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const values = new Map()
  const supported = new Set([
    '--base',
    '--node',
    '--go',
    '--admin-cookie',
    '--member-cookie',
    '--db',
    '--timeout-ms',
    '--prefix',
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (!supported.has(argument)) throw new Error(`Unknown option: ${argument}`)
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
        : DEFAULT_PHOTOS_READ_BASE_URL),
  )
  return {
    base,
    nodeURL: normalizeBaseURL(
      values.get('--node') || environment.CFRAME_DUAL_NODE_URL || base,
    ),
    goURL: normalizeBaseURL(
      values.get('--go') ||
        environment.CFRAME_DUAL_GO_URL ||
        `${base}/__lab/go`,
    ),
    adminCookie: normalizeCookie(
      values.get('--admin-cookie') ||
        environment.CFRAME_DUAL_ADMIN_COOKIE ||
        environment.CFRAME_DUAL_COOKIE ||
        DEFAULT_PHOTOS_READ_ADMIN_COOKIE,
      'admin-cookie',
    ),
    memberCookie: normalizeCookie(
      values.get('--member-cookie') ||
        environment.CFRAME_DUAL_MEMBER_COOKIE ||
        DEFAULT_PHOTOS_READ_MEMBER_COOKIE,
      'member-cookie',
    ),
    databasePath: normalizeDatabasePath(
      values.get('--db') ||
        environment.CFRAME_DUAL_DB_PATH ||
        environment.DATABASE_URL ||
        DEFAULT_PHOTOS_READ_DATABASE_PATH,
    ),
    timeoutMs: positiveInteger(
      values.get('--timeout-ms') ||
        environment.CFRAME_DUAL_TIMEOUT_MS ||
        10_000,
      'timeout-ms',
      60_000,
    ),
    prefix: normalizePrefix(
      values.get('--prefix') ||
        environment.CFRAME_DUAL_PHOTOS_READ_PREFIX ||
        DEFAULT_PHOTOS_READ_PREFIX,
    ),
  }
}

export async function verifyDualPhotosRead({
  base = DEFAULT_PHOTOS_READ_BASE_URL,
  nodeURL = base,
  goURL = `${base}/__lab/go`,
  adminCookie = DEFAULT_PHOTOS_READ_ADMIN_COOKIE,
  memberCookie = DEFAULT_PHOTOS_READ_MEMBER_COOKIE,
  databasePath = DEFAULT_PHOTOS_READ_DATABASE_PATH,
  timeoutMs = 10_000,
  prefix = DEFAULT_PHOTOS_READ_PREFIX,
  readCases = PHOTOS_READ_CASES,
  boundaryCases = PHOTOS_READ_BOUNDARY_CASES,
  duplicateCases = PHOTOS_READ_DUPLICATE_CASES,
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
    timeoutMs: positiveInteger(timeoutMs, 'timeout-ms', 60_000),
    prefix: normalizePrefix(prefix),
    fetchImpl,
  }
  const summary = {
    ok: false,
    base: options.base,
    nodeURL: options.nodeURL,
    goURL: options.goURL,
    databasePath: options.databasePath,
    routeIds: [...PHOTOS_READ_ROUTE_IDS],
    checks: [],
    cleanup: [],
  }
  const state = {
    previewLimit: undefined,
    seeded: false,
    fixture: fixtureState(options.prefix),
  }

  try {
    assertDatabaseAvailable(options.databasePath)
    await setProvider(options, summary, 'node')
    state.previewLimit = await readSettingValue(
      options,
      PREVIEW_LIMIT_SETTING_PATH,
    )
    seedPhotos(options.databasePath, state.fixture)
    state.seeded = true
    await setSettingValue(
      options,
      summary,
      PREVIEW_LIMIT_SETTING_PATH,
      700,
      'set legacy preview limit above public query cap',
    )

    for (const testCase of readCases) {
      await comparePair(options, summary, state, testCase)
    }
    for (const testCase of boundaryCases) {
      await comparePair(options, summary, state, testCase)
    }
    for (const testCase of duplicateCases) {
      const resolved = resolveDuplicateCase(testCase, state.fixture)
      await comparePair(options, summary, state, resolved)
    }
    for (const provider of PROVIDERS) {
      await verifyGatewaySwitch(options, summary, state, provider)
    }

    validateRouteEvidence(summary.checks)
    summary.ok = true
  } catch (error) {
    summary.errors =
      error instanceof PhotosReadVerificationFailure
        ? error.errors
        : [{ name: 'dual photos-read verifier', message: errorMessage(error) }]
  } finally {
    if (state.previewLimit !== undefined) {
      await cleanupStep(summary, 'restore preview photo limit', async () => {
        await setSettingValue(
          options,
          summary,
          PREVIEW_LIMIT_SETTING_PATH,
          state.previewLimit,
          undefined,
          false,
        )
      })
    }
    if (state.seeded) {
      await cleanupStep(summary, 'remove temporary photos-read fixtures', () =>
        deleteSeededPhotos(options.databasePath, state.fixture),
      )
    }
    await cleanupStep(summary, 'restore backend provider to node', () =>
      writeProvider(options, 'node'),
    )
  }

  summary.total = summary.checks.filter(
    (check) => check.kind !== 'setup',
  ).length
  summary.failed = summary.checks.filter((check) => check.ok === false).length
  if (summary.errors?.length && summary.failed === 0) summary.failed = 1
  if (summary.cleanup.some((entry) => entry.ok === false)) summary.ok = false
  return summary
}

function fixtureState(prefix) {
  return {
    idPrefix: `${prefix}-`,
    duplicateID: `${prefix}-existing`,
    duplicateFileName: `${prefix}-existing.jpg`,
    duplicateStorageKey: `dual-fixture/users/${DUAL_BACKEND_COMPARE_FIXTURE.userId}/${prefix}-existing.jpg`,
    duplicateHash: 'a'.repeat(64),
    hiddenID: `${prefix}-hidden`,
    memberID: `${prefix}-member`,
    mapCount: 530,
  }
}

function seedPhotos(databasePath, fixture) {
  const sqlite = new Database(databasePath)
  try {
    sqlite.pragma('busy_timeout = 5000')
    sqlite.pragma('foreign_keys = ON')
    const existing = sqlite
      .prepare('SELECT COUNT(*) AS count FROM photos WHERE id LIKE ?')
      .get(`${fixture.idPrefix}%`).count
    if (existing !== 0) {
      throw new Error(
        `Refusing to overwrite ${existing} existing photos matching ${fixture.idPrefix}%`,
      )
    }
    const insert = sqlite.prepare(
      `INSERT INTO photos (
         id, title, description, media_type, date_taken, storage_key,
         content_hash, last_modified, latitude, longitude, city, tags, exif,
         is_live_photo, owner_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    const insertAlbumPhoto = sqlite.prepare(
      `INSERT INTO album_photos (album_id, photo_id, position, added_at)
       VALUES (?, ?, ?, ?)`,
    )
    sqlite.transaction(() => {
      for (let index = 0; index < fixture.mapCount; index += 1) {
        const id =
          index === 0
            ? fixture.duplicateID
            : `${fixture.idPrefix}map-${String(index).padStart(4, '0')}`
        const longitude = index < fixture.mapCount / 2 ? 179.5 : -179.5
        const latitude = 10 + (index % 25) / 10_000
        const timestamp = new Date(
          Date.UTC(2029, 0, 1, 0, 0, index),
        ).toISOString()
        insert.run(
          id,
          index === 1
            ? `${prefixLabel(fixture)} 100%_literal`
            : `Photos Read Fixture ${index}`,
          `Temporary Node/Go photos-read parity row ${index}`,
          index > 0 && index % 13 === 0 ? 'video' : 'image',
          timestamp,
          index === 0 ? fixture.duplicateStorageKey : null,
          index === 0 ? fixture.duplicateHash : null,
          timestamp,
          latitude,
          longitude,
          'Dateline',
          JSON.stringify(['dual-backend', 'photos-read']),
          JSON.stringify({
            Make: 'ChronoFrame',
            Model: `ReadFixture-${index}`,
          }),
          DUAL_BACKEND_COMPARE_FIXTURE.userId,
        )
      }
      insert.run(
        fixture.memberID,
        'Photos Read Member Fixture',
        'Temporary member-owned row',
        'image',
        '2030-01-01T00:00:00.000Z',
        null,
        null,
        '2030-01-01T00:00:00.000Z',
        null,
        null,
        null,
        JSON.stringify(['dual-backend', 'member']),
        null,
        DUAL_BACKEND_COMPARE_FIXTURE.memberUserId,
      )
      insert.run(
        fixture.hiddenID,
        'Photos Read Hidden Fixture',
        'Temporary hidden-album row',
        'image',
        '2031-01-01T00:00:00.000Z',
        null,
        null,
        '2031-01-01T00:00:00.000Z',
        31.25,
        121.5,
        'Shanghai',
        null,
        null,
        DUAL_BACKEND_COMPARE_FIXTURE.userId,
      )
      insertAlbumPhoto.run(
        DUAL_BACKEND_COMPARE_FIXTURE.hiddenAlbumId,
        fixture.hiddenID,
        99_999,
        1_862_000_000,
      )
    })()
  } finally {
    sqlite.close()
  }
}

function prefixLabel(fixture) {
  return fixture.idPrefix.slice(0, -1)
}

function deleteSeededPhotos(databasePath, fixture) {
  const sqlite = new Database(databasePath)
  try {
    sqlite.pragma('busy_timeout = 5000')
    sqlite.pragma('foreign_keys = ON')
    sqlite.transaction(() => {
      sqlite
        .prepare('DELETE FROM album_photos WHERE photo_id LIKE ?')
        .run(`${fixture.idPrefix}%`)
      sqlite
        .prepare('DELETE FROM photos WHERE id LIKE ?')
        .run(`${fixture.idPrefix}%`)
    })()
    const remaining = sqlite
      .prepare('SELECT COUNT(*) AS count FROM photos WHERE id LIKE ?')
      .get(`${fixture.idPrefix}%`).count
    if (remaining !== 0)
      throw new Error(`${remaining} temporary photo rows remain`)
  } finally {
    sqlite.close()
  }
}

function resolveDuplicateCase(testCase, fixture) {
  if (testCase.assertion === 'hashes') {
    return {
      ...testCase,
      body: {
        contentHashes: [fixture.duplicateHash.toUpperCase(), ' invalid '],
      },
    }
  }
  if (testCase.assertion === 'keys') {
    return {
      ...testCase,
      body: {
        fileNames: [
          fixture.duplicateFileName,
          `${prefixLabel(fixture)}-missing.jpg`,
        ],
        storageKeys: [
          fixture.duplicateStorageKey,
          `${prefixLabel(fixture)}/missing.mp4`,
        ],
      },
    }
  }
  return testCase
}

async function comparePair(options, summary, state, testCase) {
  const requestID = `dual-photos-read-${randomUUID()}`
  const [node, go] = await Promise.all([
    executeRequest(options, {
      ...testCase,
      baseURL: options.nodeURL,
      expectedBackend: 'node',
      requestID,
    }),
    executeRequest(options, {
      ...testCase,
      baseURL: options.goURL,
      expectedBackend: 'go',
      requestID,
    }),
  ])
  const errors = validatePhotosReadPair(testCase, node, go)
  if (errors.length === 0) {
    errors.push(...validateAssertion(testCase, node.body, state.fixture))
  }
  summary.checks.push({
    name: testCase.name,
    routeId: testCase.routeId || routeIDForPath(testCase.path, testCase.method),
    kind: testCase.assertion === 'boundary' ? 'boundary' : 'parity',
    method: testCase.method,
    path: testCase.path,
    ok: errors.length === 0,
    node: compactResult(node),
    go: compactResult(go),
    differences: errors,
  })
  if (errors.length > 0) throw new PhotosReadVerificationFailure(errors)
  return { node, go }
}

export function validatePhotosReadPair(testCase, node, go) {
  const errors = []
  for (const [backend, result] of [
    ['node', node],
    ['go', go],
  ]) {
    if (result.status !== testCase.expectedStatus) {
      errors.push(
        difference(
          testCase.name,
          `${backend}.status`,
          testCase.expectedStatus,
          result.status,
        ),
      )
    }
    if (result.backend !== backend) {
      errors.push(
        difference(
          testCase.name,
          `${backend}.backend`,
          backend,
          result.backend,
        ),
      )
    }
    if (result.contentType !== 'application/json') {
      errors.push(
        difference(
          testCase.name,
          `${backend}.content-type`,
          'application/json',
          result.contentType,
        ),
      )
    }
  }
  if (node.requestID !== go.requestID) {
    errors.push(
      difference(testCase.name, 'x-request-id', node.requestID, go.requestID),
    )
  }
  const nodeBody = normalizedBody(node.body, testCase.normalizers || [])
  const goBody = normalizedBody(go.body, testCase.normalizers || [])
  if (JSON.stringify(nodeBody) !== JSON.stringify(goBody)) {
    errors.push(difference(testCase.name, 'body', nodeBody, goBody))
  }
  if (
    testCase.expectedStatusMessage !== undefined &&
    node.body?.statusMessage !== testCase.expectedStatusMessage
  ) {
    errors.push(
      difference(
        testCase.name,
        'body.statusMessage',
        testCase.expectedStatusMessage,
        node.body?.statusMessage,
      ),
    )
  }
  return errors
}

function validateAssertion(testCase, body, fixture) {
  const errors = []
  const fail = (field, expected, actual) =>
    errors.push(difference(testCase.name, field, expected, actual))
  switch (testCase.assertion) {
    case 'public-cap':
      if (!Array.isArray(body)) fail('body', 'array', body)
      else {
        if (body.length !== 500) fail('body.length', 500, body.length)
        if (body.some((photo) => photo.id === fixture.hiddenID)) {
          fail('body.hiddenPhoto', 'absent', 'present')
        }
      }
      break
    case 'public-complete':
      if (!Array.isArray(body)) fail('body', 'array', body)
      else {
        if (!body.some((photo) => photo.id === fixture.memberID)) {
          fail('body.memberFixture', 'present', 'absent')
        }
        if (body.some((photo) => photo.id === fixture.hiddenID)) {
          fail('body.hiddenPhoto', 'absent', 'present')
        }
      }
      break
    case 'manage-admin':
      if (!Array.isArray(body)) fail('body', 'array', body)
      else if (!body.some((photo) => photo.id === fixture.hiddenID)) {
        fail('body.hiddenManagedPhoto', 'present', 'absent')
      }
      break
    case 'manage-member':
      if (!Array.isArray(body)) fail('body', 'array', body)
      else {
        if (!body.some((photo) => photo.id === fixture.memberID)) {
          fail('body.memberFixture', 'present', 'absent')
        }
        if (
          body.some(
            (photo) =>
              photo.ownerUserId !== DUAL_BACKEND_COMPARE_FIXTURE.memberUserId,
          )
        ) {
          fail(
            'body.ownerScope',
            DUAL_BACKEND_COMPARE_FIXTURE.memberUserId,
            'mixed',
          )
        }
      }
      break
    case 'pagination':
      if (!Array.isArray(body?.items) || body.items.length !== 17) {
        fail('body.items.length', 17, body?.items?.length)
      }
      if (body?.page !== 2 || body?.pageSize !== 17) {
        fail(
          'body.pagination',
          { page: 2, pageSize: 17 },
          { page: body?.page, pageSize: body?.pageSize },
        )
      }
      break
    case 'meta-only':
      if (!Array.isArray(body?.items) || body.items.length !== 0) {
        fail('body.items', [], body?.items)
      }
      if (!(body?.total >= fixture.mapCount)) {
        fail('body.total', `>= ${fixture.mapCount}`, body?.total)
      }
      break
    case 'image-filter':
      if (body?.items?.some((photo) => photo.mediaType !== 'image')) {
        fail('body.items.mediaType', 'image only', 'mixed')
      }
      break
    case 'video-filter':
      if (
        !body?.items?.length ||
        body.items.some((photo) => photo.mediaType !== 'video')
      ) {
        fail('body.items.mediaType', 'non-empty video only', body?.items)
      }
      break
    case 'map-preview-cap':
      if (body?.total !== 500) fail('body.total', 500, body?.total)
      if (body?.clustered !== false)
        fail('body.clustered', false, body?.clustered)
      break
    case 'map-clustered':
      if (!(body?.total >= fixture.mapCount)) {
        fail('body.total', `>= ${fixture.mapCount}`, body?.total)
      }
      if (body?.clustered !== true || !body?.clusters?.length) {
        fail('body.clustered', 'true with clusters', body)
      }
      break
    case 'map-unclustered':
      if (body?.clustered !== false || body?.markers?.length !== body?.total) {
        fail('body', 'unclustered markers for every result', body)
      }
      break
    case 'map-antimeridian':
      if (body?.total !== fixture.mapCount) {
        fail('body.total', fixture.mapCount, body?.total)
      }
      break
    case 'map-shanghai':
      if (
        !body?.markers?.some(
          (photo) => photo.id === DUAL_BACKEND_COMPARE_FIXTURE.photoId,
        )
      ) {
        fail('body.fixturePhoto', 'present', 'absent')
      }
      if (body?.markers?.some((photo) => photo.id === fixture.hiddenID)) {
        fail('body.hiddenPhoto', 'absent', 'present')
      }
      break
    case 'status-member':
      if (!Array.isArray(body?.recentPhotos))
        fail('body.recentPhotos', 'array', body?.recentPhotos)
      else if (
        body.recentPhotos.some(
          (photo) =>
            photo.ownerUserId !== DUAL_BACKEND_COMPARE_FIXTURE.memberUserId,
        )
      ) {
        fail(
          'body.recentPhotos.ownerScope',
          DUAL_BACKEND_COMPARE_FIXTURE.memberUserId,
          'mixed',
        )
      }
      break
    case 'empty':
      if (
        body?.success !== true ||
        body?.duplicatesFound !== 0 ||
        !Array.isArray(body?.results) ||
        body.results.length !== 0
      ) {
        fail('body', 'successful empty duplicate result', body)
      }
      break
    case 'hashes':
      if (
        body?.duplicatesFound !== 1 ||
        body?.results?.[0]?.normalizedContentHash !== fixture.duplicateHash ||
        body?.results?.[0]?.photo?.id !== fixture.duplicateID ||
        body?.results?.[1]?.normalizedContentHash !== null ||
        body?.results?.[1]?.exists !== false
      ) {
        fail('body', 'one normalized owner-scoped hash duplicate', body)
      }
      break
    case 'keys':
      if (
        body?.duplicatesFound !== 2 ||
        body?.results?.[0]?.photo?.id !== fixture.duplicateID ||
        body?.results?.[1]?.exists !== false ||
        body?.results?.[2]?.photo?.id !== fixture.duplicateID ||
        body?.results?.[3]?.exists !== false
      ) {
        fail('body', 'matching filename and storage-key duplicates only', body)
      }
      break
  }
  return errors
}

async function verifyGatewaySwitch(options, summary, state, provider) {
  await setProvider(options, summary, provider)
  const read = await executeRequest(options, {
    name: `gateway photo read after switching to ${provider}`,
    baseURL: options.base,
    expectedBackend: provider,
    method: 'GET',
    path: '/api/photos?scope=manage&page=1&pageSize=3',
    cookie: 'admin',
    expectedStatus: 200,
    requestID: `dual-photos-read-switch-${randomUUID()}`,
  })
  const errors = []
  if (read.status !== 200)
    errors.push(difference(read.name, 'status', 200, read.status))
  if (read.backend !== provider)
    errors.push(difference(read.name, 'backend', provider, read.backend))
  if (!Array.isArray(read.body?.items) || read.body.items.length !== 3) {
    errors.push(
      difference(read.name, 'body.items.length', 3, read.body?.items?.length),
    )
  }
  summary.checks.push({
    name: read.name,
    routeId: 'photos.list',
    kind: 'switch',
    method: 'GET',
    path: '/api/photos?scope=manage&page=1&pageSize=3',
    ok: errors.length === 0,
    [provider]: compactResult(read),
    differences: errors,
  })
  if (errors.length > 0) throw new PhotosReadVerificationFailure(errors)

  const duplicate = await executeRequest(options, {
    name: `gateway duplicate check after switching to ${provider}`,
    baseURL: options.base,
    expectedBackend: provider,
    method: 'POST',
    path: '/api/photos/check-duplicate',
    cookie: 'admin',
    body: { fileNames: [] },
    expectedStatus: 200,
    requestID: `dual-photos-read-switch-duplicate-${randomUUID()}`,
  })
  const duplicateErrors = validateAssertion(
    { name: duplicate.name, assertion: 'empty' },
    duplicate.body,
    state.fixture,
  )
  if (duplicate.status !== 200) {
    duplicateErrors.push(
      difference(duplicate.name, 'status', 200, duplicate.status),
    )
  }
  if (duplicate.backend !== provider) {
    duplicateErrors.push(
      difference(duplicate.name, 'backend', provider, duplicate.backend),
    )
  }
  summary.checks.push({
    name: duplicate.name,
    routeId: 'photos.duplicate.check',
    kind: 'switch',
    method: 'POST',
    path: '/api/photos/check-duplicate',
    ok: duplicateErrors.length === 0,
    [provider]: compactResult(duplicate),
    differences: duplicateErrors,
  })
  if (duplicateErrors.length > 0) {
    throw new PhotosReadVerificationFailure(duplicateErrors)
  }
}

async function executeRequest(options, request) {
  const headers = {
    Accept: 'application/json',
    'X-Request-Id': request.requestID,
  }
  const cookie = cookieValue(options, request.cookie)
  if (cookie) headers.Cookie = cookie
  let body
  if (Object.hasOwn(request, 'rawBody')) {
    body = request.rawBody
    headers['Content-Type'] = 'application/json'
  } else if (Object.hasOwn(request, 'body')) {
    body = JSON.stringify(request.body)
    headers['Content-Type'] = 'application/json'
  }
  const response = await options.fetchImpl(
    joinBackendURL(request.baseURL, request.path),
    {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    },
  )
  const text = await response.text()
  let parsed
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = text
  }
  return {
    name: request.name,
    status: response.status,
    backend: response.headers.get('x-chronoframe-backend'),
    requestID: response.headers.get('x-request-id'),
    contentType:
      response.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase() ||
      '',
    body: parsed,
  }
}

function cookieValue(options, cookie) {
  if (!cookie || cookie === 'anonymous') return undefined
  if (cookie === 'admin') return options.adminCookie
  if (cookie === 'member') return options.memberCookie
  throw new Error(`Unknown cookie alias: ${cookie}`)
}

function normalizedBody(body, normalizers) {
  const copy = structuredClone(body)
  for (const pointer of normalizers) removeJSONPointer(copy, pointer)
  return canonicalize(copy)
}

function removeJSONPointer(value, pointer) {
  const segments = pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
  let cursor = value
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (cursor === null || typeof cursor !== 'object') return
    cursor = cursor[segments[index]]
  }
  if (cursor !== null && typeof cursor === 'object') {
    delete cursor[segments.at(-1)]
  }
}

async function readSettingValue(options, path) {
  const response = await executeRequest(options, {
    name: `read setting ${path}`,
    baseURL: options.nodeURL,
    expectedBackend: 'node',
    method: 'GET',
    path,
    cookie: 'admin',
    expectedStatus: 200,
    requestID: `dual-photos-read-setting-${randomUUID()}`,
  })
  if (response.status !== 200) {
    throw new Error(`Unable to read ${path}: status ${response.status}`)
  }
  return response.body?.value
}

async function setSettingValue(
  options,
  summary,
  path,
  value,
  name,
  record = true,
) {
  const response = await executeRequest(options, {
    name: name || `set ${path}`,
    baseURL: options.nodeURL,
    expectedBackend: 'node',
    method: 'PUT',
    path,
    cookie: 'admin',
    body: { value },
    expectedStatus: 200,
    requestID: `dual-photos-read-setting-${randomUUID()}`,
  })
  const ok = response.status === 200
  if (record) {
    summary.checks.push({
      name: response.name,
      kind: 'setup',
      ok,
      node: compactResult(response),
      differences: ok
        ? []
        : [difference(response.name, 'status', 200, response.status)],
    })
  }
  if (!ok) throw new Error(`${response.name}: status ${response.status}`)
}

async function setProvider(options, summary, provider) {
  const response = await writeProvider(options, provider)
  const ok = response.status === 200
  summary.checks.push({
    name: `set backend provider to ${provider}`,
    kind: 'setup',
    ok,
    node: compactResult(response),
    differences: ok
      ? []
      : [
          difference(
            `set backend provider to ${provider}`,
            'status',
            200,
            response.status,
          ),
        ],
  })
  if (!ok) throw new Error(`Unable to set backend provider to ${provider}`)
}

async function writeProvider(options, provider) {
  return executeRequest(options, {
    name: `set backend provider to ${provider}`,
    baseURL: options.nodeURL,
    expectedBackend: 'node',
    method: 'PUT',
    path: PROVIDER_SETTING_PATH,
    cookie: 'admin',
    body: { value: provider },
    expectedStatus: 200,
    requestID: `dual-photos-read-provider-${randomUUID()}`,
  })
}

function validateRouteEvidence(checks) {
  const missing = PHOTOS_READ_ROUTE_IDS.filter(
    (routeId) => !checks.some((check) => check.routeId === routeId && check.ok),
  )
  if (missing.length > 0) {
    throw new Error(
      `Missing passing evidence for routes: ${missing.join(', ')}`,
    )
  }
}

async function cleanupStep(summary, name, operation) {
  try {
    await operation()
    summary.cleanup.push({ name, ok: true })
  } catch (error) {
    summary.cleanup.push({ name, ok: false, error: errorMessage(error) })
  }
}

function routeIDForPath(path, method) {
  const pathname = new URL(path, 'http://photos-read.local').pathname
  if (pathname === '/api/photos/check-duplicate')
    return 'photos.duplicate.check'
  if (pathname === '/api/photos/map') return 'photos.map'
  if (pathname === '/api/photos/status') return 'photos.status'
  if (pathname === '/api/photos/visible') return 'photos.visible'
  if (pathname === '/api/photos' && method === 'GET') return 'photos.list'
  return undefined
}

function compactResult(result) {
  return {
    status: result.status,
    backend: result.backend,
    contentType: result.contentType,
  }
}

function difference(name, field, expected, actual) {
  return { name, field, expected, actual }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function assertDatabaseAvailable(databasePath) {
  if (!existsSync(databasePath)) {
    throw new Error(`SQLite database does not exist: ${databasePath}`)
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

function normalizeCookie(value, label) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`${label} must not be empty`)
  return normalized
}

function normalizeDatabasePath(value) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error('db must not be empty')
  return normalized
}

function normalizePrefix(value) {
  const normalized = String(value || '').trim()
  if (!/^[a-z0-9][a-z0-9_-]{0,19}$/i.test(normalized)) {
    throw new Error(
      'prefix must be 1-20 characters using letters, numbers, underscore, or dash',
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

export class PhotosReadVerificationFailure extends Error {
  constructor(errors) {
    super(errors.map((entry) => `${entry.name}: ${entry.field}`).join('; '))
    this.name = 'PhotosReadVerificationFailure'
    this.errors = errors
  }
}

async function main() {
  const result = await verifyDualPhotosRead(parsePhotosReadVerifierOptions())
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

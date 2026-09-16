#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import {
  canonicalize,
  DUAL_BACKEND_COMPARE_FIXTURE,
  joinBackendURL,
} from './compare-backends.mjs'
import {
  FIXTURE_MEMBER_SESSION_TOKEN,
  FIXTURE_SESSION_TOKEN,
} from './seed-dual-backend-fixture.mjs'

export const DEFAULT_ALBUMS_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_ALBUMS_ADMIN_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`
export const DEFAULT_ALBUMS_MEMBER_COOKIE = `cf_session=${FIXTURE_MEMBER_SESSION_TOKEN}`
export const DEFAULT_ALBUMS_PREFIX = 'dual-albums'

export const ALBUM_ROUTE_IDS = Object.freeze([
  'albums.delete',
  'albums.detail',
  'albums.update',
  'albums.photos.remove',
  'albums.reorder',
  'albums.list',
  'albums.create',
  'photos.albums.read',
  'photos.albums.update',
  'photos.albums.bulk-update',
])

const PROVIDERS = Object.freeze(['node', 'go'])
const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'
const FIXTURE_ALBUM_PATH = `/api/albums/${DUAL_BACKEND_COMPARE_FIXTURE.albumId}`
const HIDDEN_ALBUM_PATH = `/api/albums/${DUAL_BACKEND_COMPARE_FIXTURE.hiddenAlbumId}`
const FIXTURE_PHOTO_ALBUMS_PATH = `/api/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}/albums`
const MUTABLE_PHOTO_ALBUMS_PATH = `/api/photos/${DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId}/albums`
const BULK_PHOTO_ALBUMS_PATH = '/api/photos/albums'
const MUTATION_ALBUM_KEYS = Object.freeze([
  'coverPhotoId',
  'createdAt',
  'description',
  'id',
  'isHidden',
  'ownerUserId',
  'position',
  'title',
  'updatedAt',
])

export const ALBUM_READ_CASES = Object.freeze([
  Object.freeze({
    name: 'public album list',
    path: '/api/albums',
    cookie: 'anonymous',
  }),
  Object.freeze({
    name: 'managed album list',
    path: '/api/albums?scope=manage',
    cookie: 'admin',
  }),
  Object.freeze({
    name: 'visible album detail',
    path: FIXTURE_ALBUM_PATH,
    cookie: 'admin',
  }),
  Object.freeze({
    name: 'hidden album detail for owner',
    path: HIDDEN_ALBUM_PATH,
    cookie: 'admin',
  }),
  Object.freeze({
    name: 'photo album associations',
    path: FIXTURE_PHOTO_ALBUMS_PATH,
    cookie: 'admin',
  }),
])

export const ALBUM_BOUNDARY_CASES = Object.freeze([
  boundary(
    'anonymous managed album list',
    'GET',
    '/api/albums?scope=manage',
    'anonymous',
    401,
    'Unauthorized',
  ),
  boundary(
    'anonymous album create',
    'POST',
    '/api/albums',
    'anonymous',
    401,
    'Unauthorized',
    { title: 'not-created' },
  ),
  boundary(
    'anonymous album update',
    'PUT',
    FIXTURE_ALBUM_PATH,
    'anonymous',
    401,
    'Unauthorized',
    { title: 'not-updated' },
  ),
  boundary(
    'anonymous album delete',
    'DELETE',
    FIXTURE_ALBUM_PATH,
    'anonymous',
    401,
    'Unauthorized',
  ),
  boundary(
    'anonymous album photo remove',
    'DELETE',
    `${FIXTURE_ALBUM_PATH}/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}`,
    'anonymous',
    401,
    'Unauthorized',
  ),
  boundary(
    'anonymous photo albums update',
    'PUT',
    FIXTURE_PHOTO_ALBUMS_PATH,
    'anonymous',
    401,
    'Unauthorized',
    { albumIds: [] },
  ),
  boundary(
    'anonymous photo albums bulk update',
    'PUT',
    BULK_PHOTO_ALBUMS_PATH,
    'anonymous',
    401,
    'Unauthorized',
    {
      photoIds: [DUAL_BACKEND_COMPARE_FIXTURE.photoId],
      albumIds: [],
      mode: 'replace',
    },
  ),
  boundary(
    'member cannot update another owner album',
    'PUT',
    FIXTURE_ALBUM_PATH,
    'member',
    404,
    'Album not found',
    { title: 'not-updated' },
  ),
  boundary(
    'member cannot delete another owner album',
    'DELETE',
    FIXTURE_ALBUM_PATH,
    'member',
    404,
    'Album not found',
  ),
  boundary(
    'member cannot remove from another owner album',
    'DELETE',
    `${FIXTURE_ALBUM_PATH}/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}`,
    'member',
    404,
    'Album not found',
  ),
  boundary(
    'member cannot update another owner photo albums',
    'PUT',
    FIXTURE_PHOTO_ALBUMS_PATH,
    'member',
    404,
    'Photo not found',
    { albumIds: [] },
  ),
  boundary(
    'member cannot bulk update another owner photo albums',
    'PUT',
    BULK_PHOTO_ALBUMS_PATH,
    'member',
    404,
    'Photo not found',
    {
      photoIds: [DUAL_BACKEND_COMPARE_FIXTURE.photoId],
      albumIds: [],
      mode: 'replace',
    },
  ),
  boundary(
    'invalid album detail id',
    'GET',
    '/api/albums/not-a-number',
    'admin',
    400,
    'Validation Error',
  ),
  boundary(
    'invalid album update id',
    'PUT',
    '/api/albums/not-a-number',
    'admin',
    400,
    'Validation Error',
    { title: 'valid' },
  ),
  boundary(
    'invalid album delete id',
    'DELETE',
    '/api/albums/not-a-number',
    'admin',
    400,
    'Validation Error',
  ),
  boundary(
    'invalid album photo remove id',
    'DELETE',
    `/api/albums/not-a-number/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}`,
    'admin',
    400,
    'Validation Error',
  ),
  boundary(
    'album create missing title',
    'POST',
    '/api/albums',
    'admin',
    400,
    'Validation Error',
    {},
  ),
  boundary(
    'album create null optional fields',
    'POST',
    '/api/albums',
    'admin',
    400,
    'Validation Error',
    {
      title: 'valid',
      description: null,
      coverPhotoId: null,
      photoIds: null,
      isHidden: null,
    },
  ),
  boundary(
    'album create invalid field types',
    'POST',
    '/api/albums',
    'admin',
    400,
    'Validation Error',
    {
      title: 1,
      description: true,
      coverPhotoId: 2,
      photoIds: {},
      isHidden: 'false',
    },
  ),
  boundary(
    'album create empty title',
    'POST',
    '/api/albums',
    'admin',
    400,
    'Validation Error',
    { title: '' },
  ),
  boundary(
    'album create title UTF-16 upper bound',
    'POST',
    '/api/albums',
    'admin',
    400,
    'Validation Error',
    { title: '😀'.repeat(128) },
  ),
  boundary(
    'album create description upper bound',
    'POST',
    '/api/albums',
    'admin',
    400,
    'Validation Error',
    { title: 'valid', description: 'x'.repeat(1001) },
  ),
  boundary(
    'album create missing photo',
    'POST',
    '/api/albums',
    'admin',
    404,
    'Photo not found',
    { title: 'valid', photoIds: ['dual-albums-missing-photo'] },
  ),
  boundary(
    'album update null optional fields',
    'PUT',
    FIXTURE_ALBUM_PATH,
    'admin',
    400,
    'Validation Error',
    {
      title: null,
      description: null,
      coverPhotoId: null,
      photoIds: null,
      isHidden: null,
    },
  ),
  boundary(
    'album update invalid field types',
    'PUT',
    FIXTURE_ALBUM_PATH,
    'admin',
    400,
    'Validation Error',
    {
      title: 1,
      description: true,
      coverPhotoId: 2,
      photoIds: {},
      isHidden: 'false',
    },
  ),
  boundary(
    'album update title upper bound',
    'PUT',
    FIXTURE_ALBUM_PATH,
    'admin',
    400,
    'Validation Error',
    { title: 'x'.repeat(256) },
  ),
  boundary(
    'album update missing album',
    'PUT',
    '/api/albums/99999999',
    'admin',
    404,
    'Album not found',
    { title: 'missing' },
  ),
  boundary(
    'album update missing photo',
    'PUT',
    FIXTURE_ALBUM_PATH,
    'admin',
    404,
    'Photo not found',
    { coverPhotoId: 'dual-albums-missing-photo' },
  ),
  boundary(
    'album delete missing album',
    'DELETE',
    '/api/albums/99999999',
    'admin',
    404,
    'Album not found',
  ),
  boundary(
    'album photo remove missing album',
    'DELETE',
    `/api/albums/99999999/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}`,
    'admin',
    404,
    'Album not found',
  ),
  boundary(
    'album photo remove missing relation',
    'DELETE',
    `${FIXTURE_ALBUM_PATH}/photos/${DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId}`,
    'admin',
    404,
    'Photo not found in album',
  ),
  boundary(
    'album photo remove preserves whitespace id',
    'DELETE',
    `${FIXTURE_ALBUM_PATH}/photos/%20`,
    'admin',
    404,
    'Photo not found in album',
  ),
  boundary(
    'photo albums rejects non-positive album id',
    'PUT',
    FIXTURE_PHOTO_ALBUMS_PATH,
    'admin',
    400,
    'Validation Error',
    { albumIds: [0] },
  ),
  boundary(
    'photo albums rejects missing photo',
    'PUT',
    '/api/photos/dual-albums-missing-photo/albums',
    'admin',
    404,
    'Photo not found',
    { albumIds: [] },
  ),
  boundary(
    'photo albums rejects missing album',
    'PUT',
    FIXTURE_PHOTO_ALBUMS_PATH,
    'admin',
    404,
    'Album not found',
    { albumIds: [99999999] },
  ),
  boundary(
    'photo albums bulk requires photo ids',
    'PUT',
    BULK_PHOTO_ALBUMS_PATH,
    'admin',
    400,
    'Validation Error',
    { albumIds: [] },
  ),
  boundary(
    'photo albums bulk rejects empty photo ids',
    'PUT',
    BULK_PHOTO_ALBUMS_PATH,
    'admin',
    400,
    'Validation Error',
    { photoIds: [], albumIds: [] },
  ),
  boundary(
    'photo albums bulk rejects empty photo id item',
    'PUT',
    BULK_PHOTO_ALBUMS_PATH,
    'admin',
    400,
    'Validation Error',
    { photoIds: [''], albumIds: [] },
  ),
  boundary(
    'photo albums bulk rejects non-positive album id',
    'PUT',
    BULK_PHOTO_ALBUMS_PATH,
    'admin',
    400,
    'Validation Error',
    { photoIds: [DUAL_BACKEND_COMPARE_FIXTURE.photoId], albumIds: [0] },
  ),
  boundary(
    'photo albums bulk rejects invalid mode',
    'PUT',
    BULK_PHOTO_ALBUMS_PATH,
    'admin',
    400,
    'Validation Error',
    {
      photoIds: [DUAL_BACKEND_COMPARE_FIXTURE.photoId],
      albumIds: [],
      mode: 'merge',
    },
  ),
  boundary(
    'photo albums bulk rejects missing photo',
    'PUT',
    BULK_PHOTO_ALBUMS_PATH,
    'admin',
    404,
    'Photo not found',
    { photoIds: ['dual-albums-missing-photo'], albumIds: [], mode: 'replace' },
  ),
  boundary(
    'photo albums bulk rejects missing album',
    'PUT',
    BULK_PHOTO_ALBUMS_PATH,
    'admin',
    404,
    'Album not found',
    {
      photoIds: [DUAL_BACKEND_COMPARE_FIXTURE.photoId],
      albumIds: [99999999],
      mode: 'replace',
    },
  ),
])

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
  }
  if (arguments.length >= 7) result.body = body
  return Object.freeze(result)
}

export function parseAlbumsVerifierOptions(
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
    '--timeout-ms',
    '--prefix',
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (!supported.has(arg)) throw new Error(`Unknown option: ${arg}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`)
    }
    values.set(arg, value)
    index += 1
  }

  const base = normalizeBaseURL(
    values.get('--base') ||
      environment.CFRAME_DUAL_BASE_URL ||
      (environment.CFRAME_DUAL_PORT
        ? `http://127.0.0.1:${environment.CFRAME_DUAL_PORT}`
        : DEFAULT_ALBUMS_BASE_URL),
  )
  const timeoutMs = positiveInteger(
    values.get('--timeout-ms') || environment.CFRAME_DUAL_TIMEOUT_MS || 5_000,
    'timeout-ms',
  )
  if (timeoutMs > 60_000) throw new Error('timeout-ms must be 60000 or less')

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
        DEFAULT_ALBUMS_ADMIN_COOKIE,
      'admin-cookie',
    ),
    memberCookie: normalizeCookie(
      values.get('--member-cookie') ||
        environment.CFRAME_DUAL_MEMBER_COOKIE ||
        DEFAULT_ALBUMS_MEMBER_COOKIE,
      'member-cookie',
    ),
    timeoutMs,
    prefix: normalizePrefix(
      values.get('--prefix') ||
        environment.CFRAME_DUAL_ALBUMS_PREFIX ||
        DEFAULT_ALBUMS_PREFIX,
    ),
  }
}

export async function verifyDualAlbums({
  base = DEFAULT_ALBUMS_BASE_URL,
  nodeURL = base,
  goURL = `${base}/__lab/go`,
  adminCookie = DEFAULT_ALBUMS_ADMIN_COOKIE,
  memberCookie = DEFAULT_ALBUMS_MEMBER_COOKIE,
  timeoutMs = 5_000,
  prefix = DEFAULT_ALBUMS_PREFIX,
  readCases = ALBUM_READ_CASES,
  boundaryCases = ALBUM_BOUNDARY_CASES,
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
    timeoutMs: positiveInteger(timeoutMs, 'timeout-ms'),
    prefix: normalizePrefix(prefix),
    fetchImpl,
  }
  const summary = {
    ok: false,
    base: options.base,
    nodeURL: options.nodeURL,
    goURL: options.goURL,
    routeIds: [...ALBUM_ROUTE_IDS],
    checks: [],
    cleanup: [],
  }
  const state = {
    originalProvider: undefined,
    originalMutableAlbumIds: undefined,
    temporaryAlbumIds: new Set(),
  }

  try {
    state.originalProvider = await readProvider(options, summary)
    await setProvider(options, summary, 'node')
    state.originalMutableAlbumIds = albumIDs(
      (
        await requestOne(options, summary, {
          name: 'capture editable photo album associations',
          baseURL: options.nodeURL,
          expectedBackend: 'node',
          method: 'GET',
          path: MUTABLE_PHOTO_ALBUMS_PATH,
          cookie: 'admin',
        })
      ).body,
    )

    for (const testCase of readCases) {
      await comparePair(options, summary, {
        ...testCase,
        method: 'GET',
        expectedStatus: 200,
        kind: 'read',
      })
    }
    for (const testCase of boundaryCases) {
      await comparePair(options, summary, { ...testCase, kind: 'boundary' })
    }
    for (const creator of PROVIDERS) {
      await verifyLifecycle(options, summary, state, creator)
    }

    summary.ok = true
  } catch (error) {
    summary.errors =
      error instanceof AlbumVerificationFailure
        ? error.errors
        : [{ name: 'dual album verifier', message: errorMessage(error) }]
  } finally {
    await cleanupAlbums(options, summary, state)
  }
  summary.total = summary.checks.length
  summary.failed = summary.checks.filter((check) => check.ok === false).length
  if (summary.errors?.length && summary.failed === 0) summary.failed = 1
  if (summary.cleanup.some((entry) => entry.ok === false)) summary.ok = false
  return summary
}

async function verifyLifecycle(options, summary, state, creator) {
  const other = creator === 'node' ? 'go' : 'node'
  const token = `${options.prefix}-${creator}-${randomUUID().slice(0, 8)}`
  const title = `  ${token} created  `
  const updatedTitle = `  ${token} updated by ${other}  `
  const description = `  ${token} description  `
  const updatedDescription = `  ${token} updated description  `

  await setProvider(options, summary, creator)
  const created = await requestOne(options, summary, {
    name: `album create via ${creator}`,
    baseURL: options.base,
    expectedBackend: creator,
    method: 'POST',
    path: '/api/albums',
    cookie: 'admin',
    body: {
      title,
      description,
      coverPhotoId: DUAL_BACKEND_COMPARE_FIXTURE.photoId,
      photoIds: [
        DUAL_BACKEND_COMPARE_FIXTURE.photoId,
        DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId,
        DUAL_BACKEND_COMPARE_FIXTURE.photoId,
      ],
      isHidden: true,
    },
  })
  expectExactKeys(created.name, created.body, MUTATION_ALBUM_KEYS)
  const albumID = requirePositiveInteger(
    created.name,
    created.body?.id,
    'body.id',
  )
  state.temporaryAlbumIds.add(albumID)
  expectEqual(created.name, created.body?.title, title, 'body.title')
  expectEqual(
    created.name,
    created.body?.description,
    description,
    'body.description',
  )
  expectEqual(
    created.name,
    created.body?.coverPhotoId,
    DUAL_BACKEND_COMPARE_FIXTURE.photoId,
    'body.coverPhotoId',
  )
  expectEqual(created.name, created.body?.isHidden, true, 'body.isHidden')

  await setProvider(options, summary, other)
  const crossDetail = await requestOne(options, summary, {
    name: `album detail via ${other} after ${creator} create`,
    baseURL: options.base,
    expectedBackend: other,
    method: 'GET',
    path: `/api/albums/${albumID}`,
    cookie: 'admin',
  })
  expectEqual(
    crossDetail.name,
    crossDetail.body?.totalPhotoCount,
    2,
    'body.totalPhotoCount',
  )
  expectEqual(
    crossDetail.name,
    crossDetail.body?.coverPhotoId,
    DUAL_BACKEND_COMPARE_FIXTURE.photoId,
    'body.coverPhotoId',
  )
  expectEqual(crossDetail.name, crossDetail.body?.title, title, 'body.title')

  const managedList = await requestOne(options, summary, {
    name: `managed album list via ${other} after ${creator} create`,
    baseURL: options.base,
    expectedBackend: other,
    method: 'GET',
    path: '/api/albums?scope=manage',
    cookie: 'admin',
  })
  const listed = findAlbum(managedList.body, albumID)
  expectEqual(managedList.name, listed?.title, title, 'body[].title')
  expectEqual(
    managedList.name,
    listed?.photoIds,
    [
      DUAL_BACKEND_COMPARE_FIXTURE.photoId,
      DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId,
    ],
    'body[].photoIds',
  )

  const updated = await requestOne(options, summary, {
    name: `album update via ${other}`,
    baseURL: options.base,
    expectedBackend: other,
    method: 'PUT',
    path: `/api/albums/${albumID}`,
    cookie: 'admin',
    body: {
      title: updatedTitle,
      description: updatedDescription,
      coverPhotoId: DUAL_BACKEND_COMPARE_FIXTURE.photoId,
      photoIds: [
        DUAL_BACKEND_COMPARE_FIXTURE.photoId,
        DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId,
      ],
      isHidden: true,
    },
  })
  expectExactKeys(updated.name, updated.body, MUTATION_ALBUM_KEYS)
  expectEqual(updated.name, updated.body?.title, updatedTitle, 'body.title')
  expectEqual(
    updated.name,
    updated.body?.description,
    updatedDescription,
    'body.description',
  )

  await setProvider(options, summary, creator)
  const removed = await requestOne(options, summary, {
    name: `album cover photo remove via ${creator}`,
    baseURL: options.base,
    expectedBackend: creator,
    method: 'DELETE',
    path: `/api/albums/${albumID}/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}`,
    cookie: 'admin',
  })
  expectEqual(removed.name, removed.body, { success: true }, 'body')

  await setProvider(options, summary, other)
  const afterRemove = await requestOne(options, summary, {
    name: `album detail via ${other} after ${creator} remove`,
    baseURL: options.base,
    expectedBackend: other,
    method: 'GET',
    path: `/api/albums/${albumID}`,
    cookie: 'admin',
  })
  expectEqual(
    afterRemove.name,
    afterRemove.body?.coverPhotoId,
    null,
    'body.coverPhotoId',
  )
  expectEqual(
    afterRemove.name,
    afterRemove.body?.totalPhotoCount,
    1,
    'body.totalPhotoCount',
  )
  expectEqual(
    afterRemove.name,
    afterRemove.body?.photos?.map((photo) => photo.id),
    [DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId],
    'body.photos[].id',
  )

  const desiredAlbumIDs = uniquePositiveIntegers([
    ...(state.originalMutableAlbumIds || []),
    albumID,
  ])
  const associationUpdate = await requestOne(options, summary, {
    name: `photo albums update via ${other}`,
    baseURL: options.base,
    expectedBackend: other,
    method: 'PUT',
    path: MUTABLE_PHOTO_ALBUMS_PATH,
    cookie: 'admin',
    body: { albumIds: desiredAlbumIDs },
  })
  expectExactKeys(associationUpdate.name, associationUpdate.body, [
    'albumIds',
    'albums',
    'photoId',
  ])
  expectEqual(
    associationUpdate.name,
    associationUpdate.body?.photoId,
    DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId,
    'body.photoId',
  )
  expectIncludes(
    associationUpdate.name,
    associationUpdate.body?.albumIds,
    albumID,
    'body.albumIds',
  )

  await setProvider(options, summary, creator)
  const crossAssociations = await requestOne(options, summary, {
    name: `photo album associations via ${creator} after ${other} update`,
    baseURL: options.base,
    expectedBackend: creator,
    method: 'GET',
    path: MUTABLE_PHOTO_ALBUMS_PATH,
    cookie: 'admin',
  })
  expectIncludes(
    crossAssociations.name,
    albumIDs(crossAssociations.body),
    albumID,
    'body[].id',
  )

  const bulkRemove = await requestOne(options, summary, {
    name: `photo albums bulk remove via ${creator}`,
    baseURL: options.base,
    expectedBackend: creator,
    method: 'PUT',
    path: BULK_PHOTO_ALBUMS_PATH,
    cookie: 'admin',
    body: {
      photoIds: [DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId],
      albumIds: [albumID],
      mode: 'remove',
    },
  })
  expectEqual(
    bulkRemove.name,
    bulkRemove.body,
    {
      success: true,
      updatedCount: 1,
      mode: 'remove',
    },
    'body',
  )

  await setProvider(options, summary, other)
  const afterBulkRemove = await requestOne(options, summary, {
    name: `photo album associations via ${other} after ${creator} bulk remove`,
    baseURL: options.base,
    expectedBackend: other,
    method: 'GET',
    path: MUTABLE_PHOTO_ALBUMS_PATH,
    cookie: 'admin',
  })
  expectEqual(
    afterBulkRemove.name,
    albumIDs(afterBulkRemove.body).includes(albumID),
    false,
    'body[].id includes temporary album',
  )

  const deleted = await requestOne(options, summary, {
    name: `album delete via ${other}`,
    baseURL: options.base,
    expectedBackend: other,
    method: 'DELETE',
    path: `/api/albums/${albumID}`,
    cookie: 'admin',
  })
  expectEqual(deleted.name, deleted.body, { success: true }, 'body')
  state.temporaryAlbumIds.delete(albumID)

  await setProvider(options, summary, 'node')
  await comparePair(options, summary, {
    name: `deleted album is absent after ${creator} lifecycle`,
    method: 'GET',
    path: `/api/albums/${albumID}`,
    cookie: 'admin',
    expectedStatus: 404,
    expectedStatusMessage: 'Album not found',
    kind: 'boundary',
  })
}

async function comparePair(options, summary, testCase) {
  const requestID = `dual-albums-${randomUUID()}`
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
  const errors = validateAlbumPair(testCase, node, go)
  const result = {
    name: testCase.name,
    kind: testCase.kind,
    method: testCase.method,
    path: testCase.path,
    ok: errors.length === 0,
    node: compactResult(node),
    go: compactResult(go),
    differences: errors,
  }
  summary.checks.push(result)
  if (errors.length > 0) throw new AlbumVerificationFailure(errors)
  return result
}

export function validateAlbumPair(testCase, node, go) {
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
          `${backend}.headers.x-chronoframe-backend`,
          backend,
          result.backend,
        ),
      )
    }
    if (result.contentType !== 'application/json') {
      errors.push(
        difference(
          testCase.name,
          `${backend}.headers.content-type`,
          'application/json',
          result.contentType,
        ),
      )
    }
    if (result.responseRequestID !== result.requestID) {
      errors.push(
        difference(
          testCase.name,
          `${backend}.headers.x-request-id`,
          result.requestID,
          result.responseRequestID,
        ),
      )
    }
    if (result.setCookie) {
      errors.push(
        difference(
          testCase.name,
          `${backend}.headers.set-cookie`,
          'absent',
          'present',
        ),
      )
    }
    if (
      testCase.expectedStatusMessage &&
      result.body?.statusMessage !== testCase.expectedStatusMessage
    ) {
      errors.push(
        difference(
          testCase.name,
          `${backend}.body.statusMessage`,
          testCase.expectedStatusMessage,
          result.body?.statusMessage,
        ),
      )
    }
  }

  const nodeBody = comparableBody(node.body, testCase.kind)
  const goBody = comparableBody(go.body, testCase.kind)
  if (JSON.stringify(nodeBody) !== JSON.stringify(goBody)) {
    errors.push({
      name: testCase.name,
      field: 'body',
      node: nodeBody,
      go: goBody,
    })
  }
  return errors
}

async function requestOne(options, summary, request) {
  const result = await executeRequest(options, {
    ...request,
    requestID: `dual-albums-${randomUUID()}`,
  })
  const errors = []
  const expectedStatus = request.expectedStatus || 200
  if (result.status !== expectedStatus) {
    errors.push(
      difference(request.name, 'status', expectedStatus, result.status),
    )
  }
  if (result.backend !== request.expectedBackend) {
    errors.push(
      difference(
        request.name,
        'headers.x-chronoframe-backend',
        request.expectedBackend,
        result.backend,
      ),
    )
  }
  if (result.contentType !== 'application/json') {
    errors.push(
      difference(
        request.name,
        'headers.content-type',
        'application/json',
        result.contentType,
      ),
    )
  }
  if (result.responseRequestID !== result.requestID) {
    errors.push(
      difference(
        request.name,
        'headers.x-request-id',
        result.requestID,
        result.responseRequestID,
      ),
    )
  }
  if (result.setCookie) {
    errors.push(
      difference(request.name, 'headers.set-cookie', 'absent', 'present'),
    )
  }
  summary.checks.push({
    name: request.name,
    kind: request.kind || 'lifecycle',
    method: request.method,
    path: request.path,
    ok: errors.length === 0,
    result: compactResult(result),
    differences: errors,
  })
  if (errors.length > 0) throw new AlbumVerificationFailure(errors)
  return { ...result, name: request.name }
}

async function executeRequest(options, request) {
  const headers = {
    Accept: 'application/json',
    'Accept-Language': 'en',
    'X-Request-Id': request.requestID,
  }
  const cookie = resolveCookie(options, request.cookie)
  if (cookie) headers.Cookie = cookie
  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs),
  }
  if (Object.hasOwn(request, 'body')) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(request.body)
  } else if (Object.hasOwn(request, 'rawBody')) {
    headers['Content-Type'] = request.contentType || 'application/json'
    init.body = request.rawBody
  }
  const response = await options.fetchImpl(
    joinBackendURL(request.baseURL, request.path),
    init,
  )
  const text = await response.text()
  return {
    status: response.status,
    backend: response.headers.get('x-chronoframe-backend'),
    contentType: normalizedContentType(response.headers.get('content-type')),
    setCookie: response.headers.has('set-cookie'),
    requestID: request.requestID,
    responseRequestID: response.headers.get('x-request-id'),
    body: parseJSON(text),
  }
}

async function readProvider(options, summary) {
  const response = await requestOne(options, summary, {
    name: 'capture original backend provider',
    baseURL: options.nodeURL,
    expectedBackend: 'node',
    method: 'GET',
    path: PROVIDER_SETTING_PATH,
    cookie: 'admin',
  })
  return response.body?.value === 'go' ? 'go' : 'node'
}

async function setProvider(options, summary, provider) {
  if (!PROVIDERS.includes(provider))
    throw new Error(`Unknown provider: ${provider}`)
  const response = await requestOne(options, summary, {
    name: `switch provider to ${provider}`,
    kind: 'control',
    baseURL: options.nodeURL,
    expectedBackend: 'node',
    method: 'PUT',
    path: PROVIDER_SETTING_PATH,
    cookie: 'admin',
    body: { value: provider },
  })
  expectEqual(response.name, response.body?.value, provider, 'body.value')
}

async function cleanupAlbums(options, summary, state) {
  const cleanup = async (name, action) => {
    try {
      await action()
      summary.cleanup.push({ name, ok: true })
    } catch (error) {
      summary.cleanup.push({ name, ok: false, message: errorMessage(error) })
    }
  }
  await cleanup('force Node provider for cleanup', async () => {
    await controlRequest(options, 'PUT', { value: 'node' })
  })
  if (Array.isArray(state.originalMutableAlbumIds)) {
    await cleanup('restore editable photo album associations', async () => {
      await cleanupRequest(options, 'PUT', MUTABLE_PHOTO_ALBUMS_PATH, {
        albumIds: state.originalMutableAlbumIds,
      })
    })
  }
  for (const albumID of state.temporaryAlbumIds) {
    await cleanup(`delete temporary album ${albumID}`, async () => {
      const response = await cleanupRequest(
        options,
        'DELETE',
        `/api/albums/${albumID}`,
      )
      if (response.status !== 200 && response.status !== 404) {
        throw new Error(
          `DELETE /api/albums/${albumID} returned ${response.status}`,
        )
      }
    })
  }
  if (PROVIDERS.includes(state.originalProvider)) {
    await cleanup(
      `restore backend provider to ${state.originalProvider}`,
      async () => {
        await controlRequest(options, 'PUT', { value: state.originalProvider })
      },
    )
  }
}

async function controlRequest(options, method, body) {
  const response = await cleanupRequest(
    options,
    method,
    PROVIDER_SETTING_PATH,
    body,
  )
  if (!response.ok) {
    throw new Error(
      `${method} ${PROVIDER_SETTING_PATH} returned ${response.status}`,
    )
  }
  return response
}

async function cleanupRequest(options, method, path, body) {
  const headers = {
    Accept: 'application/json',
    Cookie: options.adminCookie,
    'X-Request-Id': `dual-albums-cleanup-${randomUUID()}`,
  }
  const init = {
    method,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs),
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return options.fetchImpl(joinBackendURL(options.nodeURL, path), init)
}

function comparableBody(body, kind) {
  const value = structuredClone(body)
  if (kind === 'boundary' && value && typeof value === 'object') {
    delete value.url
    delete value.stack
  }
  return canonicalize(value)
}

function resolveCookie(options, kind) {
  switch (kind) {
    case undefined:
    case 'admin':
      return options.adminCookie
    case 'member':
      return options.memberCookie
    case 'anonymous':
      return undefined
    default:
      throw new Error(`Unknown cookie kind: ${kind}`)
  }
}

function compactResult(result) {
  return {
    status: result.status,
    backend: result.backend,
    contentType: result.contentType,
  }
}

function findAlbum(body, id) {
  return Array.isArray(body)
    ? body.find((album) => album?.id === id)
    : undefined
}

function albumIDs(body) {
  if (!Array.isArray(body)) return []
  return uniquePositiveIntegers(body.map((album) => album?.id))
}

function uniquePositiveIntegers(values) {
  return [
    ...new Set(
      values.filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  ]
}

function requirePositiveInteger(name, value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AlbumVerificationFailure([
      difference(name, field, 'positive safe integer', value),
    ])
  }
  return value
}

function expectExactKeys(name, value, keys) {
  const actual =
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value).sort()
      : value
  expectEqual(name, actual, [...keys].sort(), 'body.keys')
}

function expectIncludes(name, values, expected, field) {
  if (!Array.isArray(values) || !values.includes(expected)) {
    throw new AlbumVerificationFailure([
      difference(name, field, `array including ${expected}`, values),
    ])
  }
}

function expectEqual(name, actual, expected, field) {
  if (
    JSON.stringify(canonicalize(actual)) !==
    JSON.stringify(canonicalize(expected))
  ) {
    throw new AlbumVerificationFailure([
      difference(name, field, expected, actual),
    ])
  }
}

function difference(name, field, expected, actual) {
  return { name, field, expected, actual }
}

function normalizedContentType(value) {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || ''
}

function parseJSON(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { parseError: true, raw: text.slice(0, 500) }
  }
}

function normalizeBaseURL(value) {
  const url = new URL(String(value || '').trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('base URLs must use http or https')
  }
  url.pathname = url.pathname.replace(/\/+$/g, '') || '/'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/g, '')
}

function normalizeCookie(value, label) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`${label} must not be empty`)
  return normalized
}

function normalizePrefix(value) {
  const normalized = String(value || '').trim()
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(normalized)) {
    throw new Error(
      'prefix must be 1-64 characters using letters, numbers, dot, underscore, or dash',
    )
  }
  return normalized
}

function positiveInteger(value, label) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return parsed
}

function errorMessage(error) {
  if (error instanceof AlbumVerificationFailure) {
    return JSON.stringify(error.errors)
  }
  return error instanceof Error ? error.message : String(error)
}

class AlbumVerificationFailure extends Error {
  constructor(errors) {
    super(errors.map((error) => `${error.name}: ${error.field}`).join(', '))
    this.name = 'AlbumVerificationFailure'
    this.errors = errors
  }
}

async function main() {
  const result = await verifyDualAlbums(parseAlbumsVerifierOptions())
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(errorMessage(error))
    process.exitCode = 1
  })
}

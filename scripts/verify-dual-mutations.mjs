#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { DUAL_BACKEND_COMPARE_FIXTURE } from './compare-backends.mjs'
import { FIXTURE_SESSION_TOKEN } from './seed-dual-backend-fixture.mjs'

export const DEFAULT_MUTATION_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_MUTATION_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`
export const DEFAULT_MUTATION_PREFIX = 'dual-mutation'

const PROVIDERS = ['node', 'go']
const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'
const STORAGE_PROVIDER_SETTING_PATH = '/api/system/settings/storage/provider'
const SLOGAN_SETTING_PATH = '/api/system/settings/app/slogan'
const ACCESS_CONFIG_PATH = '/api/access/config'
const FIXTURE_PHOTO_ALBUMS_PATH = `/api/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}/albums`
const PHOTO_ALBUMS_BULK_PATH = '/api/photos/albums'
const FIXTURE_MUTABLE_PHOTO_PATH = `/api/photos/${DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId}`
const FIXTURE_MUTABLE_PHOTO_SEARCH_PATH = `/api/photos?scope=manage&search=${encodeURIComponent(
  DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId,
)}&page=1&pageSize=10`
const UPLOAD_PREPARE_FILE_NAME = 'dual-mutation-upload-prepare.jpg'
const UPLOAD_PREPARE_CONTENT_HASH =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const S3_UPLOAD_PREPARE_FILE_NAME = 'dual-mutation-s3-upload-prepare.jpg'
const S3_UPLOAD_PREPARE_CONTENT_HASH =
  'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
const S3_PUBLIC_UPLOAD_PREPARE_CONTENT_HASH =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
const UPLOAD_PREPARE_EXPECTED_BODY = {
  signedUrl:
    '/api/photos/upload?key=dual-fixture%2Fusers%2F910001%2Fdual-mutation-upload-prepare.jpg',
  fileKey: 'dual-fixture/users/910001/dual-mutation-upload-prepare.jpg',
  contentHash: UPLOAD_PREPARE_CONTENT_HASH,
  expiresIn: 3600,
}
const UPLOAD_OBJECT_BODY = 'chronoframe-dual-backend-upload-object'
const ISO_MILLISECOND_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const UPLOAD_SHARE_RESPONSE_KEYS = [
  'createdAt',
  'expiresAt',
  'id',
  'isActive',
  'label',
  'lastUsedAt',
  'maxUploads',
  'token',
  'updatedAt',
  'uploadCount',
  'url',
]

export function parseMutationVerifierOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`)
    }
    if (!['--base', '--cookie', '--timeout-ms', '--prefix'].includes(arg)) {
      throw new Error(`Unknown option: ${arg}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`)
    }
    values.set(arg, value)
    index += 1
  }

  const base =
    values.get('--base') ||
    environment.CFRAME_DUAL_BASE_URL ||
    (environment.CFRAME_DUAL_PORT
      ? `http://127.0.0.1:${environment.CFRAME_DUAL_PORT}`
      : DEFAULT_MUTATION_BASE_URL)
  const cookie =
    values.get('--cookie') ||
    environment.CFRAME_DUAL_COOKIE ||
    DEFAULT_MUTATION_COOKIE
  const timeoutMs = parsePositiveInteger(
    values.get('--timeout-ms') || environment.CFRAME_DUAL_TIMEOUT_MS || 5_000,
    'timeout-ms',
  )
  const prefix = normalizePrefix(
    values.get('--prefix') ||
      environment.CFRAME_DUAL_MUTATION_PREFIX ||
      DEFAULT_MUTATION_PREFIX,
  )
  if (timeoutMs > 60_000) {
    throw new Error('timeout-ms must be 60000 or less')
  }

  return {
    base: normalizeBaseURL(base),
    cookie: normalizeCookie(cookie),
    timeoutMs,
    prefix,
  }
}

export async function verifyDualMutations({
  base = DEFAULT_MUTATION_BASE_URL,
  cookie = DEFAULT_MUTATION_COOKIE,
  timeoutMs = 5_000,
  prefix = DEFAULT_MUTATION_PREFIX,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function')
  }
  const normalized = {
    base: normalizeBaseURL(base),
    cookie: normalizeCookie(cookie),
    timeoutMs: parsePositiveInteger(timeoutMs, 'timeout-ms'),
    prefix: normalizePrefix(prefix),
  }
  const summary = {
    ok: false,
    base: normalized.base,
    prefix: normalized.prefix,
    checks: [],
    cleanup: [],
  }
  const state = {
    originalSlogan: undefined,
    originalStorageProvider: undefined,
    originalAccessConfig: undefined,
    originalAlbumIds: undefined,
    originalMutablePhoto: undefined,
    albums: new Set(),
    reactions: [],
    storageConfigs: new Set(),
    uploadShares: new Set(),
    users: new Set(),
  }
  const api = createMutationAPI({ ...normalized, summary, fetchImpl })

  try {
    await setProvider(api, 'node')
    state.originalStorageProvider = (
      await api.request({
        name: 'capture original active storage provider',
        method: 'GET',
        path: STORAGE_PROVIDER_SETTING_PATH,
        expectedBackend: 'node',
      })
    ).body.value
    state.originalSlogan = (
      await api.request({
        name: 'capture original app slogan',
        method: 'GET',
        path: SLOGAN_SETTING_PATH,
        expectedBackend: 'node',
      })
    ).body.value
    state.originalAccessConfig = (
      await api.request({
        name: 'capture original access config',
        method: 'GET',
        path: ACCESS_CONFIG_PATH,
        expectedBackend: 'node',
      })
    ).body
    state.originalAlbumIds = albumIdsFromPhotoAlbumsResponse(
      (
        await api.request({
          name: 'capture original fixture photo albums',
          method: 'GET',
          path: FIXTURE_PHOTO_ALBUMS_PATH,
          expectedBackend: 'node',
        })
      ).body,
    )
    state.originalMutablePhoto = await readMutablePhoto(
      api,
      'node',
      'capture original editable photo',
    )

    await verifyPhotoUploadPreparation(api)
    await verifyPhotoObjectUpload(api)
    await verifyPhotoDuplicateCheck(api)
    await verifySettingsMutation(api)
    await verifyAccessConfigMutation(api, state)
    await verifyAdminUserMutations(api, state)
    await verifyAlbumMutations(api, state)
    await verifyPhotoAlbumMutation(api, state)
    await verifyPhotoReactionMutations(api, state)
    await verifyPhotoMetadataMutation(api)
    await verifyStorageConfigMutations(api, state)
    await verifyS3PhotoUploadPreparation(api, state)
    await verifyUploadShareMutations(api, state)

    summary.ok = true
    return summary
  } catch (error) {
    summary.errors =
      error instanceof VerificationFailure
        ? error.errors
        : [
            {
              name: 'dual mutation verifier',
              message: error instanceof Error ? error.message : String(error),
            },
          ]
    return summary
  } finally {
    await cleanupMutationState(api, state, summary)
  }
}

export function validateHTTPResult(expectation, result) {
  const errors = []
  const expectedStatuses = expectation.expectedStatuses || [
    expectation.expectedStatus || 200,
  ]
  if (!expectedStatuses.includes(result.status)) {
    errors.push({
      name: expectation.name,
      field: 'status',
      expected:
        expectedStatuses.length === 1 ? expectedStatuses[0] : expectedStatuses,
      actual: result.status,
    })
  }
  if (
    expectation.expectedBackend &&
    result.backend !== expectation.expectedBackend
  ) {
    errors.push({
      name: expectation.name,
      field: 'headers.x-chronoframe-backend',
      expected: expectation.expectedBackend,
      actual: result.backend,
    })
  }
  if (
    expectation.expectJSON !== false &&
    result.contentType !== 'application/json'
  ) {
    errors.push({
      name: expectation.name,
      field: 'headers.content-type',
      expected: 'application/json',
      actual: result.contentType,
    })
  }
  if (
    Object.hasOwn(expectation, 'expectedValue') &&
    result.body?.value !== expectation.expectedValue
  ) {
    errors.push({
      name: expectation.name,
      field: 'body.value',
      expected: expectation.expectedValue,
      actual: result.body?.value,
    })
  }
  return errors
}

function createMutationAPI({
  base,
  cookie,
  timeoutMs,
  prefix,
  summary,
  fetchImpl,
}) {
  return {
    base,
    prefix,
    async request(expectation) {
      const requestId = `dual-mutation-${randomUUID()}`
      const headers = {
        Accept: 'application/json',
        Cookie: cookie,
        'X-Request-Id': requestId,
      }
      Object.assign(headers, expectation.headers || {})
      const options = {
        method: expectation.method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      }
      if (Object.hasOwn(expectation, 'body')) {
        headers['Content-Type'] = 'application/json'
        options.body = JSON.stringify(expectation.body)
      } else if (Object.hasOwn(expectation, 'rawBody')) {
        headers['Content-Type'] =
          expectation.contentType || 'application/octet-stream'
        options.body = expectation.rawBody
      }

      const response = await fetchImpl(
        joinMutationURL(base, expectation.path),
        options,
      )
      const text = await response.text()
      const body = parseJSONBody(text)
      const result = {
        name: expectation.name,
        method: expectation.method,
        path: expectation.path,
        expectedBackend: expectation.expectedBackend,
        status: response.status,
        backend: response.headers.get('x-chronoframe-backend'),
        contentType: normalizedContentType(
          response.headers.get('content-type'),
        ),
        requestId,
        responseRequestId: response.headers.get('x-request-id'),
        body,
      }
      summary.checks.push(result)

      const errors = validateHTTPResult(expectation, result)
      if (errors.length > 0) {
        throw new VerificationFailure(errors)
      }
      return result
    },
  }
}

async function verifyPhotoUploadPreparation(api) {
  const body = {
    fileName: UPLOAD_PREPARE_FILE_NAME,
    contentType: 'image/jpeg',
    contentHash: UPLOAD_PREPARE_CONTENT_HASH,
  }
  for (const provider of PROVIDERS) {
    await setProvider(api, provider)
    const prepare = await api.request({
      name: `photo upload prepare via ${provider}`,
      method: 'POST',
      path: '/api/photos',
      expectedBackend: provider,
      body,
    })
    expectExactKeys(
      prepare.name,
      prepare.body,
      ['signedUrl', 'fileKey', 'contentHash', 'expiresIn'],
      'body',
    )
    expectDeepEqual(
      prepare.name,
      prepare.body,
      UPLOAD_PREPARE_EXPECTED_BODY,
      'body',
    )
  }
}

async function verifyPhotoObjectUpload(api) {
  for (const provider of PROVIDERS) {
    await setProvider(api, provider)
    const upload = await api.request({
      name: `photo object upload via ${provider}`,
      method: 'PUT',
      path: `/api/photos/upload?key=${encodeURIComponent(
        UPLOAD_PREPARE_EXPECTED_BODY.fileKey,
      )}`,
      expectedBackend: provider,
      rawBody: `${UPLOAD_OBJECT_BODY}:${provider}`,
      contentType: 'image/jpeg',
    })
    expectExactKeys(upload.name, upload.body, ['ok', 'key'], 'body')
    expectEqual(upload.name, upload.body?.ok, true, 'body.ok')
    expectEqual(
      upload.name,
      upload.body?.key,
      UPLOAD_PREPARE_EXPECTED_BODY.fileKey,
      'body.key',
    )
  }
}

async function verifyPhotoDuplicateCheck(api) {
  const body = {
    fileNames: [UPLOAD_PREPARE_FILE_NAME],
    storageKeys: [UPLOAD_PREPARE_EXPECTED_BODY.fileKey],
    contentHashes: [UPLOAD_PREPARE_CONTENT_HASH.toUpperCase(), 'invalid-hash'],
  }
  let nodeBody
  for (const provider of PROVIDERS) {
    await setProvider(api, provider)
    const check = await api.request({
      name: `photo duplicate check via ${provider}`,
      method: 'POST',
      path: '/api/photos/check-duplicate',
      expectedBackend: provider,
      body,
    })
    expectEqual(check.name, check.body?.success, true, 'body.success')
    expectEqual(
      check.name,
      check.body?.duplicatesFound,
      0,
      'body.duplicatesFound',
    )
    expectDeepEqual(
      check.name,
      check.body?.results?.map((result) => result.exists),
      [false, false, false, false],
      'body.results[].exists',
    )
    if (provider === 'node') {
      nodeBody = check.body
    } else {
      expectDeepEqual(check.name, check.body, nodeBody, 'body')
    }
  }
}

async function verifySettingsMutation(api) {
  for (const writer of PROVIDERS) {
    const reader = otherProvider(writer)
    const value = `${statePrefix(api)}-slogan-written-by-${writer}`
    await setProvider(api, writer)
    await api.request({
      name: `settings mutation via ${writer}`,
      method: 'PUT',
      path: SLOGAN_SETTING_PATH,
      expectedBackend: writer,
      expectedValue: value,
      body: { value },
    })

    await setProvider(api, reader)
    await api.request({
      name: `settings cross-read via ${reader} after ${writer} write`,
      method: 'GET',
      path: SLOGAN_SETTING_PATH,
      expectedBackend: reader,
      expectedValue: value,
    })
  }
}

async function verifyAccessConfigMutation(api, state) {
  const hasPassword = Boolean(state.originalAccessConfig?.hasPassword)
  for (const writer of PROVIDERS) {
    const reader = otherProvider(writer)
    const body = {
      enabled: false,
      photoLimit: writer === 'node' ? 11 : 12,
      albumLimit: writer === 'node' ? 2 : 3,
    }

    await setProvider(api, writer)
    const update = await api.request({
      name: `access config update via ${writer}`,
      method: 'PUT',
      path: ACCESS_CONFIG_PATH,
      expectedBackend: writer,
      body,
    })
    expectAccessConfigResponse(update.name, update.body, {
      ...body,
      hasPassword,
    })

    await setProvider(api, reader)
    const readBack = await api.request({
      name: `access config cross-read via ${reader} after ${writer} write`,
      method: 'GET',
      path: ACCESS_CONFIG_PATH,
      expectedBackend: reader,
    })
    expectAccessConfigResponse(readBack.name, readBack.body, {
      ...body,
      hasPassword,
    })
  }
}

async function verifyAdminUserMutations(api, state) {
  for (const creator of PROVIDERS) {
    const updater = otherProvider(creator)
    const suffix = `${creator}-${randomUUID().slice(0, 8)}`
    const username = `${statePrefix(api)}_${creator}`.slice(0, 64)
    const email = `${statePrefix(api)}-${suffix}@example.test`.toLowerCase()
    const updatedUsername =
      `${statePrefix(api)}_${creator}_updated_by_${updater}`.slice(0, 64)
    const updatedEmail =
      `${statePrefix(api)}-${suffix}-updated@example.test`.toLowerCase()

    await setProvider(api, creator)
    const create = await api.request({
      name: `admin user create via ${creator}`,
      method: 'POST',
      path: '/api/admin/users',
      expectedBackend: creator,
      body: { username, email, password: 'DualUser123!', isAdmin: false },
    })
    const id = requirePositiveInteger(create.body.id, create.name, 'body.id')
    state.users.add(id)
    expectExactKeys(
      create.name,
      create.body,
      ['email', 'id', 'isActive', 'isAdmin', 'username'],
      'body',
    )
    expectEqual(create.name, create.body.username, username, 'body.username')
    expectEqual(create.name, create.body.email, email, 'body.email')
    expectEqual(create.name, create.body.isAdmin, 0, 'body.isAdmin')
    expectEqual(create.name, create.body.isActive, true, 'body.isActive')

    await setProvider(api, updater)
    const listAfterCreate = await api.request({
      name: `admin user cross-read via ${updater} after ${creator} create`,
      method: 'GET',
      path: '/api/admin/users',
      expectedBackend: updater,
    })
    const createdUser = findById(listAfterCreate.body, id)
    expectEqual(
      listAfterCreate.name,
      createdUser?.username,
      username,
      'body[].username',
    )
    expectEqual(listAfterCreate.name, createdUser?.email, email, 'body[].email')
    expectEqual(
      listAfterCreate.name,
      createdUser?.photoCount,
      0,
      'body[].photoCount',
    )
    expectEqual(
      listAfterCreate.name,
      createdUser?.albumCount,
      0,
      'body[].albumCount',
    )

    const update = await api.request({
      name: `admin user update via ${updater}`,
      method: 'PATCH',
      path: `/api/admin/users/${id}`,
      expectedBackend: updater,
      body: {
        username: updatedUsername,
        email: updatedEmail,
        isAdmin: false,
        isActive: true,
      },
    })
    expectExactKeys(
      update.name,
      update.body,
      ['email', 'id', 'isActive', 'isAdmin', 'username'],
      'body',
    )
    expectEqual(
      update.name,
      update.body.username,
      updatedUsername,
      'body.username',
    )
    expectEqual(update.name, update.body.email, updatedEmail, 'body.email')
    expectEqual(update.name, update.body.isAdmin, 0, 'body.isAdmin')
    expectEqual(update.name, update.body.isActive, true, 'body.isActive')

    await setProvider(api, creator)
    const listAfterUpdate = await api.request({
      name: `admin user cross-read via ${creator} after ${updater} update`,
      method: 'GET',
      path: '/api/admin/users',
      expectedBackend: creator,
    })
    const updatedUser = findById(listAfterUpdate.body, id)
    expectEqual(
      listAfterUpdate.name,
      updatedUser?.username,
      updatedUsername,
      'body[].username',
    )
    expectEqual(
      listAfterUpdate.name,
      updatedUser?.email,
      updatedEmail,
      'body[].email',
    )

    await api.request({
      name: `admin user delete via ${creator}`,
      method: 'DELETE',
      path: `/api/admin/users/${id}`,
      expectedBackend: creator,
    })
    state.users.delete(id)
  }
}

async function verifyAlbumMutations(api, state) {
  for (const creator of PROVIDERS) {
    const updater = otherProvider(creator)
    const title = `  ${statePrefix(api)} album created by ${creator}  `
    const description = `  temporary parity album created by ${creator}  `
    const updatedTitle = `  ${statePrefix(api)} album updated by ${updater}  `
    const updatedDescription = `  temporary parity album updated by ${updater}  `

    await setProvider(api, creator)
    const create = await api.request({
      name: `album create via ${creator}`,
      method: 'POST',
      path: '/api/albums',
      expectedBackend: creator,
      body: {
        title,
        description,
        isHidden: true,
        // Node always adds a truthy coverPhotoId to the relation set. Keeping
        // photoIds empty makes the verifier detect a Go implementation that
        // stores the cover field but forgets the album-photo relationship.
        photoIds: [],
        coverPhotoId: DUAL_BACKEND_COMPARE_FIXTURE.photoId,
      },
    })
    const albumId = requirePositiveInteger(
      create.body.id,
      create.name,
      'body.id',
    )
    state.albums.add(albumId)
    expectEqual(create.name, create.body.title, title, 'body.title')

    await setProvider(api, updater)
    const readAfterCreate = await api.request({
      name: `album cross-read via ${updater} after ${creator} create`,
      method: 'GET',
      path: `/api/albums/${albumId}`,
      expectedBackend: updater,
    })
    expectEqual(
      readAfterCreate.name,
      readAfterCreate.body.title,
      title,
      'body.title',
    )
    expectEqual(
      readAfterCreate.name,
      readAfterCreate.body.description,
      description,
      'body.description',
    )
    expectEqual(
      readAfterCreate.name,
      readAfterCreate.body.coverPhotoId,
      DUAL_BACKEND_COMPARE_FIXTURE.photoId,
      'body.coverPhotoId',
    )
    expectEqual(
      readAfterCreate.name,
      readAfterCreate.body.totalPhotoCount,
      1,
      'body.totalPhotoCount',
    )

    await api.request({
      name: `album update via ${updater}`,
      method: 'PUT',
      path: `/api/albums/${albumId}`,
      expectedBackend: updater,
      body: {
        title: updatedTitle,
        description: updatedDescription,
        isHidden: true,
      },
    })

    await setProvider(api, creator)
    const readAfterUpdate = await api.request({
      name: `album cross-read via ${creator} after ${updater} update`,
      method: 'GET',
      path: `/api/albums/${albumId}`,
      expectedBackend: creator,
    })
    expectEqual(
      readAfterUpdate.name,
      readAfterUpdate.body.title,
      updatedTitle,
      'body.title',
    )
    expectEqual(
      readAfterUpdate.name,
      readAfterUpdate.body.description,
      updatedDescription,
      'body.description',
    )
    expectEqual(
      readAfterUpdate.name,
      readAfterUpdate.body.totalPhotoCount,
      1,
      'body.totalPhotoCount',
    )

    await api.request({
      name: `album delete via ${creator}`,
      method: 'DELETE',
      path: `/api/albums/${albumId}`,
      expectedBackend: creator,
    })
    state.albums.delete(albumId)
  }
}

async function verifyPhotoAlbumMutation(api, state) {
  const create = await createTemporaryAlbum(
    api,
    state,
    'node',
    'photo relation',
  )
  const albumId = create.id
  const originalAlbumIds = state.originalAlbumIds || []
  const withTemporaryAlbum = uniqueIntegers([...originalAlbumIds, albumId])

  await setProvider(api, 'node')
  await api.request({
    name: 'photo album relation update via node',
    method: 'PUT',
    path: FIXTURE_PHOTO_ALBUMS_PATH,
    expectedBackend: 'node',
    body: { albumIds: withTemporaryAlbum },
  })

  await setProvider(api, 'go')
  const goRead = await api.request({
    name: 'photo album relation cross-read via go after node write',
    method: 'GET',
    path: FIXTURE_PHOTO_ALBUMS_PATH,
    expectedBackend: 'go',
  })
  expectIncludes(
    goRead.name,
    albumIdsFromPhotoAlbumsResponse(goRead.body),
    albumId,
    'body[].id',
  )

  await api.request({
    name: 'photo album relation restore via go',
    method: 'PUT',
    path: FIXTURE_PHOTO_ALBUMS_PATH,
    expectedBackend: 'go',
    body: { albumIds: originalAlbumIds },
  })

  await setProvider(api, 'node')
  const nodeRead = await api.request({
    name: 'photo album relation cross-read via node after go restore',
    method: 'GET',
    path: FIXTURE_PHOTO_ALBUMS_PATH,
    expectedBackend: 'node',
  })
  expectEqual(
    nodeRead.name,
    albumIdsFromPhotoAlbumsResponse(nodeRead.body).includes(albumId),
    false,
    'body[].id includes temporary album',
  )

  const bulkAdd = await api.request({
    name: 'photo album bulk add via node',
    method: 'PUT',
    path: PHOTO_ALBUMS_BULK_PATH,
    expectedBackend: 'node',
    body: {
      photoIds: [DUAL_BACKEND_COMPARE_FIXTURE.photoId],
      albumIds: [albumId],
      mode: 'add',
    },
  })
  expectPhotoAlbumBulkMutationResponse(bulkAdd.name, bulkAdd.body, 'add', 1)

  await setProvider(api, 'go')
  const goReadAfterBulkAdd = await api.request({
    name: 'photo album bulk cross-read via go after node add',
    method: 'GET',
    path: FIXTURE_PHOTO_ALBUMS_PATH,
    expectedBackend: 'go',
  })
  expectIncludes(
    goReadAfterBulkAdd.name,
    albumIdsFromPhotoAlbumsResponse(goReadAfterBulkAdd.body),
    albumId,
    'body[].id',
  )

  const bulkRemove = await api.request({
    name: 'photo album bulk remove via go',
    method: 'PUT',
    path: PHOTO_ALBUMS_BULK_PATH,
    expectedBackend: 'go',
    body: {
      photoIds: [DUAL_BACKEND_COMPARE_FIXTURE.photoId],
      albumIds: [albumId],
      mode: 'remove',
    },
  })
  expectPhotoAlbumBulkMutationResponse(
    bulkRemove.name,
    bulkRemove.body,
    'remove',
    1,
  )

  await setProvider(api, 'node')
  const nodeReadAfterBulkRemove = await api.request({
    name: 'photo album bulk cross-read via node after go remove',
    method: 'GET',
    path: FIXTURE_PHOTO_ALBUMS_PATH,
    expectedBackend: 'node',
  })
  expectEqual(
    nodeReadAfterBulkRemove.name,
    albumIdsFromPhotoAlbumsResponse(nodeReadAfterBulkRemove.body).includes(
      albumId,
    ),
    false,
    'body[].id includes temporary album',
  )
}

async function verifyPhotoReactionMutations(api, state) {
  const path = `/api/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}/reactions`
  for (const creator of PROVIDERS) {
    const updater = otherProvider(creator)
    const headers = reactionFingerprintHeaders(api, creator)
    state.reactions.push({ path, headers })

    await setProvider(api, creator)
    const create = await api.request({
      name: `photo reaction create via ${creator}`,
      method: 'POST',
      path,
      expectedBackend: creator,
      headers,
      body: { reactionType: 'fire' },
    })
    expectPhotoReactionMutationResponse(
      create.name,
      create.body,
      'created',
      'fire',
    )

    await setProvider(api, updater)
    const readAfterCreate = await api.request({
      name: `photo reaction cross-read via ${updater} after ${creator} create`,
      method: 'GET',
      path,
      expectedBackend: updater,
      headers,
    })
    expectEqual(
      readAfterCreate.name,
      readAfterCreate.body?.userReaction,
      'fire',
      'body.userReaction',
    )

    const update = await api.request({
      name: `photo reaction update via ${updater}`,
      method: 'POST',
      path,
      expectedBackend: updater,
      headers,
      body: { reactionType: 'love' },
    })
    expectPhotoReactionMutationResponse(
      update.name,
      update.body,
      'updated',
      'love',
    )

    await setProvider(api, creator)
    const readAfterUpdate = await api.request({
      name: `photo reaction cross-read via ${creator} after ${updater} update`,
      method: 'GET',
      path,
      expectedBackend: creator,
      headers,
    })
    expectEqual(
      readAfterUpdate.name,
      readAfterUpdate.body?.userReaction,
      'love',
      'body.userReaction',
    )

    const remove = await api.request({
      name: `photo reaction delete via ${creator}`,
      method: 'DELETE',
      path,
      expectedBackend: creator,
      headers,
    })
    expectExactKeys(remove.name, remove.body, ['action', 'success'], 'body')
    expectEqual(remove.name, remove.body.success, true, 'body.success')
    expectEqual(remove.name, remove.body.action, 'deleted', 'body.action')
    state.reactions = state.reactions.filter(
      (reaction) => reaction.headers !== headers,
    )

    await setProvider(api, updater)
    const readAfterDelete = await api.request({
      name: `photo reaction cross-read via ${updater} after ${creator} delete`,
      method: 'GET',
      path,
      expectedBackend: updater,
      headers,
    })
    expectEqual(
      readAfterDelete.name,
      readAfterDelete.body?.userReaction,
      null,
      'body.userReaction',
    )
  }
}

async function verifyPhotoMetadataMutation(api) {
  for (const writer of PROVIDERS) {
    const reader = otherProvider(writer)
    const title = `${statePrefix(api)} photo metadata written by ${writer}`
    const description = `${statePrefix(api)} description written by ${writer}`
    const tags = [statePrefix(api), 'photo-metadata', writer]
    const inputTags = [
      `  ${tags[0]}  `,
      tags[0].toUpperCase(),
      '   ',
      ` ${tags[1]} `,
      ` ${tags[2]} `,
    ]
    const rating = writer === 'node' ? 2 : 3

    await setProvider(api, writer)
    const update = await api.request({
      name: `photo metadata update via ${writer}`,
      method: 'PUT',
      path: FIXTURE_MUTABLE_PHOTO_PATH,
      expectedBackend: writer,
      body: {
        title: `  ${title}  `,
        description: `  ${description}  `,
        tags: inputTags,
        rating,
        unknown: 'stripped',
      },
    })
    expectEqual(update.name, update.body?.success, true, 'body.success')
    expectEqual(
      update.name,
      update.body?.photo?.title,
      title,
      'body.photo.title',
    )
    expectEqual(
      update.name,
      update.body?.photo?.description,
      description,
      'body.photo.description',
    )
    expectDeepEqual(
      update.name,
      update.body?.photo?.tags,
      tags,
      'body.photo.tags',
    )
    expectEqual(
      update.name,
      update.body?.photo?.exif?.Rating,
      rating,
      'body.photo.exif.Rating',
    )

    await setProvider(api, reader)
    const readBack = await readMutablePhoto(
      api,
      reader,
      `photo metadata cross-read via ${reader} after ${writer} write`,
    )
    expectEqual(
      readBack.name,
      readBack.photo.title,
      title,
      'body.items[].title',
    )
    expectEqual(
      readBack.name,
      readBack.photo.description,
      description,
      'body.items[].description',
    )
    expectDeepEqual(
      readBack.name,
      readBack.photo.tags,
      tags,
      'body.items[].tags',
    )
    expectEqual(
      readBack.name,
      readBack.photo.exif?.Rating,
      rating,
      'body.items[].exif.Rating',
    )
  }
}

async function verifyStorageConfigMutations(api, state) {
  for (const storageCase of storageConfigMutationCases(statePrefix(api))) {
    const checkPrefix =
      storageCase.provider === 'local'
        ? 'storage config'
        : `storage config ${storageCase.provider}`

    for (const creator of PROVIDERS) {
      const updater = otherProvider(creator)
      const name = `${statePrefix(api)} ${storageCase.provider} storage created by ${creator}`
      const updatedName = `${statePrefix(api)} ${storageCase.provider} storage updated by ${updater}`
      const config = storageCase.createConfig(creator)
      const expectedConfig = storageCase.expectedCreateConfig(creator)
      const updatedConfig = storageCase.updateConfig(creator, updater)
      const expectedUpdatedConfig = storageCase.expectedUpdateConfig(
        creator,
        updater,
      )

      await setProvider(api, creator)
      const create = await api.request({
        name: `${checkPrefix} create via ${creator}`,
        method: 'POST',
        path: '/api/system/settings/storage-config',
        expectedBackend: creator,
        body: { name, provider: storageCase.provider, config },
      })
      const id = requirePositiveInteger(create.body.id, create.name, 'body.id')
      state.storageConfigs.add(id)

      await setProvider(api, updater)
      const readAfterCreate = await api.request({
        name: `${checkPrefix} cross-read via ${updater} after ${creator} create`,
        method: 'GET',
        path: `/api/system/settings/storage-config/${id}`,
        expectedBackend: updater,
      })
      expectEqual(
        readAfterCreate.name,
        readAfterCreate.body.name,
        name,
        'body.name',
      )
      expectEqual(
        readAfterCreate.name,
        readAfterCreate.body.provider,
        storageCase.provider,
        'body.provider',
      )
      expectDeepEqual(
        readAfterCreate.name,
        readAfterCreate.body.config,
        expectedConfig,
        'body.config',
      )

      await api.request({
        name: `${checkPrefix} update via ${updater}`,
        method: 'PUT',
        path: `/api/system/settings/storage-config/${id}`,
        expectedBackend: updater,
        body: {
          name: updatedName,
          provider: storageCase.provider,
          config: updatedConfig,
        },
      })

      await setProvider(api, creator)
      const readAfterUpdate = await api.request({
        name: `${checkPrefix} cross-read via ${creator} after ${updater} update`,
        method: 'GET',
        path: `/api/system/settings/storage-config/${id}`,
        expectedBackend: creator,
      })
      expectEqual(
        readAfterUpdate.name,
        readAfterUpdate.body.name,
        updatedName,
        'body.name',
      )
      expectEqual(
        readAfterUpdate.name,
        readAfterUpdate.body.provider,
        storageCase.provider,
        'body.provider',
      )
      expectDeepEqual(
        readAfterUpdate.name,
        readAfterUpdate.body.config,
        expectedUpdatedConfig,
        'body.config',
      )

      await api.request({
        name: `${checkPrefix} delete via ${creator}`,
        method: 'DELETE',
        path: `/api/system/settings/storage-config/${id}`,
        expectedBackend: creator,
      })
      state.storageConfigs.delete(id)
    }
  }
}

async function verifyS3PhotoUploadPreparation(api, state) {
  const body = {
    fileName: S3_UPLOAD_PREPARE_FILE_NAME,
    contentType: 'image/jpeg',
    contentHash: S3_UPLOAD_PREPARE_CONTENT_HASH,
    skipDuplicateCheck: true,
  }

  for (const creator of PROVIDERS) {
    const config = s3UploadPrepareStorageConfig(statePrefix(api), creator)
    const name = `${statePrefix(api)} active s3 storage created by ${creator}`

    await setProvider(api, creator)
    const create = await api.request({
      name: `s3 active storage config create via ${creator}`,
      method: 'POST',
      path: '/api/system/settings/storage-config',
      expectedBackend: creator,
      body: { name, provider: 's3', config },
    })
    const id = requirePositiveInteger(create.body.id, create.name, 'body.id')
    state.storageConfigs.add(id)

    await setActiveStorageProvider(api, creator, id)

    const expectedFileKey = `${config.prefix}/users/910001/${S3_UPLOAD_PREPARE_FILE_NAME}`
    for (const provider of PROVIDERS) {
      await setProvider(api, provider)
      const prepare = await api.request({
        name: `s3 photo upload prepare via ${provider} after ${creator} storage switch`,
        method: 'POST',
        path: '/api/photos',
        expectedBackend: provider,
        body,
      })
      expectExactKeys(
        prepare.name,
        prepare.body,
        ['signedUrl', 'fileKey', 'contentHash', 'expiresIn'],
        'body',
      )
      expectEqual(
        prepare.name,
        prepare.body.fileKey,
        expectedFileKey,
        'body.fileKey',
      )
      expectEqual(
        prepare.name,
        prepare.body.contentHash,
        S3_UPLOAD_PREPARE_CONTENT_HASH,
        'body.contentHash',
      )
      expectEqual(prepare.name, prepare.body.expiresIn, 3600, 'body.expiresIn')
      expectS3UploadPrepareURL(prepare.name, prepare.body.signedUrl, {
        endpoint: config.endpoint,
        bucket: config.bucket,
        key: expectedFileKey,
        accessKeyId: config.accessKeyId,
        region: config.region,
      })
    }

    await setProvider(api, creator)
    const shareCreate = await api.request({
      name: `s3 public upload share create via ${creator}`,
      method: 'POST',
      path: '/api/upload-shares',
      expectedBackend: creator,
      body: {
        label: `${statePrefix(api)} public s3 ${creator}`,
        maxUploads: null,
      },
    })
    const shareId = requirePositiveInteger(
      shareCreate.body.id,
      shareCreate.name,
      'body.id',
    )
    state.uploadShares.add(shareId)
    expectUploadShareResponse(api, shareCreate.name, shareCreate.body)
    const token = shareCreate.body.token
    const publicFileName = `${statePrefix(api)}-public-s3-${creator}.jpg`
    const expectedKeyPrefix = `${config.prefix}/users/910001/guest-uploads/${shareId}/`

    for (const provider of PROVIDERS) {
      await setProvider(api, provider)
      const prepare = await api.request({
        name: `s3 public upload prepare via ${provider} after ${creator} storage switch`,
        method: 'POST',
        path: `/api/upload-shares/public/${encodeURIComponent(token)}/prepare`,
        expectedBackend: provider,
        body: {
          fileName: publicFileName,
          contentType: 'image/jpeg',
          contentHash: S3_PUBLIC_UPLOAD_PREPARE_CONTENT_HASH,
        },
      })
      expectExactKeys(
        prepare.name,
        prepare.body,
        ['signedUrl', 'fileKey', 'contentHash', 'expiresIn'],
        'body',
      )
      expectStringStartsWith(
        prepare.name,
        prepare.body.fileKey,
        expectedKeyPrefix,
        'body.fileKey',
      )
      expectStringEndsWith(
        prepare.name,
        prepare.body.fileKey,
        '.jpg',
        'body.fileKey',
      )
      expectEqual(
        prepare.name,
        prepare.body.contentHash,
        S3_PUBLIC_UPLOAD_PREPARE_CONTENT_HASH,
        'body.contentHash',
      )
      expectEqual(prepare.name, prepare.body.expiresIn, 3600, 'body.expiresIn')
      expectS3UploadPrepareURL(prepare.name, prepare.body.signedUrl, {
        endpoint: config.endpoint,
        bucket: config.bucket,
        key: prepare.body.fileKey,
        accessKeyId: config.accessKeyId,
        region: config.region,
      })
    }

    await setProvider(api, creator)
    await api.request({
      name: `s3 public upload share delete via ${creator}`,
      method: 'DELETE',
      path: `/api/upload-shares/${shareId}`,
      expectedBackend: creator,
    })
    state.uploadShares.delete(shareId)

    await setActiveStorageProvider(
      api,
      'node',
      state.originalStorageProvider ?? null,
    )
    await setProvider(api, creator)
    await api.request({
      name: `s3 active storage config delete via ${creator}`,
      method: 'DELETE',
      path: `/api/system/settings/storage-config/${id}`,
      expectedBackend: creator,
    })
    state.storageConfigs.delete(id)
  }
}

async function verifyUploadShareMutations(api, state) {
  for (const creator of PROVIDERS) {
    const updater = otherProvider(creator)
    const label = `${statePrefix(api)} share created by ${creator}`
    const updatedLabel = `${statePrefix(api)} share updated by ${updater}`

    await setProvider(api, creator)
    const create = await api.request({
      name: `upload share create via ${creator}`,
      method: 'POST',
      path: '/api/upload-shares',
      expectedBackend: creator,
      body: { label: `  ${label}  `, maxUploads: null, unknown: 'stripped' },
    })
    const id = requirePositiveInteger(create.body.id, create.name, 'body.id')
    state.uploadShares.add(id)
    expectUploadShareResponse(api, create.name, create.body)
    expectEqual(create.name, create.body.label, label, 'body.label')
    expectEqual(create.name, create.body.isActive, true, 'body.isActive')
    expectEqual(create.name, create.body.uploadCount, 0, 'body.uploadCount')
    expectEqual(create.name, create.body.maxUploads, null, 'body.maxUploads')
    expectEqual(create.name, create.body.lastUsedAt, null, 'body.lastUsedAt')

    await setProvider(api, updater)
    const listAfterCreate = await api.request({
      name: `upload share cross-read via ${updater} after ${creator} create`,
      method: 'GET',
      path: '/api/upload-shares',
      expectedBackend: updater,
    })
    const listCreatedShare = findById(listAfterCreate.body, id)
    expectUploadShareResponse(api, listAfterCreate.name, listCreatedShare)
    expectEqual(
      listAfterCreate.name,
      listCreatedShare?.label,
      label,
      'body[].label',
    )

    const update = await api.request({
      name: `upload share update via ${updater}`,
      method: 'PATCH',
      path: `/api/upload-shares/${id}`,
      expectedBackend: updater,
      body: {
        label: `  ${updatedLabel}  `,
        isActive: true,
        maxUploads: 3,
        unknown: 'stripped',
      },
    })
    expectUploadShareResponse(api, update.name, update.body)
    expectEqual(update.name, update.body.label, updatedLabel, 'body.label')
    expectEqual(update.name, update.body.isActive, true, 'body.isActive')
    expectEqual(update.name, update.body.uploadCount, 0, 'body.uploadCount')
    expectEqual(update.name, update.body.maxUploads, 3, 'body.maxUploads')
    expectEqual(update.name, update.body.lastUsedAt, null, 'body.lastUsedAt')

    await setProvider(api, creator)
    const listAfterUpdate = await api.request({
      name: `upload share cross-read via ${creator} after ${updater} update`,
      method: 'GET',
      path: '/api/upload-shares',
      expectedBackend: creator,
    })
    const listUpdatedShare = findById(listAfterUpdate.body, id)
    expectUploadShareResponse(api, listAfterUpdate.name, listUpdatedShare)
    expectEqual(
      listAfterUpdate.name,
      listUpdatedShare?.label,
      updatedLabel,
      'body[].label',
    )

    await setProvider(api, updater)
    const nullableUpdate = await api.request({
      name: `upload share nullable update via ${updater}`,
      method: 'PATCH',
      path: `/api/upload-shares/${id}`,
      expectedBackend: updater,
      body: { label: null, maxUploads: null },
    })
    expectUploadShareResponse(api, nullableUpdate.name, nullableUpdate.body)
    expectEqual(
      nullableUpdate.name,
      nullableUpdate.body.label,
      null,
      'body.label',
    )
    expectEqual(
      nullableUpdate.name,
      nullableUpdate.body.maxUploads,
      null,
      'body.maxUploads',
    )

    await setProvider(api, creator)
    const emptyUpdate = await api.request({
      name: `upload share empty update via ${creator}`,
      method: 'PATCH',
      path: `/api/upload-shares/${id}`,
      expectedBackend: creator,
      body: {},
    })
    expectUploadShareResponse(api, emptyUpdate.name, emptyUpdate.body)
    expectEqual(emptyUpdate.name, emptyUpdate.body.label, null, 'body.label')
    expectEqual(
      emptyUpdate.name,
      emptyUpdate.body.maxUploads,
      null,
      'body.maxUploads',
    )

    await api.request({
      name: `upload share delete via ${creator}`,
      method: 'DELETE',
      path: `/api/upload-shares/${id}`,
      expectedBackend: creator,
    })
    state.uploadShares.delete(id)
  }
}

async function readMutablePhoto(api, provider, name) {
  const result = await api.request({
    name,
    method: 'GET',
    path: FIXTURE_MUTABLE_PHOTO_SEARCH_PATH,
    expectedBackend: provider,
  })
  const items = Array.isArray(result.body) ? result.body : result.body?.items
  const photo = findById(items, DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId)
  if (!photo) {
    throw new VerificationFailure([
      {
        name,
        field: 'body.items[].id',
        expected: DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId,
        actual: Array.isArray(items) ? items.map((item) => item?.id) : items,
      },
    ])
  }
  return { name, photo }
}

async function createTemporaryAlbum(api, state, provider, purpose) {
  const title = `${statePrefix(api)} ${purpose} album`
  await setProvider(api, provider)
  const result = await api.request({
    name: `${purpose} temporary album create via ${provider}`,
    method: 'POST',
    path: '/api/albums',
    expectedBackend: provider,
    body: {
      title,
      description: `temporary album for ${purpose}`,
      isHidden: true,
    },
  })
  const id = requirePositiveInteger(result.body.id, result.name, 'body.id')
  state.albums.add(id)
  return { id, title }
}

async function setProvider(api, provider) {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unknown provider ${provider}`)
  }
  await api.request({
    name: `switch provider to ${provider}`,
    method: 'PUT',
    path: PROVIDER_SETTING_PATH,
    expectedBackend: 'node',
    expectedValue: provider,
    body: { value: provider },
  })
}

async function setActiveStorageProvider(api, provider, storageProviderId) {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unknown provider ${provider}`)
  }
  await setProvider(api, provider)
  await api.request({
    name: `switch active storage provider to ${String(storageProviderId)} via ${provider}`,
    method: 'PUT',
    path: STORAGE_PROVIDER_SETTING_PATH,
    expectedBackend: provider,
    expectedValue: storageProviderId,
    body: { value: storageProviderId },
  })
}

async function cleanupMutationState(api, state, summary) {
  const cleanup = async (name, action) => {
    try {
      await action()
      summary.cleanup.push({ name, ok: true })
    } catch (error) {
      summary.cleanup.push({
        name,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
      summary.ok = false
    }
  }

  await cleanup('restore provider to node', () => setProvider(api, 'node'))
  if (state.originalStorageProvider !== undefined) {
    await cleanup('restore active storage provider', () =>
      api.request({
        name: 'cleanup: restore active storage provider',
        method: 'PUT',
        path: STORAGE_PROVIDER_SETTING_PATH,
        expectedBackend: 'node',
        expectedValue: state.originalStorageProvider,
        body: { value: state.originalStorageProvider },
      }),
    )
  }
  if (state.originalSlogan !== undefined) {
    await cleanup('restore app slogan', () =>
      api.request({
        name: 'cleanup: restore app slogan',
        method: 'PUT',
        path: SLOGAN_SETTING_PATH,
        expectedBackend: 'node',
        expectedValue: state.originalSlogan,
        body: { value: state.originalSlogan },
      }),
    )
  }
  if (state.originalAccessConfig !== undefined) {
    await cleanup('restore access config', () => {
      const enabled = Boolean(state.originalAccessConfig.enabled)
      if (enabled && !state.originalAccessConfig.hasPassword) {
        throw new Error(
          'cannot restore an enabled access config without an existing password hash through /api/access/config',
        )
      }
      return api.request({
        name: 'cleanup: restore access config',
        method: 'PUT',
        path: ACCESS_CONFIG_PATH,
        expectedBackend: 'node',
        body: {
          enabled,
          photoLimit: requirePositiveInteger(
            state.originalAccessConfig.photoLimit,
            'cleanup: restore access config',
            'body.photoLimit',
          ),
          albumLimit: requirePositiveInteger(
            state.originalAccessConfig.albumLimit,
            'cleanup: restore access config',
            'body.albumLimit',
          ),
        },
      })
    })
  }
  if (state.originalAlbumIds !== undefined) {
    await cleanup('restore fixture photo albums', () =>
      api.request({
        name: 'cleanup: restore fixture photo albums',
        method: 'PUT',
        path: FIXTURE_PHOTO_ALBUMS_PATH,
        expectedBackend: 'node',
        body: { albumIds: state.originalAlbumIds },
      }),
    )
  }
  if (state.originalMutablePhoto !== undefined) {
    await cleanup('restore editable photo metadata', () =>
      api.request({
        name: 'cleanup: restore editable photo metadata',
        method: 'PUT',
        path: FIXTURE_MUTABLE_PHOTO_PATH,
        expectedBackend: 'node',
        body: {
          title: state.originalMutablePhoto.photo.title || '',
          description: state.originalMutablePhoto.photo.description || '',
          tags: Array.isArray(state.originalMutablePhoto.photo.tags)
            ? state.originalMutablePhoto.photo.tags
            : [],
          rating: Number.isSafeInteger(
            state.originalMutablePhoto.photo.exif?.Rating,
          )
            ? state.originalMutablePhoto.photo.exif.Rating
            : null,
        },
      }),
    )
  }
  for (const reaction of [...state.reactions].reverse()) {
    await cleanup(`delete temporary reaction ${reaction.path}`, () =>
      api.request({
        name: `cleanup: delete temporary reaction ${reaction.path}`,
        method: 'DELETE',
        path: reaction.path,
        headers: reaction.headers,
        expectedBackend: 'node',
        expectedStatuses: [200, 404],
      }),
    )
  }
  for (const id of [...state.uploadShares].reverse()) {
    await cleanup(`delete temporary upload share ${id}`, () =>
      api.request({
        name: `cleanup: delete temporary upload share ${id}`,
        method: 'DELETE',
        path: `/api/upload-shares/${id}`,
        expectedBackend: 'node',
        expectedStatuses: [200, 404],
      }),
    )
  }
  for (const id of [...state.storageConfigs].reverse()) {
    await cleanup(`delete temporary storage config ${id}`, () =>
      api.request({
        name: `cleanup: delete temporary storage config ${id}`,
        method: 'DELETE',
        path: `/api/system/settings/storage-config/${id}`,
        expectedBackend: 'node',
        expectedStatuses: [200, 404],
      }),
    )
  }
  for (const id of [...state.users].reverse()) {
    await cleanup(`delete temporary user ${id}`, () =>
      api.request({
        name: `cleanup: delete temporary user ${id}`,
        method: 'DELETE',
        path: `/api/admin/users/${id}`,
        expectedBackend: 'node',
        expectedStatuses: [200, 404],
      }),
    )
  }
  for (const id of [...state.albums].reverse()) {
    await cleanup(`delete temporary album ${id}`, () =>
      api.request({
        name: `cleanup: delete temporary album ${id}`,
        method: 'DELETE',
        path: `/api/albums/${id}`,
        expectedBackend: 'node',
        expectedStatuses: [200, 404],
      }),
    )
  }
}

function localStorageConfig(prefix, suffix) {
  return {
    provider: 'local',
    basePath: '/app/data/storage',
    baseUrl: '/storage',
    prefix: `${prefix}/${suffix}`,
  }
}

function s3UploadPrepareStorageConfig(prefix, suffix) {
  return {
    provider: 's3',
    bucket: `${prefix}-${suffix}-upload-bucket`,
    region: 'auto',
    endpoint: `https://${suffix}.s3.example.test`,
    prefix: `${prefix}/s3-${suffix}`,
    accessKeyId: `access-${suffix}`,
    secretAccessKey: `secret-${suffix}`,
    forcePathStyle: true,
  }
}

function storageConfigMutationCases(prefix) {
  return [
    {
      provider: 'local',
      createConfig: (creator) => ({
        ...localStorageConfig(prefix, `${creator}`),
        ignoredBySchema: true,
      }),
      expectedCreateConfig: (creator) =>
        localStorageConfig(prefix, `${creator}`),
      updateConfig: (creator, updater) => ({
        ...localStorageConfig(prefix, `${creator}-updated-by-${updater}`),
        ignoredBySchema: true,
      }),
      expectedUpdateConfig: (creator, updater) =>
        localStorageConfig(prefix, `${creator}-updated-by-${updater}`),
    },
    {
      provider: 's3',
      createConfig: (creator) => ({
        provider: 's3',
        bucket: `${prefix}-${creator}-bucket`,
        endpoint: `https://${creator}.s3.example.test`,
        accessKeyId: `access-${creator}`,
        secretAccessKey: `secret-${creator}`,
        ignoredBySchema: true,
      }),
      expectedCreateConfig: (creator) => ({
        provider: 's3',
        bucket: `${prefix}-${creator}-bucket`,
        region: 'auto',
        endpoint: `https://${creator}.s3.example.test`,
        prefix: '/photos',
        accessKeyId: `access-${creator}`,
        secretAccessKey: `secret-${creator}`,
      }),
      updateConfig: (creator, updater) => ({
        bucket: `${prefix}-${creator}-updated-by-${updater}-bucket`,
        ignoredBySchema: true,
      }),
      expectedUpdateConfig: (creator, updater) => ({
        bucket: `${prefix}-${creator}-updated-by-${updater}-bucket`,
        region: 'auto',
        prefix: '/photos',
      }),
    },
    {
      provider: 'openlist',
      createConfig: (creator) => ({
        provider: 'openlist',
        baseUrl: `https://${creator}.files.example.test`,
        rootPath: `/chronoframe/${prefix}/${creator}`,
        token: `token-${creator}`,
        ignoredBySchema: true,
      }),
      expectedCreateConfig: (creator) => ({
        provider: 'openlist',
        baseUrl: `https://${creator}.files.example.test`,
        rootPath: `/chronoframe/${prefix}/${creator}`,
        token: `token-${creator}`,
        uploadEndpoint: '/api/fs/put',
        deleteEndpoint: '/api/fs/remove',
        metaEndpoint: '/api/fs/get',
        pathField: 'path',
      }),
      updateConfig: () => ({
        ignoredBySchema: true,
      }),
      expectedUpdateConfig: () => ({
        uploadEndpoint: '/api/fs/put',
        deleteEndpoint: '/api/fs/remove',
        metaEndpoint: '/api/fs/get',
        pathField: 'path',
      }),
    },
  ]
}

function albumIdsFromPhotoAlbumsResponse(body) {
  if (!Array.isArray(body)) return []
  return uniqueIntegers(
    body
      .map((album) => album?.id)
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  )
}

function uniqueIntegers(values) {
  return [
    ...new Set(
      values.filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  ]
}

function expectPhotoAlbumBulkMutationResponse(
  name,
  body,
  expectedMode,
  expectedUpdatedCount,
) {
  expectExactKeys(name, body, ['mode', 'success', 'updatedCount'], 'body')
  expectEqual(name, body.success, true, 'body.success')
  expectEqual(
    name,
    body.updatedCount,
    expectedUpdatedCount,
    'body.updatedCount',
  )
  expectEqual(name, body.mode, expectedMode, 'body.mode')
}

function expectPhotoReactionMutationResponse(
  name,
  body,
  expectedAction,
  expectedReactionType,
) {
  expectExactKeys(name, body, ['action', 'reactionType', 'success'], 'body')
  expectEqual(name, body.success, true, 'body.success')
  expectEqual(name, body.action, expectedAction, 'body.action')
  expectEqual(
    name,
    body.reactionType,
    expectedReactionType,
    'body.reactionType',
  )
}

function expectAccessConfigResponse(name, body, expected) {
  expectExactKeys(
    name,
    body,
    ['albumLimit', 'enabled', 'hasPassword', 'photoLimit'],
    'body',
  )
  expectEqual(name, body.enabled, expected.enabled, 'body.enabled')
  expectEqual(name, body.hasPassword, expected.hasPassword, 'body.hasPassword')
  expectEqual(name, body.photoLimit, expected.photoLimit, 'body.photoLimit')
  expectEqual(name, body.albumLimit, expected.albumLimit, 'body.albumLimit')
}

function reactionFingerprintHeaders(api, provider) {
  const suffix = randomUUID().slice(0, 8)
  return {
    'X-Forwarded-For': '198.51.100.17',
    'User-Agent': `chronoframe-dual-mutation/${statePrefix(api)}/${provider}/${suffix}`,
    'Accept-Language': 'en-US',
    'Accept-Encoding': 'gzip',
  }
}

function findById(values, id) {
  return Array.isArray(values)
    ? values.find((value) => value?.id === id)
    : undefined
}

function requirePositiveInteger(value, name, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new VerificationFailure([
      { name, field, expected: 'positive integer', actual: value },
    ])
  }
  return value
}

function expectEqual(name, actual, expected, field) {
  if (actual !== expected) {
    throw new VerificationFailure([{ name, field, expected, actual }])
  }
}

function expectDeepEqual(name, actual, expected, field) {
  if (stableJSON(actual) !== stableJSON(expected)) {
    throw new VerificationFailure([{ name, field, expected, actual }])
  }
}

function stableJSON(value) {
  return JSON.stringify(sortJSONValue(value))
}

function sortJSONValue(value) {
  if (Array.isArray(value)) return value.map(sortJSONValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJSONValue(value[key])]),
  )
}

function expectExactKeys(name, actual, expected, field) {
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    throw new VerificationFailure([{ name, field, expected, actual }])
  }
  expectDeepEqual(name, Object.keys(actual).sort(), [...expected].sort(), field)
}

function expectS3UploadPrepareURL(
  name,
  actual,
  { endpoint, bucket, key, accessKeyId, region },
) {
  if (typeof actual !== 'string') {
    throw new VerificationFailure([
      { name, field: 'body.signedUrl', expected: 'S3 presigned URL', actual },
    ])
  }

  let parsed
  let expectedEndpoint
  try {
    parsed = new URL(actual)
    expectedEndpoint = new URL(endpoint)
  } catch {
    throw new VerificationFailure([
      { name, field: 'body.signedUrl', expected: 'absolute S3 URL', actual },
    ])
  }

  expectEqual(
    name,
    parsed.protocol,
    expectedEndpoint.protocol,
    'body.signedUrl.protocol',
  )
  expectEqual(name, parsed.host, expectedEndpoint.host, 'body.signedUrl.host')
  expectEqual(
    name,
    parsed.pathname,
    `/${bucket}/${key}`,
    'body.signedUrl.pathname',
  )
  expectEqual(
    name,
    parsed.searchParams.get('X-Amz-Algorithm'),
    'AWS4-HMAC-SHA256',
    'body.signedUrl.X-Amz-Algorithm',
  )
  expectEqual(
    name,
    parsed.searchParams.get('X-Amz-Expires'),
    '3600',
    'body.signedUrl.X-Amz-Expires',
  )
  expectEqual(
    name,
    parsed.searchParams.get('X-Amz-SignedHeaders'),
    'host',
    'body.signedUrl.X-Amz-SignedHeaders',
  )

  const credential = parsed.searchParams.get('X-Amz-Credential') || ''
  expectIncludes(
    name,
    credential,
    `${accessKeyId}/`,
    'body.signedUrl.X-Amz-Credential',
  )
  expectIncludes(
    name,
    credential,
    `/${region || 'auto'}/s3/aws4_request`,
    'body.signedUrl.X-Amz-Credential',
  )
  expectNonEmptyString(
    name,
    parsed.searchParams.get('X-Amz-Date'),
    'body.signedUrl.X-Amz-Date',
  )
  expectNonEmptyString(
    name,
    parsed.searchParams.get('X-Amz-Signature'),
    'body.signedUrl.X-Amz-Signature',
  )
}

function expectUploadShareResponse(api, name, body) {
  expectExactKeys(name, body, UPLOAD_SHARE_RESPONSE_KEYS, 'body')
  expectISOStringMilliseconds(name, body.createdAt, 'body.createdAt')
  expectISOStringMilliseconds(name, body.updatedAt, 'body.updatedAt')
  expectNullableISOStringMilliseconds(name, body.expiresAt, 'body.expiresAt')
  expectNullableISOStringMilliseconds(name, body.lastUsedAt, 'body.lastUsedAt')
  expectNonEmptyString(name, body.token, 'body.token')
  expectUploadShareURL(api, name, body.url, 'body.url')
}

function expectISOStringMilliseconds(name, actual, field) {
  if (typeof actual !== 'string' || !ISO_MILLISECOND_UTC_PATTERN.test(actual)) {
    throw new VerificationFailure([
      {
        name,
        field,
        expected: 'ISO 8601 UTC string with millisecond precision',
        actual,
      },
    ])
  }
}

function expectNullableISOStringMilliseconds(name, actual, field) {
  if (actual === null) return
  expectISOStringMilliseconds(name, actual, field)
}

function expectNonEmptyString(name, actual, field) {
  if (typeof actual !== 'string' || actual.length === 0) {
    throw new VerificationFailure([
      { name, field, expected: 'non-empty string', actual },
    ])
  }
}

function expectStringStartsWith(name, actual, expected, field) {
  if (typeof actual !== 'string' || !actual.startsWith(expected)) {
    throw new VerificationFailure([{ name, field, expected, actual }])
  }
}

function expectStringEndsWith(name, actual, expected, field) {
  if (typeof actual !== 'string' || !actual.endsWith(expected)) {
    throw new VerificationFailure([{ name, field, expected, actual }])
  }
}

function expectUploadShareURL(api, name, actual, field) {
  const expectedOrigin = new URL(api.base).origin
  if (
    typeof actual !== 'string' ||
    !actual.startsWith(`${expectedOrigin}/upload/`)
  ) {
    throw new VerificationFailure([
      { name, field, expected: `${expectedOrigin}/upload/{token}`, actual },
    ])
  }
}

function expectIncludes(name, values, expected, field) {
  if (!values.includes(expected)) {
    throw new VerificationFailure([{ name, field, expected, actual: values }])
  }
}

function otherProvider(provider) {
  return provider === 'node' ? 'go' : 'node'
}

function statePrefix(api) {
  return api.prefix || DEFAULT_MUTATION_PREFIX
}

function joinMutationURL(baseURL, requestPath) {
  const base = new URL(baseURL)
  const suffix = requestPath.startsWith('/') ? requestPath : `/${requestPath}`
  const [pathPart, searchPart = ''] = suffix.split('?')
  base.pathname = `${base.pathname.replace(/\/+$/, '')}${pathPart}`
  base.search = searchPart ? `?${searchPart}` : ''
  base.hash = ''
  return base
}

function normalizeBaseURL(rawValue) {
  const value = String(rawValue || '').trim()
  if (!value) throw new Error('base must not be empty')
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('base must be an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('base must use http or https')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function normalizeCookie(rawValue) {
  const value = String(rawValue || '').trim()
  if (!value) {
    throw new Error(
      'cookie must not be empty; seed the fixture session or pass --cookie',
    )
  }
  return value
}

function normalizePrefix(rawValue) {
  const value = String(rawValue || '').trim()
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(value)) {
    throw new Error(
      'prefix must be 1-64 characters and contain only letters, numbers, dot, underscore, or dash',
    )
  }
  return value
}

function parsePositiveInteger(rawValue, name) {
  const value =
    typeof rawValue === 'number' ? rawValue : Number.parseInt(rawValue, 10)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function normalizedContentType(value) {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || ''
}

function parseJSONBody(text) {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

class VerificationFailure extends Error {
  constructor(errors) {
    super(errors.map((error) => `${error.name}: ${error.field}`).join(', '))
    this.name = 'VerificationFailure'
    this.errors = errors
  }
}

async function main() {
  const options = parseMutationVerifierOptions()
  const result = await verifyDualMutations(options)
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}

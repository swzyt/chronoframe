import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DUAL_BACKEND_COMPARE_FIXTURE } from '../scripts/compare-backends.mjs'
import {
  DEFAULT_MUTATION_COOKIE,
  parseMutationVerifierOptions,
  validateHTTPResult,
  verifyDualMutations,
} from '../scripts/verify-dual-mutations.mjs'

const REACTION_TYPES = [
  'like',
  'love',
  'amazing',
  'funny',
  'wow',
  'sad',
  'fire',
  'sparkle',
]

function jsonResponse(body, backend, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-chronoframe-backend': backend,
      'x-request-id': 'response-request-1',
    },
  })
}

function createMutationGateway({
  breakGoAlbumRead = false,
  breakGoUploadObjectShape = false,
  breakGoUploadPrepareShape = false,
  breakGoUploadShareTimestamp = false,
  breakGoUserMutationShape = false,
} = {}) {
  const state = {
    provider: 'node',
    storageProvider: 910_001,
    slogan: 'original slogan',
    accessConfig: {
      enabled: false,
      hasPassword: false,
      photoLimit: 10,
      albumLimit: 1,
    },
    originalAlbumIds: [DUAL_BACKEND_COMPARE_FIXTURE.albumId],
    photoAlbumIds: [DUAL_BACKEND_COMPARE_FIXTURE.albumId],
    nextAlbumId: 920_001,
    nextStorageConfigId: 930_001,
    nextUploadShareId: 940_001,
    nextUserId: 950_001,
    mutablePhoto: {
      id: DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId,
      title: 'editable original title',
      description: 'editable original description',
      tags: ['dual-backend', 'editable'],
      exif: { Rating: 1 },
    },
    albums: new Map([
      [
        DUAL_BACKEND_COMPARE_FIXTURE.albumId,
        {
          id: DUAL_BACKEND_COMPARE_FIXTURE.albumId,
          title: 'fixture album',
          description: null,
          photoIds: [DUAL_BACKEND_COMPARE_FIXTURE.photoId],
        },
      ],
    ]),
    storageConfigs: new Map(),
    uploadShares: new Map(),
    users: new Map(),
    uploadedObjects: new Map(),
    reactions: new Map(),
    requests: [],
  }

  const fetchImpl = async (url, options) => {
    const contentType = options.headers['Content-Type'] || ''
    const request = {
      url: String(url),
      method: options.method,
      body:
        options.body && contentType.startsWith('application/json')
          ? JSON.parse(options.body)
          : undefined,
      rawBody:
        options.body && !contentType.startsWith('application/json')
          ? String(options.body)
          : undefined,
      headers: { ...options.headers },
    }
    state.requests.push(request)

    const urlObject = new URL(url)
    const pathname = urlObject.pathname
    if (
      request.method === 'PUT' &&
      pathname === '/api/system/settings/system/backend.readProvider'
    ) {
      state.provider = request.body.value
      return jsonResponse(
        {
          namespace: 'system',
          key: 'backend.readProvider',
          value: state.provider,
        },
        'node',
      )
    }

    const backend =
      breakGoAlbumRead &&
      state.provider === 'go' &&
      request.method === 'GET' &&
      /^\/api\/albums\/\d+$/.test(pathname)
        ? 'node'
        : state.provider

    if (pathname === '/api/system/settings/storage/provider') {
      if (request.method === 'GET') {
        return jsonResponse(
          {
            namespace: 'storage',
            key: 'provider',
            value: state.storageProvider,
          },
          backend,
        )
      }
      if (request.method === 'PUT') {
        state.storageProvider = request.body.value
        return jsonResponse(
          {
            namespace: 'storage',
            key: 'provider',
            value: state.storageProvider,
          },
          backend,
        )
      }
    }

    if (pathname === '/api/system/settings/app/slogan') {
      if (request.method === 'GET') {
        return jsonResponse(
          { namespace: 'app', key: 'slogan', value: state.slogan },
          backend,
        )
      }
      if (request.method === 'PUT') {
        state.slogan = request.body.value
        return jsonResponse(
          { namespace: 'app', key: 'slogan', value: state.slogan },
          backend,
        )
      }
    }

    if (pathname === '/api/access/config') {
      if (request.method === 'GET') {
        return jsonResponse({ ...state.accessConfig }, backend)
      }
      if (request.method === 'PUT') {
        state.accessConfig = {
          ...state.accessConfig,
          enabled: request.body.enabled,
          photoLimit: request.body.photoLimit,
          albumLimit: request.body.albumLimit,
        }
        return jsonResponse({ ...state.accessConfig }, backend)
      }
    }

    if (pathname === '/api/admin/users') {
      if (request.method === 'GET') {
        return jsonResponse([...state.users.values()], backend)
      }
      if (request.method === 'POST') {
        const id = state.nextUserId++
        const user = {
          id,
          username: request.body.username,
          email: request.body.email,
          avatar: null,
          createdAt: new Date(1_789_137_245_151).toISOString(),
          isAdmin: request.body.isAdmin ? 1 : 0,
          isActive: true,
          photoCount: 0,
          albumCount: 0,
        }
        state.users.set(id, user)
        const responseUser = {
          id: user.id,
          username: user.username,
          email: user.email,
          isAdmin: user.isAdmin,
          isActive: user.isActive,
        }
        if (breakGoUserMutationShape && backend === 'go') {
          responseUser.createdAt = user.createdAt
        }
        return jsonResponse(responseUser, backend)
      }
    }

    const userMatch = /^\/api\/admin\/users\/(\d+)$/.exec(pathname)
    if (userMatch) {
      const id = Number(userMatch[1])
      const user = state.users.get(id)
      if (!user) {
        return jsonResponse({ statusMessage: 'User not found' }, backend, 404)
      }
      if (request.method === 'PATCH') {
        Object.assign(user, {
          username: request.body.username ?? user.username,
          email: request.body.email ?? user.email,
          isAdmin:
            request.body.isAdmin === undefined
              ? user.isAdmin
              : request.body.isAdmin
                ? 1
                : 0,
          isActive: request.body.isActive ?? user.isActive,
        })
        const responseUser = {
          id: user.id,
          username: user.username,
          email: user.email,
          isAdmin: user.isAdmin,
          isActive: user.isActive,
        }
        if (breakGoUserMutationShape && backend === 'go') {
          responseUser.createdAt = user.createdAt
        }
        return jsonResponse(responseUser, backend)
      }
      if (request.method === 'DELETE') {
        state.users.delete(id)
        return jsonResponse({ success: true }, backend)
      }
    }

    if (pathname === '/api/photos' && request.method === 'POST') {
      const activeStorageConfig = state.storageConfigs.get(
        state.storageProvider,
      )
      if (activeStorageConfig?.provider === 's3') {
        const fileKey = `${activeStorageConfig.config.prefix}/users/910001/${request.body.fileName}`
        const responseBody = {
          signedUrl: fakeS3SignedUrl(activeStorageConfig.config, fileKey),
          fileKey,
          contentHash: request.body.contentHash,
          expiresIn: 3600,
        }
        if (breakGoUploadPrepareShape && backend === 'go') {
          delete responseBody.contentHash
        }
        return jsonResponse(responseBody, backend)
      }

      const responseBody = {
        signedUrl:
          '/api/photos/upload?key=dual-fixture%2Fusers%2F910001%2Fdual-mutation-upload-prepare.jpg',
        fileKey: 'dual-fixture/users/910001/dual-mutation-upload-prepare.jpg',
        contentHash: request.body.contentHash,
        expiresIn: 3600,
      }
      if (breakGoUploadPrepareShape && backend === 'go') {
        delete responseBody.contentHash
      }
      return jsonResponse(responseBody, backend)
    }

    if (pathname === '/api/photos/upload' && request.method === 'PUT') {
      const key = urlObject.searchParams.get('key')
      state.uploadedObjects.set(`${backend}:${key}`, {
        key,
        body: request.rawBody,
      })
      const responseBody = { ok: true, key }
      if (breakGoUploadObjectShape && backend === 'go') {
        delete responseBody.key
      }
      return jsonResponse(responseBody, backend)
    }

    if (
      pathname === '/api/photos/check-duplicate' &&
      request.method === 'POST'
    ) {
      return jsonResponse(
        {
          success: true,
          results: [
            {
              contentHash:
                '0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF',
              normalizedContentHash:
                '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
              exists: false,
              photo: null,
            },
            {
              contentHash: 'invalid-hash',
              normalizedContentHash: null,
              exists: false,
              photo: null,
            },
            {
              fileName: 'dual-mutation-upload-prepare.jpg',
              storageKey:
                'dual-fixture/users/910001/dual-mutation-upload-prepare.jpg',
              photoId: 'dual-mutation-upload-prepare',
              exists: false,
              photo: null,
            },
            {
              storageKey:
                'dual-fixture/users/910001/dual-mutation-upload-prepare.jpg',
              photoId: 'dual-mutation-upload-prepare',
              exists: false,
              photo: null,
            },
          ],
          duplicatesFound: 0,
          summary: {
            title: 'Check Complete',
            message: 'Checked 4 files, found 0 duplicates',
          },
        },
        backend,
      )
    }

    if (pathname === '/api/photos' && request.method === 'GET') {
      const search = urlObject.searchParams.get('search')
      const items =
        search === DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId
          ? [state.mutablePhoto]
          : []
      return jsonResponse(
        {
          items,
          total: items.length,
          page: 1,
          pageSize: 10,
          totalPages: 1,
        },
        backend,
      )
    }

    const reactionMatch = /^\/api\/photos\/([^/]+)\/reactions$/.exec(pathname)
    if (reactionMatch) {
      const photoId = decodeURIComponent(reactionMatch[1])
      const key = reactionKey(request, photoId)
      if (request.method === 'GET') {
        const reactions = Object.fromEntries(
          REACTION_TYPES.map((reactionType) => [reactionType, 0]),
        )
        for (const reaction of state.reactions.values()) {
          if (reaction.photoId === photoId) {
            reactions[reaction.reactionType] += 1
          }
        }
        return jsonResponse(
          {
            photoId,
            reactions,
            userReaction: state.reactions.get(key)?.reactionType ?? null,
          },
          backend,
        )
      }
      if (request.method === 'POST') {
        const existing = state.reactions.get(key)
        const action = existing ? 'updated' : 'created'
        state.reactions.set(key, {
          photoId,
          reactionType: request.body.reactionType,
        })
        return jsonResponse(
          {
            success: true,
            action,
            reactionType: request.body.reactionType,
          },
          backend,
        )
      }
      if (request.method === 'DELETE') {
        if (!state.reactions.has(key)) {
          return jsonResponse(
            {
              statusCode: 404,
              statusMessage: 'Server Error',
              message: 'Reaction not found',
            },
            backend,
            404,
          )
        }
        state.reactions.delete(key)
        return jsonResponse({ success: true, action: 'deleted' }, backend)
      }
    }

    if (
      pathname === `/api/photos/${DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId}`
    ) {
      if (request.method === 'PUT') {
        const normalizedTags = []
        const seenTags = new Set()
        for (const rawTag of request.body.tags ?? []) {
          const tag = rawTag.trim()
          const key = tag.toLowerCase()
          if (!tag || seenTags.has(key)) continue
          seenTags.add(key)
          normalizedTags.push(tag)
        }
        state.mutablePhoto = {
          ...state.mutablePhoto,
          title: request.body.title?.trim() ?? state.mutablePhoto.title,
          description:
            request.body.description?.trim() ?? state.mutablePhoto.description,
          tags:
            request.body.tags === undefined
              ? state.mutablePhoto.tags
              : normalizedTags,
          exif: {
            ...state.mutablePhoto.exif,
            Rating:
              request.body.rating === undefined
                ? state.mutablePhoto.exif.Rating
                : request.body.rating,
          },
        }
        return jsonResponse(
          { success: true, photo: state.mutablePhoto },
          backend,
        )
      }
    }

    if (
      pathname === `/api/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}/albums`
    ) {
      if (request.method === 'GET') {
        return jsonResponse(
          state.photoAlbumIds
            .map((id) => state.albums.get(id))
            .filter(Boolean)
            .map((album) => ({ id: album.id, title: album.title })),
          backend,
        )
      }
      if (request.method === 'PUT') {
        state.photoAlbumIds = [...new Set(request.body.albumIds)]
        return jsonResponse(
          {
            photoId: DUAL_BACKEND_COMPARE_FIXTURE.photoId,
            albumIds: state.photoAlbumIds,
          },
          backend,
        )
      }
    }

    if (pathname === '/api/photos/albums' && request.method === 'PUT') {
      const photoIds = [...new Set(request.body.photoIds || [])]
      const albumIds = [...new Set(request.body.albumIds || [])]
      const mode = request.body.mode || 'replace'
      if (photoIds.includes(DUAL_BACKEND_COMPARE_FIXTURE.photoId)) {
        if (mode === 'replace') {
          state.photoAlbumIds = albumIds
        } else if (mode === 'add') {
          state.photoAlbumIds = [
            ...new Set([...state.photoAlbumIds, ...albumIds]),
          ]
        } else if (mode === 'remove') {
          state.photoAlbumIds = state.photoAlbumIds.filter(
            (albumId) => !albumIds.includes(albumId),
          )
        }
      }
      return jsonResponse(
        { success: true, updatedCount: photoIds.length, mode },
        backend,
      )
    }

    if (pathname === '/api/albums' && request.method === 'POST') {
      const id = state.nextAlbumId++
      const photoIds = [...new Set(request.body.photoIds || [])]
      if (request.body.coverPhotoId) photoIds.push(request.body.coverPhotoId)
      state.albums.set(id, {
        id,
        title: request.body.title,
        description: request.body.description || null,
        coverPhotoId: request.body.coverPhotoId || null,
        photoIds: [...new Set(photoIds)],
      })
      return jsonResponse({ id, title: request.body.title }, backend)
    }

    const albumMatch = /^\/api\/albums\/(\d+)$/.exec(pathname)
    if (albumMatch) {
      const id = Number(albumMatch[1])
      const album = state.albums.get(id)
      if (!album)
        return jsonResponse({ statusMessage: 'Album not found' }, backend, 404)
      if (request.method === 'GET') {
        return jsonResponse(
          {
            ...album,
            totalPhotoCount: album.photoIds.length,
            photos: album.photoIds.map((id) => ({ id })),
          },
          backend,
        )
      }
      if (request.method === 'PUT') {
        Object.assign(album, {
          title: request.body.title ?? album.title,
          description: request.body.description ?? album.description,
        })
        return jsonResponse({ ...album }, backend)
      }
      if (request.method === 'DELETE') {
        state.albums.delete(id)
        state.photoAlbumIds = state.photoAlbumIds.filter(
          (albumId) => albumId !== id,
        )
        return jsonResponse({ success: true }, backend)
      }
    }

    if (pathname === '/api/system/settings/storage-config') {
      if (request.method === 'POST') {
        const id = state.nextStorageConfigId++
        state.storageConfigs.set(id, {
          id,
          name: request.body.name,
          provider: request.body.provider,
          config: normalizeFakeStorageConfigForCreate(
            request.body.provider,
            request.body.config,
          ),
        })
        return jsonResponse({ id }, backend)
      }
    }

    const storageMatch =
      /^\/api\/system\/settings\/storage-config\/(\d+)$/.exec(pathname)
    if (storageMatch) {
      const id = Number(storageMatch[1])
      const config = state.storageConfigs.get(id)
      if (!config) {
        return jsonResponse(
          { statusMessage: 'Storage configuration not found' },
          backend,
          404,
        )
      }
      if (request.method === 'GET') return jsonResponse(config, backend)
      if (request.method === 'PUT') {
        Object.assign(config, {
          name: request.body.name,
          provider: request.body.provider,
          config: normalizeFakeStorageConfigForUpdate(
            request.body.provider,
            request.body.config,
          ),
        })
        return jsonResponse({ success: true }, backend)
      }
      if (request.method === 'DELETE') {
        state.storageConfigs.delete(id)
        return jsonResponse({ success: true }, backend)
      }
    }

    if (pathname === '/api/upload-shares') {
      if (request.method === 'GET') {
        return jsonResponse([...state.uploadShares.values()], backend)
      }
      if (request.method === 'POST') {
        const id = state.nextUploadShareId++
        const share = {
          id,
          label: request.body.label?.trim() || null,
          isActive: true,
          uploadCount: 0,
          maxUploads: request.body.maxUploads ?? null,
          expiresAt: '2026-09-12T18:52:31.000Z',
          lastUsedAt: null,
          createdAt: '2026-09-11T18:52:31.000Z',
          updatedAt: '2026-09-11T18:52:31.000Z',
          token: `token-${id}`,
          url: `http://gateway.test/upload/token-${id}`,
        }
        state.uploadShares.set(id, share)
        return jsonResponse(
          uploadShareResponse(share, backend, breakGoUploadShareTimestamp),
          backend,
        )
      }
    }

    const publicPrepareMatch =
      /^\/api\/upload-shares\/public\/([^/]+)\/prepare$/.exec(pathname)
    if (publicPrepareMatch && request.method === 'POST') {
      const token = decodeURIComponent(publicPrepareMatch[1])
      const share = [...state.uploadShares.values()].find(
        (candidate) => candidate.token === token,
      )
      if (!share) {
        return jsonResponse(
          { statusMessage: 'Upload link not found' },
          backend,
          404,
        )
      }
      const config = state.storageConfigs.get(state.storageProvider)?.config
      const baseName = request.body.fileName.replace(/\.[^.]*$/, '')
      const extension = request.body.fileName.endsWith('.jpg') ? '.jpg' : ''
      const fileKey = `${config.prefix}/users/910001/guest-uploads/${share.id}/2026-09-12/${baseName}-abcdef012345${extension}`
      return jsonResponse(
        {
          signedUrl: fakeS3SignedUrl(config, fileKey),
          fileKey,
          contentHash: request.body.contentHash,
          expiresIn: 3600,
        },
        backend,
      )
    }

    const shareMatch = /^\/api\/upload-shares\/(\d+)$/.exec(pathname)
    if (shareMatch) {
      const id = Number(shareMatch[1])
      const share = state.uploadShares.get(id)
      if (!share) {
        return jsonResponse(
          { statusMessage: 'Upload link not found' },
          backend,
          404,
        )
      }
      if (request.method === 'PATCH') {
        if (request.body.label !== undefined) {
          share.label = request.body.label?.trim() || null
        }
        if (request.body.isActive !== undefined) {
          share.isActive = request.body.isActive
        }
        if (request.body.maxUploads !== undefined) {
          share.maxUploads = request.body.maxUploads
        }
        share.updatedAt = '2026-09-11T18:52:32.000Z'
        return jsonResponse(
          uploadShareResponse(share, backend, breakGoUploadShareTimestamp),
          backend,
        )
      }
      if (request.method === 'DELETE') {
        state.uploadShares.delete(id)
        return jsonResponse({ ok: true }, backend)
      }
    }

    return jsonResponse({ statusMessage: 'not found' }, backend, 404)
  }

  return { state, fetchImpl }
}

function normalizeFakeStorageConfigForCreate(provider, config) {
  if (provider === 'local') {
    return pickDefined({
      provider: 'local',
      basePath: config.basePath,
      baseUrl: config.baseUrl,
      prefix: config.prefix,
    })
  }
  if (provider === 's3') {
    return pickDefined({
      provider: 's3',
      bucket: config.bucket,
      region: config.region ?? 'auto',
      endpoint: config.endpoint,
      prefix: config.prefix ?? '/photos',
      cdnUrl: config.cdnUrl,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      forcePathStyle: config.forcePathStyle,
      maxKeys: config.maxKeys,
    })
  }
  if (provider === 'openlist') {
    return pickDefined({
      provider: 'openlist',
      baseUrl: config.baseUrl,
      rootPath: config.rootPath,
      token: config.token,
      uploadEndpoint: config.uploadEndpoint ?? '/api/fs/put',
      downloadEndpoint: config.downloadEndpoint,
      listEndpoint: config.listEndpoint,
      deleteEndpoint: config.deleteEndpoint ?? '/api/fs/remove',
      metaEndpoint: config.metaEndpoint ?? '/api/fs/get',
      pathField: config.pathField ?? 'path',
      cdnUrl: config.cdnUrl,
    })
  }
  throw new Error(`Unknown fake storage provider: ${provider}`)
}

function normalizeFakeStorageConfigForUpdate(provider, config) {
  if (provider === 'local') {
    return pickDefined({
      provider: config.provider,
      basePath: config.basePath,
      baseUrl: config.baseUrl,
      prefix: config.prefix,
    })
  }
  if (provider === 's3') {
    return pickDefined({
      provider: config.provider,
      bucket: config.bucket,
      region: config.region ?? 'auto',
      endpoint: config.endpoint,
      prefix: config.prefix ?? '/photos',
      cdnUrl: config.cdnUrl,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      forcePathStyle: config.forcePathStyle,
      maxKeys: config.maxKeys,
    })
  }
  if (provider === 'openlist') {
    return pickDefined({
      provider: config.provider,
      baseUrl: config.baseUrl,
      rootPath: config.rootPath,
      token: config.token,
      uploadEndpoint: config.uploadEndpoint ?? '/api/fs/put',
      downloadEndpoint: config.downloadEndpoint,
      listEndpoint: config.listEndpoint,
      deleteEndpoint: config.deleteEndpoint ?? '/api/fs/remove',
      metaEndpoint: config.metaEndpoint ?? '/api/fs/get',
      pathField: config.pathField ?? 'path',
      cdnUrl: config.cdnUrl,
    })
  }
  throw new Error(`Unknown fake storage provider: ${provider}`)
}

function fakeS3SignedUrl(config, fileKey) {
  const url = new URL(config.endpoint)
  url.pathname = `/${config.bucket}/${fileKey}`
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256')
  url.searchParams.set(
    'X-Amz-Credential',
    `${config.accessKeyId}/20260912/${config.region || 'auto'}/s3/aws4_request`,
  )
  url.searchParams.set('X-Amz-Date', '20260912T000000Z')
  url.searchParams.set('X-Amz-Expires', '3600')
  url.searchParams.set('X-Amz-Signature', 'fake-signature')
  url.searchParams.set('X-Amz-SignedHeaders', 'host')
  return url.toString()
}

function pickDefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  )
}

function reactionKey(request, photoId) {
  return [
    photoId,
    request.headers['X-Forwarded-For'],
    request.headers['User-Agent'],
    request.headers['Accept-Language'],
    request.headers['Accept-Encoding'],
  ].join('|')
}

function uploadShareResponse(share, backend, breakGoUploadShareTimestamp) {
  const responseShare = { ...share }
  if (breakGoUploadShareTimestamp && backend === 'go') {
    responseShare.createdAt = responseShare.createdAt.replace('.000Z', 'Z')
  }
  return responseShare
}

test('dual mutation verifier exercises reversible writes through both providers', async () => {
  const gateway = createMutationGateway()

  const result = await verifyDualMutations({
    base: 'http://gateway.test',
    cookie: 'cf_session=test-token',
    prefix: 'parity-test',
    fetchImpl: gateway.fetchImpl,
  })

  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2))
  assert.equal(gateway.state.provider, 'node')
  assert.equal(gateway.state.storageProvider, 910_001)
  assert.equal(gateway.state.slogan, 'original slogan')
  assert.deepEqual(gateway.state.accessConfig, {
    enabled: false,
    hasPassword: false,
    photoLimit: 10,
    albumLimit: 1,
  })
  assert.deepEqual(gateway.state.photoAlbumIds, gateway.state.originalAlbumIds)
  assert.equal(gateway.state.mutablePhoto.title, 'editable original title')
  assert.deepEqual(gateway.state.mutablePhoto.tags, [
    'dual-backend',
    'editable',
  ])
  assert.equal(gateway.state.mutablePhoto.exif.Rating, 1)
  assert.equal(gateway.state.storageConfigs.size, 0)
  assert.equal(gateway.state.uploadShares.size, 0)
  assert.equal(gateway.state.users.size, 0)
  assert.equal(gateway.state.reactions.size, 0)
  assert.deepEqual(
    [...gateway.state.albums.keys()],
    [DUAL_BACKEND_COMPARE_FIXTURE.albumId],
  )
  assert.ok(
    result.checks.some(
      (check) =>
        check.name === 'storage config update via go' && check.backend === 'go',
    ),
  )
  assert.ok(
    result.checks.some(
      (check) =>
        check.name === 'storage config s3 update via go' &&
        check.backend === 'go',
    ),
  )
  assert.ok(
    result.checks.some(
      (check) =>
        check.name ===
          's3 photo upload prepare via go after node storage switch' &&
        check.backend === 'go',
    ),
  )
  assert.ok(
    result.checks.some(
      (check) =>
        check.name ===
          'storage config openlist cross-read via go after node create' &&
        check.backend === 'go',
    ),
  )
  assert.ok(
    result.checks.some(
      (check) =>
        check.name === 'upload share update via node' &&
        check.backend === 'node',
    ),
  )
  assert.ok(
    result.checks.some(
      (check) =>
        check.name === 'photo metadata update via go' && check.backend === 'go',
    ),
  )
  assert.ok(
    result.checks.some(
      (check) =>
        check.name === 'admin user update via go' && check.backend === 'go',
    ),
  )
  assert.ok(
    result.checks.some(
      (check) =>
        check.name === 'access config update via go' && check.backend === 'go',
    ),
  )
  assert.ok(
    result.checks.some(
      (check) =>
        check.name === 'photo upload prepare via go' && check.backend === 'go',
    ),
  )
  assert.ok(
    result.checks.some(
      (check) =>
        check.name === 'photo object upload via go' && check.backend === 'go',
    ),
  )
  assert.ok(
    result.checks.some(
      (check) =>
        check.name === 'photo album bulk remove via go' &&
        check.backend === 'go',
    ),
  )
  assert.ok(
    result.checks.some(
      (check) =>
        check.name === 'photo reaction update via go' && check.backend === 'go',
    ),
  )
  assert.ok(
    result.checks.some(
      (check) =>
        check.name === 'photo reaction create via go' && check.backend === 'go',
    ),
  )
  assert.equal(
    gateway.state.uploadedObjects.get(
      'go:dual-fixture/users/910001/dual-mutation-upload-prepare.jpg',
    )?.body,
    'chronoframe-dual-backend-upload-object:go',
  )
  assert.ok(
    result.checks.some(
      (check) =>
        check.name === 'photo duplicate check via go' && check.backend === 'go',
    ),
  )
  assert.ok(
    gateway.state.requests.some((request) =>
      request.url.includes(
        '/api/photos?scope=manage&search=dual-fixture-photo-editable&page=1&pageSize=10',
      ),
    ),
  )
})

test('dual mutation verifier cleans temporary records after a provider mismatch', async () => {
  const gateway = createMutationGateway({ breakGoAlbumRead: true })

  const result = await verifyDualMutations({
    base: 'http://gateway.test',
    cookie: 'cf_session=test-token',
    prefix: 'parity-test',
    fetchImpl: gateway.fetchImpl,
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors, [
    {
      name: 'album cross-read via go after node create',
      field: 'headers.x-chronoframe-backend',
      expected: 'go',
      actual: 'node',
    },
  ])
  assert.equal(gateway.state.provider, 'node')
  assert.equal(gateway.state.storageProvider, 910_001)
  assert.equal(gateway.state.slogan, 'original slogan')
  assert.equal(gateway.state.mutablePhoto.title, 'editable original title')
  assert.equal(gateway.state.storageConfigs.size, 0)
  assert.equal(gateway.state.uploadShares.size, 0)
  assert.equal(gateway.state.users.size, 0)
  assert.deepEqual(
    [...gateway.state.albums.keys()],
    [DUAL_BACKEND_COMPARE_FIXTURE.albumId],
  )
  assert.ok(
    result.cleanup.some((entry) =>
      entry.name.startsWith('delete temporary album '),
    ),
  )
})

test('dual mutation verifier rejects admin user response shape drift', async () => {
  const gateway = createMutationGateway({ breakGoUserMutationShape: true })

  const result = await verifyDualMutations({
    base: 'http://gateway.test',
    cookie: 'cf_session=test-token',
    prefix: 'parity-test',
    fetchImpl: gateway.fetchImpl,
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors, [
    {
      name: 'admin user update via go',
      field: 'body',
      expected: ['email', 'id', 'isActive', 'isAdmin', 'username'],
      actual: ['createdAt', 'email', 'id', 'isActive', 'isAdmin', 'username'],
    },
  ])
  assert.equal(gateway.state.provider, 'node')
  assert.equal(gateway.state.users.size, 0)
})

test('dual mutation verifier rejects photo object upload response drift', async () => {
  const gateway = createMutationGateway({ breakGoUploadObjectShape: true })

  const result = await verifyDualMutations({
    base: 'http://gateway.test',
    cookie: 'cf_session=test-token',
    prefix: 'parity-test',
    fetchImpl: gateway.fetchImpl,
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors, [
    {
      name: 'photo object upload via go',
      field: 'body',
      expected: ['key', 'ok'],
      actual: ['ok'],
    },
  ])
  assert.equal(gateway.state.provider, 'node')
})

test('dual mutation verifier rejects photo upload prepare response drift', async () => {
  const gateway = createMutationGateway({ breakGoUploadPrepareShape: true })

  const result = await verifyDualMutations({
    base: 'http://gateway.test',
    cookie: 'cf_session=test-token',
    prefix: 'parity-test',
    fetchImpl: gateway.fetchImpl,
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors, [
    {
      name: 'photo upload prepare via go',
      field: 'body',
      expected: ['contentHash', 'expiresIn', 'fileKey', 'signedUrl'],
      actual: ['expiresIn', 'fileKey', 'signedUrl'],
    },
  ])
  assert.equal(gateway.state.provider, 'node')
})

test('dual mutation verifier rejects upload share timestamp drift', async () => {
  const gateway = createMutationGateway({ breakGoUploadShareTimestamp: true })

  const result = await verifyDualMutations({
    base: 'http://gateway.test',
    cookie: 'cf_session=test-token',
    prefix: 'parity-test',
    fetchImpl: gateway.fetchImpl,
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors, [
    {
      name: 's3 public upload share create via go',
      field: 'body.createdAt',
      expected: 'ISO 8601 UTC string with millisecond precision',
      actual: '2026-09-11T18:52:31Z',
    },
  ])
  assert.equal(gateway.state.provider, 'node')
  assert.equal(gateway.state.uploadShares.size, 0)
})

test('dual mutation verifier options default to fixture session and dual port', () => {
  const options = parseMutationVerifierOptions([], {
    CFRAME_DUAL_PORT: '33105',
  })

  assert.equal(options.base, 'http://127.0.0.1:33105')
  assert.equal(options.cookie, DEFAULT_MUTATION_COOKIE)
  assert.equal(options.timeoutMs, 5_000)
  assert.equal(options.prefix, 'dual-mutation')
})

test('dual mutation verifier options accept explicit values', () => {
  const options = parseMutationVerifierOptions(
    [
      '--',
      '--base',
      'http://gateway.test/prefix/',
      '--cookie',
      'cf_session=custom',
      '--timeout-ms',
      '2500',
      '--prefix',
      'custom-prefix',
    ],
    {},
  )

  assert.deepEqual(options, {
    base: 'http://gateway.test/prefix',
    cookie: 'cf_session=custom',
    timeoutMs: 2_500,
    prefix: 'custom-prefix',
  })
})

test('dual mutation HTTP result validation reports drift', () => {
  assert.deepEqual(
    validateHTTPResult(
      {
        name: 'mutation',
        expectedStatus: 200,
        expectedBackend: 'go',
        expectedValue: 'go',
      },
      {
        status: 500,
        backend: 'node',
        contentType: 'text/plain',
        body: { value: 'node' },
      },
    ).map((error) => error.field),
    [
      'status',
      'headers.x-chronoframe-backend',
      'headers.content-type',
      'body.value',
    ],
  )
})

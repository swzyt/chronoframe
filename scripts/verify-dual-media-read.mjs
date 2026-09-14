#!/usr/bin/env node

import { createHash, createHmac, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import Database from 'better-sqlite3'
import sharp from 'sharp'

import { DUAL_BACKEND_COMPARE_FIXTURE } from './compare-backends.mjs'
import {
  FIXTURE_SESSION_TOKEN,
  resolveSQLitePath,
} from './seed-dual-backend-fixture.mjs'

export const MEDIA_READ_ROUTE_IDS = Object.freeze([
  'photos.livephoto.read',
  'media.display',
  'media.image',
  'media.image.head',
  'media.og',
  'media.storage',
  'media.storage.head',
  'media.thumbnail',
])

export const MEDIA_READ_SCENARIOS = Object.freeze([
  'image full and HEAD',
  'image closed open suffix and conditional ranges',
  'image cache validators',
  'storage full and HEAD',
  'storage closed open suffix and conditional ranges',
  'storage cache validators',
  'display object and cache validator',
  'thumbnail key URL original URL and explicit original key',
  'OG dedicated derived legacy invalid duplicate and range tokens',
  'Live Photo success and missing photo',
  'anonymous original authorization',
  'unknown media and traversal boundaries',
])

const DEFAULT_BASE = 'http://127.0.0.1:3000'
const DEFAULT_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`
const DEFAULT_DATABASE_PATH = './data/app.sqlite3'
const DEFAULT_PREFIX = 'dual-media-read'
const DEFAULT_TIMEOUT_MS = 10_000
const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'
const PROVIDERS = ['node', 'go']
const OG_CONTEXT = 'chronoframe:og-media:v1'

export function parseMediaReadVerifierOptions(
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
      !['--base', '--cookie', '--db', '--prefix', '--timeout-ms'].includes(
        argument,
      )
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

  const base =
    values.get('--base') ||
    environment.CFRAME_DUAL_BASE ||
    (environment.CFRAME_DUAL_PORT
      ? `http://127.0.0.1:${environment.CFRAME_DUAL_PORT}`
      : DEFAULT_BASE)
  return {
    base: String(base).replace(/\/+$/, ''),
    cookie:
      values.get('--cookie') ||
      environment.CFRAME_DUAL_COOKIE ||
      DEFAULT_COOKIE,
    databasePath:
      values.get('--db') ||
      environment.CFRAME_DUAL_MEDIA_READ_DB ||
      DEFAULT_DATABASE_PATH,
    prefix:
      values.get('--prefix') ||
      environment.CFRAME_DUAL_MEDIA_READ_PREFIX ||
      DEFAULT_PREFIX,
    timeoutMs: positiveInteger(
      values.get('--timeout-ms') ||
        environment.CFRAME_DUAL_TIMEOUT_MS ||
        DEFAULT_TIMEOUT_MS,
      'timeout-ms',
    ),
  }
}

export async function verifyDualMediaRead(options = {}) {
  const normalized = normalizeOptions(options)
  const summary = {
    ok: false,
    base: normalized.base,
    databasePath: normalized.databasePath,
    routeIds: MEDIA_READ_ROUTE_IDS,
    scenarios: MEDIA_READ_SCENARIOS,
    checks: [],
    comparisons: [],
    cleanup: [],
  }
  const fixture = await createMediaFixture(normalized)
  const api = createAPI(normalized, summary)
  const results = new Map()

  try {
    for (const provider of PROVIDERS) {
      await setProvider(api, provider)
      results.set(provider, await exerciseProvider(api, provider, fixture))
    }

    const nodeResults = results.get('node')
    const goResults = results.get('go')
    for (const [caseID, nodeResult] of nodeResults) {
      const goResult = goResults.get(caseID)
      const errors = validateMediaReadPair(caseID, nodeResult, goResult)
      summary.comparisons.push({ caseId: caseID, ok: errors.length === 0 })
      if (errors.length > 0) {
        throw new Error(`${caseID}: ${errors.join('; ')}`)
      }
    }
    if (goResults.size !== nodeResults.size) {
      throw new Error(
        `provider matrix size differs: node=${nodeResults.size}, go=${goResults.size}`,
      )
    }
    summary.ok = true
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error)
  } finally {
    await cleanup(summary, 'restore backend provider to node', () =>
      setProvider(api, 'node'),
    )
    await cleanup(summary, 'remove media-read fixture', () =>
      removeMediaFixture(fixture),
    )
    summary.checkCount = summary.checks.length
    summary.comparisonCount = summary.comparisons.length
    if (summary.cleanup.some((item) => !item.ok)) summary.ok = false
  }
  return summary
}

function normalizeOptions(options) {
  const parsed = {
    base: String(options.base ?? DEFAULT_BASE).replace(/\/+$/, ''),
    cookie: String(options.cookie ?? DEFAULT_COOKIE),
    databasePath: resolveSQLitePath(
      String(options.databasePath ?? DEFAULT_DATABASE_PATH),
    ),
    prefix: String(options.prefix ?? DEFAULT_PREFIX),
    timeoutMs: positiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'timeoutMs',
    ),
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    dedicatedSecret: String(
      options.dedicatedSecret ??
        process.env.NUXT_OG_IMAGE_SECRET ??
        'chronoframe-dual-og-development-secret',
    ),
    sessionSecret: String(
      options.sessionSecret ??
        process.env.NUXT_SESSION_PASSWORD ??
        'chronoframe-dual-development-secret-change-me',
    ),
  }
  if (typeof parsed.fetchImpl !== 'function') {
    throw new Error('fetch implementation is required')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(parsed.prefix)) {
    throw new Error('prefix must contain 1-64 safe characters')
  }
  if (parsed.dedicatedSecret.length < 32 || parsed.sessionSecret.length < 32) {
    throw new Error(
      'OG and session verification secrets must be at least 32 characters',
    )
  }
  return parsed
}

function createAPI(options, summary) {
  return {
    async request({ name, method = 'GET', requestPath, headers = {}, cookie }) {
      const requestID = `dual-media-read-${randomUUID()}`
      const response = await options.fetchImpl(
        `${options.base}${requestPath}`,
        {
          method,
          headers: {
            Accept: '*/*',
            'X-Request-Id': requestID,
            ...(cookie === false ? {} : { Cookie: options.cookie }),
            ...headers,
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(options.timeoutMs),
        },
      )
      const bytes = Buffer.from(await response.arrayBuffer())
      const contentType = normalizeContentType(
        response.headers.get('content-type'),
      )
      const body = contentType === 'application/json' ? parseJSON(bytes) : null
      const result = {
        name,
        method,
        path: requestPath,
        status: response.status,
        backend: response.headers.get('x-chronoframe-backend') ?? '',
        requestID,
        responseRequestID: response.headers.get('x-request-id') ?? '',
        contentType,
        cacheControl: response.headers.get('cache-control'),
        acceptRanges: response.headers.get('accept-ranges'),
        contentRange: response.headers.get('content-range'),
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        vary: response.headers.get('vary'),
        byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        body,
        bytes,
      }
      summary.checks.push({ ...result, bytes: undefined })
      if (result.responseRequestID !== requestID) {
        throw new Error(
          `${name}: X-Request-Id mismatch ${result.responseRequestID} != ${requestID}`,
        )
      }
      return result
    },
    async switch(provider) {
      const requestID = `dual-media-read-switch-${randomUUID()}`
      const response = await options.fetchImpl(
        `${options.base}${PROVIDER_SETTING_PATH}`,
        {
          method: 'PUT',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Cookie: options.cookie,
            'X-Request-Id': requestID,
          },
          body: JSON.stringify({ value: provider }),
          signal: AbortSignal.timeout(options.timeoutMs),
        },
      )
      const body = await response.json()
      summary.checks.push({
        name: `switch backend provider to ${provider}`,
        method: 'PUT',
        path: PROVIDER_SETTING_PATH,
        status: response.status,
        backend: response.headers.get('x-chronoframe-backend') ?? '',
        requestID,
        responseRequestID: response.headers.get('x-request-id') ?? '',
        contentType: normalizeContentType(response.headers.get('content-type')),
        body,
      })
      if (
        response.status !== 200 ||
        response.headers.get('x-chronoframe-backend') !== 'node' ||
        response.headers.get('x-request-id') !== requestID ||
        body?.value !== provider
      ) {
        throw new Error(`failed to switch backend provider to ${provider}`)
      }
    },
  }
}

async function setProvider(api, provider) {
  if (!PROVIDERS.includes(provider))
    throw new Error(`invalid provider ${provider}`)
  await api.switch(provider)
}

async function exerciseProvider(api, provider, fixture) {
  const results = new Map()
  const run = async (caseID, expectation) => {
    const result = await api.request({
      name: `${caseID} via ${provider}`,
      ...expectation,
    })
    if (result.backend !== provider) {
      throw new Error(
        `${caseID}: expected backend ${provider}, got ${result.backend}`,
      )
    }
    validateExpectation(caseID, result, expectation)
    results.set(caseID, result)
    return result
  }

  const imagePath = `/image/${encodeKey(fixture.storageKey)}`
  const storagePath = `/storage/${encodeKey(fixture.storageKey)}`
  const imageETag = `W/"${fixture.original.length}-${encodeURIComponent(fixture.storageKey)}"`
  const storageStat = statSync(fixture.paths.original)
  const storageETag = `W/"${fixture.original.length}-${storageStat.mtimeMs}"`
  const lastModified = storageStat.mtime.toUTCString()

  const imageFull = await run('image.full', {
    requestPath: imagePath,
    expectedStatus: 200,
    expectedContentType: 'image/png',
    expectedBytes: fixture.original,
    expectedHeaders: mediaHeaders(imageETag, lastModified),
  })
  assertValue('image.full etag', imageFull.etag, imageETag)
  await run('image.head', {
    method: 'HEAD',
    requestPath: imagePath,
    expectedStatus: 200,
    expectedContentType: 'image/png',
    expectedBytes: Buffer.alloc(0),
    expectedHeaders: mediaHeaders(imageETag, lastModified),
  })
  await mediaRangeCases(
    run,
    'image',
    imagePath,
    fixture.original,
    imageETag,
    lastModified,
  )

  const storageFull = await run('storage.full', {
    requestPath: storagePath,
    expectedStatus: 200,
    expectedContentType: 'image/png',
    expectedBytes: fixture.original,
    expectedHeaders: mediaHeaders(storageETag, lastModified),
  })
  assertValue('storage.full etag', storageFull.etag, storageETag)
  await run('storage.head', {
    method: 'HEAD',
    requestPath: storagePath,
    expectedStatus: 200,
    expectedContentType: 'image/png',
    expectedBytes: Buffer.alloc(0),
    expectedHeaders: mediaHeaders(storageETag, lastModified),
  })
  await mediaRangeCases(
    run,
    'storage',
    storagePath,
    fixture.original,
    storageETag,
    lastModified,
  )

  const display = await run('display.full', {
    requestPath: `/display/${encodeURIComponent(fixture.id)}`,
    expectedStatus: 200,
    expectedContentType: 'image/webp',
    expectedBytes: fixture.display,
    expectedHeaders: {
      cacheControl: 'private, max-age=604800',
      etag: `W/"display-${fixture.id}-${fixture.display.length}"`,
      vary: 'Cookie',
    },
  })
  await run('display.if-none-match', {
    requestPath: `/display/${encodeURIComponent(fixture.id)}`,
    headers: { 'If-None-Match': display.etag },
    expectedStatus: 304,
    expectedContentType: '',
    expectedBytes: Buffer.alloc(0),
    expectedHeaders: {
      cacheControl: 'private, max-age=604800',
      etag: display.etag,
      vary: 'Cookie',
    },
  })

  await run('thumbnail.explicit-thumbnail-key', {
    requestPath: thumbPath(`/image/${fixture.thumbnailKey}`),
    expectedStatus: 200,
    expectedContentType: 'image/jpeg',
    expectedBytes: fixture.thumbnailJPEG,
    expectedHeaders: thumbnailHeaders(),
  })
  await run('thumbnail.original-url-fallback', {
    requestPath: thumbPath(fixture.originalURL),
    expectedStatus: 200,
    expectedContentType: 'image/jpeg',
    expectedBytes: fixture.thumbnailJPEG,
    expectedHeaders: thumbnailHeaders(),
  })
  await run('thumbnail.explicit-original-key', {
    requestPath: thumbPath(`/image/${fixture.storageKey}`),
    expectedStatus: 200,
    expectedContentType: 'image/jpeg',
    expectedBytes: fixture.originalJPEG,
    expectedHeaders: thumbnailHeaders(),
  })
  await run('thumbnail.bare-key-rejected', {
    requestPath: thumbPath(fixture.storageKey),
    expectedStatus: 404,
    expectedStatusMessage: 'Photo not found',
  })

  for (const tokenCase of [
    ['dedicated', fixture.tokens.dedicated],
    ['derived-session', fixture.tokens.derived],
    ['legacy-session', fixture.tokens.legacy],
  ]) {
    await run(`og.${tokenCase[0]}-token`, {
      requestPath: ogPath(fixture.id, tokenCase[1]),
      expectedStatus: 200,
      expectedContentType: 'image/webp',
      expectedBytes: fixture.thumbnail,
      expectedHeaders: thumbnailHeaders(),
    })
  }
  await run('og.range-ignored', {
    requestPath: ogPath(fixture.id, fixture.tokens.dedicated),
    headers: { Range: 'bytes=0-3' },
    expectedStatus: 200,
    expectedContentType: 'image/webp',
    expectedBytes: fixture.thumbnail,
    expectedHeaders: thumbnailHeaders(),
  })
  await run('og.invalid-token', {
    requestPath: ogPath(fixture.id, 'invalid'),
    expectedStatus: 404,
    expectedStatusMessage: 'Image not found',
  })
  await run('og.missing-token', {
    requestPath: `/og-media/${encodeURIComponent(fixture.id)}`,
    expectedStatus: 404,
    expectedStatusMessage: 'Image not found',
  })
  await run('og.duplicate-token', {
    requestPath: `${ogPath(fixture.id, fixture.tokens.dedicated)}&token=${fixture.tokens.dedicated}`,
    expectedStatus: 404,
    expectedStatusMessage: 'Image not found',
  })

  await run('livephoto.success', {
    requestPath: `/api/photos/${encodeURIComponent(fixture.id)}/livephoto`,
    expectedStatus: 200,
    expectedContentType: 'application/json',
    expectedBody: {
      id: fixture.id,
      title: fixture.title,
      isLivePhoto: true,
      livePhotoVideoUrl: fixture.livePhotoVideoURL,
      originalUrl: fixture.originalURL,
      thumbnailUrl: fixture.thumbnailURL,
    },
  })
  await run('livephoto.missing', {
    requestPath: '/api/photos/media-read-missing/livephoto',
    expectedStatus: 404,
    expectedStatusMessage: 'Photo not found',
  })
  await run('image.anonymous-original', {
    requestPath: imagePath,
    cookie: false,
    expectedStatus: 401,
    expectedStatusMessage: 'Site access required to download original photos',
  })
  await run('storage.anonymous-original', {
    requestPath: storagePath,
    cookie: false,
    expectedStatus: 401,
    expectedStatusMessage: 'Site access required to download original photos',
  })
  await run('image.unknown-key', {
    requestPath: '/image/media-read-fixtures/missing.png',
    expectedStatus: 404,
    expectedStatusMessage: 'Photo not found',
  })
  await run('image.backslash-not-normalized', {
    requestPath: `/image/${encodeURIComponent(fixture.storageKey.replaceAll('/', '\\'))}`,
    expectedStatus: 500,
    expectedStatusMessage: 'Server Error',
  })
  await run('storage.unknown-key', {
    requestPath: '/storage/media-read-fixtures/missing.png',
    expectedStatus: 404,
    expectedStatusMessage: 'Not Found',
  })
  await run('storage.traversal-rejected', {
    requestPath: '/storage/media-read-fixtures/invalid..path/missing.png',
    expectedStatus: 400,
    expectedStatusMessage: 'Invalid path',
  })

  return results
}

async function mediaRangeCases(
  run,
  prefix,
  requestPath,
  bytes,
  etag,
  lastModified,
) {
  const common = mediaHeaders(etag, lastModified)
  await run(`${prefix}.range-closed`, {
    requestPath,
    headers: { Range: 'bytes=0-7' },
    expectedStatus: 206,
    expectedContentType: 'image/png',
    expectedBytes: bytes.subarray(0, 8),
    expectedHeaders: {
      ...common,
      contentRange: `bytes 0-7/${bytes.length}`,
    },
  })
  await run(`${prefix}.range-open`, {
    requestPath,
    headers: { Range: 'bytes=8-' },
    expectedStatus: 206,
    expectedContentType: 'image/png',
    expectedBytes: bytes.subarray(8),
    expectedHeaders: {
      ...common,
      contentRange: `bytes 8-${bytes.length - 1}/${bytes.length}`,
    },
  })
  await run(`${prefix}.range-suffix`, {
    requestPath,
    headers: { Range: 'bytes=-8' },
    expectedStatus: 206,
    expectedContentType: 'image/png',
    expectedBytes: bytes.subarray(-8),
    expectedHeaders: {
      ...common,
      contentRange: `bytes ${bytes.length - 8}-${bytes.length - 1}/${bytes.length}`,
    },
  })
  await run(`${prefix}.range-invalid`, {
    requestPath,
    headers: { Range: 'bytes=invalid' },
    expectedStatus: 416,
    expectedStatusMessage: 'Invalid range',
    expectedHeaders: { contentRange: `bytes */${bytes.length}` },
  })
  await run(`${prefix}.range-unsatisfiable`, {
    requestPath,
    headers: { Range: `bytes=${bytes.length + 10}-` },
    expectedStatus: 416,
    expectedStatusMessage: 'Range not satisfiable',
    expectedHeaders: { contentRange: `bytes */${bytes.length}` },
  })
  await run(`${prefix}.if-range-current`, {
    requestPath,
    headers: { Range: 'bytes=-8', 'If-Range': etag },
    expectedStatus: 206,
    expectedContentType: 'image/png',
    expectedBytes: bytes.subarray(-8),
    expectedHeaders: {
      ...common,
      contentRange: `bytes ${bytes.length - 8}-${bytes.length - 1}/${bytes.length}`,
    },
  })
  await run(`${prefix}.if-range-stale`, {
    requestPath,
    headers: { Range: 'bytes=-8', 'If-Range': '"stale-validator"' },
    expectedStatus: 200,
    expectedContentType: 'image/png',
    expectedBytes: bytes,
    expectedHeaders: common,
  })
  await run(`${prefix}.if-none-match`, {
    requestPath,
    headers: { 'If-None-Match': etag },
    expectedStatus: 304,
    expectedContentType: '',
    expectedBytes: Buffer.alloc(0),
    expectedHeaders: common,
  })
  await run(`${prefix}.if-modified-since`, {
    requestPath,
    headers: { 'If-Modified-Since': lastModified },
    expectedStatus: 304,
    expectedContentType: '',
    expectedBytes: Buffer.alloc(0),
    expectedHeaders: common,
  })
}

export function validateMediaReadPair(caseID, nodeResult, goResult) {
  if (!nodeResult || !goResult) return [`missing result for ${caseID}`]
  const fields = [
    'status',
    'contentType',
    'cacheControl',
    'acceptRanges',
    'contentRange',
    'etag',
    'lastModified',
    'vary',
  ]
  if (
    nodeResult.contentType !== 'application/json' &&
    goResult.contentType !== 'application/json'
  ) {
    fields.push('byteLength', 'sha256')
  }
  const errors = []
  for (const field of fields) {
    if (!Object.is(nodeResult[field], goResult[field])) {
      errors.push(
        `${field} differs: node=${JSON.stringify(nodeResult[field])}, go=${JSON.stringify(goResult[field])}`,
      )
    }
  }
  const nodeBody = canonicalBody(nodeResult.body)
  const goBody = canonicalBody(goResult.body)
  if (JSON.stringify(nodeBody) !== JSON.stringify(goBody)) {
    errors.push(
      `body differs: node=${JSON.stringify(nodeBody)}, go=${JSON.stringify(goBody)}`,
    )
  }
  return errors
}

function validateExpectation(caseID, result, expectation) {
  assertValue(`${caseID} status`, result.status, expectation.expectedStatus)
  if (expectation.expectedContentType !== undefined) {
    assertValue(
      `${caseID} content-type`,
      result.contentType,
      expectation.expectedContentType,
    )
  }
  if (expectation.expectedBytes !== undefined) {
    assertValue(
      `${caseID} byte length`,
      result.byteLength,
      expectation.expectedBytes.length,
    )
    assertValue(
      `${caseID} sha256`,
      result.sha256,
      createHash('sha256').update(expectation.expectedBytes).digest('hex'),
    )
  }
  if (expectation.expectedBody !== undefined) {
    assertValue(
      `${caseID} body`,
      JSON.stringify(canonicalBody(result.body)),
      JSON.stringify(canonicalBody(expectation.expectedBody)),
    )
  }
  if (expectation.expectedStatusMessage !== undefined) {
    assertValue(
      `${caseID} statusMessage`,
      result.body?.statusMessage,
      expectation.expectedStatusMessage,
    )
  }
  for (const [field, expected] of Object.entries(
    expectation.expectedHeaders ?? {},
  )) {
    assertValue(`${caseID} ${field}`, result[field], expected)
  }
}

function mediaHeaders(etag, lastModified) {
  return {
    cacheControl: 'private, max-age=86400',
    acceptRanges: 'bytes',
    etag,
    lastModified,
    vary: 'Cookie',
  }
}

function thumbnailHeaders() {
  return { cacheControl: 'private, max-age=86400', vary: 'Cookie' }
}

async function createMediaFixture(options) {
  const storage = readLocalStorage(options.databasePath)
  const id = `${options.prefix}-${randomUUID().slice(0, 8)}`
  const title = `Dual media read ${id}`
  const relativeRoot = `media-read-fixtures/${id}`
  const key = (name) =>
    [storage.prefix, relativeRoot, name].filter(Boolean).join('/')
  const storageKey = key('original.png')
  const thumbnailKey = key('thumbnail.webp')
  const displayKey = key('display.webp')
  const livePhotoVideoKey = key('motion.mov')
  const originalURL = `/fixture-original/${id}`
  const thumbnailURL = `/image/${thumbnailKey}`
  const livePhotoVideoURL = `${storage.baseURL}/${livePhotoVideoKey}`
  const original = await sharp({
    create: {
      width: 4,
      height: 3,
      channels: 4,
      background: { r: 220, g: 20, b: 60, alpha: 1 },
    },
  })
    .png()
    .toBuffer()
  const thumbnail = await sharp({
    create: {
      width: 4,
      height: 3,
      channels: 4,
      background: { r: 30, g: 100, b: 230, alpha: 1 },
    },
  })
    .webp()
    .toBuffer()
  const display = await sharp({
    create: {
      width: 5,
      height: 4,
      channels: 4,
      background: { r: 20, g: 180, b: 90, alpha: 1 },
    },
  })
    .webp()
    .toBuffer()
  const motion = Buffer.from('ChronoFrame media-read Live Photo fixture\n')
  const paths = {
    original: resolveFixturePath(storage.basePath, storageKey),
    thumbnail: resolveFixturePath(storage.basePath, thumbnailKey),
    display: resolveFixturePath(storage.basePath, displayKey),
    motion: resolveFixturePath(storage.basePath, livePhotoVideoKey),
  }
  const fixture = {
    id,
    title,
    storageKey,
    thumbnailKey,
    displayKey,
    livePhotoVideoKey,
    originalURL,
    thumbnailURL,
    livePhotoVideoURL,
    original,
    thumbnail,
    display,
    motion,
    paths,
    rootPath: path.dirname(paths.original),
    databasePath: options.databasePath,
  }
  const database = openDatabase(options.databasePath)
  try {
    if (database.prepare('SELECT id FROM photos WHERE id = ?').get(id)) {
      throw new Error(`refusing to overwrite existing photo ${id}`)
    }
    database
      .prepare(
        `INSERT INTO photos (
           id, title, media_type, storage_key, thumbnail_key, display_key,
           file_size, last_modified, original_url, thumbnail_url, tags, exif,
           is_live_photo, live_photo_video_url, live_photo_video_key,
           owner_user_id
         ) VALUES (?, ?, 'image', ?, ?, ?, ?, ?, ?, ?, '[]', '{}', 1, ?, ?, ?)`,
      )
      .run(
        id,
        title,
        storageKey,
        thumbnailKey,
        displayKey,
        original.length,
        new Date().toISOString(),
        originalURL,
        thumbnailURL,
        livePhotoVideoURL,
        livePhotoVideoKey,
        DUAL_BACKEND_COMPARE_FIXTURE.userId,
      )
    const versionRow = database
      .prepare(
        "SELECT value FROM settings WHERE namespace = 'app' AND key = 'access.version'",
      )
      .get()
    fixture.accessVersion = String(parseStoredValue(versionRow?.value) || 1)
  } finally {
    database.close()
  }
  try {
    for (const [name, bytes] of [
      ['original', original],
      ['thumbnail', thumbnail],
      ['display', display],
      ['motion', motion],
    ]) {
      const filePath = paths[name]
      mkdirSync(path.dirname(filePath), { recursive: true })
      writeFileSync(filePath, bytes, { flag: 'wx' })
    }
    const seconds = Math.floor(Date.now() / 1000) + 0.123
    for (const filePath of Object.values(paths)) {
      utimesSync(filePath, seconds, seconds)
    }
    fixture.originalJPEG = await sharp(original)
      .rotate()
      .jpeg({ quality: 85 })
      .toBuffer()
    fixture.thumbnailJPEG = await sharp(thumbnail)
      .rotate()
      .jpeg({ quality: 85 })
      .toBuffer()
    fixture.tokens = createTokens(fixture, options)
    return fixture
  } catch (error) {
    removeMediaFixture(fixture)
    throw error
  }
}

function createTokens(fixture, options) {
  const payload = `${fixture.accessVersion}:${fixture.id}:${fixture.thumbnailKey}`
  const derivedKey = createHmac('sha256', options.sessionSecret)
    .update(OG_CONTEXT)
    .digest()
  return {
    dedicated: sign(payload, options.dedicatedSecret),
    derived: sign(payload, derivedKey),
    legacy: sign(payload, options.sessionSecret),
  }
}

function sign(payload, key) {
  return createHmac('sha256', key).update(payload).digest('base64url')
}

function readLocalStorage(databasePath) {
  const database = openDatabase(databasePath)
  try {
    const setting = database
      .prepare(
        "SELECT value FROM settings WHERE namespace = 'storage' AND key = 'provider'",
      )
      .get()
    const providerID = parseStoredValue(setting?.value)
    const row = database
      .prepare(
        'SELECT provider, config FROM settings_storage_providers WHERE id = ?',
      )
      .get(providerID)
    if (!row || row.provider !== 'local') {
      throw new Error(
        `media-read verifier requires local storage, got ${row?.provider ?? 'missing'}`,
      )
    }
    const config = JSON.parse(row.config)
    const basePath = path.resolve(String(config.basePath || ''))
    if (!path.isAbsolute(basePath) || basePath === path.parse(basePath).root) {
      throw new Error('media-read verifier requires a safe absolute basePath')
    }
    return {
      basePath,
      prefix: normalizeRelativePath(config.prefix || '', true),
      baseURL: String(config.baseUrl || '/storage').replace(/\/+$/, ''),
    }
  } finally {
    database.close()
  }
}

function resolveFixturePath(basePath, key) {
  const normalized = normalizeRelativePath(key, false)
  const absolute = path.resolve(basePath, normalized)
  const relative = path.relative(basePath, absolute)
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('media-read fixture path escapes storage basePath')
  }
  return absolute
}

function normalizeRelativePath(value, allowEmpty) {
  const text = String(value).replaceAll('\\', '/')
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) {
    throw new Error('media-read fixture path must be relative')
  }
  const parts = text.split('/').filter(Boolean)
  if (
    parts.some((part) => part === '.' || part === '..') ||
    (!allowEmpty && parts.length === 0)
  ) {
    throw new Error('media-read fixture path is invalid')
  }
  return parts.join('/')
}

function removeMediaFixture(fixture) {
  if (!fixture) return
  const database = openDatabase(fixture.databasePath)
  try {
    database.prepare('DELETE FROM photos WHERE id = ?').run(fixture.id)
  } finally {
    database.close()
  }
  rmSync(fixture.rootPath, { recursive: true, force: true })
  if (existsSync(fixture.rootPath)) {
    throw new Error(`fixture directory remains: ${fixture.rootPath}`)
  }
}

function openDatabase(databasePath) {
  const database = new Database(databasePath, { fileMustExist: true })
  database.pragma('busy_timeout = 5000')
  database.pragma('foreign_keys = ON')
  return database
}

function parseStoredValue(value) {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function thumbPath(value) {
  return `/thumb/${encodeURIComponent(value)}`
}

function ogPath(photoID, token) {
  return `/og-media/${encodeURIComponent(photoID)}?token=${encodeURIComponent(token)}`
}

function encodeKey(key) {
  return key.split('/').map(encodeURIComponent).join('/')
}

function normalizeContentType(value) {
  return String(value || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
}

function parseJSON(bytes) {
  if (bytes.length === 0) return null
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
}

function canonicalBody(value) {
  if (Array.isArray(value)) return value.map(canonicalBody)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'stack')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [
        key,
        key === 'url' && typeof item === 'string'
          ? item.replace(/^\/__lab\/go/, '')
          : canonicalBody(item),
      ]),
  )
}

function assertValue(label, actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
  }
}

function positiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 60_000) {
    throw new Error(`${label} must be a positive integer up to 60000`)
  }
  return parsed
}

async function cleanup(summary, name, action) {
  try {
    await action()
    summary.cleanup.push({ name, ok: true })
  } catch (error) {
    summary.cleanup.push({
      name,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

async function main() {
  const summary = await verifyDualMediaRead(parseMediaReadVerifierOptions())
  console.log(JSON.stringify(summary, null, 2))
  if (!summary.ok) process.exitCode = 1
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
